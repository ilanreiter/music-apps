import io
import json
import os
import re
import time
from urllib.parse import quote

import requests
from PIL import Image

AUDIODB_API_KEY = os.environ.get('AUDIODB_API_KEY', '123')
AUDIODB_BASE_URL = f"https://www.theaudiodb.com/api/v1/json/{AUDIODB_API_KEY}"
WIKIPEDIA_SUMMARY_URL = "https://en.wikipedia.org/api/rest_v1/page/summary"
WIKIPEDIA_USER_AGENT = "m-discovery/1.0 (personal self-hosted music library app)"
ARTIST_CACHE_DIR = os.environ.get('ARTIST_CACHE_DIR', '/app/artist_cache')
PHOTO_SIZE = (400, 400)
REQUEST_TIMEOUT = 8


def _slug(artist_name):
    return re.sub(r'[^a-z0-9]+', '-', artist_name.lower()).strip('-') or 'unknown'


def _fetch_from_audiodb(artist_name):
    """Returns a result dict, or None if the artist wasn't found (so the caller can
    fall back to another source) or the request failed outright."""
    try:
        response = requests.get(f"{AUDIODB_BASE_URL}/search.php", params={'s': artist_name}, timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
        data = response.json()
    except Exception:
        return None

    artists = data.get('artists') or []
    if not artists:
        return None

    a = artists[0]
    return {
        'found': True,
        'source': 'audiodb',
        'name': a.get('strArtist'),
        'biography': a.get('strBiography'),
        'genre': a.get('strGenre'),
        'style': a.get('strStyle'),
        'country': a.get('strCountry'),
        'formed_year': a.get('intFormedYear'),
        'website': a.get('strWebsite'),
        'thumb_source_url': a.get('strArtistThumb'),
    }


MAX_RETRY_WAIT_SECONDS = 15


def _get_with_retry(url, headers, retried=False):
    """GET with one retry on 429, honoring the server's Retry-After header when
    present. Wikimedia's REST API and its Commons image CDN (separate hosts, both
    observed hitting this) rate-limit fairly aggressively for bursts of lookups
    (e.g. shuffling into several new artists at once); a single retry smooths that
    over without hammering a sustained block."""
    try:
        response = requests.get(url, headers=headers, timeout=REQUEST_TIMEOUT)
    except Exception:
        return None
    if response.status_code == 429 and not retried:
        try:
            wait = min(int(response.headers.get('Retry-After', 2)), MAX_RETRY_WAIT_SECONDS)
        except ValueError:
            wait = 2
        time.sleep(wait)
        return _get_with_retry(url, headers, retried=True)
    if response.status_code != 200:
        return None
    return response


def _get_wikipedia_summary(title, headers):
    response = _get_with_retry(f"{WIKIPEDIA_SUMMARY_URL}/{quote(title)}", headers)
    return response.json() if response else None


def _fetch_from_wikipedia(artist_name):
    """TheAudioDB's catalog skews heavily English/Western and misses most non-English
    or regional artists. Wikipedia has far broader coverage, but a bare artist name
    occasionally collides with an unrelated or disambiguation page (e.g. "Kiss",
    "Genesis", "Yes" are all common words) - the bare name is tried first since it
    resolves correctly for the vast majority of artists, with band/musician-qualified
    titles as fallbacks only when that first lookup 404s or lands on a disambiguation
    page (rejected via its "type" field).
    """
    headers = {'User-Agent': WIKIPEDIA_USER_AGENT}
    candidates = [
        artist_name,
        f"{artist_name} (band)",
        f"{artist_name} (musician)",
        f"{artist_name} (singer)",
    ]
    for title in candidates:
        data = _get_wikipedia_summary(title, headers)
        if data is None or data.get('type') != 'standard':
            continue
        return {
            'found': True,
            'source': 'wikipedia',
            'name': artist_name,
            'biography': data.get('extract'),
            'genre': None,
            'style': None,
            'country': None,
            'formed_year': None,
            'website': None,
            'thumb_source_url': (data.get('thumbnail') or {}).get('source'),
        }
    return None


def get_artist_info(artist_name):
    """Return cached or freshly-fetched artist bio/details, trying TheAudioDB first
    and falling back to Wikipedia for the (very common) case of artists it doesn't
    cover. Caches to disk indefinitely, including "not found" results, since both
    are public APIs with rate limits - repeat lookups for the same artist should
    never hit the network again. Returns None only when both sources failed
    outright (network error), which is deliberately left uncached so a transient
    error doesn't permanently blank out an artist.
    """
    os.makedirs(ARTIST_CACHE_DIR, exist_ok=True)
    cache_path = os.path.join(ARTIST_CACHE_DIR, f"{_slug(artist_name)}.json")

    if os.path.exists(cache_path):
        with open(cache_path) as f:
            return json.load(f)

    result = _fetch_from_audiodb(artist_name) or _fetch_from_wikipedia(artist_name) or {'found': False}

    with open(cache_path, 'w') as f:
        json.dump(result, f)
    return result


def get_artist_photo_path(artist_name):
    """Return a local cached image path for the artist's photo, downloading and
    downscaling it on first request. Returns None if unavailable."""
    info = get_artist_info(artist_name)
    if not info or not info.get('found') or not info.get('thumb_source_url'):
        return None

    os.makedirs(ARTIST_CACHE_DIR, exist_ok=True)
    photo_path = os.path.join(ARTIST_CACHE_DIR, f"{_slug(artist_name)}.jpg")
    if os.path.exists(photo_path):
        return photo_path

    response = _get_with_retry(info['thumb_source_url'], {'User-Agent': WIKIPEDIA_USER_AGENT})
    if response is None:
        return None

    try:
        image = Image.open(io.BytesIO(response.content)).convert('RGB')
        image.thumbnail(PHOTO_SIZE)
        image.save(photo_path, format='JPEG', quality=85)
    except Exception:
        return None

    return photo_path
