import base64
import json
import logging
import os
import re
import secrets
import subprocess
import threading
import time
from difflib import SequenceMatcher
from urllib.parse import quote

import requests
from ytmusicapi import YTMusic

from . import database

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


# Set whenever /search comes back 429'd, to the real (uncapped) Retry-After -
# confirmed live this can be ~56 minutes, not the few seconds the quick retry
# below waits. _search_and_score checks this before making a call at all, so
# a caller stuck retrying the same still-blocked candidate every poll tick
# (see playback_advancer._advance_spotify) doesn't re-hit the API - and
# re-poking Spotify during its own penalty window is a real risk of making
# the block worse, not just wasted effort.
_search_blocked_until = 0.0


def _api_request(method, path, params=None, json_body=None, retried=False):
    global _search_blocked_until
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

    if response.status_code == 429:
        retry_after = int(response.headers.get('Retry-After', 1))
        if path == '/search':
            _search_blocked_until = time.time() + retry_after
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
    token = _start_intent(device_id)
    if drain_queue:
        # Must transfer first - clear_queue's GET /me/player/queue and the
        # `next` calls it drains with both act on whatever device is
        # *currently* active account-wide, not device_id, unless this device
        # is already it (same reason play/play_uris always transfer before
        # playing - see _transfer_to_device).
        _transfer_to_device(device_id)
        clear_queue(device_id)
    if not _is_current_intent(device_id, token):
        logger.info("play %s: superseded by a newer call, bailing out", device_id)
        return False
    _transfer_to_device(device_id)
    body = {'context_uri': context_uri}
    if track_uri:
        body['offset'] = {'uri': track_uri}
    result = _api_request('PUT', '/me/player/play', params={'device_id': device_id}, json_body=body)
    _device_last_outcome[device_id] = 'ok' if result is not None else 'failed'
    return result is not None


def pause(device_id):
    result = _api_request('PUT', '/me/player/pause', params={'device_id': device_id})
    return result is not None


def resume(device_id):
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
    a resume, requiring a fresh play_uris call to recover."""
    current = get_status(device_id)
    if current and current.get('track_uri') and current.get('position_ms') is not None:
        _transfer_to_device(device_id)
        result = _api_request('PUT', '/me/player/play', params={'device_id': device_id}, json_body={
            'uris': [current['track_uri']],
            'position_ms': current['position_ms'],
        })
        return result is not None
    result = _api_request('PUT', '/me/player/play', params={'device_id': device_id})
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


def next_track(device_id):
    result = _api_request('POST', '/me/player/next', params={'device_id': device_id})
    return result is not None


def previous_track(device_id):
    result = _api_request('POST', '/me/player/previous', params={'device_id': device_id})
    return result is not None


def get_status(device_id):
    data = _api_request('GET', '/me/player')
    if data is None:
        return None
    if not data:
        return {
            'reachable': True, 'status': 'stop', 'position_ms': None, 'duration_ms': None,
            'volume': None, 'track_uri': None, 'title': None, 'artist': None, 'album': None,
            'artwork_url': None,
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
        tracks.append({
            'uri': t['uri'],
            'name': t['name'],
            'artists': ', '.join(a['name'] for a in t.get('artists', [])),
            'album': album.get('name'),
            'duration_ms': t.get('duration_ms'),
            'artwork_url': images[0]['url'] if images else None,
        })
    return tracks


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


PLAY_URIS_MAX_ATTEMPTS = 3
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


def play_uris(device_id, uris, drain_queue=False):
    """Play an explicit ad-hoc list of Spotify track URIs (not a playlist
    context) - used for local-library tracks matched to their Spotify catalog
    equivalent, since there's no existing Spotify playlist backing them.

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

    Bails out early (returns False, sends no further requests) if superseded
    by a newer play()/play_uris() call for the same device - see
    _start_intent. Confirmed live this matters: switching the output device
    (which re-casts whatever was already nowPlaying) landing at nearly the
    same moment as a fresh Shuffle All match finishing fired two concurrent
    play_uris calls for the same device; without this guard, the older
    call's retry loop kept fighting the newer one for the device's state and
    could win the last word, leaving the previous (wrong) track playing."""
    token = _start_intent(device_id)
    if drain_queue:
        # Must transfer first - see the matching comment in play().
        _transfer_to_device(device_id)
        clear_queue(device_id)
    for attempt in range(1, PLAY_URIS_MAX_ATTEMPTS + 1):
        if not _is_current_intent(device_id, token):
            logger.info("play_uris %s: superseded by a newer call before attempt %d, bailing out", device_id, attempt)
            return False
        _transfer_to_device(device_id)
        result = _api_request('PUT', '/me/player/play', params={'device_id': device_id}, json_body={'uris': uris})
        if result is None:
            logger.warning("play_uris %s: attempt %d/%d - request failed", device_id, attempt, PLAY_URIS_MAX_ATTEMPTS)
            continue
        time.sleep(PLAY_URIS_CONFIRM_DELAY_SECONDS)
        if not _is_current_intent(device_id, token):
            logger.info("play_uris %s: superseded by a newer call after attempt %d's play, bailing out", device_id, attempt)
            return False
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
            unstick = _api_request('PUT', '/me/player/play', params={'device_id': device_id}, json_body={
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


def add_to_queue(device_id, uri):
    """Appends a single track to the end of the currently active playback
    queue, without interrupting what's already playing - used to feed one
    lookahead match at a time instead of front-loading a whole batch."""
    result = _api_request('POST', '/me/player/queue', params={'uri': uri, 'device_id': device_id})
    return result is not None


CLEAR_QUEUE_MAX_DRAIN = 20


def clear_queue(device_id, max_drain=CLEAR_QUEUE_MAX_DRAIN):
    """Spotify's Web API has no endpoint to remove a track from the queue -
    once something lands there it can only be consumed by skipping past it.
    A manually-queued track (via add_to_queue above - this app's own
    lookahead buffer, or anything queued from another Spotify client)
    survives a later play()/play_uris() call untouched, confirmed live: it
    gets spliced in after whatever that call starts, and surfaces later as
    an unexplained jump to unrelated older music. GET /me/player/queue's
    `queue` array mixes those in with the *current* context's own upcoming
    tracks (no way to tell them apart), so this only drains up to
    max_drain items rather than the whole thing - enough to clear the
    handful of orphaned single-track entries this app's own lookahead can
    leave behind (at most one at a time, per session), without turning into
    a slow walk through an entire playlist's remaining tracks if the prior
    session was a context (e.g. a Spotify-owned playlist) with a long queue.

    Called via play()/play_uris()'s drain_queue=True, itself only passed for
    a genuinely new ad-hoc session (a fresh track/Shuffle All/Play All click,
    switching the destination to Spotify, or restoring a session on Play) -
    not for in-session Next/Prev or the near-end lookahead handoff
    (playback_advancer._advance_spotify), which intentionally rely on the
    single lookahead track add_to_queue just placed there. Best-effort: any
    failure just leaves the residue for next time rather than blocking
    playback.

    Caller must already have transferred to device_id (see play()/play_uris())
    before calling this - GET /me/player/queue and the `next` calls this
    drains with both act on whatever device is *currently* active
    account-wide, not necessarily device_id, so calling this against a device
    that isn't already active drains (or reads) the wrong device's queue."""
    data = _api_request('GET', '/me/player/queue')
    if not data:
        return
    pending = len(data.get('queue') or [])
    for _ in range(min(pending, max_drain)):
        if not next_track(device_id):
            break


# How close a search result's own title/artist must be to what we searched for
# before we trust it as a real match, rather than an unrelated track that
# happened to rank first (common for generic titles like "Intro" or "Home").
MATCH_THRESHOLD = 0.72


def _normalize(text):
    # [^a-z0-9]+ used to strip *any* non-ASCII character - not just
    # punctuation, but every Hebrew/Cyrillic/CJK/accented-Latin letter too,
    # collapsing e.g. a Hebrew title to an empty string. _similar() then
    # short-circuits to 0.0 whenever either side is empty, so two identical
    # Hebrew titles compared against each other still scored zero (confirmed
    # live). \w is Unicode-aware by default in Python 3's re module, so this
    # keeps letters from any script while still stripping real punctuation.
    if not text:
        return ''
    return re.sub(r'[^\w]+', ' ', text.lower()).strip()


def _similar(a, b):
    a, b = _normalize(a), _normalize(b)
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def _tokens_contained(needle_tokens, haystack_tokens):
    if not needle_tokens or not haystack_tokens or len(needle_tokens) > len(haystack_tokens):
        return False
    span = len(needle_tokens)
    return any(
        haystack_tokens[i:i + span] == needle_tokens
        for i in range(len(haystack_tokens) - span + 1)
    )


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
    bridge below, etc.)."""
    if time.time() < _search_blocked_until:
        return 'unavailable', None
    query = f'track:{track_name} artist:{artist_name}'
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
        return 'ok', None

    best, best_artists = min(candidates, key=lambda c: _release_date_key(c[0]))
    album = best.get('album') or {}
    images = album.get('images') or []
    return 'ok', {
        'uri': best['uri'],
        'artwork_url': images[0]['url'] if images else None,
        'track_name': best['name'],
        'artist_name': best_artists,
    }


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
    regional recording is available everywhere)."""
    if time.time() < _search_blocked_until:
        return 'unavailable', None
    data = _api_request('GET', '/search', params={'q': f'isrc:{isrc}', 'type': 'track', 'limit': 1})
    if data is None:
        return 'unavailable', None
    items = (data.get('tracks') or {}).get('items') or []
    if not items:
        return 'ok', None
    best = items[0]
    album = best.get('album') or {}
    images = album.get('images') or []
    return 'ok', {
        'uri': best['uri'],
        'artwork_url': images[0]['url'] if images else None,
        'track_name': best['name'],
        'artist_name': ', '.join(a['name'] for a in best.get('artists', [])),
    }


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
