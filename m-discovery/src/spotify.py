import base64
import os
import re
import time
from difflib import SequenceMatcher

import requests

SPOTIFY_CLIENT_ID = os.environ.get('SPOTIFY_CLIENT_ID')
SPOTIFY_CLIENT_SECRET = os.environ.get('SPOTIFY_CLIENT_SECRET')
TOKEN_URL = 'https://accounts.spotify.com/api/token'
API_BASE_URL = 'https://api.spotify.com/v1'
REQUEST_TIMEOUT = 10

# How close a search result's own title/artist must be to what we searched for
# before we trust it as a real match, rather than an unrelated track that
# happened to rank first (common for generic titles like "Intro" or "Home").
MATCH_THRESHOLD = 0.72

_token_cache = {'access_token': None, 'expires_at': 0}


def _normalize(text):
    if not text:
        return ''
    return re.sub(r'[^a-z0-9]+', ' ', text.lower()).strip()


def _similar(a, b):
    a, b = _normalize(a), _normalize(b)
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def is_configured():
    return bool(SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET)


def _get_access_token():
    """Client Credentials flow: app-level catalog access, no user login. Token
    is cached in-process and refreshed a minute before it actually expires
    (normally after 1 hour)."""
    if not is_configured():
        return None
    if _token_cache['access_token'] and time.time() < _token_cache['expires_at']:
        return _token_cache['access_token']

    auth = base64.b64encode(f"{SPOTIFY_CLIENT_ID}:{SPOTIFY_CLIENT_SECRET}".encode()).decode()
    try:
        response = requests.post(
            TOKEN_URL,
            headers={'Authorization': f'Basic {auth}'},
            data={'grant_type': 'client_credentials'},
            timeout=REQUEST_TIMEOUT,
        )
        response.raise_for_status()
        data = response.json()
    except Exception:
        return None

    _token_cache['access_token'] = data['access_token']
    _token_cache['expires_at'] = time.time() + data['expires_in'] - 60
    return _token_cache['access_token']


# A short Retry-After is a normal, transient per-second burst limit - worth
# one short sleep-and-retry. A newly-registered app was observed getting
# handed a ~24-HOUR Retry-After after a few minutes of unthrottled requests,
# which is a hard block, not a "try again in a moment" signal - sleeping for
# that (or even our old 30s cap, repeated once per remaining track) would
# either hang the whole background job for a day or silently burn through
# the rest of the library misreporting every track as "no match". Anything
# past this threshold aborts the run instead via RateLimited.
SHORT_RETRY_THRESHOLD_SECONDS = 10


class RateLimited(Exception):
    def __init__(self, retry_after_seconds):
        self.retry_after_seconds = retry_after_seconds
        super().__init__(f"Spotify API rate-limited us for {retry_after_seconds}s")


def _retry_after_seconds(response):
    try:
        return int(response.headers.get('Retry-After', 2))
    except ValueError:
        return 2


def _api_get(path, params, retried=False):
    token = _get_access_token()
    if not token:
        return None
    try:
        response = requests.get(
            f"{API_BASE_URL}{path}",
            headers={'Authorization': f'Bearer {token}'},
            params=params,
            timeout=REQUEST_TIMEOUT,
        )
    except Exception:
        return None
    if response.status_code == 429:
        wait = _retry_after_seconds(response)
        if wait > SHORT_RETRY_THRESHOLD_SECONDS:
            raise RateLimited(wait)
        if not retried:
            time.sleep(wait)
            return _api_get(path, params, retried=True)
        raise RateLimited(wait)
    if response.status_code != 200:
        return None
    return response.json()


def _release_date_key(item):
    """Sort key that puts the earliest, most-precise release first. A missing
    or year-only date sorts last within its precision tier, since "1965"
    alone is less useful for picking the true original pressing than a
    dated "1965-06-15\" would be, but is still better than nothing."""
    release_date = (item.get('album') or {}).get('release_date') or ''
    return release_date if len(release_date) == 10 else release_date + '~'


def search_track(track_name, artist_name):
    """Best-matching Spotify track for a local (track_name, artist_name) pair,
    or None if nothing close enough was found. Spotify's own relevance
    ranking usually puts the right *song* first, but very often as whatever
    edition is most streamed today - a reissue or greatest-hits compilation,
    not the original album - which would poison a "year" backfill with the
    reissue's date. Among the candidates that match well enough (checked
    against both title and artist similarity, not taken on faith), the
    earliest release is preferred as the best proxy for the true original."""
    query = f'track:{track_name} artist:{artist_name}'
    data = _api_get('/search', {'q': query, 'type': 'track', 'limit': 5})
    if not data:
        return None
    items = (data.get('tracks') or {}).get('items') or []

    candidates = []
    for item in items:
        item_artists = ', '.join(a['name'] for a in item.get('artists', []))
        score = (_similar(track_name, item['name']) + _similar(artist_name, item_artists)) / 2
        if score >= MATCH_THRESHOLD:
            candidates.append(item)

    if not candidates:
        return None
    return min(candidates, key=_release_date_key)


ENRICH_COMMIT_EVERY = 50
SEARCH_PACING_SECONDS = 0.2


def enrich_library_from_spotify(get_connection, progress):
    """Backfill year (only where the local tag left it blank - embedded tags
    always win over Spotify's opinion) plus its own track/artwork URLs for
    every track not yet checked. Runs on a background thread since a full
    library means thousands of network calls. spotify_checked is set for
    every track whether or not a match was found, so a match-less track
    (e.g. a bootleg with no Spotify equivalent) isn't re-searched on every
    subsequent run - only tracks added since the last run (spotify_checked
    defaults to FALSE) get picked up.

    Genre and popularity are deliberately NOT fetched: as of Spotify's
    November 2024 API policy change, both are blanked out (empty/null) for
    any app without "extended quota mode" approval, which a newly-registered
    app doesn't have - so genre/artist lookups would just be wasted network
    calls with no data to show for it. spotify_popularity stays NULL for
    now; the column exists in case that access is ever granted later.
    """
    progress.update(status='running', processed=0, total=0, matched=0, unmatched=0, error=None)

    if not is_configured():
        progress.update(status='error', error='SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET not set in .env')
        return

    conn = get_connection()
    if conn is None:
        progress.update(status='error', error='Could not connect to the database')
        return

    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT id, track_name, artist_name, year FROM known_tracks
            WHERE spotify_checked IS NOT TRUE
        """)
        rows = cur.fetchall()
        cur.close()
        progress['total'] = len(rows)

        cur = conn.cursor()
        for track_id, track_name, artist_name, existing_year in rows:
            match = search_track(track_name, artist_name)
            if match:
                album = match.get('album') or {}
                images = album.get('images') or []
                release_date = album.get('release_date') or ''

                new_year = existing_year
                if not existing_year and release_date[:4].isdigit():
                    new_year = int(release_date[:4])

                cur.execute("""
                    UPDATE known_tracks SET
                        spotify_track_id = %s, spotify_url = %s,
                        spotify_album_art_url = %s, spotify_checked = TRUE,
                        year = %s
                    WHERE id = %s
                """, (
                    match.get('id'), (match.get('external_urls') or {}).get('spotify'),
                    images[0]['url'] if images else None, new_year, track_id,
                ))
                progress['matched'] += 1
            else:
                cur.execute("UPDATE known_tracks SET spotify_checked = TRUE WHERE id = %s", (track_id,))
                progress['unmatched'] += 1

            progress['processed'] += 1
            if progress['processed'] % ENRICH_COMMIT_EVERY == 0:
                conn.commit()
            # A newly-registered app has a much tighter rate-limit ceiling
            # than an established one (observed firsthand: a ~24h block after
            # a few minutes of back-to-back requests) - pace requests instead
            # of firing them as fast as the network allows.
            time.sleep(SEARCH_PACING_SECONDS)

        conn.commit()
        cur.close()
        progress['status'] = 'done'
    except RateLimited as e:
        conn.commit()  # keep whatever was already processed this run
        hours = round(e.retry_after_seconds / 3600, 1)
        progress.update(
            status='error',
            error=f"Spotify rate-limited us (retry in ~{hours}h) - stopped after {progress['processed']} of {progress['total']}. Already-processed tracks are saved; re-running later will pick up where this left off.",
        )
    except Exception as e:
        conn.rollback()
        progress.update(status='error', error=str(e))
    finally:
        conn.close()
