import base64
import json
import logging
import os
import re
import secrets
import subprocess
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


def list_devices():
    data = _api_request('GET', '/me/player/devices')
    if data is None:
        return []
    return [{'id': d['id'], 'name': d['name']} for d in data.get('devices', [])]


def get_device(device_id):
    for device in list_devices():
        if device['id'] == device_id:
            return device
    return None


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


def play(device_id, context_uri, track_uri=None):
    _transfer_to_device(device_id)
    body = {'context_uri': context_uri}
    if track_uri:
        body['offset'] = {'uri': track_uri}
    result = _api_request('PUT', '/me/player/play', params={'device_id': device_id}, json_body=body)
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


def play_uris(device_id, uris):
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
    no one to notice and press play again."""
    for attempt in range(1, PLAY_URIS_MAX_ATTEMPTS + 1):
        _transfer_to_device(device_id)
        result = _api_request('PUT', '/me/player/play', params={'device_id': device_id}, json_body={'uris': uris})
        if result is None:
            logger.warning("play_uris %s: attempt %d/%d - request failed", device_id, attempt, PLAY_URIS_MAX_ATTEMPTS)
            continue
        time.sleep(PLAY_URIS_CONFIRM_DELAY_SECONDS)
        confirm_status = get_status(device_id)
        if confirm_status and confirm_status.get('status') == 'play':
            if attempt > 1:
                logger.info("play_uris %s: confirmed playing on attempt %d/%d", device_id, attempt, PLAY_URIS_MAX_ATTEMPTS)
            return True
        logger.warning(
            "play_uris %s: attempt %d/%d loaded but didn't start (status=%r)",
            device_id, attempt, PLAY_URIS_MAX_ATTEMPTS, confirm_status and confirm_status.get('status'),
        )
    return False


def add_to_queue(device_id, uri):
    """Appends a single track to the end of the currently active playback
    queue, without interrupting what's already playing - used to feed one
    lookahead match at a time instead of front-loading a whole batch."""
    result = _api_request('POST', '/me/player/queue', params={'uri': uri, 'device_id': device_id})
    return result is not None


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


def _search_shazam_core(query):
    """Text search against Shazam's own catalog (Apple Music-backed) via the
    Shazam Core RapidAPI listing - a maintained, paid-hosting-backed wrapper,
    not a raw reverse-engineered scrape like the YouTube Music bridge above.
    Confirmed live this finds tracks neither direct Spotify search nor the
    YouTube Music bridge can (e.g. a track whose local tags are a bogus
    placeholder like "Track 09" would never work as a query anyway, but for
    tracks with real - if English-transliterated or slightly-off - tags, this
    catalog has meaningfully broader coverage). Each result already carries
    an ISRC directly, no separate track-detail lookup needed.

    Returns a list of {'name', 'artist_name', 'isrc', 'duration_ms'} dicts
    (possibly empty), or None if not configured / persistently failing."""
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
                results.append({
                    'name': attrs['name'], 'artist_name': attrs['artistName'],
                    'isrc': attrs['isrc'], 'duration_ms': attrs.get('durationInMillis'),
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
    results = _search_shazam_core(f'{track_name} {artist_name}')
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

    Returns (title, artist, isrc) - isrc is None if the second lookup
    (shazam_worker.py's track_about call, same direct-to-Shazam servers, no
    RapidAPI) didn't succeed for some reason, or None entirely (no match, no
    worker/venv, or timeout - treated as opportunistic, same as every other
    bridge above)."""
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
    return title, artist, data.get('isrc')


def identify_via_shazam(track_name, artist_name, file_path=None):
    """Identifies a track via Shazam alone - text search first, then audio
    recognition as a last resort for files with no usable tag text at all.
    Makes zero Spotify API calls, by construction: every call this function
    reaches (_bridge_via_shazam_core -> _search_shazam_core, and
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

    Returns a {'track_name', 'artist_name', 'isrc'} dict, or None if Shazam
    has nothing confident to offer either way."""
    shazam_hit = _bridge_via_shazam_core(track_name, artist_name)
    if shazam_hit:
        return {'track_name': shazam_hit['name'], 'artist_name': shazam_hit['artist_name'], 'isrc': shazam_hit['isrc']}

    if file_path:
        recognized = _recognize_via_shazam_audio(file_path)
        if recognized:
            audio_title, audio_artist, audio_isrc = recognized
            if audio_isrc:
                return {'track_name': audio_title, 'artist_name': audio_artist, 'isrc': audio_isrc}
            # track_about's own isrc lookup didn't come through for some
            # reason - fall back to resolving it via Shazam Core instead.
            shazam_hit = _bridge_via_shazam_core(audio_title, audio_artist)
            if shazam_hit:
                return {'track_name': shazam_hit['name'], 'artist_name': shazam_hit['artist_name'], 'isrc': shazam_hit['isrc']}

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
    'isrc'} dict whenever Shazam (text search or audio recognition)
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
        identified = {'track_name': shazam_hit['name'], 'artist_name': shazam_hit['artist_name'], 'isrc': shazam_hit['isrc']}
        result, match = _search_by_isrc(shazam_hit['isrc'])
        if match:
            return 'ok', match, identified
        blocked = blocked or result == 'unavailable'

    if file_path and not identified:
        recognized = _recognize_via_shazam_audio(file_path)
        if recognized:
            audio_title, audio_artist, audio_isrc = recognized
            # Prefer the ISRC shazam_worker.py's own track_about call already
            # found (direct to Shazam, no RapidAPI) over re-deriving it
            # through Shazam Core - see identify_via_shazam for why this
            # matters (RapidAPI's free tier can be fully exhausted while
            # audio recognition itself keeps working fine).
            if audio_isrc:
                identified = {'track_name': audio_title, 'artist_name': audio_artist, 'isrc': audio_isrc}
            else:
                shazam_hit = _bridge_via_shazam_core(audio_title, audio_artist)
                if shazam_hit:
                    identified = {'track_name': shazam_hit['name'], 'artist_name': shazam_hit['artist_name'], 'isrc': shazam_hit['isrc']}
            if identified:
                result, match = _search_by_isrc(identified['isrc'])
                if match:
                    return 'ok', match, identified
                blocked = blocked or result == 'unavailable'

    return ('unavailable' if blocked else 'ok'), None, identified
