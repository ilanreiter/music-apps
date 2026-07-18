import os
import psycopg2
from psycopg2 import Error
from psycopg2.extras import Json

def get_db_connection():
    """Establishes and returns a database connection."""
    try:
        conn = psycopg2.connect(
            user=os.getenv("DB_USER"),
            password=os.getenv("DB_PASSWORD"),
            host=os.getenv("DB_HOST"),
            port=os.getenv("DB_PORT"),
            database=os.getenv("DB_NAME")
        )
        return conn
    except Error as e:
        print(f"Error connecting to PostgreSQL database: {e}")
        return None

def create_tables():
    """Creates the known_tracks and discovery_history tables if they don't exist."""
    conn = None
    try:
        conn = get_db_connection()
        if conn:
            cur = conn.cursor()
            
            # Create known_tracks table
            cur.execute("""
                CREATE TABLE IF NOT EXISTS known_tracks (
                    id SERIAL PRIMARY KEY,
                    track_name TEXT NOT NULL,
                    artist_name TEXT NOT NULL,
                    album_name TEXT,
                    is_favorite BOOLEAN DEFAULT FALSE,
                    last_played TIMESTAMP,
                    UNIQUE(track_name, artist_name)
                );
            """)
            print("Table 'known_tracks' checked/created successfully.")

            # Migrate known_tracks for local library ingestion: add tag/file columns.
            # The same track_name+artist_name can legitimately appear on multiple
            # files (compilations, live versions), so file_path replaces it as the
            # identity for scanned rows; the old constraint is dropped accordingly.
            cur.execute("""
                ALTER TABLE known_tracks
                    ADD COLUMN IF NOT EXISTS file_path TEXT,
                    ADD COLUMN IF NOT EXISTS genre TEXT,
                    ADD COLUMN IF NOT EXISTS year INTEGER,
                    ADD COLUMN IF NOT EXISTS duration_seconds INTEGER,
                    ADD COLUMN IF NOT EXISTS bitrate INTEGER,
                    ADD COLUMN IF NOT EXISTS sample_rate INTEGER,
                    ADD COLUMN IF NOT EXISTS channels INTEGER,
                    ADD COLUMN IF NOT EXISTS file_size_bytes BIGINT,
                    ADD COLUMN IF NOT EXISTS track_number INTEGER,
                    ADD COLUMN IF NOT EXISTS track_total INTEGER,
                    ADD COLUMN IF NOT EXISTS has_artwork BOOLEAN,
                    ADD COLUMN IF NOT EXISTS date_added TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    ADD COLUMN IF NOT EXISTS spotify_track_id TEXT,
                    ADD COLUMN IF NOT EXISTS spotify_url TEXT,
                    ADD COLUMN IF NOT EXISTS spotify_popularity INTEGER,
                    ADD COLUMN IF NOT EXISTS spotify_album_art_url TEXT,
                    ADD COLUMN IF NOT EXISTS spotify_checked BOOLEAN DEFAULT FALSE,
                    ADD COLUMN IF NOT EXISTS external_artwork_checked BOOLEAN DEFAULT FALSE,
                    ADD COLUMN IF NOT EXISTS artwork_source_url TEXT,
                    ADD COLUMN IF NOT EXISTS tag_cleanup_checked BOOLEAN DEFAULT FALSE,
                    ADD COLUMN IF NOT EXISTS original_track_name TEXT,
                    ADD COLUMN IF NOT EXISTS original_artist_name TEXT,
                    ADD COLUMN IF NOT EXISTS isrc TEXT;
            """)
            cur.execute("""
                ALTER TABLE known_tracks
                    DROP CONSTRAINT IF EXISTS known_tracks_track_name_artist_name_key;
            """)
            cur.execute("""
                CREATE UNIQUE INDEX IF NOT EXISTS known_tracks_file_path_idx
                    ON known_tracks (file_path) WHERE file_path IS NOT NULL;
            """)
            print("Table 'known_tracks' migrated for library scanning.")

            # Create discovery_history table
            cur.execute("""
                CREATE TABLE IF NOT EXISTS discovery_history (
                    id SERIAL PRIMARY KEY,
                    generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    prompt_used TEXT,
                    track_list JSONB
                );
            """)
            print("Table 'discovery_history' checked/created successfully.")

            # Spotify Connect OAuth tokens - single row (id=1), this is a
            # personal single-user tool so there's no per-user table.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS spotify_auth (
                    id INTEGER PRIMARY KEY DEFAULT 1,
                    access_token TEXT,
                    refresh_token TEXT,
                    expires_at BIGINT,
                    scope TEXT,
                    updated_at TIMESTAMP DEFAULT NOW()
                );
            """)
            print("Table 'spotify_auth' checked/created successfully.")

            # Server-side mirror of the frontend's queue/nowPlaying/destination
            # state - single row (id=1), same personal-single-user-tool pattern
            # as spotify_auth. Exists so a background poller can keep playback
            # advancing to the next track even when no browser tab is open to
            # drive it (the frontend's own setInterval-based poll dies the
            # moment a phone locks or a tab backgrounds).
            cur.execute("""
                CREATE TABLE IF NOT EXISTS playback_session (
                    id INTEGER PRIMARY KEY DEFAULT 1,
                    destination_type TEXT,
                    destination_id TEXT,
                    now_playing JSONB,
                    queue JSONB,
                    shuffle_enabled BOOLEAN DEFAULT FALSE,
                    spotify_match_pool JSONB,
                    chromecast_pushed_count INTEGER,
                    last_status JSONB,
                    updated_at TIMESTAMP DEFAULT NOW()
                );
            """)
            print("Table 'playback_session' checked/created successfully.")

            conn.commit()
            cur.close()
    except Error as e:
        print(f"Error creating tables: {e}")
    finally:
        if conn:
            conn.close()


def save_spotify_tokens(access_token, refresh_token, expires_at, scope):
    """Upserts the single spotify_auth row. refresh_token is only sent by
    Spotify on the very first authorization, not on subsequent refreshes -
    callers pass None in that case and the existing refresh_token is kept."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        if refresh_token:
            cur.execute("""
                INSERT INTO spotify_auth (id, access_token, refresh_token, expires_at, scope, updated_at)
                VALUES (1, %s, %s, %s, %s, NOW())
                ON CONFLICT (id) DO UPDATE SET
                    access_token = EXCLUDED.access_token,
                    refresh_token = EXCLUDED.refresh_token,
                    expires_at = EXCLUDED.expires_at,
                    scope = EXCLUDED.scope,
                    updated_at = NOW()
            """, (access_token, refresh_token, expires_at, scope))
        else:
            cur.execute("""
                INSERT INTO spotify_auth (id, access_token, expires_at, scope, updated_at)
                VALUES (1, %s, %s, %s, NOW())
                ON CONFLICT (id) DO UPDATE SET
                    access_token = EXCLUDED.access_token,
                    expires_at = EXCLUDED.expires_at,
                    scope = EXCLUDED.scope,
                    updated_at = NOW()
            """, (access_token, expires_at, scope))
        conn.commit()
        cur.close()
    except Error as e:
        print(f"Error saving Spotify tokens: {e}")
    finally:
        if conn:
            conn.close()


def get_spotify_tokens():
    """Returns {'access_token', 'refresh_token', 'expires_at', 'scope'} or None."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("SELECT access_token, refresh_token, expires_at, scope FROM spotify_auth WHERE id = 1")
        row = cur.fetchone()
        cur.close()
        if not row or not row[1]:
            return None
        return {'access_token': row[0], 'refresh_token': row[1], 'expires_at': row[2], 'scope': row[3]}
    except Error as e:
        print(f"Error reading Spotify tokens: {e}")
        return None
    finally:
        if conn:
            conn.close()


def clear_spotify_tokens():
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("DELETE FROM spotify_auth WHERE id = 1")
        conn.commit()
        cur.close()
    except Error as e:
        print(f"Error clearing Spotify tokens: {e}")
    finally:
        if conn:
            conn.close()


def save_playback_session(destination_type, destination_id, now_playing, queue,
                           shuffle_enabled=False, spotify_match_pool=None,
                           chromecast_pushed_count=None, last_status=None):
    """Upserts the single playback_session row. Callers always pass the full
    set of fields they want persisted (not a partial patch) - the background
    advancer reads the row with SELECT ... FOR UPDATE before writing it back,
    so it always has the current values in hand for whichever fields it isn't
    actively changing."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO playback_session (id, destination_type, destination_id, now_playing, queue,
                                           shuffle_enabled, spotify_match_pool, chromecast_pushed_count,
                                           last_status, updated_at)
            VALUES (1, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
            ON CONFLICT (id) DO UPDATE SET
                destination_type = EXCLUDED.destination_type,
                destination_id = EXCLUDED.destination_id,
                now_playing = EXCLUDED.now_playing,
                queue = EXCLUDED.queue,
                shuffle_enabled = EXCLUDED.shuffle_enabled,
                spotify_match_pool = EXCLUDED.spotify_match_pool,
                chromecast_pushed_count = EXCLUDED.chromecast_pushed_count,
                last_status = EXCLUDED.last_status,
                updated_at = NOW()
        """, (
            destination_type, destination_id,
            Json(now_playing) if now_playing is not None else None,
            Json(queue) if queue is not None else None,
            shuffle_enabled,
            Json(spotify_match_pool) if spotify_match_pool is not None else None,
            chromecast_pushed_count,
            Json(last_status) if last_status is not None else None,
        ))
        conn.commit()
        cur.close()
    except Error as e:
        print(f"Error saving playback session: {e}")
    finally:
        if conn:
            conn.close()


def get_playback_session():
    """Returns the full row as a dict, or None if nothing has ever been saved."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("""
            SELECT destination_type, destination_id, now_playing, queue, shuffle_enabled,
                   spotify_match_pool, chromecast_pushed_count, last_status, updated_at
            FROM playback_session WHERE id = 1
        """)
        row = cur.fetchone()
        cur.close()
        if not row:
            return None
        return {
            'destination_type': row[0], 'destination_id': row[1], 'now_playing': row[2], 'queue': row[3],
            'shuffle_enabled': row[4], 'spotify_match_pool': row[5], 'chromecast_pushed_count': row[6],
            'last_status': row[7], 'updated_at': row[8].isoformat() if row[8] else None,
        }
    except Error as e:
        print(f"Error reading playback session: {e}")
        return None
    finally:
        if conn:
            conn.close()


def update_chromecast_pushed_count(count):
    """Targeted single-column update (not a full save_playback_session upsert)
    - called right after the interactive Chromecast /play route successfully
    sends its initial QUEUE_LOAD, so it can't race/clobber the frontend's own
    concurrent now_playing/queue session sync, which happens around the same
    moment from the same user action."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("UPDATE playback_session SET chromecast_pushed_count = %s, updated_at = NOW() WHERE id = 1", (count,))
        conn.commit()
        cur.close()
    except Error as e:
        print(f"Error updating chromecast_pushed_count: {e}")
    finally:
        if conn:
            conn.close()


def clear_playback_session():
    """Nulls out the active session (destination/now_playing/queue) rather than
    deleting the row - the background advancer always SELECTs id=1, so keeping
    a stable (empty) row avoids a "no row to lock yet" edge case on its very
    next poll tick."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("""
            UPDATE playback_session SET
                destination_type = NULL, destination_id = NULL, now_playing = NULL, queue = NULL,
                shuffle_enabled = FALSE, spotify_match_pool = NULL, chromecast_pushed_count = NULL,
                last_status = NULL, updated_at = NOW()
            WHERE id = 1
        """)
        conn.commit()
        cur.close()
    except Error as e:
        print(f"Error clearing playback session: {e}")
    finally:
        if conn:
            conn.close()

if __name__ == "__main__":
    # This block will be executed when database.py is run directly
    # It's useful for initial setup or testing the connection/table creation
    print("Attempting to create database tables...")
    create_tables()
    print("Database table creation process finished.")
