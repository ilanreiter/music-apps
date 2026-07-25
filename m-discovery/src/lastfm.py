import os
import random

import requests

# Reusing _normalize/_tokens_contained rather than a 4th copy of the same
# word-containment logic - see _dedupe_seed_artists below for why it's needed.
from . import spotify_connect

REQUEST_TIMEOUT = 10
LASTFM_API_KEY = os.environ.get('LASTFM_API_KEY')
LASTFM_BASE_URL = 'http://ws.audioscrobbler.com/2.0/'

# How many similar artists to pull per seed artist, and how many of an
# artist's top tracks to consider (weighted-random pick among these rather
# than always #1, so repeated Discover runs on the same seed don't return an
# identical list every time).
SIMILAR_ARTISTS_PER_SEED = 10
TOP_TRACKS_PER_ARTIST = 3

# Last.fm's artist.getSimilar "match" score (0-1, relative to the single best
# match for that seed artist) - candidates below this are dropped entirely
# rather than just deprioritized. Confirmed live: with a genre-filtered seed
# spanning several artists at once, a plain uniform shuffle of the combined
# candidate pool gave a barely-related 0.15-match artist from one seed the
# same odds as a 0.9-match artist from another, which is exactly the "some
# recommendations make sense, some don't" pattern reported.
MIN_ARTIST_MATCH_SCORE = 0.4
# From the remaining (already match-filtered) candidates, how many of the
# strongest to actually consider - picked from with weighted randomness
# (higher match score = more likely, but not deterministic) so repeated runs
# still vary without reaching into the weak tail of the pool at all.
SHORTLIST_SIZE = 25


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


def _get_similar_artists(artist_name, limit=SIMILAR_ARTISTS_PER_SEED):
    """[(name, match_score), ...] - match_score is Last.fm's own 0-1
    relative-similarity score for this seed artist, used below to filter out
    weak matches and weight selection toward the strong ones."""
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


def discover_tracks(seed_artists, target_count=10, tracks_per_artist=1):
    """[{'track_name', 'artist_name'}, ...] of real tracks similar to
    seed_artists, drawn from Last.fm's similar-artist/top-tracks data - since
    this is real catalog/listening data rather than generated text, it can't
    hallucinate a track that doesn't exist (unlike the Gemini-based approach
    this replaced). Best-effort throughout: any single artist lookup failing
    just yields fewer candidates, never an exception.

    Candidates are filtered by Last.fm's own match score (MIN_ARTIST_MATCH_SCORE)
    and selection is weighted toward the strongest matches (see
    _weighted_sample_without_replacement) - confirmed live this was needed:
    with a genre-filtered seed spanning several artists, a plain uniform
    shuffle of the combined pool gave a barely-related low-match candidate
    from one seed the same odds as a strong match from another, producing
    the "some recommendations make sense, some don't" pattern reported.

    tracks_per_artist=1 (default) is today's "flat list of individual
    tracks" mode - target_count means how many tracks, one per artist,
    randomly weighted toward each artist's most popular. tracks_per_artist>1
    is "group by artist" mode (see main.py's DiscoveryParameters.group_by_artist) -
    target_count then means how many *artists*, each contributing up to
    tracks_per_artist of their actual top tracks (deterministic, most-popular-
    first - unlike the single-track case, showing an artist's genuinely best-
    known songs together reads better than a random pick)."""
    seed_artists = _dedupe_seed_artists(seed_artists)
    seed_set = {a.lower() for a in seed_artists}

    # key -> (display_name, best match score seen for it across all seeds)
    candidates = {}
    # Same floor-not-cap reasoning as SHORTLIST_SIZE below - a narrow seed
    # (few seed artists) asking for a high target_count needs a deeper pull
    # per seed artist too, not just a bigger shortlist to choose from.
    per_seed_limit = max(SIMILAR_ARTISTS_PER_SEED, target_count * 2)
    for seed_artist in seed_artists:
        for name, match in _get_similar_artists(seed_artist, limit=per_seed_limit):
            key = name.lower()
            if key in seed_set or match < MIN_ARTIST_MATCH_SCORE:
                continue
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
