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
    enqueue_ytmusic_push_job, get_active_ytmusic_push_job, get_next_queued_ytmusic_push_job,
    count_queued_ytmusic_push_jobs, has_pending_ytmusic_push_work,
    list_pending_ytmusic_push_jobs, delete_ytmusic_push_job,
    get_playlist_track_cache, replace_playlist_track_cache,
    find_known_track_external_match, backfill_known_track_ids, backfill_ytmusic_cache_match,
    create_radio_session, get_radio_session, append_seen_track_keys, set_radio_session_track_state,
    set_radio_session_generation_status, append_radio_playlist_items, set_radio_session_playlist,
    set_radio_session_ytmusic_job, stop_radio_session, append_tracks_to_ytmusic_push_job,
    count_searches_since_last_reset, get_spotify_quota_state,
    set_prewarm_paused, is_prewarm_paused, upsert_radio_discovered_track,
    get_radio_cooldown_days, set_radio_cooldown_days, get_radio_tuning, set_radio_tuning,
    get_active_generated_radio_session_id,
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
from . import ytmusic_connect
from . import ytmusic_push_job
from . import external_artwork
from . import spotify_prewarm
from . import tag_cleanup
from . import playback_advancer
from . import shazam_identify
from . import lastfm
from . import radio_engine
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

# Guards the two /playlists/all-tracks routes' refresh path (fetch-live then
# replace_playlist_track_cache) - confirmed live this is a real risk, not
# theoretical: two overlapping refreshes for the same platform each fetch
# their own snapshot of "every track that should exist" independently, then
# each deletes any cached row *not* in their own snapshot. Interleaved, the
# second's delete can wipe out rows the first just wrote (from a playlist the
# second's own fetch happened to race past), silently truncating the cache
# well below the real track count with no error anywhere. Serializing the
# whole fetch+replace per platform behind this lock closes that window.
_playlist_cache_refresh_locks = {'spotify': threading.Lock(), 'ytmusic': threading.Lock()}

# No in-memory progress dict for this one, unlike the jobs above - its state
# (status/counters) lives entirely in the ytmusic_push_job Postgres row (see
# database.py), read directly by the status route below. Just a lock to stop
# two overlapping background threads.
ytmusic_push_job_lock = threading.Lock()

tag_cleanup_lock = threading.Lock()
tag_cleanup_progress = {"status": "idle"}

# Not a one-shot backfill like the jobs above (no lock/trigger-route needed -
# there's nothing to "start" on demand) - see playback_advancer.run for why.
playback_advancer_progress = {"status": "idle"}

# Same "runs continuously, nothing to start on demand" shape as
# playback_advancer above - see shazam_identify.run for why this one isn't
# gated on app idleness the way spotify_prewarm is.
shazam_identify_progress = {"status": "idle"}

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
        "/api/spotify/search-budget",
    }
    if not path.endswith("/status") and path not in routine_poll_paths:
        _last_activity_at = time.time()
    return await call_next(request)

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
    # Cached cross-service matches (see spotify_prewarm.py / ytmusic_push_job.py)
    # - drives the Spotify/YT Music availability badges on library track cards,
    # the same way matched_spotify_uri/matched_ytmusic_video_id drive them on
    # playlist track cards.
    spotify_track_id: Optional[str] = None
    ytmusic_video_id: Optional[str] = None
    # Was populated for Discover-tab suggestions on non-English tracks back
    # when Discover was Gemini-based (international catalogs index these
    # under their native-script name, not a romanized transliteration, so
    # search needed this to find the track). Discover has since moved to
    # Last.fm (see the lastfm module + discover_music below), which returns
    # real catalog names directly with no separate native-script concept -
    # these fields stay on the model (harmless, both Optional) since
    # /api/discover/preview and /api/spotify/discover-match still accept and
    # use them if ever populated, but they're currently always None.
    native_track_name: Optional[str] = None
    native_artist_name: Optional[str] = None
    # Populated only for a radio_engine.generate_radio_batch_track_first
    # candidate - id above already carries a known_tracks id for a library
    # cache hit, but a radio_discovered_tracks cache hit (a track not in the
    # library) has no known_tracks id to put there at all, so it needs its
    # own pre-resolved spotify_uri/radio_track_id instead. Without these on
    # this model, RadioStartResponse/RadioMoreResponse's List[Track]
    # serialization silently dropped both - confirmed live this meant the
    # seed-track-fallback and ytmusic-push paths (the only consumers of
    # these routes' HTTP response, as opposed to playback_advancer's
    # background refill, which reads radio_engine's raw dicts directly and
    # was never affected) always needed a live search even for an already-
    # cached discovered track, undermining the same "use cached ids to cut
    # search rate" goal everywhere else in Radio already follows.
    spotify_uri: Optional[str] = None
    radio_track_id: Optional[int] = None
    # Why this specific candidate was suggested (e.g. "Discovered - similar
    # track") and which mechanism produced it ("Last.fm", "App logic") -
    # see radio_engine.generate_radio_batch_track_first's own
    # selection_reason/selection_engine tagging. Also needed here for the
    # same reason as spotify_uri/radio_track_id above - without a declared
    # field, it was silently dropped before reaching the frontend, so the
    # seed-track-fallback and ytmusic-push paths' plays showed the Play
    # Log's generic default reason instead of the real one.
    selection_reason: Optional[str] = None
    selection_engine: Optional[str] = None

class DiscoveryHistoryEntry(BaseModel):
    id: Optional[int] = None
    generated_at: Optional[str] = None # Will be datetime string
    prompt_used: str
    track_list: List[Track] # Assuming track_list is a JSONB array of tracks

class DiscoveryParameters(BaseModel):
    # Comma-separated artist names (built by the frontend from whatever's
    # currently filtered in the Library tab - see handleDiscoverFromLibrary
    # in frontend/src/App.js). genre/mood/tempo/complexity were dropped once
    # Discover moved off Gemini to Last.fm's similar-artist API (below) -
    # Last.fm has no such filters, and genre already carries through by
    # construction since the seed itself is genre-filtered.
    seed_tracks: str
    exclude_known: Optional[bool] = True
    # How many recommended tracks to aim for - a ceiling, not a guarantee
    # (lastfm.discover_tracks may return fewer if the seed's genuinely
    # strong-match pool runs dry, or exclude_known removes some). Clamped
    # server-side regardless of what the client sends. Means "how many
    # artists" instead of "how many tracks" when group_by_artist is set.
    limit: Optional[int] = 10
    # When true, groups results by artist (a few of each recommended
    # artist's actual top tracks) instead of one track per artist - see
    # lastfm.discover_tracks' tracks_per_artist param.
    group_by_artist: Optional[bool] = False

class RadioStartRequest(BaseModel):
    # 'track' | 'artist' | 'playlist' - purely descriptive (drives
    # seed_description/UI labeling), the actual seeding logic only ever
    # looks at seed_artists below, same "always artist names" shape
    # DiscoveryParameters.seed_tracks already uses.
    seed_type: str
    seed_description: Optional[str] = None
    seed_artists: List[str]
    # 'browser' | 'ytmusic' - decides whether this session's /more calls
    # return tracks to play (browser) or push into a YouTube Music playlist
    # instead (ytmusic, see append_tracks_to_ytmusic_push_job).
    destination_type: str
    # The literal track/artist's-track/playlist's-track the user actually
    # picked, when the frontend has one - so the picked track can play
    # first, before radio's own similar-track suggestions. Both required
    # together; excluded from the returned suggestion batch (see
    # start_radio) so it's never immediately re-suggested right after
    # playing, and folded into seen_track_keys so a later /more call won't
    # suggest it either.
    seed_track_name: Optional[str] = None
    seed_artist_name: Optional[str] = None
    # Always 'discovery' now - this app's own Last.fm-driven candidate
    # generation, matched/queued track by track. Kept as a field (rather than
    # dropped outright) since radio_session.engine is still a stored column.
    engine: Optional[str] = 'discovery'

class RadioMoreRequest(BaseModel):
    count: Optional[int] = 10

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
    status: str  # idle | running | waiting_active_use | waiting_radio_active | waiting_not_connected | paused_manually | done | error
    processed: Optional[int] = None
    matched: Optional[int] = None
    error: Optional[str] = None
    # The manual override's current persisted state (see database.is_prewarm_paused) -
    # included here (rather than a separate endpoint) so the existing status
    # poll already picks it up for free.
    paused: bool = False

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
    album_count: int
    artist_count: int
    tracks: List[Track]

class AlbumArtworkStats(BaseModel):
    total_albums: int
    albums_with_artwork: int

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
    # Set when this same track also exists as a local file (see
    # _attach_spotify_track_extras) - lets the frontend play it locally
    # instead of requiring a Spotify Connect device.
    local_track_id: Optional[int] = None
    # Set when this same track is also known to be on YouTube Music (see
    # _attach_spotify_track_extras) - backs the Playlists tab's
    # cross-service availability badge.
    matched_ytmusic_video_id: Optional[str] = None

class SpotifyMatchResult(BaseModel):
    matched: bool
    uri: Optional[str] = None
    artwork_url: Optional[str] = None
    reason: Optional[str] = None  # "no_match" | "unavailable", set when matched=False
    # Set only for a track with no known_tracks row at all (not part of the
    # library) - see upsert_radio_discovered_track/radio_discovered_tracks.
    # The frontend carries this onto the queued track (radio_track_id) the
    # same way a library match's own id already rides along as local_id, so
    # database._record_track_played can stamp last_played_at on the right
    # row regardless of source.
    radio_track_id: Optional[int] = None

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

    # spotify_prewarm.py is no longer auto-started at boot - Spotify Connect
    # playback is gone, so this job's only remaining purpose is pre-populating
    # known_tracks.spotify_track_id for the Push-to-Playlist feature, which
    # isn't worth spending search budget on unattended. Paused by default
    # (database.is_prewarm_paused); toggle it on manually via
    # POST /api/spotify/prewarm/pause if you want it running.

    # Same auto-resume principle for the paced YouTube Music push queue (see
    # ytmusic_push_job.py) - each job's progress lives entirely in its own
    # ytmusic_push_job row, not the in-memory lock/thread, so a restart just
    # needs to check whether anything was left queued/mid-flight and pick it
    # back up (the worker itself processes the queue in FIFO order).
    if ytmusic_connect.is_connected() and has_pending_ytmusic_push_work():
        active = get_active_ytmusic_push_job()
        if active:
            print(f"Resuming YouTube Music push job in the background ({active['tracks_processed_total']} of {active['total']} processed so far).")
        else:
            print("Resuming YouTube Music push queue in the background.")
        _start_ytmusic_push_job_background()

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

    # Also unconditional - makes zero Spotify calls (see
    # spotify_connect.identify_via_shazam), so unlike spotify_prewarm it
    # doesn't need to wait for app idleness to avoid competing with
    # interactive Spotify use for Spotify's rate limit.
    print("Starting Shazam track identification in the background.")
    threading.Thread(
        target=shazam_identify.run,
        args=(get_db_connection, shazam_identify_progress),
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
                        bitrate, sample_rate, channels, file_size_bytes, file_path, artwork_source_url, is_favorite, last_played,
                        spotify_track_id, ytmusic_video_id
                 FROM known_tracks {where_sql}
                 ORDER BY {DEDUP_NORM_TITLE_SQL}, {DEDUP_NORM_ARTIST_SQL}, {DEDUP_NORM_ALBUM_SQL},
                          {QUALITY_TIER_RANK_SQL} ASC, bitrate DESC NULLS LAST, id ASC
                ) AS best_tracks
            """
        else:
            from_sql = f"known_tracks {where_sql}"

        cur = db.cursor(cursor_factory=RealDictCursor)
        # album_count matches the frontend's own "artist||album" grouping key
        # (see albumGroupKey in App.js) rather than a plain DISTINCT album_name,
        # so a compilation-style empty-artist album and same-titled albums by
        # different artists count the same way here as they do in the Shuffle
        # Albums grouping itself. artist_name is a required (NOT NULL) column,
        # so no null-coalescing is needed for the artist half.
        cur.execute(f"""
            SELECT COUNT(*) AS count,
                   COUNT(DISTINCT artist_name || '||' || COALESCE(album_name, '')) AS album_count,
                   COUNT(DISTINCT artist_name) AS artist_count
            FROM {from_sql}
        """, params)
        counts = cur.fetchone()
        total = counts['count']
        album_count = counts['album_count']
        artist_count = counts['artist_count']

        # RANDOM() genuinely reshuffles the matching rows before truncating, so a
        # shuffled fetch is a true uniform sample of the whole filtered set (not
        # just the first page) and never repeats a row within the same request.
        order_sql = "ORDER BY RANDOM()" if shuffle else "ORDER BY artist_name, album_name, track_name"
        cur.execute(f"""
            SELECT id, track_name, artist_name, album_name, genre, year, duration_seconds,
                   bitrate, sample_rate, channels, file_size_bytes, file_path, artwork_source_url, is_favorite, last_played,
                   spotify_track_id, ytmusic_video_id
            FROM {from_sql}
            {order_sql}
            LIMIT %(limit)s OFFSET %(offset)s
        """, {**params, 'limit': limit, 'offset': offset})
        tracks = cur.fetchall()
        cur.close()
        for track in tracks:
            file_path = track.pop('file_path', None)
            track['file_format'] = os.path.splitext(file_path)[1].lstrip('.').upper() if file_path else None
        return {"total": total, "album_count": album_count, "artist_count": artist_count, "tracks": tracks}
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
               bitrate, sample_rate, channels, file_size_bytes, file_path, artwork_source_url, is_favorite, last_played,
               spotify_track_id, ytmusic_video_id
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
    spotify_available: Optional[bool] = None,
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
        if spotify_available is not None:
            extra_clauses.append("(spotify_track_id IS NOT NULL) = %(spotify_available)s")
            params['spotify_available'] = spotify_available
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

@app.get("/api/library/artists/search", response_model=List[GroupEntry])
async def search_library_artists(q: str, limit: int = 8, db: psycopg2.extensions.connection = Depends(get_db)):
    """Distinct artist names matching a partial query, most-tracks-first -
    powers the Library tab's artist autocomplete box. Reuses GroupEntry
    (key/label/count/sample_track_id) even though this isn't a browse-groups
    call, so the frontend can reuse the same thumbnail-rendering approach."""
    q = q.strip()
    if not q:
        return []
    try:
        cur = db.cursor()
        cur.execute(f"""
            SELECT artist_name, COUNT(*), {SAMPLE_TRACK_SQL} FROM known_tracks
            WHERE artist_name ILIKE %(q)s
            GROUP BY artist_name ORDER BY COUNT(*) DESC LIMIT %(limit)s
        """, {'q': f"%{q}%", 'limit': limit})
        results = [{"key": row[0], "label": row[0], "count": row[1], "sample_track_id": row[2]} for row in cur.fetchall()]
        cur.close()
        return results
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

@app.get("/api/spotify/playlists", response_model=List[SpotifyPlaylist])
def list_spotify_playlists():
    if not spotify_connect.is_connected():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Spotify not connected")
    return spotify_connect.list_playlists()

def _attach_spotify_track_extras(tracks):
    """Bulk-enriches a live 'By Playlist' Spotify track list with the same
    two cross-reference signals the cached 'All Tracks' route carries
    (local_track_id, matched_ytmusic_video_id) - this route reads the live
    API instead of the cache, so it does the equivalent joins fresh per
    call. matched_ytmusic_video_id has two possible sources: the
    known_tracks bridge (this track is also a local file with a resolved
    YT match), or a reverse lookup against already-resolved ytmusic cache
    rows (some YT Music playlist track was matched to this exact Spotify
    id, independent of any local file). Two indexed queries, no external
    API calls."""
    ids = [t['uri'].split(':')[-1] for t in tracks]
    if not ids:
        return tracks
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT spotify_track_id, id, ytmusic_video_id FROM known_tracks WHERE spotify_track_id = ANY(%s)", (ids,))
    known_by_id = {r[0]: (r[1], r[2]) for r in cur.fetchall()}
    cur.execute(
        "SELECT matched_spotify_uri, track_id FROM playlist_track_cache WHERE platform = 'ytmusic' AND matched_spotify_uri = ANY(%s)",
        ([f"spotify:track:{i}" for i in ids],),
    )
    ytmusic_by_uri = dict(cur.fetchall())
    cur.close()
    conn.close()
    for t, sid in zip(tracks, ids):
        known = known_by_id.get(sid)
        t['local_track_id'] = known[0] if known else None
        t['matched_ytmusic_video_id'] = (known[1] if known else None) or ytmusic_by_uri.get(f"spotify:track:{sid}")
    return tracks

def _attach_ytmusic_track_extras(tracks):
    """Mirror of _attach_spotify_track_extras above, for a live 'By
    Playlist' YouTube Music track list. matched_spotify_uri here can come
    from the known_tracks bridge or directly from this same track's own
    playlist_track_cache row (kept fresh by discover-match/
    bulk_backfill_cross_platform_matches)."""
    ids = [t['video_id'] for t in tracks]
    if not ids:
        return tracks
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT ytmusic_video_id, id, spotify_track_id FROM known_tracks WHERE ytmusic_video_id = ANY(%s)", (ids,))
    known_by_id = {r[0]: (r[1], r[2]) for r in cur.fetchall()}
    cur.execute(
        "SELECT track_id, matched_spotify_uri FROM playlist_track_cache WHERE platform = 'ytmusic' AND track_id = ANY(%s)",
        (ids,),
    )
    cached_by_id = dict(cur.fetchall())
    cur.close()
    conn.close()
    for t, vid in zip(tracks, ids):
        known = known_by_id.get(vid)
        t['local_track_id'] = known[0] if known else None
        spotify_from_known = f"spotify:track:{known[1]}" if known and known[1] else None
        t['matched_spotify_uri'] = cached_by_id.get(vid) or spotify_from_known
    return tracks

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
    return _attach_spotify_track_extras(tracks)

class PlaylistAllTracksResponse(BaseModel):
    tracks: List[Dict[str, Any]]
    skipped_count: int = 0
    refreshed_at: Optional[str] = None

@app.get("/api/spotify/playlists/all-tracks", response_model=PlaylistAllTracksResponse)
def get_spotify_all_playlist_tracks(refresh: bool = False):
    """Backs the Playlists tab's "All Tracks" mode - cached in the database
    (see database.playlist_track_cache) since flattening every playlist live
    is an N+1 fetch (one round trip per playlist) that used to make this
    view slow to open every time. Served from cache unconditionally unless
    refresh=true is passed (the tab's own Refresh button). Each track also
    carries isrc/popularity/explicit/release_date/genre - all free off the
    same playlist-items response except genre, which costs one batched
    request per ~50 unique artists (see spotify_connect.get_artist_genres)."""
    if not spotify_connect.is_connected():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Spotify not connected")
    if not refresh:
        cached = get_playlist_track_cache('spotify')
        if cached:
            return cached
    with _playlist_cache_refresh_locks['spotify']:
        tracks, skipped = spotify_connect.get_all_playlist_tracks()
        replace_playlist_track_cache('spotify', tracks, skipped)
    return get_playlist_track_cache('spotify')

def _create_spotify_playlist_from_uris(name, uris, skipped):
    """Shared tail for both playlist-creation routes below - create the
    playlist, add whatever URIs were resolved, report how many were skipped."""
    if not uris:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="None of these tracks could be matched to Spotify")

    playlist = spotify_connect.create_playlist(name)
    if playlist is None:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Could not create the playlist - if this account was connected before playlist-modify-private was "
                   "added, disconnect and reconnect Spotify in Settings to grant it",
        )
    if not spotify_connect.add_tracks_to_playlist(playlist['id'], uris):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Playlist created but adding tracks failed partway through")

    return {"playlist_url": playlist['url'], "added": len(uris), "skipped": skipped}

class CreatePlaylistFromLibraryRequest(BaseModel):
    name: str
    track_ids: List[int]

@app.post("/api/spotify/playlists/from-library")
async def create_spotify_playlist_from_library(
    params: CreatePlaylistFromLibraryRequest, db: psycopg2.extensions.connection = Depends(get_db),
):
    if not spotify_connect.is_connected():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Spotify not connected")
    if not params.track_ids:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No tracks to push")

    cur = db.cursor()
    cur.execute("SELECT id, spotify_track_id FROM known_tracks WHERE id = ANY(%s)", (params.track_ids,))
    spotify_ids_by_track = dict(cur.fetchall())
    cur.close()
    # Preserve the caller's (shuffled) order - dict lookups above don't, a
    # plain WHERE id = ANY() doesn't either.
    uris = [f"spotify:track:{spotify_ids_by_track[tid]}" for tid in params.track_ids if spotify_ids_by_track.get(tid)]
    skipped = len(params.track_ids) - len(uris)
    return _create_spotify_playlist_from_uris(params.name, uris, skipped)

class DiscoveredTrackForPlaylist(BaseModel):
    track_name: str
    artist_name: str
    native_track_name: Optional[str] = None
    native_artist_name: Optional[str] = None

class CreatePlaylistFromDiscoveredRequest(BaseModel):
    name: str
    tracks: List[DiscoveredTrackForPlaylist]

@app.post("/api/spotify/playlists/from-discovered")
def create_spotify_playlist_from_discovered(params: CreatePlaylistFromDiscoveredRequest):
    """Same idea as from-library above, but for Discover suggestions - these
    have no known_tracks row to read a cached spotify_track_id from, so each
    one is matched live via spotify_connect.search_track instead. Only
    reasonable because Discover result sets are always small (main.py caps
    DiscoveryParameters.limit at 30) - the same live-match-everything
    approach would be a bad idea for a large library push, which is why that
    route stays cache-only and just skips unmatched tracks instead."""
    if not spotify_connect.is_connected():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Spotify not connected")
    if not params.tracks:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No tracks to push")

    uris = []
    for t in params.tracks:
        attempts = [(t.native_track_name, t.artist_name)] if t.native_track_name else []
        attempts.append((t.track_name, t.artist_name))
        matched_uri = None
        hit_wall = False
        for track_name, artist_name in attempts:
            result, match, _identified = spotify_connect.search_track(track_name, artist_name)
            if result == 'unavailable':
                hit_wall = True
                break
            if match:
                matched_uri = match['uri']
                break
        if matched_uri:
            uris.append(matched_uri)
        if hit_wall:
            break  # no point burning more requests into the same rate limit - use whatever matched so far

    skipped = len(params.tracks) - len(uris)
    return _create_spotify_playlist_from_uris(params.name, uris, skipped)

@app.get("/api/ytmusic/auth/status")
def ytmusic_auth_status():
    return {"connected": ytmusic_connect.is_connected()}

class YtMusicPlaylist(BaseModel):
    id: str
    name: Optional[str] = None
    track_count: int = 0
    artwork_url: Optional[str] = None

class YtMusicPlaylistTrack(BaseModel):
    video_id: str
    track_name: str
    artist_name: Optional[str] = None
    artwork_url: Optional[str] = None
    # Set when this same track also exists as a local file (see
    # _attach_ytmusic_track_extras) - lets the frontend play it locally
    # instead of requiring a live YouTube tab.
    local_track_id: Optional[int] = None
    # Set when this same video is already known to match a Spotify catalog
    # track (see _attach_ytmusic_track_extras) - lets a click skip the live
    # discover-match search, and backs the Playlists tab's cross-service
    # availability badge.
    matched_spotify_uri: Optional[str] = None

@app.get("/api/ytmusic/playlists", response_model=List[YtMusicPlaylist])
def list_ytmusic_playlists():
    if not ytmusic_connect.is_connected():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="YouTube Music not connected")
    playlists = ytmusic_connect.list_playlists()
    if playlists is None:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not read YouTube Music playlists")
    return playlists

@app.get("/api/ytmusic/playlists/{playlist_id}/tracks", response_model=List[YtMusicPlaylistTrack])
def get_ytmusic_playlist_tracks(playlist_id: str):
    """Unlike the Spotify equivalent, there's no "can't read a playlist you
    don't own" restriction to handle here - playlistItems.list on your own
    playlist has no such gate, so this never needs a 403 branch."""
    if not ytmusic_connect.is_connected():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="YouTube Music not connected")
    tracks = ytmusic_connect.get_playlist_tracks(playlist_id)
    if tracks is None:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not read this playlist's tracks")
    return _attach_ytmusic_track_extras(tracks)

@app.get("/api/ytmusic/playlists/all-tracks", response_model=PlaylistAllTracksResponse)
def get_ytmusic_all_playlist_tracks(refresh: bool = False):
    """Same caching approach as the Spotify equivalent above."""
    if not ytmusic_connect.is_connected():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="YouTube Music not connected")
    if not refresh:
        cached = get_playlist_track_cache('ytmusic')
        if cached:
            return cached
    with _playlist_cache_refresh_locks['ytmusic']:
        tracks, skipped = ytmusic_connect.get_all_playlist_tracks()
        replace_playlist_track_cache('ytmusic', tracks, skipped)
    return get_playlist_track_cache('ytmusic')

@app.post("/api/ytmusic/auth/start")
def ytmusic_auth_start():
    """Kicks off Google's device-code flow - unlike Spotify's redirect-based
    login, there's no URL to send the browser to directly. The frontend shows
    the returned verification_url/user_code and polls /auth/poll until the
    user finishes the pairing on any device."""
    if not ytmusic_connect.is_configured():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="YTMUSIC_OAUTH_CLIENT_ID/YTMUSIC_OAUTH_CLIENT_SECRET not set in .env")
    try:
        return ytmusic_connect.start_auth()
    except Exception:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not start the YouTube Music sign-in - check the OAuth client id/secret")

@app.post("/api/ytmusic/auth/poll")
def ytmusic_auth_poll():
    try:
        result = ytmusic_connect.poll_auth()
    except Exception:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="YouTube Music sign-in failed - check the OAuth client id/secret")
    return {"status": result}

@app.post("/api/ytmusic/auth/disconnect")
def ytmusic_auth_disconnect():
    ytmusic_connect.disconnect()
    return {"status": "disconnected"}

@app.post("/api/ytmusic/playlists/from-discovered")
def create_ytmusic_playlist_from_discovered(params: CreatePlaylistFromDiscoveredRequest):
    """Same request shape as the Spotify equivalent above (reused directly,
    not duplicated - it's pure text with no Spotify-specific fields) - each
    track is matched live via ytmusic_connect.create_playlist_and_push, same
    "Discover result sets are always small" reasoning as the Spotify route."""
    if not ytmusic_connect.is_connected():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="YouTube Music not connected")
    if not params.tracks:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No tracks to push")

    tracks = [t.model_dump() for t in params.tracks]
    result = ytmusic_connect.create_playlist_and_push(params.name, tracks)
    if result is None:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not create the YouTube Music playlist")
    if result["playlist_url"] is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="None of these tracks could be matched on YouTube Music")
    return result

# Below this size, push synchronously in one request (unchanged behavior -
# a live search+insert pair costs real YouTube Data API quota per track,
# 100 + 50 units, so this stays small enough to comfortably fit one
# request's worth of quota). At or above it, the request would need more
# quota than a single day safely allows, so it's added to the FIFO queue
# ytmusic_push_job.py works through instead - it paces search+insert across
# however many days it takes, appending to that job's own growing playlist,
# and automatically moves on to the next queued job once each one finishes.
YTMUSIC_LIBRARY_PUSH_LIMIT = 30

@app.post("/api/ytmusic/playlists/from-library")
def create_ytmusic_playlist_from_library(
    params: CreatePlaylistFromLibraryRequest, db: psycopg2.extensions.connection = Depends(get_db),
):
    if not ytmusic_connect.is_connected():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="YouTube Music not connected")
    if not params.track_ids:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No tracks to push")

    if len(params.track_ids) <= YTMUSIC_LIBRARY_PUSH_LIMIT:
        cur = db.cursor()
        cur.execute("SELECT id, track_name, artist_name FROM known_tracks WHERE id = ANY(%s)", (params.track_ids,))
        rows_by_id = {row[0]: {"track_name": row[1], "artist_name": row[2]} for row in cur.fetchall()}
        cur.close()
        # Preserve the caller's (possibly shuffled) order - a dict lookup and
        # a plain WHERE id = ANY() don't, same reasoning as the Spotify route.
        tracks = [rows_by_id[tid] for tid in params.track_ids if tid in rows_by_id]

        result = ytmusic_connect.create_playlist_and_push(params.name, tracks)
        if result is None:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not create the YouTube Music playlist")
        if result["playlist_url"] is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="None of these tracks could be matched on YouTube Music")
        # Report against the full requested count (not just any dropped by a
        # future cap change) so skipped stays an honest total.
        result["skipped"] = len(params.track_ids) - result["added"]
        return result

    cur = db.cursor()
    cur.execute("SELECT id, track_name, artist_name FROM known_tracks WHERE id = ANY(%s)", (params.track_ids,))
    rows_by_id = {row[0]: {"track_name": row[1], "artist_name": row[2]} for row in cur.fetchall()}
    cur.close()
    tracks = [
        {"track_name": rows_by_id[tid]["track_name"], "artist_name": rows_by_id[tid]["artist_name"], "known_track_id": tid}
        for tid in params.track_ids if tid in rows_by_id
    ]
    if not tracks:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="None of these track ids were found in the library")

    # Always accepted - a push while another is active/waiting_quota just
    # joins the back of the FIFO queue instead of being rejected. Counting
    # ahead-of-it jobs before enqueueing (rather than after) means this new
    # job's own id is correctly excluded from its own queue position.
    queue_position = count_queued_ytmusic_push_jobs() + (1 if get_active_ytmusic_push_job() else 0)
    enqueue_ytmusic_push_job(params.name, tracks)
    _start_ytmusic_push_job_background()
    return {"job_started": True, "queue_position": queue_position}

def _match_track_to_spotify(db, track_id):
    """Looks up (or performs and caches) a local track's Spotify match. Shared
    by the single-track and batch match routes. Returns a dict shaped like
    SpotifyMatchResult, or None if track_id doesn't exist in known_tracks."""
    cur = db.cursor()
    cur.execute(
        "SELECT track_name, artist_name, spotify_track_id, spotify_checked, spotify_album_art_url, file_path, isrc, ytmusic_video_id "
        "FROM known_tracks WHERE id = %s",
        (track_id,),
    )
    row = cur.fetchone()
    if not row:
        cur.close()
        return None
    track_name, artist_name, cached_id, checked, cached_art, file_path, isrc, ytmusic_video_id = row

    if checked:
        cur.close()
        if not cached_id:
            return {"matched": False, "reason": "no_match"}
        return {"matched": True, "uri": f"spotify:track:{cached_id}", "artwork_url": cached_art}

    # Exact-id cross-reference before a live search - if this same track was
    # already matched to Spotify via a YT Music playlist (the discover-match
    # route below), reuse that instead of searching again.
    if ytmusic_video_id:
        cur.execute(
            "SELECT matched_spotify_uri, artwork_url FROM playlist_track_cache WHERE platform = 'ytmusic' AND track_id = %s",
            (ytmusic_video_id,),
        )
        cache_row = cur.fetchone()
        if cache_row and cache_row[0]:
            spotify_id = cache_row[0].split(':')[-1]
            cur.execute(
                "UPDATE known_tracks SET spotify_track_id = %s, spotify_url = %s, spotify_album_art_url = %s, spotify_checked = TRUE WHERE id = %s",
                (spotify_id, f"https://open.spotify.com/track/{spotify_id}", cache_row[1], track_id),
            )
            db.commit()
            cur.close()
            return {"matched": True, "uri": cache_row[0], "artwork_url": cache_row[1]}

    result, match, identified = spotify_connect.search_track(track_name, artist_name, file_path=file_path, known_isrc=isrc)
    if identified:
        # Persist Shazam's identification independent of whatever Spotify's
        # own outcome is - a correct name + ISRC is useful even when Spotify
        # can't be checked right now (rate-limited) or doesn't have this
        # recording in its catalog at all (confirmed live: both happen).
        # album_name/year use COALESCE (fill only if currently unset) rather
        # than an unconditional overwrite like track_name/artist_name get -
        # Shazam's album field can be a reissue/remaster title (e.g. "Metallica
        # (Remastered)") that isn't necessarily an improvement on a local tag
        # that's already correct, unlike a garbled/placeholder title which
        # never is.
        cur.execute(
            """UPDATE known_tracks SET
                track_name = %s, artist_name = %s,
                original_track_name = COALESCE(original_track_name, track_name),
                original_artist_name = COALESCE(original_artist_name, artist_name),
                isrc = %s,
                album_name = COALESCE(album_name, %s),
                year = COALESCE(year, %s)
            WHERE id = %s""",
            (identified['track_name'], identified['artist_name'], identified['isrc'],
             identified.get('album_name'), identified.get('year'), track_id),
        )
        db.commit()
        track_name, artist_name = identified['track_name'], identified['artist_name']

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

    if match and ytmusic_video_id:
        # Completes the cross-reference from this direction too - a YT Music
        # playlist track sharing this exact video_id never has to search
        # Spotify itself now.
        backfill_ytmusic_cache_match(ytmusic_video_id, match['uri'])

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

class DiscoverTrackMatchRequest(BaseModel):
    track_name: str
    artist_name: str
    native_track_name: Optional[str] = None
    native_artist_name: Optional[str] = None
    # Set only for a YouTube Music playlist track (never a pure-text Discover
    # suggestion, which has no such id) - lets this route do an exact-id
    # cross-reference before falling back to fuzzy search, and write the
    # result back to known_tracks/playlist_track_cache so it's never
    # searched for again from any path.
    ytmusic_video_id: Optional[str] = None

@app.post("/api/spotify/discover-match", response_model=SpotifyMatchResult)
def match_discovered_track_to_spotify(params: DiscoverTrackMatchRequest):
    """Same catalog search as the local-library matcher above, but for a
    Discover-tab suggestion or a YouTube Music playlist track - neither has
    a known_tracks row of its own to read a cached match from directly, but
    a YT Music track (ytmusic_video_id given) can still short-circuit via an
    exact-id cross-reference against known_tracks/playlist_track_cache
    before ever searching. Pure-text Discover suggestions (no
    ytmusic_video_id) have no id to cross-reference and stay a one-off
    ephemeral lookup, same as before."""
    if not spotify_connect.is_connected():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Spotify not connected")

    known_match = None
    if params.ytmusic_video_id:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(
            "SELECT matched_spotify_uri FROM playlist_track_cache WHERE platform = 'ytmusic' AND track_id = %s",
            (params.ytmusic_video_id,),
        )
        cache_row = cur.fetchone()
        cur.close()
        conn.close()
        if cache_row and cache_row[0]:
            return {"matched": True, "uri": cache_row[0], "artwork_url": None}
        known_match = find_known_track_external_match(ytmusic_video_id=params.ytmusic_video_id)
        if known_match and known_match['spotify_track_id']:
            uri = f"spotify:track:{known_match['spotify_track_id']}"
            backfill_ytmusic_cache_match(params.ytmusic_video_id, uri)
            return {"matched": True, "uri": uri, "artwork_url": None}

    # Confirmed empirically against iTunes/Deezer (both back the same catalog
    # data Spotify draws from) for Hebrew: an artist with an established
    # international presence is indexed under their *romanized* name (e.g.
    # "Ehud Banai"), but individual *track titles* stay in native script
    # ("יוצא לאור") - a fully-romanized title gets zero raw results, and so
    # does a fully-native search (mismatches the romanized artist field).
    # Try romanized-artist + native-title first (the combination that
    # actually matched real catalog entries), then the plain romanized
    # fallback. Capped at 2 attempts (not a 3rd fully-native one) since
    # Spotify's search is the more rate-limit-fragile of the two APIs this
    # app talks to for Discover.
    attempts = []
    if params.native_track_name:
        attempts.append((params.native_track_name, params.artist_name))
    attempts.append((params.track_name, params.artist_name))
    for track_name, artist_name in attempts:
        result, match, _identified = spotify_connect.search_track(track_name, artist_name)
        if result == 'unavailable':
            return {"matched": False, "reason": "unavailable"}
        if match:
            if params.ytmusic_video_id:
                backfill_ytmusic_cache_match(params.ytmusic_video_id, match['uri'])
                if known_match:
                    backfill_known_track_ids(known_match['id'], spotify_track_id=match['uri'].split(':')[-1])
            radio_track_id = None
            if not known_match:
                # No known_tracks row at all for this one (not part of the
                # library) - worth remembering for a *future* radio
                # session's own cache tiers regardless of whether Discover
                # or Radio's own client-side fallback is what searched for
                # it just now - see upsert_radio_discovered_track.
                radio_track_id = upsert_radio_discovered_track(
                    match.get('track_name') or track_name, match.get('artist_name') or artist_name,
                    None, match['uri'], match.get('artwork_url'),
                )
            return {"matched": True, "uri": match['uri'], "artwork_url": match.get('artwork_url'), "radio_track_id": radio_track_id}
    if params.ytmusic_video_id:
        # A settled "no match" is still worth recording - so the background
        # prewarm job (which treats matched_at IS NULL as "not tried yet")
        # doesn't redundantly re-search this same track later.
        backfill_ytmusic_cache_match(params.ytmusic_video_id, None)
    return {"matched": False, "reason": "no_match"}

class DiscoverPreviewRequest(BaseModel):
    track_name: str
    artist_name: str
    native_track_name: Optional[str] = None
    native_artist_name: Optional[str] = None

@app.post("/api/discover/preview")
def get_discover_track_preview(params: DiscoverPreviewRequest):
    """30-second sample clip for a Discover suggestion, via iTunes/Deezer -
    doesn't touch Spotify at all, so works regardless of whether Spotify is
    connected or rate-limited."""
    result = None
    # See match_discovered_track_to_spotify above for how this priority order
    # was derived - romanized artist + native title matched real iTunes/
    # Deezer catalog entries where neither fully-romanized nor fully-native
    # did. iTunes/Deezer are far less rate-limit-sensitive than Spotify, so a
    # 3rd (fully-native) attempt is worth it here specifically.
    if params.native_track_name:
        result = external_artwork.find_track_preview(params.artist_name, params.native_track_name)
    if not result and params.native_track_name and params.native_artist_name:
        result = external_artwork.find_track_preview(params.native_artist_name, params.native_track_name)
    if not result:
        result = external_artwork.find_track_preview(params.artist_name, params.track_name)
    if not result:
        return {"preview_url": None, "artwork_url": None}
    return {"preview_url": result['preview_url'], "artwork_url": result.get('artwork_url')}

@app.get("/api/discover/artwork")
def get_discover_track_artwork(track_name: str, artist_name: str):
    """Backfills artwork for a Discover candidate with no known_tracks/
    radio_discovered_tracks cache hit at all (a plain-text, never-searched
    Last.fm suggestion) - see radio_engine.generate_radio_batch_track_first,
    whose candidates only carry artwork_url for an already-cached match.
    Called lazily, one row at a time as it scrolls into view (see
    RadioPlaylistPreview's LazyTrackArt), not upfront for a whole
    500-1000-track list - same reasoning as /api/discover/preview's own lazy
    fetch."""
    return {"artwork_url": lastfm.track_artwork(artist_name, track_name)}

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
    return {**spotify_prewarm_progress, "paused": is_prewarm_paused()}

class PrewarmPauseRequest(BaseModel):
    paused: bool

@app.post("/api/spotify/prewarm/pause")
async def set_spotify_prewarm_paused(params: PrewarmPauseRequest):
    """Manual, explicit override for the background search-consuming
    spotify_prewarm.py job. Checked ahead of its existing is_idle gating, for
    whenever that isn't reason enough on its own to stop consuming budget
    right now."""
    set_prewarm_paused(params.paused)
    return {"paused": params.paused}

@app.get("/api/radio/cooldown-days")
async def get_radio_cooldown_days_route():
    """How many days a track Radio itself played sits out of its own
    candidate tiers before it's eligible to be suggested again - see
    radio_engine.py's find_cached_artist_tracks/find_any_cached_tracks/
    _index_cached_tracks_by_key."""
    return {"cooldown_days": get_radio_cooldown_days()}

class RadioCooldownRequest(BaseModel):
    cooldown_days: int

@app.post("/api/radio/cooldown-days")
async def set_radio_cooldown_days_route(params: RadioCooldownRequest):
    if params.cooldown_days < 0:
        raise HTTPException(status_code=400, detail="cooldown_days must be >= 0")
    set_radio_cooldown_days(params.cooldown_days)
    return {"cooldown_days": params.cooldown_days}

class RadioTuning(BaseModel):
    min_track_match_score: float
    min_artist_match_score: float
    track_similar_limit: int
    similar_artists_per_seed: int

@app.get("/api/radio/tuning", response_model=RadioTuning)
async def get_radio_tuning_route():
    """The user-adjustable versions of lastfm.py's own MIN_TRACK_MATCH_SCORE/
    MIN_ARTIST_MATCH_SCORE/TRACK_SIMILAR_LIMIT/SIMILAR_ARTISTS_PER_SEED
    constants - see database.get_radio_tuning and lastfm._tuning."""
    return get_radio_tuning()

@app.post("/api/radio/tuning", response_model=RadioTuning)
async def set_radio_tuning_route(params: RadioTuning):
    if not (0 <= params.min_track_match_score <= 1):
        raise HTTPException(status_code=400, detail="min_track_match_score must be between 0 and 1")
    if not (0 <= params.min_artist_match_score <= 1):
        raise HTTPException(status_code=400, detail="min_artist_match_score must be between 0 and 1")
    if not (1 <= params.track_similar_limit <= 50):
        raise HTTPException(status_code=400, detail="track_similar_limit must be between 1 and 50")
    if not (1 <= params.similar_artists_per_seed <= 50):
        raise HTTPException(status_code=400, detail="similar_artists_per_seed must be between 1 and 50")
    set_radio_tuning(
        params.min_track_match_score, params.min_artist_match_score,
        params.track_similar_limit, params.similar_artists_per_seed,
    )
    return params

@app.get("/api/play-log")
async def get_play_log(limit: int = 2000, db: psycopg2.extensions.connection = Depends(get_db)):
    """Every track with a recorded last_played_at (see database._record_track_played),
    newest first - both known_tracks (this user's own library) and
    radio_discovered_tracks (a Radio/Discover match not in the library -
    see that table's own comment) carry this column, so this is a UNION of
    both rather than just one. played_at is formatted here as a plain
    'YYYY-MM-DD HH:MM:SS' string, not an ISO/tz-aware one - the column is
    already stored as America/New_York wall-clock time (database.now_ny_naive),
    deliberately not UTC, and letting the frontend's `new Date(...)` parse
    it would silently reinterpret it as the viewer's own local time zone
    instead. Displaying the stored string verbatim is what actually keeps
    it reading as NY time everywhere it's shown, same reasoning as the NY-
    time work itself.

    known_track_id is only ever set for a 'library' row - the frontend
    builds its artwork src from GET /tracks/{id}/artwork with it, same
    pattern used everywhere else in the app (see App.js). A
    'radio_discovered' row has no known_tracks row to point at, so its
    artwork_url (radio_discovered_tracks.spotify_album_art_url, already a
    real, direct CDN URL) is returned as-is instead. Sorting/filtering
    (by artist/track/source, or a date range) all happen client-side once
    fetched - this is a single-user personal log, not a dataset that needs
    server-side pagination at any plausible scale, and doing it client-side
    means every filter/sort change is instant, no round trip."""
    cur = db.cursor()
    cur.execute("""
        SELECT id AS known_track_id, track_name, artist_name, last_played_at,
               'library' AS source, NULL::TEXT AS artwork_url, last_played_reason, last_played_engine
        FROM known_tracks
        WHERE last_played_at IS NOT NULL
        UNION ALL
        SELECT NULL::INTEGER AS known_track_id, track_name, artist_name, last_played_at,
               'radio_discovered' AS source, spotify_album_art_url AS artwork_url, last_played_reason, last_played_engine
        FROM radio_discovered_tracks
        WHERE last_played_at IS NOT NULL
        ORDER BY last_played_at DESC
        LIMIT %s
    """, (limit,))
    rows = cur.fetchall()
    cur.close()
    return [
        {
            "known_track_id": known_track_id,
            "track_name": track_name,
            "artist_name": artist_name,
            "played_at": last_played_at.strftime("%Y-%m-%d %H:%M:%S"),
            "source": source,
            "artwork_url": artwork_url,
            "reason": reason,
            "engine": engine,
        }
        for known_track_id, track_name, artist_name, last_played_at, source, artwork_url, reason, engine in rows
    ]

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

@app.get("/api/spotify/search-budget")
async def get_spotify_search_budget():
    """Live view of the Spotify /search rate-limit state - two independent
    gates, both surfaced so the UI never shows a healthy-looking counter
    while search is actually blocked (confirmed live: the self-imposed
    estimate can read well under its ceiling while a real 429's Retry-After
    cooldown is still fully in effect, since that's a separate mechanism -
    see spotify_connect.py's search_budget_available/
    search_block_remaining_seconds, both DB-backed so a container restart
    doesn't lose either). "limit" is not a number Spotify publishes - it's
    this app's own self-learned daily estimate (starts at
    database.QUOTA_ESTIMATE_DEFAULT), ratcheted down when a real 429
    confirms reason=QUOTA_EXCEEDED (spotify_connect.py's
    _learn_from_quota_exceeded) and back up once a day after a clean
    stretch (database.maybe_recover_spotify_quota_estimate) -
    last_adjusted_at/last_adjustment_reason show when/why it last moved,
    if ever. "used" counts since the last reset - per explicit user
    request, that's only ever a real, confirmed QUOTA_EXCEEDED transition
    (spotify_connect._learn_from_quota_exceeded/database.reset_search_count),
    NOT a calendar-day boundary - so it keeps climbing across midnight and
    across days until Spotify actually pushes back. Polled by the Radio
    tab's traffic-light meter and shown alongside the Cleanup tab's
    prewarm status, since every Spotify-search consumer in the app
    (Discover, Radio, library matching, both prewarm jobs) shares all of
    this."""
    used = count_searches_since_last_reset()
    blocked_seconds = spotify_connect.search_block_remaining_seconds()
    quota_state = get_spotify_quota_state()
    return {
        "used": used,
        "limit": quota_state["daily_estimate"],
        "blocked_seconds": round(blocked_seconds),
        "last_adjusted_at": quota_state["last_adjusted_at"],
        "last_adjustment_reason": quota_state["last_adjustment_reason"],
    }

def _start_ytmusic_push_job_background():
    """Kicks off the background YouTube Music push job if one isn't already
    running - same non-blocking-lock pattern as _start_spotify_prewarm_background,
    for the same reason (a run interrupted by a container rebuild needs to
    auto-resume, since the in-memory lock doesn't survive the process exiting;
    the job's actual progress lives in the ytmusic_push_job row instead)."""
    if not ytmusic_push_job_lock.acquire(blocking=False):
        return False
    try:
        def _run():
            try:
                ytmusic_push_job.run(get_db_connection)
            finally:
                ytmusic_push_job_lock.release()

        threading.Thread(target=_run, daemon=True).start()
        return True
    except Exception:
        ytmusic_push_job_lock.release()
        raise

class YtMusicPushJobStatus(BaseModel):
    status: str = "idle"
    name: Optional[str] = None
    playlist_url: Optional[str] = None
    total: Optional[int] = None
    matched: Optional[int] = None
    inserted: Optional[int] = None
    skipped: Optional[int] = None
    tracks_processed_total: Optional[int] = None
    pace_tracks_per_day: Optional[float] = None
    eta_days: Optional[float] = None
    error: Optional[str] = None
    queued_count: int = 0

@app.get("/api/ytmusic/push-job/status", response_model=YtMusicPushJobStatus)
async def get_ytmusic_push_job_status():
    queued_count = count_queued_ytmusic_push_jobs()
    job = get_active_ytmusic_push_job()
    if not job:
        # A brief window can exist right after enqueueing, before the worker
        # thread promotes the next queued job to 'running' - fall back to
        # showing that job as 'queued' rather than flashing "idle".
        job = get_next_queued_ytmusic_push_job()
        if not job:
            return {"status": "idle", "queued_count": 0}
        queued_count = max(queued_count - 1, 0)  # this job itself isn't "behind" anything
        return {
            "status": "queued", "name": job["name"], "total": job["total"],
            "matched": 0, "inserted": 0, "skipped": 0, "tracks_processed_total": 0,
            "queued_count": queued_count,
        }

    # Pace/ETA measured in quota units spent, not wall-clock time - most of a
    # job's elapsed time is spent idle waiting for tomorrow's quota, so a
    # wall-clock rate would swing wildly between polls. units_spent_total and
    # tracks_processed_total are both monotonic (unaffected by idle waiting),
    # so this stays stable and self-corrects as the cache-hit ratio improves.
    pace_tracks_per_day, eta_days = None, None
    if job["tracks_processed_total"] > 0 and job["units_spent_total"] > 0:
        avg_units_per_track = job["units_spent_total"] / job["tracks_processed_total"]
        pace_tracks_per_day = ytmusic_push_job.DAILY_SAFE_BUDGET / avg_units_per_track
        remaining = max(job["total"] - job["tracks_processed_total"], 0)
        eta_days = remaining / pace_tracks_per_day if pace_tracks_per_day > 0 else None

    return {
        "status": job["status"],
        "name": job["name"],
        # music.youtube.com, not www.youtube.com - same playlist object
        # either way, but the plain youtube.com link opens the regular
        # YouTube player instead of YouTube Music (see create_playlist_and_push
        # in ytmusic_connect.py for the same fix on the one-shot push path).
        "playlist_url": f"https://music.youtube.com/playlist?list={job['playlist_id']}" if job["playlist_id"] else None,
        "total": job["total"],
        "matched": job["matched"],
        "inserted": job["inserted"],
        "skipped": job["skipped"],
        "tracks_processed_total": job["tracks_processed_total"],
        "pace_tracks_per_day": pace_tracks_per_day,
        "eta_days": eta_days,
        "error": job["error"],
        "queued_count": queued_count,
    }

class YtMusicPendingPushJob(BaseModel):
    id: int
    name: Optional[str] = None
    total: Optional[int] = None
    matched: Optional[int] = None
    tracks_processed_total: Optional[int] = None
    status: str
    created_at: Optional[str] = None

@app.get("/api/ytmusic/push-jobs", response_model=List[YtMusicPendingPushJob])
async def list_ytmusic_push_jobs():
    """Every job still owed work (queued, running, or paused on quota),
    oldest first - fetched by the frontend only once there's more than one
    to show, rather than folded into the single-job /status route above."""
    return list_pending_ytmusic_push_jobs()

@app.delete("/api/ytmusic/push-jobs/{job_id}")
async def remove_ytmusic_push_job(job_id: int):
    """Removes a pending push outright - stops future work on it, but
    doesn't undo whatever it already added to its playlist (see
    database.delete_ytmusic_push_job)."""
    if not delete_ytmusic_push_job(job_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No pending push with that id")
    return {"status": "removed"}

@app.get("/api/library/track-identification/status")
async def get_track_identification_status():
    return shazam_identify_progress

@app.get("/api/library/track-identification/stats")
async def get_track_identification_stats(db: psycopg2.extensions.connection = Depends(get_db)):
    # isrc is only ever set by the Shazam-based fallbacks in
    # spotify_connect.search_track (text search or audio recognition) -
    # unlike original_track_name/original_artist_name (also touched by
    # tag_cleanup.py), a non-null isrc unambiguously means this specific
    # pipeline identified the row, whether or not Spotify itself has since
    # confirmed a match for it.
    cur = db.cursor()
    cur.execute("SELECT COUNT(*) FROM known_tracks")
    total = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM known_tracks WHERE isrc IS NOT NULL")
    identified = cur.fetchone()[0]
    # Every identified row always has original_track_name/original_artist_name
    # set (the UPDATE in shazam_identify.py/spotify_connect.py sets them
    # unconditionally via COALESCE), but they only *differ* from the current
    # tag when Shazam's title/artist actually corrected something - the rest
    # were already tagged correctly and just needed the ISRC confirmed.
    cur.execute("""
        SELECT COUNT(*) FROM known_tracks
        WHERE isrc IS NOT NULL AND (original_track_name != track_name OR original_artist_name != artist_name)
    """)
    renamed = cur.fetchone()[0]
    cur.close()
    return {"total": total, "identified": identified, "renamed": renamed, "already_correct": identified - renamed}

@app.get("/api/library/track-identification/tracks")
async def get_track_identification_tracks(
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    db: psycopg2.extensions.connection = Depends(get_db),
):
    cur = db.cursor(cursor_factory=RealDictCursor)
    cur.execute("SELECT COUNT(*) AS count FROM known_tracks WHERE isrc IS NOT NULL")
    total = cur.fetchone()['count']
    cur.execute("""
        SELECT id, original_track_name, original_artist_name, track_name, artist_name, isrc,
               spotify_checked, spotify_track_id
        FROM known_tracks
        WHERE isrc IS NOT NULL
        ORDER BY id
        LIMIT %(limit)s OFFSET %(offset)s
    """, {'limit': limit, 'offset': offset})
    tracks = cur.fetchall()
    cur.close()
    return {"total": total, "tracks": tracks}

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
    # startQueue's spotifyMatchPool option in App.js) - the remaining
    # not-yet-tried candidate pool for playback_advancer's lookahead refill
    # to keep working through (a plain {candidates, cursor} for library-cast,
    # or the same shape plus a radio_session_id for a Radio-fed pool, see
    # radio_engine.py/playback_advancer.py). Omitted on routine syncs (Next/
    # Prev, a plain queue reorder), in which case the backend's own tracked
    # pool is kept.
    spotify_match_pool: Optional[Dict[str, Any]] = None
    # Explicit "drop whatever pool is there now" signal - a bare
    # spotify_match_pool: null in JSON is indistinguishable from the field
    # being omitted entirely (both parse to None), so an omitted pool can't
    # double as "clear it": this flag disambiguates a genuine clear (e.g.
    # stopRadio, or starting something on Spotify with nothing to hand off)
    # from "no opinion, preserve whatever's already stored."
    clear_spotify_match_pool: bool = False

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
    # spotify_match_pool deliberately does NOT use the same_destination gate
    # chromecast_pushed_count/last_status still do below - confirmed live
    # this was a real bug: any routine sync (Next/Prev, a queue update, the
    # periodic position sync) whose destination_id didn't line up exactly
    # with what's already stored (a stale value racing a page reload before
    # the true server state loads, a Spotify Connect device reconnecting
    # under a slightly different id, two tabs syncing against each other)
    # silently wiped spotify_match_pool to None, even though nothing
    # actually intended a clear - with an active radio_session_id still on
    # now_playing but no pool left to refill from, Radio got permanently
    # stuck with an empty queue and a disabled Next button, no path back
    # short of a restart. clear_spotify_match_pool already exists as the
    # one explicit, intentional way to clear it (see Stop Radio in App.js) -
    # nothing legitimately relies on a destination mismatch doing the same
    # thing by accident, so this now only ever preserves or explicitly
    # replaces it, never implicitly drops it.
    resolved_pool = None if params.clear_spotify_match_pool \
        else (params.spotify_match_pool if params.spotify_match_pool is not None
            else (existing.get('spotify_match_pool') if existing else None))
    save_playback_session(
        destination_type=params.destination_type,
        destination_id=params.destination_id,
        now_playing=params.now_playing,
        queue=params.queue,
        shuffle_enabled=params.shuffle_enabled,
        spotify_match_pool=resolved_pool,
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

@app.get("/api/library/artwork/album-stats", response_model=AlbumArtworkStats)
async def get_album_artwork_stats(db: psycopg2.extensions.connection = Depends(get_db)):
    # Album-level coverage, not track-level - shown on both the Missing
    # Artwork and Track ID tabs (the latter can now find artwork too, via
    # the Shazam integration in shazam_identify.run). Grouped the same way
    # artwork itself is cached/shared (artist_name + normalized album, see
    # artwork.cache_key_for) - has_artwork is kept consistent across every
    # track in a group by the jobs that set it (check_artwork_presence's own
    # sibling broadcast, external_artwork.apply_artwork_result), so
    # bool_or(has_artwork) per group reflects the album's real state even if
    # a run is still mid-progress and hasn't touched every row in the group
    # yet. Tracks with no album tag at all aren't really "an album" to count
    # here, so they're excluded rather than each becoming a singleton group.
    cur = db.cursor()
    cur.execute(f"""
        SELECT COUNT(*), COUNT(*) FILTER (WHERE has_art)
        FROM (
            SELECT bool_or(has_artwork) AS has_art
            FROM known_tracks
            WHERE album_name IS NOT NULL AND album_name <> ''
            GROUP BY artist_name, {normalized_album_sql('album_name')}
        ) albums
    """)
    total_albums, albums_with_artwork = cur.fetchone()
    cur.close()
    return {"total_albums": total_albums, "albums_with_artwork": albums_with_artwork}

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

def _filter_known_tracks(suggested_tracks: List[Track], db: psycopg2.extensions.connection) -> List[Track]:
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
def discover_music(params: DiscoveryParameters, db: psycopg2.extensions.connection = Depends(get_db)):
    if not lastfm.is_configured():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Last.fm not configured - set LASTFM_API_KEY")

    seed_artists = [a.strip() for a in params.seed_tracks.split(',') if a.strip()]
    limit = max(1, min(params.limit or 10, 30))
    tracks_per_artist = 3 if params.group_by_artist else 1
    print(f"Received discovery request seeded by: {seed_artists}, limit={limit}, group_by_artist={params.group_by_artist}")

    raw_tracks = lastfm.discover_tracks(seed_artists, target_count=limit, tracks_per_artist=tracks_per_artist)
    suggested_tracks = [Track(track_name=t['track_name'], artist_name=t['artist_name']) for t in raw_tracks]
    print(f"Last.fm suggested {len(suggested_tracks)} tracks.")

    final_tracks = suggested_tracks
    if params.exclude_known:
        final_tracks = _filter_known_tracks(suggested_tracks, db)
        print(f"After filtering known tracks, {len(final_tracks)} remain.")

    # Store discovery history - prompt_used repurposed to describe the seed
    # (this column predates the Gemini->Last.fm switch and originally held
    # the LLM prompt text; keeping it as a plain description avoids a schema
    # change for what's still just a human-readable "what was this run
    # seeded by" record).
    try:
        cur = db.cursor()
        track_list_dicts = [track.model_dump() for track in final_tracks]
        cur.execute(
            "INSERT INTO discovery_history (prompt_used, track_list) VALUES (%s, %s)",
            (f"Last.fm similar-artist discovery seeded by: {', '.join(seed_artists)}", json.dumps(track_list_dicts))
        )
        db.commit()
        cur.close()
        print("Discovery history stored successfully.")
    except Exception as e:
        print(f"Error storing discovery history: {e}")
        db.rollback() # Rollback in case of error

    return final_tracks

class RadioStartResponse(BaseModel):
    session_id: int
    tracks: List[Track]
    # Set only for a 'ytmusic'-destination session - the frontend has
    # nothing to queue/play itself for that destination, it just polls
    # /api/ytmusic/push-job/status using this id's job.
    ytmusic_push_job_id: Optional[int] = None
    # True only when both of radio_engine.generate_radio_batch_track_first's
    # Last.fm-driven tiers (track-level recursion, then the artist-level
    # reserve) came up genuinely empty and it had to fall back to an
    # untargeted cached-library track - always False for browser/ytmusic
    # destinations, which never touch Spotify's search at all.
    degraded: bool = False

class RadioMoreResponse(BaseModel):
    tracks: List[Track]
    # True when this call (after retrying a couple of rounds against the
    # session's own seed) still found nothing new - the seed artist pool has
    # run dry, not a transient blip. Doesn't stop the session server-side;
    # the frontend decides whether to surface "this station is running low"
    # and/or stop polling.
    exhausted: bool = False
    # See RadioStartResponse.degraded.
    degraded: bool = False

class RadioPlaylistItem(BaseModel):
    """One row of a pre-generated radio_session.playlist - a text-level
    Last.fm candidate, possibly already cache-resolved to a real Spotify
    match (id/spotify_uri/radio_track_id set) but not yet actually searched
    otherwise. item_id is stable identity (radio_session.next_item_id
    counter), not array position - survives reorder/delete."""
    item_id: int
    track_name: str
    artist_name: str
    album_name: Optional[str] = None
    selection_reason: Optional[str] = None
    selection_engine: Optional[str] = None
    # 'in_library' (already cache-resolved at generation time) or
    # 'unresolved' (plain Last.fm text, no Spotify search attempted yet -
    # deliberately not 'not_in_library', which would be a claim this hasn't
    # earned).
    source: Optional[str] = None
    id: Optional[int] = None
    spotify_uri: Optional[str] = None
    radio_track_id: Optional[int] = None
    artwork_url: Optional[str] = None
    # Last.fm's own track.getSimilar score (0-1) relative to whichever
    # already-collected track this one was actually found from (its BFS
    # parent, not necessarily the original seed) - see
    # lastfm.track_similar_tracks and radio_engine.generate_radio_batch_track_first.
    match: Optional[float] = None
    # 1 minus the compounded product of every hop's own match score along
    # the BFS path back to the original seed - 0 at the seed itself,
    # approaching 1 the longer/weaker the chain of hops that reached this
    # track has been. See generate_radio_batch_track_first's own docstring.
    drift: Optional[float] = None
    # From the local file's own tags (known_tracks) - only ever set for a
    # genuine library match (source='in_library' via a real known_tracks
    # row, not a radio_discovered_tracks cache hit or a plain-text
    # candidate, neither of which have this metadata at all). The frontend
    # summary panel discloses how many tracks actually carry these rather
    # than assuming full coverage.
    genre: Optional[str] = None
    year: Optional[int] = None
    duration_seconds: Optional[int] = None

class RadioSessionInfo(BaseModel):
    id: int
    status: str  # 'active' | 'stopped'
    seed_type: str
    seed_description: Optional[str] = None
    destination_type: Optional[str] = None
    engine: str
    # Pre-generated playlist support - see push_radio_playlist_to_ytmusic/
    # reorder_radio_playlist/remove_radio_playlist_item.
    generation_status: str = 'ready'  # 'generating' | 'ready' | 'error'
    target_length: Optional[int] = None
    playlist: List[RadioPlaylistItem] = []

class RadioPushYtmusicRequest(BaseModel):
    # Which playlist items to push, by their stable item_id (same identity
    # reorder/remove already use) - None/omitted pushes the whole
    # server-side playlist; a list restricts to just those items (in the
    # playlist's own order, not the order given here), letting the caller
    # push only whatever a client-side facet filter currently has in view.
    item_ids: Optional[List[int]] = None

class RadioPushYtmusicResponse(BaseModel):
    job_id: int

@app.post("/api/radio/{session_id}/push-to-ytmusic", response_model=RadioPushYtmusicResponse)
def push_radio_playlist_to_ytmusic(session_id: int, params: RadioPushYtmusicRequest = RadioPushYtmusicRequest()):
    """Pushes a generated (spotify+discovery) session's reviewed playlist to
    YouTube Music - the "lowest hanging fruit" version of Phase 2's real
    "push somewhere" step, reusing ytmusic_push_job.py's already-built,
    already-quota-paced worker wholesale rather than writing a new one for
    Spotify first. Unlike the Spotify-cache-hit-only shortcut this was
    weighed against, this resolves the *whole* list via a real search per
    track (see ytmusic_push_job.run) - a track from radio_session.playlist
    with no known_track_id is always a cache 'miss' there, by design."""
    session = get_radio_session(session_id)
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No radio session with that id")
    if not session['playlist']:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Nothing to push - the playlist is empty")
    if not ytmusic_connect.is_connected():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="YouTube Music not connected")

    playlist = session['playlist']
    if params.item_ids is not None:
        wanted = set(params.item_ids)
        playlist = [t for t in playlist if t.get('item_id') in wanted]
        if not playlist:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Nothing to push - none of those items are still on the playlist")

    push_tracks = [{"track_name": t['track_name'], "artist_name": t['artist_name']} for t in playlist]
    job_id = enqueue_ytmusic_push_job(session['seed_description'] or f"Discover session {session_id}", push_tracks)
    if job_id is None:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not start the YouTube Music push")
    set_radio_session_ytmusic_job(session_id, None, job_id)
    _start_ytmusic_push_job_background()
    return {"job_id": job_id}

@app.post("/api/radio/start", response_model=RadioStartResponse)
def start_radio(params: RadioStartRequest, db: psycopg2.extensions.connection = Depends(get_db)):
    if not lastfm.is_configured():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Last.fm not configured - set LASTFM_API_KEY")
    if not params.seed_artists:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No seed artists to start radio from")
    if params.destination_type not in ('browser', 'ytmusic'):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="destination_type must be 'browser' or 'ytmusic'")
    engine = params.engine or 'discovery'
    if engine != 'discovery':
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="engine must be 'discovery'")

    seed_description = params.seed_description or f"Radio from {', '.join(params.seed_artists[:3])}"
    has_seed_track = bool(params.seed_track_name and params.seed_artist_name)
    seed_key = radio_engine.radio_track_key(params.seed_track_name, params.seed_artist_name) if has_seed_track else None

    # Excludes the seed track itself from the generated batch (via the
    # initial seen-keys arg) so it's never immediately re-suggested right
    # after playing - the frontend plays it separately, first, using the
    # richer object it already has (a real local file or a native playlist
    # track) rather than this plain track_name/artist_name reconstruction.
    initial_seen = [seed_key] if seed_key else []
    degraded = False
    track_frontier = []
    discovery_state = {}
    track_dicts = radio_engine.generate_fresh_radio_tracks(params.seed_artists, params.destination_type, initial_seen, 15, db)
    seen_keys = [radio_engine.radio_track_key(t['track_name'], t['artist_name']) for t in track_dicts]
    if seed_key:
        seen_keys.append(seed_key)

    session_id = create_radio_session(
        seed_type=params.seed_type,
        seed_description=seed_description,
        seed_artists=params.seed_artists,
        destination_type=params.destination_type,
        seen_track_keys=seen_keys,
        seed_track_name=params.seed_track_name,
        seed_artist_name=params.seed_artist_name,
        track_frontier=track_frontier,
    )
    if session_id is None:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not start a radio session")
    if discovery_state:
        set_radio_session_track_state(session_id, track_frontier, discovery_state)

    if params.destination_type == 'ytmusic':
        if not ytmusic_connect.is_connected():
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="YouTube Music not connected")
        # Unlike browser/spotify (where the frontend plays the seed track
        # itself, separately, first), there's no in-app playback for a
        # ytmusic-destination session - the seed track's only chance to lead
        # off the actual result is being the first track physically pushed
        # into the playlist.
        push_tracks = track_dicts
        if has_seed_track:
            push_tracks = [{"track_name": params.seed_track_name, "artist_name": params.seed_artist_name}] + track_dicts
        job_id = enqueue_ytmusic_push_job(seed_description, push_tracks)
        if job_id is None:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not start the YouTube Music radio playlist")
        set_radio_session_ytmusic_job(session_id, None, job_id)
        _start_ytmusic_push_job_background()
        return {"session_id": session_id, "tracks": [], "ytmusic_push_job_id": job_id}

    return {"session_id": session_id, "tracks": [Track(**t) for t in track_dicts], "degraded": degraded}

@app.post("/api/radio/{session_id}/more", response_model=RadioMoreResponse)
def get_more_radio_tracks(session_id: int, params: RadioMoreRequest, db: psycopg2.extensions.connection = Depends(get_db)):
    session = get_radio_session(session_id)
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No radio session with that id")
    if session['status'] != 'active':
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="This radio session has been stopped")

    count = max(1, min(params.count or 10, 30))
    degraded = False
    track_dicts = radio_engine.generate_fresh_radio_tracks(
        session['seed_artists'], session['destination_type'], session['seen_track_keys'] or [], count, db,
    )
    if track_dicts:
        append_seen_track_keys(session_id, [radio_engine.radio_track_key(t['track_name'], t['artist_name']) for t in track_dicts])

    if session['destination_type'] == 'ytmusic':
        if track_dicts and session['ytmusic_push_job_id']:
            append_tracks_to_ytmusic_push_job(session['ytmusic_push_job_id'], track_dicts)
            _start_ytmusic_push_job_background()
        return {"tracks": [], "exhausted": len(track_dicts) == 0}

    return {"tracks": [Track(**t) for t in track_dicts], "exhausted": len(track_dicts) == 0, "degraded": degraded}

@app.get("/api/radio/active-generated")
def get_active_generated_radio_session():
    """Lets the frontend restore Discover's own generatingSession state
    after a page refresh (or a fresh tab) - see database.get_active_generated_radio_session_id's
    own docstring for why a generated session needs a separate restore path
    from the live-session one below (it's never tagged onto
    playback_session.now_playing at all). {"session_id": None} rather than
    404 when there isn't one - this is a routine "is there anything to
    restore" check, not an error case."""
    return {"session_id": get_active_generated_radio_session_id()}

@app.get("/api/radio/{session_id}", response_model=RadioSessionInfo)
def get_radio_session_route(session_id: int):
    """Lets the frontend confirm a radio_session_id it already has (from a
    restored now_playing/queue - see /api/playback-session) is still genuinely
    'active' before restoring the Radio tab's own UI state around it on
    page load - see App.js's session-restore effect. Without this, a
    refreshed tab had no way to tell "Radio is still actually running,
    server-side, right now" apart from "an old, already-stopped session's
    tag is just sitting there on stale localStorage/playback_session data,"
    so it always came back showing no active session even when one
    genuinely still was."""
    session = get_radio_session(session_id)
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No radio session with that id")
    return session

class RadioQueueItemRequest(BaseModel):
    item_id: int

def _reorder_or_remove_committed(session_id, item_id, committed_queue, playback, remove):
    """Shared by /reorder and /remove for the case where item_id is already
    committed - present in the singleton playback_session row's own queue,
    not radio_session.playlist. Returns True if it handled (and persisted)
    the request, False if item_id wasn't found there (so the caller falls
    through to check playlist instead)."""
    for i, entry in enumerate(committed_queue):
        if entry.get('item_id') != item_id:
            continue
        if remove:
            new_queue = committed_queue[:i] + committed_queue[i + 1:]
        elif i == 0:
            return True  # reorder to top, already there - nothing to do
        else:
            new_queue = [committed_queue[i]] + committed_queue[:i] + committed_queue[i + 1:]
        save_playback_session(
            destination_type=playback.get('destination_type'), destination_id=playback.get('destination_id'),
            now_playing=playback.get('now_playing'), queue=new_queue,
            shuffle_enabled=playback.get('shuffle_enabled', False), spotify_match_pool=playback.get('spotify_match_pool'),
            chromecast_pushed_count=playback.get('chromecast_pushed_count'), last_status=playback.get('last_status'),
        )
        return True
    return False

@app.post("/api/radio/{session_id}/reorder", response_model=RadioSessionInfo)
def reorder_radio_playlist(session_id: int, params: RadioQueueItemRequest):
    """Spec point 7 - moves item_id to the front of wherever it currently
    lives. A not-yet-committed playlist item promotes within the pending
    list only (cheap, purely local - it becomes whatever the refill loop
    tries next, no Spotify interaction needed). An already-committed item
    (one of the up-to-2 already add_to_queue'd lookahead tracks) swaps
    within that small set instead, since it's already resolved - see
    _reorder_or_remove_committed."""
    session = get_radio_session(session_id)
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No radio session with that id")

    playback = get_playback_session() or {}
    if _reorder_or_remove_committed(session_id, params.item_id, playback.get('queue') or [], playback, remove=False):
        return get_radio_session(session_id)

    playlist = list(session.get('playlist') or [])
    for i, item in enumerate(playlist):
        if item.get('item_id') == params.item_id:
            if i > 0:
                set_radio_session_playlist(session_id, [playlist[i]] + playlist[:i] + playlist[i + 1:])
            return get_radio_session(session_id)

    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No playlist item with that id")

@app.post("/api/radio/{session_id}/remove", response_model=RadioSessionInfo)
def remove_radio_playlist_item(session_id: int, params: RadioQueueItemRequest):
    """Spec point 8. Same split as reorder - a committed item needs the
    singleton playback_session.queue touched (and reconciliation flagged)
    since Spotify's real device was already told to queue it; a pending
    playlist item is a pure local splice."""
    session = get_radio_session(session_id)
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No radio session with that id")

    playback = get_playback_session() or {}
    if _reorder_or_remove_committed(session_id, params.item_id, playback.get('queue') or [], playback, remove=True):
        return get_radio_session(session_id)

    playlist = session.get('playlist') or []
    new_playlist = [item for item in playlist if item.get('item_id') != params.item_id]
    if len(new_playlist) == len(playlist):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No playlist item with that id")
    set_radio_session_playlist(session_id, new_playlist)
    return get_radio_session(session_id)

@app.post("/api/radio/{session_id}/stop")
def stop_radio(session_id: int):
    session = get_radio_session(session_id)
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No radio session with that id")
    stop_radio_session(session_id)
    return {"status": "stopped"}