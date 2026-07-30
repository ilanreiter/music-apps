import time

from . import database
from . import spotify_connect

# Same pacing shape as spotify_prewarm.py, and for the same reason - blasting
# through a backlog of live Spotify searches risks the same rate-limit
# lockout that module's docstring describes (a single test call once got a
# ~20h Retry-After). This job runs the identical search_track pipeline the
# live per-click YT->Spotify match already uses, just in bulk in the
# background instead of one track at a time on demand.
PREWARM_INTERVAL_SECONDS = 90
BATCH_SIZE = 5
IDLE_POLL_INTERVAL_SECONDS = 30


def run(progress, is_idle, is_radio_active=lambda: False):
    """Slowly resolves a Spotify match for every playlist_track_cache row
    (platform='ytmusic') that doesn't have one yet, so playing a YouTube
    Music playlist track via Spotify Connect can skip the live search
    entirely (see database.get_unmatched_ytmusic_tracks/set_track_match).
    Only runs while the app is idle and Spotify is connected - same gating
    as spotify_prewarm, same reasoning (this is background housekeeping, not
    something that should compete with an actively-in-progress interaction).

    Also pauses for as long as is_radio_active() is true (a Spotify-
    destination Radio session is running) - same shared-budget reasoning as
    spotify_prewarm.py.

    Never marks a row matched-and-done on an 'unavailable' (rate-limited)
    result - same rule spotify_prewarm follows - so a track hit during a
    rate-limited stretch just gets tried again next cycle, not permanently
    miscategorized as "no match"."""
    progress.update(status='running', processed=0, matched=0, error=None)

    while True:
        if database.is_prewarm_paused():
            # A manual, explicit override - checked first, ahead of the
            # is_radio_active/is_idle gating below, since this exists
            # specifically for whenever those two aren't reason enough on
            # their own to stop consuming search budget right now.
            progress['status'] = 'paused_manually'
            time.sleep(IDLE_POLL_INTERVAL_SECONDS)
            continue
        if is_radio_active():
            progress['status'] = 'waiting_radio_active'
            time.sleep(IDLE_POLL_INTERVAL_SECONDS)
            continue
        if not is_idle():
            progress['status'] = 'waiting_active_use'
            time.sleep(IDLE_POLL_INTERVAL_SECONDS)
            continue
        if not spotify_connect.is_connected():
            progress['status'] = 'waiting_not_connected'
            time.sleep(IDLE_POLL_INTERVAL_SECONDS)
            continue

        delay = PREWARM_INTERVAL_SECONDS
        done = False
        made_live_search = False
        try:
            for _ in range(BATCH_SIZE):
                rows = database.get_unmatched_ytmusic_tracks(limit=1)
                if not rows:
                    done = True
                    break
                track = rows[0]
                # Exact-id cross-reference before any live search - if a
                # local library track already carries this exact video_id
                # (found by spotify_prewarm, ytmusic_push_job, or this same
                # cross-reference running the other direction) and already
                # has a Spotify match, reuse it instead of searching again.
                known_match = database.find_known_track_external_match(ytmusic_video_id=track['track_id'])
                if known_match and known_match['spotify_track_id']:
                    database.set_track_match(track['track_id'], f"spotify:track:{known_match['spotify_track_id']}")
                    progress['matched'] += 1
                    progress['processed'] += 1
                    continue
                made_live_search = True
                result, match, _identified = spotify_connect.search_track(track['track_name'], track['artist_name'])
                if result == 'unavailable':
                    # Genuinely rate-limited - stop this batch early rather
                    # than burning through the rest of it against the same
                    # wall, and let the full interval below be the backoff.
                    break
                database.set_track_match(track['track_id'], match['uri'] if match else None)
                if match:
                    progress['matched'] += 1
                    if known_match:
                        # This local track had no Spotify match yet either -
                        # completing the cross-reference from this direction
                        # too, so spotify_prewarm never has to search it.
                        database.backfill_known_track_ids(known_match['id'], spotify_track_id=match['uri'].split(':')[-1])
                progress['processed'] += 1
            progress.update(status=('done' if done else 'running'), error=None)
        except Exception as e:
            # Same real risk spotify_prewarm's docstring notes - an uncaught
            # exception here would otherwise silently kill this whole
            # background thread forever with no error ever recorded.
            progress.update(status='error', error=str(e))
        if done:
            return
        # A batch resolved entirely via the cross-reference above (no live
        # search at all) doesn't need the rate-limit backoff delay - only a
        # batch that actually hit Spotify's search API does.
        if made_live_search:
            time.sleep(delay)
