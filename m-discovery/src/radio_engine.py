"""Shared Last.fm-based similar-track generation for the Radio feature -
plain-dict, no FastAPI/pydantic dependency, so both main.py's synchronous
/api/radio/* routes and playback_advancer.py's background thread (which needs
to keep a Spotify-destination radio session refilling itself once a browser
tab backgrounds/closes) can call the exact same logic instead of duplicating
it. main.py wraps the plain dicts this returns into its own Track pydantic
model for its response bodies; playback_advancer.py uses them as-is.
"""

from datetime import timedelta

from . import database
from . import lastfm

# How many extra Last.fm rounds to try before giving up on a refill call - a
# single round's weighted sample can land mostly on already-seen tracks,
# especially once a seed's real pool of strong matches starts thinning out.
RADIO_MORE_MAX_ROUNDS = 3

# Drift-aware discovery tuning - see generate_radio_batch_track_first's own
# docstring for the full model. "drift" for a candidate is 1 minus the
# compounded product of every hop's own Last.fm track.getSimilar match score
# along the BFS path back to the seed - 0 at the seed itself, approaching 1
# the longer/weaker the chain of hops that reached it has been. There's no
# hop-depth cap and no artist-level tier at all anymore: every candidate is
# reached purely by track-to-track similarity, which Last.fm computes from
# listening/tag co-occurrence, not genre or artist metadata - a single hop
# can and does land on a completely different artist (see
# lastfm.track_similar_tracks' own docstring: ABBA's "Dancing Queen" ->
# Michael Jackson, Earth Wind & Fire, in one hop). INITIAL_MAX_DRIFT is the
# starting radius candidates must clear to be accepted immediately; anything
# weaker isn't discarded, just deferred until the search genuinely runs out
# of anything closer (see the deferred-pool promotion in the main loop) -
# this is what keeps the walk starting tight around the seed and only
# drifting into adjacent styles once it actually needs to, without ever
# hard-capping how far a long session can eventually wander.
INITIAL_MAX_DRIFT = 0.6


def radio_track_key(track_name, artist_name):
    return f"{track_name.strip().lower()}|||{artist_name.strip().lower()}"


def filter_known_tracks_dicts(tracks, db):
    """Dict-based twin of main.py's _filter_known_tracks (same one-query
    known_tracks membership check) - kept separate rather than shared since
    that one is pydantic-Track-typed and used by Discover, which this module
    deliberately has no dependency on."""
    if not tracks:
        return []
    known_tracks_set = set()
    try:
        cur = db.cursor()
        cur.execute("SELECT track_name, artist_name FROM known_tracks")
        for row in cur.fetchall():
            known_tracks_set.add((row[0].lower(), row[1].lower()))
        cur.close()
    except Exception as e:
        print(f"Error fetching known tracks for radio filtering: {e}")
        return tracks
    return [t for t in tracks if (t['track_name'].lower(), t['artist_name'].lower()) not in known_tracks_set]


def generate_fresh_radio_tracks(seed_artists, destination_type, seen_keys, count, db):
    """Pulls fresh Last.fm suggestions for this seed, filtering out anything
    already in seen_keys (lastfm.discover_tracks has no memory of its own
    across calls - see lastfm.py) and, for browser/spotify destinations,
    anything already in the local library (irrelevant for a ytmusic
    destination - the point there is filling a YouTube Music playlist, not
    finding something new to the local collection). Retries a few rounds
    since a single call's weighted sample can land mostly on tracks already
    seen, especially once a seed's real pool of strong matches starts
    thinning out. Returns a list of {"track_name", "artist_name"} dicts."""
    collected = []
    seen = set(seen_keys)
    for _ in range(RADIO_MORE_MAX_ROUNDS):
        if len(collected) >= count:
            break
        raw_tracks = lastfm.discover_tracks(seed_artists, target_count=count * 2, tracks_per_artist=1)
        round_tracks = [{"track_name": t['track_name'], "artist_name": t['artist_name']} for t in raw_tracks]
        if destination_type != 'ytmusic':
            round_tracks = filter_known_tracks_dicts(round_tracks, db)
        found_new = False
        for t in round_tracks:
            key = radio_track_key(t['track_name'], t['artist_name'])
            if key in seen:
                continue
            seen.add(key)
            collected.append(t)
            found_new = True
            if len(collected) >= count:
                break
        if not found_new:
            break
    return collected


def _discovered_track_row(track_id, track_name, artist_name, album_name, spotify_track_id, artwork_url):
    """Shapes a radio_discovered_tracks row into the same candidate dict
    known_tracks-sourced ones use, plus a pre-resolved spotify_uri -
    playback_advancer._advance_spotify's matching loop treats that as an
    already-confirmed match (no known_tracks id to cache-check, no live
    search needed either) the same way it already treats a known_tracks
    cache hit, just without a known_tracks id/local_id/origin_library
    ("Your Library" wouldn't be true for a track the user doesn't own)."""
    return {
        'id': None, 'radio_track_id': track_id, 'track_name': track_name, 'artist_name': artist_name,
        'album_name': album_name, 'spotify_uri': f'spotify:track:{spotify_track_id}', 'artwork_url': artwork_url,
    }

def _index_cached_tracks_by_key(artist_names, db):
    """{(track_name.lower(), artist_name.lower()): {...}} for every
    already-Spotify-confirmed track (library or previously-discovered) by
    these artists - one batched query so generate_radio_batch_track_first
    can check a whole list of candidates at once, instead of
    one query per candidate. known_tracks entries win a key collision
    (checked first) - a genuine library match is always at least as good
    as a previously-discovered one for the exact same track."""
    if not artist_names:
        return {}
    lowered = list({a.lower() for a in artist_names})
    cooldown_cutoff = database.now_ny_naive() - timedelta(days=database.get_radio_cooldown_days())
    try:
        cur = db.cursor()
        cur.execute("""
            SELECT id, track_name, artist_name, album_name, spotify_album_art_url, genre, year, duration_seconds
            FROM known_tracks
            WHERE LOWER(artist_name) = ANY(%s) AND spotify_checked IS TRUE AND spotify_track_id IS NOT NULL
                AND (last_played_at IS NULL OR last_played_at < %s)
        """, (lowered, cooldown_cutoff))
        known_rows = cur.fetchall()
        cur.execute("""
            SELECT id, track_name, artist_name, album_name, spotify_track_id, spotify_album_art_url
            FROM radio_discovered_tracks
            WHERE LOWER(artist_name) = ANY(%s)
                AND (last_played_at IS NULL OR last_played_at < %s)
        """, (lowered, cooldown_cutoff))
        discovered_rows = cur.fetchall()
        cur.close()
    except Exception as e:
        print(f"Error indexing cached tracks for radio: {e}")
        return {}
    index = {}
    for row in discovered_rows:
        track_id, track_name, artist_name, album_name, spotify_track_id, artwork_url = row
        index[(track_name.lower(), artist_name.lower())] = _discovered_track_row(
            track_id, track_name, artist_name, album_name, spotify_track_id, artwork_url,
        )
    for track_id, track_name, artist_name, album_name, artwork_url, genre, year, duration_seconds in known_rows:
        # genre/year/duration_seconds come from the local file's own tags -
        # radio_discovered_tracks (above) has no equivalent columns at all,
        # and a plain-text (never-searched) candidate has no metadata
        # source whatsoever, so these stay unset for both - the summary
        # panel (App.js) discloses that coverage rather than assuming it.
        index[(track_name.lower(), artist_name.lower())] = {
            'id': track_id, 'track_name': track_name, 'artist_name': artist_name,
            'album_name': album_name, 'artwork_url': artwork_url,
            'genre': genre, 'year': year, 'duration_seconds': duration_seconds,
        }
    return index


def _interleave_by_artist(tracks):
    """Round-robin regroup by artist so a same-artist run doesn't surface as
    several plays in a row. Real Last.fm data makes this common: an
    artist's own other songs are frequently its single strongest
    track-level match (self-compression - see MIN_TRACK_MATCH_SCORE's own
    comment in lastfm.py), so a BFS pass often clears out most of one
    artist's catalog - each of their songs, in turn, pointing right back at
    their other songs - before ever branching to a different artist.
    Confirmed live: an ABBA-seeded batch surfaced 4 straight Earth, Wind &
    Fire tracks, then 3 straight Donna Summer tracks. Preserves each
    artist's own internal discovery order (closest match first) and which
    artist was discovered first - only interleaves *between* artists, never
    reorders a single artist's own tracks relative to each other."""
    groups = {}
    for t in tracks:
        groups.setdefault(t['artist_name'].lower(), []).append(t)
    queues = list(groups.values())
    result = []
    while queues:
        next_round = []
        for q in queues:
            result.append(q.pop(0))
            if q:
                next_round.append(q)
        queues = next_round
    return result


def _bootstrap_track_frontier(session):
    """Builds a fresh one-item track_frontier when none is persisted yet (a
    brand new session, or the rare case where even the deferred pool comes
    up empty) - from the session's literal seed track when it has one,
    otherwise a single representative top-track for the seed artist, so
    track-level discovery has somewhere to start even for an artist-seeded
    (no specific track picked) session. path_similarity starts at 1.0 (zero
    drift) - the seed itself is the origin every other track's drift is
    measured against."""
    seed_artist = session.get('seed_artist_name')
    seed_track = session.get('seed_track_name')
    if not seed_artist:
        seed_artists = session.get('seed_artists') or []
        seed_artist = seed_artists[0] if seed_artists else None
    if not seed_artist:
        return []
    if not seed_track:
        top = lastfm._get_top_tracks(seed_artist, limit=1)
        seed_track = top[0] if top else None
    if not seed_track:
        return []
    return [{'artist_name': seed_artist, 'track_name': seed_track, 'path_similarity': 1.0, 'depth': 0}]


def _normalize_discovery_state(raw):
    """The persisted discovery_state column is a plain {'deferred': [...],
    'max_drift': float} dict - defensively normalized here since a session
    created before this drift-BFS rewrite (or one with no state yet) may
    hand back {}, [], or None instead."""
    if not isinstance(raw, dict):
        return {'deferred': [], 'max_drift': INITIAL_MAX_DRIFT}
    return {
        'deferred': raw.get('deferred') or [],
        'max_drift': raw.get('max_drift') or INITIAL_MAX_DRIFT,
    }


def generate_radio_batch_track_first(session, seen_keys, count, db):
    """Drift-aware Graph-BFS Radio candidate generation for a Spotify-
    destination session - replaced the old track/artist tiered generator
    entirely per explicit user request: that version could only keep
    discovering past a track-level dead end by pivoting through
    artist-level similarity (a coarser, genre/scene-level signal), which
    both under-served genuine "hidden jewel" discovery (an unrelated
    artist's one great matching song never got a look-in - only a similar
    artist's own generic top tracks did) and could still genuinely run dry
    for a narrow seed. This version has no artist-level concept at all -
    every candidate is reached purely by lastfm.track_similar_tracks
    (track-to-track, listening/tag-co-occurrence based - a hop can and
    does land on a completely different artist), and "how far it's allowed
    to wander" is governed by a measured drift budget rather than a hop
    count, so it keeps expanding as long as *some* real Last.fm connection
    still exists, at any strength.

    Core model: every candidate's drift = 1 - path_similarity, where
    path_similarity is the product of every hop's own Last.fm match score
    along the BFS path back to the original seed (1.0 at the seed itself).
    A track discovered directly from the seed has path_similarity equal to
    its own real match score; a track reached through 3 weaker hops has a
    correspondingly smaller compounded path_similarity (bigger drift) even
    if any single hop looked fine in isolation - this is what stands in for
    the old hard TRACK_HOP_MAX_DEPTH cap (removed - a live sim under that
    old model found 2 hops from ABBA's "Dancing Queen" reached Bruno Mars,
    but that was really a statement about that *specific* weak 2-hop chain,
    not about hop count in general; a decaying drift budget rejects a weak
    chain at any depth while still allowing a strong one to run long).

    Expansion: candidates within the current max_drift are accepted
    immediately (added to track_frontier for their own future
    track.getSimilar call, breadth-first). Candidates beyond it are not
    discarded - they're deferred (kept, sorted by drift). Only once the
    live frontier is completely drained (every currently-admitted track has
    had its neighborhood searched) does the search "expand outward in a
    concentric ring": the single closest deferred candidate is promoted,
    max_drift rises to exactly cover it (never further than needed), and
    BFS resumes from there. This means the search always exhausts the
    tightest, most-confident radius before ever settling for something
    weaker, without needing to guess a fixed step size or re-query Last.fm
    for data already in hand. track_frontier and the deferred pool
    (discovery_state, {'deferred': [...], 'max_drift': float} - persisted
    via database.set_radio_session_track_state, same column that used to
    hold the old tiered generator's fallback_expanded_artists) both survive
    across /more calls and playback_advancer refill ticks, so a long
    session keeps expanding its ring from wherever it last left off instead
    of restarting at the seed.

    Only genuine, total exhaustion - track_frontier AND the deferred pool
    both empty, meaning literally no Last.fm connection at any drift level
    remains unexplored - stops the batch short of `count`. There is no
    further tier below this (the old library-fallback last resort stays
    removed - a library track is, by definition, already discovered, so
    reusing it isn't discovery).

    Every candidate is checked against a single seen/cooldown gate
    (try_add below) before being kept or deferred - cooldown
    (database.get_recently_played_keys) excludes a track this app already
    recorded a recent play for. Every accepted candidate is then checked
    against the cache index (_index_cached_tracks_by_key, built from
    whatever artists actually showed up in this batch) - a cache hit comes
    back pre-resolved (spotify_uri/id set, so playback_advancer's matching
    loop needs zero live search for it), a miss is left as a plain text
    candidate for a live search at actual match time. Every candidate
    carries selection_reason/selection_engine (always "Discovered -
    similar track"/"Last.fm" now - the old artist tier's own label is
    gone) plus match (this hop's own Last.fm score) and drift (the
    compounded distance from the seed) - persisted onto last_played_reason/
    last_played_engine once actually played (database._record_track_played)
    and surfaced in the Play Log/reviewable playlist.

    Returns (tracks, new_track_frontier, new_discovery_state, degraded).
    degraded is always False - kept in the return signature only for
    compatibility with every existing caller's unpacking (main.py,
    playback_advancer.py both destructure a 4-tuple)."""
    seen = set(seen_keys)
    frontier = [dict(f) for f in (session.get('track_frontier') or [])]
    state = _normalize_discovery_state(session.get('discovery_state'))
    deferred = [dict(d) for d in state['deferred']]
    max_drift = state['max_drift']
    cooldown_keys = database.get_recently_played_keys(
        database.now_ny_naive() - timedelta(days=database.get_radio_cooldown_days())
    )
    for f in frontier:
        seen.add(radio_track_key(f['track_name'], f['artist_name']))
    for d in deferred:
        seen.add(radio_track_key(d['track_name'], d['artist_name']))
    if not frontier and not deferred:
        frontier = _bootstrap_track_frontier(session)
        for f in frontier:
            seen.add(radio_track_key(f['track_name'], f['artist_name']))

    collected = []

    def try_add(artist_name, track_name, path_similarity, depth, step_match):
        key = radio_track_key(track_name, artist_name)
        if key in seen or key in cooldown_keys:
            return None
        seen.add(key)
        drift = round(1 - path_similarity, 4)
        node = {
            'artist_name': artist_name, 'track_name': track_name,
            'path_similarity': path_similarity, 'depth': depth, 'drift': drift, 'match': step_match,
        }
        if drift <= max_drift:
            collected.append({**node, 'selection_reason': 'Discovered - similar track', 'selection_engine': 'Last.fm'})
            return node
        deferred.append(node)
        return None

    while len(collected) < count:
        if not frontier:
            if not deferred:
                break
            deferred.sort(key=lambda d: d['drift'])
            promoted = deferred.pop(0)
            max_drift = max(max_drift, promoted['drift'])
            collected.append({**promoted, 'selection_reason': 'Discovered - similar track', 'selection_engine': 'Last.fm'})
            frontier.append(promoted)
            continue

        parent = frontier.pop(0)
        for s in lastfm.track_similar_tracks(parent['artist_name'], parent['track_name']):
            path_similarity = parent['path_similarity'] * s['match']
            node = try_add(s['artist_name'], s['track_name'], path_similarity, parent['depth'] + 1, s['match'])
            if node is not None:
                frontier.append(node)
            if len(collected) >= count:
                break

    degraded = False
    # include_library_tracks (session-level, default True - see database.py's
    # schema comment) doesn't affect exploration at all, only what's
    # surfaced below - a library track's own track.getSimilar neighbors were
    # already queued onto frontier the moment it was accepted, same as any
    # other track.
    exclude_library = not session.get('include_library_tracks', True)

    # Cache-check every plain-text candidate - reduces how many candidates
    # actually need a live Spotify search at match time.
    text_candidates = [c for c in collected if 'id' not in c and 'spotify_uri' not in c]
    cached_by_key = _index_cached_tracks_by_key(list({c['artist_name'] for c in text_candidates}), db)
    final = []
    for c in collected:
        if 'id' in c or 'spotify_uri' in c:
            final.append(c)
            continue
        cached = cached_by_key.get((c['track_name'].lower(), c['artist_name'].lower()))
        final.append(
            {**cached, 'selection_reason': c['selection_reason'], 'selection_engine': c.get('selection_engine'), 'match': c.get('match'), 'drift': c.get('drift')}
            if cached else c
        )

    if exclude_library:
        # A real known_tracks membership check, not just _index_cached_tracks_by_key's
        # cache index above - that index only covers rows already
        # Spotify-verified (spotify_checked=TRUE), so a library track that
        # hasn't been pre-warmed yet would otherwise slip through untouched.
        # filter_known_tracks_dicts (also used by generate_fresh_radio_tracks)
        # checks the whole known_tracks table regardless of that flag.
        final = filter_known_tracks_dicts(final, db)

    new_discovery_state = {'deferred': deferred, 'max_drift': max_drift}
    return _interleave_by_artist(final)[:count], frontier, new_discovery_state, degraded
