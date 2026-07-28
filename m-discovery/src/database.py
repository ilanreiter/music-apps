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
                    ADD COLUMN IF NOT EXISTS isrc TEXT,
                    ADD COLUMN IF NOT EXISTS ytmusic_video_id TEXT,
                    ADD COLUMN IF NOT EXISTS ytmusic_checked BOOLEAN DEFAULT FALSE;
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

            # YouTube Music OAuth tokens (device-code flow) - single row (id=1),
            # same personal-single-user-tool pattern as spotify_auth. No
            # token_type column - Google always returns 'Bearer', hardcoded by
            # ytmusic_connect when it reconstructs the auth dict.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS yt_music_auth (
                    id INTEGER PRIMARY KEY DEFAULT 1,
                    access_token TEXT,
                    refresh_token TEXT,
                    expires_at BIGINT,
                    scope TEXT,
                    updated_at TIMESTAMP DEFAULT NOW()
                );
            """)
            print("Table 'yt_music_auth' checked/created successfully.")

            # Multi-day paced YouTube Music playlist push, as a real FIFO
            # queue - a push larger than the app can complete in one request
            # (YTMUSIC_LIBRARY_PUSH_LIMIT in main.py) becomes a background job
            # that spends YouTube Data API quota a little at a time across
            # days rather than all at once (see ytmusic_push_job.py). Started
            # as a single-row (id=1) table (one job at a time, rejecting a
            # second push outright); migrated below to a real auto-incrementing
            # id so multiple pushes can be queued and processed in FIFO order
            # by the same worker instead of being rejected while one is
            # already active. units_spent_today/quota_day track the
            # currently-active job's own self-imposed daily budget (separate
            # from units_spent_total/tracks_processed_total, cumulative across
            # that job's life and driving the pace/ETA estimate in main.py).
            cur.execute("""
                CREATE TABLE IF NOT EXISTS ytmusic_push_job (
                    id INTEGER PRIMARY KEY DEFAULT 1,
                    name TEXT,
                    playlist_id TEXT,
                    status TEXT,
                    total INTEGER,
                    matched INTEGER DEFAULT 0,
                    inserted INTEGER DEFAULT 0,
                    skipped INTEGER DEFAULT 0,
                    units_spent_today INTEGER DEFAULT 0,
                    quota_day DATE,
                    units_spent_total INTEGER DEFAULT 0,
                    tracks_processed_total INTEGER DEFAULT 0,
                    started_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW(),
                    error TEXT
                );
            """)
            # Convert the fixed id=1 default into a real auto-incrementing
            # sequence, preserving any existing row (and its id) exactly -
            # ALTER COLUMN ... SET DEFAULT and ALTER SEQUENCE ... OWNED BY are
            # both safe to re-run every startup. setval reads the table's own
            # current max id each time, so a sequence that's already advanced
            # past it (from real inserts since) is never pushed backward.
            cur.execute("CREATE SEQUENCE IF NOT EXISTS ytmusic_push_job_id_seq;")
            cur.execute("ALTER TABLE ytmusic_push_job ALTER COLUMN id SET DEFAULT nextval('ytmusic_push_job_id_seq');")
            cur.execute("ALTER SEQUENCE ytmusic_push_job_id_seq OWNED BY ytmusic_push_job.id;")
            cur.execute("SELECT setval('ytmusic_push_job_id_seq', GREATEST((SELECT COALESCE(MAX(id), 0) FROM ytmusic_push_job), 1));")
            cur.execute("ALTER TABLE ytmusic_push_job ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();")
            # Backfill for a row that pre-dates this column - a fresh INSERT's
            # own DEFAULT NOW() already covers new rows.
            cur.execute("UPDATE ytmusic_push_job SET created_at = started_at WHERE created_at IS NULL;")
            print("Table 'ytmusic_push_job' checked/created successfully.")

            # One row per track targeted by a ytmusic_push_job. job_id
            # (added below, backfilled to 1 for rows that pre-date the
            # multi-job queue) replaces position as the sole primary key,
            # since position now only needs to be unique within a job, not
            # globally. known_track_id is set only for library-sourced tracks
            # (not Discover's, which have no known_tracks row) - lets the job
            # opportunistically write a match back into
            # known_tracks.ytmusic_video_id for future reuse.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS ytmusic_push_job_tracks (
                    position INTEGER PRIMARY KEY,
                    track_name TEXT NOT NULL,
                    artist_name TEXT NOT NULL,
                    native_track_name TEXT,
                    native_artist_name TEXT,
                    known_track_id INTEGER,
                    video_id TEXT,
                    processed BOOLEAN DEFAULT FALSE
                );
            """)
            cur.execute("ALTER TABLE ytmusic_push_job_tracks ADD COLUMN IF NOT EXISTS job_id INTEGER;")
            cur.execute("UPDATE ytmusic_push_job_tracks SET job_id = 1 WHERE job_id IS NULL;")
            cur.execute("ALTER TABLE ytmusic_push_job_tracks ALTER COLUMN job_id SET NOT NULL;")
            cur.execute("ALTER TABLE ytmusic_push_job_tracks DROP CONSTRAINT IF EXISTS ytmusic_push_job_tracks_pkey;")
            cur.execute("""
                DO $$
                BEGIN
                    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ytmusic_push_job_tracks_pkey') THEN
                        ALTER TABLE ytmusic_push_job_tracks ADD CONSTRAINT ytmusic_push_job_tracks_pkey PRIMARY KEY (job_id, position);
                    END IF;
                END $$;
            """)
            cur.execute("""
                DO $$
                BEGIN
                    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ytmusic_push_job_tracks_job_id_fkey') THEN
                        ALTER TABLE ytmusic_push_job_tracks
                            ADD CONSTRAINT ytmusic_push_job_tracks_job_id_fkey FOREIGN KEY (job_id) REFERENCES ytmusic_push_job(id);
                    END IF;
                END $$;
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS ytmusic_push_job_tracks_job_id_idx ON ytmusic_push_job_tracks (job_id);")
            print("Table 'ytmusic_push_job_tracks' checked/created successfully.")

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


def save_ytmusic_tokens(access_token, refresh_token, expires_at, scope):
    """Upserts the single yt_music_auth row. Google's device-flow refresh
    tokens aren't rotated on refresh (unlike Spotify's, which occasionally
    sends a new one) - callers pass None for refresh_token on a refresh call
    and the existing one is kept, same shape as save_spotify_tokens."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        if refresh_token:
            cur.execute("""
                INSERT INTO yt_music_auth (id, access_token, refresh_token, expires_at, scope, updated_at)
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
                INSERT INTO yt_music_auth (id, access_token, expires_at, scope, updated_at)
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
        print(f"Error saving YouTube Music tokens: {e}")
    finally:
        if conn:
            conn.close()


def get_ytmusic_tokens():
    """Returns {'access_token', 'refresh_token', 'expires_at', 'scope'} or None."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("SELECT access_token, refresh_token, expires_at, scope FROM yt_music_auth WHERE id = 1")
        row = cur.fetchone()
        cur.close()
        if not row or not row[1]:
            return None
        return {'access_token': row[0], 'refresh_token': row[1], 'expires_at': row[2], 'scope': row[3]}
    except Error as e:
        print(f"Error reading YouTube Music tokens: {e}")
        return None
    finally:
        if conn:
            conn.close()


def clear_ytmusic_tokens():
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("DELETE FROM yt_music_auth WHERE id = 1")
        conn.commit()
        cur.close()
    except Error as e:
        print(f"Error clearing YouTube Music tokens: {e}")
    finally:
        if conn:
            conn.close()


def enqueue_ytmusic_push_job(name, tracks):
    """Adds a new job to the back of the FIFO queue (status='queued') and
    populates its ytmusic_push_job_tracks rows - called whenever a push is
    too large to complete in one request (see main.py's
    YTMUSIC_LIBRARY_PUSH_LIMIT branch), whether or not another job is
    already running/waiting/queued ahead of it. tracks: ordered list of dicts
    with track_name/artist_name (required) and
    native_track_name/native_artist_name/known_track_id (optional, None if
    absent). Returns the new job's id. The worker (ytmusic_push_job.run)
    promotes queued jobs to 'running' itself, in id order, once whatever's
    ahead of them finishes."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO ytmusic_push_job (name, playlist_id, status, total, matched, inserted, skipped,
                                           units_spent_today, quota_day, units_spent_total, tracks_processed_total,
                                           started_at, updated_at, error)
            VALUES (%s, NULL, 'queued', %s, 0, 0, 0, 0, CURRENT_DATE, 0, 0, NOW(), NOW(), NULL)
            RETURNING id
        """, (name, len(tracks)))
        job_id = cur.fetchone()[0]
        cur.executemany(
            """
            INSERT INTO ytmusic_push_job_tracks
                (job_id, position, track_name, artist_name, native_track_name, native_artist_name, known_track_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            """,
            [
                (job_id, i, t['track_name'], t['artist_name'], t.get('native_track_name'), t.get('native_artist_name'), t.get('known_track_id'))
                for i, t in enumerate(tracks)
            ],
        )
        conn.commit()
        cur.close()
        return job_id
    except Error as e:
        print(f"Error enqueueing YouTube Music push job: {e}")
        return None
    finally:
        if conn:
            conn.close()


def _row_to_ytmusic_push_job(row):
    return {
        'id': row[0], 'name': row[1], 'playlist_id': row[2], 'status': row[3], 'total': row[4],
        'matched': row[5], 'inserted': row[6], 'skipped': row[7],
        'units_spent_today': row[8], 'quota_day': row[9],
        'units_spent_total': row[10], 'tracks_processed_total': row[11],
        'started_at': row[12].isoformat() if row[12] else None,
        'updated_at': row[13].isoformat() if row[13] else None,
        'error': row[14],
    }


_YTMUSIC_PUSH_JOB_SELECT = """
    SELECT id, name, playlist_id, status, total, matched, inserted, skipped,
           units_spent_today, quota_day, units_spent_total, tracks_processed_total,
           started_at, updated_at, error
    FROM ytmusic_push_job
"""


def get_active_ytmusic_push_job():
    """The job currently being worked (status running or waiting_quota), or
    None if nothing is actively in flight right now - at most one row should
    ever match, since the worker processes the queue strictly in order."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(_YTMUSIC_PUSH_JOB_SELECT + " WHERE status IN ('running', 'waiting_quota') ORDER BY id ASC LIMIT 1")
        row = cur.fetchone()
        cur.close()
        return _row_to_ytmusic_push_job(row) if row else None
    except Error as e:
        print(f"Error reading active YouTube Music push job: {e}")
        return None
    finally:
        if conn:
            conn.close()


def get_next_queued_ytmusic_push_job():
    """Oldest still-queued job (not yet started) - used by the worker to
    pick up the next one once whatever was active finishes."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(_YTMUSIC_PUSH_JOB_SELECT + " WHERE status = 'queued' ORDER BY id ASC LIMIT 1")
        row = cur.fetchone()
        cur.close()
        return _row_to_ytmusic_push_job(row) if row else None
    except Error as e:
        print(f"Error reading next queued YouTube Music push job: {e}")
        return None
    finally:
        if conn:
            conn.close()


def count_queued_ytmusic_push_jobs():
    """How many jobs are waiting their turn behind whatever's currently
    active (or about to become active) - for showing queue depth in the UI."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM ytmusic_push_job WHERE status = 'queued'")
        count = cur.fetchone()[0]
        cur.close()
        return count
    except Error as e:
        print(f"Error counting queued YouTube Music push jobs: {e}")
        return 0
    finally:
        if conn:
            conn.close()


def has_pending_ytmusic_push_work():
    """True if any job is queued, running, or paused on quota - used at app
    startup to decide whether to restart the background worker (its
    in-memory thread/lock don't survive a restart, same as spotify_prewarm's)."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("SELECT 1 FROM ytmusic_push_job WHERE status IN ('queued', 'running', 'waiting_quota') LIMIT 1")
        exists = cur.fetchone() is not None
        cur.close()
        return exists
    except Error as e:
        print(f"Error checking for pending YouTube Music push work: {e}")
        return False
    finally:
        if conn:
            conn.close()


def promote_ytmusic_push_job_to_running(job_id):
    """Transitions a queued job to running - called by the worker right
    before it starts processing that job's tracks."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("UPDATE ytmusic_push_job SET status = 'running', updated_at = NOW() WHERE id = %s", (job_id,))
        conn.commit()
        cur.close()
    except Error as e:
        print(f"Error promoting YouTube Music push job {job_id} to running: {e}")
    finally:
        if conn:
            conn.close()


def update_ytmusic_push_job_progress(job_id, status=None, playlist_id=None, matched_delta=0, inserted_delta=0,
                                      skipped_delta=0, units_spent_delta=0, tracks_processed_delta=0,
                                      reset_quota_day=False):
    """Incremental update after processing one track - called by
    ytmusic_push_job.run after every track so a mid-job restart resumes with
    accurate counters (no separate cursor: ytmusic_push_job_tracks.processed
    is the actual resume mechanism, this just keeps the reported stats
    correct). reset_quota_day starts a fresh daily budget window (see
    DAILY_SAFE_BUDGET in ytmusic_push_job.py) - units_spent_today becomes
    just this call's own delta rather than accumulating onto the previous
    day's number."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("""
            UPDATE ytmusic_push_job SET
                status = COALESCE(%(status)s, status),
                playlist_id = COALESCE(%(playlist_id)s, playlist_id),
                matched = matched + %(matched_delta)s,
                inserted = inserted + %(inserted_delta)s,
                skipped = skipped + %(skipped_delta)s,
                units_spent_today = CASE WHEN %(reset_quota_day)s THEN %(units_spent_delta)s
                                         ELSE units_spent_today + %(units_spent_delta)s END,
                quota_day = CASE WHEN %(reset_quota_day)s THEN CURRENT_DATE ELSE quota_day END,
                units_spent_total = units_spent_total + %(units_spent_delta)s,
                tracks_processed_total = tracks_processed_total + %(tracks_processed_delta)s,
                updated_at = NOW()
            WHERE id = %(job_id)s
        """, {
            'job_id': job_id, 'status': status, 'playlist_id': playlist_id,
            'matched_delta': matched_delta, 'inserted_delta': inserted_delta, 'skipped_delta': skipped_delta,
            'units_spent_delta': units_spent_delta, 'tracks_processed_delta': tracks_processed_delta,
            'reset_quota_day': reset_quota_day,
        })
        conn.commit()
        cur.close()
    except Error as e:
        print(f"Error updating YouTube Music push job {job_id} progress: {e}")
    finally:
        if conn:
            conn.close()


def set_ytmusic_push_job_error(job_id, message):
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("UPDATE ytmusic_push_job SET status = 'error', error = %s, updated_at = NOW() WHERE id = %s", (message, job_id))
        conn.commit()
        cur.close()
    except Error as e:
        print(f"Error setting YouTube Music push job {job_id} error: {e}")
    finally:
        if conn:
            conn.close()


def get_next_pending_push_track(job_id):
    """Returns the next unprocessed row (lowest position) for this specific
    job, or None if it's worked through everything - this predicate, not a
    separate stored cursor, is what makes the job resumable after a restart,
    same principle as known_tracks.spotify_checked."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("""
            SELECT position, track_name, artist_name, native_track_name, native_artist_name, known_track_id
            FROM ytmusic_push_job_tracks WHERE job_id = %s AND processed IS NOT TRUE ORDER BY position LIMIT 1
        """, (job_id,))
        row = cur.fetchone()
        cur.close()
        if not row:
            return None
        return {
            'position': row[0], 'track_name': row[1], 'artist_name': row[2],
            'native_track_name': row[3], 'native_artist_name': row[4], 'known_track_id': row[5],
        }
    except Error as e:
        print(f"Error reading next pending YouTube Music push track for job {job_id}: {e}")
        return None
    finally:
        if conn:
            conn.close()


def mark_push_track_processed(job_id, position, video_id):
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(
            "UPDATE ytmusic_push_job_tracks SET processed = TRUE, video_id = %s WHERE job_id = %s AND position = %s",
            (video_id, job_id, position),
        )
        conn.commit()
        cur.close()
    except Error as e:
        print(f"Error marking YouTube Music push track processed for job {job_id}: {e}")
    finally:
        if conn:
            conn.close()


def list_pending_ytmusic_push_jobs():
    """All jobs still owed work (queued, running, or paused on quota),
    oldest first - for showing the full queue in the UI once there's more
    than just the one active job to look at."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("""
            SELECT id, name, total, matched, tracks_processed_total, status, created_at
            FROM ytmusic_push_job
            WHERE status IN ('queued', 'running', 'waiting_quota')
            ORDER BY id ASC
        """)
        rows = cur.fetchall()
        cur.close()
        return [
            {
                'id': row[0], 'name': row[1], 'total': row[2], 'matched': row[3],
                'tracks_processed_total': row[4], 'status': row[5],
                'created_at': row[6].isoformat() if row[6] else None,
            }
            for row in rows
        ]
    except Error as e:
        print(f"Error listing pending YouTube Music push jobs: {e}")
        return []
    finally:
        if conn:
            conn.close()


def delete_ytmusic_push_job(job_id):
    """Removes a pending job (queued, running, or waiting_quota) and its
    track rows outright - the worker re-checks the queue fresh on every loop
    iteration (see ytmusic_push_job._get_job_to_work_on), so deleting the
    currently-active job out from under it is safe: its in-flight DB writes
    just become no-ops (job_id no longer exists), and the next iteration
    picks up whatever's next in the queue. Any playlist tracks already added
    before removal stay on YouTube Music as-is - this only stops future work,
    it doesn't undo what already landed. Returns True if a job was actually
    removed, False if job_id doesn't exist or isn't in a removable state
    (already done/error)."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(
            "SELECT 1 FROM ytmusic_push_job WHERE id = %s AND status IN ('queued', 'running', 'waiting_quota')",
            (job_id,),
        )
        removable = cur.fetchone() is not None
        if removable:
            # Child rows first - ytmusic_push_job_tracks_job_id_fkey has no
            # ON DELETE CASCADE, so deleting the parent row first would fail
            # with a foreign key violation while track rows still reference it.
            cur.execute("DELETE FROM ytmusic_push_job_tracks WHERE job_id = %s", (job_id,))
            cur.execute("DELETE FROM ytmusic_push_job WHERE id = %s", (job_id,))
        conn.commit()
        cur.close()
        return removable
    except Error as e:
        print(f"Error deleting YouTube Music push job {job_id}: {e}")
        return False
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
