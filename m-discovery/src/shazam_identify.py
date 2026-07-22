import time

from . import external_artwork, spotify_connect

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
    progress.update(status='running', processed=0, identified=0, artwork_found=0, error=None)

    while True:
        conn = get_connection()
        if conn is None:
            progress.update(status='error', error='Could not connect to the database')
            return
        try:
            cur = conn.cursor()
            cur.execute("""
                SELECT id, track_name, artist_name, album_name, file_path, has_artwork FROM known_tracks
                WHERE isrc IS NULL ORDER BY RANDOM() LIMIT %s
            """, (BATCH_SIZE,))
            rows = cur.fetchall()
            cur.close()
            if not rows:
                progress['status'] = 'done'
                return

            for track_id, track_name, artist_name, album_name, file_path, has_artwork in rows:
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

                    # Opportunistic artwork save: identify_via_shazam's own
                    # lookup (text search or audio recognition, whichever
                    # matched) already carries an artwork_url for free, no
                    # extra Shazam/RapidAPI call needed to get it. Only
                    # attempted when has_artwork is the explicit FALSE the
                    # Check Artwork job sets (not NULL, i.e. not yet locally
                    # checked - COALESCE below would silently no-op against a
                    # NULL row anyway) and mark_checked_on_miss=False, since
                    # this is only one source (Shazam) among the dedicated
                    # backfill job's full chain - a miss here must leave the
                    # row alone so that job still gets its turn at it.
                    if identified.get('artwork_url') and has_artwork is False:
                        final_album_name = album_name or identified.get('album_name')
                        raw = external_artwork.download_bytes(identified['artwork_url'])
                        art_result = {'raw': raw, 'year': None, 'source_url': None} if raw else None
                        found = external_artwork.apply_artwork_result(
                            conn, track_id, identified['artist_name'], final_album_name,
                            existing_year=None, result=art_result, mark_checked_on_miss=False,
                        )
                        if found:
                            progress['artwork_found'] += 1
            progress.update(status='running', error=None)
        except Exception as e:
            progress.update(status='error', error=str(e))
        finally:
            conn.close()
        time.sleep(INTERVAL_SECONDS)
