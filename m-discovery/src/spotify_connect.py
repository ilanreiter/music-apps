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
