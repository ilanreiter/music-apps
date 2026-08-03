import os
import random

import requests

# Reusing _normalize/_tokens_contained rather than a 4th copy of the same
# word-containment logic - see _dedupe_seed_artists below for why it's needed.
from . import spotify_connect
from . import database

REQUEST_TIMEOUT = 10
LASTFM_API_KEY = os.environ.get('LASTFM_API_KEY')
LASTFM_BASE_URL = 'http://ws.audioscrobbler.com/2.0/'

# How many similar artists to pull per seed artist, and how many of an
# artist's top tracks to consider (weighted-random pick among these rather
# than always #1, so repeated Discover runs on the same seed don't return an
# identical list every time).
SIMILAR_ARTISTS_PER_SEED = 10
TOP_TRACKS_PER_ARTIST = 3

# Last.fm's artist.getSimilar "match" score (0-1) is relative to that seed's
# own single best match, not an absolute similarity measure - a seed whose
# best match is unusually strong compresses everyone else's score downward
# regardless of how genuinely similar they are. Confirmed live: ABBA's top
# match is Agnetha Fältskog (1.0, her own former bandmate's solo career),
# which alone compressed real genre peers - Bee Gees (0.25), Donna Summer
# (0.21), Fleetwood Mac (0.19) - below what used to be a flat 0.4 cutoff,
# leaving only Agnetha and Frida (ABBA's other former member) as candidates
# and starving Radio down to an unrelated last-resort fallback. This is now
# just a floor for genuinely unrelated noise, not a quality bar - real
# per-seed volume is bounded by MAX_SIMILAR_ARTISTS_PER_SEED_BY_RANK below
# instead, which doesn't care how compressed one seed's particular scale is.
MIN_ARTIST_MATCH_SCORE = 0.15
# How many of a single seed's own similar-artist results to actually keep,
# by Last.fm's own rank order (_get_similar_artists already returns them
# most-similar-first) - independent of the score floor above, so a strong
# top match compressing the rest of that seed's scores never costs it real
# candidates it would otherwise have kept. Keeps each seed's contribution to
# a multi-seed pool comparably sized too: without this, a seed fetched
# deeper than usual (discover_tracks's per_seed_limit, for a large
# target_count) could flood a shared shortlist with a long mediocre tail
# just by being asked for more, at another seed's expense.
MAX_SIMILAR_ARTISTS_PER_SEED_BY_RANK = SIMILAR_ARTISTS_PER_SEED
# From the remaining (already match-filtered) candidates, how many of the
# strongest to actually consider - picked from with weighted randomness
# (higher match score = more likely, but not deterministic) so repeated runs
# still vary without reaching into the weak tail of the pool at all.
SHORTLIST_SIZE = 25

# track.getSimilar's own "match" score has the exact same relative-to-the-
# best-match compression MIN_ARTIST_MATCH_SCORE's own comment describes for
# artists - confirmed live: track.getSimilar(ABBA, "Dancing Queen") scored
# "Mamma Mia" (the same artist's own other song) 1.0, compressing everything
# else (Gloria Gaynor 0.35, Earth Wind & Fire 0.35, Michael Jackson 0.29...)
# well below what a strict cutoff would keep. Same fix, same reasoning: a
# low floor for genuinely unrelated noise only, not a quality bar.
MIN_TRACK_MATCH_SCORE = 0.10
# How many similar tracks to pull per track.getSimilar call - this is
# radio_engine.generate_radio_batch_track_first's primary discovery
# mechanism (track-level, not artist-level), so it doesn't need the same
# over-fetch-then-rank-cap pattern SIMILAR_ARTISTS_PER_SEED/
# MAX_SIMILAR_ARTISTS_PER_SEED_BY_RANK use - each track.getSimilar call
# already returns its own independent ranked list, not one that gets merged
# with other seeds' lists the way artist-level similarity does.
TRACK_SIMILAR_LIMIT = 15


def _tuning():
    """Live values for MIN_TRACK_MATCH_SCORE/MIN_ARTIST_MATCH_SCORE/
    TRACK_SIMILAR_LIMIT/SIMILAR_ARTISTS_PER_SEED - user-adjustable via
    Settings (see database.get_radio_tuning), read fresh on every call
    rather than the bare module constants above so a Settings change takes
    effect on the very next Last.fm call, no restart needed. The constants
    themselves still document the original/default values and back this
    table's own column defaults - they're just no longer what the code
    below actually filters/limits by."""
    return database.get_radio_tuning()


def min_artist_match_score():
    """Public accessor for the live min_artist_match_score - radio_engine.py's
    artist-fallback tier reads this directly (the same floor
    _get_similar_artists/discover_tracks already apply internally) rather
    than a frozen module constant."""
    return _tuning()['min_artist_match_score']


def is_configured():
    return bool(LASTFM_API_KEY)


def _request(method, **params):
    """Raw Last.fm API call, or None on any failure - this is a best-effort
    recommendation source, not something that should ever 500 the /api/discover
    route just because Last.fm hiccuped on one artist out of a whole seed list."""
    try:
        response = requests.get(
            LASTFM_BASE_URL,
            params={'method': method, 'api_key': LASTFM_API_KEY, 'format': 'json', **params},
            timeout=REQUEST_TIMEOUT,
        )
        if response.status_code != 200:
            return None
        data = response.json()
        if isinstance(data, dict) and data.get('error'):
            return None
        return data
    except Exception:
        return None


def _get_similar_artists(artist_name, limit=None):
    """[(name, match_score), ...] - match_score is Last.fm's own 0-1
    relative-similarity score for this seed artist, used below to filter out
    weak matches and weight selection toward the strong ones."""
    if limit is None:
        limit = _tuning()['similar_artists_per_seed']
    data = _request('artist.getSimilar', artist=artist_name, limit=limit, autocorrect=1)
    if not data:
        return []
    artists = ((data.get('similarartists') or {}).get('artist')) or []
    results = []
    for a in artists:
        name = a.get('name')
        if not name:
            continue
        try:
            match = float(a.get('match') or 0)
        except (TypeError, ValueError):
            match = 0.0
        results.append((name, match))
    return results


def _get_top_tracks(artist_name, limit=TOP_TRACKS_PER_ARTIST):
    """Track names, already ordered most-popular-first by Last.fm."""
    data = _request('artist.getTopTracks', artist=artist_name, limit=limit, autocorrect=1)
    if not data:
        return []
    tracks = ((data.get('toptracks') or {}).get('track')) or []
    return [t['name'] for t in tracks if t.get('name')]


def track_similar_tracks(artist_name, track_name, limit=None):
    """[{'track_name', 'artist_name', 'match'}, ...] similar to this exact
    track - a genuinely different signal from artist-level similarity (see
    MIN_TRACK_MATCH_SCORE's own comment): reaches material by artists that
    would never show up via artist.getSimilar at all (confirmed live:
    track.getSimilar(ABBA, "Dancing Queen") surfaced Michael Jackson and
    Earth Wind & Fire, neither anywhere near ABBA's own top-50 similar-
    artist list). This is radio_engine.generate_radio_batch_track_first's
    primary mechanism - see that function for how repeatedly calling this on
    each newly-discovered track (rather than just once per seed) is what
    makes the pool functionally unbounded instead of capped at one artist
    neighborhood's own top-N tracks. Filtered by MIN_TRACK_MATCH_SCORE,
    ordered strongest-match-first (Last.fm's own order, not re-sorted)."""
    tuning = _tuning()
    if limit is None:
        limit = tuning['track_similar_limit']
    data = _request('track.getSimilar', artist=artist_name, track=track_name, limit=limit, autocorrect=1)
    if not data:
        return []
    tracks = ((data.get('similartracks') or {}).get('track')) or []
    results = []
    for t in tracks:
        name = t.get('name')
        artist = (t.get('artist') or {}).get('name')
        if not name or not artist:
            continue
        try:
            match = float(t.get('match') or 0)
        except (TypeError, ValueError):
            match = 0.0
        if match < tuning['min_track_match_score']:
            continue
        results.append({'track_name': name, 'artist_name': artist, 'match': match})
    return results


def track_artwork(artist_name, track_name):
    """Largest available cover-art URL from track.getInfo's own album.image
    list, or None. Confirmed live before building this: unlike the
    long-standing "Last.fm images are all dead placeholders" folklore,
    real, distinct covers do come back for tracks Last.fm actually has data
    for (ABBA/Earth Wind & Fire/Michael Jackson all checked by hand) - it
    just returns nothing at all for a track it has no album data for,
    rather than a fake stand-in. Used to backfill artwork for a Discover
    candidate that has no known_tracks/radio_discovered_tracks cache hit -
    see main.py's get_discover_track_artwork."""
    data = _request('track.getInfo', artist=artist_name, track=track_name, autocorrect=1)
    if not data:
        return None
    images = ((data.get('track') or {}).get('album') or {}).get('image') or []
    for size in ('extralarge', 'large', 'medium'):
        for img in images:
            if img.get('size') == size and img.get('#text'):
                return img['#text']
    return None


def _pick_top_track(top_tracks):
    # top_tracks is already ordered most-popular-first - weight so the #1
    # track is favored without being deterministic (some variety across
    # repeated Discover runs on the same seed), rather than picking
    # uniformly among all of them regardless of how well-known each is.
    weights = list(range(len(top_tracks), 0, -1))
    return random.choices(top_tracks, weights=weights, k=1)[0]


def _weighted_sample_without_replacement(items_with_weights):
    """Returns all items in a weighted-random order - a higher weight means
    more likely to appear earlier, but never deterministic. The pool here is
    always small (<= SHORTLIST_SIZE), so the simple O(n^2) re-draw approach
    is plenty fast and much easier to verify correct than an alternative
    single-pass weighted-reservoir algorithm."""
    pool = list(items_with_weights)
    ordered = []
    while pool:
        items, weights = zip(*pool)
        chosen = random.choices(items, weights=weights, k=1)[0]
        ordered.append(chosen)
        pool = [(item, weight) for item, weight in pool if item != chosen]
    return ordered


def _dedupe_seed_artists(seed_artists):
    """Collapses a collaboration/feature credit ("Eva Cassidy & Chuck Brown")
    into its primary artist ("Eva Cassidy") when both appear in the seed.
    Confirmed live: a library search for "Eva Cassidy" pulled in both her
    solo credit and this one secondary duet-album credit as the seed -
    treated as two independent, equally-weighted seeds, the duet credit's
    own similar-artist neighborhood (Ray Charles duets, jazz-piano
    collaborations - genuinely different from Eva Cassidy solo's) ended up
    supplying half the final recommendations, which read as "not similar to
    Eva Cassidy at all" even though each individual step was working
    correctly. Same word-containment heuristic already used for the
    analogous Spotify-artist-matching problem (see
    spotify_connect._artist_guard_passes) - keeps whichever name is shorter
    (more likely the primary/solo credit) when one's tokens are a superset
    of the other's."""
    kept = []
    for artist in seed_artists:
        tokens = spotify_connect._normalize(artist).split()
        absorbed = False
        for i, existing in enumerate(kept):
            existing_tokens = spotify_connect._normalize(existing).split()
            if (spotify_connect._tokens_contained(existing_tokens, tokens)
                    or spotify_connect._tokens_contained(tokens, existing_tokens)):
                if len(tokens) < len(existing_tokens):
                    kept[i] = artist
                absorbed = True
                break
        if not absorbed:
            kept.append(artist)
    return kept


def similar_artist_names(seed_artists, limit_per_seed=None):
    """Flat, deduped list of artist names similar to seed_artists (just the
    names, no track lookups), filtered by MIN_ARTIST_MATCH_SCORE and capped
    per seed by MAX_SIMILAR_ARTISTS_PER_SEED_BY_RANK, ordered strongest-
    match-first - same candidate-building logic discover_tracks uses
    internally, exposed on its own for callers that want to widen a search
    against something else entirely (radio_engine.py's local-library
    fallback when Spotify's search is rate-limited: Last.fm itself isn't,
    so this still works to find more on-theme candidates when Spotify can't
    be searched at all)."""
    tuning = _tuning()
    if limit_per_seed is None:
        limit_per_seed = tuning['similar_artists_per_seed']
    seed_artists = _dedupe_seed_artists(seed_artists)
    seed_set = {a.lower() for a in seed_artists}
    candidates = {}
    for seed_artist in seed_artists:
        ranked = [
            (name, match) for name, match in _get_similar_artists(seed_artist, limit=limit_per_seed)
            if name.lower() not in seed_set and match >= tuning['min_artist_match_score']
        ]
        for name, match in ranked[:MAX_SIMILAR_ARTISTS_PER_SEED_BY_RANK]:
            key = name.lower()
            if key not in candidates or match > candidates[key][1]:
                candidates[key] = (name, match)
    return [name for name, _ in sorted(candidates.values(), key=lambda c: c[1], reverse=True)]


def discover_tracks(seed_artists, target_count=10, tracks_per_artist=1):
    """[{'track_name', 'artist_name'}, ...] of real tracks similar to
    seed_artists, drawn from Last.fm's similar-artist/top-tracks data - since
    this is real catalog/listening data rather than generated text, it can't
    hallucinate a track that doesn't exist (unlike the Gemini-based approach
    this replaced). Best-effort throughout: any single artist lookup failing
    just yields fewer candidates, never an exception.

    Candidates are filtered by Last.fm's own match score (MIN_ARTIST_MATCH_SCORE,
    now just a floor for genuinely unrelated noise - see its own comment)
    and capped per seed by rank (MAX_SIMILAR_ARTISTS_PER_SEED_BY_RANK), then
    selection is weighted toward the strongest matches among what's left
    (see _weighted_sample_without_replacement) - confirmed live the per-seed
    rank cap was needed: with a genre-filtered seed spanning several
    artists, a seed fetched deeper than usual (per_seed_limit below, for a
    large target_count) could otherwise flood the shared shortlist with a
    long mediocre tail just by being asked for more, at another seed's
    expense, producing the "some recommendations make sense, some don't"
    pattern reported.

    tracks_per_artist=1 (default) is today's "flat list of individual
    tracks" mode - target_count means how many tracks, one per artist,
    randomly weighted toward each artist's most popular. tracks_per_artist>1
    is "group by artist" mode (see main.py's DiscoveryParameters.group_by_artist) -
    target_count then means how many *artists*, each contributing up to
    tracks_per_artist of their actual top tracks (deterministic, most-popular-
    first - unlike the single-track case, showing an artist's genuinely best-
    known songs together reads better than a random pick)."""
    tuning = _tuning()
    seed_artists = _dedupe_seed_artists(seed_artists)
    seed_set = {a.lower() for a in seed_artists}

    # key -> (display_name, best match score seen for it across all seeds)
    candidates = {}
    # Same floor-not-cap reasoning as SHORTLIST_SIZE below - a narrow seed
    # (few seed artists) asking for a high target_count needs a deeper pull
    # per seed artist too, not just a bigger shortlist to choose from. The
    # per-seed rank cap right below is what keeps that deeper pull from
    # translating into a proportionally larger share of the final pool.
    per_seed_limit = max(tuning['similar_artists_per_seed'], target_count * 2)
    for seed_artist in seed_artists:
        ranked = [
            (name, match) for name, match in _get_similar_artists(seed_artist, limit=per_seed_limit)
            if name.lower() not in seed_set and match >= tuning['min_artist_match_score']
        ]
        for name, match in ranked[:MAX_SIMILAR_ARTISTS_PER_SEED_BY_RANK]:
            key = name.lower()
            if key not in candidates or match > candidates[key][1]:
                candidates[key] = (name, match)

    # SHORTLIST_SIZE is a floor, not a cap - a caller asking for more tracks
    # than that needs a proportionally larger pool to actually draw from,
    # otherwise target_count could never be reached regardless of how many
    # strong matches exist.
    shortlist = sorted(candidates.values(), key=lambda c: c[1], reverse=True)[:max(SHORTLIST_SIZE, target_count * 3)]
    ordered_candidates = _weighted_sample_without_replacement(shortlist)

    results = []
    result_keys = set()
    artists_used = 0
    for candidate_artist in ordered_candidates:
        if artists_used >= target_count:
            break
        top_tracks = _get_top_tracks(candidate_artist, limit=max(TOP_TRACKS_PER_ARTIST, tracks_per_artist))
        if not top_tracks:
            continue
        picks = top_tracks[:tracks_per_artist] if tracks_per_artist > 1 else [_pick_top_track(top_tracks)]
        added_any = False
        for track_name in picks:
            key = (track_name.lower(), candidate_artist.lower())
            if key in result_keys:
                continue
            result_keys.add(key)
            results.append({'track_name': track_name, 'artist_name': candidate_artist})
            added_any = True
        if added_any:
            artists_used += 1

    return results
