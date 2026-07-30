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

# Caps how many of a cached-fallback batch can come from the literal seed
# artist(s) alone (see generate_radio_batch_for_spotify) - just enough to
# guarantee a genuine same-artist track exists to become the seed pick
# itself, without a well-covered artist (e.g. 16 cached Jethro Tull tracks)
# swallowing the *entire* batch before the widened similar-artist tier ever
# gets a turn. Confirmed live this was happening: an "Aqualung" (Jethro
# Tull) session's whole fallback batch came back as 7 Jethro Tull tracks and
# just 1 Genesis one, when the point of Radio is discovering other artists,
# not replaying the same one seed.
SEED_ARTIST_FALLBACK_CAP = 2


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

    degraded = hit_budget_wall
    if len(collected) < count:
        # Last.fm's own list ran short (not necessarily a budget problem),
        # or the budget wall was hit partway through - either way, keep the
        # queue filled with more cached library tracks rather than stop.
        # Tries the literal seed artist(s)' own cache first, unwidened - a
        # genuine same-artist track is always a better seed/filler than a
        # same-genre substitute. Confirmed live this matters: the old single
        # combined query (seed_artists + similar_artist_names in one list,
        # picked via ORDER BY random()) gave a seed's own cached tracks no
        # priority at all over the widened similar-artist pool - a "Radio
        # from Aqualung" (Jethro Tull) session's random draw won on a Yes
        # track from the widened list, even though 16 genuine cached Jethro
        # Tull tracks were sitting right there unused.
        already_seen = list(seen_keys) + [radio_track_key(x['track_name'], x['artist_name']) for x in collected]
        same_artist_limit = min(SEED_ARTIST_FALLBACK_CAP, count - len(collected))
        collected.extend(find_cached_artist_tracks(seed_artists, already_seen, same_artist_limit, db))

    if len(collected) < count:
        # Widens to Last.fm-similar artists' own cache whenever there's
        # still a gap - regardless of hit_budget_wall. Confirmed live this
        # was wrongly gated on budget alone: Last.fm itself can simply have
        # few similar-track suggestions for a given seed (a real, common
        # case, not a rate-limit signal at all - "Nick Cave & the Bad
        # Seeds" returned only 7 raw suggestions total even asking for 30),
        # and skipping straight past this tier sent it to the untargeted
        # "any cached track" last resort below instead - both a worse pick
        # (a random unrelated track instead of a genuinely similar artist
        # like Grinderman or The Birthday Party, both Nick Cave's own other
        # projects and likely already cached) and, since that tier also
        # marks the batch "degraded", a misleading "Spotify's search is
        # rate-limited" message when no rate limit was involved anywhere.
        # This lookup itself is Last.fm (unthrottled) plus a local cache
        # query - free regardless of Spotify's budget state.
        already_seen = list(seen_keys) + [radio_track_key(x['track_name'], x['artist_name']) for x in collected]
        similar_artists = lastfm.similar_artist_names(seed_artists)
        collected.extend(find_cached_artist_tracks(similar_artists, already_seen, count - len(collected), db))

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

    # Moves the *first* genuine seed-artist match (if any) to the front -
    # deliberately not a full sort. Whoever calls this to resolve an actual
    # seed track (App.js's resolveFirstSpotifyMatch, used when the literal
    # picked track/artist itself couldn't be matched) takes the first
    # candidate that resolves, so this is what makes that the picked
    # artist's own track whenever one exists in the batch, rather than
    # whichever came first by Last.fm's ranking or random luck. Everything
    # *after* that one spot is left exactly as tiered above (Last.fm
    # discovery first, other-artist cache only once genuinely constrained) -
    # a full sort here would instead front-load every same-artist match
    # ahead of any other artist's, turning the whole ongoing queue into a
    # run of the seed artist's own tracks before ever reaching the similar-
    # artist variety Radio's actually meant to surface.
    seed_artists_lower = {a.lower() for a in seed_artists}
    same_artist_index = next(
        (i for i, t in enumerate(collected) if t['artist_name'].lower() in seed_artists_lower), None,
    )
    if same_artist_index is not None and same_artist_index != 0:
        collected.insert(0, collected.pop(same_artist_index))

    return collected, degraded
