import base64
import json
import logging
import os
import re
import secrets
import subprocess
import threading
import time
from datetime import datetime, timedelta
from urllib.parse import quote

import requests
from ytmusicapi import YTMusic

from . import database
from .text_match import MATCH_THRESHOLD, _normalize, _similar, _tokens_contained

logger = logging.getLogger(__name__)

SPOTIFY_CLIENT_ID = os.environ.get('SPOTIFY_CLIENT_ID')
SPOTIFY_CLIENT_SECRET = os.environ.get('SPOTIFY_CLIENT_SECRET')
PUBLIC_BASE_URL = os.environ.get('PUBLIC_BASE_URL', 'http://localhost:8001')
# Spotify's OAuth redirect_uri must be https:// (or exactly http://localhost) -
# PUBLIC_BASE_URL is plain HTTP on a LAN IP (fine for stream/artwork URLs,
# which every other device on the LAN needs to reach), so this is a separate,
# optional env var pointed at an HTTPS front door just for the OAuth hop.
# Falls back to PUBLIC_BASE_URL for setups where that's already HTTPS.
SPOTIFY_REDIRECT_BASE_URL = os.environ.get('SPOTIFY_REDIRECT_BASE_URL', PUBLIC_BASE_URL)
REDIRECT_URI = f"{SPOTIFY_REDIRECT_BASE_URL}/api/spotify/auth/callback"

AUTHORIZE_URL = 'https://accounts.spotify.com/authorize'
TOKEN_URL = 'https://accounts.spotify.com/api/token'
API_BASE_URL = 'https://api.spotify.com/v1'
REQUEST_TIMEOUT = 10

# Connect (device discovery/control) + currently-playing polling + reading
# the user's own playlists, plus creating/editing playlists this app itself
# creates (playlist-modify-private - see create_playlist/add_tracks_to_playlist,
# used for "push this shuffled list to Spotify"). Existing connections were
# authorized before this scope was added, so they won't have it - Spotify
# scopes are fixed at authorization time, so a reconnect (disconnect then
# connect again in Settings) is required to pick up the new permission.
SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private playlist-read-collaborative playlist-modify-private'

# A short Retry-After is a normal transient burst limit worth one retry; this
# runs inline within a web request (unlike the old bulk-enrichment job), so a
# long block just fails the request rather than sleeping the whole app.
RATE_LIMIT_RETRY_CAP_SECONDS = 3

# CSRF check for the OAuth redirect - this is a personal single-user tool with
# no session/cookie infrastructure, so an in-memory pending value (like
# scan_progress in main.py) is enough; it only needs to survive the few
# seconds between redirecting to Spotify and Spotify redirecting back.
_pending_state = {'value': None}


def is_configured():
    return bool(SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET)


def get_auth_url():
    state = secrets.token_urlsafe(16)
    _pending_state['value'] = state
    params = {
        'client_id': SPOTIFY_CLIENT_ID,
        'response_type': 'code',
        'redirect_uri': REDIRECT_URI,
        'scope': SCOPES,
        'state': state,
    }
    query = '&'.join(f"{k}={quote(str(v))}" for k, v in params.items())
    return f"{AUTHORIZE_URL}?{query}"


def verify_and_consume_state(state):
    expected = _pending_state['value']
    _pending_state['value'] = None
    return bool(expected) and expected == state


def _basic_auth_header():
    raw = f"{SPOTIFY_CLIENT_ID}:{SPOTIFY_CLIENT_SECRET}".encode()
    return f"Basic {base64.b64encode(raw).decode()}"


def exchange_code_for_tokens(code):
    try:
        response = requests.post(
            TOKEN_URL,
            headers={'Authorization': _basic_auth_header()},
            data={'grant_type': 'authorization_code', 'code': code, 'redirect_uri': REDIRECT_URI},
            timeout=REQUEST_TIMEOUT,
        )
        response.raise_for_status()
        data = response.json()
    except Exception:
        return False

    database.save_spotify_tokens(
        access_token=data['access_token'],
        refresh_token=data.get('refresh_token'),
        expires_at=int(time.time()) + data['expires_in'] - 60,
        scope=data.get('scope'),
    )
    return True


def _refresh_access_token(refresh_token):
    try:
        response = requests.post(
            TOKEN_URL,
            headers={'Authorization': _basic_auth_header()},
            data={'grant_type': 'refresh_token', 'refresh_token': refresh_token},
            timeout=REQUEST_TIMEOUT,
        )
        response.raise_for_status()
        data = response.json()
    except Exception:
        return None

    # Spotify only sends a new refresh_token occasionally - save_spotify_tokens
    # keeps the existing one on disk when this is None.
    database.save_spotify_tokens(
        access_token=data['access_token'],
        refresh_token=data.get('refresh_token'),
        expires_at=int(time.time()) + data['expires_in'] - 60,
        scope=data.get('scope'),
    )
    return data['access_token']


def _get_valid_access_token():
    tokens = database.get_spotify_tokens()
    if not tokens:
        return None
    if tokens['expires_at'] and time.time() < tokens['expires_at']:
        return tokens['access_token']
    return _refresh_access_token(tokens['refresh_token'])


def is_connected():
    return database.get_spotify_tokens() is not None


def disconnect():
    database.clear_spotify_tokens()


# Spotify's 429 response for /search has been confirmed live to sometimes
# omit Retry-After entirely - falling back to "assume 1 second" in that case
# (as if Spotify meant "barely rate-limited at all") would defeat the whole
# point of persisting a cooldown at all: the always-on background pre-warm
# job (spotify_prewarm.py, one attempt every 5 minutes) would just try again
# almost immediately, re-poking an endpoint that's already rate-limiting the
# account and plausibly extending the penalty rather than ever letting it
# cool down. When the header's missing, assume a real block is in effect and
# back off for a while instead of barely at all.
SEARCH_RATE_LIMIT_FALLBACK_SECONDS = 300

# Self-reported (not gating) daily search count, purely for display/
# adjustment bookkeeping - Spotify publishes no quota number to pace
# against here (confirmed via their own docs: "the specific groupings and
# limits are subject to change", unlike YouTube's documented daily budget,
# see ytmusic_push_job.py's DAILY_SAFE_BUDGET). Since there's no
# authoritative figure, this starts at a guessed default
# (database.QUOTA_ESTIMATE_DEFAULT), moves down whenever a real 429 response
# body confirms Spotify actually meant "daily quota exhausted" (reason:
# QUOTA_EXCEEDED, a distinct signal Spotify added July 2026, rather than an
# ordinary short-window rate-limit which says nothing about the daily
# ceiling - see _learn_from_quota_exceeded), and moves up automatically
# whenever a real search completes with no rate limit hit and today's true
# count has already exceeded it (see _api_request). Confirmed live that
# having this also *gate* new attempts (the original design) was backwards -
# an untested guess was pre-emptively refusing real attempts before Spotify
# had ever actually said no. search_budget_available() below no longer
# checks this at all; the only thing that ever blocks a real attempt now is
# search_block_remaining_seconds' own persisted cooldown.
#
# A single anomalous block (observed live: one hit at only 7 requests that
# day) shouldn't be able to ratchet the estimate down to near-zero and
# effectively neuter Radio's Spotify-fresh-discovery path for unrelated
# reasons - never let it fall below this.
QUOTA_ESTIMATE_FLOOR = 5

# How long a confirmed QUOTA_EXCEEDED blocks new /search attempts before
# trying again, per user request - not a fixed "wait until midnight"
# anymore. Confirmed live that trusting Spotify's own Retry-After for this
# specific reason was unreliable (far shorter than the real block, causing
# repeated hits on the same wall every few minutes) - so instead of trusting
# either that header or a guessed daily-reset boundary, this lets one real
# search back through periodically to actually test whether it's cleared.
# If that probe still 429s, _api_request's same QUOTA_EXCEEDED handling
# extends the block by this same interval again - repeating until a probe
# genuinely succeeds, at which point the block simply isn't renewed and
# normal searching resumes immediately, no more waiting than necessary.
QUOTA_EXCEEDED_PROBE_INTERVAL_SECONDS = 3600


def search_budget_available():
    """True if a fresh /search call would actually be attempted right now -
    i.e. not inside a real, confirmed 429 cooldown. Lets a caller with a
    cheaper fallback (radio_engine.py's cached-local-track tiering) check
    first and skip straight to it, instead of finding out the hard way via
    an 'unavailable' result.

    Deliberately does NOT also gate on the self-learned daily quota estimate
    (database.get_spotify_quota_estimate) the way an earlier version did -
    confirmed live that was backwards: an untested guess (starting at 100)
    was pre-emptively refusing real attempts before Spotify had ever
    actually said no, so the counter (and Radio's own discovery) silently
    stalled at whatever the guess happened to be, with no way to tell "we
    hit a wall" apart from "we hit our own made-up ceiling." The only real
    signal Spotify gives is a real 429 - search_block_remaining_seconds
    reacts to that directly and is the sole gate here now. The daily
    estimate still exists, but purely as a reported/adjusted-after-the-fact
    number (see _api_request's post-response bookkeeping below), not
    something anything checks before acting."""
    return search_block_remaining_seconds() <= 0


def search_block_remaining_seconds():
    """How much longer a real Spotify 429 cooldown has left, or 0 if none is
    active. Reads the *persisted* cooldown (database.get_spotify_search_blocked_until)
    rather than an in-memory value - confirmed live this needed to survive
    a container restart: losing an in-memory-only cooldown mid-block meant
    immediately re-poking Spotify during its own penalty window the moment
    this app's process happened to restart. This is a *separate* gate from
    the daily quota estimate above - the estimate can read well under its
    ceiling (plenty of self-imposed headroom left) while Spotify's own
    enforcement is still actively blocking every search, since a single
    real 429's Retry-After (minutes to ~20h, observed live) has nothing to
    do with how many calls this app's own counter has made."""
    blocked_until = database.get_spotify_search_blocked_until()
    if blocked_until is None:
        return 0
    remaining = (blocked_until - datetime.utcnow()).total_seconds()
    return max(0, remaining)


def _extract_quota_exceeded_reason(response):
    """None, or 'QUOTA_EXCEEDED' if this 429's own response body confirms
    that's specifically what Spotify meant (added July 2026 - previously a
    429 gave no way to tell "daily quota exhausted" apart from "you're
    briefly going too fast"). Defensive about exactly where the field lives
    in the body, since the precise shape isn't fully documented anywhere
    this app's own research could confirm - checks a couple of plausible
    locations rather than assuming one, and never raises on an unexpected
    or non-JSON body."""
    try:
        body = response.json()
    except Exception:
        return None
    if not isinstance(body, dict):
        return None
    if body.get('reason') == 'QUOTA_EXCEEDED':
        return 'QUOTA_EXCEEDED'
    error = body.get('error')
    if isinstance(error, dict) and error.get('reason') == 'QUOTA_EXCEEDED':
        return 'QUOTA_EXCEEDED'
    return None


def _learn_from_quota_exceeded():
    """A confirmed QUOTA_EXCEEDED response is direct evidence that the
    actual request volume since the last reset already exceeded Spotify's
    real (undocumented) allowance - ratchets the self-imposed estimate down
    to just under that observed point, so the rest of this stretch stops
    before hitting the same wall instead of re-learning it the hard way.
    This only ever moves the estimate down - recovering it back up is
    database.maybe_recover_spotify_quota_estimate's job, run separately once
    a day after a clean stretch, not this function's (a bad stretch doesn't
    mean Spotify's real limit went up, so there's no equivalent positive
    signal to react to here).

    Also resets the "used" counter itself (database.reset_search_count) -
    per explicit user request, a real QUOTA_EXCEEDED is the ONLY thing that
    should ever reset it, not a calendar-day boundary. Done unconditionally
    here (not just when the estimate actually moves down) since this
    function only ever runs on a genuine new transition into being blocked
    (see the was_already_blocked guard at the only call site below) - that
    transition itself is the reset trigger, regardless of whether the
    estimate needed adjusting too."""
    observed = database.count_searches_since_last_reset()
    current_estimate = database.get_spotify_quota_estimate()
    new_estimate = max(QUOTA_ESTIMATE_FLOOR, min(current_estimate, observed - 1))
    if new_estimate < current_estimate:
        database.set_spotify_quota_estimate(
            new_estimate, f"QUOTA_EXCEEDED after {observed} real searches since the last reset",
        )
    database.reset_search_count(f"QUOTA_EXCEEDED after {observed} real searches")


def _api_request(method, path, params=None, json_body=None, retried=False):
    token = _get_valid_access_token()
    if not token:
        return None
    try:
        response = requests.request(
            method,
            f"{API_BASE_URL}{path}",
            headers={'Authorization': f'Bearer {token}'},
            params=params,
            json=json_body,
            timeout=REQUEST_TIMEOUT,
        )
    except Exception:
        return None

    if path == '/search':
        # Logged here for every real attempt that reaches Spotify - success
        # or not, including a post-429 retry below (its own real call) -
        # before any quota-learning logic reads it back, so a request that
        # itself triggers QUOTA_EXCEEDED is included in its own "how many
        # since the last reset" tally instead of being off by one.
        database.record_spotify_search()
        if response.status_code != 429:
            # A completed, non-429 response is direct proof the real volume
            # since the last reset is at least this high with no rate limit
            # hit - the daily estimate (purely a reported number now, see
            # search_budget_available - nothing gates on it anymore) should
            # track that instead of staying frozen at an old guess or a
            # since-superseded downward ratchet. Only ever raises; a real
            # 429 elsewhere in this function is still the only thing that
            # ever lowers it.
            observed = database.count_searches_since_last_reset()
            current_estimate = database.get_spotify_quota_estimate()
            if observed > current_estimate:
                database.set_spotify_quota_estimate(
                    observed, f"raised to match {observed} real searches completed since the last reset with no rate limit hit",
                )

    if response.status_code == 429:
        retry_after_header = response.headers.get('Retry-After')
        retry_after = int(retry_after_header) if retry_after_header is not None else 1
        if path == '/search':
            # Confirmed live: Spotify's own Retry-After alongside a
            # QUOTA_EXCEEDED 429 can be far shorter than the real block, so
            # honoring it literally caused repeated hits on the same wall
            # every few minutes. Rather than trust that header *or* assume a
            # fixed daily-reset boundary (also just a guess - Spotify never
            # confirmed the allowance actually resets at NY midnight
            # specifically), this blocks for a fixed probe interval instead
            # (QUOTA_EXCEEDED_PROBE_INTERVAL_SECONDS) and lets one real
            # search back through once it elapses, purely to test whether
            # it's actually cleared - if that probe also 429s, this same
            # branch runs again and extends the block by the same interval,
            # repeating until a probe genuinely succeeds (at which point the
            # non-429 branch above just doesn't renew the block, and normal
            # searching resumes immediately).
            was_already_blocked = search_block_remaining_seconds() > 0
            reason = _extract_quota_exceeded_reason(response)
            if reason == 'QUOTA_EXCEEDED':
                database.set_spotify_search_blocked_until(
                    datetime.utcnow() + timedelta(seconds=QUOTA_EXCEEDED_PROBE_INTERVAL_SECONDS),
                )
                if not was_already_blocked:
                    # Only a genuine transition into being rate-limited is
                    # new evidence about where today's real ceiling sits - a
                    # 429 that lands while a block was already in effect is
                    # just the same still-ongoing event, not a second
                    # independent data point, and must not ratchet the
                    # estimate down again for it.
                    _learn_from_quota_exceeded()
            else:
                # A missing header doesn't mean "barely rate-limited" -
                # assume a real block and back off for a while rather than
                # the ~1s this would otherwise fall back to (see
                # SEARCH_RATE_LIMIT_FALLBACK_SECONDS). Not a confirmed daily
                # exhaustion, so no reason to assume it lasts until midnight.
                block_seconds = retry_after if retry_after_header is not None else SEARCH_RATE_LIMIT_FALLBACK_SECONDS
                database.set_spotify_search_blocked_until(datetime.utcnow() + timedelta(seconds=block_seconds))
            # Deliberately no quick-retry for /search specifically - real
            # cooldowns here run minutes to ~20h (observed live), so retrying
            # a few seconds later is essentially guaranteed to hit the same
            # wall again. Confirmed live this was actually happening: one
            # logical lookup would 429, auto-retry once below, 429 again,
            # and get logged/learned-from twice for what was really a single
            # event. Every other endpoint keeps the existing quick-retry,
            # since their rate limits are observed to be much shorter-lived.
            return None
        if not retried:
            wait = min(retry_after, RATE_LIMIT_RETRY_CAP_SECONDS)
            time.sleep(wait)
            return _api_request(method, path, params=params, json_body=json_body, retried=True)
        return None

    if response.status_code == 204 or response.status_code == 202:
        return {}
    if not response.ok:
        return None
    if not response.content:
        return {}
    try:
        return response.json()
    except ValueError:
        # Spotify's player endpoints are documented as 204 on success, but
        # have been observed returning 200 with an opaque non-JSON body
        # instead (e.g. a bare token string) - still a success, just nothing
        # structured to parse out of it.
        return {}


# Outcome of the most recent play()/play_uris() call per device - in-memory
# only, reset on restart. Spotify's own /me/player/devices listing has no
# reliability signal of its own (a device can be listed as available and
# still fail to actually sustain playback - confirmed live on this account's
# "Office Streamer onn", which accepts commands and briefly plays before
# silently dropping back to paused every time). Recorded by play()/play_uris()
# below and surfaced through list_devices() so the destination picker can
# flag a device that's been failing, purely as a heads-up - a 'failed' device
# can still be selected and tried.
_device_last_outcome = {}  # device_id -> 'ok' | 'failed'


def _device_display_name(d):
    # Some Spotify Connect implementations (confirmed live on two real AVR
    # receivers on this account) never send a real device name during
    # registration - Spotify's own servers then fall back to the raw device
    # id as "name" verbatim, which every client reading this list (this app,
    # the official Spotify app, etc.) sees as-is. Swap in the device's own
    # `type` (Spotify's own coarse category - "AVR", "Speaker", "TV", ...)
    # as a far more legible fallback than a 40-character hex string.
    if d['name'] != d['id']:
        return d['name']
    return f"{d.get('type') or 'Spotify'} (unnamed)"


def list_devices():
    data = _api_request('GET', '/me/player/devices')
    if data is None:
        return []
    return [
        {'id': d['id'], 'name': _device_display_name(d), 'status': _device_last_outcome.get(d['id'], 'unknown')}
        for d in data.get('devices', [])
    ]


def get_device(device_id):
    for device in list_devices():
        if device['id'] == device_id:
            return device
    return None


_intent_lock = threading.Lock()
_intent_counter = 0
_latest_intent = {}  # device_id -> int, the most recent play()/play_uris() call for that device

# This app's own goal state per device - 'play' from the moment play()/
# play_uris() is called (regardless of whether that specific attempt ends up
# confirmed - the *intent* is still "should be playing" until an explicit
# pause() succeeds), 'pause' only once pause() actually confirms. Lets a
# poller (playback_advancer._maybe_auto_resume) tell "this device silently
# dropped out of playback on its own" apart from "this app told it to pause"
# - confirmed live (Office Streamer onn) that a device can genuinely
# confirm-play and then drop back to paused a while later with nothing
# noticing, since near_end/passive-reconciliation only react to the *track*
# changing, not playback silently stopping while the same one stays loaded.
_desired_state = {}  # device_id -> 'play' | 'pause'


def get_desired_state(device_id):
    return _desired_state.get(device_id)


def _start_intent(device_id):
    """Claims this call as the newest thing that should be playing on
    device_id, superseding any earlier play()/play_uris() call still
    mid-retry for the same device. Needed because the frontend can
    legitimately fire two casts to the same device close together -
    confirmed live: switching the output device (which re-casts whatever
    was already nowPlaying) landing at nearly the same moment as a fresh
    Shuffle All match finishing sent two concurrent play_uris calls for the
    same device, each with several seconds of its own retry loop. Without
    this, the two loops interleaved and fought over the device's real state,
    and the *older* call (retrying against its own now-stale target track)
    could win the last word, leaving the wrong (previous) track playing even
    though the newer, correct call had already succeeded moments earlier.
    Callers must bail out via _is_current_intent rather than keep retrying
    once superseded - continuing would just resume the same fight."""
    global _intent_counter
    with _intent_lock:
        _intent_counter += 1
        token = _intent_counter
        _latest_intent[device_id] = token
    return token


def _is_current_intent(device_id, token):
    return _latest_intent.get(device_id) == token


def _transfer_to_device(device_id):
    """Explicitly hands playback control to device_id before telling it to
    play something new. Needed because sending `play` straight to a device
    that isn't already Spotify's currently-active one is unreliable on
    several real devices (observed on Fire TV/Echo/smart-TV Connect targets
    on this account) - it can just resume whatever that device already had
    queued instead of switching to the new content. The short sleep gives a
    just-woken device time to actually become active before the follow-up
    play call, which otherwise can race the transfer."""
    _api_request('PUT', '/me/player', json_body={'device_ids': [device_id], 'play': False})
    # Spotify's own shuffle silently reorders which track from a queue
    # actually plays first (and how next/previous move through it) -
    # confirmed live: a 3-track play request started on track 3, not track 1,
    # while this account had shuffle on. Force it off so play()/play_uris()
    # are deterministic; this app has its own separate local-shuffle toggle
    # for local-library playback, unrelated to Spotify's own.
    _api_request('PUT', '/me/player/shuffle', params={'device_id': device_id, 'state': 'false'})
    time.sleep(0.3)


def play(device_id, context_uri, track_uri=None, drain_queue=False):
    """Returns True (sent successfully), False (a genuine failure - the API
    call itself failed), or the string 'superseded' (a newer play()/
    play_uris() call for this same device came in first, so this one
    deliberately did nothing - not a failure, see _start_intent). Callers
    must not treat 'superseded' as a real error - confirmed live this was
    previously conflated with a genuine failure (both returned bare False),
    which surfaced a misleading "couldn't reach Spotify" error to the user
    for what was actually just a normal race between two of their own quick
    actions (e.g. pressing Next twice)."""
    token = _start_intent(device_id)
    _desired_state[device_id] = 'play'
    if drain_queue:
        # Must transfer first - clear_queue's GET /me/player/queue and the
        # `next` calls it drains with both act on whatever device is
        # *currently* active account-wide, not device_id, unless this device
        # is already it (same reason play/play_uris always transfer before
        # playing - see _transfer_to_device).
        _transfer_to_device(device_id)
        clear_queue(device_id, token=token)
    if not _is_current_intent(device_id, token):
        logger.info("play %s: superseded by a newer call, bailing out", device_id)
        return 'superseded'
    _transfer_to_device(device_id)
    body = {'context_uri': context_uri}
    if track_uri:
        body['offset'] = {'uri': track_uri}
    result = _api_request('PUT', '/me/player/play', params={'device_id': device_id}, json_body=body)
    _device_last_outcome[device_id] = 'ok' if result is not None else 'failed'
    return result is not None


def pause(device_id, use_active_device=False):
    """use_active_device=True omits device_id from the actual API call, so
    it targets whichever device Spotify itself currently reports as active
    (see get_status's own active_device_id/active_device_name) rather than
    this specific id - for a caller that wants to silence "whatever's
    actually making noise right now" rather than force-target a possibly-
    stale tracked id. device_id is still used as the _desired_state key
    either way - that's this app's own bookkeeping of intent, independent of
    which literal id the API call targeted."""
    params = {} if use_active_device else {'device_id': device_id}
    result = _api_request('PUT', '/me/player/pause', params=params)
    if result is not None:
        _desired_state[device_id] = 'pause'
    return result is not None


def resume(device_id, use_active_device=False):
    """A bare PUT /me/player/play with no body restarts the current track
    from 0 instead of continuing - confirmed live on this account's Spotify
    Connect devices: a lone position_ms with no accompanying uris/context_uri
    is silently ignored. Re-fetches the paused track's uri/position and
    replays it explicitly with position_ms, which does resume in place.

    Also runs the device through _transfer_to_device first, same as
    play()/play_uris() - a device that's been paused for a while (or has
    quietly dropped its connection, which these budget Connect devices are
    already known to do) isn't reliably woken by /play alone; confirmed live
    that skipping this left the account with no active device at all after
    a resume, requiring a fresh play_uris call to recover.

    use_active_device=True skips that explicit transfer (there's no single
    "the" device to wake when the goal is "resume whatever's already active,
    wherever that is") and omits device_id from the actual play call, same
    reasoning as pause's own use_active_device. Confirmed live this matters:
    the account's real active device can drift to a different (or mirrored)
    id than whatever this app tracked at session start - transferring to
    that stale id would force playback back onto it instead of just letting
    whatever's genuinely active keep going."""
    current = get_status(device_id)
    if current and current.get('track_uri') and current.get('position_ms') is not None:
        params = {}
        if not use_active_device:
            _transfer_to_device(device_id)
            params['device_id'] = device_id
        result = _api_request('PUT', '/me/player/play', params=params, json_body={
            'uris': [current['track_uri']],
            'position_ms': current['position_ms'],
        })
        return result is not None
    params = {} if use_active_device else {'device_id': device_id}
    result = _api_request('PUT', '/me/player/play', params=params)
    return result is not None


def stop(device_id):
    # Spotify's API has no transport "stop" distinct from pause.
    return pause(device_id)


def seek(device_id, position_ms):
    result = _api_request('PUT', '/me/player/seek', params={'device_id': device_id, 'position_ms': position_ms})
    return result is not None


def set_volume(device_id, level):
    result = _api_request('PUT', '/me/player/volume', params={'device_id': device_id, 'volume_percent': max(0, min(100, int(level)))})
    return result is not None


def next_track(device_id, use_active_device=False):
    """use_active_device=True - same reasoning as pause()/resume()/
    add_to_queue()/play_uris() above: omits device_id from the actual API
    call so it targets whichever device Spotify itself currently considers
    active, for a caller following up right after a use_active_device=True
    play_uris() call that may not have landed on device_id literally."""
    params = {} if use_active_device else {'device_id': device_id}
    result = _api_request('POST', '/me/player/next', params=params)
    return result is not None


def previous_track(device_id):
    result = _api_request('POST', '/me/player/previous', params={'device_id': device_id})
    return result is not None


def get_status(device_id):
    """device_id is unused - GET /me/player has always been account-wide,
    not scoped to any particular device (confirmed live, and already
    documented elsewhere - see clear_queue's own docstring on GET /me/player/
    queue behaving the same way). Kept as a parameter since most callers
    pass their own tracked destination_id and it costs nothing to accept.

    Includes active_device_id/active_device_name - Spotify's own response
    already carries these on every call (this function just wasn't reading
    them out before), and they're the authoritative answer to "which device
    does Spotify itself think is active right now" - not necessarily the
    same device_id a caller is tracking, which is exactly the gap that let
    a session go silently untracked when the account's real active device
    drifted to a different (or mirrored) id outside this app's control."""
    data = _api_request('GET', '/me/player')
    if data is None:
        return None
    if not data:
        return {
            'reachable': True, 'status': 'stop', 'position_ms': None, 'duration_ms': None,
            'volume': None, 'track_uri': None, 'title': None, 'artist': None, 'album': None,
            'artwork_url': None, 'active_device_id': None, 'active_device_name': None,
        }

    item = data.get('item') or {}
    album = item.get('album') or {}
    images = album.get('images') or []
    device = data.get('device') or {}

    return {
        'reachable': True,
        'status': 'play' if data.get('is_playing') else 'pause',
        'position_ms': data.get('progress_ms'),
        'duration_ms': item.get('duration_ms'),
        'volume': device.get('volume_percent'),
        'track_uri': item.get('uri'),
        'title': item.get('name'),
        'artist': ', '.join(a['name'] for a in item.get('artists', [])),
        'album': album.get('name'),
        'artwork_url': images[0]['url'] if images else None,
        'active_device_id': device.get('id'),
        'active_device_name': device.get('name'),
    }


def _map_queue_item(item):
    """Raw Spotify track item (from /me/player/queue) into this app's own
    track shape - same fields playback_advancer._advance_spotify's own
    matched-track dicts use, so the "spotify_native" radio mode (see
    playback_advancer._advance_spotify_native) can hand these straight to
    save_session(now_playing=..., queue=...) with no further mapping."""
    if not item:
        return None
    album = item.get('album') or {}
    images = album.get('images') or []
    return {
        'id': item.get('uri'), 'source': 'spotify', 'uri': item.get('uri'), 'context_uri': None,
        'track_name': item.get('name'),
        'artist_name': ', '.join(a['name'] for a in item.get('artists', [])),
        'album_name': album.get('name'),
        'duration_seconds': (item['duration_ms'] / 1000) if item.get('duration_ms') is not None else None,
        'artwork_url': images[0]['url'] if images else None,
    }


def get_queue():
    """Spotify's own account-wide "on air + up next" - reflects whatever the
    active device's native queue actually holds, including anything its own
    autoplay added on its own once a spotify_native radio session's seed
    track played through (see playback_advancer._advance_spotify_native). A
    read-only GET against a dedicated endpoint, not /search - doesn't touch
    this app's own search budget at all, which is the whole appeal of that
    radio mode. Returns None if the request itself failed; {'now_playing':
    None, 'queue': []} is a normal "nothing playing right now" response, not
    a failure."""
    data = _api_request('GET', '/me/player/queue')
    if data is None:
        return None
    return {
        'now_playing': _map_queue_item(data.get('currently_playing')),
        'queue': [t for t in (_map_queue_item(i) for i in (data.get('queue') or [])) if t],
    }


def _get_full_url(url):
    """Like _api_request, but for a complete `next` pagination URL Spotify
    already handed back (own query string included) rather than a path+params
    pair we'd build ourselves."""
    token = _get_valid_access_token()
    if not token:
        return None
    try:
        response = requests.get(url, headers={'Authorization': f'Bearer {token}'}, timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
        return response.json()
    except Exception:
        return None


def _paginate(path, params):
    items = []
    data = _api_request('GET', path, params=params)
    while data:
        items.extend(data.get('items', []))
        next_url = data.get('next')
        if not next_url:
            break
        data = _get_full_url(next_url)
    return items


def list_playlists():
    raw = _paginate('/me/playlists', {'limit': 50})
    playlists = []
    for p in raw:
        images = p.get('images') or []
        # Spotify renamed the playlist's track-count sub-object from `tracks`
        # to `items` at some point - accept either since which one a given
        # account/API version returns isn't guaranteed to stay put.
        count_obj = p.get('items') or p.get('tracks') or {}
        playlists.append({
            'id': p['id'],
            'name': p['name'],
            'track_count': count_obj.get('total', 0),
            'artwork_url': images[0]['url'] if images else None,
            'uri': p['uri'],
        })
    return playlists


def get_playlist_tracks(playlist_id):
    """List of track dicts, or None if this playlist's contents aren't
    readable via the API - confirmed empirically: Spotify 403s reads of the
    track listing for any playlist not owned by the authenticated account
    (even public/followed ones), but play() below still works fine on the
    same playlist via context_uri, since starting playback isn't gated the
    same way reading someone else's playlist contents is."""
    # The playlist-contents endpoint also moved from .../tracks (now 403s
    # unconditionally) to .../items, with each entry's track payload moved
    # from an entry["track"] key to entry["item"] - support both defensively.
    token = _get_valid_access_token()
    if not token:
        return None
    try:
        probe = requests.get(
            f"{API_BASE_URL}/playlists/{playlist_id}/items",
            headers={'Authorization': f'Bearer {token}'}, params={'limit': 100}, timeout=REQUEST_TIMEOUT,
        )
    except Exception:
        return None
    if probe.status_code == 403:
        return None
    if not probe.ok:
        return []

    first_page = probe.json()
    raw = first_page.get('items', [])
    next_url = first_page.get('next')
    while next_url:
        page = _get_full_url(next_url)
        if not page:
            break
        raw.extend(page.get('items', []))
        next_url = page.get('next')

    tracks = []
    for entry in raw:
        t = entry.get('item') or entry.get('track')
        if not t or not t.get('uri'):
            continue  # local files / unavailable tracks Spotify can't play via Connect
        album = t.get('album') or {}
        images = album.get('images') or []
        artists = t.get('artists') or []
        external_ids = t.get('external_ids') or {}
        tracks.append({
            'uri': t['uri'],
            'name': t['name'],
            'artists': ', '.join(a['name'] for a in artists),
            'album': album.get('name'),
            'duration_ms': t.get('duration_ms'),
            'artwork_url': images[0]['url'] if images else None,
            # Extra metadata for the Playlists tab's "All Tracks" cache (see
            # get_all_playlist_tracks below) - all come free off this same
            # track object, no extra API calls. Harmless extra keys for
            # every other caller (main.py's response_model filters them back
            # out for the plain playlist-browsing route). genre isn't here -
            # it's an artist-level attribute in Spotify's API, not a
            # per-track one, so it's looked up separately by primary_artist_id.
            'isrc': external_ids.get('isrc'),
            'popularity': t.get('popularity'),
            'explicit': t.get('explicit'),
            'release_date': album.get('release_date'),
            'primary_artist_id': artists[0]['id'] if artists else None,
        })
    return tracks


def get_artist_genres(artist_ids):
    """Batched artist genre lookup - GET /artists accepts up to 50 ids per
    call, so this costs one request per ~50 unique artists rather than one
    per track. Genre is an artist-level attribute in Spotify's API (not a
    per-track one), which is why get_all_playlist_tracks looks it up this
    way instead of per track. Returns {artist_id: 'genre1, genre2'}."""
    token = _get_valid_access_token()
    if not token:
        return {}
    genres_by_id = {}
    unique_ids = list(dict.fromkeys(aid for aid in artist_ids if aid))
    for i in range(0, len(unique_ids), 50):
        batch = unique_ids[i:i + 50]
        try:
            resp = requests.get(
                f"{API_BASE_URL}/artists",
                headers={'Authorization': f'Bearer {token}'}, params={'ids': ','.join(batch)}, timeout=REQUEST_TIMEOUT,
            )
        except Exception:
            continue
        if not resp.ok:
            continue
        for artist in resp.json().get('artists') or []:
            if artist and artist.get('id'):
                genres_by_id[artist['id']] = ', '.join(artist.get('genres') or [])
    return genres_by_id


def get_all_playlist_tracks():
    """Every track across every playlist, deduped by uri (the same track in
    two playlists is genuinely the same track, not two rows) - backs the
    Playlists tab's "All Tracks" mode. Playlists this account doesn't own
    403 on their track listing (see get_playlist_tracks) - counted and
    skipped rather than aborting the whole aggregation. Returns
    (tracks, skipped_count), each track dict shaped for
    database.replace_playlist_track_cache."""
    seen = {}
    skipped = 0
    for p in list_playlists():
        tracks = get_playlist_tracks(p['id'])
        if tracks is None:
            skipped += 1
            continue
        for t in tracks:
            if t['uri'] not in seen:
                seen[t['uri']] = t
    unique_tracks = list(seen.values())
    genres_by_artist = get_artist_genres([t.get('primary_artist_id') for t in unique_tracks])
    return [{
        'track_id': t['uri'].split(':')[-1],
        'track_name': t['name'],
        'artist_name': t['artists'],
        'album': t['album'],
        'artwork_url': t['artwork_url'],
        'isrc': t.get('isrc'),
        'duration_ms': t.get('duration_ms'),
        'popularity': t.get('popularity'),
        'explicit': t.get('explicit'),
        'release_date': t.get('release_date'),
        'genre': genres_by_artist.get(t.get('primary_artist_id')),
    } for t in unique_tracks], skipped


PLAYLIST_ADD_BATCH_SIZE = 100  # Spotify's own per-request cap on POST .../tracks


def create_playlist(name, description=None):
    """Creates a new private playlist in the connected account. Private
    (not public) by default - this app has no reason to publish anything to
    the account's public profile on its own. Returns {'id', 'url'}, or None
    if not connected, this scope isn't authorized yet (see SCOPES above), or
    the call otherwise fails.

    POST /me/playlists, not POST /users/{user_id}/playlists - confirmed live
    the latter now returns a bare 403 for every caller regardless of scope
    or app configuration (this app's registration was fine; the endpoint
    itself moved). /me/playlists needs no separate /me lookup first either,
    since it creates directly under the authenticated account."""
    body = {'name': name, 'public': False}
    if description:
        body['description'] = description
    data = _api_request('POST', '/me/playlists', json_body=body)
    if data is None or not data.get('id'):
        return None
    return {'id': data['id'], 'url': (data.get('external_urls') or {}).get('spotify')}


def add_tracks_to_playlist(playlist_id, uris):
    """Adds uris to playlist_id, batched to Spotify's 100-per-request limit.
    Returns True only if every batch succeeded - on a partial failure the
    playlist is left as whatever got added before the failing batch (not
    rolled back; a personal single-user tool has no need for transactional
    cleanup here, and the playlist is still usable with what did land).

    POST /playlists/{id}/items, not .../tracks - same endpoint rename
    get_playlist_tracks above already works around for reads (.../tracks
    now 403s unconditionally for the write side too, confirmed live)."""
    for i in range(0, len(uris), PLAYLIST_ADD_BATCH_SIZE):
        batch = uris[i:i + PLAYLIST_ADD_BATCH_SIZE]
        if _api_request('POST', f'/playlists/{playlist_id}/items', json_body={'uris': batch}) is None:
            return False
    return True


RADIO_SEED_PLAYLIST_NAME = "m-discovery Radio Seed"
RADIO_SEED_PLAYLIST_DESCRIPTION = (
    "Used internally by m-discovery's Spotify Radio mode - its one track "
    "changes every time a new session starts. Safe to ignore."
)


def ensure_radio_seed_playlist():
    """Get-or-create the one playlist spotify_native radio reuses every time
    a session starts (see main.py's start_radio / seed_radio_playlist
    below). Confirmed live: Spotify's own Autoplay only continues once a
    real *context* (playlist/album/artist) finishes - a bare ad-hoc
    play_uris track, however Autoplay is configured on the account, never
    triggers it (verified directly: an album context correctly handed off
    to Autoplay once its last track ended; a plain uris-list play of the
    same account/device just stopped). A single-track playlist is the
    smallest context that gets the same handoff, without playing through
    anything else first the way a real album/playlist would. Reused rather
    than created fresh per session so this doesn't litter the account with
    a new playlist every time Radio starts. Returns {'id', 'uri'}, or None
    if creation genuinely failed (not connected, scope missing, API error)."""
    playlist_id = database.get_spotify_radio_seed_playlist_id()
    if playlist_id:
        # Confirm it still exists - the user could have deleted it from
        # Spotify directly - rather than trusting a stale id forever and
        # failing every session start on a 404 that's simple to self-heal.
        if _api_request('GET', f'/playlists/{playlist_id}', params={'fields': 'id'}) is not None:
            return {'id': playlist_id, 'uri': f'spotify:playlist:{playlist_id}'}
    created = create_playlist(RADIO_SEED_PLAYLIST_NAME, RADIO_SEED_PLAYLIST_DESCRIPTION)
    if created is None:
        return None
    database.set_spotify_radio_seed_playlist_id(created['id'])
    return {'id': created['id'], 'uri': f"spotify:playlist:{created['id']}"}


def seed_radio_playlist(track_uri):
    """Replaces the radio-seed playlist's entire contents with just
    track_uri and returns its context_uri to play - see
    ensure_radio_seed_playlist. Returns None if the playlist couldn't be
    ensured or the replace call itself failed.

    PUT /playlists/{id}/items, not .../tracks - same endpoint rename
    add_tracks_to_playlist above already works around (.../tracks 403s
    unconditionally for this app's calls, confirmed live)."""
    playlist = ensure_radio_seed_playlist()
    if playlist is None:
        return None
    if _api_request('PUT', f"/playlists/{playlist['id']}/items", json_body={'uris': [track_uri]}) is None:
        return None
    return playlist['uri']


# Bumped from 3 - confirmed live one of this account's actual devices
# (a budget WiFi streamer) needed all 3 of the old attempts to catch up and
# start the right track, leaving no margin before play_uris gives up and
# main.py surfaces a 502 to the user. 5 attempts at the same 2s spacing
# still fails within ~10-16s worst case, not an unreasonable wait, and gives
# genuinely slow/flaky devices like that one real headroom instead of none.
PLAY_URIS_MAX_ATTEMPTS = 5
PLAY_URIS_CONFIRM_DELAY_SECONDS = 2
SUSTAIN_CHECK_DELAY_SECONDS = 5


def _schedule_sustain_check(device_id, expected_uri):
    """The 2-second confirm check above isn't enough to catch every failure
    mode - confirmed live on this account's "Office Streamer onn": it
    genuinely starts playing and satisfies that check, then silently drops
    back to paused a few seconds later on its own (real device/network
    flakiness, not anything a repeated play command fixes). That looked like
    a healthy device to _device_last_outcome even though it wasn't.

    Runs in a background thread rather than blocking the caller for another
    several seconds on top of the confirm delay already paid above - callers
    (interactive Next/Prev clicks especially) already return once the initial
    confirm passes; this only refines the *reliability signal* a moment
    later, not whether playback started. Deliberately overwrites whatever
    _device_last_outcome already holds for this device - a good result here
    should still win over a stale 'failed' from an earlier attempt, and vice
    versa."""
    def _check():
        time.sleep(SUSTAIN_CHECK_DELAY_SECONDS)
        status = get_status(device_id)
        sustained = bool(status and status.get('status') == 'play' and status.get('track_uri') == expected_uri)
        _device_last_outcome[device_id] = 'ok' if sustained else 'failed'
    threading.Thread(target=_check, daemon=True).start()


def play_uris(device_id, uris, drain_queue=False, use_active_device=False):
    """Play an explicit ad-hoc list of Spotify track URIs (not a playlist
    context) - used for local-library tracks matched to their Spotify catalog
    equivalent, since there's no existing Spotify playlist backing them.

    use_active_device=True skips _transfer_to_device and omits device_id
    from every play call in here, so this targets whichever device Spotify
    already considers active instead of forcing playback onto device_id
    specifically - same reasoning as pause/resume/add_to_queue's own
    use_active_device. Confirmed live this matters for a track-to-track
    transition specifically: the account's real active device can be
    switched entirely outside this app (the Spotify app's own device
    picker), and forcing a transfer back onto whatever this app originally
    tracked overrides that choice the moment the next transition fires,
    even though everything else (status, queue additions) had already
    correctly followed the switch. No fallback to a specific device_id if
    this comes back unconfirmed - see the caller in playback_advancer.py,
    which retries once with a targeted device_id rather than leaving Radio
    silently stalled if nothing was genuinely active at that instant.

    Confirmed live on this account's devices: the play command intermittently
    "takes" (track loads, correct metadata) without actually starting
    playback - device left paused at position ~0, sometimes needing more than
    one retry to actually catch. Verified and retried up to
    PLAY_URIS_MAX_ATTEMPTS times rather than trusting the 200 response alone,
    since a caller with nobody watching (the background advancer transitioning
    tracks unattended, which is the whole point of this app not depending on
    a browser tab) would otherwise leave playback silently stuck paused with
    no one to notice and press play again.

    The confirm check verifies track_uri, not just status=='play' - confirmed
    live this matters: with drain_queue=True, the confirm poll can land while
    the device is still finishing settling from the drain's own `next` calls
    (a *different* track playing, just not the one this call asked for), and
    checking status alone let that false-positive as success - the reported
    symptom was "plays something from the old queue instead of the new
    list's first track" even though clear_queue had genuinely skipped past
    the stale entries. Retrying (which re-sends the same play call) corrects
    it once Spotify's backend actually catches up.

    drain_queue: see clear_queue - drains any queue residue from an earlier
    session before playing, only appropriate for a genuinely new ad-hoc
    session (never for the driven Next/Prev or lookahead-handoff callers of
    this function, which rely on the queue's own lookahead entry).

    Bails out early (returns 'superseded', sends no further requests) if
    superseded by a newer play()/play_uris() call for the same device - see
    _start_intent. Confirmed live this matters: switching the output device
    (which re-casts whatever was already nowPlaying) landing at nearly the
    same moment as a fresh Shuffle All match finishing fired two concurrent
    play_uris calls for the same device; without this guard, the older
    call's retry loop kept fighting the newer one for the device's state and
    could win the last word, leaving the previous (wrong) track playing.
    'superseded' is deliberately distinct from a bare False (a genuine
    failure after exhausting every attempt) - callers must not treat it as
    an error, see play()'s docstring for the fuller reasoning (this was
    previously conflated, surfacing a misleading error to the user for a
    normal race between two of their own quick actions)."""
    token = _start_intent(device_id)
    _desired_state[device_id] = 'play'
    play_params = {} if use_active_device else {'device_id': device_id}
    if drain_queue:
        # Must transfer first - see the matching comment in play(). Not
        # skipped for use_active_device - drain_queue is only ever True for
        # a genuinely new ad-hoc session start, which use_active_device is
        # never used for (see this function's own docstring - it's for an
        # already-running session's transition, never the initial start).
        _transfer_to_device(device_id)
        clear_queue(device_id, token=token)
    for attempt in range(1, PLAY_URIS_MAX_ATTEMPTS + 1):
        if not _is_current_intent(device_id, token):
            logger.info("play_uris %s: superseded by a newer call before attempt %d, bailing out", device_id, attempt)
            return 'superseded'
        if not use_active_device:
            _transfer_to_device(device_id)
        result = _api_request('PUT', '/me/player/play', params=play_params, json_body={'uris': uris})
        if result is None:
            logger.warning("play_uris %s: attempt %d/%d - request failed", device_id, attempt, PLAY_URIS_MAX_ATTEMPTS)
            continue
        time.sleep(PLAY_URIS_CONFIRM_DELAY_SECONDS)
        if not _is_current_intent(device_id, token):
            logger.info("play_uris %s: superseded by a newer call after attempt %d's play, bailing out", device_id, attempt)
            return 'superseded'
        confirm_status = get_status(device_id)
        if confirm_status and confirm_status.get('status') == 'play' and confirm_status.get('track_uri') == uris[0]:
            if attempt > 1:
                logger.info("play_uris %s: confirmed playing on attempt %d/%d", device_id, attempt, PLAY_URIS_MAX_ATTEMPTS)
            _schedule_sustain_check(device_id, uris[0])
            return True
        # The right track loaded but is sitting paused rather than playing -
        # a different failure mode than "wrong/no track loaded" (the retry
        # loop above already handles that by re-sending the whole play call).
        # Confirmed live this specific case needed the same explicit
        # position_ms reissue resume() already uses to un-stick a paused
        # device - a bare re-send of {'uris': uris} with no position can
        # itself land as another silent no-op. Doesn't count against
        # PLAY_URIS_MAX_ATTEMPTS - it's a same-attempt recovery, not a fresh
        # attempt at loading the track.
        if confirm_status and confirm_status.get('track_uri') == uris[0] and confirm_status.get('status') == 'pause' \
                and _is_current_intent(device_id, token):
            unstick = _api_request('PUT', '/me/player/play', params=play_params, json_body={
                'uris': uris, 'position_ms': confirm_status.get('position_ms') or 0,
            })
            if unstick is not None:
                time.sleep(PLAY_URIS_CONFIRM_DELAY_SECONDS)
                confirm_status = get_status(device_id)
                if confirm_status and confirm_status.get('status') == 'play' and confirm_status.get('track_uri') == uris[0]:
                    logger.info("play_uris %s: right track was stuck paused, un-stuck via explicit position_ms reissue", device_id)
                    _schedule_sustain_check(device_id, uris[0])
                    return True
        logger.warning(
            "play_uris %s: attempt %d/%d loaded but didn't start on the right track (status=%r, track_uri=%r, expected=%r)",
            device_id, attempt, PLAY_URIS_MAX_ATTEMPTS,
            confirm_status and confirm_status.get('status'), confirm_status and confirm_status.get('track_uri'), uris[0],
        )
    _device_last_outcome[device_id] = 'failed'
    return False


def add_to_queue(device_id, uri, use_active_device=False):
    """Appends a single track to the end of the currently active playback
    queue, without interrupting what's already playing - used to feed one
    lookahead match at a time instead of front-loading a whole batch.

    use_active_device=True omits device_id from the request, targeting
    whichever device Spotify already considers active instead of this
    specific id - same reasoning as pause/resume's own use_active_device.
    GET /me/player/queue itself has always reported whatever's active
    account-wide regardless of what device_id a caller asks about (see
    clear_queue's own docstring) - this makes the add side consistent with
    that instead of pinning to a tracked id that can drift out of sync with
    reality."""
    params = {'uri': uri} if use_active_device else {'uri': uri, 'device_id': device_id}
    result = _api_request('POST', '/me/player/queue', params=params)
    success = result is not None
    if success:
        # Tracks exactly how many real account-queue entries are sitting
        # there unconsumed - see clear_queue, which drains against this
        # instead of guessing. Only incremented on a confirmed success, so
        # a failed add (this app believes nothing landed) doesn't inflate
        # the count past what's actually sitting on the account.
        database.increment_pending_queue_adds()
    return success


# Absolute ceiling regardless of what pending_queue_adds or Spotify's own
# reported queue length say - a genuine safety net against a runaway drain
# (a corrupted counter, or a real context playlist's own remaining tracks
# mixed into GET /me/player/queue's response - see this function's own
# docstring) turning into an extremely slow walk before the actual play
# call ever lands.
CLEAR_QUEUE_SAFETY_CAP = 200
# Confirmed live this matters, specifically for a slower/flakier device (a
# budget WiFi streamer, on this account): firing the drain's /next calls
# back-to-back with no pause at all could leave it in an inconsistent state
# right as the follow-up play() call landed moments later, surfacing as
# "wrong track playing" or "nothing playing" - and only ever on a freshly
# restored/new session, since that's the only time drain_queue=True runs at
# all. CLEAR_QUEUE_STEP_DELAY_SECONDS paces each individual skip;
# CLEAR_QUEUE_SETTLE_DELAY_SECONDS gives one more moment for the device to
# fully catch up after the last one, before the actual play command arrives.
CLEAR_QUEUE_STEP_DELAY_SECONDS = 0.3
CLEAR_QUEUE_SETTLE_DELAY_SECONDS = 0.5
# How many extra skip rounds to try, beyond the initial tracked/reported
# pass, if Spotify still reports an active *context* afterward - a context
# (a playlist/album/shuffled Liked Songs actively driving playback, not
# this app's own ad-hoc queue) is a fundamentally different, harder problem
# than ordinary leftover residue: GET /me/player/queue only ever shows a
# shallow "next few" preview of it, which just refills to roughly the same
# depth after every skip, so a single guessed count computed once up front
# can never actually escape it. Bounded rather than unbounded so a
# genuinely endless shuffle doesn't turn this into an infinite loop - after
# this many rounds, give up and let the caller's own play()/play_uris() ad-
# hoc list try to override it directly instead (confirmed live that alone
# can still win, just not reliably on the first attempt - see play_uris'
# own retry loop).
CLEAR_QUEUE_MAX_CONTEXT_ROUNDS = 4
CLEAR_QUEUE_CONTEXT_ROUND_SIZE = 15


def clear_queue(device_id, token=None):
    """Spotify's Web API has no endpoint to remove a track from the queue -
    once something lands there it can only be consumed by skipping past it.
    A manually-queued track (via add_to_queue above - this app's own
    lookahead buffer, or anything queued from another Spotify client)
    survives a later play()/play_uris() call untouched, confirmed live: it
    gets spliced in after whatever that call starts, and surfaces later as
    an unexplained jump to unrelated older music - including, confirmed
    live, getting mistakenly tagged as belonging to whatever *new* radio
    session happens to be active when it resurfaces, since this app's own
    passive reconciliation has no way to tell "genuinely this session's
    own track" apart from "stray leftover from a previous one" other than
    whether anything is still sitting in Spotify's real account queue at
    all.

    Drains database.take_pending_queue_adds() - the exact count of real
    add_to_queue calls not yet accounted for by a previous drain, tracked
    precisely because this app is the only thing that ever calls it for its
    own ad-hoc sessions - rather than guessing from a flat cap. Confirmed
    live the old flat 20-item cap wasn't enough: a radio session running
    long enough to queue more than that over its lifetime left genuine
    residue behind that resurfaced under a later session. Ceilinged at
    CLEAR_QUEUE_SAFETY_CAP (so a runaway count, or a real context
    playlist's own remaining tracks mixed into GET /me/player/queue's
    response, can't turn this into an extremely slow walk through an entire
    playlist before the actual play call ever lands).

    That single pass is only ever as good as its one up-front guess, which
    confirmed-live can badly undercount: a device with its own actively-
    refilling context (someone shuffling Liked Songs directly in the real
    Spotify app on that device, say) makes GET /me/player/queue's "next few"
    preview refill to roughly the same shallow depth after every skip,
    since there's no fixed amount left to run out of. So after the initial
    pass, this checks GET /me/player's own context field - if a context is
    still actively driving playback, that's real, different evidence beyond
    ordinary residue, and it's worth a few more bounded rounds
    (CLEAR_QUEUE_MAX_CONTEXT_ROUNDS x CLEAR_QUEUE_CONTEXT_ROUND_SIZE) rather
    than giving up after one guessed count. Still bounded overall, since a
    genuinely endless shuffle can't be fully escaped this way no matter how
    many rounds are tried - at that point the caller's own play()/play_uris()
    ad-hoc list has to just try to win the override directly instead.

    Called via play()/play_uris()'s drain_queue=True, itself only passed for
    a genuinely new ad-hoc session (a fresh track/Shuffle All/Play All click,
    switching the destination to Spotify, or restoring a session on Play) -
    not for in-session Next/Prev or the near-end lookahead handoff
    (playback_advancer._advance_spotify), which intentionally rely on the
    single lookahead track add_to_queue just placed there. Also callable
    directly (see clear_queue_for_device) for the Settings "Clear queue"
    button, a manual escape hatch for whenever the automatic drain still
    isn't enough. Best-effort: any failure just leaves the residue for next
    time rather than blocking playback.

    token: the caller's own _start_intent token, if it has one (play()/
    play_uris() do) - lets a multi-step drain bail out immediately if a
    newer call for the same device supersedes this one partway through,
    rather than continuing to fire skip commands that would only fight with
    (and waste time ahead of) the newer call's own attempt.

    Caller must already have transferred to device_id (see play()/play_uris())
    before calling this - GET /me/player/queue, GET /me/player, and the
    `next` calls this drains with all act on whatever device is *currently*
    active account-wide, not necessarily device_id, so calling this against
    a device that isn't already active drains (or reads) the wrong device's
    queue.

    Returns how many tracks were actually skipped."""
    tracked_pending = database.take_pending_queue_adds()
    data = _api_request('GET', '/me/player/queue')
    reported_pending = len(data.get('queue') or []) if data else 0
    # Whichever signal says more - either can under-report on its own
    # (tracked_pending only knows what this app itself queued via
    # add_to_queue since the last drain, e.g. nothing if a container
    # restart happened mid-session before this call ever landed; the API's
    # own report has its own confirmed quirks) - capped so neither a
    # corrupted count nor a real context playlist's own remaining tracks
    # can turn this into an extremely slow drain.
    pending = min(max(tracked_pending, reported_pending), CLEAR_QUEUE_SAFETY_CAP)
    drained = 0

    def _skip_batch(count):
        nonlocal drained
        for _ in range(count):
            if token is not None and not _is_current_intent(device_id, token):
                logger.info("clear_queue %s: superseded by a newer call mid-drain, bailing out", device_id)
                return False
            if not next_track(device_id):
                break
            drained += 1
            time.sleep(CLEAR_QUEUE_STEP_DELAY_SECONDS)
        return True

    if not _skip_batch(pending):
        database.restore_pending_queue_adds(max(0, pending - drained))
        return drained

    for _ in range(CLEAR_QUEUE_MAX_CONTEXT_ROUNDS):
        status_data = _api_request('GET', '/me/player')
        if not status_data or not status_data.get('context'):
            break
        logger.info("clear_queue %s: context still active after %d skips, trying another round", device_id, drained)
        if not _skip_batch(CLEAR_QUEUE_CONTEXT_ROUND_SIZE):
            database.restore_pending_queue_adds(max(0, pending - drained))
            return drained

    if drained:
        time.sleep(CLEAR_QUEUE_SETTLE_DELAY_SECONDS)
    # Whatever this pass intended to skip (pending) but didn't actually
    # reach (drained) is still genuinely sitting in the real queue - carry
    # it forward instead of letting take_pending_queue_adds' own reset
    # silently forget it (see that function's own comment).
    database.restore_pending_queue_adds(max(0, pending - drained))
    return drained


def clear_queue_for_device(device_id):
    """Manual entry point for the Settings "Clear queue" button - unlike
    clear_queue itself (normally only called from inside play()/play_uris(),
    which already transfer to device_id first as part of starting a new
    session), this has to do that transfer itself since it isn't part of an
    actual play call - just a standalone maintenance action for whenever
    residue is suspected (or confirmed) outside of starting anything new.
    Returns how many tracks were skipped, or None if Spotify isn't even
    connected."""
    if not is_connected():
        return None
    token = _start_intent(device_id)
    _transfer_to_device(device_id)
    return clear_queue(device_id, token=token)


# How many total clear_queue_for_device rounds clear_queue_for_device_verified
# will try before giving up - a genuine multi-attempt retry (not just the
# single hardcoded extra pass main.py's /play and /switch-device routes used
# to do inline), for when one bounded pass genuinely wasn't enough (see
# clear_queue's own docstring on why a single guess can undercount). Still
# bounded, not unbounded - see the function's own docstring for why more
# rounds can't help against an actively-refilling native context.
CLEAR_QUEUE_VERIFY_MAX_ATTEMPTS = 3


def clear_queue_for_device_verified(device_id, max_attempts=CLEAR_QUEUE_VERIFY_MAX_ATTEMPTS):
    """Repeats clear_queue_for_device, checking via get_queue() after each
    round and stopping as soon as it genuinely reports empty - answers "can
    we make a 2nd (or 3rd) clear attempt" with yes, this is that loop,
    replacing the single hardcoded extra pass /play and /switch-device used
    to do inline.

    Still fundamentally bounded, not a fix for every case: an actively-
    refilling native context (Spotify's own Autoplay, or Liked Songs being
    shuffled directly on the device) never actually reaches empty no matter
    how many rounds run, since there's no fixed backlog to exhaust in the
    first place - see clear_queue's own docstring. This gives up after
    max_attempts rather than chasing a moving target forever.

    Returns (total_drained, fully_cleared) - fully_cleared is only True when
    the last verify genuinely came back empty, so a caller can tell "queue
    may still have residue" apart from "definitely cleared" instead of
    assuming success just because this returned without raising."""
    total_drained = 0
    for attempt in range(1, max_attempts + 1):
        drained = clear_queue_for_device(device_id)
        total_drained += drained or 0
        verify = get_queue()
        if verify is not None and not verify.get('queue'):
            return total_drained, True
        if attempt < max_attempts:
            logger.info(
                "clear_queue_for_device_verified %s: still not empty after attempt %d/%d, retrying",
                device_id, attempt, max_attempts,
            )
    return total_drained, False


def _artist_guard_passes(local_artist, bridged_artist):
    """True if bridged_artist is a plausible match for local_artist - either
    by overall similarity, or because one name is a contiguous run of words
    inside the other. The word-containment check catches a duet/cover where
    both performers got concatenated into one local tag (confirmed live:
    "Arkadi Duchin Vladimir Visotsky" locally vs. the bridge naming just
    "Arkadi Duchin" - clearly the right person, but scores low on straight
    similarity since half the local string doesn't appear in it at all).
    Whole-word containment (not a raw substring check) avoids a short name
    spuriously matching inside an unrelated longer one (e.g. "Ari" inside
    "Mariah") - a genuinely different artist won't share a word run either
    way (confirmed live: "Guy Davidov & Izhar Cohen" vs "Ehud Manor" shares
    nothing and correctly still fails this)."""
    if _similar(local_artist, bridged_artist) >= MATCH_THRESHOLD:
        return True
    local_tokens = _normalize(local_artist).split()
    bridged_tokens = _normalize(bridged_artist).split()
    return _tokens_contained(bridged_tokens, local_tokens) or _tokens_contained(local_tokens, bridged_tokens)


def _release_date_key(item):
    """Sort key that puts the earliest, most-precise release first. A missing
    or year-only date sorts last within its precision tier, since "1965"
    alone is less useful for picking the true original pressing than a
    dated "1965-06-15" would be, but is still better than nothing."""
    release_date = (item.get('album') or {}).get('release_date') or ''
    return release_date if len(release_date) == 10 else release_date + '~'


def _search_and_score(track_name, artist_name):
    """One /search call plus local similarity scoring - the single Spotify
    transaction search_track wraps, extracted so the YouTube Music bridge
    below can reuse it for a second attempt without duplicating the scoring
    logic. Returns ('ok', match_or_None) on a completed search, or
    ('unavailable', None) if the API call itself failed (rate-limited etc).

    The match dict carries Spotify's own title/artist for the matched item
    (as 'track_name'/'artist_name'), not just the uri - callers use this to
    correct the local track's tags to what Spotify actually calls it, which
    can differ from the local tag even on a successful match (capitalization,
    "(Remastered ...)" suffixes, a translated title via the YouTube Music
    bridge below, etc.).

    Checks database.spotify_search_cache first (a general-purpose cache
    independent of known_tracks, which only covers this user's own library)
    and returns straight from it with no budget check or live call at all
    on a hit - this is the one choke point every text search (Radio,
    Discover, both prewarm jobs, interactive matches) already funnels
    through, so caching here covers every source at once. Confirmed live
    this was a real gap: a Radio "fresh discovery" suggestion not in the
    user's library had nowhere to persist its match, so the same track
    coming up again in a later, unrelated session cost a fresh search every
    time. A confirmed no-match gets cached too (same philosophy
    known_tracks.spotify_checked already uses for library tracks)."""
    cache_key = f"{track_name.strip().lower()}|||{artist_name.strip().lower()}"
    cached = database.get_cached_spotify_search(cache_key)
    if cached is not None:
        if not cached['matched']:
            return 'ok', None
        return 'ok', {
            'uri': cached['uri'], 'artwork_url': cached['artwork_url'],
            'track_name': cached['track_name'], 'artist_name': cached['artist_name'],
        }

    if not search_budget_available():
        return 'unavailable', None
    query = f'track:{track_name} artist:{artist_name}'
    # _api_request itself logs this attempt (success or not) and, on a real
    # 429, checks for/learns from a confirmed QUOTA_EXCEEDED reason - see
    # both there.
    data = _api_request('GET', '/search', params={'q': query, 'type': 'track', 'limit': 5})
    if data is None:
        return 'unavailable', None

    items = (data.get('tracks') or {}).get('items') or []
    candidates = []
    for item in items:
        item_artists = ', '.join(a['name'] for a in item.get('artists', []))
        score = (_similar(track_name, item['name']) + _similar(artist_name, item_artists)) / 2
        if score >= MATCH_THRESHOLD:
            candidates.append((item, item_artists))

    if not candidates:
        database.set_cached_spotify_search(cache_key, False, None)
        return 'ok', None

    best, best_artists = min(candidates, key=lambda c: _release_date_key(c[0]))
    album = best.get('album') or {}
    images = album.get('images') or []
    match = {
        'uri': best['uri'],
        'artwork_url': images[0]['url'] if images else None,
        'track_name': best['name'],
        'artist_name': best_artists,
    }
    database.set_cached_spotify_search(cache_key, True, match)
    return 'ok', match


def search_track_direct(track_name, artist_name):
    """Single Spotify /search call, no YouTube Music/Shazam bridging -
    unlike search_track below, which exists specifically to rescue a
    *local library file*'s own tag (which can be garbled, placeholder-only,
    or an English transliteration of a native-script original), a Radio
    candidate's track_name/artist_name comes straight from Last.fm's own
    catalog data - already clean, canonical text with nothing for a bridge
    to plausibly fix. Confirmed live this was a real cost, not theoretical:
    a single miss (Spotify's own direct search finding nothing) fell through
    to the YouTube Music bridge and searched *again* with whatever it
    returned - two real /search calls logged for one candidate that still
    never became a playable track either way. Same ('ok'|'unavailable',
    match_or_None) shape _search_and_score already returns; only playback_advancer.py's
    _match_text_candidate calls this today."""
    return _search_and_score(track_name, artist_name)


# Unauthenticated instance - search-only usage needs no login. Cheap to
# construct (no network/file I/O - confirmed live), so a module-level
# singleton is fine.
_ytmusic = YTMusic()


def _bridge_via_ytmusic(track_name, artist_name):
    """A local track tagged with an English transliteration of a non-Latin
    original (confirmed live: several Hebrew tracks tagged in English never
    matched Spotify's own Hebrew-script titles, even after fixing _normalize
    to be Unicode-aware) will never match via a plain-text Spotify search,
    since the catalog entry's title is in a different script entirely.
    YouTube Music's own search reliably resolves the same English query to
    the native-script title/artist - bridges the gap with no translation API
    key needed. ytmusicapi is unofficial/reverse-engineered (no auth
    required for search, but no stability guarantee either) - any failure
    here is treated as "no bridge available", not a hard error, since this
    is only ever an opportunistic second attempt, never a required step.

    Returns (native_title, native_artist) or None. This is *not* validated
    against the original query - ytmusicapi's top result isn't always the
    right song (confirmed live: one query returned a same-titled cover by a
    completely different artist) - search_track checks the returned artist
    against the original before trusting the title."""
    try:
        results = _ytmusic.search(f'{track_name} {artist_name}', filter='songs')
    except Exception:
        return None
    if not results:
        return None
    top = results[0]
    native_title = top.get('title')
    artists = top.get('artists') or []
    native_artist = artists[0]['name'] if artists else None
    if not native_title or not native_artist:
        return None
    return native_title, native_artist


SHAZAM_RAPIDAPI_KEY = os.environ.get('SHAZAM_RAPIDAPI_KEY')
SHAZAM_RAPIDAPI_HOST = 'shazam-core.p.rapidapi.com'
# The free tier of this RapidAPI-hosted service is genuinely flaky - confirmed
# live: the identical query returned a real result, then a 404 "Object not
# found" seconds later, then real data again on a third try. Not a rate limit
# (no 429, no Retry-After) and not query-content-specific (plain ASCII queries
# hit it too) - just has to be retried through.
SHAZAM_CORE_MAX_ATTEMPTS = 4
SHAZAM_CORE_RETRY_DELAY_SECONDS = 2


def _parse_year(value):
    """Pulls a plausible 4-digit year out of whatever format a source hands
    back - Shazam Core's releaseDate is an ISO-ish "2012-06-08", while
    track_about's "Released" section is often just plain text like "1991".
    Grabs the first 19xx/20xx run rather than requiring a specific format, so
    both shapes (and anything else vaguely date-like) work the same way.
    Returns an int, or None if nothing plausible is found."""
    if not value:
        return None
    match = re.search(r'(19|20)\d{2}', str(value))
    return int(match.group(0)) if match else None


def search_shazam_core(query):
    """Text search against Shazam's own catalog (Apple Music-backed) via the
    Shazam Core RapidAPI listing - a maintained, paid-hosting-backed wrapper,
    not a raw reverse-engineered scrape like the YouTube Music bridge above.
    Confirmed live this finds tracks neither direct Spotify search nor the
    YouTube Music bridge can (e.g. a track whose local tags are a bogus
    placeholder like "Track 09" would never work as a query anyway, but for
    tracks with real - if English-transliterated or slightly-off - tags, this
    catalog has meaningfully broader coverage). Each result already carries
    an ISRC directly, no separate track-detail lookup needed. Not
    underscore-prefixed - external_artwork.find_via_shazam also calls this
    directly (for its artwork_url), rather than duplicating the RapidAPI
    request/retry plumbing in a second place hitting the same account quota.

    Returns a list of {'name', 'artist_name', 'isrc', 'duration_ms',
    'album_name', 'year', 'artwork_url'} dicts (possibly empty; album_name/
    year/artwork_url are None when Shazam Core doesn't have them for a given
    result), or None if not configured / persistently failing."""
    if not SHAZAM_RAPIDAPI_KEY:
        return None
    headers = {'X-RapidAPI-Key': SHAZAM_RAPIDAPI_KEY, 'X-RapidAPI-Host': SHAZAM_RAPIDAPI_HOST}
    for attempt in range(1, SHAZAM_CORE_MAX_ATTEMPTS + 1):
        try:
            response = requests.get(
                f'https://{SHAZAM_RAPIDAPI_HOST}/v1/search/multi',
                headers=headers, params={'search_type': 'SONGS', 'query': query}, timeout=REQUEST_TIMEOUT,
            )
        except Exception:
            response = None
        if response is not None and response.ok:
            items = response.json().get('data') or []
            results = []
            for item in items:
                attrs = item.get('attributes') or {}
                if not attrs.get('name') or not attrs.get('artistName') or not attrs.get('isrc'):
                    continue
                # Apple Music catalog artwork - url is a template with literal
                # "{w}" / "{h}" placeholders the caller has to fill in (same
                # convention as iTunes Search's artworkUrl100 needing its
                # "100x100bb" substring swapped for a bigger size), not a
                # ready-to-download URL as-is.
                artwork_url = (attrs.get('artwork') or {}).get('url')
                if artwork_url:
                    artwork_url = artwork_url.replace('{w}', '600').replace('{h}', '600')
                results.append({
                    'name': attrs['name'], 'artist_name': attrs['artistName'],
                    'isrc': attrs['isrc'], 'duration_ms': attrs.get('durationInMillis'),
                    'album_name': attrs.get('albumName'), 'year': _parse_year(attrs.get('releaseDate')),
                    'artwork_url': artwork_url,
                })
            return results
        if attempt < SHAZAM_CORE_MAX_ATTEMPTS:
            time.sleep(SHAZAM_CORE_RETRY_DELAY_SECONDS)
    return None


def _bridge_via_shazam_core(track_name, artist_name):
    """Searches Shazam's catalog and picks the best-scoring candidate, same
    title+artist averaged-similarity scoring _search_and_score uses - Shazam
    Core can return several same-artist candidates for one query (confirmed
    live: a search for one song returned 4 different tracks by the right
    artist), so picking blindly by rank risks a right-artist-wrong-song match
    the way a pure artist-only guard would.

    Returns the winning candidate dict ({'name', 'artist_name', 'isrc',
    'duration_ms'}), or None. The full candidate is returned (not just the
    ISRC) so callers can persist Shazam's own title/artist even if Spotify
    itself never confirms the match - a correct name and a real ISRC are
    useful on their own, not just as an intermediate Spotify lookup key."""
    results = search_shazam_core(f'{track_name} {artist_name}')
    if not results:
        return None
    scored = []
    for r in results:
        score = (_similar(track_name, r['name']) + _similar(artist_name, r['artist_name'])) / 2
        if score >= MATCH_THRESHOLD:
            scored.append((score, r))
    if not scored:
        return None
    return max(scored, key=lambda s: s[0])[1]


def _search_by_isrc(isrc):
    """Exact Spotify lookup by ISRC - unlike a text search, this can't
    silently pick a wrong-but-similar-looking track, so no similarity
    threshold is applied to the result. Returns ('unavailable', None) if
    blocked/rate-limited (this ISRC genuinely hasn't been checked - caller
    must not treat that as a confirmed absence), or ('ok', match_or_None) -
    match is None if this app's catalog access doesn't have it (confirmed
    live: happens even for an ISRC Shazam correctly reports - not every
    regional recording is available everywhere).

    Shares database.spotify_search_cache with _search_and_score, under an
    'isrc:' prefix so this and a text-search key can never collide - same
    reasoning as there: a confirmed result, hit or miss, never needs a live
    lookup again from any source."""
    cache_key = f"isrc:{isrc}"
    cached = database.get_cached_spotify_search(cache_key)
    if cached is not None:
        if not cached['matched']:
            return 'ok', None
        return 'ok', {
            'uri': cached['uri'], 'artwork_url': cached['artwork_url'],
            'track_name': cached['track_name'], 'artist_name': cached['artist_name'],
        }

    if not search_budget_available():
        return 'unavailable', None
    data = _api_request('GET', '/search', params={'q': f'isrc:{isrc}', 'type': 'track', 'limit': 1})
    if data is None:
        return 'unavailable', None
    items = (data.get('tracks') or {}).get('items') or []
    if not items:
        database.set_cached_spotify_search(cache_key, False, None)
        return 'ok', None
    best = items[0]
    album = best.get('album') or {}
    images = album.get('images') or []
    match = {
        'uri': best['uri'],
        'artwork_url': images[0]['url'] if images else None,
        'track_name': best['name'],
        'artist_name': ', '.join(a['name'] for a in best.get('artists', [])),
    }
    database.set_cached_spotify_search(cache_key, True, match)
    return 'ok', match


SHAZAM_AUDIO_VENV_PYTHON = '/opt/shazam-venv/bin/python3'
SHAZAM_AUDIO_WORKER_PATH = '/app/shazam_worker.py'
SHAZAM_AUDIO_TIMEOUT_SECONDS = 30


def _recognize_via_shazam_audio(file_path):
    """Identifies a local file from its actual audio content via Shazam's
    fingerprint recognition, run in a dedicated subprocess/venv - shazamio
    hard-pins pydantic<2.0, which directly conflicts with FastAPI's
    pydantic>=2.7 requirement in this same app, so it can't be imported
    in-process without breaking every Pydantic-based request/response model
    here. Isolating it in its own venv (see Dockerfile) keeps this app's own
    dependencies untouched.

    Confirmed live this recognizes tracks no text-based method can even
    attempt - a local tag of "Track 09" or a corrupted/garbled title has
    nothing for a text search to work with, but audio recognition doesn't
    need tag text at all. Also confirmed live: real coverage gaps exist even
    for correctly-produced regional content (2 of 10 random Hebrew test
    tracks came back unrecognized), so this is a genuine "maybe," not
    "almost always" - and the most expensive fallback here, since it
    requires actually decoding the audio, not just a text query.

    Returns (title, artist, isrc, album_name, year, artwork_url) - isrc/
    album_name/year are None if the second lookup (shazam_worker.py's
    track_about call, same direct-to-Shazam servers, no RapidAPI) didn't
    succeed or didn't have them; artwork_url comes from the first
    (recognize) call instead, so it's independent of that second lookup's
    success. The whole tuple is None if there's no match at all, no
    worker/venv, or a timeout - treated as opportunistic, same as every
    other bridge above."""
    try:
        result = subprocess.run(
            [SHAZAM_AUDIO_VENV_PYTHON, SHAZAM_AUDIO_WORKER_PATH, file_path],
            capture_output=True, text=True, timeout=SHAZAM_AUDIO_TIMEOUT_SECONDS,
        )
    except Exception:
        return None
    if result.returncode != 0:
        return None
    try:
        data = json.loads(result.stdout)
    except ValueError:
        return None
    title, artist = data.get('title'), data.get('artist')
    if not title or not artist:
        return None
    return title, artist, data.get('isrc'), data.get('album'), _parse_year(data.get('released')), data.get('artwork_url')


def identify_via_shazam(track_name, artist_name, file_path=None):
    """Identifies a track via Shazam alone - text search first, then audio
    recognition as a last resort for files with no usable tag text at all.
    Makes zero Spotify API calls, by construction: every call this function
    reaches (_bridge_via_shazam_core -> search_shazam_core, and
    _recognize_via_shazam_audio) talks to Shazam/RapidAPI only, never
    spotify_connect._api_request. This is what makes it safe to run on its
    own schedule, completely decoupled from Spotify's rate limit and this
    app's idle-detection (which exists purely to avoid the *Spotify-facing*
    background job competing with interactive Spotify use for the same
    quota - see spotify_prewarm.py's is_idle gate. A job that never touches
    Spotify at all can't compete with it, so gating this one the same way
    would just be needless delay).

    The audio-recognition branch prefers the ISRC shazam_worker.py's own
    track_about call already found (talks to Shazam's servers directly, not
    RapidAPI) over re-deriving it through Shazam Core - confirmed live that
    _bridge_via_shazam_core alone can be fully blocked (RapidAPI's free tier
    hit its *monthly* quota from testing this session) while audio
    recognition itself keeps working fine, since it's a separate service
    with its own limits entirely.

    Returns a {'track_name', 'artist_name', 'isrc', 'album_name', 'year',
    'artwork_url'} dict, or None if Shazam has nothing confident to offer
    either way. album_name/year/artwork_url are None when the source that
    identified the track didn't have them - artwork_url in particular is a
    free byproduct of whichever lookup succeeded (Shazam Core's search
    already carries it, and audio recognition's own first call does too),
    never a separate request, so callers can opportunistically save it
    without worrying about extra API cost."""
    shazam_hit = _bridge_via_shazam_core(track_name, artist_name)
    if shazam_hit:
        return {
            'track_name': shazam_hit['name'], 'artist_name': shazam_hit['artist_name'], 'isrc': shazam_hit['isrc'],
            'album_name': shazam_hit.get('album_name'), 'year': shazam_hit.get('year'),
            'artwork_url': shazam_hit.get('artwork_url'),
        }

    if file_path:
        recognized = _recognize_via_shazam_audio(file_path)
        if recognized:
            audio_title, audio_artist, audio_isrc, audio_album, audio_year, audio_artwork_url = recognized
            if audio_isrc:
                return {
                    'track_name': audio_title, 'artist_name': audio_artist, 'isrc': audio_isrc,
                    'album_name': audio_album, 'year': audio_year, 'artwork_url': audio_artwork_url,
                }
            # track_about's own isrc lookup didn't come through for some
            # reason - fall back to resolving it via Shazam Core instead.
            shazam_hit = _bridge_via_shazam_core(audio_title, audio_artist)
            if shazam_hit:
                return {
                    'track_name': shazam_hit['name'], 'artist_name': shazam_hit['artist_name'], 'isrc': shazam_hit['isrc'],
                    'album_name': shazam_hit.get('album_name') or audio_album, 'year': shazam_hit.get('year') or audio_year,
                    'artwork_url': shazam_hit.get('artwork_url') or audio_artwork_url,
                }

    return None


def search_track(track_name, artist_name, file_path=None, known_isrc=None):
    """Best-matching Spotify catalog track for a local (track_name, artist_name)
    pair. Returns a ('ok', match_or_None) tuple when the search actually
    completed (match is None if nothing cleared MATCH_THRESHOLD, even after
    every fallback below), or ('unavailable', None) if the direct API call
    itself failed - e.g. rate-limited, which this app hits hard (a single
    test call got a ~10h Retry-After, another got ~20h). Callers must not
    treat 'unavailable' as a real "no match" answer, since that would
    permanently cache a wrong result for what was really just a transient
    failure - only 'ok' should ever be persisted.

    On a genuine no-match (not a rate-limit), tries progressively more
    expensive fallbacks before giving up: the YouTube Music bridge, then
    Shazam's text-search catalog, then (only if file_path is given) Shazam's
    audio-fingerprint recognition on the actual local file - confirmed live
    these last two catch real cases the first two miss (a badly garbled or
    placeholder-only local tag has nothing for a text search to work with at
    all, but audio recognition doesn't need tag text). Each extra fallback
    costs more (an extra search call, or real audio decoding for the last
    one), so they're only ever tried after the cheaper ones actually miss,
    never stacked on top of an already-rate-limited response.

    Every match (direct or bridged) carries Spotify's own title/artist as
    'track_name'/'artist_name' - see _search_and_score. Callers use this to
    correct the local track's own tags to what Spotify actually calls it,
    not just to cache the Spotify id.

    Returns a third value, identified: a {'track_name', 'artist_name',
    'isrc', 'album_name', 'year'} dict (album_name/year may be None even
    when identified is not, if the source that identified the track didn't
    have them) whenever Shazam (text search or audio recognition)
    confidently identified the track, regardless of whether the Spotify step
    that follows actually found or could even check a match - Spotify's own
    catalog gaps and this app's own rate-limit history (a ~20h lockout, live
    this session) mean a real identification is often the best information
    available even when Spotify never confirms it. None when no Shazam
    fallback ran or none of them found a confident candidate. Callers should
    persist this independently of whatever the Spotify match/result says.

    Crucially, a blocked Spotify search does NOT stop the non-Spotify
    fallbacks (YouTube Music, Shazam) from running - they don't share
    Spotify's rate limit at all, so an identification is still worth finding
    and persisting even while Spotify itself can't be checked right now.
    'unavailable' is only returned at the very end, and only if no match was
    found anywhere AND at least one Spotify-facing call was actually
    blocked - a real "not on Spotify" answer (every Spotify call completed,
    just found nothing) still returns 'ok' so callers can cache it.

    known_isrc: pass known_tracks.isrc when the caller already has one (the
    decoupled shazam_identify job - see identify_via_shazam - may have found
    it independently, on its own schedule, before this function ever ran for
    this row). Skips re-deriving it via Shazam Core/audio recognition and
    goes straight to the Spotify ISRC lookup - avoids redoing already-done
    identification work every time this function retries a row."""
    identified = None
    blocked = False

    result, match = _search_and_score(track_name, artist_name)
    if match:
        return 'ok', match, identified
    blocked = blocked or result == 'unavailable'

    bridged = _bridge_via_ytmusic(track_name, artist_name)
    if bridged:
        native_title, native_artist = bridged
        if _artist_guard_passes(artist_name, native_artist):
            result, match = _search_and_score(native_title, native_artist)
            if match:
                return 'ok', match, identified
            blocked = blocked or result == 'unavailable'

    if known_isrc:
        result, match = _search_by_isrc(known_isrc)
        if match:
            return 'ok', match, identified
        return ('unavailable' if (blocked or result == 'unavailable') else 'ok'), None, identified

    shazam_hit = _bridge_via_shazam_core(track_name, artist_name)
    if shazam_hit:
        identified = {
            'track_name': shazam_hit['name'], 'artist_name': shazam_hit['artist_name'], 'isrc': shazam_hit['isrc'],
            'album_name': shazam_hit.get('album_name'), 'year': shazam_hit.get('year'),
        }
        result, match = _search_by_isrc(shazam_hit['isrc'])
        if match:
            return 'ok', match, identified
        blocked = blocked or result == 'unavailable'

    if file_path and not identified:
        recognized = _recognize_via_shazam_audio(file_path)
        if recognized:
            audio_title, audio_artist, audio_isrc, audio_album, audio_year, _audio_artwork_url = recognized
            # Prefer the ISRC shazam_worker.py's own track_about call already
            # found (direct to Shazam, no RapidAPI) over re-deriving it
            # through Shazam Core - see identify_via_shazam for why this
            # matters (RapidAPI's free tier can be fully exhausted while
            # audio recognition itself keeps working fine).
            if audio_isrc:
                identified = {
                    'track_name': audio_title, 'artist_name': audio_artist, 'isrc': audio_isrc,
                    'album_name': audio_album, 'year': audio_year,
                }
            else:
                shazam_hit = _bridge_via_shazam_core(audio_title, audio_artist)
                if shazam_hit:
                    identified = {
                        'track_name': shazam_hit['name'], 'artist_name': shazam_hit['artist_name'], 'isrc': shazam_hit['isrc'],
                        'album_name': shazam_hit.get('album_name') or audio_album, 'year': shazam_hit.get('year') or audio_year,
                    }
            if identified:
                result, match = _search_by_isrc(identified['isrc'])
                if match:
                    return 'ok', match, identified
                blocked = blocked or result == 'unavailable'

    return ('unavailable' if blocked else 'ok'), None, identified
