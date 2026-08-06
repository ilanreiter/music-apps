import os
import re
import time

import requests
from ytmusicapi.auth.oauth import OAuthCredentials

from . import database
from .text_match import MATCH_THRESHOLD, _component_score

YTMUSIC_OAUTH_CLIENT_ID = os.environ.get('YTMUSIC_OAUTH_CLIENT_ID')
YTMUSIC_OAUTH_CLIENT_SECRET = os.environ.get('YTMUSIC_OAUTH_CLIENT_SECRET')


def is_configured():
    return bool(YTMUSIC_OAUTH_CLIENT_ID and YTMUSIC_OAUTH_CLIENT_SECRET)


_credentials = None


def _get_credentials():
    # Cheap to construct (just wraps the client id/secret + a requests
    # Session), module-level singleton same as spotify_connect's own
    # module-level state.
    global _credentials
    if _credentials is None:
        _credentials = OAuthCredentials(client_id=YTMUSIC_OAUTH_CLIENT_ID, client_secret=YTMUSIC_OAUTH_CLIENT_SECRET)
    return _credentials


# Device-code flow pending state - single in-memory slot, same
# single-user-tool justification as spotify_connect._pending_state. Google's
# own device_code is itself the secret here (nothing else needs guarding).
_pending_device = {'device_code': None, 'expires_at': 0.0}


def start_auth():
    """Kicks off Google's device-code flow: stashes the device_code server-side
    and returns {verification_url, user_code} for the frontend to show the
    user - they complete the login on any browser/device, this app never
    handles their Google credentials directly."""
    code = _get_credentials().get_code()
    _pending_device['device_code'] = code['device_code']
    _pending_device['expires_at'] = time.time() + code['expires_in']
    return {'verification_url': code['verification_url'], 'user_code': code['user_code']}


def poll_auth():
    """Attempts the token exchange once. Google's device-flow token endpoint
    doesn't raise an HTTP error while the user hasn't finished authorizing yet
    - it responds 400 with {"error": "authorization_pending"} (or "slow_down"),
    and ytmusicapi's OAuthCredentials._send_request only raises for a 401
    (client misconfiguration), so token_from_code returns that error dict
    as-is rather than throwing. Returns 'connected', 'pending', or 'expired'.
    Raises BadOAuthClient/UnauthorizedOAuthClient if the client id/secret
    themselves are wrong - a real setup error, not a "still waiting" state."""
    device_code = _pending_device['device_code']
    if not device_code or time.time() > _pending_device['expires_at']:
        _pending_device['device_code'] = None
        return 'expired'

    raw = _get_credentials().token_from_code(device_code)
    if 'access_token' not in raw:
        error = raw.get('error')
        if error in ('authorization_pending', 'slow_down'):
            return 'pending'
        _pending_device['device_code'] = None
        return 'expired'

    _pending_device['device_code'] = None
    expires_at = int(time.time()) + raw['expires_in']
    database.save_ytmusic_tokens(
        access_token=raw['access_token'], refresh_token=raw.get('refresh_token'),
        expires_at=expires_at, scope=raw.get('scope'),
    )
    return 'connected'


def is_connected():
    return database.get_ytmusic_tokens() is not None


def disconnect():
    database.clear_ytmusic_tokens()


def _get_valid_token():
    """Mirrors spotify_connect._get_valid_access_token - checks expiry
    ourselves and refreshes explicitly via Google's plain OAuth2 refresh
    endpoint (through OAuthCredentials.refresh_token, generic device-flow
    mechanics unrelated to the InnerTube-blocking issue below), persisting
    the result back to Postgres each time rather than leaving it to expire
    silently."""
    tokens = database.get_ytmusic_tokens()
    if not tokens:
        return None
    if tokens['expires_at'] and time.time() < tokens['expires_at'] - 60:
        return tokens

    raw = _get_credentials().refresh_token(tokens['refresh_token'])
    if 'access_token' not in raw:
        return None
    expires_at = int(time.time()) + raw['expires_in']
    # Google's device-flow refresh doesn't rotate the refresh_token itself -
    # save_ytmusic_tokens keeps the existing one on disk when this is None.
    database.save_ytmusic_tokens(access_token=raw['access_token'], refresh_token=None, expires_at=expires_at, scope=raw.get('scope'))
    return {
        'access_token': raw['access_token'], 'refresh_token': tokens['refresh_token'],
        'expires_at': expires_at, 'scope': raw.get('scope'),
    }


# Real, public, officially-documented YouTube Data API v3 - deliberately NOT
# ytmusicapi's YTMusic client, which talks to YouTube Music's private/internal
# "InnerTube" web API instead. Google has been actively fingerprinting and
# blocking third-party OAuth traffic against that private API since ~August
# 2025 (github.com/sigma67/ytmusicapi#813, open/unresolved as of this
# writing) - the public Data API v3 isn't affected by any of that, since it's
# the same stable surface real integrations have always used. Confirmed live
# (2026-07-27): a playlist created here shows up correctly in the real
# YouTube Music app's own Library, with proper album art and artist
# attribution, not just on youtube.com - Google unified the two apps'
# playlist storage some time ago.
DATA_API_BASE_URL = 'https://www.googleapis.com/youtube/v3'
REQUEST_TIMEOUT = 10

# YouTube's own "Music" video category - narrows /search away from the huge
# amount of non-music content on regular YouTube (vlogs, reactions, etc.)
# that a plain keyword search would otherwise surface, since this endpoint
# searches the whole public video corpus rather than a curated music catalog
# the way ytmusicapi's InnerTube-based search did.
MUSIC_CATEGORY_ID = '10'


def _api_request(method, path, token, params=None, json_body=None, retried=False):
    try:
        response = requests.request(
            method, f'{DATA_API_BASE_URL}{path}',
            headers={'Authorization': f'Bearer {token}'},
            params=params, json=json_body, timeout=REQUEST_TIMEOUT,
        )
    except Exception:
        return None
    if response.status_code == 409 and not retried:
        # Confirmed live: playlistItems.insert can come back 409 ABORTED /
        # SERVICE_UNAVAILABLE on a perfectly valid video/playlist - transient
        # on Google's end, not a real per-video restriction (retrying the
        # identical request immediately after succeeded). One retry, same
        # spirit as spotify_connect._api_request's single 429 retry.
        return _api_request(method, path, token, params=params, json_body=json_body, retried=True)
    if not response.ok:
        return None
    if not response.content:
        return {}
    try:
        return response.json()
    except ValueError:
        return {}


# Confirmed live: the /search endpoint specifically has its own much
# stricter sub-quota than the general 10,000-unit daily project budget -
# "Search Queries per day" defaults to just 100 requests/day, entirely
# separate from and enforced independently of the unit-based budget
# ytmusic_push_job.py's DAILY_SAFE_BUDGET reserves against. Confirmed
# rejected as HTTP 429 (not 403) with body
# {"error": {"status": "RESOURCE_EXHAUSTED", "errors": [{"reason":
# "rateLimitExceeded", ...}], ...}} - both the status code and the reason
# string differ from the general quotaExceeded/dailyLimitExceeded 403 case
# handled below, and were originally missed entirely, which silently
# mis-cached dozens of genuinely-findable tracks as permanent non-matches
# once this sub-quota ran out mid-job.
_QUOTA_EXCEEDED_REASONS = {'quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded'}
_QUOTA_EXCEEDED_STATUSES = {'RESOURCE_EXHAUSTED'}


def _fetch_search_candidates(token, track_name, artist_name):
    """Returns ('unavailable', None) on a network failure or a 403/429 whose
    body identifies quota exhaustion (YouTube's equivalent of Spotify's 429)
    - callers must NOT treat this as a confirmed miss, same rule
    spotify_connect.search_track's 'unavailable' result enforces. Returns
    ('ok', items) otherwise - items is [] on any other non-OK response or a
    genuinely empty search, which IS safe to treat as "searched fine, found
    nothing" (a 400 from a malformed query, say, isn't quota-shaped and
    shouldn't stall a caller retrying it forever)."""
    try:
        response = requests.get(
            f'{DATA_API_BASE_URL}/search',
            headers={'Authorization': f'Bearer {token}'},
            params={'part': 'snippet', 'q': f'{track_name} {artist_name}',
                    'type': 'video', 'videoCategoryId': MUSIC_CATEGORY_ID, 'maxResults': 5},
            timeout=REQUEST_TIMEOUT,
        )
    except Exception:
        return 'unavailable', None
    if response.status_code in (403, 429):
        try:
            body = response.json().get('error', {})
            reasons = {e.get('reason') for e in body.get('errors', [])}
            statuses = {body.get('status')}
        except ValueError:
            reasons, statuses = set(), set()
        if (reasons & _QUOTA_EXCEEDED_REASONS) or (statuses & _QUOTA_EXCEEDED_STATUSES):
            return 'unavailable', None
    if not response.ok:
        return 'ok', []
    try:
        return 'ok', response.json().get('items', [])
    except ValueError:
        return 'ok', []


def _score_candidates(items, track_name, artist_name):
    """Best-matching videoId among search result items, or None if nothing
    clears MATCH_THRESHOLD. Uses _component_score (containment-first,
    falling back to fuzzy ratio) rather than a plain whole-string ratio -
    confirmed live this matters: a real YouTube result titled "Queen -
    Bohemian Rhapsody (Official Video Remastered)" scores only ~0.5 against
    a bare "Bohemian Rhapsody" on ratio alone (all that extra marketing text
    in the title tanks it), even though the query is unambiguously present.
    A channel ending in " - Topic" is YouTube's own auto-generated
    official-audio channel for a real release (confirmed live to be exactly
    what rendered correctly in YouTube Music) - given a small score nudge
    over any other channel that otherwise ties on title/artist similarity."""
    best_video_id, best_score = None, 0.0
    for item in items:
        snippet = item.get('snippet') or {}
        video_id = (item.get('id') or {}).get('videoId')
        title = snippet.get('title')
        channel = snippet.get('channelTitle') or ''
        if not video_id or not title or not channel:
            continue
        is_topic_channel = channel.endswith(' - Topic')
        channel_artist = channel[:-len(' - Topic')] if is_topic_channel else channel
        score = (_component_score(track_name, title) + _component_score(artist_name, channel_artist)) / 2
        if is_topic_channel:
            score += 0.05
        if score >= MATCH_THRESHOLD and score > best_score:
            best_video_id, best_score = video_id, score
    return best_video_id


def _search_video_id(token, track_name, artist_name):
    """Best-matching videoId for a (track_name, artist_name) pair, or None if
    nothing matched or the search failed - used by the interactive push path
    below, which doesn't need to distinguish "no match" from "search
    failed" (skipping either way is fine for a one-shot push). The
    background push job needs that distinction, hence
    find_video_id_with_availability below instead."""
    status, items = _fetch_search_candidates(token, track_name, artist_name)
    if status == 'unavailable':
        return None  # items is None here - confirmed live this crashed _score_candidates before this check existed
    return _score_candidates(items, track_name, artist_name)


def find_video_id_with_availability(track_name, artist_name):
    """Public entry point for the paced background push job
    (ytmusic_push_job.py) - unlike _search_video_id, distinguishes a
    completed search (possibly a genuine miss, safe to cache) from a
    quota-exhausted/network failure (must NOT be cached as a miss). Manages
    its own token. Returns ('unavailable', None) or ('ok', video_id_or_None)."""
    tokens = _get_valid_token()
    if not tokens:
        return 'unavailable', None
    status, items = _fetch_search_candidates(tokens['access_token'], track_name, artist_name)
    if status == 'unavailable':
        return 'unavailable', None
    return 'ok', _score_candidates(items, track_name, artist_name)


def _create_playlist(token, name):
    """Returns a new private playlist's id, or None on failure. 50 quota units."""
    playlist = _api_request('POST', '/playlists', token, params={'part': 'snippet,status'}, json_body={
        'snippet': {'title': name, 'description': ''},
        'status': {'privacyStatus': 'private'},
    })
    if not playlist or not playlist.get('id'):
        return None
    return playlist['id']


def _add_video_to_playlist(token, playlist_id, video_id):
    """Adds one video to an existing playlist - True/False. 50 quota units.
    playlistItems.insert only accepts one video per call (unlike
    ytmusicapi's InnerTube-based add_playlist_items, which took a batch -
    confirmed live, no batch parameter exists on this endpoint), which is
    exactly why a large push has to be spread across many separate calls
    (see ytmusic_push_job.py) rather than done in one request."""
    result = _api_request('POST', '/playlistItems', token, params={'part': 'snippet'}, json_body={
        'snippet': {'playlistId': playlist_id, 'resourceId': {'kind': 'youtube#video', 'videoId': video_id}},
    })
    return result is not None


def ensure_playlist(name, existing_playlist_id):
    """For ytmusic_push_job.py, which spreads a push across many separate
    calls/days: returns ('ok', playlist_id) - either existing_playlist_id
    unchanged (no quota spent) if already created on an earlier iteration, or
    a freshly created one (50 units) if not. Returns ('unavailable', None) if
    there's no valid token right now - same convention as
    find_video_id_with_availability, callers must retry later rather than
    treat this as a permanent failure."""
    tokens = _get_valid_token()
    if not tokens:
        return 'unavailable', None
    if existing_playlist_id:
        return 'ok', existing_playlist_id
    playlist_id = _create_playlist(tokens['access_token'], name)
    if not playlist_id:
        return 'unavailable', None
    return 'ok', playlist_id


def add_video_to_playlist(playlist_id, video_id):
    """Public, token-managing wrapper around _add_video_to_playlist, for
    ytmusic_push_job.py - True/False, or None if there's no valid token
    right now (treat like 'unavailable' - retry later, not a real per-video
    failure)."""
    tokens = _get_valid_token()
    if not tokens:
        return None
    return _add_video_to_playlist(tokens['access_token'], playlist_id, video_id)


def create_playlist_and_push(name, tracks):
    """tracks: iterable of dicts with track_name/artist_name (and optional
    native_track_name/native_artist_name, same shape as the Spotify
    from-discovered route) - pure text, no pre-existing catalog ids. Returns
    {'playlist_url', 'added', 'skipped'}, or None if not connected or the
    playlist itself couldn't be created (caller surfaces that as an error,
    same convention as _create_spotify_playlist_from_uris). A partial add
    failure (playlist created, some inserts fail) still returns a result -
    added/skipped reflect exactly what landed, same as the Spotify route's
    partial-failure handling.

    Synchronous, one-shot - only appropriate for small pushes that fit
    comfortably in a single request's worth of quota (see
    YTMUSIC_LIBRARY_PUSH_LIMIT in main.py, and Discover's own <=30-track
    cap). A push too large for that goes through ytmusic_push_job.py
    instead, which paces search+insert across multiple days and can append
    to an already-created playlist."""
    tokens = _get_valid_token()
    if not tokens:
        return None
    token = tokens['access_token']

    video_ids = []
    for track in tracks:
        video_id = None
        if track.get('native_track_name') and track.get('native_artist_name'):
            video_id = _search_video_id(token, track['native_track_name'], track['native_artist_name'])
        if not video_id:
            video_id = _search_video_id(token, track['track_name'], track['artist_name'])
        if video_id:
            video_ids.append(video_id)
    skipped = len(tracks) - len(video_ids)

    # De-duplicate (keeping order) - two different local tracks landing on
    # the same top match is a real possibility (e.g. both matching the same
    # canonical studio recording), and there's no reason to add the same
    # video twice.
    seen = set()
    unique_video_ids = [v for v in video_ids if not (v in seen or seen.add(v))]

    if not unique_video_ids:
        return {'playlist_url': None, 'added': 0, 'skipped': skipped}

    playlist_id = _create_playlist(token, name)
    if not playlist_id:
        return None

    added = sum(1 for video_id in unique_video_ids if _add_video_to_playlist(token, playlist_id, video_id))

    return {
        # music.youtube.com (not www.youtube.com) - same playlist object
        # either way (both APIs sit on the same YouTube Data API playlist),
        # but opening the plain youtube.com link puts it in the regular
        # YouTube web/app player instead of YouTube Music.
        'playlist_url': f'https://music.youtube.com/playlist?list={playlist_id}',
        'added': added,
        'skipped': len(tracks) - added,
    }


def _paginate(path, params, token):
    """YouTube Data API v3 pages via a pageToken param (not a full 'next'
    URL the way Spotify's does) - reused by list_playlists/get_playlist_tracks
    below. Both underlying calls (playlists.list, playlistItems.list) cost
    just 1 quota unit each, unlike the 100/50-unit search/insert calls the
    push feature has to ration carefully - no budget concern here even for a
    playlist with hundreds of tracks."""
    items = []
    page_token = None
    while True:
        request_params = dict(params)
        if page_token:
            request_params['pageToken'] = page_token
        data = _api_request('GET', path, token, params=request_params)
        if not data:
            break
        items.extend(data.get('items', []))
        page_token = data.get('nextPageToken')
        if not page_token:
            break
    return items


def list_playlists():
    """The connected account's own YouTube playlists (includes ones this app
    itself created via create_playlist_and_push/the paced push queue) -
    mirrors spotify_connect.list_playlists's return shape."""
    tokens = _get_valid_token()
    if not tokens:
        return None
    raw = _paginate('/playlists', {'part': 'snippet,contentDetails', 'mine': 'true', 'maxResults': 50}, tokens['access_token'])
    playlists = []
    for p in raw:
        snippet = p.get('snippet') or {}
        thumbnails = snippet.get('thumbnails') or {}
        thumbnail = thumbnails.get('medium') or thumbnails.get('default') or {}
        playlists.append({
            'id': p['id'],
            'name': snippet.get('title'),
            'track_count': (p.get('contentDetails') or {}).get('itemCount', 0),
            'artwork_url': thumbnail.get('url'),
        })
    return playlists


def get_playlist_tracks(playlist_id):
    """List of track dicts for a playlist the connected account owns, or
    None if not connected. Unlike Spotify, there's no "can't read a playlist
    you don't own" restriction here - playlistItems.list on your own
    playlist has no such gate, so (unlike spotify_connect.get_playlist_tracks)
    this never needs to return None to signal a blocked read."""
    tokens = _get_valid_token()
    if not tokens:
        return None
    raw = _paginate(
        '/playlistItems',
        {'part': 'snippet,contentDetails', 'playlistId': playlist_id, 'maxResults': 50},
        tokens['access_token'],
    )
    tracks = []
    for entry in raw:
        snippet = entry.get('snippet') or {}
        video_id = (snippet.get('resourceId') or {}).get('videoId')
        title = snippet.get('title')
        # A deleted/private video still occupies a position but has nothing
        # playable - confirmed live this is NOT always an empty title as the
        # `not title` check below assumes: YouTube returns the literal string
        # "Private video"/"Deleted video" as snippet.title for these, which
        # is truthy. Caught this because it was polluting the Playlists tab's
        # "All Tracks" cache (296 of ~5,257 tracks on this account) and would
        # have wasted that many pointless Spotify searches on titles with no
        # artist to match against.
        if not video_id or not title or title in ('Private video', 'Deleted video'):
            continue
        # snippet.channelTitle is the *playlist's own owner* (this account),
        # not the video's channel - confirmed live this is a real gotcha.
        # videoOwnerChannelTitle is the video's actual channel, which for a
        # real release is normally the "<Artist> - Topic" auto-generated
        # channel - same suffix-stripping _score_candidates already applies
        # when scoring search results.
        channel = snippet.get('videoOwnerChannelTitle') or ''
        artist_name = channel[:-len(' - Topic')] if channel.endswith(' - Topic') else (channel or None)
        thumbnails = snippet.get('thumbnails') or {}
        thumbnail = thumbnails.get('medium') or thumbnails.get('default') or {}
        tracks.append({
            'video_id': video_id,
            'track_name': title,
            'artist_name': artist_name,
            'artwork_url': thumbnail.get('url'),
        })
    return tracks


_ISO8601_DURATION_RE = re.compile(r'^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$')


def _iso8601_duration_to_ms(duration):
    """YouTube's contentDetails.duration is ISO 8601 ('PT3M45S') - there's no
    stdlib parser for this, and pulling in a dependency for one regex isn't
    worth it."""
    if not duration:
        return None
    match = _ISO8601_DURATION_RE.match(duration)
    if not match:
        return None
    hours, minutes, seconds = (int(g) if g else 0 for g in match.groups())
    return ((hours * 3600) + (minutes * 60) + seconds) * 1000


def get_video_durations(video_ids):
    """Batched duration lookup - videos.list accepts up to 50 ids per call
    (same 1-unit-per-call cost as any other list operation), so this costs
    one request per ~50 unique videos rather than one per track. Returns
    {video_id: duration_ms}."""
    tokens = _get_valid_token()
    if not tokens:
        return {}
    durations = {}
    unique_ids = list(dict.fromkeys(video_ids))
    for i in range(0, len(unique_ids), 50):
        batch = unique_ids[i:i + 50]
        data = _api_request(
            'GET', '/videos',
            tokens['access_token'], params={'part': 'contentDetails', 'id': ','.join(batch)},
        )
        if not data:
            continue
        for item in data.get('items') or []:
            video_id = item.get('id')
            duration = (item.get('contentDetails') or {}).get('duration')
            if video_id:
                durations[video_id] = _iso8601_duration_to_ms(duration)
    return durations


def get_all_playlist_tracks():
    """Every track across every playlist, deduped by video_id (the same video
    in two playlists is genuinely the same track, not two rows) - backs the
    Playlists tab's "All Tracks" mode. No 403-style restriction to skip here
    (see get_playlist_tracks), so no skipped count - kept in the return shape
    anyway for a uniform contract with spotify_connect.get_all_playlist_tracks.
    Enriched with duration (batched lookup) - YouTube's public Data API has
    no genre or ISRC for either platform to backfill, so those stay None;
    album likewise doesn't exist for a YT Music playlist item at all."""
    seen = {}
    for p in list_playlists() or []:
        tracks = get_playlist_tracks(p['id']) or []
        for t in tracks:
            if t['video_id'] not in seen:
                seen[t['video_id']] = t
    unique_tracks = list(seen.values())
    durations = get_video_durations([t['video_id'] for t in unique_tracks])
    return [{
        'track_id': t['video_id'],
        'track_name': t['track_name'],
        'artist_name': t['artist_name'],
        'album': None,
        'artwork_url': t['artwork_url'],
        'isrc': None,
        'duration_ms': durations.get(t['video_id']),
        'popularity': None,
        'explicit': None,
        'release_date': None,
        'genre': None,
    } for t in unique_tracks], 0
