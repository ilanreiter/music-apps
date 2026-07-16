import re
from collections import Counter
from difflib import SequenceMatcher

# Strips common "same song, different edition" noise so e.g. "Yesterday" and
# "Yesterday (Remastered 2009)" normalize to the same key.
NOISE_PATTERN = re.compile(
    r'\s*[\(\[]\s*(live[^)\]]*|remaster(ed)?[^)\]]*|remix[^)\]]*|radio edit|explicit|clean|'
    r'mono|stereo|bonus track|feat\.[^)\]]*|ft\.[^)\]]*|deluxe[^)\]]*|single version|album version)'
    r'\s*[\)\]]',
    re.IGNORECASE,
)

FUZZY_THRESHOLD = 0.82
MIN_FUZZY_LENGTH = 6  # below this, ratio() is unreliable - e.g. "Artist A" vs "Artist B"
                      # scores 0.875 similarity purely from sharing a long common prefix
DURATION_TOLERANCE_SECONDS = 5
MAX_BUCKET_FOR_FUZZY = 300  # guard against a pathological bucket (e.g. many tracks titled "Intro")

# Our own filename-fallback naming (library_scanner._fallback_from_filename) produces
# titles like "Track 04" when a file has no tags, and "Unknown Artist" when there's no
# artist tag either. These placeholders carry no real identifying information, so two
# untagged, unrelated files can share the exact same fallback title+artist by pure
# coincidence - they must be excluded from matching entirely (not just fuzzy matching),
# since equal-but-meaningless strings would otherwise register as an "exact" duplicate.
GENERIC_TITLE_PATTERN = re.compile(r'^(track|untitled)\s*\d*$', re.IGNORECASE)
GENERIC_ARTIST_PATTERN = re.compile(r'^unknown\s*artist$', re.IGNORECASE)


def _is_generic_placeholder(track_name, artist_name):
    return bool(GENERIC_TITLE_PATTERN.match(track_name or '') or GENERIC_ARTIST_PATTERN.match(artist_name or ''))


def _normalize(text):
    if not text:
        return ''
    text = NOISE_PATTERN.sub('', text)
    text = re.sub(r'[^a-z0-9]+', ' ', text.lower())
    return text.strip()


def _fuzzy_ratio_ok(a, b):
    if GENERIC_TITLE_PATTERN.match(a) or GENERIC_TITLE_PATTERN.match(b):
        return False
    if len(a) < MIN_FUZZY_LENGTH or len(b) < MIN_FUZZY_LENGTH:
        return False
    return SequenceMatcher(None, a, b).ratio() >= FUZZY_THRESHOLD


def _durations_compatible(t1, t2):
    d1, d2 = t1.get('duration_seconds'), t2.get('duration_seconds')
    if d1 is None or d2 is None:
        return True  # can't verify either way; don't block on missing data
    return abs(d1 - d2) <= DURATION_TOLERANCE_SECONDS


def _strip_private(members):
    return [{k: v for k, v in m.items() if not k.startswith('_')} for m in members]


def _collect_fuzzy_pairs(buckets, key_fn, seen_pairs, results):
    for members in buckets.values():
        if len(members) < 2 or len(members) > MAX_BUCKET_FOR_FUZZY:
            continue
        for i in range(len(members)):
            for j in range(i + 1, len(members)):
                t1, t2 = members[i], members[j]
                a, b = key_fn(t1), key_fn(t2)
                if not a or not b or a == b:
                    continue  # already covered by the exact pass, or nothing to compare
                if not (_fuzzy_ratio_ok(a, b) and _durations_compatible(t1, t2)):
                    continue
                pair_key = tuple(sorted((t1['id'], t2['id'])))
                if pair_key in seen_pairs:
                    continue
                seen_pairs.add(pair_key)
                results.append({'reason': 'similar', 'tracks': _strip_private([t1, t2])})


def find_duplicates(tracks):
    """tracks: iterable of dicts with id, track_name, artist_name (plus any extra
    fields to pass through, e.g. duration/bitrate/file_size for a "which to keep"
    decision). Returns duplicate groups, largest first, each tagged as an "exact"
    normalized match (same title & artist - may include Live/Remastered editions
    of the same song, since those are stripped as noise) or "similar" (a likely
    typo/spelling variant, e.g. an artist name transliterated two different ways).

    Exact matches are grouped transitively (safe: string equality is a true
    equivalence relation). Fuzzy matches are reported as individual pairs, NOT
    merged transitively - similarity isn't transitive (A~B and B~C doesn't
    imply A~C), and chaining through a shared bucket produced real false
    positives in testing (many differently-timed "Track 01".."Track 10"
    fallback-named files by the same artist all merging into one giant cluster).
    """
    tracks = [t for t in tracks if not _is_generic_placeholder(t['track_name'], t['artist_name'])]
    normalized = [{**t, '_title': _normalize(t['track_name']), '_artist': _normalize(t['artist_name'])} for t in tracks]

    exact_groups = {}
    for t in normalized:
        if not t['_title'] or not t['_artist']:
            continue
        exact_groups.setdefault((t['_title'], t['_artist']), []).append(t)

    results = [
        {'reason': 'exact', 'tracks': _strip_private(members)}
        for members in exact_groups.values() if len(members) > 1
    ]

    by_title = {}
    by_artist = {}
    for t in normalized:
        if t['_title']:
            by_title.setdefault(t['_title'], []).append(t)
        if t['_artist']:
            by_artist.setdefault(t['_artist'], []).append(t)

    seen_pairs = set()
    # Same title, fuzzy-matching artist (catches an artist's name transliterated
    # two different ways across files).
    _collect_fuzzy_pairs(by_title, lambda t: t['_artist'], seen_pairs, results)
    # Same artist, fuzzy-matching title (catches typos in the track title itself).
    _collect_fuzzy_pairs(by_artist, lambda t: t['_title'], seen_pairs, results)

    results.sort(key=lambda g: len(g['tracks']), reverse=True)
    return results


MIN_HAVE_COUNT = 2  # a single track under a shared/compilation album name isn't "an
                    # album you're collecting" - just one song tagged with that album
MAX_PLAUSIBLE_ALBUM_SIZE = 50  # guards against corrupt track_total tags (real data had
                                # e.g. an "EP" claiming 304 tracks) and "Various Artists"
                                # style folders where many unrelated artists share one
                                # album name with a track_total meant for the whole
                                # compilation, not any single artist's contribution to it
MIN_GUESS_COMPLETENESS_RATIO = 0.5  # when there's no explicit track_total tag, the album
                                     # size is only a guess (the highest track_number seen) -
                                     # only trust that guess if we actually have a good
                                     # fraction of that many tracks. Real data had an album
                                     # with 7 tracks (each a duplicate scan, so 14 rows) where
                                     # one stray track was numbered 44 - trusting that as "the
                                     # album has 44 tracks" reported 37 fake gaps instead of
                                     # recognizing the 44 as an outlier, not the true length


COMPILATION_MIN_ARTISTS = 4  # matches the "by album" grouping in main.py - keep in sync
COMPILATION_MIN_TRACKS = 6


def find_missing_tracks(rows):
    """rows: iterable of (id, artist_name, album_name, track_number, track_total).
    Returns albums with a gap in the track-number sequence and/or more than one
    track sharing the same number, largest issue first. track_total (from an
    "N/M" tag) is used as the expected count when present, since it's
    authoritative; otherwise the highest track_number seen is only a heuristic
    guess at the album length. sample_track_id (any track we do have from that
    album) is included so the caller can show representative artwork - there's
    no track row at all for the missing numbers themselves, so this is the
    only artwork available for that album.

    Grouping key is normally (artist_name, album_name) - but a "Various Artists"
    compilation has a different per-track artist on every track, so grouping
    that way would split it into dozens of near-empty single-artist "albums",
    each compared against the *whole compilation's* track-total tag and so
    each looking wildly incomplete (e.g. "2 of 36" for an artist who
    contributed 2 of the compilation's 36 tracks). Detected compilations
    (many distinct artists across a real number of tracks) are reunified by
    album name alone first, matching the same heuristic used for "by album"
    browsing.
    """
    rows = list(rows)
    artists_per_album = {}
    for _track_id, artist_name, album_name, track_number, _track_total in rows:
        if not album_name or track_number is None:
            continue
        info = artists_per_album.setdefault(album_name, {'artists': set(), 'count': 0})
        info['artists'].add(artist_name)
        info['count'] += 1

    def is_compilation(album_name):
        info = artists_per_album.get(album_name)
        return bool(info) and len(info['artists']) > COMPILATION_MIN_ARTISTS and info['count'] >= COMPILATION_MIN_TRACKS

    albums = {}
    for track_id, artist_name, album_name, track_number, track_total in rows:
        if not album_name or track_number is None:
            continue
        compilation = is_compilation(album_name)
        key = album_name if compilation else (artist_name, album_name)
        entry = albums.setdefault(key, {
            'artist_name': 'Various Artists' if compilation else artist_name,
            'album_name': album_name,
            # Counts (not just a set) so a track number used by more than one
            # file - either a genuine duplicate rip or two different songs
            # mistagged with the same number - can be told apart from a
            # normal, singly-used one.
            'number_counts': Counter(),
            'total_hint': None,
            'sample_track_id': track_id,
        })
        entry['number_counts'][track_number] += 1
        if track_total:
            entry['total_hint'] = max(entry['total_hint'] or 0, track_total)

    results = []
    for entry in albums.values():
        counts = entry['number_counts']
        numbers = set(counts)
        if len(numbers) < MIN_HAVE_COUNT:
            continue

        duplicate_track_numbers = sorted(n for n, c in counts.items() if c > 1)

        has_explicit_total = entry['total_hint'] is not None
        expected_total = entry['total_hint'] or max(numbers)
        trust_guess = has_explicit_total or len(numbers) / expected_total >= MIN_GUESS_COMPLETENESS_RATIO
        missing = []
        if expected_total <= MAX_PLAUSIBLE_ALBUM_SIZE and trust_guess:
            missing = sorted(set(range(1, expected_total + 1)) - numbers)

        if missing or duplicate_track_numbers:
            results.append({
                'artist_name': entry['artist_name'],
                'album_name': entry['album_name'],
                'have_count': len(numbers),
                'expected_total': expected_total,
                'missing_track_numbers': missing,
                'duplicate_track_numbers': duplicate_track_numbers,
                'sample_track_id': entry['sample_track_id'],
            })

    results.sort(key=lambda r: len(r['missing_track_numbers']) + len(r['duplicate_track_numbers']), reverse=True)
    return results
