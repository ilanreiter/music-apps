import os
import re
import time
import traceback

from . import wiim
from . import chromecast

PUBLIC_BASE_URL = os.environ.get('PUBLIC_BASE_URL', 'http://localhost:8001')

# Matches the frontend's own DEFAULT_STATUS_POLL_INTERVAL_MS (App.js) - the
# backend now polls at the same cadence the frontend used to, not on top of it.
POLL_INTERVAL_SECONDS = {'wiim': 2, 'chromecast': 2}
IDLE_POLL_INTERVAL_SECONDS = 5

# How close to the end of a track counts as "about to finish" - matches the
# frontend's old nearEnd heuristic (App.js, duration - position < 4000)
# exactly, so behavior doesn't change, just where it runs. Used for WiiM
# (2s poll interval, comfortably smaller than this window).
NEAR_END_MS = 4000

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
            else:
                delay = IDLE_POLL_INTERVAL_SECONDS
            progress.update(status='running', error=None)
        except Exception as e:
            # Previously silent beyond the in-memory progress dict (no API
            # route ever exposed it, nothing printed) - confirmed live this
            # let a single persistently-failing tick go unnoticed for hours
            # (every 5s, forever, since nothing here ever re-raises or kills
            # the loop - see the try/except itself, that resilience is
            # intentional) with radio silently stuck on stale content and no
            # trace of why. Printed so it actually reaches `docker compose
            # logs` instead of only living in memory no one can query.
            print(f"playback_advancer tick failed: {e}")
            traceback.print_exc()
            progress.update(status='error', error=str(e))
        time.sleep(delay)
