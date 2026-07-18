from fastapi import FastAPI, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel
from typing import List, Optional, Any, Dict
import psycopg2
from psycopg2.extras import RealDictCursor
from .database import (
    get_db_connection, create_tables,
    save_playback_session, get_playback_session, clear_playback_session,
    update_chromecast_pushed_count,
)
from .library_scanner import run_scan
from .artwork import get_or_create_thumbnail, check_artwork_presence, cache_key_for, normalize_album_name, normalized_album_sql, save_thumbnail
from .artist_info import get_artist_info, get_artist_photo_path
from .library_cleanup import (
    find_duplicates, find_missing_tracks,
    COMPILATION_MIN_ARTISTS, COMPILATION_MIN_TRACKS,
    MIN_GUESS_COMPLETENESS_RATIO, MAX_PLAUSIBLE_ALBUM_SIZE,
)
from . import wiim
from . import chromecast
from . import spotify_connect
from . import external_artwork
from . import spotify_prewarm
from . import tag_cleanup
from . import playback_advancer
import google.generativeai as genai
import logging
import os
import json
import re
import threading
import time

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

# "Best Quality" dedup: same song on the same album (title+artist+album,
# loosely normalized) kept only once, picking the highest quality-tier/bitrate
# copy when more than one rip exists. Album is part of the key so a song that
# legitimately appears on two different albums (e.g. a studio LP and a
# compilation) still shows once per album, instead of one appearance winning
# and hiding the other. Deliberately simpler than library_cleanup.
# find_duplicates' noise stripping (no Live/Remastered/etc. removal) - this
# runs on every default library-tab load, so it favors a cheap, conservative
# match (won't merge a live recording into a studio one) over the fuzzier
# one-off cleanup report.
DEDUP_NORM_TITLE_SQL = "btrim(regexp_replace(lower(track_name), '[^a-z0-9]+', ' ', 'g'))"
DEDUP_NORM_ARTIST_SQL = "btrim(regexp_replace(lower(artist_name), '[^a-z0-9]+', ' ', 'g'))"
DEDUP_NORM_ALBUM_SQL = normalized_album_sql('album_name')

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

external_artwork_lock = threading.Lock()
external_artwork_progress = {"status": "idle"}

spotify_prewarm_lock = threading.Lock()
spotify_prewarm_progress = {"status": "idle"}

tag_cleanup_lock = threading.Lock()
tag_cleanup_progress = {"status": "idle"}

# Not a one-shot backfill like the jobs above (no lock/trigger-route needed -
# there's nothing to "start" on demand) - see playback_advancer.run for why.
playback_advancer_progress = {"status": "idle"}

# Timestamp of the last non-polling request, used by the Spotify pre-warm
# background job to tell "actively using the app" apart from "idle" so it
# only spends search requests when nothing else needs them.
IDLE_THRESHOLD_SECONDS = 120
_last_activity_at = 0.0

def _is_idle():
    return (time.time() - _last_activity_at) > IDLE_THRESHOLD_SECONDS

@app.middleware("http")
async def track_activity(request, call_next):
    # Routine status polling happens every ~2s-5s during any ongoing playback
    # - counting it as "activity" would mean the pre-warm job could never run
    # during a long listening session, which isn't the intent of "idle".
    # /api/playback-session is the same kind of routine poll for WiiM/Spotify
    # sessions (added when advancement moved server-side - see
    # playback_advancer.py) as the per-device /status routes are for
    # Chromecast/interactive use, so it's excluded the same way. The frontend
    # also polls device-picker lists and library group counts every ~90-100s
    # regardless of whether the user is actively doing anything - confirmed
    # live: this alone kept resetting the idle clock just under the 120s
    # threshold, so the prewarm job's idle window almost never opened
    # (11 hours uptime, 1 track processed). Excluded the same way.
    global _last_activity_at
    path = request.url.path
    routine_poll_paths = {
        "/api/playback-session",
        "/api/wiim/devices",
        "/api/spotify/devices",
        "/api/chromecast/devices",
        "/api/library/groups",
    }
    if not path.endswith("/status") and path not in routine_poll_paths:
        _last_activity_at = time.time()
    return await call_next(request)

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
    artwork_source_url: Optional[str] = None
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

class ExternalArtworkStatus(BaseModel):
    status: str  # idle | running | waiting | done | error
    processed: Optional[int] = None
    total: Optional[int] = None
    found: Optional[int] = None
    still_missing: Optional[int] = None
    resume_at: Optional[float] = None  # unix timestamp; set only while status == 'waiting'
    error: Optional[str] = None

class SpotifyPrewarmStatus(BaseModel):
    status: str  # idle | running | waiting_active_use | waiting_not_connected | done | error
    processed: Optional[int] = None
    matched: Optional[int] = None
    error: Optional[str] = None

class TagCleanupStatus(BaseModel):
    status: str  # idle | running | done | error
    processed: Optional[int] = None
    total: Optional[int] = None
    fixed: Optional[int] = None
    unrecoverable: Optional[int] = None
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

class TrackAlbumPosition(BaseModel):
    track_number: Optional[int] = None
    track_total: Optional[int] = None
    library_track_count: Optional[int] = None

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

class SpotifyDevice(BaseModel):
    id: str
    name: str

class SpotifyPlayRequest(BaseModel):
    context_uri: str
    track_uri: Optional[str] = None

class SpotifyPlayUrisRequest(BaseModel):
    uris: List[str]

class SpotifyQueueRequest(BaseModel):
    uri: str

class SpotifyVolumeRequest(BaseModel):
    level: int

class SpotifySeekRequest(BaseModel):
    position_ms: int

class SpotifyStatus(BaseModel):
    reachable: bool
    status: Optional[str] = None
    position_ms: Optional[int] = None
    duration_ms: Optional[int] = None
    volume: Optional[int] = None
    track_uri: Optional[str] = None
    title: Optional[str] = None
    artist: Optional[str] = None
    album: Optional[str] = None
    artwork_url: Optional[str] = None

class SpotifyPlaylist(BaseModel):
    id: str
    name: str
    track_count: int
    artwork_url: Optional[str] = None
    uri: str

class SpotifyTrack(BaseModel):
    uri: str
    name: str
    artists: str
    album: Optional[str] = None
    duration_ms: Optional[int] = None
    artwork_url: Optional[str] = None

class SpotifyMatchResult(BaseModel):
    matched: bool
    uri: Optional[str] = None
    artwork_url: Optional[str] = None
    reason: Optional[str] = None  # "no_match" | "unavailable", set when matched=False

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

    # An external-artwork run (mid-processing, or mid-wait for a rate limit)
    # has no way to survive a container rebuild on its own - the in-memory
    # progress/lock are gone the moment the process exits. Auto-resume here
    # rather than requiring a manual re-click, since unchecked rows are
    # exactly the same "still work to do" signal a genuine interruption would
    # leave behind (also covers new tracks added by a scan since the last
    # complete run).
    conn = get_db_connection()
    if conn:
        try:
            cur = conn.cursor()
            cur.execute("SELECT COUNT(*) FROM known_tracks WHERE has_artwork = FALSE AND external_artwork_checked IS NOT TRUE")
            remaining = cur.fetchone()[0]
            cur.close()
        finally:
            conn.close()
        if remaining > 0:
            print(f"Resuming external artwork backfill in the background ({remaining} tracks not yet checked).")
            _start_external_artwork_background()

    # Same idea for the Spotify pre-warm job: it needs a connected account to
    # do anything, so only auto-start it if one's already linked at boot.
    if spotify_connect.is_connected():
        conn = get_db_connection()
        if conn:
            try:
                cur = conn.cursor()
                cur.execute("SELECT COUNT(*) FROM known_tracks WHERE spotify_checked IS NOT TRUE")
                remaining = cur.fetchone()[0]
                cur.close()
            finally:
                conn.close()
            if remaining > 0:
                print(f"Resuming Spotify pre-warm in the background ({remaining} tracks not yet checked).")
                _start_spotify_prewarm_background()

    # Unconditional, unlike the backfill jobs above - this is a supervisor
    # that keeps playback advancing to the next track even once the browser
    # tab that started it goes to sleep (see playback_advancer.run). Normally
    # idle-polling with nothing to do until a session is synced via
    # POST /api/playback-session, so there's no "only start if there's known
    # work" check to make here.
    print("Starting playback advancer in the background.")
    threading.Thread(
        target=playback_advancer.run,
        args=(get_playback_session, save_playback_session, playback_advancer_progress),
        daemon=True,
    ).start()

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
    external_artwork_found: Optional[bool] = None,
    spotify_available: Optional[bool] = None,
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
        best_quality_only = (quality == 'best')
        if quality and not best_quality_only:
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
        if external_artwork_found is not None:
            # external_artwork_checked is only ever set on rows the external-artwork
            # job actually processed (has_artwork was FALSE going in), so this
            # correctly excludes tracks whose art was always found locally.
            where_clauses.append("(external_artwork_checked IS TRUE AND has_artwork IS TRUE) = %(external_artwork_found)s")
            params['external_artwork_found'] = external_artwork_found
        if spotify_available is not None:
            # Already has a cached Spotify match (spotify_track_id set) - lets
            # Shuffle All be tested against a sub-list that never needs a live
            # search, so playback behavior can be verified independently of
            # whether Spotify's search is currently rate-limited.
            where_clauses.append("(spotify_track_id IS NOT NULL) = %(spotify_available)s")
            params['spotify_available'] = spotify_available

        where_sql = f"WHERE {' AND '.join(where_clauses)}" if where_clauses else ""

        # "Best Quality" mode: collapse same-song-on-the-same-album duplicates
        # down to their single best-quality copy *before* any other
        # filter/pagination logic runs, by treating the deduped result as if
        # it were known_tracks itself.
        if best_quality_only:
            from_sql = f"""
                (SELECT DISTINCT ON ({DEDUP_NORM_TITLE_SQL}, {DEDUP_NORM_ARTIST_SQL}, {DEDUP_NORM_ALBUM_SQL})
                        id, track_name, artist_name, album_name, genre, year, duration_seconds,
                        bitrate, sample_rate, channels, file_size_bytes, file_path, artwork_source_url, is_favorite, last_played
                 FROM known_tracks {where_sql}
                 ORDER BY {DEDUP_NORM_TITLE_SQL}, {DEDUP_NORM_ARTIST_SQL}, {DEDUP_NORM_ALBUM_SQL},
                          {QUALITY_TIER_RANK_SQL} ASC, bitrate DESC NULLS LAST, id ASC
                ) AS best_tracks
            """
        else:
            from_sql = f"known_tracks {where_sql}"

        cur = db.cursor(cursor_factory=RealDictCursor)
        cur.execute(f"SELECT COUNT(*) AS count FROM {from_sql}", params)
        total = cur.fetchone()['count']

        # RANDOM() genuinely reshuffles the matching rows before truncating, so a
        # shuffled fetch is a true uniform sample of the whole filtered set (not
        # just the first page) and never repeats a row within the same request.
        order_sql = "ORDER BY RANDOM()" if shuffle else "ORDER BY artist_name, album_name, track_name"
        cur.execute(f"""
            SELECT id, track_name, artist_name, album_name, genre, year, duration_seconds,
                   bitrate, sample_rate, channels, file_size_bytes, file_path, artwork_source_url, is_favorite, last_played
            FROM {from_sql}
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

class TrackIdsRequest(BaseModel):
    ids: List[int]

@app.post("/api/tracks/by-ids", response_model=List[Track])
async def get_tracks_by_ids(params: TrackIdsRequest, db: psycopg2.extensions.connection = Depends(get_db)):
    # Restores the exact shuffled order the library view persisted (see
    # LIBRARY_VIEW_KEY in App.js) - a fresh "ORDER BY RANDOM()" fetch on every
    # reload would roll a brand-new sequence every time, completely
    # disconnected from whatever's actually still playing (confirmed live:
    # refreshing mid-shuffle produced a different track list on every single
    # refresh). POST + JSON body rather than a query string - a full shuffled
    # library is 10k+ ids, well past URL length limits (confirmed live: a GET
    # with that many ids 414'd). Response preserves the requested order
    # (SQL's WHERE id = ANY() doesn't), dropping any that no longer exist
    # rather than failing the whole request over one bad id.
    id_list = params.ids
    if not id_list:
        return []
    cur = db.cursor(cursor_factory=RealDictCursor)
    cur.execute("""
        SELECT id, track_name, artist_name, album_name, genre, year, duration_seconds,
               bitrate, sample_rate, channels, file_size_bytes, file_path, artwork_source_url, is_favorite, last_played
        FROM known_tracks WHERE id = ANY(%s)
    """, (id_list,))
    rows_by_id = {row['id']: row for row in cur.fetchall()}
    cur.close()
    tracks = [rows_by_id[i] for i in id_list if i in rows_by_id]
    for track in tracks:
        file_path = track.pop('file_path', None)
        track['file_format'] = os.path.splitext(file_path)[1].lstrip('.').upper() if file_path else None
    return tracks

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
        if quality and quality != 'best':
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
            # Grouping by (album_name, artist_name) fragments any album where
            # tracks carry different per-track artist tags - which is exactly
            # every "Various Artists" compilation, since we don't scan a
            # separate album-artist tag. Detect that case (many distinct
            # artists across a real number of tracks, not just 2-3 tracks
            # that happen to share a generic title) and group by album_name
            # alone for those; ordinary albums keep the artist-scoped
            # grouping, so two unrelated artists' same-titled albums don't
            # get merged into one.
            cur.execute(f"""
                WITH album_meta AS (
                    SELECT album_name AS cte_album_name,
                           (COUNT(DISTINCT artist_name) > 4 AND COUNT(*) >= 6) AS is_compilation
                    FROM known_tracks
                    WHERE album_name IS NOT NULL AND album_name <> '' {extra_sql}
                    GROUP BY album_name
                )
                SELECT
                    kt.album_name,
                    CASE WHEN am.is_compilation THEN '' ELSE kt.artist_name END AS grouping_artist,
                    CASE WHEN am.is_compilation THEN 'Various Artists' ELSE kt.artist_name END AS display_artist,
                    COUNT(*), {SAMPLE_TRACK_SQL}
                FROM known_tracks kt
                JOIN album_meta am ON am.cte_album_name = kt.album_name
                WHERE kt.album_name IS NOT NULL AND kt.album_name <> '' {extra_sql}
                GROUP BY kt.album_name, grouping_artist, display_artist
                ORDER BY kt.album_name, display_artist
            """, params)
            groups = [
                {"key": f"{row[1]}||{row[0]}", "label": f"{row[0]} — {row[2]}", "count": row[3], "sample_track_id": row[4]}
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
                   bitrate, sample_rate, channels, file_size_bytes, file_path, artwork_source_url, is_favorite, last_played
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

@app.get("/api/tracks/{track_id}/album-position", response_model=TrackAlbumPosition)
async def get_track_album_position(track_id: int, db: psycopg2.extensions.connection = Depends(get_db)):
    """How this track's own track_number tag relates to how many of that
    album's tracks are actually present in the library - e.g. "Track #3, of
    12 (10 in Lib)" in the Now Playing panel. track_total is the original
    album's real track count: the highest total-tracks tag seen anywhere in
    the album (not just this file's own tag, since not every rip necessarily
    has it filled in), falling back to a guessed total (the highest
    track_number seen) when no rip has an explicit tag at all - same
    total_hint/trust_guess approach as find_missing_tracks. Grouping is
    compilation-aware (same heuristic as find_missing_tracks/"by album"
    browsing): a "Various Artists" style album is matched by album name
    alone, since every track there has a different artist tag."""
    try:
        cur = db.cursor(cursor_factory=RealDictCursor)
        cur.execute(
            "SELECT artist_name, album_name, track_number FROM known_tracks WHERE id = %s",
            (track_id,),
        )
        track = cur.fetchone()
        if not track:
            cur.close()
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Track not found")

        if not track['album_name']:
            cur.close()
            return {'track_number': track['track_number'], 'track_total': None, 'library_track_count': None}

        cur.execute(
            "SELECT COUNT(DISTINCT artist_name) AS artists, COUNT(*) AS cnt FROM known_tracks WHERE album_name = %(album)s",
            {'album': track['album_name']},
        )
        meta = cur.fetchone()
        is_compilation = meta['artists'] > COMPILATION_MIN_ARTISTS and meta['cnt'] >= COMPILATION_MIN_TRACKS

        if is_compilation:
            cur.execute(
                """SELECT MAX(track_total) AS total_hint, MAX(track_number) AS max_number,
                          COUNT(DISTINCT track_number) AS cnt
                   FROM known_tracks WHERE album_name = %(album)s AND track_number IS NOT NULL""",
                {'album': track['album_name']},
            )
        else:
            cur.execute(
                """SELECT MAX(track_total) AS total_hint, MAX(track_number) AS max_number,
                          COUNT(DISTINCT track_number) AS cnt
                   FROM known_tracks WHERE album_name = %(album)s AND artist_name = %(artist)s AND track_number IS NOT NULL""",
                {'album': track['album_name'], 'artist': track['artist_name']},
            )
        album_stats = cur.fetchone()
        cur.close()

        has_explicit_total = album_stats['total_hint'] is not None
        expected_total = album_stats['total_hint'] or album_stats['max_number']
        trust_guess = expected_total and (
            has_explicit_total or album_stats['cnt'] / expected_total >= MIN_GUESS_COMPLETENESS_RATIO
        )
        track_total = expected_total if (trust_guess and expected_total <= MAX_PLAUSIBLE_ALBUM_SIZE) else None

        return {
            'track_number': track['track_number'],
            'track_total': track_total,
            'library_track_count': album_stats['cnt'],
        }
    except HTTPException:
        raise
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
        cur.execute("SELECT file_path, artist_name, album_name, spotify_album_art_url FROM known_tracks WHERE id = %s", (track_id,))
        row = cur.fetchone()
        if not row or (not row[0] and not row[3]):
            cur.close()
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No artwork available")
        file_path, artist_name, album_name, spotify_album_art_url = row

        # Tracks sharing an artist+album share one cache entry and fall back
        # to a sibling's embedded art if this file itself has none, so an
        # album shows one consistent thumbnail instead of it varying per file.
        # Albums are matched loosely (normalized_album_sql), not by exact
        # string, so e.g. "Album Songtrack" and "Album [Songtrack]" share art.
        candidate_paths = [file_path] if file_path else []
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
    if not cache_path and spotify_album_art_url:
        # No embedded/local art anywhere in the album - a track that's
        # already matched to Spotify has a real cover art URL sitting right
        # there in known_tracks, so try that before giving up. Downloaded and
        # cached the same way the external-artwork job does (same cache_key,
        # same save_thumbnail), so this is a one-time cost per album, not a
        # remote fetch on every request.
        raw = external_artwork.download_bytes(spotify_album_art_url)
        if raw:
            cache_path = save_thumbnail(cache_key, raw)
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
    # Tells playback_advancer how many *upcoming* items (beyond this first
    # one) are already sitting in the device's native queue, so it knows when
    # to top it up via queue_insert rather than double-pushing what's already
    # there. A single-column update (not a full session upsert) so it can't
    # race the frontend's own now_playing/queue sync from this same action.
    update_chromecast_pushed_count(len(items) - 1)
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

@app.get("/api/spotify/auth/login")
def spotify_auth_login():
    if not spotify_connect.is_configured():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET not set in .env")
    return RedirectResponse(spotify_connect.get_auth_url())

@app.get("/api/spotify/auth/callback")
def spotify_auth_callback(code: Optional[str] = None, state: Optional[str] = None, error: Optional[str] = None):
    if error or not code or not spotify_connect.verify_and_consume_state(state):
        return RedirectResponse(f"{PUBLIC_BASE_URL}?spotify=error")
    if not spotify_connect.exchange_code_for_tokens(code):
        return RedirectResponse(f"{PUBLIC_BASE_URL}?spotify=error")
    return RedirectResponse(f"{PUBLIC_BASE_URL}?spotify=connected")

@app.get("/api/spotify/auth/status")
def spotify_auth_status():
    return {"connected": spotify_connect.is_connected()}

@app.post("/api/spotify/auth/logout")
def spotify_auth_logout():
    spotify_connect.disconnect()
    return {"status": "disconnected"}

def _get_spotify_device_or_404(device_id: str):
    device = spotify_connect.get_device(device_id)
    if not device:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown Spotify Connect device")
    return device

@app.get("/api/spotify/devices", response_model=List[SpotifyDevice])
def list_spotify_devices():
    return spotify_connect.list_devices()

@app.post("/api/spotify/devices/{device_id}/play")
def spotify_play(device_id: str, params: SpotifyPlayRequest):
    _get_spotify_device_or_404(device_id)
    if not spotify_connect.play(device_id, params.context_uri, params.track_uri):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not reach Spotify")
    return {"status": "playing"}

@app.post("/api/spotify/devices/{device_id}/play-uris")
def spotify_play_uris(device_id: str, params: SpotifyPlayUrisRequest):
    _get_spotify_device_or_404(device_id)
    if not spotify_connect.play_uris(device_id, params.uris):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not reach Spotify")
    return {"status": "playing"}

@app.post("/api/spotify/devices/{device_id}/queue")
def spotify_add_to_queue(device_id: str, params: SpotifyQueueRequest):
    _get_spotify_device_or_404(device_id)
    if not spotify_connect.add_to_queue(device_id, params.uri):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not reach Spotify")
    return {"status": "queued"}

@app.post("/api/spotify/devices/{device_id}/pause")
def spotify_pause(device_id: str):
    _get_spotify_device_or_404(device_id)
    if not spotify_connect.pause(device_id):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not reach Spotify")
    return {"status": "paused"}

@app.post("/api/spotify/devices/{device_id}/resume")
def spotify_resume(device_id: str):
    _get_spotify_device_or_404(device_id)
    if not spotify_connect.resume(device_id):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not reach Spotify")
    return {"status": "playing"}

@app.post("/api/spotify/devices/{device_id}/stop")
def spotify_stop(device_id: str):
    _get_spotify_device_or_404(device_id)
    if not spotify_connect.stop(device_id):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not reach Spotify")
    return {"status": "stopped"}

@app.post("/api/spotify/devices/{device_id}/seek")
def spotify_seek(device_id: str, params: SpotifySeekRequest):
    _get_spotify_device_or_404(device_id)
    if not spotify_connect.seek(device_id, params.position_ms):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not reach Spotify")
    return {"status": "ok"}

@app.post("/api/spotify/devices/{device_id}/volume")
def spotify_set_volume(device_id: str, params: SpotifyVolumeRequest):
    _get_spotify_device_or_404(device_id)
    if not spotify_connect.set_volume(device_id, params.level):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not reach Spotify")
    return {"status": "ok"}

@app.post("/api/spotify/devices/{device_id}/next")
def spotify_next(device_id: str):
    _get_spotify_device_or_404(device_id)
    if not spotify_connect.next_track(device_id):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not reach Spotify")
    return {"status": "ok"}

@app.post("/api/spotify/devices/{device_id}/previous")
def spotify_previous(device_id: str):
    _get_spotify_device_or_404(device_id)
    if not spotify_connect.previous_track(device_id):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not reach Spotify")
    return {"status": "ok"}

@app.get("/api/spotify/devices/{device_id}/status", response_model=SpotifyStatus)
def spotify_get_status(device_id: str):
    _get_spotify_device_or_404(device_id)
    result = spotify_connect.get_status(device_id)
    if result is None:
        return {"reachable": False}
    return result

@app.get("/api/spotify/playlists", response_model=List[SpotifyPlaylist])
def list_spotify_playlists():
    if not spotify_connect.is_connected():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Spotify not connected")
    return spotify_connect.list_playlists()

@app.get("/api/spotify/playlists/{playlist_id}/tracks", response_model=List[SpotifyTrack])
def get_spotify_playlist_tracks(playlist_id: str):
    if not spotify_connect.is_connected():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Spotify not connected")
    tracks = spotify_connect.get_playlist_tracks(playlist_id)
    if tracks is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Spotify doesn't allow reading the track listing of a playlist you don't own - play it directly instead",
        )
    return tracks

def _match_track_to_spotify(db, track_id):
    """Looks up (or performs and caches) a local track's Spotify match. Shared
    by the single-track and batch match routes. Returns a dict shaped like
    SpotifyMatchResult, or None if track_id doesn't exist in known_tracks."""
    cur = db.cursor()
    cur.execute(
        "SELECT track_name, artist_name, spotify_track_id, spotify_checked, spotify_album_art_url "
        "FROM known_tracks WHERE id = %s",
        (track_id,),
    )
    row = cur.fetchone()
    if not row:
        cur.close()
        return None
    track_name, artist_name, cached_id, checked, cached_art = row

    if checked:
        cur.close()
        if not cached_id:
            return {"matched": False, "reason": "no_match"}
        return {"matched": True, "uri": f"spotify:track:{cached_id}", "artwork_url": cached_art}

    result, match = spotify_connect.search_track(track_name, artist_name)
    if result == 'unavailable':
        cur.close()
        return {"matched": False, "reason": "unavailable"}

    if match:
        spotify_id = match['uri'].split(':')[-1]
        spotify_track_name = match.get('track_name')
        spotify_artist_name = match.get('artist_name')
        if spotify_track_name and spotify_artist_name and (spotify_track_name != track_name or spotify_artist_name != artist_name):
            # Spotify's own title/artist for the matched track differs from
            # the local tag - could be a translated title recovered via the
            # YouTube Music bridge, or just a "(Remastered)" suffix/
            # capitalization difference on an otherwise-direct match. Correct
            # the local tag to match, same reversible pattern tag_cleanup.py
            # uses - COALESCE so a track already corrected once (e.g. by
            # tag_cleanup) keeps its true original tag rather than this
            # overwriting it with an intermediate value.
            cur.execute(
                """UPDATE known_tracks SET
                    track_name = %s, artist_name = %s,
                    original_track_name = COALESCE(original_track_name, track_name),
                    original_artist_name = COALESCE(original_artist_name, artist_name),
                    spotify_track_id = %s, spotify_url = %s, spotify_album_art_url = %s, spotify_checked = TRUE
                WHERE id = %s""",
                (spotify_track_name, spotify_artist_name, spotify_id,
                 f"https://open.spotify.com/track/{spotify_id}", match['artwork_url'], track_id),
            )
        else:
            cur.execute(
                "UPDATE known_tracks SET spotify_track_id = %s, spotify_url = %s, spotify_album_art_url = %s, spotify_checked = TRUE WHERE id = %s",
                (spotify_id, f"https://open.spotify.com/track/{spotify_id}", match['artwork_url'], track_id),
            )
    else:
        cur.execute("UPDATE known_tracks SET spotify_checked = TRUE WHERE id = %s", (track_id,))
    db.commit()
    cur.close()

    if not match:
        return {"matched": False, "reason": "no_match"}
    return {"matched": True, "uri": match['uri'], "artwork_url": match['artwork_url']}

@app.post("/api/spotify/tracks/{track_id}/match", response_model=SpotifyMatchResult)
def match_local_track_to_spotify(track_id: int, db: psycopg2.extensions.connection = Depends(get_db)):
    if not spotify_connect.is_connected():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Spotify not connected")
    result = _match_track_to_spotify(db, track_id)
    if result is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Track not found")
    return result

def _start_spotify_prewarm_background():
    """Kicks off the background Spotify pre-warm job if one isn't already
    running. Returns False (no-op, no error) if one is already in flight -
    same pattern as _start_external_artwork_background, for the same reason
    (a run interrupted by a container rebuild needs to auto-resume, since the
    in-memory progress/lock don't survive the process exiting)."""
    if not spotify_prewarm_lock.acquire(blocking=False):
        return False
    try:
        spotify_prewarm_progress.clear()
        spotify_prewarm_progress.update(status="running")

        def _run():
            try:
                spotify_prewarm.run(get_db_connection, spotify_prewarm_progress, _is_idle)
            finally:
                spotify_prewarm_lock.release()

        threading.Thread(target=_run, daemon=True).start()
        return True
    except Exception:
        spotify_prewarm_lock.release()
        raise

@app.get("/api/spotify/prewarm/status", response_model=SpotifyPrewarmStatus)
async def get_spotify_prewarm_status():
    return spotify_prewarm_progress

@app.get("/api/spotify/prewarm/stats")
async def get_spotify_prewarm_stats(db: psycopg2.extensions.connection = Depends(get_db)):
    # spotify_prewarm_progress only tracks *this run's* processed/matched
    # counts (reset each time the job (re)starts) - these are cumulative
    # totals across the whole library, for a meaningful "X of Y checked"
    # readout regardless of how many times the background job has restarted.
    cur = db.cursor()
    cur.execute("SELECT COUNT(*) FROM known_tracks")
    total = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM known_tracks WHERE spotify_checked IS TRUE")
    checked = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM known_tracks WHERE spotify_track_id IS NOT NULL")
    matched = cur.fetchone()[0]
    cur.close()
    return {"total": total, "checked": checked, "matched": matched}

class PlaybackSessionUpdate(BaseModel):
    # Loosely typed on purpose - track objects already vary by source
    # (local_id/context_uri/uri are all conditional depending on whether a
    # track is local, Spotify-matched, or a real Spotify playlist item) and
    # are already untyped JSON once they hit the frontend's own localStorage
    # copy. A strict schema here would just be duplicate maintenance for a
    # personal single-user tool.
    destination_type: Optional[str] = None
    destination_id: Optional[str] = None
    now_playing: Optional[Dict[str, Any]] = None
    queue: Optional[List[Dict[str, Any]]] = None
    shuffle_enabled: bool = False
    # Only ever sent right after a fresh Spotify match attempt (see
    # matchAndPlayLocalTracksOnSpotify in App.js) - the remaining
    # not-yet-tried candidate pool for playback_advancer's lookahead refill
    # to keep working through. Omitted on routine syncs (Next/Prev, a plain
    # queue reorder), in which case the backend's own tracked pool is kept.
    spotify_match_pool: Optional[Dict[str, Any]] = None

@app.post("/api/playback-session")
async def post_playback_session(params: PlaybackSessionUpdate):
    if not params.destination_type:
        # Mirrors DELETE - the frontend posts destination_type: null when
        # switching to "This Browser" (nothing for a background job to drive).
        clear_playback_session()
        return {"status": "cleared"}
    # spotify_match_pool/chromecast_pushed_count/last_status are backend-owned
    # (written by playback_advancer, not the frontend, except spotify_match_pool
    # right after a fresh match attempt - see the model field above). Preserve
    # the backend's own fields across this sync as long as the destination
    # itself hasn't changed; a full unconditional overwrite here would
    # otherwise wipe chromecast_pushed_count back to None on every single
    # queue change, making the advancer think nothing has ever been pushed to
    # the device's native queue and refill (potentially duplicating) it
    # unnecessarily.
    existing = get_playback_session()
    same_destination = (
        existing and existing.get('destination_type') == params.destination_type
        and existing.get('destination_id') == params.destination_id
    )
    save_playback_session(
        destination_type=params.destination_type,
        destination_id=params.destination_id,
        now_playing=params.now_playing,
        queue=params.queue,
        shuffle_enabled=params.shuffle_enabled,
        spotify_match_pool=params.spotify_match_pool if params.spotify_match_pool is not None
            else (existing.get('spotify_match_pool') if same_destination else None),
        chromecast_pushed_count=existing.get('chromecast_pushed_count') if same_destination else None,
        last_status=existing.get('last_status') if same_destination else None,
    )
    return {"status": "saved"}

@app.get("/api/playback-session")
async def get_playback_session_route():
    session = get_playback_session()
    if not session:
        return {"destination_type": None}
    return session

@app.delete("/api/playback-session")
async def delete_playback_session():
    clear_playback_session()
    return {"status": "cleared"}

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
            SELECT id, artist_name, album_name, track_number, track_total
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

def _start_tag_cleanup_background():
    """Kicks off a background tag-cleanup pass if one isn't already running.
    Returns False (no-op, no error) if one is already in flight - same
    pattern as the other library background jobs above."""
    if not tag_cleanup_lock.acquire(blocking=False):
        return False
    try:
        tag_cleanup_progress.clear()
        tag_cleanup_progress.update(status="running")

        def _run():
            try:
                tag_cleanup.clean_tags(get_db_connection, tag_cleanup_progress)
            finally:
                tag_cleanup_lock.release()

        threading.Thread(target=_run, daemon=True).start()
        return True
    except Exception:
        tag_cleanup_lock.release()
        raise

@app.post("/api/library/tag-cleanup", response_model=TagCleanupStatus, status_code=status.HTTP_202_ACCEPTED)
async def start_tag_cleanup():
    if not _start_tag_cleanup_background():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="A tag cleanup is already running.")
    return tag_cleanup_progress

@app.get("/api/library/tag-cleanup/status", response_model=TagCleanupStatus)
async def get_tag_cleanup_status():
    return tag_cleanup_progress

@app.get("/api/library/tag-cleanup/fixed")
async def get_tag_cleanup_fixed(
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    db: psycopg2.extensions.connection = Depends(get_db),
):
    # original_track_name/original_artist_name are only ever set on a row
    # this job actually changed (see tag_cleanup.clean_tags) - either one
    # being non-null is enough to identify a "fixed" row, since a change can
    # touch just the title (leading track-number strip) or just the artist.
    cur = db.cursor(cursor_factory=RealDictCursor)
    cur.execute("""
        SELECT COUNT(*) AS count FROM known_tracks
        WHERE original_track_name IS NOT NULL OR original_artist_name IS NOT NULL
    """)
    total = cur.fetchone()['count']
    cur.execute("""
        SELECT id, original_track_name, original_artist_name, track_name, artist_name
        FROM known_tracks
        WHERE original_track_name IS NOT NULL OR original_artist_name IS NOT NULL
        ORDER BY id
        LIMIT %(limit)s OFFSET %(offset)s
    """, {'limit': limit, 'offset': offset})
    tracks = cur.fetchall()
    cur.close()
    return {"total": total, "tracks": tracks}

def _start_external_artwork_background():
    """Kicks off a background external-artwork backfill if one isn't already
    running. Returns False (no-op, no error) if one is already in flight -
    used both by the explicit endpoint below and the auto-resume-on-startup
    check (a run interrupted by a container rebuild - mid-run or mid-wait
    for a rate limit - otherwise wouldn't restart itself, since the
    in-memory progress/lock don't survive the process exiting)."""
    if not external_artwork_lock.acquire(blocking=False):
        return False
    try:
        external_artwork_progress.clear()
        external_artwork_progress.update(status="running")

        def _run():
            try:
                external_artwork.backfill_external_artwork(get_db_connection, external_artwork_progress)
            finally:
                external_artwork_lock.release()

        threading.Thread(target=_run, daemon=True).start()
        return True
    except Exception:
        external_artwork_lock.release()
        raise

@app.post("/api/library/external-artwork", response_model=ExternalArtworkStatus, status_code=status.HTTP_202_ACCEPTED)
async def start_external_artwork():
    if not _start_external_artwork_background():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="An external artwork backfill is already running.")
    return external_artwork_progress

@app.get("/api/library/external-artwork/status", response_model=ExternalArtworkStatus)
async def get_external_artwork_status():
    return external_artwork_progress

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