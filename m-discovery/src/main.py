from fastapi import FastAPI, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import List, Optional
import psycopg2
from psycopg2.extras import RealDictCursor
from .database import get_db_connection, create_tables
from .library_scanner import run_scan
from .artwork import get_or_create_thumbnail, check_artwork_presence
from .artist_info import get_artist_info, get_artist_photo_path
from .library_cleanup import find_duplicates, find_missing_tracks
from . import wiim
import google.generativeai as genai
import os
import json
import re
import threading

EXTENSION_MIME_TYPES = {
    '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4',
    '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/opus', '.wav': 'audio/wav',
    '.aac': 'audio/aac', '.wma': 'audio/x-ms-wma',
}
PUBLIC_BASE_URL = os.environ.get('PUBLIC_BASE_URL', 'http://localhost:8001')

app = FastAPI()

# Single shared scan state: this is a personal single-user tool, so one in-flight
# scan at a time is enough. Guarded by scan_lock to avoid two overlapping scans.
scan_lock = threading.Lock()
scan_progress = {"status": "idle"}

artwork_check_lock = threading.Lock()
artwork_check_progress = {"status": "idle"}

# Configure Gemini API
genai.configure(api_key=os.getenv("GOOGLE_API_KEY"))
model = genai.GenerativeModel('gemini-1.5-pro')

# Pydantic models for data validation and serialization
class Track(BaseModel):
    id: Optional[int] = None
    track_name: str
    artist_name: str
    album_name: Optional[str] = None
    genre: Optional[str] = None
    year: Optional[int] = None
    duration_seconds: Optional[int] = None
    bitrate: Optional[int] = None
    sample_rate: Optional[int] = None
    channels: Optional[int] = None
    file_size_bytes: Optional[int] = None
    file_format: Optional[str] = None
    is_favorite: Optional[bool] = False
    last_played: Optional[str] = None # Will be datetime string

class DiscoveryHistoryEntry(BaseModel):
    id: Optional[int] = None
    generated_at: Optional[str] = None # Will be datetime string
    prompt_used: str
    track_list: List[Track] # Assuming track_list is a JSONB array of tracks

class DiscoveryParameters(BaseModel):
    seed_tracks: str
    genre: Optional[str] = None
    mood: Optional[str] = None
    tempo: Optional[int] = None
    complexity: Optional[str] = None
    exclude_known: Optional[bool] = True

class LibraryScanRequest(BaseModel):
    root_path: str

class ScanStatus(BaseModel):
    status: str  # idle | running | done | error
    root_path: Optional[str] = None
    processed: Optional[int] = None
    added: Optional[int] = None
    updated: Optional[int] = None
    skipped: Optional[int] = None
    unreadable_files: Optional[List[str]] = None
    error: Optional[str] = None

class ArtworkCheckStatus(BaseModel):
    status: str  # idle | running | done | error
    processed: Optional[int] = None
    total: Optional[int] = None
    found: Optional[int] = None
    missing: Optional[int] = None
    error: Optional[str] = None

class CountEntry(BaseModel):
    name: str
    count: int

class LibraryStats(BaseModel):
    total_tracks: int
    top_genres: List[CountEntry]
    top_artists: List[CountEntry]
    tracks_by_decade: List[CountEntry]

class TrackListResponse(BaseModel):
    total: int
    tracks: List[Track]

class GroupEntry(BaseModel):
    key: str
    label: str
    count: int

class ArtistInfo(BaseModel):
    found: bool
    source: Optional[str] = None  # 'audiodb' or 'wikipedia'
    name: Optional[str] = None
    biography: Optional[str] = None
    genre: Optional[str] = None
    style: Optional[str] = None
    country: Optional[str] = None
    formed_year: Optional[str] = None
    website: Optional[str] = None

class WiimDevice(BaseModel):
    id: str
    name: str
    ip: str

class WiimPlayRequest(BaseModel):
    track_id: int

class WiimVolumeRequest(BaseModel):
    level: int

class WiimStatus(BaseModel):
    reachable: bool
    status: Optional[str] = None
    title: Optional[str] = None
    artist: Optional[str] = None
    album: Optional[str] = None
    position_ms: Optional[int] = None
    duration_ms: Optional[int] = None
    volume: Optional[int] = None

# Dependency to get a database connection
def get_db():
    conn = None
    try:
        conn = get_db_connection()
        yield conn
    finally:
        if conn:
            conn.close()

@app.on_event("startup")
async def startup_event():
    print("Starting up... Creating tables if they don't exist.")
    create_tables()
    print("Tables checked/created.")

@app.get("/")
async def read_root():
    return {"message": "Gemini Music Discovery API is running!"}

@app.get("/api/tracks/known", response_model=TrackListResponse)
async def get_known_tracks(
    search: Optional[str] = None,
    genre: Optional[str] = None,
    decade: Optional[int] = None,
    album: Optional[str] = None,
    artist: Optional[str] = None,
    has_artwork: Optional[bool] = None,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: psycopg2.extensions.connection = Depends(get_db),
):
    try:
        where_clauses = []
        params = {}
        if search:
            where_clauses.append("(track_name ILIKE %(search)s OR artist_name ILIKE %(search)s OR album_name ILIKE %(search)s)")
            params['search'] = f"%{search}%"
        if genre:
            where_clauses.append("genre = %(genre)s")
            params['genre'] = genre
        if decade is not None:
            where_clauses.append("year >= %(decade_start)s AND year < %(decade_end)s")
            params['decade_start'] = decade
            params['decade_end'] = decade + 10
        if album:
            where_clauses.append("album_name = %(album)s")
            params['album'] = album
        if artist:
            where_clauses.append("artist_name = %(artist)s")
            params['artist'] = artist
        if has_artwork is not None:
            where_clauses.append("has_artwork = %(has_artwork)s")
            params['has_artwork'] = has_artwork

        where_sql = f"WHERE {' AND '.join(where_clauses)}" if where_clauses else ""

        cur = db.cursor(cursor_factory=RealDictCursor)
        cur.execute(f"SELECT COUNT(*) AS count FROM known_tracks {where_sql}", params)
        total = cur.fetchone()['count']

        cur.execute(f"""
            SELECT id, track_name, artist_name, album_name, genre, year, duration_seconds,
                   bitrate, sample_rate, channels, file_size_bytes, file_path, is_favorite, last_played
            FROM known_tracks {where_sql}
            ORDER BY artist_name, album_name, track_name
            LIMIT %(limit)s OFFSET %(offset)s
        """, {**params, 'limit': limit, 'offset': offset})
        tracks = cur.fetchall()
        cur.close()
        for track in tracks:
            file_path = track.pop('file_path', None)
            track['file_format'] = os.path.splitext(file_path)[1].lstrip('.').upper() if file_path else None
        return {"total": total, "tracks": tracks}
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

@app.get("/api/library/groups", response_model=List[GroupEntry])
async def get_library_groups(by: str, search: Optional[str] = None, db: psycopg2.extensions.connection = Depends(get_db)):
    if by not in ("album", "genre", "decade"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="by must be one of: album, genre, decade")
    try:
        search_sql = ""
        params = {}
        if search:
            search_sql = "AND (track_name ILIKE %(search)s OR artist_name ILIKE %(search)s OR album_name ILIKE %(search)s)"
            params['search'] = f"%{search}%"

        cur = db.cursor()

        if by == "genre":
            cur.execute(f"""
                SELECT genre, COUNT(*) FROM known_tracks
                WHERE genre IS NOT NULL AND genre <> '' {search_sql}
                GROUP BY genre ORDER BY COUNT(*) DESC
            """, params)
            groups = [{"key": row[0], "label": row[0], "count": row[1]} for row in cur.fetchall()]
        elif by == "decade":
            cur.execute(f"""
                SELECT (year / 10) * 10 AS decade, COUNT(*) FROM known_tracks
                WHERE year IS NOT NULL {search_sql}
                GROUP BY decade ORDER BY decade
            """, params)
            groups = [{"key": str(row[0]), "label": f"{row[0]}s", "count": row[1]} for row in cur.fetchall()]
        else:
            cur.execute(f"""
                SELECT album_name, artist_name, COUNT(*) FROM known_tracks
                WHERE album_name IS NOT NULL AND album_name <> '' {search_sql}
                GROUP BY album_name, artist_name ORDER BY artist_name, album_name
            """, params)
            groups = [
                {"key": f"{row[1]}||{row[0]}", "label": f"{row[0]} — {row[1]}", "count": row[2]}
                for row in cur.fetchall()
            ]

        cur.close()
        return groups
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

@app.get("/api/tracks/{track_id}/stream")
async def stream_track(track_id: int, db: psycopg2.extensions.connection = Depends(get_db)):
    try:
        cur = db.cursor()
        cur.execute("SELECT file_path FROM known_tracks WHERE id = %s", (track_id,))
        row = cur.fetchone()
        cur.close()
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

    if not row or not row[0] or not os.path.isfile(row[0]):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Track file not found")

    file_path = row[0]
    media_type = EXTENSION_MIME_TYPES.get(os.path.splitext(file_path)[1].lower(), 'application/octet-stream')
    return FileResponse(file_path, media_type=media_type)

@app.get("/api/tracks/{track_id}/artwork")
async def get_track_artwork(track_id: int, db: psycopg2.extensions.connection = Depends(get_db)):
    try:
        cur = db.cursor()
        cur.execute("SELECT file_path FROM known_tracks WHERE id = %s", (track_id,))
        row = cur.fetchone()
        cur.close()
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

    if not row or not row[0]:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No artwork available")

    cache_path = get_or_create_thumbnail(track_id, row[0])
    if not cache_path:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No artwork available")

    return FileResponse(cache_path, media_type="image/jpeg")

# Defined as regular (non-async) functions so FastAPI runs them in its threadpool -
# they make a blocking network call to TheAudioDB, which would otherwise stall the
# single asyncio event loop for every other in-flight request.
@app.get("/api/artist-info", response_model=ArtistInfo)
def get_artist_info_endpoint(name: str):
    info = get_artist_info(name)
    if info is None:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not reach artist info service")
    return info

@app.get("/api/artist-info/photo")
def get_artist_photo_endpoint(name: str):
    photo_path = get_artist_photo_path(name)
    if not photo_path:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No artist photo available")
    return FileResponse(photo_path, media_type="image/jpeg")

def _get_wiim_device_or_404(device_id: str):
    device = wiim.get_device(device_id)
    if not device:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown WiiM device")
    return device

@app.get("/api/wiim/devices", response_model=List[WiimDevice])
def list_wiim_devices():
    return wiim.list_devices()

@app.post("/api/wiim/devices/{device_id}/play")
def wiim_play(device_id: str, params: WiimPlayRequest, db: psycopg2.extensions.connection = Depends(get_db)):
    device = _get_wiim_device_or_404(device_id)

    cur = db.cursor()
    cur.execute("SELECT track_name, artist_name, album_name FROM known_tracks WHERE id = %s", (params.track_id,))
    track = cur.fetchone()
    cur.close()
    if not track:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Track not found")
    track_name, artist_name, album_name = track

    stream_url = f"{PUBLIC_BASE_URL}/api/tracks/{params.track_id}/stream"
    art_url = f"{PUBLIC_BASE_URL}/api/tracks/{params.track_id}/artwork"
    if not wiim.play_url(device['ip'], params.track_id, stream_url, art_url, title=track_name, artist=artist_name, album=album_name):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not reach WiiM device")
    return {"status": "playing"}

@app.post("/api/wiim/devices/{device_id}/pause")
def wiim_pause(device_id: str):
    device = _get_wiim_device_or_404(device_id)
    if not wiim.pause(device['ip']):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not reach WiiM device")
    return {"status": "paused"}

@app.post("/api/wiim/devices/{device_id}/resume")
def wiim_resume(device_id: str):
    device = _get_wiim_device_or_404(device_id)
    if not wiim.resume(device['ip']):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not reach WiiM device")
    return {"status": "playing"}

@app.post("/api/wiim/devices/{device_id}/stop")
def wiim_stop(device_id: str):
    device = _get_wiim_device_or_404(device_id)
    if not wiim.stop(device['ip']):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not reach WiiM device")
    return {"status": "stopped"}

@app.post("/api/wiim/devices/{device_id}/volume")
def wiim_set_volume(device_id: str, params: WiimVolumeRequest):
    device = _get_wiim_device_or_404(device_id)
    if not wiim.set_volume(device['ip'], params.level):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not reach WiiM device")
    return {"status": "ok"}

@app.get("/api/wiim/devices/{device_id}/status", response_model=WiimStatus)
def wiim_get_status(device_id: str):
    device = _get_wiim_device_or_404(device_id)
    result = wiim.get_status(device['ip'])
    if result is None:
        return {"reachable": False}
    return {"reachable": True, **result}

@app.post("/api/library/scan", response_model=ScanStatus, status_code=status.HTTP_202_ACCEPTED)
async def scan_library(params: LibraryScanRequest):
    if not scan_lock.acquire(blocking=False):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="A scan is already running.")
    try:
        scan_progress.clear()
        scan_progress.update(status="running", root_path=params.root_path)

        def _run():
            try:
                run_scan(params.root_path, get_db_connection, scan_progress)
            finally:
                scan_lock.release()

        threading.Thread(target=_run, daemon=True).start()
        return scan_progress
    except Exception:
        scan_lock.release()
        raise

@app.get("/api/library/scan/status", response_model=ScanStatus)
async def get_scan_status():
    return scan_progress

@app.get("/api/library/stats", response_model=LibraryStats)
async def get_library_stats(db: psycopg2.extensions.connection = Depends(get_db)):
    try:
        cur = db.cursor()

        cur.execute("SELECT COUNT(*) FROM known_tracks")
        total_tracks = cur.fetchone()[0]

        cur.execute("""
            SELECT genre, COUNT(*) FROM known_tracks
            WHERE genre IS NOT NULL AND genre <> ''
            GROUP BY genre ORDER BY COUNT(*) DESC LIMIT 15
        """)
        top_genres = [{"name": row[0], "count": row[1]} for row in cur.fetchall()]

        cur.execute("""
            SELECT artist_name, COUNT(*) FROM known_tracks
            GROUP BY artist_name ORDER BY COUNT(*) DESC LIMIT 15
        """)
        top_artists = [{"name": row[0], "count": row[1]} for row in cur.fetchall()]

        cur.execute("""
            SELECT (year / 10) * 10 AS decade, COUNT(*) FROM known_tracks
            WHERE year IS NOT NULL
            GROUP BY decade ORDER BY decade
        """)
        tracks_by_decade = [{"name": f"{row[0]}s", "count": row[1]} for row in cur.fetchall()]

        cur.close()
        return {
            "total_tracks": total_tracks,
            "top_genres": top_genres,
            "top_artists": top_artists,
            "tracks_by_decade": tracks_by_decade,
        }
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

@app.get("/api/library/duplicates")
async def get_duplicate_tracks(db: psycopg2.extensions.connection = Depends(get_db)):
    try:
        cur = db.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            SELECT id, track_name, artist_name, album_name, duration_seconds, bitrate, file_size_bytes
            FROM known_tracks
        """)
        tracks = cur.fetchall()
        cur.close()
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))
    return find_duplicates(tracks)

@app.get("/api/library/missing-tracks")
async def get_missing_tracks(db: psycopg2.extensions.connection = Depends(get_db)):
    try:
        cur = db.cursor()
        cur.execute("""
            SELECT artist_name, album_name, track_number, track_total
            FROM known_tracks
            WHERE album_name IS NOT NULL AND album_name <> '' AND track_number IS NOT NULL
        """)
        rows = cur.fetchall()
        cur.close()
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))
    return find_missing_tracks(rows)

@app.post("/api/library/check-artwork", response_model=ArtworkCheckStatus, status_code=status.HTTP_202_ACCEPTED)
async def start_artwork_check():
    if not artwork_check_lock.acquire(blocking=False):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="An artwork check is already running.")
    try:
        artwork_check_progress.clear()
        artwork_check_progress.update(status="running")

        def _run():
            try:
                check_artwork_presence(get_db_connection, artwork_check_progress)
            finally:
                artwork_check_lock.release()

        threading.Thread(target=_run, daemon=True).start()
        return artwork_check_progress
    except Exception:
        artwork_check_lock.release()
        raise

@app.get("/api/library/check-artwork/status", response_model=ArtworkCheckStatus)
async def get_artwork_check_status():
    return artwork_check_progress

@app.get("/api/history", response_model=List[DiscoveryHistoryEntry])
async def get_discovery_history(db: psycopg2.extensions.connection = Depends(get_db)):
    try:
        cur = db.cursor(cursor_factory=RealDictCursor)
        cur.execute("SELECT id, generated_at, prompt_used, track_list FROM discovery_history ORDER BY generated_at DESC")
        history = cur.fetchall()
        cur.close()
        # Convert track_list from JSONB string to List[Track]
        for entry in history:
            # Ensure track_list is a list of dicts before passing to Track
            if isinstance(entry['track_list'], list):
                entry['track_list'] = [Track(**track) for track in entry['track_list']]
            else:
                entry['track_list'] = [] # Default to empty list if unexpected format
        return history
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

def _build_prompt(params: DiscoveryParameters) -> str:
    prompt_parts = [
        f"I'm looking for music similar to '{params.seed_tracks}'.",
        "Suggest 5-10 tracks that I might not have heard before.",
        "For each track, provide the track name, artist name, and album name.",
        "Format the output as a JSON array of objects, where each object has 'track_name', 'artist_name', and 'album_name' keys."
    ]
    if params.genre:
        prompt_parts.append(f"The genre should be: {params.genre}.")
    if params.mood:
        prompt_parts.append(f"The mood should be: {params.mood}.")
    if params.tempo:
        prompt_parts.append(f"The tempo should be around {params.tempo} BPM.")
    if params.complexity:
        prompt_parts.append(f"The musical complexity should be: {params.complexity}.")
    
    prompt_parts.append("Ensure the output is valid JSON and nothing else.")
    return " ".join(prompt_parts)

async def _call_gemini_api(prompt: str) -> List[Track]:
    try:
        response = await model.generate_content_async(prompt)
        # Extract JSON string from the response
        text_response = response.text.strip()
        
        # Gemini might add markdown ```json ... ```
        if text_response.startswith("```json") and text_response.endswith("```"):
            text_response = text_response[7:-3].strip()
        
        suggested_tracks_data = json.loads(text_response)
        
        # Validate and convert to Track Pydantic models
        suggested_tracks = [Track(**track_data) for track_data in suggested_tracks_data]
        return suggested_tracks
    except Exception as e:
        print(f"Error calling Gemini API or parsing response: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Error from AI: {e}")

async def _filter_known_tracks(suggested_tracks: List[Track], db: psycopg2.extensions.connection) -> List[Track]:
    if not suggested_tracks:
        return []

    known_tracks_set = set()
    try:
        cur = db.cursor()
        cur.execute("SELECT track_name, artist_name FROM known_tracks")
        for row in cur.fetchall():
            known_tracks_set.add((row[0].lower(), row[1].lower())) # Case-insensitive comparison
        cur.close()
    except Exception as e:
        print(f"Error fetching known tracks for filtering: {e}")
        # Continue without filtering if there's a DB error
        return suggested_tracks

    filtered_tracks = []
    for track in suggested_tracks:
        if (track.track_name.lower(), track.artist_name.lower()) not in known_tracks_set:
            filtered_tracks.append(track)
    return filtered_tracks

@app.post("/api/discover", response_model=List[Track])
async def discover_music(params: DiscoveryParameters, db: psycopg2.extensions.connection = Depends(get_db)):
    print(f"Received discovery request with params: {params}")

    prompt = _build_prompt(params)
    print(f"Gemini Prompt: {prompt}")

    suggested_tracks = await _call_gemini_api(prompt)
    print(f"Gemini suggested {len(suggested_tracks)} tracks.")

    final_tracks = suggested_tracks
    if params.exclude_known:
        final_tracks = await _filter_known_tracks(suggested_tracks, db)
        print(f"After filtering known tracks, {len(final_tracks)} remain.")

    # Store discovery history
    try:
        cur = db.cursor()
        # Convert list of Track objects to list of dicts for JSONB storage
        track_list_dicts = [track.model_dump() for track in final_tracks]
        cur.execute(
            "INSERT INTO discovery_history (prompt_used, track_list) VALUES (%s, %s)",
            (prompt, json.dumps(track_list_dicts))
        )
        db.commit()
        cur.close()
        print("Discovery history stored successfully.")
    except Exception as e:
        print(f"Error storing discovery history: {e}")
        db.rollback() # Rollback in case of error

    return final_tracks