import time

from . import spotify_connect

# Unlike spotify_prewarm.py, this job makes zero Spotify API calls (see
# spotify_connect.identify_via_shazam) - it can't compete with interactive
# Spotify use for Spotify's rate limit, so it isn't gated on app idleness at
# all. Still paced, though: Shazam Core's own RapidAPI free-tier quota is
# unknown, and audio recognition costs real CPU/IO to decode each file, so
# this isn't sped up to "as fast as possible" either.
BATCH_SIZE = 5
INTERVAL_SECONDS = 30


def run(get_connection, progress):
    """Runs forever on a background thread, started unconditionally at app
    startup (same shape as playback_advancer.run) - continuously identifies
    tracks whose isrc is still unknown via Shazam alone, independent of
    Spotify's rate-limit state or this app's own idle-detection.

    Deliberately not scoped to spotify_checked IS NOT TRUE - a track already
    confirmed to have no direct/YouTube-Music-bridged Spotify match (a real,
    common outcome - see spotify_prewarm.py) never gets revisited by that
    job, but Shazam identification is still worth attempting for it; only
    isrc IS NULL matters here."""
    progress.update(status='running', processed=0, identified=0, error=None)

    while True:
        conn = get_connection()
        if conn is None:
            progress.update(status='error', error='Could not connect to the database')
            return
        try:
            cur = conn.cursor()
            cur.execute("""
                SELECT id, track_name, artist_name, file_path FROM known_tracks
                WHERE isrc IS NULL ORDER BY RANDOM() LIMIT %s
            """, (BATCH_SIZE,))
            rows = cur.fetchall()
            cur.close()
            if not rows:
                progress['status'] = 'done'
                return

            for track_id, track_name, artist_name, file_path in rows:
                identified = spotify_connect.identify_via_shazam(track_name, artist_name, file_path=file_path)
                progress['processed'] += 1
                if identified:
                    cur = conn.cursor()
                    cur.execute("""
                        UPDATE known_tracks SET
                            track_name = %s, artist_name = %s,
                            original_track_name = COALESCE(original_track_name, track_name),
                            original_artist_name = COALESCE(original_artist_name, artist_name),
                            isrc = %s,
                            album_name = COALESCE(album_name, %s),
                            year = COALESCE(year, %s)
                        WHERE id = %s
                    """, (identified['track_name'], identified['artist_name'], identified['isrc'],
                          identified.get('album_name'), identified.get('year'), track_id))
                    conn.commit()
                    cur.close()
                    progress['identified'] += 1
            progress.update(status='running', error=None)
        except Exception as e:
            progress.update(status='error', error=str(e))
        finally:
            conn.close()
        time.sleep(INTERVAL_SECONDS)
