import os
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
import psycopg2
from psycopg2 import Error
from psycopg2.extras import Json, execute_values

# Used to align the Spotify daily search counter/quota to America/New_York
# calendar days (per user request), regardless of what timezone the DB
# server itself runs in (confirmed to be UTC - see _ny_midnight_as_naive_utc).
NY_TZ = ZoneInfo('America/New_York')

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
                    ADD COLUMN IF NOT EXISTS ytmusic_checked BOOLEAN DEFAULT FALSE,
                    ADD COLUMN IF NOT EXISTS last_played_at TIMESTAMP,
                    ADD COLUMN IF NOT EXISTS last_played_reason TEXT,
                    ADD COLUMN IF NOT EXISTS last_played_engine TEXT;
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
            # Exact count of real Spotify account-queue adds (spotify_connect
            # .add_to_queue) not yet accounted for by a drain - see
            # clear_queue's own comment for why: GET /me/player/queue's
            # reported length has its own quirks (confirmed live it can
            # misreport), and the previous flat 20-item drain cap could
            # leave real residue behind after a long-running session queued
            # more than that over its lifetime, which then resurfaces later
            # under a *new* session's own tracking. This is exact (we're the
            # only thing ever calling add_to_queue for this app's own
            # ad-hoc sessions), so clear_queue can drain precisely this many
            # instead of guessing.
            cur.execute("ALTER TABLE playback_session ADD COLUMN IF NOT EXISTS pending_queue_adds INTEGER NOT NULL DEFAULT 0;")
            print("Table 'playback_session' checked/created successfully.")

            # One row per running Radio session (track/artist/playlist-seeded
            # continuous similar-music stream) - unlike playback_session
            # above, this isn't a single-row mirror: multiple past sessions
            # are kept around (status='stopped') rather than overwritten, so
            # there's a natural history, though only one is ever 'active' at
            # a time in practice (starting a new one just leaves the old row
            # stopped rather than deleting it). seen_track_keys is this
            # session's own anti-repeat set (lowercased "track|||artist"
            # keys) - lastfm.discover_tracks has no memory across calls, so
            # without this a long-running radio would eventually start
            # repeating itself. ytmusic_push_job_id links to the dedicated
            # playlist job backing a 'ytmusic'-destination session (see
            # append_tracks_to_ytmusic_push_job below).
            cur.execute("""
                CREATE TABLE IF NOT EXISTS radio_session (
                    id SERIAL PRIMARY KEY,
                    seed_type TEXT NOT NULL,
                    seed_description TEXT,
                    seed_artists JSONB NOT NULL,
                    seen_track_keys JSONB DEFAULT '[]'::jsonb,
                    destination_type TEXT,
                    ytmusic_playlist_id TEXT,
                    ytmusic_push_job_id INTEGER REFERENCES ytmusic_push_job(id),
                    status TEXT DEFAULT 'active',
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW()
                );
            """)
            # 'discovery' (default, existing behavior) - this app's own
            # Last.fm-driven candidate generation, matched/queued track by
            # track. 'spotify_native' - just seeds one track and leans on
            # Spotify's own account-level autoplay to keep queueing similar
            # tracks after it, at near-zero ongoing /search cost since
            # nothing past the seed goes through this app's own matching.
            cur.execute("ALTER TABLE radio_session ADD COLUMN IF NOT EXISTS engine TEXT NOT NULL DEFAULT 'discovery';")
            # Track-first 'discovery' engine state (radio_engine.generate_radio_batch_track_first) -
            # seed_track_name/seed_artist_name is the literal seed track (when
            # one exists) that track_frontier bootstraps from. track_frontier
            # is the persisted BFS queue of {artist_name, track_name, depth}
            # dicts still awaiting a track.getSimilar call - has to survive
            # across /more calls and playback_advancer refill ticks the same
            # way seen_track_keys already does, or every call would restart
            # the walk from the seed instead of continuing it.
            # discovery_state is the drift-BFS's own reserve state -
            # {'deferred': [...], 'max_drift': float} (see
            # radio_engine.generate_radio_batch_track_first) - candidates
            # found but not yet admitted because they drifted further from
            # the seed than the search radius has grown to need yet. Column
            # predates the drift-BFS rewrite (used to hold a tiered
            # artist-fallback generator's fallback_expanded_artists list) -
            # dropped and re-added rather than migrated in place, since that
            # generator's own state had no meaningful mapping to this one.
            # include_library_tracks - when False, generate_radio_batch_track_first
            # drops any candidate that matches a known_tracks row (a genuine
            # local-library match, not a radio_discovered_tracks cache hit)
            # from what it returns - lets Discover be pointed at "only stuff
            # I don't already have" without touching how the walk itself
            # explores (a library track's own neighbors are still explored
            # exactly as before, it just isn't surfaced as a result itself).
            cur.execute("ALTER TABLE radio_session ADD COLUMN IF NOT EXISTS include_library_tracks BOOLEAN NOT NULL DEFAULT TRUE;")
            cur.execute("ALTER TABLE radio_session ADD COLUMN IF NOT EXISTS seed_track_name TEXT;")
            cur.execute("ALTER TABLE radio_session ADD COLUMN IF NOT EXISTS seed_artist_name TEXT;")
            cur.execute("ALTER TABLE radio_session ADD COLUMN IF NOT EXISTS track_frontier JSONB DEFAULT '[]'::jsonb;")
            cur.execute("ALTER TABLE radio_session DROP COLUMN IF EXISTS fallback_expanded_artists;")
            cur.execute("ALTER TABLE radio_session ADD COLUMN IF NOT EXISTS discovery_state JSONB DEFAULT '{}'::jsonb;")
            # Pre-generated, editable playlist support (the whole point being
            # to generate a full ordered list *before* anything plays, so it
            # can be reviewed/reordered/deleted, rather than discovering it a
            # couple tracks at a time as the old model did). playlist is the
            # ordered list of NOT-YET-PLAYED items, each carrying a stable
            # item_id (from next_item_id, a per-session counter - identity,
            # not array position, so reorder/delete-by-id survives reordering
            # rather than racing a plain index). generation_status lets the
            # frontend poll a background-generated playlist without blocking
            # the request that kicked it off.
            cur.execute("ALTER TABLE radio_session ADD COLUMN IF NOT EXISTS target_length INTEGER DEFAULT 500;")
            cur.execute("ALTER TABLE radio_session ADD COLUMN IF NOT EXISTS playlist JSONB DEFAULT '[]'::jsonb;")
            cur.execute("ALTER TABLE radio_session ADD COLUMN IF NOT EXISTS generation_status TEXT DEFAULT 'ready';")
            cur.execute("ALTER TABLE radio_session ADD COLUMN IF NOT EXISTS next_item_id INTEGER DEFAULT 0;")
            # A crash mid-generation would otherwise leave generation_status
            # stuck at 'generating' forever - nothing else would ever set it,
            # and the frontend's poll would spin indefinitely with no
            # timeout. Anything still 'generating' at boot definitely isn't
            # (the thread that was generating it is gone), so it's a genuine
            # failure, not an in-progress job to wait on.
            cur.execute("UPDATE radio_session SET generation_status = 'error' WHERE generation_status = 'generating';")
            print("Table 'radio_session' checked/created successfully.")

            # One row per real (non-short-circuited) Spotify /search call -
            # every consumer of spotify_connect.search_track shares this same
            # rate limit (Discover, Radio, library matching, and the
            # background spotify_track_matcher.py job), and Spotify publishes
            # no quota number
            # to pace against the way YouTube's Data API does - this is what
            # lets spotify_connect.py's own self-imposed budget (see
            # SEARCH_BUDGET_PER_WINDOW) count real recent usage instead of
            # guessing blind. Pruned back to the last 24h on every insert
            # (see record_spotify_search) - nothing here needs history longer
            # than the rolling window it's checked against.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS spotify_search_log (
                    id SERIAL PRIMARY KEY,
                    requested_at TIMESTAMP DEFAULT NOW()
                );
            """)
            print("Table 'spotify_search_log' checked/created successfully.")

            # Single-row, self-learned estimate of Spotify's real (never
            # published - confirmed via developer forum research) daily
            # search quota. Starts at a guessed 100/day; spotify_connect.py
            # ratchets it down whenever a real 429 response's body confirms
            # "reason": "QUOTA_EXCEEDED" specifically (not just an ordinary
            # short-window rate-limit, which says nothing about the daily
            # ceiling) - so the self-imposed throttle gets more accurate
            # over time instead of being a permanent guess.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS spotify_quota_estimate (
                    id INTEGER PRIMARY KEY DEFAULT 1,
                    daily_estimate INTEGER NOT NULL DEFAULT 100,
                    last_adjusted_at TIMESTAMP,
                    last_adjustment_reason TEXT,
                    updated_at TIMESTAMP DEFAULT NOW()
                );
            """)
            # blocked_until persists the live Spotify /search 429 cooldown
            # that used to live only in an in-memory Python global
            # (spotify_connect.py's old _search_blocked_until) - lost on
            # every container restart, which meant a mid-cooldown restart
            # would immediately re-poke Spotify during its own penalty
            # window. last_recovery_check_date tracks the last NY calendar
            # date the upward-recovery check (see
            # maybe_recover_spotify_quota_estimate) already ran for, so it
            # only ever evaluates once per day.
            cur.execute("ALTER TABLE spotify_quota_estimate ADD COLUMN IF NOT EXISTS blocked_until TIMESTAMP;")
            cur.execute("ALTER TABLE spotify_quota_estimate ADD COLUMN IF NOT EXISTS last_recovery_check_date DATE;")
            # Anchor for the "used" search counter (count_searches_since_last_reset) -
            # per explicit user request, this counter must NOT reset at NY
            # midnight just because a new calendar day started (confirmed
            # live it previously did, via the now-removed
            # count_searches_since_ny_midnight/_ny_midnight_as_naive_utc
            # boundary) - only a real, confirmed QUOTA_EXCEEDED transition
            # is meaningful evidence the count so far is done mattering
            # (spotify_connect._learn_from_quota_exceeded calls
            # reset_search_count right after learning from one). Defaults to
            # NOW() so an existing/fresh install starts counting from
            # whenever this migration runs, not further back.
            cur.execute("ALTER TABLE spotify_quota_estimate ADD COLUMN IF NOT EXISTS search_count_reset_at TIMESTAMP DEFAULT NOW();")
            print("Table 'spotify_quota_estimate' checked/created successfully.")

            # A manual, explicit "stop consuming search budget" switch for
            # the background spotify_track_matcher.py job - separate from and
            # in addition to its existing is_idle gating, for whenever that
            # isn't enough on its own.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS background_job_control (
                    id INTEGER PRIMARY KEY DEFAULT 1,
                    track_matcher_paused BOOLEAN NOT NULL DEFAULT FALSE
                );
            """)
            # Renamed from prewarm_paused (spotify_prewarm.py's old name) -
            # idempotent so this is safe to run on every startup, including
            # a fresh install that never had the old column at all.
            cur.execute("""
                DO $$
                BEGIN
                    IF EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'background_job_control' AND column_name = 'prewarm_paused'
                    ) AND NOT EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'background_job_control' AND column_name = 'track_matcher_paused'
                    ) THEN
                        ALTER TABLE background_job_control RENAME COLUMN prewarm_paused TO track_matcher_paused;
                    END IF;
                END $$;
            """)
            print("Table 'background_job_control' checked/created successfully.")

            # General-purpose cache for any (track_name, artist_name) text
            # search against Spotify's catalog - independent of known_tracks,
            # which only ever covers tracks that are part of this user's own
            # library. Confirmed live this was a real gap: a Radio "fresh
            # discovery" suggestion (a Last.fm-recommended track the user
            # doesn't own locally) had nowhere to persist its Spotify match
            # at all, so the exact same track coming up again in a later,
            # unrelated session - a different day, a different seed sharing
            # a similar-artist neighborhood - cost a fresh search every
            # single time. Keyed by spotify_connect._search_and_score's own
            # normalized "track|||artist" text (same shape as
            # radio_engine.radio_track_key), the one choke point every text
            # search (Radio, Discover, the track matcher job, interactive
            # matches) already funnels through - caching there covers every
            # source at once rather than one feature at a time. A confirmed
            # no-match is cached too (matched=FALSE, no uri) - same
            # philosophy known_tracks.spotify_checked already uses for
            # library tracks - so a track this app has resolved once, in
            # either direction, never needs a live search again from
            # anywhere.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS spotify_search_cache (
                    id SERIAL PRIMARY KEY,
                    track_key TEXT NOT NULL UNIQUE,
                    matched BOOLEAN NOT NULL,
                    spotify_uri TEXT,
                    spotify_track_name TEXT,
                    spotify_artist_name TEXT,
                    artwork_url TEXT,
                    cached_at TIMESTAMP DEFAULT NOW()
                );
            """)
            print("Table 'spotify_search_cache' checked/created successfully.")

            # Confirmed Spotify matches for tracks that aren't part of this
            # user's own library at all - a Radio "fresh discovery" (a
            # Last.fm suggestion with no known_tracks row) or a Discover
            # suggestion, successfully matched at least once. Deliberately a
            # separate table from known_tracks rather than inserting a
            # fileless row there - known_tracks represents the user's real
            # local file collection (has_artwork, file scanning, quality
            # tiers etc. all assume a real file backs each row), and mixing
            # in tracks the user doesn't actually own would make the
            # Library tab start showing things that aren't really there.
            # radio_engine.py's own cache tiers (find_cached_artist_tracks/
            # find_any_cached_tracks) pull from this table alongside
            # known_tracks, so a track discovered once - by Radio or
            # Discover, on any past day - becomes a free, zero-search
            # candidate for every *future* radio session too, the same
            # "discover new music" goal a fresh search serves the first
            # time, without paying for it again every time it comes up.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS radio_discovered_tracks (
                    id SERIAL PRIMARY KEY,
                    track_key TEXT NOT NULL UNIQUE,
                    track_name TEXT NOT NULL,
                    artist_name TEXT NOT NULL,
                    album_name TEXT,
                    spotify_track_id TEXT NOT NULL,
                    spotify_album_art_url TEXT,
                    last_played_at TIMESTAMP,
                    discovered_at TIMESTAMP DEFAULT NOW()
                );
            """)
            cur.execute("""
                CREATE INDEX IF NOT EXISTS radio_discovered_tracks_artist_idx
                    ON radio_discovered_tracks (LOWER(artist_name));
            """)
            cur.execute("ALTER TABLE radio_discovered_tracks ADD COLUMN IF NOT EXISTS last_played_reason TEXT;")
            cur.execute("ALTER TABLE radio_discovered_tracks ADD COLUMN IF NOT EXISTS last_played_engine TEXT;")
            print("Table 'radio_discovered_tracks' checked/created successfully.")

            # Single settable knob for Radio's own play-cooldown - a track
            # (library or radio_discovered_tracks) that played within the
            # last cooldown_days is excluded from radio_engine.py's own
            # candidate tiers (find_cached_artist_tracks/find_any_cached_tracks/
            # _index_cached_tracks_by_key), per user request, so the same
            # song doesn't keep resurfacing across sessions - a week by
            # default, adjustable via the API. Deliberately doesn't touch
            # the *seed* track/artist the user explicitly picks to start a
            # session with, or any other play path (Discover, Shuffle All,
            # a direct library click) - those are deliberate choices, not
            # Radio's own suggestions repeating themselves.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS radio_settings (
                    id INTEGER PRIMARY KEY DEFAULT 1,
                    cooldown_days INTEGER NOT NULL DEFAULT 7
                );
            """)
            # User-adjustable versions of lastfm.py's own tuning constants
            # (MIN_TRACK_MATCH_SCORE/MIN_ARTIST_MATCH_SCORE/TRACK_SIMILAR_LIMIT/
            # SIMILAR_ARTISTS_PER_SEED) - see get_radio_tuning/set_radio_tuning.
            # Column defaults match those constants' own current values, so an
            # existing row (or a fresh install that's never touched Settings)
            # behaves identically to before this was made configurable.
            cur.execute("ALTER TABLE radio_settings ADD COLUMN IF NOT EXISTS min_track_match_score REAL NOT NULL DEFAULT 0.10;")
            cur.execute("ALTER TABLE radio_settings ADD COLUMN IF NOT EXISTS min_artist_match_score REAL NOT NULL DEFAULT 0.15;")
            cur.execute("ALTER TABLE radio_settings ADD COLUMN IF NOT EXISTS track_similar_limit INTEGER NOT NULL DEFAULT 15;")
            cur.execute("ALTER TABLE radio_settings ADD COLUMN IF NOT EXISTS similar_artists_per_seed INTEGER NOT NULL DEFAULT 10;")
            print("Table 'radio_settings' checked/created successfully.")

            # Cache for the Playlists tab's "All Tracks" mode - flattening
            # every playlist's tracks live (N+1 calls to Spotify/YouTube, one
            # per playlist) is what made that view slow to open every time.
            # One row per track (not one JSONB blob per platform - the
            # original shape this replaced) so genre/isrc/duration/etc. are
            # queryable columns rather than buried in JSON. Served as-is on
            # every read regardless of age - main.py's routes only recompute
            # it when explicitly asked to refresh, so a stale cache is a
            # deliberate trade for speed, not an oversight.
            #
            # track_id is the Spotify track's bare id (not the full uri) for
            # platform='spotify' rows, or the YouTube video_id for
            # platform='ytmusic' rows - both already the natural per-platform
            # identifier, just made an explicit column instead of parsed out
            # of a blob every time something needs it.
            #
            # album/isrc/popularity/explicit/release_date only ever populate
            # for platform='spotify' (all come free off the same track object
            # Spotify's playlist-items endpoint already returns - no extra
            # API calls). genre is the primary artist's Spotify genres,
            # joined - fetched via a batched artist lookup (see
            # spotify_connect.get_artist_genres), so it costs one call per
            # ~50 unique artists, not per track. YouTube's public Data API
            # has no genre or ISRC for either platform to backfill - those
            # columns just stay NULL on platform='ytmusic' rows.
            #
            # matched_spotify_uri/matched_at are ytmusic-only: a pre-resolved
            # Spotify catalog match for this YouTube Music track, found via
            # the same search_track pipeline the live per-click match (Push
            # to Playlist / discover-match) uses. matched_at tracks whether a
            # match attempt has even been made yet (NULL means "not tried" -
            # distinct from "tried, no match found", which leaves
            # matched_spotify_uri NULL but sets matched_at).
            cur.execute("""
                CREATE TABLE IF NOT EXISTS playlist_track_cache (
                    platform TEXT NOT NULL,
                    track_id TEXT NOT NULL,
                    track_name TEXT NOT NULL,
                    artist_name TEXT,
                    album TEXT,
                    artwork_url TEXT,
                    isrc TEXT,
                    duration_ms INTEGER,
                    popularity INTEGER,
                    explicit BOOLEAN,
                    release_date TEXT,
                    genre TEXT,
                    matched_spotify_uri TEXT,
                    matched_at TIMESTAMP,
                    PRIMARY KEY (platform, track_id)
                );
            """)
            # Cross-reference to known_tracks - this row's track also exists
            # as a local file, if set. Soft reference (no FK), same precedent
            # as ytmusic_push_job_tracks.known_track_id above: a local
            # library rescan can legitimately delete/recreate known_tracks
            # rows, and this cache shouldn't be held hostage to that.
            # Populated in bulk by bulk_backfill_local_track_ids, called from
            # replace_playlist_track_cache right after every refresh.
            cur.execute("ALTER TABLE playlist_track_cache ADD COLUMN IF NOT EXISTS local_track_id INTEGER;")
            # Mirrors matched_spotify_uri (which lives on platform='ytmusic'
            # rows) for the other direction - a platform='spotify' row's
            # matching YouTube video_id, once known. Backs the Playlists
            # tab's cross-service availability badges. Populated in bulk by
            # bulk_backfill_cross_platform_matches, same call site as
            # bulk_backfill_local_track_ids.
            cur.execute("ALTER TABLE playlist_track_cache ADD COLUMN IF NOT EXISTS matched_ytmusic_video_id TEXT;")
            print("Table 'playlist_track_cache' checked/created successfully.")

            # Per-platform metadata that isn't a per-track fact - skipped_count
            # (Spotify playlists this account doesn't own, whose tracks 403)
            # and when the whole cache was last rebuilt.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS playlist_track_cache_meta (
                    platform TEXT PRIMARY KEY,
                    skipped_count INTEGER DEFAULT 0,
                    refreshed_at TIMESTAMP
                );
            """)
            print("Table 'playlist_track_cache_meta' checked/created successfully.")

            # Superseded by playlist_track_cache above (this was its original
            # one-JSONB-blob-per-platform shape, replaced the same day it was
            # built once one-row-per-track with real metadata columns turned
            # out to be worth the normalization) - drop rather than leave a
            # dead, never-populated table around.
            cur.execute("DROP TABLE IF EXISTS playlist_all_tracks_cache;")

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
    in-memory thread/lock don't survive a restart, same as spotify_track_matcher's)."""
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


def _now_playing_identity(now_playing):
    """A stable per-track identifier from a now_playing object - its
    Spotify/YT Music uri when it has one, otherwise its own id (a bare
    known_tracks id for a genuine local-file play). Used by
    save_playback_session to tell "the same track is still playing" apart
    from "playback just advanced to a new one", so last_played_at only gets
    touched on a genuine change, not every routine sync."""
    if not now_playing:
        return None
    return now_playing.get('uri') or now_playing.get('id')


def _record_track_played(cur, now_playing):
    """Stamps last_played_at (the moment this track started playing, not
    when this row happened to get written) on whichever row now_playing
    actually corresponds to - local_id for a library track cast to
    Spotify/matched from a playlist (see App.js's mapMatchedLocalTrack/
    mapSpotifyTrack/mapYtMusicTrack), its own bare id for a genuine
    local-file play (no 'source' key at all), or radio_track_id for a
    confirmed match with no known_tracks row at all (see
    upsert_radio_discovered_track - a Radio "fresh discovery" or Discover
    suggestion not in the user's own library). Genuinely nothing to record
    only when none of these apply (e.g. a pure Spotify/YT Music playlist
    track that was never matched to anything). Called from the one place
    every play - library, playlist, or Radio, whichever destination,
    whether this tab or playback_advancer's own background thread changed
    now_playing - already funnels through, so this covers all of them at
    once rather than needing a hook at every individual play/queue call
    site.

    Also stamps last_played_reason/last_played_engine - two separate axes,
    not one conflated string: reason is *why* this specific play was picked
    ("Discovered - similar track", "library fallback", "Radio seed", ...),
    engine is *which mechanism* produced it ("Last.fm", "App logic",
    "Spotify", or blank when nothing was actually recommended - a direct
    click, a playlist track). now_playing['selection_reason']/
    ['selection_engine'] carry these when a caller set them explicitly
    (radio_engine.generate_radio_batch_track_first tags every candidate it
    produces, threaded through by playback_advancer into the found/
    now_playing dict) - otherwise this falls back to a sensible label built
    from whichever other tag is already present on now_playing, so the Play
    Log always has something meaningful to show even for play paths that
    don't set these explicitly (a plain library click, a Spotify/YT Music
    playlist track, a Discover pick)."""
    played_at = now_ny_naive()
    reason = now_playing.get('selection_reason')
    engine = now_playing.get('selection_engine')
    if not reason:
        if now_playing.get('radio_session_id') is not None:
            # The literal seed track/artist the user picked to start a
            # session with - App.js's resolveSeedTrackForPlayback tags this
            # explicitly too, this is the fallback for whenever that
            # somehow didn't reach here (e.g. a stale frontend bundle).
            reason = 'Radio seed'
        elif now_playing.get('discover_id') is not None:
            reason, engine = 'Discover suggestion', (engine or 'Last.fm')
        elif now_playing.get('ytmusic_id') is not None:
            reason = 'YouTube Music playlist'
        elif now_playing.get('playlist_name'):
            reason = f"Playlist: {now_playing['playlist_name']}"
        else:
            # A genuine local-file play, or a library track cast to
            # Spotify/matched from a playlist (origin_library) - either
            # way, a plain direct play with no recommendation engine
            # involved at all.
            reason = 'library playback'
    radio_track_id = now_playing.get('radio_track_id')
    if radio_track_id is not None:
        try:
            cur.execute(
                "UPDATE radio_discovered_tracks SET last_played_at = %s, last_played_reason = %s, last_played_engine = %s WHERE id = %s",
                (played_at, reason, engine, radio_track_id),
            )
        except Error as e:
            print(f"Error recording last played time for discovered track {radio_track_id}: {e}")
        return
    known_track_id = now_playing.get('local_id')
    if known_track_id is None and not now_playing.get('source'):
        known_track_id = now_playing.get('id')
    if known_track_id is None:
        return
    try:
        cur.execute(
            "UPDATE known_tracks SET last_played_at = %s, last_played_reason = %s, last_played_engine = %s WHERE id = %s",
            (played_at, reason, engine, known_track_id),
        )
    except Error as e:
        print(f"Error recording last played time for track {known_track_id}: {e}")


def save_playback_session(destination_type, destination_id, now_playing, queue,
                           shuffle_enabled=False, spotify_match_pool=None,
                           chromecast_pushed_count=None, last_status=None):
    """Upserts the single playback_session row. Callers always pass the full
    set of fields they want persisted (not a partial patch) - the background
    advancer reads the row with SELECT ... FOR UPDATE before writing it back,
    so it always has the current values in hand for whichever fields it isn't
    actively changing.

    Also records last_played_at on whatever known_tracks row now_playing
    corresponds to, whenever it's genuinely a new track (not just this same
    one being re-saved for an unrelated field change) - see
    _now_playing_identity/_record_track_played."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("SELECT now_playing FROM playback_session WHERE id = 1")
        existing_row = cur.fetchone()
        previous_now_playing = existing_row[0] if existing_row else None
        if now_playing and _now_playing_identity(now_playing) != _now_playing_identity(previous_now_playing):
            _record_track_played(cur, now_playing)
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


def increment_pending_queue_adds():
    """Bumps the exact count of real Spotify account-queue adds not yet
    accounted for by a drain - called right after spotify_connect.add_to_queue
    actually succeeds. See playback_session.pending_queue_adds' own comment
    for why this exists (clear_queue used to only guess, via a flat cap and
    Spotify's own not-fully-reliable queue-length report)."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("UPDATE playback_session SET pending_queue_adds = pending_queue_adds + 1 WHERE id = 1")
        conn.commit()
        cur.close()
    except Error as e:
        print(f"Error incrementing pending_queue_adds: {e}")
    finally:
        if conn:
            conn.close()


def take_pending_queue_adds():
    """Reads the current pending_queue_adds count and resets it to 0 in the
    same transaction - called at the start of a fresh drain (see
    spotify_connect.clear_queue), so whatever a *new* session's own
    add_to_queue calls add during/after that drain starts counting fresh
    rather than being folded into what the drain was already accounting
    for. Returns 0 on any error, same as "nothing tracked" - clear_queue
    still has its own flat floor/API-reported-length fallback either way.

    Resetting to 0 unconditionally here is deliberate and still correct -
    see restore_pending_queue_adds, which clear_queue calls afterward with
    whatever this batch didn't actually manage to drain (bounded by
    CLEAR_QUEUE_SAFETY_CAP, or cut short by a superseding call). Without
    that follow-up call, a backlog bigger than one bounded pass could reach
    used to just vanish from tracking the moment this function ran, even
    though it was still genuinely sitting in Spotify's real queue - the next
    drain attempt (a new session, or a retry) started blind at 0 with no
    memory a backlog was still owed."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("SELECT pending_queue_adds FROM playback_session WHERE id = 1")
        row = cur.fetchone()
        cur.execute("UPDATE playback_session SET pending_queue_adds = 0 WHERE id = 1")
        conn.commit()
        cur.close()
        return row[0] if row else 0
    except Error as e:
        print(f"Error reading/resetting pending_queue_adds: {e}")
        return 0
    finally:
        if conn:
            conn.close()


def restore_pending_queue_adds(count):
    """Adds count back onto pending_queue_adds (increment, not overwrite) -
    called by clear_queue with whatever a drain didn't actually manage to
    skip past. Increments rather than sets, since take_pending_queue_adds
    already reset the live counter to 0 right as this drain started - any
    add_to_queue calls that happened concurrently during the drain (a
    different session/tick topping up its own lookahead) have already been
    counted fresh into that counter by the time this runs, and should be
    added to, not clobbered by, whatever this drain still owes."""
    if count <= 0:
        return
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("UPDATE playback_session SET pending_queue_adds = pending_queue_adds + %s WHERE id = 1", (count,))
        conn.commit()
        cur.close()
    except Error as e:
        print(f"Error restoring pending_queue_adds: {e}")
    finally:
        if conn:
            conn.close()


def get_cached_spotify_search(track_key):
    """A previously-cached (track_name, artist_name) text search result, or
    None if never searched before - see spotify_search_cache's own comment.
    track_key is the caller's own normalized "track|||artist" text (same
    shape as radio_engine.radio_track_key) - this function doesn't
    normalize it itself, so callers must be consistent about it (see
    spotify_connect._search_and_score, the only caller today).

    Returns {'matched': False} for a cached no-match, or {'matched': True,
    'uri', 'track_name', 'artist_name', 'artwork_url'} for a cached hit -
    shaped to drop straight into the same match dict _search_and_score
    already builds from a live search."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(
            "SELECT matched, spotify_uri, spotify_track_name, spotify_artist_name, artwork_url "
            "FROM spotify_search_cache WHERE track_key = %s",
            (track_key,),
        )
        row = cur.fetchone()
        cur.close()
        if row is None:
            return None
        matched, uri, spotify_track_name, spotify_artist_name, artwork_url = row
        if not matched:
            return {'matched': False}
        return {
            'matched': True, 'uri': uri, 'track_name': spotify_track_name,
            'artist_name': spotify_artist_name, 'artwork_url': artwork_url,
        }
    except Error as e:
        print(f"Error reading cached Spotify search for {track_key!r}: {e}")
        return None
    finally:
        if conn:
            conn.close()


def set_cached_spotify_search(track_key, matched, match):
    """Persists a genuine (non-'unavailable') Spotify search result - see
    spotify_search_cache's own comment. match is the {'uri', 'track_name',
    'artist_name', 'artwork_url'} dict _search_and_score already builds, or
    None for a confirmed no-match."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO spotify_search_cache (track_key, matched, spotify_uri, spotify_track_name, spotify_artist_name, artwork_url)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (track_key) DO UPDATE SET
                matched = EXCLUDED.matched, spotify_uri = EXCLUDED.spotify_uri,
                spotify_track_name = EXCLUDED.spotify_track_name, spotify_artist_name = EXCLUDED.spotify_artist_name,
                artwork_url = EXCLUDED.artwork_url, cached_at = NOW()
        """, (
            track_key, matched,
            (match or {}).get('uri'), (match or {}).get('track_name'),
            (match or {}).get('artist_name'), (match or {}).get('artwork_url'),
        ))
        conn.commit()
        cur.close()
    except Error as e:
        print(f"Error caching Spotify search for {track_key!r}: {e}")
    finally:
        if conn:
            conn.close()


def upsert_radio_discovered_track(track_name, artist_name, album_name, spotify_uri, artwork_url):
    """Persists a confirmed Spotify match for a track with no known_tracks
    row at all - see radio_discovered_tracks' own comment for why this is a
    separate table. Called whenever a Radio "fresh discovery" candidate or
    a Discover suggestion gets successfully matched for the first time
    (playback_advancer.py's matching loop, main.py's discover-match route),
    regardless of which of those two actually triggered the search - either
    is equally worth remembering for a *future* radio session's own cache
    tiers (see radio_engine.find_cached_artist_tracks/find_any_cached_tracks).
    Returns the row's own id, or None on failure."""
    # Same normalized shape as radio_engine.radio_track_key - duplicated
    # rather than imported, since radio_engine imports spotify_connect,
    # which imports this module, and importing radio_engine here would
    # make that a circular import.
    key = f"{track_name.strip().lower()}|||{artist_name.strip().lower()}"
    spotify_track_id = spotify_uri.split(':')[-1]
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO radio_discovered_tracks (track_key, track_name, artist_name, album_name, spotify_track_id, spotify_album_art_url)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (track_key) DO UPDATE SET
                spotify_track_id = EXCLUDED.spotify_track_id,
                spotify_album_art_url = EXCLUDED.spotify_album_art_url
            RETURNING id
        """, (key, track_name, artist_name, album_name, spotify_track_id, artwork_url))
        row = cur.fetchone()
        conn.commit()
        cur.close()
        return row[0] if row else None
    except Error as e:
        print(f"Error remembering discovered track {track_name!r} by {artist_name!r}: {e}")
        return None
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


# Cap on radio_session.seen_track_keys - a session left running for hours
# would otherwise grow this JSONB array unboundedly; only the most recent
# entries are ever useful for anti-repeat purposes anyway.
RADIO_SEEN_TRACK_KEYS_CAP = 500


def create_radio_session(seed_type, seed_description, seed_artists, destination_type, seen_track_keys, engine='discovery',
                          seed_track_name=None, seed_artist_name=None, track_frontier=None,
                          target_length=None, generation_status='ready', include_library_tracks=True):
    """Starts a new radio_session row. seen_track_keys is the caller's
    already-lowercased list of "track|||artist" keys for the first batch of
    tracks it just generated, so a subsequent /more call's dedup starts from
    a non-empty set rather than repeating the very first batch.

    seed_track_name/seed_artist_name/track_frontier are the track-first
    engine's own persisted state (see radio_engine.generate_radio_batch_track_first) -
    None/empty for a spotify_native session or one with no literal seed
    track, in which case the generator bootstraps its own starting track on
    the first call that needs one.

    Retires every other still-'active' session first, in the same
    transaction - this is a personal single-user tool, so only one radio
    session is ever really "the" current one at a time, same as
    playback_session's single-row model. Without this, a session the user
    never explicitly stopped (closed the tab, navigated away mid-playback)
    stays 'active' forever."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("UPDATE radio_session SET status = 'stopped', updated_at = NOW() WHERE status = 'active'")
        cur.execute("""
            INSERT INTO radio_session (seed_type, seed_description, seed_artists, seen_track_keys, destination_type, engine, status,
                                        seed_track_name, seed_artist_name, track_frontier, target_length, generation_status, include_library_tracks)
            VALUES (%s, %s, %s, %s, %s, %s, 'active', %s, %s, %s, %s, %s, %s)
            RETURNING id
        """, (
            seed_type, seed_description, Json(seed_artists), Json(seen_track_keys[-RADIO_SEEN_TRACK_KEYS_CAP:]), destination_type, engine,
            seed_track_name, seed_artist_name, Json(track_frontier or []), target_length, generation_status, include_library_tracks,
        ))
        session_id = cur.fetchone()[0]
        conn.commit()
        cur.close()
        return session_id
    except Error as e:
        print(f"Error creating radio session: {e}")
        return None
    finally:
        if conn:
            conn.close()


def get_radio_session(session_id):
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("""
            SELECT id, seed_type, seed_description, seed_artists, seen_track_keys, destination_type,
                   ytmusic_playlist_id, ytmusic_push_job_id, status, engine,
                   seed_track_name, seed_artist_name, track_frontier, discovery_state,
                   target_length, playlist, generation_status, next_item_id, include_library_tracks
            FROM radio_session WHERE id = %s
        """, (session_id,))
        row = cur.fetchone()
        cur.close()
        if not row:
            return None
        return {
            'id': row[0], 'seed_type': row[1], 'seed_description': row[2], 'seed_artists': row[3],
            'seen_track_keys': row[4], 'destination_type': row[5], 'ytmusic_playlist_id': row[6],
            'ytmusic_push_job_id': row[7], 'status': row[8], 'engine': row[9],
            'seed_track_name': row[10], 'seed_artist_name': row[11],
            'track_frontier': row[12] or [], 'discovery_state': row[13] or {},
            'target_length': row[14], 'playlist': row[15] or [], 'generation_status': row[16],
            'next_item_id': row[17] or 0, 'include_library_tracks': row[18],
        }
    except Error as e:
        print(f"Error reading radio session {session_id}: {e}")
        return None
    finally:
        if conn:
            conn.close()


def get_active_generated_radio_session_id():
    """The one radio_session (if any) a page refresh should restore into
    Discover's own generatingSession state - a spotify+discovery session
    still 'active' (create_radio_session retires every other session the
    instant a new one starts, so at most one row ever qualifies) whose
    generation is underway or already finished, waiting to be reviewed.
    Unlike a *live* session (spotify_native/browser/ytmusic), a generated
    one is never tagged onto playback_session.now_playing at all - nothing
    plays until a future push step - so it has no other restore path.
    Confirmed live this mattered: a completed generation looked identical
    to "lost forever" after a refresh with nothing pointing back to it."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("""
            SELECT id FROM radio_session
            WHERE status = 'active' AND destination_type = 'spotify' AND engine = 'discovery'
                AND generation_status IN ('generating', 'ready')
            LIMIT 1
        """)
        row = cur.fetchone()
        cur.close()
        return row[0] if row else None
    except Error as e:
        print(f"Error finding the active generated radio session: {e}")
        return None
    finally:
        if conn:
            conn.close()


def append_seen_track_keys(session_id, new_keys):
    """Read-merge-write, same idiom as save_playback_session - merges
    new_keys into the session's anti-repeat set and caps it at
    RADIO_SEEN_TRACK_KEYS_CAP (keeping the most recent), rather than letting
    it grow forever across a long-running session."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("SELECT seen_track_keys FROM radio_session WHERE id = %s", (session_id,))
        row = cur.fetchone()
        if not row:
            cur.close()
            return
        existing = row[0] or []
        merged = existing + [k for k in new_keys if k not in existing]
        merged = merged[-RADIO_SEEN_TRACK_KEYS_CAP:]
        cur.execute(
            "UPDATE radio_session SET seen_track_keys = %s, updated_at = NOW() WHERE id = %s",
            (Json(merged), session_id),
        )
        conn.commit()
        cur.close()
    except Error as e:
        print(f"Error appending seen track keys for radio session {session_id}: {e}")
    finally:
        if conn:
            conn.close()


def set_radio_session_track_state(session_id, track_frontier, discovery_state):
    """Overwrite (not merge) - unlike seen_track_keys, both of these are
    whole-state snapshots the generator recomputes in full on every call
    (radio_engine.generate_radio_batch_track_first pops from/pushes onto its
    own in-memory copy of track_frontier during a single call, and this just
    persists wherever it ended up), not accumulating sets. discovery_state
    is {'deferred': [...], 'max_drift': float} - see
    generate_radio_batch_track_first's own docstring."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(
            "UPDATE radio_session SET track_frontier = %s, discovery_state = %s, updated_at = NOW() WHERE id = %s",
            (Json(track_frontier), Json(discovery_state), session_id),
        )
        conn.commit()
        cur.close()
    except Error as e:
        print(f"Error saving track-first state for radio session {session_id}: {e}")
    finally:
        if conn:
            conn.close()


def set_radio_session_generation_status(session_id, generation_status):
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(
            "UPDATE radio_session SET generation_status = %s, updated_at = NOW() WHERE id = %s",
            (generation_status, session_id),
        )
        conn.commit()
        cur.close()
    except Error as e:
        print(f"Error setting generation status for radio session {session_id}: {e}")
    finally:
        if conn:
            conn.close()


def append_radio_playlist_items(session_id, items):
    """Assigns each item a stable item_id (from the session's own
    next_item_id counter) and appends it to the session's playlist -
    identity, not array position, so a later reorder/remove-by-id survives
    the list being reordered or partially consumed in between. Read-merge-
    write, same lost-write race tolerance as append_seen_track_keys (no
    locking) - acceptable here since this is only ever called by the single
    background generation thread or the single advancer thread for a given
    session, never concurrently with itself.

    Returns the items with their assigned item_id, so the caller (the
    generation background job) can use them without a second read."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("SELECT playlist, next_item_id FROM radio_session WHERE id = %s", (session_id,))
        row = cur.fetchone()
        if not row:
            cur.close()
            return []
        existing_playlist = row[0] or []
        next_id = row[1] or 0
        tagged = []
        for item in items:
            tagged_item = dict(item)
            tagged_item['item_id'] = next_id
            next_id += 1
            tagged.append(tagged_item)
        cur.execute(
            "UPDATE radio_session SET playlist = %s, next_item_id = %s, updated_at = NOW() WHERE id = %s",
            (Json(existing_playlist + tagged), next_id, session_id),
        )
        conn.commit()
        cur.close()
        return tagged
    except Error as e:
        print(f"Error appending playlist items for radio session {session_id}: {e}")
        return []
    finally:
        if conn:
            conn.close()


def assign_radio_playlist_item_ids(session_id, items):
    """Tags items with fresh stable item_ids and advances next_item_id -
    unlike append_radio_playlist_items, does NOT touch the playlist column
    at all. Needed by playback_advancer's consumption tick specifically:
    that tick trims its own in-memory copy of playlist as it goes (popping
    matched/discarded items) *in the same tick* it might also extend the
    list, so a read-modify-write against the DB's playlist column here would
    race against - and undo - that in-memory trimming. The caller merges
    these tagged items into its own already-correct in-memory list and
    persists the whole thing once via set_radio_session_playlist."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("SELECT next_item_id FROM radio_session WHERE id = %s", (session_id,))
        row = cur.fetchone()
        if not row:
            cur.close()
            return []
        next_id = row[0] or 0
        tagged = []
        for item in items:
            tagged_item = dict(item)
            tagged_item['item_id'] = next_id
            next_id += 1
            tagged.append(tagged_item)
        cur.execute("UPDATE radio_session SET next_item_id = %s WHERE id = %s", (next_id, session_id))
        conn.commit()
        cur.close()
        return tagged
    except Error as e:
        print(f"Error assigning playlist item ids for radio session {session_id}: {e}")
        return []
    finally:
        if conn:
            conn.close()


def set_radio_session_playlist(session_id, playlist):
    """Overwrite (not merge) - callers (the advancer's consumption loop,
    reorder/remove routes) always compute the full resulting list themselves
    first, same idiom as set_radio_session_track_state."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(
            "UPDATE radio_session SET playlist = %s, updated_at = NOW() WHERE id = %s",
            (Json(playlist), session_id),
        )
        conn.commit()
        cur.close()
    except Error as e:
        print(f"Error saving playlist for radio session {session_id}: {e}")
    finally:
        if conn:
            conn.close()


def set_radio_session_ytmusic_job(session_id, ytmusic_playlist_id, ytmusic_push_job_id):
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(
            "UPDATE radio_session SET ytmusic_playlist_id = %s, ytmusic_push_job_id = %s, updated_at = NOW() WHERE id = %s",
            (ytmusic_playlist_id, ytmusic_push_job_id, session_id),
        )
        conn.commit()
        cur.close()
    except Error as e:
        print(f"Error setting radio session {session_id}'s YouTube Music job: {e}")
    finally:
        if conn:
            conn.close()


def stop_radio_session(session_id):
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("UPDATE radio_session SET status = 'stopped', updated_at = NOW() WHERE id = %s", (session_id,))
        conn.commit()
        cur.close()
    except Error as e:
        print(f"Error stopping radio session {session_id}: {e}")
    finally:
        if conn:
            conn.close()


def record_spotify_search():
    """Logs one real (non-short-circuited) Spotify /search call - see
    spotify_connect.py's _search_and_score. No time-based pruning here
    (deliberately removed) - count_searches_since_last_reset() below can
    legitimately need to count back across multiple calendar days now (a
    QUOTA_EXCEEDED might not happen for a while), so an unconditional "older
    than 24h" delete would have silently capped that count regardless of
    the real reset anchor. reset_search_count() is what actually prunes,
    once a row is genuinely unreachable (older than the current anchor)."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("INSERT INTO spotify_search_log DEFAULT VALUES")
        conn.commit()
        cur.close()
    except Error as e:
        print(f"Error recording a Spotify search: {e}")
    finally:
        if conn:
            conn.close()


def now_ny_naive():
    """Current wall-clock moment in America/New_York, as a naive value -
    used to stamp last_played_at (see _record_track_played) so that
    timestamp reads as NY local time at a glance, matching every other
    NY-aligned convention in this app (see NY_TZ above), rather than the
    DB server's own UTC. This is a deliberate, isolated exception to the
    rest of this file's naive-UTC convention (see
    _ny_midnight_as_naive_utc's own note) - anything comparing against
    last_played_at must also use this, not NOW()/_ny_midnight_as_naive_utc,
    or the comparison will be off by the UTC/NY offset."""
    return datetime.now(NY_TZ).replace(tzinfo=None)


def _ny_midnight_as_naive_utc(days_ago=0):
    """Start of "today" (or N days back) in America/New_York, expressed as
    the naive UTC-wall-clock value this app's plain TIMESTAMP columns
    actually store (confirmed live: this DB's own session timezone is
    Etc/UTC, and NOW() is stored with its offset silently stripped) - so a
    plain >= comparison against requested_at/last_adjusted_at lines up
    correctly without needing every column to be TIMESTAMPTZ."""
    now_ny = datetime.now(NY_TZ)
    start_ny = (now_ny - timedelta(days=days_ago)).replace(hour=0, minute=0, second=0, microsecond=0)
    return start_ny.astimezone(timezone.utc).replace(tzinfo=None)


def _get_search_count_reset_at(cur):
    """Reads the persisted anchor for count_searches_since_last_reset,
    self-healing the same way get_spotify_quota_estimate does if the row
    doesn't exist yet. Takes an already-open cursor rather than opening its
    own connection - always called from within another function's
    transaction (count_searches_since_last_reset, reset_search_count)."""
    cur.execute("SELECT search_count_reset_at FROM spotify_quota_estimate WHERE id = 1")
    row = cur.fetchone()
    if row is not None and row[0] is not None:
        return row[0]
    now = datetime.utcnow()
    cur.execute(
        "INSERT INTO spotify_quota_estimate (id, search_count_reset_at) VALUES (1, %s) "
        "ON CONFLICT (id) DO UPDATE SET search_count_reset_at = COALESCE(spotify_quota_estimate.search_count_reset_at, EXCLUDED.search_count_reset_at)",
        (now,),
    )
    return now


def count_searches_since_last_reset():
    """How many real Spotify /search calls have been logged since the last
    reset anchor - NOT a calendar-day boundary (see search_count_reset_at's
    own comment on the table migration): per explicit user request, this
    must only ever reset on a real, confirmed QUOTA_EXCEEDED transition
    (spotify_connect._learn_from_quota_exceeded calls reset_search_count),
    never just because a new NY day started."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        reset_at = _get_search_count_reset_at(cur)
        conn.commit()
        cur.execute("SELECT COUNT(*) FROM spotify_search_log WHERE requested_at >= %s", (reset_at,))
        count = cur.fetchone()[0]
        cur.close()
        return count
    except Error as e:
        print(f"Error counting Spotify searches since last reset: {e}")
        return 0
    finally:
        if conn:
            conn.close()


def reset_search_count(reason):
    """Moves the "used" counter's reset anchor forward to now, and prunes
    every spotify_search_log row older than it (they're now permanently
    unreachable - nothing will ever query further back than the current
    anchor again, so there's no reason to keep them, same role the old
    24h-rolling prune used to serve, just tied to a real event instead of a
    fixed window). Called only from spotify_connect._learn_from_quota_exceeded,
    right after a genuine new QUOTA_EXCEEDED transition - never on a timer,
    never at a calendar boundary."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        now = datetime.utcnow()
        cur.execute(
            "INSERT INTO spotify_quota_estimate (id, search_count_reset_at) VALUES (1, %s) "
            "ON CONFLICT (id) DO UPDATE SET search_count_reset_at = EXCLUDED.search_count_reset_at",
            (now,),
        )
        cur.execute("DELETE FROM spotify_search_log WHERE requested_at < %s", (now,))
        conn.commit()
        cur.close()
        print(f"Spotify search counter reset: {reason}")
    except Error as e:
        print(f"Error resetting Spotify search counter: {e}")
    finally:
        if conn:
            conn.close()


# What the daily estimate starts at, and the ceiling upward recovery (see
# maybe_recover_spotify_quota_estimate) never climbs past - the original
# guess is the most this app ever assumed was safe to begin with, so
# recovering past it would just be inventing a second, ungrounded guess.
QUOTA_ESTIMATE_DEFAULT = 100


def get_spotify_quota_estimate():
    """Current self-learned daily search quota estimate - creates the
    single row (default 100/day) on first read if it doesn't exist yet.
    Also opportunistically runs the once-a-day upward-recovery check (see
    maybe_recover_spotify_quota_estimate) - cheap/idempotent past the first
    call each day, and this is the one function every budget check already
    calls, so recovery reliably gets evaluated soon after each NY midnight
    without needing its own scheduled job."""
    maybe_recover_spotify_quota_estimate()
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("SELECT daily_estimate FROM spotify_quota_estimate WHERE id = 1")
        row = cur.fetchone()
        if row is None:
            cur.execute(
                "INSERT INTO spotify_quota_estimate (id, daily_estimate) VALUES (1, %s) ON CONFLICT (id) DO NOTHING",
                (QUOTA_ESTIMATE_DEFAULT,),
            )
            conn.commit()
            row = (QUOTA_ESTIMATE_DEFAULT,)
        cur.close()
        return row[0]
    except Error as e:
        print(f"Error reading Spotify quota estimate: {e}")
        return QUOTA_ESTIMATE_DEFAULT
    finally:
        if conn:
            conn.close()


def get_spotify_quota_state():
    """Full row - used by the /api/spotify/search-budget route to also
    surface when/why the estimate was last adjusted, not just its current
    value."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("SELECT daily_estimate, last_adjusted_at, last_adjustment_reason FROM spotify_quota_estimate WHERE id = 1")
        row = cur.fetchone()
        cur.close()
        if row is None:
            return {"daily_estimate": QUOTA_ESTIMATE_DEFAULT, "last_adjusted_at": None, "last_adjustment_reason": None}
        return {
            "daily_estimate": row[0],
            "last_adjusted_at": row[1].isoformat() if row[1] else None,
            "last_adjustment_reason": row[2],
        }
    except Error as e:
        print(f"Error reading Spotify quota state: {e}")
        return {"daily_estimate": QUOTA_ESTIMATE_DEFAULT, "last_adjusted_at": None, "last_adjustment_reason": None}
    finally:
        if conn:
            conn.close()


def set_spotify_quota_estimate(new_value, reason):
    """Records a new self-learned daily quota estimate, with why - called
    by spotify_connect.py only when a real 429 response body confirms
    reason='QUOTA_EXCEEDED', never on an ordinary rate-limit."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO spotify_quota_estimate (id, daily_estimate, last_adjusted_at, last_adjustment_reason, updated_at)
            VALUES (1, %s, NOW(), %s, NOW())
            ON CONFLICT (id) DO UPDATE SET
                daily_estimate = EXCLUDED.daily_estimate,
                last_adjusted_at = EXCLUDED.last_adjusted_at,
                last_adjustment_reason = EXCLUDED.last_adjustment_reason,
                updated_at = NOW()
        """, (new_value, reason))
        conn.commit()
        cur.close()
        print(f"Spotify daily search quota estimate adjusted to {new_value}: {reason}")
    except Error as e:
        print(f"Error setting Spotify quota estimate: {e}")
    finally:
        if conn:
            conn.close()


def maybe_recover_spotify_quota_estimate():
    """Once per NY calendar day: if the estimate is below the original
    default and wasn't lowered again yesterday or today, nudge it back up
    (20% of the remaining gap, floor +1, capped at the default) - the
    closest thing to a positive signal available, since Spotify never
    confirms "your quota was fine," only reactively rejects with a 429. A
    clean day is treated as weak evidence the current estimate might be
    more conservative than it needs to be. No-ops immediately once already
    run for today."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(
            "SELECT daily_estimate, last_adjusted_at, last_recovery_check_date FROM spotify_quota_estimate WHERE id = 1",
        )
        row = cur.fetchone()
        if row is None:
            cur.close()
            return
        daily_estimate, last_adjusted_at, last_recovery_check_date = row
        today = datetime.now(NY_TZ).date()
        if last_recovery_check_date == today:
            cur.close()
            return
        adjusted_recently = last_adjusted_at is not None and last_adjusted_at >= _ny_midnight_as_naive_utc(days_ago=1)
        new_estimate = daily_estimate
        if not adjusted_recently and daily_estimate < QUOTA_ESTIMATE_DEFAULT:
            new_estimate = min(QUOTA_ESTIMATE_DEFAULT, daily_estimate + max(1, round(daily_estimate * 0.2)))
        cur.execute(
            "UPDATE spotify_quota_estimate SET daily_estimate = %s, last_recovery_check_date = %s, updated_at = NOW() WHERE id = 1",
            (new_estimate, today),
        )
        conn.commit()
        cur.close()
        if new_estimate != daily_estimate:
            print(f"Spotify daily search quota estimate recovered {daily_estimate} -> {new_estimate} after a clean day")
    except Error as e:
        print(f"Error checking Spotify quota recovery: {e}")
    finally:
        if conn:
            conn.close()


def get_spotify_search_blocked_until():
    """Naive-UTC datetime this app's last real 429 said to wait until, or
    None - persisted (not just an in-memory Python global) so a container
    restart mid-cooldown doesn't forget and immediately re-poke Spotify
    during its own penalty window."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("SELECT blocked_until FROM spotify_quota_estimate WHERE id = 1")
        row = cur.fetchone()
        cur.close()
        return row[0] if row else None
    except Error as e:
        print(f"Error reading Spotify search block state: {e}")
        return None
    finally:
        if conn:
            conn.close()


def set_spotify_search_blocked_until(blocked_until):
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO spotify_quota_estimate (id, blocked_until, updated_at)
            VALUES (1, %s, NOW())
            ON CONFLICT (id) DO UPDATE SET blocked_until = EXCLUDED.blocked_until, updated_at = NOW()
        """, (blocked_until,))
        conn.commit()
        cur.close()
    except Error as e:
        print(f"Error setting Spotify search block state: {e}")
    finally:
        if conn:
            conn.close()


def is_track_matcher_paused():
    """The manual override checked by spotify_track_matcher.py alongside its
    existing is_idle gating - see background_job_control's own comment."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("SELECT track_matcher_paused FROM background_job_control WHERE id = 1")
        row = cur.fetchone()
        return bool(row[0]) if row else False
    except Error as e:
        print(f"Error reading track matcher pause state: {e}")
        return False
    finally:
        if conn:
            conn.close()


def set_track_matcher_paused(paused):
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO background_job_control (id, track_matcher_paused)
            VALUES (1, %s)
            ON CONFLICT (id) DO UPDATE SET track_matcher_paused = EXCLUDED.track_matcher_paused
        """, (paused,))
        conn.commit()
        cur.close()
    except Error as e:
        print(f"Error setting track matcher pause state: {e}")
    finally:
        if conn:
            conn.close()


RADIO_COOLDOWN_DAYS_DEFAULT = 7


def get_radio_cooldown_days():
    """How long a track that Radio itself played (library or
    radio_discovered_tracks) sits out of Radio's own candidate tiers before
    it's eligible again - creates the default row (7 days) on first read.
    Only radio_engine.py's candidate-selection queries consult this; a
    user explicitly picking a seed track/artist, a library click, Shuffle
    All, or Discover are unaffected."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("SELECT cooldown_days FROM radio_settings WHERE id = 1")
        row = cur.fetchone()
        if row is None:
            cur.execute(
                "INSERT INTO radio_settings (id, cooldown_days) VALUES (1, %s) ON CONFLICT (id) DO NOTHING",
                (RADIO_COOLDOWN_DAYS_DEFAULT,),
            )
            conn.commit()
            row = (RADIO_COOLDOWN_DAYS_DEFAULT,)
        cur.close()
        return row[0]
    except Error as e:
        print(f"Error reading radio cooldown days: {e}")
        return RADIO_COOLDOWN_DAYS_DEFAULT
    finally:
        if conn:
            conn.close()


def set_radio_cooldown_days(days):
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO radio_settings (id, cooldown_days)
            VALUES (1, %s)
            ON CONFLICT (id) DO UPDATE SET cooldown_days = EXCLUDED.cooldown_days
        """, (days,))
        conn.commit()
        cur.close()
    except Error as e:
        print(f"Error setting radio cooldown days: {e}")
    finally:
        if conn:
            conn.close()


def get_radio_tuning():
    """The user-adjustable versions of lastfm.py's own MIN_TRACK_MATCH_SCORE/
    MIN_ARTIST_MATCH_SCORE/TRACK_SIMILAR_LIMIT/SIMILAR_ARTISTS_PER_SEED
    constants - lastfm.py reads this (not the bare constants) at call time,
    so a change here takes effect on the next Last.fm call, no restart
    needed. Self-seeds the row (using the same defaults as those constants,
    matching this table's own column DEFAULTs) on first read, same pattern
    as get_radio_cooldown_days."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("""
            SELECT min_track_match_score, min_artist_match_score, track_similar_limit, similar_artists_per_seed
            FROM radio_settings WHERE id = 1
        """)
        row = cur.fetchone()
        if row is None:
            cur.execute("INSERT INTO radio_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING")
            conn.commit()
            row = (0.10, 0.15, 15, 10)
        cur.close()
        return {
            'min_track_match_score': row[0], 'min_artist_match_score': row[1],
            'track_similar_limit': row[2], 'similar_artists_per_seed': row[3],
        }
    except Error as e:
        print(f"Error reading radio tuning settings: {e}")
        return {'min_track_match_score': 0.10, 'min_artist_match_score': 0.15, 'track_similar_limit': 15, 'similar_artists_per_seed': 10}
    finally:
        if conn:
            conn.close()


def set_radio_tuning(min_track_match_score, min_artist_match_score, track_similar_limit, similar_artists_per_seed):
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO radio_settings (id, min_track_match_score, min_artist_match_score, track_similar_limit, similar_artists_per_seed)
            VALUES (1, %s, %s, %s, %s)
            ON CONFLICT (id) DO UPDATE SET
                min_track_match_score = EXCLUDED.min_track_match_score,
                min_artist_match_score = EXCLUDED.min_artist_match_score,
                track_similar_limit = EXCLUDED.track_similar_limit,
                similar_artists_per_seed = EXCLUDED.similar_artists_per_seed
        """, (min_track_match_score, min_artist_match_score, track_similar_limit, similar_artists_per_seed))
        conn.commit()
        cur.close()
    except Error as e:
        print(f"Error setting radio tuning settings: {e}")
    finally:
        if conn:
            conn.close()


def get_recently_played_keys(cutoff):
    """{"track|||artist", ...} for every known_tracks/radio_discovered_tracks
    row whose last_played_at falls within the cooldown window (i.e. >=
    cutoff) - used by radio_engine.generate_radio_batch_track_first to
    exclude a recently-played track from fresh Last.fm-driven suggestions
    too, not just from the cached-library tiers (find_cached_artist_tracks
    etc. already exclude these via their own SQL WHERE clause, but a track
    surfaced by track.getSimilar/artist-fallback text has no such query to
    filter it - this set is what lets the generator drop it just as early).
    Inlines the same "track|||artist" normalization radio_engine.radio_track_key
    uses rather than importing that module - see upsert_radio_discovered_track's
    own comment on why database.py never imports radio_engine.py."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(
            "SELECT track_name, artist_name FROM known_tracks WHERE last_played_at >= %s",
            (cutoff,),
        )
        rows = cur.fetchall()
        cur.execute(
            "SELECT track_name, artist_name FROM radio_discovered_tracks WHERE last_played_at >= %s",
            (cutoff,),
        )
        rows += cur.fetchall()
        cur.close()
        return {f"{track_name.strip().lower()}|||{artist_name.strip().lower()}" for track_name, artist_name in rows}
    except Error as e:
        print(f"Error reading recently-played keys: {e}")
        return set()
    finally:
        if conn:
            conn.close()


def append_tracks_to_ytmusic_push_job(job_id, tracks):
    """Appends more tracks to an already-enqueued YouTube Music push job -
    used by radio's continuous ytmusic-destination refill instead of
    enqueue_ytmusic_push_job (which always creates a brand new job/playlist).
    Inserts new ytmusic_push_job_tracks rows at the next available
    positions, bumps the job's total, and - the one real behavioral
    difference from a normal enqueue - revives a job that had already
    reached 'done' back to 'running' so ytmusic_push_job.run's queue-empty
    exit (get_next_pending_push_track returning None) doesn't leave these new
    rows stranded forever; get_active_ytmusic_push_job only ever picks up
    'running'/'waiting_quota' jobs, so a 'done' job needs this flip before
    the worker thread (which the caller must separately restart, since the
    worker exits its loop once the queue empties) will look at it again."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("SELECT COALESCE(MAX(position), -1) FROM ytmusic_push_job_tracks WHERE job_id = %s", (job_id,))
        next_position = cur.fetchone()[0] + 1
        cur.executemany(
            """
            INSERT INTO ytmusic_push_job_tracks
                (job_id, position, track_name, artist_name, native_track_name, native_artist_name, known_track_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            """,
            [
                (job_id, next_position + i, t['track_name'], t['artist_name'], t.get('native_track_name'), t.get('native_artist_name'), t.get('known_track_id'))
                for i, t in enumerate(tracks)
            ],
        )
        cur.execute("""
            UPDATE ytmusic_push_job SET
                total = total + %s,
                status = CASE WHEN status = 'done' THEN 'running' ELSE status END,
                updated_at = NOW()
            WHERE id = %s
        """, (len(tracks), job_id))
        conn.commit()
        cur.close()
        return True
    except Error as e:
        print(f"Error appending tracks to YouTube Music push job {job_id}: {e}")
        return False
    finally:
        if conn:
            conn.close()


def replace_playlist_track_cache(platform, tracks, skipped_count):
    """Upserts every track's metadata for this platform, then drops any
    previously-cached row no longer present (removed from every playlist
    since the last refresh). Deliberately an upsert, not a delete-then-insert
    - matched_spotify_uri/matched_at (a resolved cross-platform match) are
    not touched here, so re-running Refresh never throws away a resolved match
    for a track that's still around. tracks is a list of dicts with keys
    track_id/track_name/artist_name/album/artwork_url/isrc/duration_ms/
    popularity/explicit/release_date/genre (missing/None is fine for any of
    the metadata fields - only track_id/track_name are ever required).

    Refuses to do anything at all when tracks is empty - confirmed live this
    is a real risk, not theoretical: a transient upstream failure (Spotify
    429 rate-limit, an expired token) can make list_playlists()/
    get_all_playlist_tracks() come back with zero results, indistinguishable
    at this layer from "you genuinely have no playlists left". Wiping a
    previously-good cache of thousands of tracks on a transient failure is a
    far worse outcome than leaving stale data in place until the next
    successful refresh - a real "deleted every playlist" case just has to
    wait for a manual retry, a vanishingly rare tradeoff against silent
    catastrophic data loss (which is exactly what happened here before this
    guard existed)."""
    if not tracks:
        print(f"playlist_track_cache: refusing to replace '{platform}' rows with an empty fetch result - almost certainly a transient failure, not genuinely zero tracks.")
        return
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        track_ids = [t['track_id'] for t in tracks]
        execute_values(cur, """
            INSERT INTO playlist_track_cache
                (platform, track_id, track_name, artist_name, album, artwork_url,
                 isrc, duration_ms, popularity, explicit, release_date, genre)
            VALUES %s
            ON CONFLICT (platform, track_id) DO UPDATE SET
                track_name = EXCLUDED.track_name, artist_name = EXCLUDED.artist_name,
                album = EXCLUDED.album, artwork_url = EXCLUDED.artwork_url,
                isrc = EXCLUDED.isrc, duration_ms = EXCLUDED.duration_ms,
                popularity = EXCLUDED.popularity, explicit = EXCLUDED.explicit,
                release_date = EXCLUDED.release_date, genre = EXCLUDED.genre
        """, [(
            platform, t['track_id'], t['track_name'], t.get('artist_name'), t.get('album'),
            t.get('artwork_url'), t.get('isrc'), t.get('duration_ms'), t.get('popularity'),
            t.get('explicit'), t.get('release_date'), t.get('genre'),
        ) for t in tracks])
        cur.execute(
            "DELETE FROM playlist_track_cache WHERE platform = %s AND NOT (track_id = ANY(%s))",
            (platform, track_ids),
        )
        cur.execute("""
            INSERT INTO playlist_track_cache_meta (platform, skipped_count, refreshed_at)
            VALUES (%s, %s, NOW())
            ON CONFLICT (platform) DO UPDATE SET skipped_count = EXCLUDED.skipped_count, refreshed_at = NOW()
        """, (platform, skipped_count))
        conn.commit()
        cur.close()
    except Error as e:
        print(f"Error replacing playlist_track_cache for {platform}: {e}")
        if conn:
            conn.rollback()
    finally:
        if conn:
            conn.close()
    bulk_backfill_local_track_ids(platform)
    bulk_backfill_cross_platform_matches(platform)


def get_playlist_track_cache(platform):
    """Returns {'tracks': [...], 'skipped_count': int, 'refreshed_at': iso str}
    for this platform ('spotify'/'ytmusic'), or None if nothing's cached yet.
    Each track dict includes matched_spotify_uri/matched_at (both None until
    a cross-platform match is resolved for that row, ytmusic-only)."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(
            "SELECT skipped_count, refreshed_at FROM playlist_track_cache_meta WHERE platform = %s",
            (platform,),
        )
        meta_row = cur.fetchone()
        if not meta_row:
            cur.close()
            return None
        cur.execute("""
            SELECT track_id, track_name, artist_name, album, artwork_url, isrc,
                   duration_ms, popularity, explicit, release_date, genre,
                   matched_spotify_uri, matched_at, local_track_id, matched_ytmusic_video_id
            FROM playlist_track_cache WHERE platform = %s
        """, (platform,))
        rows = cur.fetchall()
        cur.close()
        tracks = [{
            'track_id': r[0], 'track_name': r[1], 'artist_name': r[2], 'album': r[3],
            'artwork_url': r[4], 'isrc': r[5], 'duration_ms': r[6], 'popularity': r[7],
            'explicit': r[8], 'release_date': r[9], 'genre': r[10],
            'matched_spotify_uri': r[11], 'matched_at': r[12].isoformat() if r[12] else None,
            'local_track_id': r[13], 'matched_ytmusic_video_id': r[14],
        } for r in rows]
        return {
            'tracks': tracks, 'skipped_count': meta_row[0],
            'refreshed_at': meta_row[1].isoformat() if meta_row[1] else None,
        }
    except Error as e:
        print(f"Error reading playlist_track_cache for {platform}: {e}")
        return None
    finally:
        if conn:
            conn.close()


def set_track_match(track_id, matched_spotify_uri):
    """Writes back a resolved Spotify match for one ytmusic track -
    matched_spotify_uri is None on a genuine "no match found", which still
    sets matched_at so this row isn't retried forever."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("""
            UPDATE playlist_track_cache SET matched_spotify_uri = %s, matched_at = NOW()
            WHERE platform = 'ytmusic' AND track_id = %s
        """, (matched_spotify_uri, track_id))
        conn.commit()
        cur.close()
    except Error as e:
        print(f"Error setting track match for {track_id}: {e}")
    finally:
        if conn:
            conn.close()


def find_known_track_external_match(ytmusic_video_id=None, spotify_track_id=None):
    """Exact-id lookup into known_tracks - the safe (never fuzzy) half of the
    cross-reference this app now does before any live search: if a local
    library track has already been matched to this exact Spotify/YouTube id
    by a *different* code path (spotify_track_matcher.py, ytmusic_push_job.py, the
    reverse direction of this same cross-reference), reuse that instead of
    searching again. Exactly one of the two kwargs should be given. Returns
    {'id', 'spotify_track_id', 'ytmusic_video_id'} or None."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        if ytmusic_video_id is not None:
            cur.execute(
                "SELECT id, spotify_track_id, ytmusic_video_id FROM known_tracks WHERE ytmusic_video_id = %s",
                (ytmusic_video_id,),
            )
        else:
            cur.execute(
                "SELECT id, spotify_track_id, ytmusic_video_id FROM known_tracks WHERE spotify_track_id = %s",
                (spotify_track_id,),
            )
        row = cur.fetchone()
        cur.close()
        if not row:
            return None
        return {'id': row[0], 'spotify_track_id': row[1], 'ytmusic_video_id': row[2]}
    except Error as e:
        print(f"Error finding known_tracks external match: {e}")
        return None
    finally:
        if conn:
            conn.close()


def backfill_known_track_ids(known_track_id, spotify_track_id=None, ytmusic_video_id=None):
    """Writes a freshly-resolved external id back into known_tracks -
    COALESCE so an id known_tracks already had (however it got there) is
    never overwritten, only ever filled in when it was previously unset.
    Marks the corresponding *_checked flag true either way, since a
    known_track_id is only ever passed here once its match (found or
    genuinely absent upstream) is settled."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        if spotify_track_id is not None:
            cur.execute("""
                UPDATE known_tracks SET
                    spotify_track_id = COALESCE(spotify_track_id, %s), spotify_checked = TRUE
                WHERE id = %s
            """, (spotify_track_id, known_track_id))
        if ytmusic_video_id is not None:
            cur.execute("""
                UPDATE known_tracks SET
                    ytmusic_video_id = COALESCE(ytmusic_video_id, %s), ytmusic_checked = TRUE
                WHERE id = %s
            """, (ytmusic_video_id, known_track_id))
        conn.commit()
        cur.close()
    except Error as e:
        print(f"Error backfilling known_tracks ids for {known_track_id}: {e}")
    finally:
        if conn:
            conn.close()


def backfill_ytmusic_cache_match(video_id, spotify_uri):
    """Same write as set_track_match, under a name that makes sense at its
    other call sites (the discover-match route, _match_track_to_spotify) -
    playlist_track_cache should stay in sync regardless of which code path
    resolved the match."""
    set_track_match(video_id, spotify_uri)


def bulk_backfill_local_track_ids(platform):
    """Cross-references every cached row for this platform against
    known_tracks in one query, setting local_track_id wherever this
    playlist/library track turns out to be the same track (matched by the
    platform's own external id column) - enables local playback for a
    playlist track that also happens to be a file already on disk. Run
    after every replace_playlist_track_cache call; a plain UPDATE...FROM
    join, no extra API calls."""
    external_column = 'spotify_track_id' if platform == 'spotify' else 'ytmusic_video_id'
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(f"""
            UPDATE playlist_track_cache AS ptc
            SET local_track_id = kt.id
            FROM known_tracks AS kt
            WHERE ptc.platform = %s AND kt.{external_column} = ptc.track_id
        """, (platform,))
        conn.commit()
        cur.close()
    except Error as e:
        print(f"Error backfilling local_track_id for {platform}: {e}")
    finally:
        if conn:
            conn.close()


def bulk_backfill_cross_platform_matches(platform):
    """Populates cross-service availability in bulk right after every
    refresh, backing the Playlists tab's availability badges, for a real,
    already-knowable answer instead of waiting on a live per-click match.

    platform='ytmusic': a known_tracks-bridge quick win for
    matched_spotify_uri - COALESCE means this never overwrites an
    already-resolved match, it just gets there sooner for tracks the local
    library already resolved. Anything this bridge doesn't catch is left for
    a live discover-match lookup instead.

    platform='spotify': matched_ytmusic_video_id has no dedicated background
    job of its own - it's populated entirely as a byproduct here, via (1)
    the same known_tracks bridge and (2) a reverse lookup against
    already-resolved ytmusic rows (a ytmusic track matched to this exact
    Spotify id means this Spotify track is available on YouTube Music too,
    with that video_id)."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        if platform == 'ytmusic':
            cur.execute("""
                UPDATE playlist_track_cache AS ptc
                SET matched_spotify_uri = COALESCE(ptc.matched_spotify_uri, 'spotify:track:' || kt.spotify_track_id),
                    matched_at = COALESCE(ptc.matched_at, NOW())
                FROM known_tracks AS kt
                WHERE ptc.platform = 'ytmusic' AND ptc.local_track_id = kt.id AND kt.spotify_track_id IS NOT NULL
            """)
        else:
            cur.execute("""
                UPDATE playlist_track_cache AS ptc
                SET matched_ytmusic_video_id = COALESCE(ptc.matched_ytmusic_video_id, kt.ytmusic_video_id)
                FROM known_tracks AS kt
                WHERE ptc.platform = 'spotify' AND ptc.local_track_id = kt.id AND kt.ytmusic_video_id IS NOT NULL
            """)
            cur.execute("""
                UPDATE playlist_track_cache AS ptc
                SET matched_ytmusic_video_id = COALESCE(ptc.matched_ytmusic_video_id, other.track_id)
                FROM playlist_track_cache AS other
                WHERE ptc.platform = 'spotify' AND other.platform = 'ytmusic'
                  AND other.matched_spotify_uri = 'spotify:track:' || ptc.track_id
            """)
        conn.commit()
        cur.close()
    except Error as e:
        print(f"Error backfilling cross-platform matches for {platform}: {e}")
    finally:
        if conn:
            conn.close()


if __name__ == "__main__":
    # This block will be executed when database.py is run directly
    # It's useful for initial setup or testing the connection/table creation
    print("Attempting to create database tables...")
    create_tables()
    print("Database table creation process finished.")
