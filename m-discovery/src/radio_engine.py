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

# How many hops out from wherever a track was discovered
# generate_radio_batch_track_first keeps following track.getSimilar before
# treating a result as a dead end (still returned as a candidate, just not
# pushed back onto track_frontier for further exploration) - bounds how far
# a long session can wander from its own recent picks. Confirmed via live
# simulation this is not just a safety net: even at depth 1, a single seed
# track supplied 120+ genuinely varied, on-theme candidates before the
# track-level frontier ever ran dry, and it kept the walk closer to a
# hub-and-spoke pattern (many short hops off whatever's currently playing)
# rather than one long chain that can drift a long way from the original
# seed over enough hops (also confirmed live: 2 hops from ABBA's "Dancing
# Queen" reached Bruno Mars).
TRACK_HOP_MAX_DEPTH = 1

# The artist-level reserve tier's own tuning (see
# generate_radio_batch_track_first's docstring, tier 2) - deliberately wider
# than the artist-similarity module's own SIMILAR_ARTISTS_PER_SEED/
# TOP_TRACKS_PER_ARTIST defaults, since this only ever runs once track-level
# has genuinely gone dry and needs to inject a real amount of fresh material
# at once, not trickle-feed it the way a per-seed Discover pull does.
ARTIST_FALLBACK_SIMILAR_LIMIT = 20
ARTIST_FALLBACK_TOP_TRACKS_LIMIT = 20


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

def find_any_cached_tracks(seen_keys, limit, db):
    """Absolute last resort: any already-Spotify-confirmed track at all
    (library or previously-discovered, no artist filter) - confirmed live
    this tier was actually needed: a seed with a small library/genre
    footprint (an obscure artist plus a handful of Last.fm-similar ones)
    can genuinely exhaust every cached track by all of them after just a
    few played tracks, especially while rate-limited (no live search to
    discover anything beyond that fixed set). generate_radio_batch_track_first
    only reaches for this as its absolute last resort (tier 3), once both
    Last.fm-driven tiers ahead of it come up short - keeping *something*
    playing wins over staying on-theme, per the same "Radio must never just
    stop" requirement the rest of this tiering already follows."""
    seen = set(seen_keys)
    cooldown_cutoff = database.now_ny_naive() - timedelta(days=database.get_radio_cooldown_days())
    try:
        cur = db.cursor()
        cur.execute("""
            SELECT id, track_name, artist_name, album_name, spotify_album_art_url
            FROM known_tracks
            WHERE spotify_checked IS TRUE AND spotify_track_id IS NOT NULL
                AND (last_played_at IS NULL OR last_played_at < %s)
            ORDER BY random()
            LIMIT %s
        """, (cooldown_cutoff, max(limit * 3, limit)))  # over-fetch - seen_keys will drop some
        known_rows = cur.fetchall()
        cur.execute("""
            SELECT id, track_name, artist_name, album_name, spotify_track_id, spotify_album_art_url
            FROM radio_discovered_tracks
            WHERE (last_played_at IS NULL OR last_played_at < %s)
            ORDER BY random()
            LIMIT %s
        """, (cooldown_cutoff, max(limit * 3, limit)))
        discovered_rows = cur.fetchall()
        cur.close()
    except Exception as e:
        print(f"Error finding any cached track for radio: {e}")
        return []
    results = []
    for track_id, track_name, artist_name, album_name, artwork_url in known_rows:
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
    for row in discovered_rows:
        if len(results) >= limit:
            break
        track_id, track_name, artist_name, album_name, spotify_track_id, artwork_url = row
        key = radio_track_key(track_name, artist_name)
        if key in seen:
            continue
        seen.add(key)
        results.append(_discovered_track_row(track_id, track_name, artist_name, album_name, spotify_track_id, artwork_url))
    return results


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
            SELECT id, track_name, artist_name, album_name, spotify_album_art_url
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
    for track_id, track_name, artist_name, album_name, artwork_url in known_rows:
        index[(track_name.lower(), artist_name.lower())] = {
            'id': track_id, 'track_name': track_name, 'artist_name': artist_name,
            'album_name': album_name, 'artwork_url': artwork_url,
        }
    return index


def _bootstrap_track_frontier(session):
    """Builds a fresh one-item track_frontier when none is persisted yet (a
    brand new session, or the rare case where even the artist-fallback
    hasn't produced anything) - from the session's literal seed track when
    it has one, otherwise a single representative top-track for the seed
    artist, so track-level discovery has somewhere to start even for an
    artist-seeded (no specific track picked) session."""
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
    return [{'artist_name': seed_artist, 'track_name': seed_track, 'depth': 0}]


def _artist_fallback_candidates(session, artists_encountered, fallback_expanded):
    """The reserve tier - see generate_radio_batch_track_first's own
    docstring (tier 2). Tries the original seed artist first (if not
    already expanded this session), then whichever artist has actually
    turned up among genuinely-added candidates so far but hasn't been
    expanded yet - pulling ARTIST_FALLBACK_TOP_TRACKS_LIMIT top tracks for
    it plus one bootstrap track per newly-surfaced similar artist (up to
    ARTIST_FALLBACK_SIMILAR_LIMIT of them). Stops at the first artist that
    yields anything rather than draining the whole candidate list in one
    call - deliberately mirrors the tiny footprint the live simulation
    validated (one artist's worth of expansion was enough to fuel another
    140+ tracks of pure track-level discovery afterward).

    Returns (candidates, updated fallback_expanded list) - candidates are
    plain {'artist_name', 'track_name', 'selection_reason', 'selection_engine'}
    dicts, not yet checked against seen/cooldown (the caller's try_add does
    that, same as every other tier funnels through one single check)."""
    seed_artists = session.get('seed_artists') or []
    seed_artist = session.get('seed_artist_name') or (seed_artists[0] if seed_artists else None)
    ordered_candidates = []
    for a in ([seed_artist] if seed_artist else []) + list(seed_artists) + artists_encountered:
        if a and a not in ordered_candidates:
            ordered_candidates.append(a)

    expanded_lower = set(fallback_expanded)
    for artist in ordered_candidates:
        key_a = artist.strip().lower()
        if key_a in expanded_lower:
            continue
        expanded_lower.add(key_a)

        candidates = []
        for track_name in lastfm._get_top_tracks(artist, limit=ARTIST_FALLBACK_TOP_TRACKS_LIMIT):
            # Both sub-cases below come from this same reserve tier (an
            # already-established artist's own catalog, or a brand new
            # similar artist bootstrapped off it) - kept under one shared
            # "Discovered - similar artist" label (matching "Discovered -
            # similar track" for tier 1) rather than each carrying its own
            # one-off detail string, so the Play Log's reason column stays a
            # small, genuinely filterable set of categories instead of a
            # different value practically every row. Still Last.fm-driven
            # (getTopTracks/getSimilar), same engine as tier 1.
            candidates.append({
                'artist_name': artist, 'track_name': track_name,
                'selection_reason': 'Discovered - similar artist', 'selection_engine': 'Last.fm',
            })
        for name, match in lastfm._get_similar_artists(artist, limit=ARTIST_FALLBACK_SIMILAR_LIMIT):
            if match < lastfm.MIN_ARTIST_MATCH_SCORE or name.strip().lower() in expanded_lower:
                continue
            bootstrap = lastfm._get_top_tracks(name, limit=1)
            if not bootstrap:
                continue
            candidates.append({
                'artist_name': name, 'track_name': bootstrap[0],
                'selection_reason': 'Discovered - similar artist', 'selection_engine': 'Last.fm',
            })

        if candidates:
            return candidates, sorted(expanded_lower)
    return [], sorted(expanded_lower)


def generate_radio_batch_track_first(session, seen_keys, count, db):
    """Track-first Radio candidate generation for a Spotify-destination
    session - replaces the old artist-only generate_radio_batch_for_spotify.
    Validated via live simulation (not just design) before being built:
    track-level recursion alone reached 100+ genuinely varied, on-theme
    tracks from a single seed using a dozen-odd Last.fm calls, without the
    old approach's failure mode - a narrow seed's similar-artist
    neighborhood exhausting within an hour of a long unattended session,
    then falling back to whichever library artist happened to have the
    deepest cached catalog (confirmed live: a 9-hour ABBA session spent most
    of its second half replaying Bee Gees, purely because Bee Gees had 67
    cached tracks against 0-3 for most of ABBA's other genuine similar
    artists).

    Tier 1 (primary): lastfm.track_similar_tracks, called recursively -
    every genuinely new track this finds becomes a fresh seed for its own
    track.getSimilar call, up to TRACK_HOP_MAX_DEPTH hops from wherever it
    was discovered, via track_frontier - a BFS queue persisted on the
    radio_session row (database.set_radio_session_track_state) so it
    survives across /more calls and playback_advancer refill ticks instead
    of restarting from the seed on every call.

    Tier 2 (fallback, only once the track frontier is genuinely empty):
    _artist_fallback_candidates - the artist-level bundle, re-anchored on
    the original seed artist (or the next not-yet-expanded artist
    encountered via track-hops), feeding straight back into track_frontier
    so track-level resumes as the primary driver immediately after -
    fallback_expanded_artists (also persisted) stops this from redundantly
    re-expanding the same artist on a later call.

    Tier 3 (absolute last resort, only if tiers 1 and 2 are both exhausted
    within this same call): find_any_cached_tracks - any already-matched
    library track at all, no artist filter. "Radio must never just stop"
    still applies, but per explicit user request this is now a genuine last
    resort, not an early or frequent fallback.

    Every candidate from tiers 1 and 2 is checked against a single
    seen/cooldown gate (try_add below) before being kept - cooldown
    (database.get_recently_played_keys) excludes a track this app already
    recorded a recent play for, regardless of which tier proposed it. Every
    kept candidate is then checked against the cache index
    (_index_cached_tracks_by_key, built from whatever artists actually
    showed up in this batch) - a cache hit comes back pre-resolved
    (spotify_uri/id set, so playback_advancer's matching loop needs zero
    live search for it), a miss is left as a plain text candidate for a
    live search at actual match time. Every candidate carries
    selection_reason/selection_engine - persisted onto last_played_reason/
    last_played_engine once actually played (database._record_track_played)
    and surfaced in the Play Log as two separate columns.

    Returns (tracks, new_track_frontier, new_fallback_expanded_artists, degraded).
    degraded=True only when tier 3 had to be used."""
    seen = set(seen_keys)
    frontier = [dict(f) for f in (session.get('track_frontier') or [])]
    fallback_expanded = list(session.get('fallback_expanded_artists') or [])
    cooldown_keys = database.get_recently_played_keys(
        database.now_ny_naive() - timedelta(days=database.get_radio_cooldown_days())
    )
    for f in frontier:
        seen.add(radio_track_key(f['track_name'], f['artist_name']))
    if not frontier:
        frontier = _bootstrap_track_frontier(session)
        for f in frontier:
            seen.add(radio_track_key(f['track_name'], f['artist_name']))

    collected = []
    artists_encountered = []

    def try_add(artist_name, track_name, reason, engine):
        key = radio_track_key(track_name, artist_name)
        if key in seen or key in cooldown_keys:
            return None
        seen.add(key)
        entry = {'artist_name': artist_name, 'track_name': track_name, 'selection_reason': reason, 'selection_engine': engine}
        collected.append(entry)
        artists_encountered.append(artist_name)
        return entry

    fallback_attempted = False
    while len(collected) < count:
        if not frontier:
            if fallback_attempted:
                break
            fallback_attempted = True
            fallback_candidates, fallback_expanded = _artist_fallback_candidates(
                session, artists_encountered, fallback_expanded,
            )
            added_any = False
            for c in fallback_candidates:
                if try_add(c['artist_name'], c['track_name'], c['selection_reason'], c['selection_engine']) is not None:
                    frontier.append({'artist_name': c['artist_name'], 'track_name': c['track_name'], 'depth': 0})
                    added_any = True
            if not added_any:
                break
            continue

        parent = frontier.pop(0)
        for s in lastfm.track_similar_tracks(parent['artist_name'], parent['track_name']):
            entry = try_add(s['artist_name'], s['track_name'], 'Discovered - similar track', 'Last.fm')
            if entry is not None and parent['depth'] + 1 <= TRACK_HOP_MAX_DEPTH:
                frontier.append({'artist_name': s['artist_name'], 'track_name': s['track_name'], 'depth': parent['depth'] + 1})
            if len(collected) >= count:
                break

    degraded = False
    if len(collected) < count:
        # Tier 3 - see docstring. Only reached if both Last.fm-driven tiers
        # above genuinely ran dry within this same call. Pure local DB
        # query, no external recommendation engine involved at all - "App
        # logic" reflects that honestly rather than crediting Last.fm for a
        # pick it had nothing to do with.
        degraded = True
        for c in find_any_cached_tracks(list(seen), count - len(collected), db):
            c['selection_reason'] = 'library fallback'
            c['selection_engine'] = 'App logic'
            collected.append(c)
            seen.add(radio_track_key(c['track_name'], c['artist_name']))

    # Cache-check every plain-text candidate (tier 3's own rows are already
    # pre-resolved, nothing more to do for those) - reduces how many
    # candidates actually need a live Spotify search at match time.
    text_candidates = [c for c in collected if 'id' not in c and 'spotify_uri' not in c]
    cached_by_key = _index_cached_tracks_by_key(list({c['artist_name'] for c in text_candidates}), db)
    final = []
    for c in collected:
        if 'id' in c or 'spotify_uri' in c:
            final.append(c)
            continue
        cached = cached_by_key.get((c['track_name'].lower(), c['artist_name'].lower()))
        final.append(
            {**cached, 'selection_reason': c['selection_reason'], 'selection_engine': c.get('selection_engine')}
            if cached else c
        )

    return final[:count], frontier, fallback_expanded, degraded
