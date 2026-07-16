from fastapi import FastAPI, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import List, Optional
import psycopg2
from psycopg2.extras import RealDictCursor
from .database import get_db_connection, create_tables
from .library_scanner import run_scan
from .artwork import get_or_create_thumbnail, check_artwork_presence, cache_key_for, normalize_album_name, normalized_album_sql
from .artist_info import get_artist_info, get_artist_photo_path
from .library_cleanup import find_duplicates, find_missing_tracks
from . import wiim
from . import chromecast
import google.generativeai as genai
import logging
import os
import json
import re
import threading

# Without this, module-level loggers (e.g. chromecast.py's) have no handler
# and INFO/WARNING records are silently dropped - only bare exceptions would
# ever surface in `docker compose logs app`.
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s: %(message)s')

EXTENSION_MIME_TYPES = {
    '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4',
    '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/opus', '.wav': 'audio/wav',
    '.aac': 'audio/aac', '.wma': 'audio/x-ms-wma',
}
PUBLIC_BASE_URL = os.environ.get('PUBLIC_BASE_URL', 'http://localhost:8001')

# Derived (not stored) library attributes computed on the fly from existing
# columns. Defined once here so the bucket boundaries can't drift between the
# flat track filter and the group-by browsing endpoint.
FORMAT_SQL = "UPPER(regexp_replace(file_path, '^.*\\.', ''))"
QUALITY_TIER_SQL = f"""
    CASE
        WHEN {FORMAT_SQL} IN ('FLAC', 'WAV', 'ALAC', 'AIFF', 'APE') THEN 'Lossless'
        WHEN bitrate >= 256000 THEN 'High (256kbps+)'
        WHEN bitrate >= 128000 THEN 'Standard (128-255kbps)'
        WHEN bitrate IS NOT NULL THEN 'Low (<128kbps)'
        ELSE 'Unknown'
    END
"""
QUALITY_TIER_RANK_SQL = f"""
    CASE {QUALITY_TIER_SQL}
        WHEN 'Lossless' THEN 0
        WHEN 'High (256kbps+)' THEN 1
        WHEN 'Standard (128-255kbps)' THEN 2
        WHEN 'Low (<128kbps)' THEN 3
        ELSE 4
    END
"""
LENGTH_TIER_SQL = """
    CASE
        WHEN duration_seconds IS NULL THEN 'Unknown'
        WHEN duration_seconds < 180 THEN 'Short (<3 min)'
        WHEN duration_seconds < 360 THEN 'Medium (3-6 min)'
        ELSE 'Long (6 min+)'
    END
"""
LENGTH_TIER_RANK_SQL = f"""
    CASE {LENGTH_TIER_SQL}
        WHEN 'Short (<3 min)' THEN 0
        WHEN 'Medium (3-6 min)' THEN 1
        WHEN 'Long (6 min+)' THEN 2
        ELSE 3
    END
"""
FAVORITE_LABEL_SQL = "CASE WHEN is_favorite THEN 'Favorites' ELSE 'Not Favorited' END"
# One representative track per group, for a grid-view tile's artwork - prefers
# a track that actually has artwork, falling back to any track in the group.
SAMPLE_TRACK_SQL = "COALESCE(MIN(CASE WHEN has_artwork THEN id END), MIN(id))"

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
    sample_track_id: Optional[int] = None

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

class WiimSeekRequest(BaseModel):
    position_ms: int

class WiimStatus(BaseModel):
    reachable: bool
    status: Optional[str] = None
    title: Optional[str] = None
    artist: Optional[str] = None
    album: Optional[str] = None
    position_ms: Optional[int] = None
    duration_ms: Optional[int] = None
    volume: Optional[int] = None

class ChromecastDevice(BaseModel):
    id: str
    name: str
    ip: str

class ChromecastPlayRequest(BaseModel):
    track_id: int
    # Upcoming tracks to preload as a real Cast queue alongside track_id, so
    # the device's own next/prev (including the TV remote's skip buttons)
    # has something to navigate to. Capped server-side.
    queue_track_ids: Optional[List[int]] = None

class ChromecastVolumeRequest(BaseModel):
    level: int

class ChromecastSeekRequest(BaseModel):
    position_ms: int

class ChromecastStatus(BaseModel):
    reachable: bool
    status: Optional[str] = None
    position_ms: Optional[int] = None
    duration_ms: Optional[int] = None
    volume: Optional[int] = None
    content_id: Optional[str] = None

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
    quality: Optional[str] = None,
    format: Optional[str] = None,
    favorite: Optional[bool] = None,
    length: Optional[str] = None,
    shuffle: bool = False,
    limit: int = Query(100, ge=1, le=20000),
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
        if quality:
            where_clauses.append(f"({QUALITY_TIER_SQL}) = %(quality)s")
            params['quality'] = quality
        if format:
            where_clauses.append(f"({FORMAT_SQL}) = %(format)s")
            params['format'] = format.upper()
        if favorite is not None:
            where_clauses.append("is_favorite = %(favorite)s")
            params['favorite'] = favorite
        if length:
            where_clauses.append(f"({LENGTH_TIER_SQL}) = %(length)s")
            params['length'] = length

        where_sql = f"WHERE {' AND '.join(where_clauses)}" if where_clauses else ""

        cur = db.cursor(cursor_factory=RealDictCursor)
        cur.execute(f"SELECT COUNT(*) AS count FROM known_tracks {where_sql}", params)
        total = cur.fetchone()['count']

        # RANDOM() genuinely reshuffles the matching rows before truncating, so a
        # shuffled fetch is a true uniform sample of the whole filtered set (not
        # just the first page) and never repeats a row within the same request.
        order_sql = "ORDER BY RANDOM()" if shuffle else "ORDER BY artist_name, album_name, track_name"
        cur.execute(f"""
            SELECT id, track_name, artist_name, album_name, genre, year, duration_seconds,
                   bitrate, sample_rate, channels, file_size_bytes, file_path, is_favorite, last_played
            FROM known_tracks {where_sql}
            {order_sql}
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
async def get_library_groups(
    by: str,
    search: Optional[str] = None,
    genre: Optional[str] = None,
    decade: Optional[int] = None,
    quality: Optional[str] = None,
    format: Optional[str] = None,
    db: psycopg2.extensions.connection = Depends(get_db),
):
    valid_by = ("album", "genre", "decade", "quality", "format", "favorite", "length")
    if by not in valid_by:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"by must be one of: {', '.join(valid_by)}")
    try:
        # These are the same ambient filters the flat track list supports, so
        # they can stay active while browsing/drilling into any grouping too.
        extra_clauses = []
        params = {}
        if search:
            extra_clauses.append("(track_name ILIKE %(search)s OR artist_name ILIKE %(search)s OR album_name ILIKE %(search)s)")
            params['search'] = f"%{search}%"
        if genre:
            extra_clauses.append("genre = %(genre)s")
            params['genre'] = genre
        if decade is not None:
            extra_clauses.append("year >= %(decade_start)s AND year < %(decade_end)s")
            params['decade_start'] = decade
            params['decade_end'] = decade + 10
        if quality:
            extra_clauses.append(f"({QUALITY_TIER_SQL}) = %(quality)s")
            params['quality'] = quality
        if format:
            extra_clauses.append(f"({FORMAT_SQL}) = %(format)s")
            params['format'] = format.upper()
        extra_sql = ("AND " + " AND ".join(extra_clauses)) if extra_clauses else ""

        cur = db.cursor()

        if by == "genre":
            cur.execute(f"""
                SELECT genre, COUNT(*), {SAMPLE_TRACK_SQL} FROM known_tracks
                WHERE genre IS NOT NULL AND genre <> '' {extra_sql}
                GROUP BY genre ORDER BY COUNT(*) DESC
            """, params)
            groups = [{"key": row[0], "label": row[0], "count": row[1], "sample_track_id": row[2]} for row in cur.fetchall()]
        elif by == "decade":
            cur.execute(f"""
                SELECT (year / 10) * 10 AS decade, COUNT(*), {SAMPLE_TRACK_SQL} FROM known_tracks
                WHERE year IS NOT NULL {extra_sql}
                GROUP BY decade ORDER BY decade
            """, params)
            groups = [{"key": str(row[0]), "label": f"{row[0]}s", "count": row[1], "sample_track_id": row[2]} for row in cur.fetchall()]
        elif by == "quality":
            cur.execute(f"""
                SELECT {QUALITY_TIER_SQL} AS tier, COUNT(*), {SAMPLE_TRACK_SQL} FROM known_tracks
                WHERE 1=1 {extra_sql}
                GROUP BY tier ORDER BY MIN({QUALITY_TIER_RANK_SQL})
            """, params)
            groups = [{"key": row[0], "label": row[0], "count": row[1], "sample_track_id": row[2]} for row in cur.fetchall()]
        elif by == "format":
            cur.execute(f"""
                SELECT {FORMAT_SQL} AS fmt, COUNT(*), {SAMPLE_TRACK_SQL} FROM known_tracks
                WHERE file_path IS NOT NULL {extra_sql}
                GROUP BY fmt ORDER BY COUNT(*) DESC
            """, params)
            groups = [{"key": row[0], "label": row[0], "count": row[1], "sample_track_id": row[2]} for row in cur.fetchall()]
        elif by == "favorite":
            cur.execute(f"""
                SELECT {FAVORITE_LABEL_SQL} AS fav, COUNT(*), {SAMPLE_TRACK_SQL} FROM known_tracks
                WHERE 1=1 {extra_sql}
                GROUP BY fav ORDER BY fav ASC
            """, params)
            groups = [{"key": row[0], "label": row[0], "count": row[1], "sample_track_id": row[2]} for row in cur.fetchall()]
        elif by == "length":
            cur.execute(f"""
                SELECT {LENGTH_TIER_SQL} AS tier, COUNT(*), {SAMPLE_TRACK_SQL} FROM known_tracks
                WHERE 1=1 {extra_sql}
                GROUP BY tier ORDER BY MIN({LENGTH_TIER_RANK_SQL})
            """, params)
            groups = [{"key": row[0], "label": row[0], "count": row[1], "sample_track_id": row[2]} for row in cur.fetchall()]
        else:
            cur.execute(f"""
                SELECT album_name, artist_name, COUNT(*), {SAMPLE_TRACK_SQL} FROM known_tracks
                WHERE album_name IS NOT NULL AND album_name <> '' {extra_sql}
                GROUP BY album_name, artist_name ORDER BY artist_name, album_name
            """, params)
            groups = [
                {"key": f"{row[1]}||{row[0]}", "label": f"{row[0]} — {row[1]}", "count": row[2], "sample_track_id": row[3]}
                for row in cur.fetchall()
            ]

        cur.close()
        return groups
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

@app.get("/api/tracks/{track_id}", response_model=Track)
async def get_track(track_id: int, db: psycopg2.extensions.connection = Depends(get_db)):
    try:
        cur = db.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            SELECT id, track_name, artist_name, album_name, genre, year, duration_seconds,
                   bitrate, sample_rate, channels, file_size_bytes, file_path, is_favorite, last_played
            FROM known_tracks WHERE id = %s
        """, (track_id,))
        track = cur.fetchone()
        cur.close()
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

    if not track:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Track not found")
    file_path = track.pop('file_path', None)
    track['file_format'] = os.path.splitext(file_path)[1].lstrip('.').upper() if file_path else None
    return track

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
        cur.execute("SELECT file_path, artist_name, album_name FROM known_tracks WHERE id = %s", (track_id,))
        row = cur.fetchone()
        if not row or not row[0]:
            cur.close()
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No artwork available")
        file_path, artist_name, album_name = row

        # Tracks sharing an artist+album share one cache entry and fall back
        # to a sibling's embedded art if this file itself has none, so an
        # album shows one consistent thumbnail instead of it varying per file.
        # Albums are matched loosely (normalized_album_sql), not by exact
        # string, so e.g. "Album Songtrack" and "Album [Songtrack]" share art.
        candidate_paths = [file_path]
        if album_name:
            # has_artwork is already known (from the background check-artwork
            # scan) for most tracks, so order by it: a sibling already
            # flagged as having art gets opened first, instead of opening
            # every sibling file blindly hoping to find one. Still falls
            # back through the rest (NULLS LAST puts never-checked tracks
            # before confirmed-empty ones) for tracks the scan hasn't
            # reached yet.
            cur.execute(f"""
                SELECT file_path FROM known_tracks
                WHERE artist_name = %(artist)s
                  AND {normalized_album_sql()} = %(normalized_album)s
                  AND file_path IS NOT NULL AND id != %(track_id)s
                ORDER BY has_artwork DESC NULLS LAST
            """, {
                'artist': artist_name,
                'normalized_album': normalize_album_name(album_name),
                'track_id': track_id,
            })
            candidate_paths += [r[0] for r in cur.fetchall()]
        cur.close()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

    cache_key = cache_key_for(track_id, artist_name, album_name)
    cache_path = get_or_create_thumbnail(cache_key, candidate_paths)
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

@app.post("/api/wiim/devices/{device_id}/seek")
def wiim_seek(device_id: str, params: WiimSeekRequest):
    device = _get_wiim_device_or_404(device_id)
    if not wiim.seek(device['ip'], params.position_ms):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not reach WiiM device")
    return {"status": "ok"}

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

def _get_chromecast_device_or_404(device_id: str):
    device = chromecast.get_device(device_id)
    if not device:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown Chromecast device")
    return device

@app.get("/api/chromecast/devices", response_model=List[ChromecastDevice])
def list_chromecast_devices():
    return chromecast.list_devices()

CHROMECAST_QUEUE_WINDOW = 30  # how many upcoming tracks to preload onto the device's own queue

def _build_chromecast_item(row):
    track_id, track_name, artist_name, album_name, file_path = row
    content_type = EXTENSION_MIME_TYPES.get(os.path.splitext(file_path or '')[1].lower(), 'audio/mpeg')
    return {
        'stream_url': f"{PUBLIC_BASE_URL}/api/tracks/{track_id}/stream",
        'art_url': f"{PUBLIC_BASE_URL}/api/tracks/{track_id}/artwork",
        'content_type': content_type,
        'title': track_name,
        'artist': artist_name,
        'album': album_name,
    }

@app.post("/api/chromecast/devices/{device_id}/play")
def chromecast_play(device_id: str, params: ChromecastPlayRequest, db: psycopg2.extensions.connection = Depends(get_db)):
    _get_chromecast_device_or_404(device_id)

    track_ids = [params.track_id] + (params.queue_track_ids or [])[:CHROMECAST_QUEUE_WINDOW]

    cur = db.cursor(cursor_factory=RealDictCursor)
    cur.execute(
        "SELECT id, track_name, artist_name, album_name, file_path FROM known_tracks WHERE id = ANY(%s)",
        (track_ids,),
    )
    rows_by_id = {row['id']: row for row in cur.fetchall()}
    cur.close()
    if params.track_id not in rows_by_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Track not found")

    # Preserve the requested order (ANY() doesn't), dropping any ids that
    # weren't found rather than failing the whole cast over one bad id.
    items = [
        _build_chromecast_item((row['id'], row['track_name'], row['artist_name'], row['album_name'], row['file_path']))
        for row in (rows_by_id[tid] for tid in track_ids if tid in rows_by_id)
    ]

    if not chromecast.play_queue(device_id, items):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not reach Chromecast device")
    return {"status": "playing"}

@app.post("/api/chromecast/devices/{device_id}/queue-next")
def chromecast_queue_next(device_id: str):
    _get_chromecast_device_or_404(device_id)
    if not chromecast.queue_next(device_id):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not reach Chromecast device")
    return {"status": "ok"}

@app.post("/api/chromecast/devices/{device_id}/queue-prev")
def chromecast_queue_prev(device_id: str):
    _get_chromecast_device_or_404(device_id)
    if not chromecast.queue_prev(device_id):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not reach Chromecast device")
    return {"status": "ok"}

@app.post("/api/chromecast/devices/{device_id}/pause")
def chromecast_pause(device_id: str):
    _get_chromecast_device_or_404(device_id)
    if not chromecast.pause(device_id):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not reach Chromecast device")
    return {"status": "paused"}

@app.post("/api/chromecast/devices/{device_id}/resume")
def chromecast_resume(device_id: str):
    _get_chromecast_device_or_404(device_id)
    if not chromecast.resume(device_id):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not reach Chromecast device")
    return {"status": "playing"}

@app.post("/api/chromecast/devices/{device_id}/stop")
def chromecast_stop(device_id: str):
    _get_chromecast_device_or_404(device_id)
    if not chromecast.stop(device_id):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not reach Chromecast device")
    return {"status": "stopped"}

@app.post("/api/chromecast/devices/{device_id}/seek")
def chromecast_seek(device_id: str, params: ChromecastSeekRequest):
    _get_chromecast_device_or_404(device_id)
    if not chromecast.seek(device_id, params.position_ms):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not reach Chromecast device")
    return {"status": "ok"}

@app.post("/api/chromecast/devices/{device_id}/volume")
def chromecast_set_volume(device_id: str, params: ChromecastVolumeRequest):
    _get_chromecast_device_or_404(device_id)
    if not chromecast.set_volume(device_id, params.level):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not reach Chromecast device")
    return {"status": "ok"}

@app.get("/api/chromecast/devices/{device_id}/status", response_model=ChromecastStatus)
def chromecast_get_status(device_id: str):
    _get_chromecast_device_or_404(device_id)
    result = chromecast.get_status(device_id)
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
                # Newly-scanned tracks start with has_artwork unset, so a scan
                # is exactly the event that makes that flag stale - follow it
                # with a check automatically instead of relying on the user
                # to remember to click "Check Artwork" themselves.
                if scan_progress.get('status') == 'done':
                    _start_artwork_check_background()
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

def _start_artwork_check_background():
    """Kicks off a background artwork-presence check if one isn't already
    running. Returns False (no-op, no error) if one is already in flight -
    used both by the explicit endpoint below and the auto-trigger after a
    library scan finishes."""
    if not artwork_check_lock.acquire(blocking=False):
        return False
    try:
        artwork_check_progress.clear()
        artwork_check_progress.update(status="running")

        def _run():
            try:
                check_artwork_presence(get_db_connection, artwork_check_progress)
            finally:
                artwork_check_lock.release()

        threading.Thread(target=_run, daemon=True).start()
        return True
    except Exception:
        artwork_check_lock.release()
        raise

@app.post("/api/library/check-artwork", response_model=ArtworkCheckStatus, status_code=status.HTTP_202_ACCEPTED)
async def start_artwork_check():
    if not _start_artwork_check_background():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="An artwork check is already running.")
    return artwork_check_progress

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