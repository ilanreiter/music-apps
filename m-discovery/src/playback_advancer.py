import os
import re
import time

from . import wiim
from . import chromecast
from . import spotify_connect
from . import radio_engine
from .database import get_db_connection, get_radio_session, append_seen_track_keys

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

    queue_result = spotify_connect.get_queue()
    if queue_result is None:
        return match_pool

    radio_session_id = match_pool.get('radio_session_id')
    now_playing = queue_result['now_playing']
    if now_playing is not None and radio_session_id is not None:
        now_playing['radio_session_id'] = radio_session_id
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

    is_context = bool((now_playing or {}).get('context_uri'))
    duration = result.get('duration_ms') or 0
    position = result.get('position_ms') or 0
    near_end = duration > 0 and (duration - position) < SPOTIFY_NEAR_END_MS

    if not is_context and queue and near_end:
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
                now_playing = {
                    'id': track_uri, 'source': 'spotify', 'uri': track_uri,
                    'context_uri': (now_playing or {}).get('context_uri'),
                    'track_name': result.get('title'), 'artist_name': result.get('artist'),
                    'album_name': result.get('album'),
                    'duration_seconds': (result['duration_ms'] / 1000) if result.get('duration_ms') is not None else None,
                    'artwork_url': result.get('artwork_url'),
                    # This track fell outside the tracked queue window (e.g. a
                    # 999-track playlist past the frontend's 200-track queue
                    # cap), not a genuine change of playlist - still the same
                    # one the frontend originally started, so carry its name
                    # forward rather than losing it (see App.js's
                    # mapSpotifyTrack/PlayerBar's "Source: ..." label).
                    'playlist_name': (now_playing or {}).get('playlist_name'),
                    # Same reasoning - a Library track matched to Spotify's
                    # catalog for Connect playback (see App.js's
                    # mapMatchedLocalTrack) is still a Library track as far as
                    # the "Source: ..." label is concerned.
                    'origin_library': (now_playing or {}).get('origin_library'),
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
            is_context = bool((now_playing or {}).get('context_uri'))

    if is_context or queue or not match_pool:
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
            # A real known_tracks id (library-cast) uses the cache-first
            # matcher; a Radio candidate (Last.fm text suggestion, no local
            # row - id is None) has nothing to cache against, so it's
            # searched directly.
            if candidate_id is not None:
                match_result = _match_local_track_cached(candidate_id, candidate.get('track_name'), candidate.get('artist_name'))
            else:
                match_result = _match_text_candidate(candidate.get('track_name'), candidate.get('artist_name'))
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
                save_session(queue=[found], spotify_match_pool=match_pool)
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
            # Tiered by API cost, not just a flat Last.fm pull - tries
            # already-cached library tracks first (zero new Spotify calls),
            # only reaching for a fresh search if there's budget, and falling
            # further back to a wider (Last.fm-only, unthrottled) artist
            # pool of still-cached tracks if there isn't. This is what keeps
            # a backgrounded Radio session matching indefinitely through a
            # rate limit instead of just running dry - see
            # radio_engine.generate_radio_batch_for_spotify.
            new_tracks, _degraded = radio_engine.generate_radio_batch_for_spotify(
                session['seed_artists'], session.get('seen_track_keys') or [], RADIO_ADVANCER_REFILL_BATCH, conn,
            )
        finally:
            conn.close()
        refilled_from_radio = True
        if not new_tracks:
            break
        append_seen_track_keys(radio_session_id, [radio_engine.radio_track_key(t['track_name'], t['artist_name']) for t in new_tracks])
        # t.get('id') is a real known_tracks id for an already-cached library
        # track (find_cached_artist_tracks) - carrying it through lets the
        # matching loop above use the cache-hit path instead of a fresh
        # search; None (a plain Last.fm suggestion) still gets the text path.
        candidates = candidates + [
            {'id': t.get('id'), 'track_name': t['track_name'], 'artist_name': t['artist_name'], 'album_name': t.get('album_name')}
            for t in new_tracks
        ]

    match_pool = {'candidates': candidates, 'cursor': cursor}
    if radio_session_id is not None:
        match_pool['radio_session_id'] = radio_session_id
    if not _radio_session_still_current(radio_session_id):
        # Same race as the matching loop above, guarding against this tick's
        # refill (generate_radio_batch_for_spotify, itself possibly a live
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
            progress.update(status='error', error=str(e))
        time.sleep(delay)
