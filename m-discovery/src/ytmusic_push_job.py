import time
from datetime import date

from . import database, ytmusic_connect

# YouTube Data API's default daily quota is 10,000 units (search costs 100,
# a playlist insert costs 50) - a hard, fixed-per-day budget, unlike
# Spotify's soft per-second rate limit that spotify_track_matcher.py paces around.
# This job reserves well under the full quota for itself, leaving headroom
# for the user's own interactive Discover/library pushes on the same shared
# daily pool - it self-throttles to this number rather than only reacting
# once Google's real 403/429 quota-exceeded response actually fires (that
# reactive check still exists too, as a safety net for whatever headroom
# this reservation doesn't cover).
DAILY_SAFE_BUDGET = 7000

# How often to recheck while paused (daily budget reached, or a genuine
# quota-exceeded/network 'unavailable' hit) - Google's quota resets roughly
# once every 24h with no published exact time, so there's no point trying to
# compute it precisely; periodic retries pick it back up naturally once it
# clears.
WAITING_QUOTA_RETRY_SECONDS = 3600


def _cached_match(conn, known_track_id):
    """Returns ('hit', video_id_or_None) if this known_tracks row has
    already been checked (by this job, an earlier run, or any future
    whole-library matcher reusing the same column), or ('miss', None) if it
    still needs a live search. known_track_id is None for Discover-sourced
    tracks, which have no known_tracks row - always a 'miss' for those."""
    if known_track_id is None:
        return 'miss', None
    cur = conn.cursor()
    cur.execute("SELECT ytmusic_video_id, ytmusic_checked FROM known_tracks WHERE id = %s", (known_track_id,))
    row = cur.fetchone()
    cur.close()
    if row and row[1]:
        return 'hit', row[0]
    return 'miss', None


def _write_cache(conn, known_track_id, video_id):
    """Opportunistically remembers a fresh match (or confirmed non-match,
    video_id=None) against known_tracks, same as spotify_track_matcher.py does for
    Spotify - benefits any future push, not just this job. No-op for
    Discover-sourced tracks (known_track_id is None)."""
    if known_track_id is None:
        return
    cur = conn.cursor()
    cur.execute(
        "UPDATE known_tracks SET ytmusic_video_id = %s, ytmusic_checked = TRUE WHERE id = %s",
        (video_id, known_track_id),
    )
    conn.commit()
    cur.close()


def _get_job_to_work_on():
    """Returns the job the worker should be processing right now: whatever's
    already active (running/waiting_quota), or the oldest queued job
    promoted to running, or None if the queue is empty. Jobs are strictly
    FIFO - a later job never starts before an earlier one reaches done/error,
    since they'd share the same daily quota anyway (no benefit to
    interleaving, only bookkeeping complexity)."""
    job = database.get_active_ytmusic_push_job()
    if job:
        return job
    job = database.get_next_queued_ytmusic_push_job()
    if not job:
        return None
    database.promote_ytmusic_push_job_to_running(job['id'])
    job['status'] = 'running'
    return job


def run(get_connection):
    """Works through the FIFO queue of YouTube Music push jobs, one track at
    a time, spread across however many days it takes to stay within
    DAILY_SAFE_BUDGET quota units per day. Each job is scoped to the one push
    request that created it - not a general whole-library matcher (that
    would take months at a safe quota pace and isn't what was asked for; see
    the plan this was built from). When a job finishes, the next queued one
    (if any) is picked up automatically in the same run - a new thread only
    needs to be started when the queue was empty and a fresh push arrives.

    Resumes correctly after a restart with no separate cursor: each job row's
    own `processed` flags and `units_spent_today`/`quota_day` ARE the resume
    state, same principle as known_tracks.spotify_checked for
    spotify_track_matcher.py. Started fresh each time by main.py's startup
    auto-resume block if any job is left queued/running/waiting_quota."""
    while True:
        job = _get_job_to_work_on()
        if not job:
            return  # queue is empty - nothing to do until a new push arrives
        job_id = job['id']

        if job['quota_day'] != date.today():
            database.update_ytmusic_push_job_progress(job_id, status='running', reset_quota_day=True, units_spent_delta=0)
            job = database.get_active_ytmusic_push_job()

        if job['units_spent_today'] >= DAILY_SAFE_BUDGET:
            database.update_ytmusic_push_job_progress(job_id, status='waiting_quota')
            time.sleep(WAITING_QUOTA_RETRY_SECONDS)
            continue

        if not ytmusic_connect.is_connected():
            database.update_ytmusic_push_job_progress(job_id, status='waiting_quota')
            time.sleep(WAITING_QUOTA_RETRY_SECONDS)
            continue

        track = database.get_next_pending_push_track(job_id)
        if track is None:
            database.update_ytmusic_push_job_progress(job_id, status='done')
            continue  # loop back around - _get_job_to_work_on will pick up the next queued job, if any

        try:
            units_spent = 0

            # Cache check/write each get their own short-lived connection,
            # closed immediately - never held open across a network call or
            # the quota-wait sleep below. Confirmed live this matters: an
            # earlier version held one connection open for the whole
            # per-track iteration, including the full hour-long sleep on a
            # quota wall - its "idle in transaction" state stalled every
            # OTHER background job that also touches known_tracks (they
            # queued behind the lock for minutes), not just this one.
            conn = get_connection()
            if conn is None:
                database.set_ytmusic_push_job_error(job_id, 'Could not connect to the database')
                return
            try:
                cache_status, video_id = _cached_match(conn, track['known_track_id'])
            finally:
                conn.close()

            if cache_status == 'miss':
                # Native name first (non-Latin-script Discover tracks), same
                # attempt order create_playlist_and_push uses, falling back
                # to the plain tag.
                attempts = []
                if track['native_track_name'] and track['native_artist_name']:
                    attempts.append((track['native_track_name'], track['native_artist_name']))
                attempts.append((track['track_name'], track['artist_name']))

                video_id, hit_wall = None, False
                for name, artist in attempts:
                    result, candidate = ytmusic_connect.find_video_id_with_availability(name, artist)
                    units_spent += 100
                    if result == 'unavailable':
                        hit_wall = True
                        break
                    if candidate:
                        video_id = candidate
                        break

                if hit_wall:
                    database.update_ytmusic_push_job_progress(job_id, status='waiting_quota', units_spent_delta=units_spent)
                    time.sleep(WAITING_QUOTA_RETRY_SECONDS)
                    continue

                conn = get_connection()
                if conn is None:
                    database.set_ytmusic_push_job_error(job_id, 'Could not connect to the database')
                    return
                try:
                    _write_cache(conn, track['known_track_id'], video_id)
                finally:
                    conn.close()

            if not video_id:
                database.mark_push_track_processed(job_id, track['position'], None)
                database.update_ytmusic_push_job_progress(
                    job_id, status='running', skipped_delta=1, units_spent_delta=units_spent, tracks_processed_delta=1,
                )
                continue

            was_playlist_created_already = bool(job['playlist_id'])
            status, playlist_id = ytmusic_connect.ensure_playlist(job['name'], job['playlist_id'])
            if status == 'unavailable':
                database.update_ytmusic_push_job_progress(job_id, status='waiting_quota', units_spent_delta=units_spent)
                time.sleep(WAITING_QUOTA_RETRY_SECONDS)
                continue
            if not was_playlist_created_already:
                units_spent += 50

            inserted = ytmusic_connect.add_video_to_playlist(playlist_id, video_id)
            units_spent += 50
            if not inserted:
                database.update_ytmusic_push_job_progress(
                    job_id, status='waiting_quota', playlist_id=playlist_id, units_spent_delta=units_spent,
                )
                time.sleep(WAITING_QUOTA_RETRY_SECONDS)
                continue

            database.mark_push_track_processed(job_id, track['position'], video_id)
            database.update_ytmusic_push_job_progress(
                job_id, status='running', playlist_id=playlist_id, matched_delta=1, inserted_delta=1,
                units_spent_delta=units_spent, tracks_processed_delta=1,
            )
        except Exception as e:
            # Same lesson as spotify_track_matcher.py: an uncaught exception here
            # would silently kill this background thread forever with no
            # recorded error - a sibling job (shazam_identify) hit exactly
            # this once with a transient Postgres disconnect.
            database.set_ytmusic_push_job_error(job_id, str(e))
            return
