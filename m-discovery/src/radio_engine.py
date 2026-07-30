"""Shared Last.fm-based similar-track generation for the Radio feature -
plain-dict, no FastAPI/pydantic dependency, so both main.py's synchronous
/api/radio/* routes and playback_advancer.py's background thread (which needs
to keep a Spotify-destination radio session refilling itself once a browser
tab backgrounds/closes) can call the exact same logic instead of duplicating
it. main.py wraps the plain dicts this returns into its own Track pydantic
model for its response bodies; playback_advancer.py uses them as-is.
"""

from . import lastfm
from . import spotify_connect

# How many extra Last.fm rounds to try before giving up on a refill call - a
# single round's weighted sample can land mostly on already-seen tracks,
# especially once a seed's real pool of strong matches starts thinning out.
RADIO_MORE_MAX_ROUNDS = 3


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


def find_cached_artist_tracks(artist_names, seen_keys, limit, db):
    """Local library tracks by any of these artists (case-insensitive)
    already confirmed matched on Spotify (spotify_checked=TRUE with a real
    spotify_track_id) - zero new Spotify calls to queue, since passing these
    back with id=known_tracks.id means the existing
    playback_advancer._match_local_track_cached cache-hit path resolves them
    instantly. This is the free tier generate_radio_batch_for_spotify always
    tries first, and the only tier it falls back to once Spotify's search is
    rate-limited or the self-imposed budget is spent - see that function."""
    if not artist_names:
        return []
    seen = set(seen_keys)
    lowered = list({a.lower() for a in artist_names})
    try:
        cur = db.cursor()
        cur.execute("""
            SELECT id, track_name, artist_name, album_name, spotify_album_art_url
            FROM known_tracks
            WHERE LOWER(artist_name) = ANY(%s) AND spotify_checked IS TRUE AND spotify_track_id IS NOT NULL
            ORDER BY random()
            LIMIT %s
        """, (lowered, max(limit * 3, limit)))  # over-fetch - seen_keys will drop some
        rows = cur.fetchall()
        cur.close()
    except Exception as e:
        print(f"Error finding cached library tracks for radio: {e}")
        return []
    results = []
    for track_id, track_name, artist_name, album_name, artwork_url in rows:
        key = radio_track_key(track_name, artist_name)
        if key in seen:
            continue
        seen.add(key)
        results.append({
            'id': track_id, 'track_name': track_name, 'artist_name': artist_name,
            'album_name': album_name, 'artwork_url': artwork_url,
        })
        if len(results) >= limit:
            break
    return results


def find_any_cached_tracks(seen_keys, limit, db):
    """Absolute last resort: any already-Spotify-matched library track at
    all, no artist filter - confirmed live this tier was actually needed: a
    seed with a small library/genre footprint (an obscure artist plus a
    handful of Last.fm-similar ones) can genuinely exhaust every cached track
    by all of them after just a few played tracks, especially while rate-
    limited (no live search to discover anything beyond that fixed set).
    generate_radio_batch_for_spotify only reaches for this once artist-scoped
    find_cached_artist_tracks (even widened to similar artists) comes up
    short - keeping *something* playing wins over staying on-theme, per the
    same "Radio must never just stop" requirement the rest of this tiering
    already follows."""
    seen = set(seen_keys)
    try:
        cur = db.cursor()
        cur.execute("""
            SELECT id, track_name, artist_name, album_name, spotify_album_art_url
            FROM known_tracks
            WHERE spotify_checked IS TRUE AND spotify_track_id IS NOT NULL
            ORDER BY random()
            LIMIT %s
        """, (max(limit * 3, limit),))  # over-fetch - seen_keys will drop some
        rows = cur.fetchall()
        cur.close()
    except Exception as e:
        print(f"Error finding any cached library track for radio: {e}")
        return []
    results = []
    for track_id, track_name, artist_name, album_name, artwork_url in rows:
        key = radio_track_key(track_name, artist_name)
        if key in seen:
            continue
        seen.add(key)
        results.append({
            'id': track_id, 'track_name': track_name, 'artist_name': artist_name,
            'album_name': album_name, 'artwork_url': artwork_url,
        })
        if len(results) >= limit:
            break
    return results


def _index_cached_tracks_by_key(artist_names, db):
    """{(track_name.lower(), artist_name.lower()): {...}} for every locally
    cached, Spotify-matched track by these artists - one batched query so
    generate_radio_batch_for_spotify can check a whole list of Last.fm
    recommendations against the library at once, instead of one query per
    candidate."""
    if not artist_names:
        return {}
    lowered = list({a.lower() for a in artist_names})
    try:
        cur = db.cursor()
        cur.execute("""
            SELECT id, track_name, artist_name, album_name, spotify_album_art_url
            FROM known_tracks
            WHERE LOWER(artist_name) = ANY(%s) AND spotify_checked IS TRUE AND spotify_track_id IS NOT NULL
        """, (lowered,))
        rows = cur.fetchall()
        cur.close()
    except Exception as e:
        print(f"Error indexing cached tracks for radio: {e}")
        return {}
    index = {}
    for track_id, track_name, artist_name, album_name, artwork_url in rows:
        index[(track_name.lower(), artist_name.lower())] = {
            'id': track_id, 'track_name': track_name, 'artist_name': artist_name,
            'album_name': album_name, 'artwork_url': artwork_url,
        }
    return index


def generate_radio_batch_for_spotify(seed_artists, seen_keys, count, db):
    """Radio's Spotify-destination candidate batch. Last.fm's similar-artist
    recommendations are always the driver here - that's the actual point of
    Radio (discovering new music), not just replaying the library - and
    library-caching is woven in as a free-if-available check per
    recommended candidate, not a bulk pre-fill that would crowd discovery
    out entirely (confirmed live this was backwards in an earlier version:
    a seed artist with plenty of cached tracks filled the whole batch from
    the library alone and Last.fm never even got consulted):

    1. Pull Last.fm's actual recommendations for the seed (same call
       generate_fresh_radio_tracks makes) - this is the candidate list, in
       Last.fm's own weighted order.
    2. For each recommended candidate, in order: if it's already a cached,
       Spotify-matched library track, use that (free, but still exactly
       what Last.fm recommended - not a random substitute). Otherwise, if
       there's search budget, take it as a fresh discovery (a live search
       happens later, at actual match time). Otherwise, skip it for now.
    3. Only if Last.fm's own list runs short, or the budget runs out
       partway through, fall back to filling the remainder with more cached
       library tracks - widened to Last.fm's similar-artist pool (not just
       the literal seed) only once genuinely out of budget, so Radio still
       never just stops.

    Returns (tracks, degraded) - degraded=True whenever the budget-exhausted
    fallback in step 3 was used, so callers can surface "Radio is running
    from your library/cache only right now."
    """
    seen = set(seen_keys)
    raw_tracks = lastfm.discover_tracks(seed_artists, target_count=count * 2, tracks_per_artist=1)
    candidates = []
    for t in raw_tracks:
        key = radio_track_key(t['track_name'], t['artist_name'])
        if key in seen:
            continue
        seen.add(key)
        candidates.append(t)

    cached_by_key = _index_cached_tracks_by_key(list({c['artist_name'] for c in candidates}), db)

    collected = []
    hit_budget_wall = False
    for c in candidates:
        if len(collected) >= count:
            break
        cached = cached_by_key.get((c['track_name'].lower(), c['artist_name'].lower()))
        if cached:
            collected.append(cached)
            continue
        if hit_budget_wall:
            continue
        if not spotify_connect.search_budget_available():
            hit_budget_wall = True
            continue
        collected.append(c)  # a genuine fresh discovery - matched (live search) later, at actual play time

    degraded = False
    if len(collected) < count:
        # Last.fm's own list ran short (not necessarily a budget problem),
        # or the budget wall was hit partway through - either way, keep the
        # queue filled with more cached library tracks rather than stop.
        # Only widen past the literal seed artist(s) once genuinely out of
        # budget - a short Last.fm list on its own just means this seed's
        # real pool of strong matches is thinning out, not a reason to
        # flood the queue with library repeats.
        degraded = hit_budget_wall
        fallback_artists = (seed_artists + lastfm.similar_artist_names(seed_artists)) if hit_budget_wall else seed_artists
        already_seen = list(seen_keys) + [radio_track_key(x['track_name'], x['artist_name']) for x in collected]
        more_cached = find_cached_artist_tracks(fallback_artists, already_seen, count - len(collected), db)
        collected.extend(more_cached)

    if len(collected) < count:
        # Confirmed live: an obscure seed's cached pool (even widened to
        # Last.fm-similar artists) can be small enough to fully exhaust after
        # just a few played tracks, especially while rate-limited - nothing
        # above found anything left to try, but "Radio must never just stop"
        # doesn't get a pass just because this specific artist neighborhood
        # ran dry. Any already-matched library track, any artist, is still
        # better than silence.
        degraded = True
        already_seen = list(seen_keys) + [radio_track_key(x['track_name'], x['artist_name']) for x in collected]
        collected.extend(find_any_cached_tracks(already_seen, count - len(collected), db))

    return collected, degraded
