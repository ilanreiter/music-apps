import base64
import os
import re
import secrets
import time
from difflib import SequenceMatcher
from urllib.parse import quote

import requests

from . import database

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
# the user's own playlists - nothing that touches library modification.
SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private playlist-read-collaborative'

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

    if response.status_code == 429 and not retried:
        wait = min(int(response.headers.get('Retry-After', 1)), RATE_LIMIT_RETRY_CAP_SECONDS)
        time.sleep(wait)
        return _api_request(method, path, params=params, json_body=json_body, retried=True)

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


def play_uris(device_id, uris):
    """Play an explicit ad-hoc list of Spotify track URIs (not a playlist
    context) - used for local-library tracks matched to their Spotify catalog
    equivalent, since there's no existing Spotify playlist backing them."""
    _transfer_to_device(device_id)
    result = _api_request('PUT', '/me/player/play', params={'device_id': device_id}, json_body={'uris': uris})
    return result is not None


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
    if not text:
        return ''
    return re.sub(r'[^a-z0-9]+', ' ', text.lower()).strip()


def _similar(a, b):
    a, b = _normalize(a), _normalize(b)
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def _release_date_key(item):
    """Sort key that puts the earliest, most-precise release first. A missing
    or year-only date sorts last within its precision tier, since "1965"
    alone is less useful for picking the true original pressing than a
    dated "1965-06-15" would be, but is still better than nothing."""
    release_date = (item.get('album') or {}).get('release_date') or ''
    return release_date if len(release_date) == 10 else release_date + '~'


def search_track(track_name, artist_name):
    """Best-matching Spotify catalog track for a local (track_name, artist_name)
    pair. Returns a ('ok', match_or_None) tuple when the search actually
    completed (match is None if nothing cleared MATCH_THRESHOLD), or
    ('unavailable', None) if the API call itself failed - e.g. rate-limited,
    which this app hits hard (a single test call got a ~10h Retry-After).
    Callers must not treat 'unavailable' as a real "no match" answer, since
    that would permanently cache a wrong result for what was really just a
    transient failure - only 'ok' should ever be persisted."""
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
            candidates.append(item)

    if not candidates:
        return 'ok', None

    best = min(candidates, key=_release_date_key)
    album = best.get('album') or {}
    images = album.get('images') or []
    return 'ok', {'uri': best['uri'], 'artwork_url': images[0]['url'] if images else None}
