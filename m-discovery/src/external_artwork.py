import os
import re
import time
from difflib import SequenceMatcher

import requests

from . import spotify_connect
from .artist_info import AUDIODB_BASE_URL
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

# Discogs' structured search (separate artist/release_title params, rather
# than free text) already does relevant-result filtering server-side, so
# unlike the other sources a full similarity-ratio check isn't needed - just
# a substring sanity check on the combined "Artist - Title" result string.
# 60 req/min for authenticated (token) requests per their docs.
DISCOGS_SEARCH_URL = 'https://api.discogs.com/database/search'
DISCOGS_TOKEN = os.environ.get('DISCOGS_TOKEN')
DISCOGS_MIN_INTERVAL_SECONDS = 1.05

ITUNES_SEARCH_URL = 'https://itunes.apple.com/search'
MATCH_THRESHOLD = 0.72

DEEZER_SEARCH_URL = 'https://api.deezer.com/search/album'
DEEZER_ALBUM_URL = 'https://api.deezer.com/album'
DEEZER_TRACK_SEARCH_URL = 'https://api.deezer.com/search'

# TheAudioDB's free-tier key ("123" unless a real one is set) is shared by
# everyone using it and capped around 30 req/min - a dedicated throttle here
# keeps this job from being what finally pushes it over that shared limit
# (the artist-info bio/photo lookups also use this same key).
AUDIODB_MIN_INTERVAL_SECONDS = 2.1

_last_musicbrainz_call = 0.0
_last_audiodb_call = 0.0
_last_discogs_call = 0.0


def is_discogs_configured():
    return bool(DISCOGS_TOKEN)


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


def _year_from(value):
    """Pulls a plausible 4-digit year out of a date-ish value (int, "1969",
    "1969-09-26", "1969-09-26T07:00:00Z", ...), or None."""
    if not value:
        return None
    digits = str(value)[:4]
    return int(digits) if digits.isdigit() else None


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


def find_via_musicbrainz(artist_name, album_name):
    """{'raw', 'year', 'source_url'} for the best-matching MusicBrainz
    release + Cover Art Archive image, or None. Among releases meeting
    MusicBrainz's own relevance score, prefers the earliest dated one as
    the best proxy for the true original release, same reasoning as the
    Spotify/Discogs candidate selection below - a reissue can score just as
    well as the original pressing."""
    _throttle_musicbrainz()
    query = f'release:"{_escape_lucene(album_name)}" AND artist:"{_escape_lucene(artist_name)}"'
    try:
        response = requests.get(
            MUSICBRAINZ_SEARCH_URL,
            params={'query': query, 'fmt': 'json', 'limit': 5},
            headers={'User-Agent': MUSICBRAINZ_USER_AGENT},
            timeout=REQUEST_TIMEOUT,
        )
    except Exception:
        return None
    if response.status_code == 503:
        raise RateLimited(10)
    if response.status_code != 200:
        return None

    candidates = [r for r in (response.json().get('releases') or []) if (r.get('score') or 0) >= MUSICBRAINZ_SCORE_THRESHOLD]
    candidates.sort(key=lambda r: _year_from(r.get('date')) or 9999)
    for release in candidates:
        mbid = release.get('id')
        if not mbid:
            continue
        raw = download_bytes(f"{COVER_ART_ARCHIVE_URL}/{mbid}/front-500")
        if raw:
            return {'raw': raw, 'year': _year_from(release.get('date')), 'source_url': f'https://musicbrainz.org/release/{mbid}'}
    return None


def _throttle_discogs():
    global _last_discogs_call
    elapsed = time.time() - _last_discogs_call
    if elapsed < DISCOGS_MIN_INTERVAL_SECONDS:
        time.sleep(DISCOGS_MIN_INTERVAL_SECONDS - elapsed)
    _last_discogs_call = time.time()


def find_via_discogs(artist_name, album_name):
    """{'raw', 'year', 'source_url'} via Discogs, or None. Particularly
    strong for vinyl/regional releases (e.g. Israeli/Hebrew pressings) that
    the more mainstream-Western-catalog sources tend to miss - tried early
    in the fallback chain for that reason.

    Uses a combined free-text query rather than Discogs' structured
    artist=/release_title= fields - those need a near-exact match against
    how Discogs indexes the artist name and returned nothing for the large
    majority of a real test batch (including well-documented artists), while
    free text against the same catalog reliably found them. Among title
    matches, prefers the earliest-dated pressing - Discogs' top hit for
    "Abbey Road" was a 2016 reissue, not the 1969 original."""
    if not DISCOGS_TOKEN:
        return None
    _throttle_discogs()
    try:
        response = requests.get(
            DISCOGS_SEARCH_URL,
            params={
                'q': f'{artist_name} {album_name}', 'type': 'release',
                'token': DISCOGS_TOKEN, 'per_page': 10,
            },
            headers={'User-Agent': MUSICBRAINZ_USER_AGENT},
            timeout=REQUEST_TIMEOUT,
        )
    except Exception:
        return None
    if response.status_code == 429:
        raise RateLimited(60)
    if response.status_code != 200:
        return None

    normalized_album = _normalize(album_name)
    candidates = [
        r for r in (response.json().get('results') or [])
        if normalized_album and normalized_album in _normalize(r.get('title', ''))
    ]
    candidates.sort(key=lambda r: _year_from(r.get('year')) or 9999)
    for result in candidates:
        raw = download_bytes(result.get('cover_image') or result.get('thumb'))
        if raw:
            uri = result.get('uri')
            return {
                'raw': raw,
                'year': _year_from(result.get('year')),
                'source_url': f'https://www.discogs.com{uri}' if uri else None,
            }
    return None


def find_via_itunes(artist_name, album_name):
    """{'raw', 'year', 'source_url'} via the iTunes Search API, or None."""
    try:
        response = requests.get(
            ITUNES_SEARCH_URL,
            params={'term': f'{artist_name} {album_name}', 'media': 'music', 'entity': 'album', 'limit': 5},
            timeout=REQUEST_TIMEOUT,
        )
    except Exception:
        return None
    if response.status_code in (403, 429):
        raise RateLimited(30)
    if response.status_code != 200:
        return None

    candidates = []
    for result in response.json().get('results') or []:
        score = (_similar(album_name, result.get('collectionName', '')) + _similar(artist_name, result.get('artistName', ''))) / 2
        if score >= MATCH_THRESHOLD:
            candidates.append(result)
    candidates.sort(key=lambda r: _year_from(r.get('releaseDate')) or 9999)

    for result in candidates:
        art_url = result.get('artworkUrl100')
        raw = download_bytes(art_url.replace('100x100bb', '600x600bb') if art_url else None)
        if raw:
            return {
                'raw': raw,
                'year': _year_from(result.get('releaseDate')),
                'source_url': result.get('collectionViewUrl'),
            }
    return None


def find_via_deezer(artist_name, album_name):
    """{'raw', 'year', 'source_url'} via Deezer, or None. Deezer signals its
    rate limit with an HTTP 200 whose JSON body is an error object (code 4,
    "Quota limit exceeded"), not an HTTP error status - checked explicitly.
    release_date isn't in the search response, only the full album lookup -
    fetched only for the single best-scored match, not every candidate, to
    avoid an extra API call per candidate."""
    try:
        response = requests.get(
            DEEZER_SEARCH_URL,
            params={'q': f'artist:"{artist_name}" album:"{album_name}"', 'limit': 3},
            timeout=REQUEST_TIMEOUT,
        )
    except Exception:
        return None
    if response.status_code != 200:
        return None
    data = response.json()
    if isinstance(data, dict) and data.get('error'):
        raise RateLimited(5)

    best, best_score = None, 0.0
    for result in data.get('data') or []:
        score = (_similar(album_name, result.get('title', '')) + _similar(artist_name, (result.get('artist') or {}).get('name', ''))) / 2
        if score > best_score:
            best, best_score = result, score
    if best is None or best_score < MATCH_THRESHOLD:
        return None

    raw = download_bytes(best.get('cover_xl') or best.get('cover_big'))
    if not raw:
        return None

    year = None
    try:
        detail = requests.get(f"{DEEZER_ALBUM_URL}/{best['id']}", timeout=REQUEST_TIMEOUT).json()
        year = _year_from(detail.get('release_date'))
    except Exception:
        pass
    return {'raw': raw, 'year': year, 'source_url': best.get('link')}


def find_track_preview(artist_name, track_name):
    """{'preview_url', 'artwork_url', 'source'} for a 30-second sample clip
    (artwork_url may be None even on a match, if the source result has none),
    or None. Used by the Discover tab to let a user sample an AI-suggested
    track that isn't in the library (no file, and possibly no Spotify match
    either) - unlike the artwork lookups above, nothing here gets cached/
    persisted, this is a one-off interactive lookup, not a background job, so
    no throttling/RateLimited machinery is needed."""
    try:
        response = requests.get(
            ITUNES_SEARCH_URL,
            params={'term': f'{artist_name} {track_name}', 'media': 'music', 'entity': 'song', 'limit': 5},
            timeout=REQUEST_TIMEOUT,
        )
        if response.status_code == 200:
            best, best_score = None, 0.0
            for result in response.json().get('results') or []:
                score = (_similar(track_name, result.get('trackName', '')) + _similar(artist_name, result.get('artistName', ''))) / 2
                if score > best_score:
                    best, best_score = result, score
            if best and best_score >= MATCH_THRESHOLD and best.get('previewUrl'):
                art = best.get('artworkUrl100')
                return {
                    'preview_url': best['previewUrl'],
                    'artwork_url': art.replace('100x100bb', '600x600bb') if art else None,
                    'source': 'itunes',
                }
    except Exception:
        pass

    try:
        response = requests.get(
            DEEZER_TRACK_SEARCH_URL,
            params={'q': f'artist:"{artist_name}" track:"{track_name}"', 'limit': 5},
            timeout=REQUEST_TIMEOUT,
        )
        if response.status_code == 200:
            data = response.json()
            if not (isinstance(data, dict) and data.get('error')):
                best, best_score = None, 0.0
                for result in data.get('data') or []:
                    score = (_similar(track_name, result.get('title', '')) + _similar(artist_name, (result.get('artist') or {}).get('name', ''))) / 2
                    if score > best_score:
                        best, best_score = result, score
                if best and best_score >= MATCH_THRESHOLD and best.get('preview'):
                    album = best.get('album') or {}
                    return {
                        'preview_url': best['preview'],
                        'artwork_url': album.get('cover_big') or album.get('cover_medium'),
                        'source': 'deezer',
                    }
    except Exception:
        pass

    return None


def _throttle_audiodb():
    global _last_audiodb_call
    elapsed = time.time() - _last_audiodb_call
    if elapsed < AUDIODB_MIN_INTERVAL_SECONDS:
        time.sleep(AUDIODB_MIN_INTERVAL_SECONDS - elapsed)
    _last_audiodb_call = time.time()


def find_via_audiodb(artist_name, album_name):
    """{'raw', 'year', 'source_url'} via TheAudioDB's album endpoint, or
    None. Tried last in the fallback chain since it shares artist_info.py's
    community rate-limited key (30 req/min on the default free-tier key).
    No public browsable album page is readily available, so source_url is
    always None here."""
    _throttle_audiodb()
    try:
        response = requests.get(
            f"{AUDIODB_BASE_URL}/searchalbum.php",
            params={'s': artist_name, 'a': album_name},
            timeout=REQUEST_TIMEOUT,
        )
    except Exception:
        return None
    if response.status_code == 429:
        raise RateLimited(60)
    if response.status_code != 200:
        return None

    candidates = []
    for album in response.json().get('album') or []:
        score = (_similar(album_name, album.get('strAlbum', '')) + _similar(artist_name, album.get('strArtist', ''))) / 2
        if score >= MATCH_THRESHOLD:
            candidates.append(album)
    candidates.sort(key=lambda a: _year_from(a.get('intYearReleased')) or 9999)

    for album in candidates:
        raw = download_bytes(album.get('strAlbumThumb'))
        if raw:
            return {'raw': raw, 'year': _year_from(album.get('intYearReleased')), 'source_url': None}
    return None


def find_via_shazam(artist_name, album_name):
    """{'raw', 'year', 'source_url'} via Shazam Core's Apple-Music-backed
    catalog search - the same RapidAPI source shazam_identify.py's Track ID
    background job already uses for isrc/album/year (see
    spotify_connect.search_shazam_core). Tried last, after even TheAudioDB:
    unlike MusicBrainz/Discogs/Deezer/iTunes this shares a single paid-hosting
    RapidAPI account with that other, continuously-running job, so its quota
    is both unknown and already partly spent elsewhere - only worth spending
    here on tracks nothing else (including AudioDB) could find. source_url is
    always None - Shazam Core has no public browsable page for a search hit,
    only the catalog attributes themselves.

    Shazam Core has no "search by album" mode (only by song), so unlike
    find_via_itunes/find_via_deezer above, candidates are scored purely on
    album_name+artist_name similarity against whatever song each search hit
    happens to be, then sorted earliest-first same as every other source."""
    if not spotify_connect.SHAZAM_RAPIDAPI_KEY:
        return None
    results = spotify_connect.search_shazam_core(f'{artist_name} {album_name}')
    if not results:
        return None

    candidates = []
    for result in results:
        if not result.get('album_name') or not result.get('artwork_url'):
            continue
        score = (_similar(album_name, result['album_name']) + _similar(artist_name, result['artist_name'])) / 2
        if score >= MATCH_THRESHOLD:
            candidates.append(result)
    candidates.sort(key=lambda r: r.get('year') or 9999)

    for result in candidates:
        raw = download_bytes(result['artwork_url'])
        if raw:
            return {'raw': raw, 'year': result.get('year'), 'source_url': None}
    return None


SEARCH_PACING_SECONDS = 0.5


def apply_artwork_result(conn, track_id, artist_name, album_name, existing_year, result, mark_checked_on_miss):
    """Persists a found-artwork result (or a miss) for track_id: downloads
    and caches the image under the shared per-album cache_key so every
    track on that album picks it up, not just this one row (an album is
    typically many rows in known_tracks, one per track); sets has_artwork
    accordingly; fills year only where it was blank; and records
    artwork_source_url. Shared by backfill_external_artwork (which has
    genuinely exhausted every source in its own chain by the time it calls
    this) and shazam_identify.run (which only ever tries Shazam,
    opportunistically, as a side effect of identifying a track) - that's
    why mark_checked_on_miss is a parameter rather than always True: a miss
    from a single-source opportunistic attempt must NOT flip
    external_artwork_checked, or the row would silently drop out of the
    dedicated backfill job's queue before the rest of its chain
    (MusicBrainz/Discogs/Deezer/iTunes/AudioDB) ever got a turn on it.

    Returns whether artwork was actually found/saved. A no-op (no DB write
    at all, not even a commit) when nothing was found and
    mark_checked_on_miss is False - the row is left exactly as it was for
    the dedicated job to still pick up."""
    found = bool(result and save_thumbnail(cache_key_for(track_id, artist_name, album_name), result['raw']))
    if not found and not mark_checked_on_miss:
        return False

    new_year = (result.get('year') if result else None) if not existing_year else None
    source_url = result.get('source_url') if result else None

    # WHERE ... has_artwork = FALSE restricts this to rows that were
    # actually part of the "still missing" set - every matched row is a
    # definite FALSE already, so setting it to `found` directly is
    # unambiguous (no NULL/never-checked rows get touched or reinterpreted
    # here). year only ever fills a blank (COALESCE keeps any
    # locally-tagged year untouched).
    cur = conn.cursor()
    if album_name:
        cur.execute(f"""
            UPDATE known_tracks SET external_artwork_checked = TRUE, has_artwork = %(found)s,
                year = COALESCE(year, %(new_year)s), artwork_source_url = COALESCE(artwork_source_url, %(source_url)s)
            WHERE artist_name = %(artist)s AND {normalized_album_sql()} = %(normalized_album)s
              AND has_artwork = FALSE
        """, {
            'found': found, 'new_year': new_year, 'source_url': source_url,
            'artist': artist_name, 'normalized_album': normalize_album_name(album_name),
        })
    else:
        cur.execute(
            "UPDATE known_tracks SET external_artwork_checked = TRUE, has_artwork = %s, "
            "year = COALESCE(year, %s), artwork_source_url = COALESCE(artwork_source_url, %s) "
            "WHERE id = %s AND has_artwork = FALSE",
            (found, new_year, source_url, track_id),
        )
    conn.commit()
    cur.close()
    return found


def backfill_external_artwork(get_connection, progress):
    """For tracks with no artwork found locally (has_artwork = FALSE, set by
    the Check Artwork job), tries external sources in order: MusicBrainz
    + Cover Art Archive, then Discogs (particularly strong for regional/vinyl
    releases), then Deezer, then the iTunes Search API, then TheAudioDB's
    album endpoint (since it shares artist_info.py's community rate-limited
    key), then finally Shazam Core (see find_via_shazam - shares its RapidAPI
    quota with the separate, continuously-running Track ID job, so it's the
    very last resort). Alongside artwork, also backfills release year
    (only where the local tag left it blank) and a link to whichever source
    matched, from the same lookup - no extra API calls needed for that.

    A hit is downloaded and cached under the same album-shared cache_key
    used everywhere else, so every track sharing that album picks it up
    too - not just the one row processed here (mirrors
    check_artwork_presence's own sibling backfill).

    Processes one row at a time so a real rate limit (raised as RateLimited)
    can pause the whole run and resume automatically once it clears -
    MusicBrainz in particular really will reject requests outright if its
    1/sec limit is violated.
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
                SELECT id, artist_name, album_name, year FROM known_tracks
                WHERE has_artwork = FALSE AND external_artwork_checked IS NOT TRUE
                LIMIT 1
            """)
            row = cur.fetchone()
            cur.close()
            if row is None:
                break

            track_id, artist_name, album_name, existing_year = row
            try:
                result = None
                if album_name:
                    result = find_via_musicbrainz(artist_name, album_name)
                if not result and album_name:
                    result = find_via_discogs(artist_name, album_name)
                if not result and album_name:
                    result = find_via_deezer(artist_name, album_name)
                if not result:
                    result = find_via_itunes(artist_name, album_name or '')
                if not result and album_name:
                    result = find_via_audiodb(artist_name, album_name)
                if not result and album_name:
                    result = find_via_shazam(artist_name, album_name)
            except RateLimited as e:
                resume_at = time.time() + e.retry_after_seconds
                progress.update(status='waiting', resume_at=resume_at)
                time.sleep(e.retry_after_seconds + 5)
                progress.update(status='running', resume_at=None)
                continue

            found = apply_artwork_result(
                conn, track_id, artist_name, album_name, existing_year, result, mark_checked_on_miss=True,
            )

            progress['found' if found else 'still_missing'] += 1
            progress['processed'] += 1
            time.sleep(SEARCH_PACING_SECONDS)

        progress['status'] = 'done'
    except Exception as e:
        conn.rollback()
        progress.update(status='error', error=str(e))
    finally:
        conn.close()
