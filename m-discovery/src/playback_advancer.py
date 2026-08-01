import os
import re
import time
import traceback

from . import wiim
from . import chromecast
from . import spotify_connect
from . import radio_engine
from .database import (
    get_db_connection, get_radio_session, append_seen_track_keys, upsert_radio_discovered_track,
    set_radio_session_track_state, find_known_track_external_match,
    set_radio_session_playlist, assign_radio_playlist_item_ids,
)

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

# How many fresh Last.fm suggestions to pull in one go when a Radio-fed pool
# runs dry mid-tick - mirrors the frontend's own RADIO_BATCH_SIZE. Fetched at
# most once per tick (see _advance_spotify) regardless of this size, so this
# only bounds how much a single refill grows the pool by, not how often.
RADIO_ADVANCER_REFILL_BATCH = 10

# How many tracks _advance_spotify keeps buffered ahead in the ad-hoc `queue`
# array at once (previously always exactly 1, replaced wholesale rather than
# topped up). At 1, the buffer is fully empty - Up Next shows nothing, the
# frontend's Next button has nothing to jump to - for the entire stretch
# between "the one buffered track just started playing" and "this tick's
# refill found its replacement" (up to one full poll interval, more if that
# tick's match happens to miss and needs another round). Keeping one spare
# buffered means there's always still something to advance to immediately,
# even if a given tick's refill is slow, misses, or is briefly rate-limited.
SPOTIFY_QUEUE_LOOKAHEAD_DEPTH = 2

# How long to wait between auto-resume attempts for the same device - see
# _maybe_auto_resume. Bounded so a genuinely offline/broken device doesn't
# get a fresh resume() call hammered at it every single 5s poll tick forever;
# 15s still recovers well within the span of a typical track.
AUTO_RESUME_COOLDOWN_SECONDS = 15
_last_auto_resume_attempt = {}  # device_id -> time.time() of the last attempt


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


def _radio_session_still_current(radio_session_id):
    """True if radio_session_id is still the one active radio_session row
    (or radio_session_id is None - a plain library-cast pool, not Radio-fed
    at all, has no such notion). Guards a save right after a live Spotify
    search/match call in _advance_spotify's matching and refill loops
    against a race: this whole function only reads match_pool/now_playing/
    queue once, at the top of a single poll tick, then can spend real wall-
    clock time on a live search before its own save_session call - if a
    brand new radio session starts (either engine) and saves its own fresh
    pool/now_playing while an *old* session's tick is still mid-search, the
    old tick's eventual save can otherwise land afterward and silently
    revert the new session's pool back to the stale one. Confirmed live:
    starting a fresh Spotify Radio session while a long-running Discover-
    engine one was mid-tick reverted straight back to the old session's pool
    and now_playing seconds later. create_radio_session retires every other
    session to 'stopped' in the same transaction it creates a new one, so a
    stale radio_session_id reliably reads back non-'active' the moment a
    newer session exists - checked as close to the actual save as practical
    rather than only once at the top of the tick, since that's exactly the
    gap the search call opens."""
    if radio_session_id is None:
        return True
    session = get_radio_session(radio_session_id)
    return session is not None and session.get('status') == 'active'


def _match_text_candidate(track_name, artist_name):
    """Matches a Radio-suggested track directly against Spotify's catalog -
    Last.fm text suggestions have no known_tracks row, so unlike
    _match_local_track_cached above there's no cache to check or write, just
    a one-off search.

    Uses search_track_direct (a single /search, no bridging), not the full
    search_track main.py's match_discovered_track_to_spotify calls -
    confirmed live a single miss here was quietly costing 2 real searches
    (the direct attempt, then a YouTube Music bridge retry) for a track
    that, being sourced straight from Last.fm's own catalog data rather
    than a possibly-garbled local file tag, was never going to be rescued
    by that bridge anyway - it exists for messy local tags, not clean
    third-party recommendation text."""
    result, match = spotify_connect.search_track_direct(track_name, artist_name)
    if result == 'unavailable':
        return {"matched": False, "reason": "unavailable"}
    if not match:
        return {"matched": False, "reason": "no_match"}
    return {"matched": True, "uri": match['uri'], "artwork_url": match.get('artwork_url')}


def resolve_playlist_item(item):
    """Resolves one radio_session.playlist item to a playable Spotify URI -
    the exact 3-way branch _advance_spotify's own refill loop uses (a
    radio_discovered_tracks cache hit needs no lookup at all, a known_tracks
    id uses the cache-first matcher, a plain text candidate gets a live
    search), pulled out so main.py's /api/radio/{id}/play route (resolving
    just the first item, before the refill loop's own tick ever runs) and
    the refill loop itself share one implementation instead of two copies
    drifting apart. No underscore prefix - called from main.py."""
    if item.get('spotify_uri') is not None:
        return {"matched": True, "uri": item['spotify_uri'], "artwork_url": item.get('artwork_url')}
    if item.get('id') is not None:
        return _match_local_track_cached(item['id'], item.get('track_name'), item.get('artist_name'))
    return _match_text_candidate(item.get('track_name'), item.get('artist_name'))


def _maybe_auto_resume(destination_id, result, is_radio_session=False):
    """Detects a Spotify Connect device silently reporting 'pause' even
    though this app's own last play()/play_uris() call for it was never
    followed by a real pause() - see spotify_connect.get_desired_state.
    Confirmed live (a budget streamer on this account, "Office Streamer
    onn"), twice: a device can genuinely confirm-play, then drop back to
    paused a while later entirely on its own (real device/network flakiness)
    - and separately, a *natural* track-to-track advance (passive
    reconciliation, not this app's own play_uris call - see _advance_spotify)
    can itself land the new track paused-at-position-0 instead of playing.
    Neither is caught by near_end/passive-reconciliation, which only react
    to the *track* changing, not playback silently stopping while the
    current (or a just-advanced-to) one stays loaded.

    Deliberately treats *any* pause this app didn't itself issue as
    something to recover from, including one from outside this app entirely
    (a voice command, another Spotify client, a physical remote) - same
    "keep playing unless explicitly told to stop" principle already applied
    to Radio elsewhere (never stop on its own). A user who genuinely wants
    to stop has this app's own Pause/Stop controls for that, which set
    desired_state to 'pause' and are always respected here.

    For a radio session specifically, desired_state of None (nothing ever
    explicitly recorded - e.g. right after this process restarted, or the
    pause happened via the passive-reconciliation path above rather than a
    tracked play_uris call) is treated the same as 'play', not "unknown,
    don't touch": an active radio session's whole premise is continuous
    playback, so silence with no recorded intent either way defaults to
    "should be playing," not to leaving it paused indefinitely. Non-radio
    playback keeps the stricter check (desired_state must be exactly
    'play') - there's no equivalent "must never stop" guarantee made for a
    plain single-track cast, so an unrecorded pause there is left alone
    rather than assumed to need fixing.

    resume() already re-fetches the paused position and replays it exactly
    (not from 0), and already runs the device through _transfer_to_device
    first - the same recovery play_uris' own docstring documents needing for
    this class of device. Bounded by AUTO_RESUME_COOLDOWN_SECONDS so a
    genuinely offline device doesn't get hammered every tick."""
    if result.get('status') != 'pause':
        return
    desired = spotify_connect.get_desired_state(destination_id)
    should_be_playing = desired == 'play' or (is_radio_session and desired is None)
    if not should_be_playing:
        return
    last_attempt = _last_auto_resume_attempt.get(destination_id, 0)
    if time.time() - last_attempt < AUTO_RESUME_COOLDOWN_SECONDS:
        return
    _last_auto_resume_attempt[destination_id] = time.time()
    print(f"auto-resume {destination_id}: found paused (desired={desired!r}, radio={is_radio_session}) at {result.get('track_uri')!r}, resuming")
    spotify_connect.resume(destination_id)


def _advance_spotify_native(save_session, destination_id, match_pool):
    """Mirrors a spotify_native radio session's state instead of driving it -
    this app only ever plays the seed track (see main.py's start_radio_native),
    then Spotify's own account-level autoplay takes over queueing similar
    tracks entirely on its own, provided the account/device has "Autoplay
    similar songs" turned on in Spotify's own app (a client-side setting with
    no Web API equivalent - if it's off, playback just ends after the seed
    and there's nothing this app can do about it). GET /me/player/queue is
    the one place Spotify's Web API actually surfaces its own upcoming picks
    (autoplay-added ones included) - a read-only call against a dedicated
    endpoint, not /search, so this whole mode costs nothing against the daily
    search budget past the one-time seed match. last_status still comes from
    get_status (play/pause/position for the player bar's progress/equalizer),
    same as the discovery-driven mode above."""
    status_result = spotify_connect.get_status(destination_id)
    if status_result is not None:
        save_session(last_status=status_result)
        _maybe_auto_resume(destination_id, status_result, is_radio_session=True)

    queue_result = spotify_connect.get_queue()
    if queue_result is None:
        return match_pool

    radio_session_id = match_pool.get('radio_session_id')
    now_playing = queue_result['now_playing']
    if now_playing is not None and radio_session_id is not None:
        now_playing['radio_session_id'] = radio_session_id
        # Distinguishes this from a discovery-engine radio pick in the Play
        # Log's reason/engine columns - Spotify's own recommendation model
        # chose this, not radio_engine.generate_radio_batch_track_first.
        now_playing['selection_reason'] = 'Spotify Autoplay'
        now_playing['selection_engine'] = 'Spotify'
    tagged_queue = []
    for t in queue_result['queue']:
        if radio_session_id is not None:
            t['radio_session_id'] = radio_session_id
        tagged_queue.append(t)

    if not _radio_session_still_current(radio_session_id):
        # Same race _advance_spotify's own matching/refill loops guard
        # against: get_status/get_queue above are real network calls, and a
        # newer session (either engine) can have already started and saved
        # its own fresh state while this tick was waiting on them.
        return match_pool
    save_session(now_playing=now_playing, queue=tagged_queue)
    return match_pool


# Session ids flagged by main.py's /api/radio/{id}/reorder or /remove routes
# when the edited item was already committed (add_to_queue'd) to Spotify's
# real queue - consumed (checked-and-cleared) once by _advance_spotify's next
# tick for that session, see flag_radio_reconcile/_reconcile_radio_queue.
# Plain in-memory set, no lock - same lost-write race tolerance already
# accepted elsewhere in this codebase (append_seen_track_keys); worst case a
# flag added the same instant a tick reads it waits one more 5s tick.
_reconcile_pending = set()


def flag_radio_reconcile(radio_session_id):
    _reconcile_pending.add(radio_session_id)


def _reconcile_radio_queue(destination_id, radio_session_id, committed_queue):
    """Spec point 9, corrected version: verifies every track this session has
    committed (add_to_queue'd) is actually present in Spotify's real
    upcoming queue, adding whichever ones are missing. Deliberately additive
    only - never drains/skips.

    The first version of this used clear_queue_for_device to fix a mismatch,
    which was a real, confirmed-live bug: clear_queue_for_device transfers to
    the device with `'play': False` and then drains by repeatedly calling
    Spotify's own `next` - which advances *whatever's currently playing*,
    not just queued residue behind it. Reconciliation never re-asserts the
    current track afterward the way /play and /switch-device do (they
    immediately follow their own drain with a fresh play_uris call) - so
    every "correction" was actually skipping straight past the real
    currently-playing track into arbitrary further tracks, then pausing on
    top of it. That's what surfaced as repeated restarts and now_playing
    jumping to an unrelated track.

    Trade-off accepted: this can no longer fix the *order* of two tracks
    that are both already sitting in Spotify's real queue (e.g. undoing a
    reorder-to-top click on an already-committed item) - there's no safe way
    to do that without skip-based draining, which is exactly what's unsafe
    here. A missing track still gets added; an existing one just can't be
    reordered without risking exactly the corruption above. Correctness of
    what's *currently playing* wins over strict queue ordering.

    Callers are responsible for only invoking this on a genuine edge (a
    transition just happened, or a committed item was just added/removed)
    and never on every idle tick - see _advance_spotify_radio_playlist,
    which also guarantees this never runs on the same tick as a fresh
    add_to_queue (get_queue() is laggy relative to a just-issued write -
    reconciling immediately after one would see the app's own pending add as
    "missing" and duplicate it)."""
    expected_uris = [t.get('uri') for t in committed_queue if t.get('uri')]
    if not expected_uris:
        return
    real = spotify_connect.get_queue()
    if real is None:
        print(f"radio reconcile {radio_session_id}: get_queue() failed, skipping this round")
        return
    real_uris = [t.get('uri') for t in (real.get('queue') or [])]
    missing = [uri for uri in expected_uris if uri not in real_uris]
    if not missing:
        return
    print(f"radio reconcile {radio_session_id}: {missing} missing from Spotify's real queue (real: {real_uris}) - adding")
    for uri in missing:
        ok = spotify_connect.add_to_queue(destination_id, uri)
        if not ok:
            print(f"radio reconcile {radio_session_id}: add_to_queue failed for {uri}")


def _advance_spotify_radio_playlist(save_session, destination_id, queue, radio_session_id, match_pool, should_reconcile):
    """Consumes radio_session.playlist directly - the new pre-generated,
    externally reorderable/deletable list (main.py's /api/radio/generate,
    /reorder, /remove) - instead of match_pool.candidates/cursor. Same
    algorithm the old candidates/cursor loop used (every examined item is
    discarded exactly once, matched or not - see the plain-pool loop below
    this function, which still uses that model for non-radio pools): pop
    from the front, resolve, either queue it and stop for this tick, or
    count a miss and keep going up to SPOTIFY_MATCH_CONSECUTIVE_CAP. Reads
    the playlist once, walks an in-memory copy, and persists the trimmed/
    extended result in as few writes as possible.

    Runs should_reconcile's check *before* attempting any match this tick
    (using `queue` as it stood at the *start* of this tick, i.e. describing
    the previous tick's already-settled state) - never after a fresh
    add_to_queue in the same call, which would race get_queue()'s lag."""
    if should_reconcile:
        _reconcile_radio_queue(destination_id, radio_session_id, queue)

    session = get_radio_session(radio_session_id)
    if session is None or session.get('status') != 'active':
        return match_pool
    if len(queue) >= SPOTIFY_QUEUE_LOOKAHEAD_DEPTH:
        return match_pool

    playlist = list(session.get('playlist') or [])
    consecutive_misses = 0
    extended_once = False

    while True:
        while playlist and consecutive_misses < SPOTIFY_MATCH_CONSECUTIVE_CAP:
            item = playlist.pop(0)
            match_result = resolve_playlist_item(item)
            if match_result.get('reason') == 'unavailable':
                # Same rule as the plain-pool loop - doesn't count toward
                # consecutive_misses, and this item simply isn't retried
                # (spotify_prewarm.py's own sweep picks it up eventually).
                continue
            if match_result.get('matched'):
                found = {
                    'id': match_result['uri'], 'source': 'spotify', 'uri': match_result['uri'], 'context_uri': None,
                    'track_name': item.get('track_name'), 'artist_name': item.get('artist_name'),
                    'album_name': item.get('album_name'), 'artwork_url': match_result.get('artwork_url'),
                    'selection_reason': item.get('selection_reason'), 'selection_engine': item.get('selection_engine'),
                    'match': item.get('match'),
                    'radio_session_id': radio_session_id,
                    # Carried forward from the playlist item so main.py's
                    # /reorder and /remove routes can still address an
                    # already-committed (add_to_queue'd) entry by the same id
                    # the frontend already has for it - it doesn't stop being
                    # "the same row" just because it moved from playlist into
                    # the committed lookahead buffer.
                    'item_id': item.get('item_id'),
                }
                if item.get('id') is not None:
                    found['local_id'] = item['id']
                elif item.get('spotify_uri') is not None:
                    found['radio_track_id'] = item.get('radio_track_id')
                else:
                    remembered_id = upsert_radio_discovered_track(
                        item.get('track_name'), item.get('artist_name'), item.get('album_name'),
                        match_result['uri'], match_result.get('artwork_url'),
                    )
                    if remembered_id is not None:
                        found['radio_track_id'] = remembered_id
                if not _radio_session_still_current(radio_session_id):
                    return match_pool
                spotify_connect.add_to_queue(destination_id, match_result['uri'])
                set_radio_session_playlist(radio_session_id, playlist)
                save_session(queue=queue + [found])
                return match_pool
            consecutive_misses += 1

        if extended_once or playlist:
            break
        session = get_radio_session(radio_session_id)
        if session is None or session.get('status') != 'active':
            break
        conn = get_db_connection()
        if conn is None:
            break
        try:
            # Same tiered generator /api/radio/generate's own background job
            # uses, called here so a long unattended run keeps extending past
            # whatever length was originally generated - "Radio must never
            # just stop" applies here exactly as it did for the old
            # candidates/cursor model.
            new_tracks, track_frontier, fallback_expanded_artists, _degraded = radio_engine.generate_radio_batch_track_first(
                session, session.get('seen_track_keys') or [], RADIO_ADVANCER_REFILL_BATCH, conn,
            )
            set_radio_session_track_state(radio_session_id, track_frontier, fallback_expanded_artists)
        finally:
            conn.close()
        extended_once = True
        if not new_tracks:
            break
        append_seen_track_keys(radio_session_id, [radio_engine.radio_track_key(t['track_name'], t['artist_name']) for t in new_tracks])
        for t in new_tracks:
            t['source'] = 'in_library' if (t.get('id') is not None or t.get('spotify_uri') is not None) else 'unresolved'
        # assign_radio_playlist_item_ids only touches next_item_id, not the
        # playlist column itself - this tick's own in-memory trims (the pops
        # above) haven't been persisted yet, so a read-modify-write against
        # the DB's playlist column here would silently undo them.
        tagged = assign_radio_playlist_item_ids(radio_session_id, new_tracks)
        playlist = playlist + tagged

    if not _radio_session_still_current(radio_session_id):
        return match_pool
    set_radio_session_playlist(radio_session_id, playlist)
    return match_pool


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
    if (match_pool or {}).get('engine') == 'spotify_native':
        # A spotify_native radio session (see main.py's start_radio_native)
        # only ever plays its own seed track - everything after that is
        # Spotify's own account-level autoplay, not this app's matching loop
        # below, so none of this function's own driving/lookahead logic
        # applies here at all.
        return _advance_spotify_native(save_session, destination_id, match_pool)
    # Read once, up front - this tick's own get_status() call below is
    # exactly the kind of real network delay that opened the race
    # _radio_session_still_current guards against elsewhere in this
    # function (the matching/refill loops); this section needs the same
    # guard, since it can also drive a real play_uris command and save,
    # not just read.
    radio_session_id = (match_pool or {}).get('radio_session_id')

    result = spotify_connect.get_status(destination_id)
    if result is None:
        return match_pool
    save_session(last_status=result)
    _maybe_auto_resume(destination_id, result, is_radio_session=radio_session_id is not None)

    is_context = bool((now_playing or {}).get('context_uri'))
    duration = result.get('duration_ms') or 0
    position = result.get('position_ms') or 0
    near_end = duration > 0 and (duration - position) < SPOTIFY_NEAR_END_MS
    # Confirmed live: the host process sleeping (e.g. the machine itself
    # suspending) for longer than the current track's remaining runtime lets
    # it finish entirely before this loop gets another tick to catch
    # near_end - Spotify then reports a fully empty player (get_status's
    # dedicated 'stop' shape: no item, duration_ms/track_uri both None, data
    # itself empty from Spotify's /me/player). That's distinguishable from a
    # real user pause, which still is_playing=False but keeps the paused
    # track's own item/duration/position - so this can't misfire on a
    # deliberate pause. Without this, nothing ever recovers: near_end can
    # never become true again for a track that already finished, and the
    # passive-reconciliation branch below only reacts to a *changed*
    # track_uri, which an empty player never provides either - the device
    # just sits stopped forever. Mirrors _advance_wiim's own
    # stopped_on_its_own handling (same "device already stopped, don't wait
    # for near_end" rule, just detected from a full/empty response there vs.
    # a dedicated 'stop' status here since the two APIs shape "nothing
    # playing" differently).
    stopped_on_its_own = result.get('status') == 'stop' and now_playing is not None

    # Tracks whether *this tick* actually changed now_playing (either
    # branch below) - drives the reconciliation edge-trigger (spec point 9,
    # see _advance_spotify_radio_playlist/_reconcile_radio_queue): checking
    # Spotify's real queue only makes sense right after a genuine
    # transition or a flagged edit, never on every idle poll.
    transitioned = False

    if not is_context and queue and (near_end or stopped_on_its_own):
        if not _radio_session_still_current(radio_session_id):
            # Confirmed live: a newer radio session (either engine) can
            # already be up and running while this tick was waiting on
            # get_status() above - this branch actively drives playback
            # (play_uris), so continuing here wouldn't just save stale data,
            # it would actually yank the device back onto this now-retired
            # session's own leftover lookahead track.
            return match_pool
        next_track = queue[0]
        queue = queue[1:]
        spotify_connect.play_uris(destination_id, [next_track['uri']])
        now_playing = next_track
        save_session(now_playing=now_playing, queue=queue)
        transitioned = True
    else:
        track_uri = result.get('track_uri')
        current_uri = (now_playing or {}).get('uri')
        if track_uri and track_uri != current_uri:
            forward_index = next((i for i, t in enumerate(queue) if t.get('uri') == track_uri), None)
            if forward_index is not None:
                now_playing = queue[forward_index]
                queue = queue[forward_index + 1:]
            else:
                # Confirmed live: this was the actual reason a session that
                # had genuinely been stopped hours earlier could still show
                # as "on air" indefinitely - once carried forward once, this
                # tag never got re-validated against its own session's
                # status on any later reconstruction, so it just kept
                # perpetuating itself onto whatever played next, forever
                # (the outer radio_session_id guard right below only checks
                # match_pool's own tag, which is unrelated once match_pool
                # itself is None for a long-stopped session - a completely
                # different source of staleness from this one). Only a
                # session that's still genuinely 'active' gets to keep
                # tagging what plays next; once it's stopped, this drops the
                # tag so the frontend's "stop when superseded" check
                # actually has a real signal to go on.
                carried_radio_session_id = (now_playing or {}).get('radio_session_id')
                if carried_radio_session_id is not None and not _radio_session_still_current(carried_radio_session_id):
                    carried_radio_session_id = None
                if is_context:
                    # A genuine ongoing context/playlist naturally advancing
                    # past our tracked window (e.g. a 999-track playlist past
                    # the frontend's 200-track queue cap) - still the same
                    # one the frontend originally started, so carry its
                    # labels forward rather than losing them (see App.js's
                    # mapSpotifyTrack/PlayerBar's "Source: ..." label).
                    playlist_name = (now_playing or {}).get('playlist_name')
                    origin_library = (now_playing or {}).get('origin_library')
                    local_id = (now_playing or {}).get('local_id')
                else:
                    # Confirmed live: an ad-hoc (non-context) session has no
                    # legitimate "still the same thing, just further ahead"
                    # case the way a real playlist does - Radio/Shuffle All/a
                    # matched local track's queue is our own explicit,
                    # bounded list, so a track_uri outside it is either stale
                    # queue residue from an unrelated earlier session (never
                    # fully drained - see spotify_connect.clear_queue) or a
                    # genuine manual skip in the real Spotify app to
                    # something else entirely. Blindly carrying the
                    # *previous* track's origin_library/local_id forward here
                    # mislabeled that leftover residue as "Your Library" for
                    # a track that was never actually cast from it, and
                    # separately broke last_played_at/last_played_reason
                    # tracking for it outright - database._record_track_played
                    # needs a real local_id for a source-tagged now_playing,
                    # and the old version of this reconstruction never
                    # carried one at all. A fresh lookup by the newly-
                    # observed track's own Spotify id is the only way to
                    # know whether *this* track is genuinely a library one,
                    # not a carry-forward guess from whatever played before.
                    playlist_name = None
                    known_match = find_known_track_external_match(spotify_track_id=track_uri.split(':')[-1])
                    local_id = known_match['id'] if known_match else None
                    origin_library = True if known_match else None
                now_playing = {
                    'id': track_uri, 'source': 'spotify', 'uri': track_uri,
                    'context_uri': (now_playing or {}).get('context_uri'),
                    'track_name': result.get('title'), 'artist_name': result.get('artist'),
                    'album_name': result.get('album'),
                    'duration_seconds': (result['duration_ms'] / 1000) if result.get('duration_ms') is not None else None,
                    'artwork_url': result.get('artwork_url'),
                    'playlist_name': playlist_name,
                    'origin_library': origin_library,
                    'local_id': local_id,
                    # Confirmed live: a Radio session's 2nd track can hit this
                    # exact branch - if Spotify's device naturally advances to
                    # the already-queued next track (see add_to_queue above)
                    # faster than this thread's own near-end/play_uris
                    # transition catches it, forward_index below comes back
                    # None (the one-buffered-ahead queue only ever tracks a
                    # single lookahead item) and this reconstructs now_playing
                    # from scratch. Without carrying this forward the same way
                    # origin_library/playlist_name already are, the frontend's
                    # "stop when superseded" effect sees a tagless now_playing
                    # and concludes Radio was superseded - after just the 2nd
                    # track, not anything actually stopping. Validated above
                    # (carried_radio_session_id) rather than read directly
                    # here, so a stopped session's tag doesn't perpetuate
                    # itself forever.
                    'radio_session_id': carried_radio_session_id,
                }
            if not _radio_session_still_current(radio_session_id):
                # Same race as the near-end branch above - this tick's own
                # now_playing/queue/match_pool snapshot (including
                # radio_session_id) was all read before get_status() above,
                # and a newer session can have already taken over in the
                # meantime.
                return match_pool
            save_session(now_playing=now_playing, queue=queue)
            transitioned = True
            is_context = bool((now_playing or {}).get('context_uri'))

    if not match_pool and not is_context and not queue:
        # Confirmed live: match_pool can end up None while now_playing still
        # carries a genuinely active radio_session_id (e.g. a container
        # restart landing between a save that cleared/never set match_pool
        # and the next refill) - without this, the "not match_pool" branch
        # right below returns immediately forever after, since the refill
        # logic that could rebuild match_pool only runs *inside* the block
        # this guards. A dead pool for an actually-active session otherwise
        # never recovers: no candidates ever get matched again, the queue
        # stays permanently empty, and the frontend's Next button/Up Next
        # list have nothing to show - "Radio must never just stop" applies
        # here too, not just to a rate limit. Rebuilding an empty pool
        # tagged with the still-current session id is enough - the refill
        # branch a few lines down already knows how to repopulate an empty
        # candidates list for a tracked radio_session_id from scratch.
        carried_radio_session_id = (now_playing or {}).get('radio_session_id')
        if carried_radio_session_id is not None and _radio_session_still_current(carried_radio_session_id):
            match_pool = {'candidates': [], 'cursor': 0, 'radio_session_id': carried_radio_session_id}

    if is_context or not match_pool:
        return match_pool

    radio_session_id = match_pool.get('radio_session_id')
    if radio_session_id is not None:
        # New pre-generated-playlist flow (main.py's /api/radio/generate +
        # /api/radio/{id}/play) - consumes radio_session.playlist directly
        # instead of match_pool.candidates/cursor, since that list is
        # externally reorderable/deletable (see main.py's /reorder,
        # /remove) and DB-persisted rather than in-memory-only. Runs on
        # every tick regardless of queue depth (unlike the plain candidates
        # path below) so the reconciliation check inside it can fire on a
        # genuine transition even when there's nothing to refill.
        should_reconcile = transitioned or radio_session_id in _reconcile_pending
        _reconcile_pending.discard(radio_session_id)
        return _advance_spotify_radio_playlist(save_session, destination_id, queue, radio_session_id, match_pool, should_reconcile)

    if len(queue) >= SPOTIFY_QUEUE_LOOKAHEAD_DEPTH:
        return match_pool

    candidates = match_pool.get('candidates') or []
    cursor = match_pool.get('cursor', 0)
    # Only set for a Radio-fed pool (see App.js's handleStartRadio) - a
    # library-cast pool's candidates are a finite array to walk through
    # (backed by a real, bounded local library), nothing to fetch more of.
    radio_session_id = match_pool.get('radio_session_id')
    if not _radio_session_still_current(radio_session_id):
        # Confirmed live this was burning real searches for nothing: the
        # earlier fix only guarded the *save* right before add_to_queue, not
        # the attempts leading up to it - so once a session was stopped
        # (superseded by a newer one, or the user pressing Stop) but its own
        # leftover pool was still sitting in spotify_match_pool (queue empty,
        # nothing left to trigger a refill/replace), every tick kept trying
        # its remaining candidates against Spotify's real /search, over and
        # over, forever discarding the result at the save-guard - a stopped
        # session's dead pool should cost nothing at all, not silently drain
        # the daily budget in the background.
        return match_pool
    consecutive_misses = 0
    refilled_from_radio = False

    while True:
        while cursor < len(candidates) and consecutive_misses < SPOTIFY_MATCH_CONSECUTIVE_CAP:
            candidate = candidates[cursor]
            cursor += 1
            candidate_id = candidate.get('id')
            discovered_uri = candidate.get('spotify_uri')
            new_discovery = False
            # A pre-resolved spotify_uri (radio_engine.find_cached_artist_tracks/
            # find_any_cached_tracks' radio_discovered_tracks entries) is
            # already a confirmed match - nothing to look up at all. Otherwise
            # a real known_tracks id (library-cast) uses the cache-first
            # matcher; a genuine fresh discovery (a Last.fm text suggestion
            # with neither) has nothing to cache against, so it's searched
            # directly - and, if this is the first time it's ever matched,
            # persisted to radio_discovered_tracks so a *future* radio
            # session can pull it back up the same free way (see
            # new_discovery below).
            if discovered_uri is not None:
                match_result = {"matched": True, "uri": discovered_uri, "artwork_url": candidate.get('artwork_url')}
            elif candidate_id is not None:
                match_result = _match_local_track_cached(candidate_id, candidate.get('track_name'), candidate.get('artist_name'))
            else:
                match_result = _match_text_candidate(candidate.get('track_name'), candidate.get('artist_name'))
                new_discovery = match_result.get('matched', False)
            if match_result.get('reason') == 'unavailable':
                # Don't stall the whole refill over one not-yet-checked candidate
                # - anything further ahead that's already cached (spotify_prewarm.py,
                # a previous session, a YT Music cross-reference) resolves
                # straight from the DB with no live search at all, so it's worth
                # trying rather than leaving playback stuck. Doesn't count toward
                # consecutive_misses (a rate-limited stretch isn't the same
                # signal as a genuine run of "not on Spotify" tracks), and this
                # candidate simply won't get retried by this pool again -
                # spotify_prewarm.py's own independent, library-wide sweep still
                # picks it up eventually, so "keep something playing" wins over
                # "guarantee every candidate gets tried in order."
                continue
            if match_result.get('matched'):
                found = {
                    'id': match_result['uri'], 'source': 'spotify', 'uri': match_result['uri'], 'context_uri': None,
                    'track_name': candidate.get('track_name'), 'artist_name': candidate.get('artist_name'),
                    'album_name': candidate.get('album_name'), 'duration_seconds': candidate.get('duration_seconds'),
                    'artwork_url': match_result.get('artwork_url'),
                    # radio_engine.generate_radio_batch_track_first tags every
                    # candidate it produces with why it was picked and which
                    # engine produced it - carried through so
                    # database._record_track_played can stamp both onto
                    # last_played_reason/last_played_engine once this
                    # actually plays, for the Play Log's own columns. None
                    # for anything not sourced from that generator (a
                    # library cast, Discover, a playlist track) -
                    # _record_track_played falls back to a generic label in
                    # that case.
                    'selection_reason': candidate.get('selection_reason'),
                    'selection_engine': candidate.get('selection_engine'),
                }
                if candidate_id is not None:
                    found['local_id'] = candidate_id
                    if radio_session_id is None:
                        # Only a genuine "cast my own library" match (not part
                        # of a Radio pool) reads as "Your Library" in the
                        # "Source: ..." label - see App.js's mapMatchedLocalTrack
                        # / sourceLabel, which already prefers radio_session_id
                        # over origin_library whenever both could apply.
                        found['origin_library'] = True
                elif discovered_uri is not None:
                    # Already a radio_discovered_tracks row (a previous
                    # session's own discovery) - carry its id forward so
                    # last_played_at tracking (database._record_track_played)
                    # can stamp the right row, same role local_id plays for
                    # a genuine library track.
                    found['radio_track_id'] = candidate.get('radio_track_id')
                elif new_discovery:
                    # The first time this exact track has ever been
                    # confirmed, from any source - persist it so a *future*
                    # radio session's own cache tiers
                    # (radio_engine.find_cached_artist_tracks/find_any_cached_tracks)
                    # can pull it back up for free instead of needing
                    # another live search, same "discover new music" goal
                    # this search already served once, without paying for it
                    # again every time it comes up.
                    remembered_id = upsert_radio_discovered_track(
                        candidate.get('track_name'), candidate.get('artist_name'), candidate.get('album_name'),
                        match_result['uri'], match_result.get('artwork_url'),
                    )
                    if remembered_id is not None:
                        found['radio_track_id'] = remembered_id
                if radio_session_id is not None:
                    # Bridges back to the Radio session that suggested this
                    # track - App.js's continuous-refill effect uses this to
                    # tell "radio is still what's playing" apart from
                    # anything else, same role it plays for a client-resolved
                    # radio match. Must be independent of the candidate_id
                    # check above: the tiered radio batch (radio_engine.py)
                    # now legitimately hands out cached-library candidates
                    # (real candidate_id) as part of an active radio pool, and
                    # those still need this tag or the frontend concludes
                    # radio was superseded after the very first track.
                    found['radio_session_id'] = radio_session_id
                if not _radio_session_still_current(radio_session_id):
                    # A newer radio session (either engine) already took over
                    # while this candidate's live search was in flight - the
                    # match itself is harmless to have made (spotify_prewarm.py
                    # would've found it eventually anyway), but queueing it and
                    # saving this now-stale pool would revert whatever the new
                    # session already correctly set up moments ago.
                    return match_pool
                spotify_connect.add_to_queue(destination_id, match_result['uri'])
                match_pool = {'candidates': candidates, 'cursor': cursor}
                if radio_session_id is not None:
                    match_pool['radio_session_id'] = radio_session_id
                # Appends rather than replaces - queue can already hold up to
                # SPOTIFY_QUEUE_LOOKAHEAD_DEPTH - 1 earlier buffered track(s)
                # at this point (the depth check above only lets this section
                # run at all once queue is below the target depth, it doesn't
                # require it to be empty). The near-end/stopped_on_its_own
                # branch above already pops from the front and leaves the
                # rest, so this stays correct regardless of depth.
                save_session(queue=queue + [found], spotify_match_pool=match_pool)
                return match_pool
            consecutive_misses += 1

        # The inner loop stopped either because it ran out of candidates
        # (cursor caught up to len(candidates) - genuinely exhausted) or hit
        # the consecutive-miss cap (candidates remain, just giving up for
        # this tick). Only the first case is worth refilling for, and only
        # once per tick - a genuinely dry seed shouldn't turn into a tight
        # retry loop, and consecutive_misses is deliberately NOT reset after
        # a refill, so the total real-search-call budget for this tick stays
        # at SPOTIFY_MATCH_CONSECUTIVE_CAP regardless of how many batches it
        # spans - same pacing guarantee as before, just now shared across an
        # old pool's tail and a freshly-fetched one.
        if refilled_from_radio or cursor < len(candidates) or radio_session_id is None:
            break
        session = get_radio_session(radio_session_id)
        if session is None or session.get('status') != 'active':
            break
        conn = get_db_connection()
        if conn is None:
            break
        try:
            # Track-first, tiered by which mechanism it costs - Last.fm
            # track.getSimilar recursion primary, the artist-level bundle a
            # reserve once that's genuinely empty, an untargeted cached
            # library track only as an absolute last resort. This is what
            # keeps a backgrounded Radio session matching indefinitely
            # through a long unattended run instead of just running dry -
            # see radio_engine.generate_radio_batch_track_first.
            new_tracks, track_frontier, fallback_expanded_artists, _degraded = radio_engine.generate_radio_batch_track_first(
                session, session.get('seen_track_keys') or [], RADIO_ADVANCER_REFILL_BATCH, conn,
            )
            set_radio_session_track_state(radio_session_id, track_frontier, fallback_expanded_artists)
        finally:
            conn.close()
        refilled_from_radio = True
        if not new_tracks:
            break
        append_seen_track_keys(radio_session_id, [radio_engine.radio_track_key(t['track_name'], t['artist_name']) for t in new_tracks])
        # Carries every field the matching loop above can use to skip a live
        # search entirely - id (a real known_tracks id) or spotify_uri/
        # radio_track_id (an already-resolved radio_discovered_tracks row,
        # see radio_engine._index_cached_tracks_by_key) short-circuit it via
        # the same cache-hit paths an initial batch's candidates already
        # use; a plain text candidate (neither present) still gets a fresh
        # search at match time. selection_reason/selection_engine ride along
        # so whichever candidate actually gets played can stamp them onto
        # last_played_reason/last_played_engine (database._record_track_played)
        # for the Play Log.
        candidates = candidates + [
            {
                'id': t.get('id'), 'spotify_uri': t.get('spotify_uri'), 'radio_track_id': t.get('radio_track_id'),
                'track_name': t['track_name'], 'artist_name': t['artist_name'], 'album_name': t.get('album_name'),
                'artwork_url': t.get('artwork_url'), 'selection_reason': t.get('selection_reason'),
                'selection_engine': t.get('selection_engine'),
            }
            for t in new_tracks
        ]

    match_pool = {'candidates': candidates, 'cursor': cursor}
    if radio_session_id is not None:
        match_pool['radio_session_id'] = radio_session_id
    if not _radio_session_still_current(radio_session_id):
        # Same race as the matching loop above, guarding against this tick's
        # refill (generate_radio_batch_track_first, itself possibly a live
        # search) finishing after a newer session already saved its own pool.
        return match_pool
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
