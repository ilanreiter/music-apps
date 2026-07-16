import re
import time
from difflib import SequenceMatcher

import requests

from .artwork import cache_key_for, normalize_album_name, normalized_album_sql, save_thumbnail

REQUEST_TIMEOUT = 10

# MusicBrainz requires a descriptive User-Agent identifying the app (their
# usage policy blocks generic/browser-like ones) and a hard 1 request/second
# limit - Cover Art Archive itself (a separate service, hosted by the
# Internet Archive) isn't subject to that same limit, only the MB search call is.
MUSICBRAINZ_SEARCH_URL = 'https://musicbrainz.org/ws/2/release/'
MUSICBRAINZ_USER_AGENT = "m-discovery/1.0 (personal self-hosted music library app)"
MUSICBRAINZ_MIN_INTERVAL_SECONDS = 1.1
MUSICBRAINZ_SCORE_THRESHOLD = 90  # MB's own 0-100 search relevance score

COVER_ART_ARCHIVE_URL = 'https://coverartarchive.org/release'

ITUNES_SEARCH_URL = 'https://itunes.apple.com/search'
MATCH_THRESHOLD = 0.72

_last_musicbrainz_call = 0.0


class RateLimited(Exception):
    def __init__(self, retry_after_seconds):
        self.retry_after_seconds = retry_after_seconds
        super().__init__(f"Rate-limited for {retry_after_seconds}s")


def _normalize(text):
    if not text:
        return ''
    return re.sub(r'[^a-z0-9]+', ' ', text.lower()).strip()


def _similar(a, b):
    a, b = _normalize(a), _normalize(b)
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def download_bytes(url):
    if not url:
        return None
    try:
        response = requests.get(url, timeout=REQUEST_TIMEOUT, headers={'User-Agent': MUSICBRAINZ_USER_AGENT})
    except Exception:
        return None
    if response.status_code != 200:
        return None
    return response.content


def _throttle_musicbrainz():
    global _last_musicbrainz_call
    elapsed = time.time() - _last_musicbrainz_call
    if elapsed < MUSICBRAINZ_MIN_INTERVAL_SECONDS:
        time.sleep(MUSICBRAINZ_MIN_INTERVAL_SECONDS - elapsed)
    _last_musicbrainz_call = time.time()


def _escape_lucene(text):
    # MusicBrainz's search query is Lucene syntax - text containing quotes
    # would otherwise break out of the quoted phrase we wrap it in.
    return text.replace('"', '')


def search_musicbrainz_release_mbid(artist_name, album_name):
    """Best-matching MusicBrainz release id for (artist_name, album_name),
    or None. Relies on MusicBrainz's own search relevance score rather than
    a separate similarity check, since that's exactly what it's designed to
    rank on for this query shape."""
    _throttle_musicbrainz()
    query = f'release:"{_escape_lucene(album_name)}" AND artist:"{_escape_lucene(artist_name)}"'
    try:
        response = requests.get(
            MUSICBRAINZ_SEARCH_URL,
            params={'query': query, 'fmt': 'json', 'limit': 3},
            headers={'User-Agent': MUSICBRAINZ_USER_AGENT},
            timeout=REQUEST_TIMEOUT,
        )
    except Exception:
        return None
    if response.status_code == 503:
        raise RateLimited(10)
    if response.status_code != 200:
        return None
    releases = response.json().get('releases') or []
    if not releases:
        return None
    best = releases[0]
    if (best.get('score') or 0) < MUSICBRAINZ_SCORE_THRESHOLD:
        return None
    return best.get('id')


def fetch_cover_art_archive_image(mbid):
    return download_bytes(f"{COVER_ART_ARCHIVE_URL}/{mbid}/front-500")


def search_itunes_artwork_url(artist_name, album_name):
    """Best-matching iTunes album artwork URL for (artist_name, album_name),
    upscaled from the default 100x100 thumbnail, or None."""
    try:
        response = requests.get(
            ITUNES_SEARCH_URL,
            params={'term': f'{artist_name} {album_name}', 'media': 'music', 'entity': 'album', 'limit': 3},
            timeout=REQUEST_TIMEOUT,
        )
    except Exception:
        return None
    if response.status_code in (403, 429):
        raise RateLimited(30)
    if response.status_code != 200:
        return None

    best, best_score = None, 0.0
    for result in response.json().get('results') or []:
        score = (_similar(album_name, result.get('collectionName', '')) + _similar(artist_name, result.get('artistName', ''))) / 2
        if score > best_score:
            best, best_score = result, score
    if best is None or best_score < MATCH_THRESHOLD:
        return None
    art_url = best.get('artworkUrl100')
    return art_url.replace('100x100bb', '600x600bb') if art_url else None


SEARCH_PACING_SECONDS = 0.5


def backfill_external_artwork(get_connection, progress):
    """For tracks with no artwork found locally (has_artwork = FALSE, set by
    the Check Artwork job), tries free external sources in order: this
    track's own already-stored Spotify album art URL (from Spotify Enrich,
    if that ran - free, no extra lookup needed), then MusicBrainz + Cover Art
    Archive, then the iTunes Search API. A hit is downloaded and cached under
    the same album-shared cache_key used everywhere else, so every track
    sharing that album picks it up too - not just the one row processed
    here (mirrors check_artwork_presence's own sibling backfill).

    Processes one row at a time so a real rate limit (raised as RateLimited)
    can pause the whole run and resume automatically once it clears, same
    approach as the Spotify enrich job - MusicBrainz in particular really
    will reject requests outright if its 1/sec limit is violated.
    """
    progress.update(status='running', processed=0, total=0, found=0, still_missing=0, error=None, resume_at=None)

    conn = get_connection()
    if conn is None:
        progress.update(status='error', error='Could not connect to the database')
        return

    try:
        cur = conn.cursor()
        cur.execute(f"""
            SELECT COUNT(DISTINCT (artist_name, COALESCE({normalized_album_sql('album_name')}, 'id:' || id::text)))
            FROM known_tracks WHERE has_artwork = FALSE AND external_artwork_checked IS NOT TRUE
        """)
        progress['total'] = cur.fetchone()[0]
        cur.close()

        while True:
            cur = conn.cursor()
            cur.execute("""
                SELECT id, artist_name, album_name, spotify_album_art_url FROM known_tracks
                WHERE has_artwork = FALSE AND external_artwork_checked IS NOT TRUE
                LIMIT 1
            """)
            row = cur.fetchone()
            cur.close()
            if row is None:
                break

            track_id, artist_name, album_name, spotify_art_url = row
            try:
                raw = download_bytes(spotify_art_url)
                if not raw and album_name:
                    mbid = search_musicbrainz_release_mbid(artist_name, album_name)
                    if mbid:
                        raw = fetch_cover_art_archive_image(mbid)
                if not raw:
                    art_url = search_itunes_artwork_url(artist_name, album_name or '')
                    raw = download_bytes(art_url)
            except RateLimited as e:
                resume_at = time.time() + e.retry_after_seconds
                progress.update(status='waiting', resume_at=resume_at)
                time.sleep(e.retry_after_seconds + 5)
                progress.update(status='running', resume_at=None)
                continue

            found = bool(raw and save_thumbnail(cache_key_for(track_id, artist_name, album_name), raw))

            # WHERE ... has_artwork = FALSE restricts this to rows that were
            # actually part of the "still missing" set this job targets -
            # every matched row is a definite FALSE already, so setting it to
            # `found` directly is unambiguous (no NULL/never-checked rows
            # get touched or reinterpreted here).
            cur = conn.cursor()
            if album_name:
                cur.execute(f"""
                    UPDATE known_tracks SET external_artwork_checked = TRUE, has_artwork = %(found)s
                    WHERE artist_name = %(artist)s AND {normalized_album_sql()} = %(normalized_album)s
                      AND has_artwork = FALSE
                """, {'found': found, 'artist': artist_name, 'normalized_album': normalize_album_name(album_name)})
            else:
                cur.execute(
                    "UPDATE known_tracks SET external_artwork_checked = TRUE, has_artwork = %s "
                    "WHERE id = %s AND has_artwork = FALSE",
                    (found, track_id),
                )
            conn.commit()
            cur.close()

            progress['found' if found else 'still_missing'] += 1
            progress['processed'] += 1
            time.sleep(SEARCH_PACING_SECONDS)

        progress['status'] = 'done'
    except Exception as e:
        conn.rollback()
        progress.update(status='error', error=str(e))
    finally:
        conn.close()
