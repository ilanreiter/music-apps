import time

from . import spotify_connect

# How long to wait between batches of background checks. Originally 300s for
# a single track (deliberately slow - see BATCH_SIZE below for why that pace
# turned out unworkable), but this app's idle-detection also had a bug where
# routine device/group polling kept resetting the idle clock just under its
# 120s threshold - confirmed live: 11 hours of uptime produced only 1
# processed track. With that idle-detection gap fixed too, this interval
# governs the steady-state pace once the job can actually run.
PREWARM_INTERVAL_SECONDS = 90
# How many tracks to check per cycle before sleeping. At 1/cycle, a ~14k-track
# backlog would take ~48 days even running continuously - nowhere close to
# converging. This is a moderate bump (finishes in a few days, not weeks)
# while still leaving a real gap between batches, unlike blasting through the
# whole backlog at once (this app hit a Spotify Development-Mode rate-limit
# lockout from a burst of interactive calls once already - see search_track's
# docstring in spotify_connect.py).
BATCH_SIZE = 5
# How often to recheck whether it's safe to run (idle + Spotify connected)
# while waiting - much shorter than the interval above so the job starts
# promptly once conditions clear, without busy-waiting.
IDLE_POLL_INTERVAL_SECONDS = 30


def run(get_connection, progress, is_idle):
    """Slowly works through known_tracks where spotify_checked IS NOT TRUE,
    one row every PREWARM_INTERVAL_SECONDS, only while the app is idle (no
    recent requests - see main.py's activity-tracking middleware) and
    Spotify is connected. Runs in a background thread (started once at app
    startup if there's work to do) until the whole library is checked.

    Never marks a row checked on an 'unavailable' (rate-limited) result -
    same rule the interactive match endpoints already follow - so a track
    hit during a rate-limited stretch just gets tried again on a later
    cycle, not permanently miscategorized as "no match".
    """
    progress.update(status='running', processed=0, matched=0, error=None)

    while True:
        if not is_idle():
            progress['status'] = 'waiting_active_use'
            time.sleep(IDLE_POLL_INTERVAL_SECONDS)
            continue
        if not spotify_connect.is_connected():
            progress['status'] = 'waiting_not_connected'
            time.sleep(IDLE_POLL_INTERVAL_SECONDS)
            continue

        conn = get_connection()
        if conn is None:
            progress.update(status='error', error='Could not connect to the database')
            return
        # Always ends with exactly one time.sleep(delay) below, whichever
        # path was taken - a rate-limited result still needs to wait out the
        # full interval (retrying in 30s would just hit the same wall), not
        # skip the sleep and hammer the API again immediately.
        delay = PREWARM_INTERVAL_SECONDS
        done = False
        try:
            for _ in range(BATCH_SIZE):
                cur = conn.cursor()
                cur.execute("SELECT id, track_name, artist_name FROM known_tracks WHERE spotify_checked IS NOT TRUE LIMIT 1")
                row = cur.fetchone()
                cur.close()
                if row is None:
                    done = True
                    break

                track_id, track_name, artist_name = row
                result, match = spotify_connect.search_track(track_name, artist_name)
                if result == 'unavailable':
                    # Genuinely rate-limited (not just "no match") - stop this
                    # batch early rather than burning through the rest of it
                    # against the same wall, and let the full interval below
                    # be the backoff.
                    break

                cur = conn.cursor()
                if match:
                    spotify_id = match['uri'].split(':')[-1]
                    native_track_name = match.get('native_track_name')
                    native_artist_name = match.get('native_artist_name')
                    if native_track_name and native_artist_name:
                        # Matched via the YouTube Music bridge - correct the
                        # local tags to the native title/artist that actually
                        # worked, same reversible pattern as tag_cleanup.py
                        # (see main.py's _match_track_to_spotify for the fuller
                        # explanation - this mirrors it for the background job).
                        cur.execute("""
                            UPDATE known_tracks SET
                                track_name = %s, artist_name = %s,
                                original_track_name = COALESCE(original_track_name, track_name),
                                original_artist_name = COALESCE(original_artist_name, artist_name),
                                spotify_track_id = %s, spotify_url = %s, spotify_album_art_url = %s, spotify_checked = TRUE
                            WHERE id = %s
                        """, (native_track_name, native_artist_name, spotify_id,
                              f"https://open.spotify.com/track/{spotify_id}", match['artwork_url'], track_id))
                    else:
                        cur.execute("""
                            UPDATE known_tracks SET spotify_track_id = %s, spotify_url = %s,
                                spotify_album_art_url = %s, spotify_checked = TRUE
                            WHERE id = %s
                        """, (spotify_id, f"https://open.spotify.com/track/{spotify_id}", match['artwork_url'], track_id))
                    progress['matched'] += 1
                else:
                    cur.execute("UPDATE known_tracks SET spotify_checked = TRUE WHERE id = %s", (track_id,))
                conn.commit()
                cur.close()
                progress['processed'] += 1
            progress['status'] = 'done' if done else 'running'
        finally:
            conn.close()
        if done:
            return
        time.sleep(delay)
