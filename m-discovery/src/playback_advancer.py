import os
import re
import time

from . import wiim
from . import chromecast
from . import spotify_connect
from .database import get_db_connection

PUBLIC_BASE_URL = os.environ.get('PUBLIC_BASE_URL', 'http://localhost:8001')

# Matches the frontend's own DEFAULT_STATUS_POLL_INTERVAL_MS / SPOTIFY_STATUS_POLL_INTERVAL_MS
# (App.js) - the backend now polls at the same cadence the frontend used to,
# not on top of it.
POLL_INTERVAL_SECONDS = {'wiim': 2, 'chromecast': 2, 'spotify': 5}
IDLE_POLL_INTERVAL_SECONDS = 5

# How close to the end of a track counts as "about to finish" - matches the
# frontend's old nearEnd heuristic (App.js, duration - position < 4000)
# exactly, so behavior doesn't change, just where it runs. Used for WiiM
# (2s poll interval, comfortably smaller than this window).
NEAR_END_MS = 4000
# Spotify polls every 5s (POLL_INTERVAL_SECONDS['spotify']) - a 4000ms window
# is narrower than that interval, so two consecutive polls could land
# entirely on either side of it and never see "still playing, near end" at
# all. Widened past the poll interval so at least one tick reliably lands
# inside it before the track actually finishes.
SPOTIFY_NEAR_END_MS = 7000

# Same extension->MIME mapping as main.py's EXTENSION_MIME_TYPES, keyed by the
# file_format string already present on every synced track object instead of
# a file_path (the advancer only ever sees the JSONB snapshot, not the DB row).
FORMAT_MIME_TYPES = {
    'MP3': 'audio/mpeg', 'FLAC': 'audio/flac', 'M4A': 'audio/mp4', 'MP4': 'audio/mp4',
    'OGG': 'audio/ogg', 'OGA': 'audio/ogg', 'OPUS': 'audio/opus', 'WAV': 'audio/wav',
    'AAC': 'audio/aac', 'WMA': 'audio/x-ms-wma',
}
# How many upcoming items to keep loaded in Chromecast's native queue at
# once, and the low-water mark that triggers topping it back up - mirrors
# CHROMECAST_QUEUE_WINDOW=30 in main.py without needing to import it (that
# module imports this one, not the other way around).
CHROMECAST_REFILL_THRESHOLD = 5
CHROMECAST_REFILL_BATCH = 20

# Same cap as the frontend's old SPOTIFY_MATCH_CONSECUTIVE_CAP (App.js) - how
# many consecutive no-match candidates to try in one lookahead-refill pass
# before giving up for this tick, so one unlucky dry streak in the shuffle
# order can't burn requests unboundedly.
SPOTIFY_MATCH_CONSECUTIVE_CAP = 20


def _track_to_cast_item(track):
    content_type = FORMAT_MIME_TYPES.get((track.get('file_format') or '').upper(), 'audio/mpeg')
    return {
        'stream_url': f"{PUBLIC_BASE_URL}/api/tracks/{track['id']}/stream",
        'art_url': f"{PUBLIC_BASE_URL}/api/tracks/{track['id']}/artwork",
        'content_type': content_type,
        'title': track.get('track_name'),
        'artist': track.get('artist_name'),
        'album': track.get('album_name'),
    }


def _advance_wiim(save_session, destination_id, queue, has_started):
    """Polls a WiiM device directly (no queue/advance concept of its own - see
    src/wiim.py) and, on detecting the current track is about to finish or has
    already stopped on its own, pops the next queue item and starts it via
    wiim.play_url - the exact same call main.py's interactive /play route
    makes. Returns the updated has_started flag (reset to False whenever a
    new track starts, so "stopped" isn't misread as "finished" before
    playback has even begun)."""
    device = wiim.get_device(destination_id)
    if not device:
        return has_started

    result = wiim.get_status(device['ip'])
    if result is None:
        return has_started

    save_session(last_status={'reachable': True, **result})

    play_state = result.get('status')
    duration = result.get('duration_ms') or 0
    position = result.get('position_ms') or 0

    if play_state == 'play':
        has_started = True

    near_end = play_state == 'play' and duration > 0 and (duration - position) < NEAR_END_MS
    stopped_on_its_own = play_state == 'stop' and has_started

    if not (near_end or stopped_on_its_own):
        return has_started
    if not queue:
        return has_started

    next_track = queue[0]
    remaining_queue = queue[1:]
    stream_url = f"{PUBLIC_BASE_URL}/api/tracks/{next_track['id']}/stream"
    art_url = f"{PUBLIC_BASE_URL}/api/tracks/{next_track['id']}/artwork"
    wiim.play_url(
        device['ip'], next_track['id'], stream_url, art_url,
        title=next_track.get('track_name'), artist=next_track.get('artist_name'), album=next_track.get('album_name'),
    )
    save_session(now_playing=next_track, queue=remaining_queue)
    return False


def _advance_chromecast(save_session, destination_id, now_playing, queue, pushed_count, last_content_id):
    """Chromecast already natively advances through its own loaded queue (see
    chromecast.play_queue) - this doesn't drive advancement, it (a) notices
    when the device has moved on, by diffing content_id, so the server-side
    now_playing/queue/pushed_count stay in sync with reality, same shape as
    the frontend's own reconcileFromContentId, and (b) tops the native queue
    back up via queue_insert once it's about to run low, so playback doesn't
    stall past CHROMECAST_QUEUE_WINDOW tracks. Returns (pushed_count, last_content_id)."""
    result = chromecast.get_status(destination_id)
    if result is None:
        return pushed_count, last_content_id

    save_session(last_status=result)

    content_id = result.get('content_id')
    if content_id and content_id != last_content_id:
        last_content_id = content_id
        match = re.search(r'/tracks/(\d+)/stream', content_id)
        if match:
            new_track_id = int(match.group(1))
            current_id = (now_playing or {}).get('id')
            if current_id != new_track_id:
                forward_index = next((i for i, t in enumerate(queue) if t.get('id') == new_track_id), None)
                if forward_index is not None:
                    # Same "consumed" count as items the device stepped past -
                    # each one came out of what was already sitting in its
                    # native queue, so pushed_count (upcoming items still
                    # loaded there) drops by the same amount.
                    consumed = forward_index + 1
                    now_playing = queue[forward_index]
                    queue = queue[forward_index + 1:]
                    pushed_count = max((pushed_count or 0) - consumed, 0)
                    save_session(now_playing=now_playing, queue=queue)
                # else: skipped beyond our tracked window (TV remote used
                # non-sequentially, or a destination switch) - same tolerance
                # the frontend already accepted for this exact case; leave
                # now_playing/queue alone, they'll resync once something we
                # do recognize comes through.

    if (pushed_count or 0) < CHROMECAST_REFILL_THRESHOLD and queue:
        not_yet_pushed = queue[(pushed_count or 0):]
        batch = not_yet_pushed[:CHROMECAST_REFILL_BATCH]
        if batch:
            items = [_track_to_cast_item(t) for t in batch]
            if chromecast.queue_insert(destination_id, items):
                pushed_count = (pushed_count or 0) + len(batch)
                save_session(chromecast_pushed_count=pushed_count)

    return pushed_count, last_content_id


def _match_local_track_cached(track_id, track_name, artist_name):
    """Deliberately mirrors main.py's _match_track_to_spotify (same
    known_tracks.spotify_track_id/spotify_checked/spotify_album_art_url
    cache-check-then-search-then-cache shape) rather than importing it - that
    function takes a request-scoped connection from FastAPI's Depends(get_db),
    which doesn't fit this background thread's own connection lifecycle.
    Keeping this cache-first is what stops the advancer's lookahead refill
    from re-searching a track some other path (the interactive /match route,
    the spotify_prewarm job) already resolved - skipping it would burn a live
    request on every candidate and defeat the whole point of pacing this
    server-side in the first place."""
    conn = get_db_connection()
    if conn is None:
        return {"matched": False, "reason": "unavailable"}
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT spotify_track_id, spotify_checked, spotify_album_art_url, file_path, isrc FROM known_tracks WHERE id = %s",
            (track_id,),
        )
        row = cur.fetchone()
        if not row:
            cur.close()
            return {"matched": False, "reason": "no_match"}
        cached_id, checked, cached_art, file_path, isrc = row

        if checked:
            cur.close()
            if not cached_id:
                return {"matched": False, "reason": "no_match"}
            return {"matched": True, "uri": f"spotify:track:{cached_id}", "artwork_url": cached_art}

        result, match, identified = spotify_connect.search_track(track_name, artist_name, file_path=file_path, known_isrc=isrc)
        if identified:
            # Persist Shazam's identification independent of whatever
            # Spotify's own outcome is - see main.py's _match_track_to_spotify
            # for the fuller explanation.
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
            conn.commit()
            track_name, artist_name = identified['track_name'], identified['artist_name']

        if result == 'unavailable':
            cur.close()
            return {"matched": False, "reason": "unavailable"}

        if match:
            spotify_id = match['uri'].split(':')[-1]
            spotify_track_name = match.get('track_name')
            spotify_artist_name = match.get('artist_name')
            if spotify_track_name and spotify_artist_name and (spotify_track_name != track_name or spotify_artist_name != artist_name):
                # Spotify's own title/artist differs from the local tag -
                # correct it, same reversible pattern as tag_cleanup.py (see
                # main.py's _match_track_to_spotify for the fuller
                # explanation).
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
        conn.commit()
        cur.close()

        if not match:
            return {"matched": False, "reason": "no_match"}
        return {"matched": True, "uri": match['uri'], "artwork_url": match['artwork_url']}
    finally:
        conn.close()


def _advance_spotify(save_session, destination_id, now_playing, queue, match_pool):
    """For an ad-hoc (non-context_uri) session with a lookahead track already
    queued, drives the transition explicitly near end-of-track via play_uris
    rather than trusting Spotify's own native queue-stepping - confirmed live
    that Spotify's account-level queue can retain stale entries from much
    earlier add_to_queue calls that were never consumed (e.g. a session that
    got interrupted before playing through its lookahead), and a natural
    advance can jump to one of *those* instead of the track we actually just
    queued. Same fix already applied to user-driven Next/Prev in the frontend
    - Spotify's native next/queue-order just isn't trustworthy enough here to
    rely on passively.

    Falls back to passive reconciliation (matching polled track_uri against
    the tracked queue, or trusting the polled metadata directly) for anything
    this doesn't drive: a context_uri playlist naturally advancing, or a
    genuine skip from the real Spotify app.

    Then, for an ad-hoc session only, keeps exactly one match buffered ahead
    via the paced lookahead search - ported from the frontend's
    findNextSpotifyMatch/lookahead-refill effect, now running here instead so
    it survives the tab sleeping. Stops immediately on an 'unavailable'
    (rate-limited) result rather than trying more candidates - same rule the
    interactive routes already follow."""
    result = spotify_connect.get_status(destination_id)
    if result is None:
        return match_pool
    save_session(last_status=result)

    is_context = bool((now_playing or {}).get('context_uri'))
    duration = result.get('duration_ms') or 0
    position = result.get('position_ms') or 0
    near_end = duration > 0 and (duration - position) < SPOTIFY_NEAR_END_MS

    if not is_context and queue and near_end:
        next_track = queue[0]
        queue = queue[1:]
        spotify_connect.play_uris(destination_id, [next_track['uri']])
        now_playing = next_track
        save_session(now_playing=now_playing, queue=queue)
    else:
        track_uri = result.get('track_uri')
        current_uri = (now_playing or {}).get('uri')
        if track_uri and track_uri != current_uri:
            forward_index = next((i for i, t in enumerate(queue) if t.get('uri') == track_uri), None)
            if forward_index is not None:
                now_playing = queue[forward_index]
                queue = queue[forward_index + 1:]
            else:
                now_playing = {
                    'id': track_uri, 'source': 'spotify', 'uri': track_uri,
                    'context_uri': (now_playing or {}).get('context_uri'),
                    'track_name': result.get('title'), 'artist_name': result.get('artist'),
                    'album_name': result.get('album'),
                    'duration_seconds': (result['duration_ms'] / 1000) if result.get('duration_ms') is not None else None,
                    'artwork_url': result.get('artwork_url'),
                }
            save_session(now_playing=now_playing, queue=queue)
            is_context = bool((now_playing or {}).get('context_uri'))

    if is_context or queue or not match_pool:
        return match_pool

    candidates = match_pool.get('candidates') or []
    cursor = match_pool.get('cursor', 0)
    consecutive_misses = 0
    while cursor < len(candidates) and consecutive_misses < SPOTIFY_MATCH_CONSECUTIVE_CAP:
        candidate = candidates[cursor]
        cursor += 1
        match_result = _match_local_track_cached(candidate.get('id'), candidate.get('track_name'), candidate.get('artist_name'))
        if match_result.get('reason') == 'unavailable':
            # Leave the cursor pointing at this same candidate rather than
            # past it - confirmed live: a rate-limited stretch mid-session
            # permanently orphaned whatever candidate was current at the
            # time, since cursor had already advanced before the rate-limit
            # was discovered, and cursor only ever moves forward. This
            # candidate genuinely wasn't checked (spotify_checked stays
            # False), so it should get a real retry once the block clears,
            # not be skipped forever. Safe to retry every tick now that
            # spotify_connect's cooldown makes a still-blocked retry free
            # (no real API call) instead of hammering the same 429.
            cursor -= 1
            break
        if match_result.get('matched'):
            found = {
                'id': match_result['uri'], 'source': 'spotify', 'uri': match_result['uri'], 'context_uri': None,
                'local_id': candidate.get('id'),
                'track_name': candidate.get('track_name'), 'artist_name': candidate.get('artist_name'),
                'album_name': candidate.get('album_name'), 'duration_seconds': candidate.get('duration_seconds'),
                'artwork_url': match_result.get('artwork_url'),
            }
            spotify_connect.add_to_queue(destination_id, match_result['uri'])
            match_pool = {'candidates': candidates, 'cursor': cursor}
            save_session(queue=[found], spotify_match_pool=match_pool)
            return match_pool
        consecutive_misses += 1

    match_pool = {'candidates': candidates, 'cursor': cursor}
    save_session(spotify_match_pool=match_pool)
    return match_pool


def run(get_session, save_session, progress):
    """Runs forever on a background thread, started unconditionally at app
    startup (src/main.py's startup_event) - unlike the other background jobs
    in this app (external_artwork, spotify_prewarm, tag_cleanup), this isn't
    a one-shot backfill with a start/status route; it's a supervisor that's
    normally idle-polling with nothing to do, and only becomes active once a
    remote destination's queue is synced via POST /api/playback-session.

    This is what lets playback keep advancing to the next track even after
    the browser tab that started it goes to sleep - the frontend's own
    setInterval-based poll (which used to own this) is suspended the moment a
    phone locks or a tab backgrounds; this loop has no such dependency.
    """
    progress.update(status='running', error=None)
    has_started = False
    last_track_id = None
    last_content_id = None
    last_chromecast_destination_id = None
    pushed_count = None

    while True:
        delay = IDLE_POLL_INTERVAL_SECONDS
        try:
            session = get_session()
            destination_type = session.get('destination_type') if session else None

            def _save(**fields):
                # _advance_X can call this more than once per tick (e.g. a
                # near-end transition setting now_playing+queue, immediately
                # followed by the lookahead refill setting queue again on its
                # own). Merging against the *original* session snapshot on
                # every call would silently revert whichever fields the
                # earlier call in this same tick just set but this call
                # doesn't re-pass - confirmed live: a now_playing set by the
                # transition got reverted back to the pre-tick track by the
                # refill's queue-only save moments later, leaving now_playing
                # and queue both pointing at the same already-consumed track.
                # Updating `session` in place after every call keeps each
                # subsequent merge working off the latest state instead.
                merged = {
                    'destination_type': destination_type,
                    'destination_id': session['destination_id'],
                    'now_playing': session.get('now_playing'),
                    'queue': session.get('queue'),
                    'shuffle_enabled': session.get('shuffle_enabled', False),
                    'spotify_match_pool': session.get('spotify_match_pool'),
                    'chromecast_pushed_count': session.get('chromecast_pushed_count'),
                    'last_status': session.get('last_status'),
                }
                merged.update(fields)
                save_session(**merged)
                session.update(merged)

            if destination_type == 'wiim':
                now_playing = session.get('now_playing') or {}
                current_id = now_playing.get('id')
                if current_id != last_track_id:
                    has_started = False
                    last_track_id = current_id

                has_started = _advance_wiim(
                    _save, session['destination_id'], session.get('queue') or [], has_started,
                )
                delay = POLL_INTERVAL_SECONDS['wiim']
            elif destination_type == 'chromecast':
                if session['destination_id'] != last_chromecast_destination_id:
                    last_content_id = None
                    pushed_count = session.get('chromecast_pushed_count')
                    last_chromecast_destination_id = session['destination_id']

                pushed_count, last_content_id = _advance_chromecast(
                    _save, session['destination_id'],
                    session.get('now_playing'), session.get('queue') or [],
                    pushed_count, last_content_id,
                )
                delay = POLL_INTERVAL_SECONDS['chromecast']
            elif destination_type == 'spotify':
                _advance_spotify(
                    _save, session['destination_id'],
                    session.get('now_playing'), session.get('queue') or [],
                    session.get('spotify_match_pool'),
                )
                delay = POLL_INTERVAL_SECONDS['spotify']
            else:
                delay = IDLE_POLL_INTERVAL_SECONDS
            progress.update(status='running', error=None)
        except Exception as e:
            progress.update(status='error', error=str(e))
        time.sleep(delay)
