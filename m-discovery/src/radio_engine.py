"""Shared Last.fm-based similar-track generation for the Radio feature -
plain-dict, no FastAPI/pydantic dependency, so both main.py's synchronous
/api/radio/* routes and playback_advancer.py's background thread (which needs
to keep a Spotify-destination radio session refilling itself once a browser
tab backgrounds/closes) can call the exact same logic instead of duplicating
it. main.py wraps the plain dicts this returns into its own Track pydantic
model for its response bodies; playback_advancer.py uses them as-is.
"""

from . import lastfm

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
