import time

from . import spotify_connect

# How long to wait between successful background checks - deliberately slow.
# This app's Spotify registration is on Development Mode with tight rate
# limits (confirmed live: a search that normally takes ~0.2s took ~3.2s once
# genuinely rate-limited from a burst of interactive testing), so this job is
# paced by song-length, not by how fast it could possibly go.
PREWARM_INTERVAL_SECONDS = 300
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
        try:
            cur = conn.cursor()
            cur.execute("SELECT id, track_name, artist_name FROM known_tracks WHERE spotify_checked IS NOT TRUE LIMIT 1")
            row = cur.fetchone()
            cur.close()
            if row is None:
                progress['status'] = 'done'
                return

            track_id, track_name, artist_name = row
            result, match = spotify_connect.search_track(track_name, artist_name)
            if result != 'unavailable':
                cur = conn.cursor()
                if match:
                    spotify_id = match['uri'].split(':')[-1]
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
            progress['status'] = 'running'
        finally:
            conn.close()
        time.sleep(delay)
