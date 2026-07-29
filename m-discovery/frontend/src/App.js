import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import './App.css';

const LIBRARY_PAGE_SIZE = 100;
const GROUP_QUEUE_LIMIT = 500;
const VIEW_MODES = ['all', 'album', 'genre', 'decade', 'quality', 'format', 'favorite', 'length'];
const BACK_LABELS = {
  album: 'Albums', genre: 'Genres', decade: 'Decades',
  quality: 'Quality Tiers', format: 'Formats', favorite: 'Favorites', length: 'Lengths',
  playlist: 'Playlists', 'ytmusic-playlist': 'YouTube Music Playlists',
};

// Adapts a Spotify API track into the same shape renderTrackCard/queue/now-playing
// expect from a local known_tracks row. The Spotify URI is used as `.id` -
// distinct from local numeric ids, so `===` comparisons never collide across
// the two, and `source`/`uri` carry what the playback dispatch code needs to
// route to Spotify instead of a local stream. context_uri is always null
// here (deliberately, not just unset) - these tracks always play via an
// explicit uris queue, not a context_uri+offset, because Spotify's own
// context-based advancement doesn't follow a client-side shuffle/reorder of
// this array: sending context_uri would mean what's displayed as "the queue"
// and what Spotify actually plays next silently diverge the moment the list
// is shuffled or reordered from Spotify's own notion of the playlist order
// (confirmed live - this exact mismatch was the root cause of a "queue
// doesn't match what's playing" bug). context_uri-based play still exists,
// just only for playSpotifyContextDirectly's fallback (playlists this app
// can't read the track list of at all, so there's no list to build uris from).
function mapSpotifyTrack(t) {
  return {
    id: t.uri,
    source: 'spotify',
    uri: t.uri,
    context_uri: null,
    track_name: t.name,
    artist_name: t.artists,
    album_name: t.album,
    duration_seconds: t.duration_ms != null ? t.duration_ms / 1000 : null,
    artwork_url: t.artwork_url,
    // Set when this same track also exists as a local file (see
    // main.py's _attach_spotify_track_extras / bulk_backfill_local_track_ids) -
    // same local_id bridging mapMatchedLocalTrack already uses, so This
    // Browser can stream the local file instead of needing Spotify Connect.
    local_id: t.local_track_id,
    // Set when this same track is also known to be on YouTube Music (see
    // main.py's _attach_spotify_track_extras) - backs the Playlists tab's
    // cross-service availability badge.
    matched_ytmusic_video_id: t.matched_ytmusic_video_id,
  };
}

// Adapts a YouTube Music playlist item into the same card shape
// renderTrackCard/queue/now-playing expect. video_id (not a Spotify uri or a
// local numeric id) is what handleTrackPlayClick's 'ytmusic' branch and the
// embedded player use to actually play it - matching/playing on Spotify
// instead (also handled by that branch) resolves track_name/artist_name
// through the existing text-only Spotify matching pipeline, same as Discover.
function mapYtMusicTrack(t) {
  return {
    id: t.video_id,
    source: 'ytmusic',
    video_id: t.video_id,
    track_name: t.track_name,
    artist_name: t.artist_name,
    artwork_url: t.artwork_url,
    // Only ever present on a track pulled from the Playlists tab's "All
    // Tracks" cache (see fetchAllPlaylistTracksFlat) - undefined for a
    // drilled-into-one-playlist track, which comes straight from the live
    // per-playlist endpoint and was never run through playlist_match_prewarm.
    // matchAndQueueYtMusicPlaylistTracksOnSpotify uses this to skip the live
    // Spotify search entirely when already resolved.
    matched_spotify_uri: t.matched_spotify_uri,
    // Set when this same video also exists as a local file (see
    // main.py's _attach_local_track_ids / bulk_backfill_local_track_ids) -
    // lets This Browser stream the local file instead of opening a new tab.
    local_id: t.local_track_id,
  };
}

const SESSION_KEY = 'md_playback_session_v1';
const POSITION_KEY = 'md_playback_position_v1';
const LIBRARY_VIEW_KEY = 'md_library_view_v1';
const SHUFFLED_IDS_KEY = 'md_library_shuffle_order_v1';
const QUEUE_PERSIST_CAP = 200;
const HISTORY_PERSIST_CAP = 50;
const CHROMECAST_QUEUE_WINDOW = 30;
// Caps how many track uris get sent to Spotify (and kept in our own queue)
// for a Spotify playlist's tracks - these already have known uris (no /search
// needed, unlike matched local tracks), so this is just a sane payload-size
// cap, not a rate-limit concern.
const SPOTIFY_PLAY_QUEUE_LIMIT = 100;
// One-at-a-time Spotify matching (see findNextSpotifyMatch): how many
// consecutive no-match candidates to try before giving up on finding
// *something* playable in a given pool - protects against burning requests
// unboundedly into a long dry streak in an unlucky shuffle order.
const SPOTIFY_MATCH_CONSECUTIVE_CAP = 20;
// The device-status poll (below) runs continuously while a destination is
// selected - at the default 2s interval that's ~1,800 Spotify API calls/hour
// for a single open session, a real contributor to hitting Spotify's
// account-wide rate limit on the player endpoints (confirmed live: a burst
// of testing triggered a ~2 hour lockout on /me/player*). WiiM/Chromecast
// polling stays fast since those are free local-network calls, not a quota
// concern - only Spotify's poll interval is widened.
const SPOTIFY_STATUS_POLL_INTERVAL_MS = 5000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
// Must match YTMUSIC_LIBRARY_PUSH_LIMIT in main.py - shown in the push
// button's tooltip only, the server enforces the actual cap.
const YTMUSIC_LIBRARY_PUSH_LIMIT = 30;

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Group keys for the album/artist shuffle modes below - matches the "artist||
// album" identity paramsForGroupKey/the album browse view already use, so an
// album shuffle treats same-titled albums by different artists as distinct,
// and only folds them together for the empty-artist "compilation" case.
const albumGroupKey = (t) => `${t.artist_name || ''}||${t.album_name || ''}`;
const artistGroupKey = (t) => t.artist_name || '';

function countDistinct(tracks, groupKeyFn) {
  return new Set(tracks.map(groupKeyFn)).size;
}

// Round-robin-by-group shuffle: each "round" is a randomized pass over every
// group that still has unplayed tracks, contributing exactly one random track
// per group per round (so no group repeats within a round), until either
// maxCount tracks have been picked or every track has been used. Groups are
// pre-shuffled once up front so "pick a random track from the group" is just
// an O(1) pop instead of re-randomizing the remaining pool on every draw.
function groupedShuffle(tracks, groupKeyFn, maxCount) {
  const groups = new Map();
  for (const t of tracks) {
    const key = groupKeyFn(t);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  for (const pool of groups.values()) {
    const shuffledPool = shuffleArray(pool);
    pool.length = 0;
    pool.push(...shuffledPool);
  }
  const limit = maxCount ?? Infinity;
  const result = [];
  while (result.length < limit) {
    const roundKeys = shuffleArray([...groups.keys()].filter((k) => groups.get(k).length > 0));
    if (roundKeys.length === 0) break;
    for (const key of roundKeys) {
      if (result.length >= limit) break;
      result.push(groups.get(key).pop());
    }
  }
  return result;
}

// Player-bar icons as SVGs (currentColor) rather than emoji - a color emoji
// glyph (the old 🔊/📡/📺 destination icons) renders with its own built-in
// color regardless of CSS `color`, which is why the destination button could
// never actually match the shuffle button's color even though both use the
// exact same .active background/color rules underneath.
const IconPlay = (props) => (
  <svg viewBox="0 0 24 24" width="1em" height="1em" {...props}><polygon points="6,4 20,12 6,20" fill="currentColor" /></svg>
);
const IconPause = (props) => (
  <svg viewBox="0 0 24 24" width="1em" height="1em" {...props}>
    <rect x="5" y="4" width="5" height="16" fill="currentColor" />
    <rect x="14" y="4" width="5" height="16" fill="currentColor" />
  </svg>
);
const IconPrev = (props) => (
  <svg viewBox="0 0 24 24" width="1em" height="1em" {...props}>
    <rect x="4" y="4" width="3" height="16" fill="currentColor" />
    <polygon points="20,4 9,12 20,20" fill="currentColor" />
  </svg>
);
const IconNext = (props) => (
  <svg viewBox="0 0 24 24" width="1em" height="1em" {...props}>
    <polygon points="4,4 15,12 4,20" fill="currentColor" />
    <rect x="17" y="4" width="3" height="16" fill="currentColor" />
  </svg>
);
const IconShuffle = (props) => (
  <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <polyline points="16 3 21 3 21 8" />
    <line x1="4" y1="20" x2="21" y2="3" />
    <polyline points="21 16 21 21 16 21" />
    <line x1="15" y1="15" x2="21" y2="21" />
    <line x1="4" y1="4" x2="9" y2="9" />
  </svg>
);
// Volume icon shows mute/low/high like Spotify's own volume button - a
// speaker cone alone (muted), plus one wave (low) or two (high) - rather
// than a fixed glyph regardless of level.
const IconVolumeMute = (props) => (
  <svg viewBox="0 0 24 24" width="1em" height="1em" {...props}>
    <polygon points="11,5 6,9 2,9 2,15 6,15 11,19" fill="currentColor" />
    <line x1="16" y1="9" x2="21" y2="15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <line x1="21" y1="9" x2="16" y2="15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);
const IconVolumeLow = (props) => (
  <svg viewBox="0 0 24 24" width="1em" height="1em" {...props}>
    <polygon points="11,5 6,9 2,9 2,15 6,15 11,19" fill="currentColor" />
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);
const IconVolumeHigh = (props) => (
  <svg viewBox="0 0 24 24" width="1em" height="1em" {...props}>
    <polygon points="11,5 6,9 2,9 2,15 6,15 11,19" fill="currentColor" />
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <path d="M18.07 5.93a9 9 0 0 1 0 12.14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);
const IconVolume = ({ level, ...props }) => (
  level === 0 ? <IconVolumeMute {...props} /> : level < 50 ? <IconVolumeLow {...props} /> : <IconVolumeHigh {...props} />
);
// "Connect to a device" glyph (Spotify's own icon for this button is a
// monitor/screen with a cast signal, not a speaker - a speaker there reads as
// a volume control and gets confused with the actual volume button).
const IconDevices = (props) => (
  <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="2" y="4" width="15" height="11" rx="1.5" />
    <line x1="7" y1="19" x2="12" y2="19" />
    <path d="M17.5 9a3.5 3.5 0 0 1 0 5" />
    <path d="M20 6.5a7 7 0 0 1 0 11" />
  </svg>
);

// Maps a browse-by group ("genre", "quality", ...) and its key to the query
// params /api/tracks/known expects for that group, shared between filtering
// the flat track list and queuing a whole group's tracks for playback.
function paramsForGroupKey(by, key) {
  if (by === 'genre') return { genre: key };
  if (by === 'decade') return { decade: Number(key) };
  if (by === 'album') {
    const [artist, album] = key.split('||');
    // Empty artist means the album grouping treated this as a compilation
    // (many distinct per-track artists) - filter by album alone in that case.
    return artist ? { artist, album } : { album };
  }
  if (by === 'quality') return { quality: key };
  if (by === 'format') return { format: key };
  if (by === 'length') return { length: key };
  if (by === 'favorite') return { favorite: key === 'Favorites' };
  return {};
}

// Parsed once per page load: avoids re-parsing a potentially large JSON blob
// on every lazy useState initializer that needs a piece of the saved session.
let _cachedSession;
function loadSession() {
  if (_cachedSession !== undefined) return _cachedSession;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    _cachedSession = raw ? JSON.parse(raw) : null;
  } catch {
    _cachedSession = null;
  }
  return _cachedSession;
}

function loadPosition() {
  try {
    const raw = localStorage.getItem(POSITION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// Same lazy-cached-once pattern as loadSession above, for the same reason -
// several useState initializers below each need a piece of this.
let _cachedLibraryView;
function loadLibraryView() {
  if (_cachedLibraryView !== undefined) return _cachedLibraryView;
  try {
    const raw = localStorage.getItem(LIBRARY_VIEW_KEY);
    _cachedLibraryView = raw ? JSON.parse(raw) : null;
  } catch {
    _cachedLibraryView = null;
  }
  return _cachedLibraryView;
}

function saveLibraryView(view) {
  try {
    localStorage.setItem(LIBRARY_VIEW_KEY, JSON.stringify(view));
  } catch {
    /* localStorage unavailable - filters just won't survive a reload this time */
  }
}

// Separate key from LIBRARY_VIEW_KEY (not folded into the same blob) since
// this can hold thousands of ids for an unfiltered shuffle, while the view/
// filters blob above should stay small and cheap to parse on every load.
function loadShuffledIds() {
  try {
    const raw = localStorage.getItem(SHUFFLED_IDS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveShuffledIds(ids) {
  try {
    localStorage.setItem(SHUFFLED_IDS_KEY, JSON.stringify(ids));
  } catch {
    // Quota exceeded on a very large library - the next reload just falls
    // back to a fresh shuffle instead of the exact prior order.
    try { localStorage.removeItem(SHUFFLED_IDS_KEY); } catch { /* ignore */ }
  }
}

function saveSession(session) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Quota exceeded (a long queue can add up) - fall back to just enough to
    // resume the current track, dropping the upcoming-queue/history payload.
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ ...session, queue: [], history: [] }));
    } catch {
      /* localStorage unavailable - resume-on-reload just won't work this time */
    }
  }
}

function savePosition(position) {
  try {
    localStorage.setItem(POSITION_KEY, JSON.stringify(position));
  } catch {
    /* ignore */
  }
}

// Brand icons for the push-to-* buttons - path data + hex colors from the
// simple-icons project (simple-icons/simple-icons, MIT licensed), not
// hand-drawn, so the shapes/colors are exactly the official marks.
function SpotifyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="#1DB954" aria-hidden="true" focusable="false">
      <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
    </svg>
  );
}

function YtMusicIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="#FF0000" aria-hidden="true" focusable="false">
      <path d="M12 0C5.376 0 0 5.376 0 12s5.376 12 12 12 12-5.376 12-12S18.624 0 12 0zm0 19.104c-3.924 0-7.104-3.18-7.104-7.104S8.076 4.896 12 4.896s7.104 3.18 7.104 7.104-3.18 7.104-7.104 7.104zm0-13.332c-3.432 0-6.228 2.796-6.228 6.228S8.568 18.228 12 18.228s6.228-2.796 6.228-6.228S15.432 5.772 12 5.772zM9.684 15.54V8.46L15.816 12l-6.132 3.54z" />
    </svg>
  );
}

// Dismiss-required popup, reusing the Settings modal's overlay/card look for
// a consistent visual language - used for messages that shouldn't silently
// vanish before being read (confirmed live: the 4s auto-fade hint cut off a
// message about a background push job starting before it could be read).
function InfoPopup({ message, onClose }) {
  if (!message) return null;
  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal info-popup" onClick={(e) => e.stopPropagation()}>
        <p>{message}</p>
        <button type="button" className="scan-btn" onClick={onClose}>OK</button>
      </div>
    </div>
  );
}

// Opened by clicking the library view's "Push to YouTube Music" button -
// shows the current push job's status (a push too large for one request
// becomes a multi-day background job, see YTMUSIC_LIBRARY_PUSH_LIMIT in
// main.py) as a progress bar, plus a button to push the currently-shown mix.
// Polls only while open (5s - faster than the old always-mounted panel,
// since this is now something the user is actively looking at).
function YtMusicPushPanel({ apiBase, onPush, pushing, onClose }) {
  const [jobStatus, setJobStatus] = useState(null);
  // Only fetched (and only shown) once there's more than one pending push -
  // for the common single-job case the /status response above already has
  // everything needed, no reason to pay for a second request.
  const [pendingJobs, setPendingJobs] = useState(null);

  const refresh = () => {
    axios.get(`${apiBase}/ytmusic/push-job/status`).then((response) => {
      setJobStatus(response.data);
      if ((response.data.queued_count || 0) > 0) {
        axios.get(`${apiBase}/ytmusic/push-jobs`)
          .then((jobsResponse) => setPendingJobs(jobsResponse.data))
          .catch((err) => console.error('Error fetching pending YouTube Music push jobs:', err));
      } else {
        setPendingJobs(null);
      }
    }).catch((err) => console.error('Error fetching YouTube Music push job status:', err));
  };

  useEffect(() => {
    refresh();
    const intervalId = setInterval(refresh, 5000);
    return () => clearInterval(intervalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase]);

  const removeJob = (jobId) => {
    axios.delete(`${apiBase}/ytmusic/push-jobs/${jobId}`)
      .then(refresh)
      .catch((err) => console.error('Error removing YouTube Music push job:', err));
  };

  const total = jobStatus?.total || 0;
  const processed = jobStatus?.tracks_processed_total || 0;
  const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const hasJob = jobStatus && jobStatus.status !== 'idle';
  // A push while one is already active/waiting_quota/queued just joins the
  // back of the FIFO queue instead of being blocked - the button always
  // works, only the label changes to set the right expectation.
  const willQueue = jobStatus && ['running', 'waiting_quota', 'queued'].includes(jobStatus.status);
  const showList = pendingJobs && pendingJobs.length > 1;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal ytmusic-push-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>YouTube Music Push</h2>
          <button className="settings-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>

        {showList ? (
          <div className="ytmusic-pending-list">
            {pendingJobs.map((job) => (
              <div key={job.id} className="ytmusic-pending-row">
                <div className="ytmusic-pending-info">
                  <strong>{job.name}</strong>
                  <span className="hint">
                    {(job.total || 0).toLocaleString()} track{job.total === 1 ? '' : 's'}
                    {' · '}created {job.created_at ? new Date(job.created_at).toLocaleDateString() : 'just now'}
                    {' · '}{job.status === 'queued'
                      ? 'queued'
                      : `${(job.tracks_processed_total || 0).toLocaleString()}/${(job.total || 0).toLocaleString()} done`}
                  </span>
                </div>
                <button
                  type="button"
                  className="settings-close"
                  title="Remove this push - stops future work on it, doesn't undo tracks already added"
                  onClick={() => removeJob(job.id)}
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
        ) : hasJob ? (
          <>
            <div className="progress-bar-track">
              <div className="progress-bar-fill" style={{ width: `${percent}%` }} />
            </div>
            <p className="hint">
              {jobStatus.status === 'done'
                ? `Done — ${(jobStatus.matched || 0).toLocaleString()} of ${total.toLocaleString()} tracks added to "${jobStatus.name}".`
                : jobStatus.status === 'error'
                  ? `Error: ${jobStatus.error}`
                  : jobStatus.status === 'queued'
                    ? `Queued — "${jobStatus.name}" (${total.toLocaleString()} tracks) will start once the current push finishes.`
                    : (
                      `${processed.toLocaleString()}/${total.toLocaleString()} tracks — "${jobStatus.name}"` +
                      (jobStatus.status === 'waiting_quota' ? ' — paused until more quota is available' : '') +
                      (jobStatus.pace_tracks_per_day ? ` — ~${Math.round(jobStatus.pace_tracks_per_day)}/day` : '') +
                      (jobStatus.eta_days != null
                        ? `, ETA ${jobStatus.eta_days < 1 ? '< 1 day' : `~${Math.ceil(jobStatus.eta_days)}d`}`
                        : '')
                    )}
              {jobStatus.playlist_url && (
                <> — <a href={jobStatus.playlist_url} target="_blank" rel="noreferrer">view playlist</a></>
              )}
            </p>
          </>
        ) : (
          <p className="hint">No push in progress yet.</p>
        )}

        <button
          className="group-action-btn"
          onClick={onPush}
          disabled={pushing}
          title={willQueue
            ? 'A push is already in progress - this will join the back of the queue and start once it and any others ahead of it finish'
            : `Create a YouTube Music playlist from the tracks currently shown (matched live, capped at the first ${YTMUSIC_LIBRARY_PUSH_LIMIT}, or a paced background job above that)`}
        >
          <YtMusicIcon /> {pushing
            ? 'Pushing…'
            : willQueue
              ? 'Queue another push to YouTube Music'
              : 'Push current mix to YouTube Music'}
        </button>
      </div>
    </div>
  );
}

function App() {
  // Discover-tab suggestions (AI-recommended tracks seeded from the Library
  // tab's own current filters) - rendered inline in the Library tab, not a
  // separate tab, so this lives alongside the rest of the library state.
  const [discoveredTracks, setDiscoveredTracks] = useState([]);
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState(null);
  // How many recommended tracks to ask for - a ceiling, not a guarantee
  // (see the matching clamp/comment on DiscoveryParameters.limit in
  // main.py - a narrow seed can still return fewer than this).
  const [discoverTrackCount, setDiscoverTrackCount] = useState(10);
  // Live checkbox state - "should the *next* Discover run group by artist".
  const [discoverGroupByArtist, setDiscoverGroupByArtist] = useState(false);
  // Whether the *current* discoveredTracks batch was actually grouped -
  // separate from the checkbox above since that can change before the next
  // run; rendering needs to reflect what the results actually are, not
  // whatever the checkbox currently says.
  const [discoveredGroupedByArtist, setDiscoveredGroupedByArtist] = useState(false);
  // Toggles the Library tab's main content between the filtered library grid
  // and the Discovered-for-you results, rather than always stacking both -
  // false (library) is the default; flips to true automatically once a
  // Discover run actually produces results.
  const [showDiscoverPanel, setShowDiscoverPanel] = useState(false);

  const [activeTab, setActiveTab] = useState(() => {
    const saved = loadLibraryView();
    // Spotify/YT Music playlist browsing used to live as two library-mode
    // sub-tabs inside "My Library" - now consolidated into their own top-level
    // "Playlists" tab. A reload from before this change would otherwise land
    // back on "My Library" with a libraryMode it no longer has a tab for.
    if ((saved?.libraryMode === 'playlist' || saved?.libraryMode === 'ytmusic-playlist') && (saved?.activeTab ?? 'library') === 'library') {
      return 'playlists';
    }
    return saved?.activeTab ?? 'library';
  });
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [rootPath, setRootPath] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState(null);
  const [scanError, setScanError] = useState(null);
  const [stats, setStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const pollRef = useRef(null);

  // Library browsing: flat search/filter or grouped-by-album/genre/decade/... with drill-down
  // - restored from localStorage so a reload or reopened tab returns to the
  // same view/filters instead of resetting to the defaults every time
  // (same "resume where you left off" treatment already given to playback).
  const [libraryMode, setLibraryMode] = useState(() => loadLibraryView()?.libraryMode ?? 'all');
  const [drill, setDrill] = useState(() => loadLibraryView()?.drill ?? null); // { by, key, label } once a group is opened
  // Terminal Spotify-matching outcomes only (rate-limited, no match,
  // wrong-destination instructions, push failures) - shown as a
  // dismiss-required popup (InfoPopup) since these need to actually be
  // read, not glanced at. null when hidden.
  const [spotifyPlayHint, setSpotifyPlayHint] = useState(null);
  // A transient "Searching Spotify for X…" progress indicator, kept
  // deliberately separate from spotifyPlayHint above - it's not something
  // that needs deliberate reading (the per-track spinner icon already
  // covers "something is happening"), and confirmed live that funneling it
  // through the same popup as genuine errors made it flash and vanish
  // before it could be read, since it's always immediately superseded by
  // either a real result or the terminal error message. Always explicitly
  // cleared by whichever function sets it, once resolved either way -
  // never relies on a timeout.
  const [spotifyMatchProgress, setSpotifyMatchProgress] = useState(null);
  const [pushingToSpotify, setPushingToSpotify] = useState(false);
  const [ytMusicPlayHint, setYtMusicPlayHint] = useState(null);
  const [pushingToYtMusic, setPushingToYtMusic] = useState(false);
  const [ytMusicPushPanelOpen, setYtMusicPushPanelOpen] = useState(false);
  // True when the currently-drilled Spotify playlist's tracks came back 403 -
  // Spotify blocks reading the track listing of a playlist you don't own,
  // even public/followed ones, though playing it via context_uri still works.
  const [playlistTracksRestricted, setPlaylistTracksRestricted] = useState(false);
  // Client-side only - the Playlists tab's whole group/track list is already
  // fetched in full (see fetchSpotifyPlaylistsAsGroups/fetchYtMusicPlaylistsAsGroups
  // and their track-list counterparts), so filtering it doesn't need a server
  // round trip the way the main Library search does.
  const [playlistSearchInput, setPlaylistSearchInput] = useState('');
  // "All Tracks" mode for the Playlists tab - every track from every playlist
  // on the current platform, flattened into one searchable list, instead of
  // browsing one playlist at a time. Independent of drill/groups (those still
  // drive "By Playlist" mode) - fetched fresh whenever this turns on or the
  // platform switches.
  const [playlistsFlatView, setPlaylistsFlatView] = useState(false);
  const [flatPlaylistTracks, setFlatPlaylistTracks] = useState([]);
  const [flatPlaylistTracksLoading, setFlatPlaylistTracksLoading] = useState(false);
  // Spotify playlists this account doesn't own can't have their individual
  // tracks read (see playlistTracksRestricted above) - counted so the flat
  // view can say why its total looks short instead of silently omitting them.
  const [flatPlaylistSkippedCount, setFlatPlaylistSkippedCount] = useState(0);
  // When the cache backing this view was last built (server timestamp) - null
  // until the first fetch resolves.
  const [flatPlaylistRefreshedAt, setFlatPlaylistRefreshedAt] = useState(null);
  // id of a local track currently being searched for on Spotify (drives a
  // loading indicator on its play button) - null when nothing's in flight.
  const [matchingTrackId, setMatchingTrackId] = useState(null);
  // Session-long history for the Library/Playlists track grid: every id
  // that's been nowPlaying at some point (any destination) gets a green
  // checkmark, every local track a Spotify batch-match couldn't find gets a
  // red X. Both just accumulate for the life of the page load - not
  // persisted, not reset between queues.
  const [playedTrackIds, setPlayedTrackIds] = useState(() => new Set());
  const [skippedTrackIds, setSkippedTrackIds] = useState(() => new Set());
  const [searchInput, setSearchInput] = useState(() => loadLibraryView()?.search ?? '');
  const [search, setSearch] = useState(() => loadLibraryView()?.search ?? '');
  // Dedicated artist-name typeahead, separate from the general search box
  // above (which already matches artist/track/album together but has no
  // suggestion dropdown) - picking a suggestion filters the library to that
  // artist via the same search mechanism, just pre-filled with an exact name.
  const [artistSearchInput, setArtistSearchInput] = useState('');
  const [artistSuggestions, setArtistSuggestions] = useState([]);
  const [artistSuggestionsOpen, setArtistSuggestionsOpen] = useState(false);
  const [artistSuggestionHighlight, setArtistSuggestionHighlight] = useState(-1);
  const [filterGenre, setFilterGenre] = useState(() => loadLibraryView()?.filterGenre ?? '');
  const [filterDecade, setFilterDecade] = useState(() => loadLibraryView()?.filterDecade ?? '');
  // Defaults to deduping same-song duplicate rips down to the best copy - see
  // the "Best Quality Only" <option> below and the `quality=best` handling in
  // /api/tracks/known.
  const [filterQuality, setFilterQuality] = useState(() => loadLibraryView()?.filterQuality ?? 'best');
  const [filterFormat, setFilterFormat] = useState(() => loadLibraryView()?.filterFormat ?? '');
  // Restricts to tracks that already have a cached Spotify match, so Shuffle
  // All/Play All can be tested without any live search - isolates playback
  // bugs from the currently-active Spotify search rate limit.
  const [filterSpotifyAvailable, setFilterSpotifyAvailable] = useState(() => loadLibraryView()?.filterSpotifyAvailable ?? false);
  // Caps how many matching tracks actually get fetched/shown - '' means no
  // cap. Applied client-side (clamping libraryTotal/the shuffled fetch size)
  // rather than as a server-side WHERE filter, since it's about how many
  // results to display, not which tracks match.
  const [filterTrackLimit, setFilterTrackLimit] = useState(() => loadLibraryView()?.filterTrackLimit ?? '');
  const [genreOptions, setGenreOptions] = useState([]);
  const [decadeOptions, setDecadeOptions] = useState([]);
  const [qualityOptions, setQualityOptions] = useState([]);
  const [formatOptions, setFormatOptions] = useState([]);
  const [groups, setGroups] = useState([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [libraryTracks, setLibraryTracks] = useState([]);
  const [libraryTotal, setLibraryTotal] = useState(0);
  // Distinct album/artist counts for whatever's behind libraryTotal above -
  // the paginated default browse view gets these straight from the server
  // (a true count over the whole filtered set, unaffected by how many pages
  // have actually loaded), while every shuffle-fetch path below computes them
  // client-side from the actual (possibly maxCount-capped) track list, since
  // a random sample's album/artist diversity can't be derived from the full
  // filtered set's totals alone.
  const [libraryAlbumCount, setLibraryAlbumCount] = useState(0);
  const [libraryArtistCount, setLibraryArtistCount] = useState(0);
  const [libraryLoading, setLibraryLoading] = useState(false);
  // Flat-library shuffle mode: '' (off), 'track' (plain "Shuffle All"),
  // 'album' (random album order, one random track per album per round), or
  // 'artist' (same, grouped by artist). While set, the flat library list
  // itself is fetched and displayed in the matching shuffled order that got
  // queued for playback, instead of the default alphabetical browse order.
  const [libraryShuffleMode, setLibraryShuffleMode] = useState(() => loadLibraryView()?.libraryShuffleMode ?? '');
  // Tracks the last filter/mode/drill/search combo the library-fetch effect
  // below actually fetched for, so it can tell "a filter genuinely changed"
  // apart from "activeTab just flipped back to library" - see that effect.
  const libraryFetchKeyRef = useRef(null);
  // True only when libraryShuffleMode was restored from a prior session (not
  // a fresh toggle click) - the very first fetch after a reload should show
  // the deterministic list, not roll a brand-new random order that's
  // immediately disconnected from whatever's actually still playing
  // (confirmed live: refreshing mid-shuffle produced a completely different
  // track list every single time, since "shuffle" always re-randomizes from
  // scratch and only the mode *preference* was ever persisted, never a
  // specific order).
  const skipInitialShuffleFetchRef = useRef(!!loadLibraryView()?.libraryShuffleMode);
  const [trackViewStyle, setTrackViewStyle] = useState(() => {
    try {
      return localStorage.getItem('md_track_view_style') || 'list';
    } catch {
      return 'list';
    }
  });

  // Playback - initialized from a previously saved session (if any) so a page
  // reload or reopening the tab returns to what was playing.
  const [queue, setQueue] = useState(() => loadSession()?.queue || []);
  const [history, setHistory] = useState(() => loadSession()?.history || []);
  const [nowPlaying, setNowPlaying] = useState(() => loadSession()?.nowPlaying || null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [shuffleEnabled, setShuffleEnabled] = useState(() => loadSession()?.shuffleEnabled || false);
  // Gates the <audio> autoPlay attribute: a restored session shouldn't blast
  // sound the instant the page loads, but a genuine user-initiated track
  // change should still autoplay exactly as before.
  const [userHasInteracted, setUserHasInteracted] = useState(false);
  const [initialSeekMs, setInitialSeekMs] = useState(() => {
    const session = loadSession();
    const position = loadPosition();
    if (session?.nowPlaying && position && position.trackId === session.nowPlaying.id && !session.outputDevice) {
      return position.positionMs ?? null;
    }
    return null;
  });
  const audioRef = useRef(null);
  const preShuffleQueueRef = useRef(null);
  // Skips the WiiM auto-cast effect's very first run, which otherwise fires
  // immediately on mount whenever a session with an active device is restored.
  const skipInitialCastRef = useRef(true);
  // True only when we restored a session that had an active cast device -
  // the first Play press for that session needs to (re-)cast the track
  // rather than just resume, since we skip the auto-cast on restore.
  const destNeedsInitialCastRef = useRef(!!loadSession()?.outputDevice);

  // Output routing: null = play in this browser, otherwise cast to a WiiM or
  // Chromecast device. Both device lists are tagged with `type` on fetch so
  // a single outputDevice object always carries which API prefix to use.
  const [wiimDevices, setWiimDevices] = useState([]);
  const [chromecastDevices, setChromecastDevices] = useState([]);
  const [spotifyDevices, setSpotifyDevices] = useState([]);
  const [spotifyConnected, setSpotifyConnected] = useState(false);
  const [ytMusicConnected, setYtMusicConnected] = useState(false);
  const outputDevices = [...wiimDevices, ...chromecastDevices, ...spotifyDevices];
  const [outputDevice, setOutputDevice] = useState(() => loadSession()?.outputDevice || null);
  const [destStatus, setDestStatus] = useState(null);
  const [volume, setVolume] = useState(() => {
    const saved = Number(localStorage.getItem('playerVolume'));
    return Number.isFinite(saved) && saved >= 0 && saved <= 100 ? saved : 100;
  });
  const destStatusRef = useRef(null);
  const prevOutputDeviceRef = useRef(null);
  // True once a Chromecast device has a real multi-item queue loaded (so its
  // own next/prev, including the TV remote's skip buttons, has something to
  // navigate between) - reset whenever the output device changes.
  const chromecastQueueLoadedRef = useRef(false);
  // Set right before handleNext/handlePrev call queue-next/queue-prev, so the
  // generic cast effect knows this nowPlaying change was already handled
  // device-side and shouldn't re-push/reload the queue.
  const skipNextCastPushRef = useRef(false);
  // Last content_id we saw from Chromecast's own status, to detect when the
  // TV's remote (not our UI) moved to a different queue item.
  const lastContentIdRef = useRef(null);

  const API_BASE_URL = process.env.REACT_APP_API_URL || '/api';
  const deviceEndpoint = (device) => `${API_BASE_URL}/${device.type}/devices/${device.id}`;

  // Just the device list (not the auth-status round trip) - cheap enough to
  // call every time the destination picker opens, so its status dots (see
  // spotify_connect._device_last_outcome) reflect the latest known
  // reliability rather than whatever was fetched once at page load.
  const refreshSpotifyDevices = () => {
    axios.get(`${API_BASE_URL}/spotify/devices`)
      .then((dr) => setSpotifyDevices(dr.data.map((d) => ({ ...d, type: 'spotify' }))))
      .catch((err) => console.error('Error fetching Spotify devices:', err));
  };

  const refreshSpotifyStatus = () => {
    axios.get(`${API_BASE_URL}/spotify/auth/status`)
      .then((r) => {
        setSpotifyConnected(r.data.connected);
        if (r.data.connected) {
          refreshSpotifyDevices();
        } else {
          setSpotifyDevices([]);
        }
      })
      .catch((err) => console.error('Error fetching Spotify auth status:', err));
  };

  const refreshYtMusicStatus = () => {
    axios.get(`${API_BASE_URL}/ytmusic/auth/status`)
      .then((r) => setYtMusicConnected(r.data.connected))
      .catch((err) => console.error('Error fetching YouTube Music auth status:', err));
  };

  useEffect(() => {
    resumeScanIfRunning();
    axios.get(`${API_BASE_URL}/wiim/devices`)
      .then((r) => setWiimDevices(r.data.map((d) => ({ ...d, type: 'wiim' }))))
      .catch((err) => console.error('Error fetching WiiM devices:', err));
    axios.get(`${API_BASE_URL}/chromecast/devices`)
      .then((r) => setChromecastDevices(r.data.map((d) => ({ ...d, type: 'chromecast' }))))
      .catch((err) => console.error('Error fetching Chromecast devices:', err));
    refreshSpotifyStatus();
    refreshYtMusicStatus();
    // Landed back here from the Spotify OAuth redirect (main.py's
    // /api/spotify/auth/callback) - the ?spotify=... param is just a signal
    // to re-check status, not something to keep in the URL/history.
    if (window.location.search.includes('spotify=')) {
      window.history.replaceState({}, '', window.location.pathname);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cast the current track to the selected device whenever it changes. The
  // very first run is skipped: when a session with an active device is
  // restored on load, outputDevice/nowPlaying are already set on mount, and
  // we don't want to blast audio to the device before the user asks for it.
  // A second way to skip: handleNext/handlePrev already told an active
  // Chromecast queue to advance itself via queue-next/queue-prev, so this
  // effect shouldn't also re-push/reload the whole queue for that change.
  useEffect(() => {
    if (skipInitialCastRef.current) {
      skipInitialCastRef.current = false;
      return;
    }
    if (!outputDevice || !nowPlaying) return;
    if (skipNextCastPushRef.current) {
      skipNextCastPushRef.current = false;
      return;
    }
    if (nowPlaying.source === 'spotify') {
      if (outputDevice.type !== 'spotify') {
        // Switched away from Spotify to a local-only destination. If this
        // track also resolves a local file (mapMatchedLocalTrack's
        // local_id, or the known_tracks cross-reference on a genuine
        // Spotify playlist track - see mapSpotifyTrack), fall back to
        // playing that there instead of leaving the new destination
        // silent - a Spotify-only track (no local equivalent at all) has
        // nothing to fall back to.
        const localId = resolveLocalTrackId(nowPlaying);
        if (localId != null) castLocalTrack(localId);
        return;
      }
      const endpoint = nowPlaying.context_uri ? 'play' : 'play-uris';
      // For an ad-hoc (non-playlist) queue, hand Spotify the *whole* matched
      // queue in this one call, not just the current track - that's what
      // gives Spotify a real queue to advance through, so Next/Prev work
      // both via our /next//previous proxy and natively in the Spotify app.
      // This is a genuinely new session starting (as opposed to an in-app
      // Next/Prev, which skip this effect via skipNextCastPushRef) -
      // clear_queue: true drains any queue residue from a previous session
      // first, so it can't splice in and surface later as a jump to
      // unrelated older music (Spotify has no "clear queue" endpoint, only
      // skip-past - see clear_queue's docstring in spotify_connect.py). Sent
      // as part of this same play call (not a separate request first) so the
      // backend can do transfer-drain-play as one uninterrupted sequence -
      // splitting it across two round trips let the device settle into a
      // stale "now playing" between them, which the second call's own
      // status-only confirm check then mistook for success.
      const payload = nowPlaying.context_uri
        ? { context_uri: nowPlaying.context_uri, track_uri: nowPlaying.uri, clear_queue: true }
        : { uris: [nowPlaying.uri, ...queue.slice(0, SPOTIFY_PLAY_QUEUE_LIMIT).map((t) => t.uri)], clear_queue: true };
      axios.post(`${deviceEndpoint(outputDevice)}/${endpoint}`, payload)
        .catch(handleSpotifyCastError)
        // The destination picker's status dot (see spotify_connect
        // ._device_last_outcome) only refreshes when the picker itself is
        // opened - without this, a device that fails or drops out *after*
        // the picker was last opened (including the backend's own delayed
        // sustain check, up to ~5s after this call resolves) never gets
        // reflected until the user happens to reopen the picker again.
        // Confirmed live: this is exactly what made a genuinely-failed
        // device still show its stale green dot.
        .finally(() => setTimeout(refreshSpotifyDevices, 7000));
      return;
    }
    if (nowPlaying.source === 'ytmusic') {
      if (outputDevice.type === 'spotify') {
        // Same reasoning as the spotify-source branch above, mirrored: a YT
        // Music playlist track has no local track_id Spotify could use even
        // if it also resolves one - it's already got its own dedicated
        // match pipeline (which also checks matched_spotify_uri first,
        // skipping a live search when already known).
        matchAndQueueYtMusicPlaylistTracksOnSpotify([nowPlaying, ...queue]);
        return;
      }
      const localId = resolveLocalTrackId(nowPlaying);
      if (localId != null) castLocalTrack(localId);
      return;
    }
    if (outputDevice.type === 'spotify') {
      // Switched destination to Spotify while a local track was already
      // playing - there's no local track_id Spotify can use, so resolve
      // nowPlaying (and the rest of the queue) the same way clicking a local
      // track does: search Spotify's catalog and play the match. Without
      // this, the old destination stops (its own effect handles that) and
      // Spotify never starts anything, which just looks like "switching
      // destination stopped my music."
      matchAndPlayLocalTracksOnSpotify([nowPlaying, ...queue]);
      return;
    }
    castLocalTrack(resolveLocalTrackId(nowPlaying));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outputDevice, nowPlaying]);

  // Stop the previous device when switching output (to a different device, or back to the browser).
  useEffect(() => {
    const prev = prevOutputDeviceRef.current;
    if (prev && prev.id !== outputDevice?.id) {
      axios.post(`${deviceEndpoint(prev)}/stop`).catch(() => {});
    }
    prevOutputDeviceRef.current = outputDevice;
    setDestStatus(null);
    chromecastQueueLoadedRef.current = false;
    lastContentIdRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outputDevice]);

  // Poll the device's real playback position so the UI reflects reality, and
  // detect track changes the app itself didn't just cause (natural end-of-
  // track, a device's own remote/app being used directly, or - for WiiM - the
  // backend's own playback_advancer having auto-advanced the queue while this
  // tab was asleep). WiiM has no native "what's playing" signal of its own
  // (see src/wiim.py) and no native advance either, so *driving* advancement
  // for it now happens entirely server-side (src/playback_advancer.py) - this
  // effect polls the resulting server-side session instead of the raw device
  // status, purely to keep the display in sync. Chromecast/Spotify still
  // self-advance (Chromecast's native queue, Spotify's own queue) and are
  // only reconciled here, not driven - same as before.
  useEffect(() => {
    if (!outputDevice || !nowPlaying) return;
    const isChromecast = outputDevice.type === 'chromecast';
    const isSpotify = outputDevice.type === 'spotify';
    const isWiim = outputDevice.type === 'wiim';
    // This whole effect (including the interval below) is torn down and
    // recreated whenever outputDevice/nowPlaying/queue/history change - e.g.
    // the instant a fresh play action sets a new nowPlaying. clearInterval
    // only stops *future* ticks though: a poll request already in flight at
    // that exact moment keeps running, and if it resolves afterward it would
    // otherwise reconcile using this closure's now-stale nowPlaying/queue/
    // history, incorrectly conclude the freshly-requested track "isn't
    // playing yet" and stomp it back to whatever the device was already on -
    // exactly the "plays its own queue" symptom. `cancelled` guards against
    // that: set once this effect instance is superseded, checked right after
    // the await, before touching any state.
    let cancelled = false;

    // Chromecast has a real device-side queue now, so track changes (whether
    // from the TV remote's own skip buttons or the device auto-advancing at
    // end-of-track) are detected by diffing content_id instead of the
    // near-end/stopped heuristics WiiM needs - that avoids double-advancing
    // when the device has *already* moved to the next queue item itself.
    const reconcileFromContentId = (contentId) => {
      if (!contentId || contentId === lastContentIdRef.current) return;
      lastContentIdRef.current = contentId;
      const match = contentId.match(/\/tracks\/(\d+)\/stream/);
      if (!match) return;
      const newTrackId = Number(match[1]);
      if (nowPlaying && newTrackId === nowPlaying.id) return;

      const forwardIndex = queue.findIndex((t) => t.id === newTrackId);
      if (forwardIndex !== -1) {
        skipNextCastPushRef.current = true;
        setHistory((h) => [...h, ...(nowPlaying ? [nowPlaying] : []), ...queue.slice(0, forwardIndex)]);
        setNowPlaying(queue[forwardIndex]);
        setIsPlaying(true);
        setQueue((q) => q.slice(forwardIndex + 1));
        return;
      }

      const reverseIndex = [...history].reverse().findIndex((t) => t.id === newTrackId);
      if (reverseIndex !== -1) {
        const historyIndex = history.length - 1 - reverseIndex;
        skipNextCastPushRef.current = true;
        setQueue((q) => [...history.slice(historyIndex + 1), ...(nowPlaying ? [nowPlaying] : []), ...q]);
        setNowPlaying(history[historyIndex]);
        setIsPlaying(true);
        setHistory((h) => h.slice(0, historyIndex));
        return;
      }

      // Skipped beyond our tracked window - just resync what's displayed;
      // the upcoming-queue list may be briefly stale until the next action.
      skipNextCastPushRef.current = true;
      axios.get(`${API_BASE_URL}/tracks/${newTrackId}`)
        .then((r) => { setNowPlaying(r.data); setIsPlaying(true); })
        .catch((err) => console.error('Error fetching track for Chromecast resync:', err));
    };

    // WiiM equivalent of reconcileFromContentId/reconcileFromSpotifyTrackUri,
    // but diffing against our own backend's playback_session row instead of
    // a device-reported identity - WiiM's own status has no such signal (see
    // src/wiim.py), so the backend's playback_advancer is what's now driving
    // advancement, and this just notices when it has.
    const reconcileFromServerSession = (session) => {
      const sessionTrack = session.now_playing;
      const sessionId = sessionTrack?.id;
      const trackChanged = sessionId != null && sessionId !== lastContentIdRef.current;
      if (trackChanged) lastContentIdRef.current = sessionId;

      // The backend's own lookahead-refill (playback_advancer._advance_spotify)
      // now drives ongoing matching during playback, not just the frontend's
      // one-shot findNextSpotifyMatch on the initial click - but it has no
      // channel back to the frontend for which candidates it tried and
      // skipped, so skippedTrackIds (the ✕ badge) only ever reflected that
      // first click and went stale for everything after (confirmed live:
      // most skips during an ongoing Shuffle-All-via-Spotify session showed
      // no badge at all). spotify_match_pool.cursor is already synced every
      // poll regardless - candidates[0:cursor] minus whatever's actually
      // playing or buffered next is exactly the set the backend tried and
      // rejected.
      const pool = session.spotify_match_pool;
      if (pool && Array.isArray(pool.candidates) && pool.cursor > 0) {
        const currentLocalId = sessionTrack?.local_id;
        const queuedLocalIds = new Set((session.queue || []).map((t) => t.local_id).filter((id) => id != null));
        const skippedIds = pool.candidates
          .slice(0, pool.cursor)
          .map((c) => c.id)
          .filter((id) => id !== currentLocalId && !queuedLocalIds.has(id));
        if (skippedIds.length) {
          setSkippedTrackIds((prev) => {
            const next = new Set(prev);
            let changed = false;
            for (const id of skippedIds) {
              if (!next.has(id)) { next.add(id); changed = true; }
            }
            return changed ? next : prev;
          });
        }
      }

      if (trackChanged && !(nowPlaying && sessionId === nowPlaying.id)) {
        const forwardIndex = queue.findIndex((t) => t.id === sessionId);
        if (forwardIndex !== -1) {
          skipNextCastPushRef.current = true;
          setHistory((h) => [...h, ...(nowPlaying ? [nowPlaying] : []), ...queue.slice(0, forwardIndex)]);
          setNowPlaying(queue[forwardIndex]);
          setIsPlaying(true);
          setQueue((q) => q.slice(forwardIndex + 1));
          return;
        }

        const reverseIndex = [...history].reverse().findIndex((t) => t.id === sessionId);
        if (reverseIndex !== -1) {
          const historyIndex = history.length - 1 - reverseIndex;
          skipNextCastPushRef.current = true;
          setQueue((q) => [...history.slice(historyIndex + 1), ...(nowPlaying ? [nowPlaying] : []), ...q]);
          setNowPlaying(history[historyIndex]);
          setIsPlaying(true);
          setHistory((h) => h.slice(0, historyIndex));
          return;
        }

        // Not in our tracked queue/history - e.g. this tab just reloaded and
        // lost its in-memory queue, or the backend advanced further than we'd
        // tracked. Trust the session's own track + remaining queue wholesale.
        skipNextCastPushRef.current = true;
        setNowPlaying(sessionTrack);
        setQueue(session.queue || []);
        setIsPlaying(true);
        return;
      }

      // now_playing itself hasn't changed, but the backend may have found and
      // queued a lookahead match *while the current track is still playing* -
      // the whole point of running that search server-side. Without this,
      // Next/Prev stay disabled until the current track naturally ends, since
      // nothing else here reacts to the queue's *contents* changing on their
      // own. Compares by id rather than gating on "only when ours is empty" -
      // that gate meant a queue that was non-empty but *stale* (e.g. this tab
      // carrying forward corrupted state from before a backend fix landed)
      // could never self-correct, since it's never empty. The backend fully
      // owns ad-hoc Spotify/WiiM queue contents once a session is active, so
      // trusting it whenever it actually differs is correct, not just when
      // ours happens to be empty.
      const sessionQueue = session.queue || [];
      const queueMatches = queue.length === sessionQueue.length
        && queue.every((t, i) => t.id === sessionQueue[i]?.id);
      if (!queueMatches) {
        setQueue(sessionQueue);
      }
    };

    const interval = setInterval(async () => {
      try {
        if (isWiim || isSpotify) {
          if (isSpotify && nowPlaying.source !== 'spotify') {
            // nowPlaying hasn't caught up to being Spotify-sourced yet - e.g.
            // this poll's closure was set up mid-transition, while a local
            // track was still being matched against Spotify's catalog
            // (that's async and can take a couple of seconds). There's
            // nothing meaningful to reconcile against a local track object,
            // and doing so anyway used to overwrite nowPlaying with whatever
            // Spotify already happened to be playing - permanently losing
            // local_id in the process (confirmed live: it broke switching
            // back to a local destination for that track afterward). Just
            // skip this tick.
            return;
          }
          const response = await axios.get(`${API_BASE_URL}/playback-session`);
          if (cancelled) return;
          if (response.data.last_status) {
            destStatusRef.current = response.data.last_status;
            setDestStatus(response.data.last_status);
          }
          reconcileFromServerSession(response.data);
          return;
        }

        const response = await axios.get(`${deviceEndpoint(outputDevice)}/status`);
        if (cancelled) return; // superseded by a newer effect instance while this request was in flight - discard
        destStatusRef.current = response.data;
        setDestStatus(response.data);
        const { reachable, content_id: contentId } = response.data;
        if (!reachable) return;

        if (isChromecast) {
          reconcileFromContentId(contentId);
        }
      } catch (err) {
        console.error('Error polling device status:', err);
      }
    }, isSpotify ? SPOTIFY_STATUS_POLL_INTERVAL_MS : DEFAULT_STATUS_POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(interval); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outputDevice, nowPlaying, queue, history]);

  useEffect(() => {
    try {
      localStorage.setItem('md_track_view_style', trackViewStyle);
    } catch {
      /* ignore */
    }
  }, [trackViewStyle]);

  // Persist the active tab/library view/filters, same "resume where you left
  // off" treatment as the playback session below - a reload or reopened tab
  // returns to the same browsing state instead of resetting every time.
  useEffect(() => {
    saveLibraryView({
      activeTab,
      libraryMode,
      drill,
      search,
      filterGenre,
      filterDecade,
      filterQuality,
      filterFormat,
      filterSpotifyAvailable,
      filterTrackLimit,
      libraryShuffleMode,
    });
  }, [activeTab, libraryMode, drill, search, filterGenre, filterDecade, filterQuality, filterFormat, filterSpotifyAvailable, filterTrackLimit, libraryShuffleMode]);

  // Persist the playback session (queue/history capped, so a mutation never
  // costs a multi-MB localStorage write) so a reload or reopened tab returns
  // to what was playing.
  useEffect(() => {
    saveSession({
      nowPlaying,
      queue: queue.slice(0, QUEUE_PERSIST_CAP),
      history: history.slice(-HISTORY_PERSIST_CAP),
      shuffleEnabled,
      outputDevice,
    });
    // Mirrors the same state server-side (playback_session table) so a
    // background job can keep advancing the queue even once this tab goes
    // to sleep - see src/playback_advancer.py. "This Browser" playback has
    // no remote device for a background job to drive, so it just clears the
    // server-side session instead of syncing one.
    if (outputDevice) {
      const payload = {
        destination_type: outputDevice.type,
        destination_id: outputDevice.id,
        now_playing: nowPlaying,
        queue: queue.slice(0, QUEUE_PERSIST_CAP),
        shuffle_enabled: shuffleEnabled,
      };
      // Only right after a fresh match attempt (matchAndPlayLocalTracksOnSpotify
      // sets spotifyMatchPoolDirtyRef), and only the untried remainder - lets
      // playback_advancer keep searching for a lookahead match after this tab
      // sleeps, picking up where the last click's search left off. Gated on
      // the dirty flag (not sent on every sync) so this tab's now-stale local
      // snapshot can't keep overwriting the server's own further progress
      // once the backend has moved the cursor on - see the ref's comment.
      if (outputDevice.type === 'spotify' && spotifyMatchPoolDirtyRef.current) {
        const pool = spotifyLookaheadRef.current;
        if (pool && pool.cursor < pool.candidates.length) {
          payload.spotify_match_pool = { candidates: pool.candidates, cursor: pool.cursor };
        }
        spotifyMatchPoolDirtyRef.current = false;
      }
      axios.post(`${API_BASE_URL}/playback-session`, payload)
        .catch((err) => console.error('Error syncing playback session:', err));
    } else {
      axios.post(`${API_BASE_URL}/playback-session`, { destination_type: null }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nowPlaying, queue, history, shuffleEnabled, outputDevice]);

  // Separately snapshot just the playback position on a timer (cheap, small
  // payload) so resuming lands close to where you left off.
  useEffect(() => {
    if (!nowPlaying) return;
    const saveNow = () => {
      const positionMs = outputDevice
        ? (destStatusRef.current?.position_ms ?? null)
        : (audioRef.current ? audioRef.current.currentTime * 1000 : null);
      if (positionMs == null) return;
      savePosition({ trackId: nowPlaying.id, positionMs });
    };
    const interval = setInterval(saveNow, 5000);
    window.addEventListener('beforeunload', saveNow);
    return () => {
      clearInterval(interval);
      window.removeEventListener('beforeunload', saveNow);
    };
  }, [nowPlaying, outputDevice]);

  useEffect(() => {
    if (activeTab === 'taste' && !stats) {
      fetchStats();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Debounce free-text search so we're not hitting the API on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 400);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Debounced artist-name suggestions for the autocomplete box below.
  useEffect(() => {
    const q = artistSearchInput.trim();
    if (!q) {
      setArtistSuggestions([]);
      setArtistSuggestionHighlight(-1);
      return;
    }
    const t = setTimeout(() => {
      axios.get(`${API_BASE_URL}/library/artists/search`, { params: { q, limit: 8 } })
        .then((r) => {
          setArtistSuggestions(r.data);
          setArtistSuggestionHighlight(-1);
        })
        .catch((err) => console.error('Error fetching artist suggestions:', err));
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artistSearchInput]);

  // No auto-dismiss timeout for spotifyPlayHint or ytMusicPlayHint - a 4s
  // fade was confirmed live to cut off messages before they could be fully
  // read (e.g. a rate-limit explanation, or "too large to push in one go,
  // started a background job"). Both render as dismiss-required popups
  // (InfoPopup, below) instead of a fading inline hint; every function that
  // sets spotifyPlayHint as a transient "Searching…" progress message
  // explicitly clears it back to null on success, so the popup never
  // lingers once an action actually worked.

  // Marks a track as "played this session" the moment it becomes nowPlaying,
  // for any destination. A local track matched to Spotify (see
  // mapMatchedLocalTrack) carries local_id alongside its Spotify uri id, so
  // the checkmark lands on the *local* track shown in the Library tab, not
  // an id nothing in that view will ever match.
  useEffect(() => {
    if (!nowPlaying) return;
    const playedId = nowPlaying.local_id ?? nowPlaying.discover_id ?? nowPlaying.id;
    setPlayedTrackIds((prev) => (prev.has(playedId) ? prev : new Set(prev).add(playedId)));
  }, [nowPlaying]);

  useEffect(() => {
    // The Playlists tab drives libraryMode/drill too (always 'playlist' or
    // 'ytmusic-playlist' there - see its nav button and platform sub-tabs
    // below), so this same dispatch has to run for it as well as 'library'.
    if (activeTab !== 'library' && activeTab !== 'playlists') return;
    // activeTab has to be a dependency so this runs on first arrival at the
    // tab, but that means it *also* re-fires on every later re-arrival (e.g.
    // Cleanup and back) even though nothing filter-related changed - which
    // used to re-shuffle the displayed order every time, decoupling it from
    // whatever's actually playing (confirmed live: navigating away and back
    // reshuffled the list while playback stayed on the original order).
    // Skip the refetch when only activeTab changed - re-entering the tab
    // should show whatever was already there, not roll a new order.
    const key = JSON.stringify([libraryMode, drill, search, filterGenre, filterDecade, filterQuality, filterFormat, filterSpotifyAvailable, filterTrackLimit]);
    if (key === libraryFetchKeyRef.current) return;
    libraryFetchKeyRef.current = key;
    // A filter change invalidates any Discover results seeded from the old
    // filter set - clear them rather than leave stale suggestions on screen
    // under a set of tracks they weren't actually generated from.
    setDiscoveredTracks([]);
    setDiscoverError(null);
    setShowDiscoverPanel(false);
    const skipInitialShuffleFetch = skipInitialShuffleFetchRef.current;
    skipInitialShuffleFetchRef.current = false;
    // Spotify playlists aren't in known_tracks - can't reuse the SQL-backed
    // /api/tracks/known / /api/library/groups fetches below at all.
    if (libraryMode === 'playlist') {
      if (drill) fetchSpotifyPlaylistTracks(drill.key); else fetchSpotifyPlaylistsAsGroups();
      return;
    }
    if (libraryMode === 'ytmusic-playlist') {
      if (drill) fetchYtMusicPlaylistTracks(drill.key); else fetchYtMusicPlaylistsAsGroups();
      return;
    }
    if (drill || libraryMode === 'all') {
      // If a shuffle mode is already active, a filter change re-shuffles the
      // new matching set rather than silently reverting to alphabetical
      // order. The shuffle buttons themselves are handled directly in their
      // own click handler (not here), so libraryShuffleMode isn't a
      // dependency of this effect. Except right after a reload restored a
      // non-'' libraryShuffleMode - that first fetch restores the exact
      // persisted shuffle order instead of rolling a fresh one, so it
      // matches whatever's still playing.
      if (libraryShuffleMode && skipInitialShuffleFetch) {
        const persistedIds = loadShuffledIds();
        if (persistedIds && persistedIds.length) fetchLibraryTracksByIds(persistedIds);
        else fetchLibraryTracksForShuffleMode(libraryShuffleMode);
      } else if (libraryShuffleMode) {
        fetchLibraryTracksForShuffleMode(libraryShuffleMode);
      } else {
        fetchLibraryTracks(0);
      }
    } else {
      fetchGroups();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, libraryMode, drill, search, filterGenre, filterDecade, filterQuality, filterFormat, filterSpotifyAvailable, filterTrackLimit]);

  // Playlists tab's "All Tracks" mode - independent of the dispatch above
  // (which only ever drives "By Playlist" groups/drill), refetches whenever
  // flat mode turns on or the platform switches while it's already on.
  useEffect(() => {
    if (activeTab !== 'playlists' || !playlistsFlatView) return;
    fetchAllPlaylistTracksFlat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, playlistsFlatView, libraryMode]);

  // Refetches each filter dropdown's own option counts whenever search or
  // any *other* filter changes, so e.g. the Genre dropdown shows "Metal
  // (12)" instead of the whole-library "Metal (1,842)" once you've searched
  // or filtered down to something narrower - each fetch omits its own
  // dimension (see buildAmbientFilterParams) so switching that same filter
  // still shows every option, not just whichever one is currently selected.
  useEffect(() => {
    if (activeTab !== 'library') return;
    const withSearch = (params) => (search ? { ...params, search } : params);

    axios.get(`${API_BASE_URL}/library/groups`, { params: { by: 'genre', ...withSearch(buildAmbientFilterParams('genre')) } })
      .then((r) => setGenreOptions(r.data))
      .catch((err) => console.error('Error fetching genres:', err));
    axios.get(`${API_BASE_URL}/library/groups`, { params: { by: 'decade', ...withSearch(buildAmbientFilterParams('decade')) } })
      .then((r) => setDecadeOptions(r.data))
      .catch((err) => console.error('Error fetching decades:', err));
    axios.get(`${API_BASE_URL}/library/groups`, { params: { by: 'quality', ...withSearch(buildAmbientFilterParams('quality')) } })
      .then((r) => setQualityOptions(r.data))
      .catch((err) => console.error('Error fetching quality tiers:', err));
    axios.get(`${API_BASE_URL}/library/groups`, { params: { by: 'format', ...withSearch(buildAmbientFilterParams('format')) } })
      .then((r) => setFormatOptions(r.data))
      .catch((err) => console.error('Error fetching formats:', err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, search, filterGenre, filterDecade, filterQuality, filterFormat, filterSpotifyAvailable]);

  // The genre/decade/quality/format filters stay active no matter which
  // browse-by view or drill-down you're in; a drill-down's own dimension
  // (e.g. drilling into a specific genre) takes precedence over the ambient
  // filter for that same dimension.
  // omit excludes one filter dimension from the result - used when fetching
  // that same dimension's own option counts, so e.g. the Genre dropdown's
  // counts reflect every *other* active filter but not whatever genre is
  // currently selected (which would otherwise collapse it to a single row).
  const buildAmbientFilterParams = (omit) => {
    const params = {};
    if (filterGenre && omit !== 'genre') params.genre = filterGenre;
    if (filterDecade && omit !== 'decade') params.decade = Number(filterDecade);
    if (filterQuality && omit !== 'quality') params.quality = filterQuality;
    if (filterFormat && omit !== 'format') params.format = filterFormat;
    if (filterSpotifyAvailable) params.spotify_available = true;
    return params;
  };

  const clearAllFilters = () => {
    setFilterGenre('');
    setFilterDecade('');
    setFilterQuality('best');
    setFilterFormat('');
    setFilterSpotifyAvailable(false);
    setFilterTrackLimit('');
    setSearchInput('');
    setSearch('');
  };

  // Picking a suggestion filters the library to that artist via the same
  // free-text search the main search box uses (an exact artist name matches
  // via the existing ILIKE search) - applied immediately rather than
  // waiting on the main search box's own 400ms debounce.
  const selectArtistSuggestion = (artistName) => {
    setSearchInput(artistName);
    setSearch(artistName);
    setArtistSearchInput('');
    setArtistSuggestions([]);
    setArtistSuggestionsOpen(false);
    setArtistSuggestionHighlight(-1);
  };

  const handleArtistSearchKeyDown = (e) => {
    if (!artistSuggestionsOpen || artistSuggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setArtistSuggestionHighlight((i) => (i + 1) % artistSuggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setArtistSuggestionHighlight((i) => (i <= 0 ? artistSuggestions.length - 1 : i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = artistSuggestions[artistSuggestionHighlight] ?? artistSuggestions[0];
      selectArtistSuggestion(pick.key);
    } else if (e.key === 'Escape') {
      setArtistSuggestionsOpen(false);
    }
  };

  const buildTrackFilterParams = () => {
    const params = {};
    if (search) params.search = search;
    Object.assign(params, buildAmbientFilterParams());
    if (drill) {
      Object.assign(params, paramsForGroupKey(drill.by, drill.key));
    }
    return params;
  };

  const fetchLibraryTracks = async (offset) => {
    setLibraryLoading(true);
    try {
      const maxCount = filterTrackLimit ? Number(filterTrackLimit) : null;
      if (maxCount && offset >= maxCount) return;
      const pageLimit = maxCount ? Math.min(LIBRARY_PAGE_SIZE, maxCount - offset) : LIBRARY_PAGE_SIZE;
      const params = { ...buildTrackFilterParams(), limit: pageLimit, offset };
      const response = await axios.get(`${API_BASE_URL}/tracks/known`, { params });
      setLibraryTotal(maxCount ? Math.min(response.data.total, maxCount) : response.data.total);
      setLibraryAlbumCount(response.data.album_count);
      setLibraryArtistCount(response.data.artist_count);
      setLibraryTracks((prev) => (offset === 0 ? response.data.tracks : [...prev, ...response.data.tracks]));
    } catch (err) {
      console.error('Error fetching tracks:', err);
    } finally {
      setLibraryLoading(false);
    }
  };

  // Fetches the *entire* matching set in one truly-shuffled order (same
  // approach as fetchAllMatchingShuffled below) and shows all of it - there's
  // no "Load more" page-by-page equivalent for a random order, since each
  // separate LIMIT/OFFSET request would re-randomize independently.
  const fetchLibraryTracksShuffled = async () => {
    setLibraryLoading(true);
    try {
      const maxCount = filterTrackLimit ? Number(filterTrackLimit) : undefined;
      const tracks = await fetchAllMatchingShuffled(buildTrackFilterParams(), maxCount);
      setLibraryTotal(tracks.length);
      setLibraryAlbumCount(countDistinct(tracks, albumGroupKey));
      setLibraryArtistCount(countDistinct(tracks, artistGroupKey));
      setLibraryTracks(tracks);
      // So a reload can restore this exact order via fetchLibraryTracksByIds
      // below instead of rolling a brand-new random sequence every time.
      saveShuffledIds(tracks.map((t) => t.id));
      return tracks;
    } catch (err) {
      console.error('Error fetching shuffled tracks:', err);
      return [];
    } finally {
      setLibraryLoading(false);
    }
  };

  // Album/artist shuffle: unlike plain track shuffle (server-side ORDER BY
  // RANDOM()), grouping has to happen client-side since it needs every
  // matching track's album/artist in hand before it can decide an order - so
  // this fetches the whole matching set in whatever order the server returns
  // it (no server shuffle needed, groupedShuffle randomizes it), then applies
  // groupedShuffle. maxCount is applied *after* grouping, not as the fetch
  // limit, otherwise it'd only ever draw from whichever albums/artists
  // happened to sort first - the same reason fetchAllMatchingShuffled above
  // fetches everything before capping.
  const fetchLibraryTracksGroupedShuffled = async (mode) => {
    setLibraryLoading(true);
    try {
      const params = buildTrackFilterParams();
      const maxCount = filterTrackLimit ? Number(filterTrackLimit) : undefined;
      const countResponse = await axios.get(`${API_BASE_URL}/tracks/known`, { params: { ...params, limit: 1, offset: 0 } });
      const total = countResponse.data.total;
      let allTracks = [];
      if (total > 0) {
        const fullResponse = await axios.get(`${API_BASE_URL}/tracks/known`, { params: { ...params, limit: total, offset: 0 } });
        allTracks = fullResponse.data.tracks;
      }
      const groupKeyFn = mode === 'artist' ? artistGroupKey : albumGroupKey;
      const tracks = groupedShuffle(allTracks, groupKeyFn, maxCount);
      setLibraryTotal(tracks.length);
      setLibraryAlbumCount(countDistinct(tracks, albumGroupKey));
      setLibraryArtistCount(countDistinct(tracks, artistGroupKey));
      setLibraryTracks(tracks);
      saveShuffledIds(tracks.map((t) => t.id));
      return tracks;
    } catch (err) {
      console.error('Error fetching grouped-shuffled tracks:', err);
      return [];
    } finally {
      setLibraryLoading(false);
    }
  };

  const fetchLibraryTracksForShuffleMode = (mode) => (
    mode === 'album' || mode === 'artist'
      ? fetchLibraryTracksGroupedShuffled(mode)
      : fetchLibraryTracksShuffled()
  );

  // Restores the exact shuffled order from a prior session (see
  // saveShuffledIds above) rather than generating a fresh random one -
  // confirmed live this was needed: refreshing mid-shuffle used to produce a
  // completely different track list on every single reload, decoupled from
  // whatever was actually still playing.
  const fetchLibraryTracksByIds = async (ids) => {
    setLibraryLoading(true);
    try {
      const response = await axios.post(`${API_BASE_URL}/tracks/by-ids`, { ids });
      setLibraryTotal(response.data.length);
      setLibraryAlbumCount(countDistinct(response.data, albumGroupKey));
      setLibraryArtistCount(countDistinct(response.data, artistGroupKey));
      setLibraryTracks(response.data);
      return response.data;
    } catch (err) {
      console.error('Error restoring shuffled tracks by id:', err);
      return [];
    } finally {
      setLibraryLoading(false);
    }
  };

  const fetchGroups = async () => {
    setGroupsLoading(true);
    try {
      const params = { by: libraryMode, ...buildAmbientFilterParams() };
      if (search) params.search = search;
      const response = await axios.get(`${API_BASE_URL}/library/groups`, { params });
      setGroups(response.data);
    } catch (err) {
      console.error('Error fetching groups:', err);
    } finally {
      setGroupsLoading(false);
    }
  };

  const fetchSpotifyPlaylistsAsGroups = async () => {
    setGroupsLoading(true);
    try {
      const response = await axios.get(`${API_BASE_URL}/spotify/playlists`);
      setGroups(response.data.map((p) => ({
        key: p.id, label: p.name, count: p.track_count, artwork_url: p.artwork_url,
      })));
    } catch (err) {
      console.error('Error fetching Spotify playlists:', err);
      setGroups([]);
    } finally {
      setGroupsLoading(false);
    }
  };

  const fetchSpotifyPlaylistTracks = async (playlistId) => {
    setLibraryLoading(true);
    setPlaylistTracksRestricted(false);
    try {
      const response = await axios.get(`${API_BASE_URL}/spotify/playlists/${playlistId}/tracks`);
      const tracks = response.data.map((t) => mapSpotifyTrack(t));
      setLibraryTracks(tracks);
      setLibraryTotal(tracks.length);
      setLibraryAlbumCount(countDistinct(tracks, albumGroupKey));
      setLibraryArtistCount(countDistinct(tracks, artistGroupKey));
    } catch (err) {
      if (err.response?.status === 403) {
        setPlaylistTracksRestricted(true);
      } else {
        console.error('Error fetching Spotify playlist tracks:', err);
      }
      setLibraryTracks([]);
      setLibraryTotal(0);
      setLibraryAlbumCount(0);
      setLibraryArtistCount(0);
    } finally {
      setLibraryLoading(false);
    }
  };

  const fetchYtMusicPlaylistsAsGroups = async () => {
    setGroupsLoading(true);
    try {
      const response = await axios.get(`${API_BASE_URL}/ytmusic/playlists`);
      setGroups(response.data.map((p) => ({
        key: p.id, label: p.name, count: p.track_count, artwork_url: p.artwork_url,
      })));
    } catch (err) {
      console.error('Error fetching YouTube Music playlists:', err);
      setGroups([]);
    } finally {
      setGroupsLoading(false);
    }
  };

  const fetchYtMusicPlaylistTracks = async (playlistId) => {
    setLibraryLoading(true);
    try {
      const response = await axios.get(`${API_BASE_URL}/ytmusic/playlists/${playlistId}/tracks`);
      const tracks = response.data.map((t) => mapYtMusicTrack(t));
      setLibraryTracks(tracks);
      setLibraryTotal(tracks.length);
      setLibraryAlbumCount(0); // YT Music playlist items carry no album metadata
      setLibraryArtistCount(countDistinct(tracks, artistGroupKey));
    } catch (err) {
      console.error('Error fetching YouTube Music playlist tracks:', err);
      setLibraryTracks([]);
      setLibraryTotal(0);
      setLibraryAlbumCount(0);
      setLibraryArtistCount(0);
    } finally {
      setLibraryLoading(false);
    }
  };

  // "All Tracks" mode for the Playlists tab: every track across every
  // playlist on the current platform, flattened+deduped. Backed by a
  // database cache (main.py's /playlists/all-tracks routes) rather than
  // fetched fresh every time - flattening live is an N+1 fetch (one round
  // trip per playlist) that made this view slow to open every time it was
  // built client-side. Served from cache unless refresh=true, which the
  // Refresh button passes to pick up playlists/tracks changed since.
  const fetchAllPlaylistTracksFlat = async (refresh = false) => {
    setFlatPlaylistTracksLoading(true);
    try {
      const isSpotify = libraryMode === 'playlist';
      const platformPath = isSpotify ? 'spotify' : 'ytmusic';
      const response = await axios.get(`${API_BASE_URL}/${platformPath}/playlists/all-tracks`, {
        params: refresh ? { refresh: true } : {},
      });
      // The cache returns a uniform row shape for both platforms
      // (track_id/track_name/artist_name/album/artwork_url/isrc/duration_ms/
      // popularity/explicit/release_date/genre/matched_spotify_uri) - adapt
      // each into the native shape mapSpotifyTrack/mapYtMusicTrack expect,
      // then carry the extra metadata through on top (isrc/popularity/etc.
      // aren't surfaced in the UI yet, but are there for it to use).
      const tracks = response.data.tracks.map((t) => (isSpotify
        ? {
          ...mapSpotifyTrack({
            uri: `spotify:track:${t.track_id}`, name: t.track_name, artists: t.artist_name,
            album: t.album, duration_ms: t.duration_ms, artwork_url: t.artwork_url,
            local_track_id: t.local_track_id, matched_ytmusic_video_id: t.matched_ytmusic_video_id,
          }),
          isrc: t.isrc, popularity: t.popularity, explicit: t.explicit, release_date: t.release_date, genre: t.genre,
        }
        : {
          ...mapYtMusicTrack({
            video_id: t.track_id, track_name: t.track_name, artist_name: t.artist_name,
            artwork_url: t.artwork_url, matched_spotify_uri: t.matched_spotify_uri,
            local_track_id: t.local_track_id,
          }),
          duration_ms: t.duration_ms, genre: t.genre,
        }));
      setFlatPlaylistTracks(tracks);
      setFlatPlaylistSkippedCount(response.data.skipped_count || 0);
      setFlatPlaylistRefreshedAt(response.data.refreshed_at || null);
    } catch (err) {
      console.error('Error fetching playlist tracks for All Tracks view:', err);
      setFlatPlaylistTracks([]);
    } finally {
      setFlatPlaylistTracksLoading(false);
    }
  };

  const fetchStats = async () => {
    setStatsLoading(true);
    try {
      const response = await axios.get(`${API_BASE_URL}/library/stats`);
      setStats(response.data);
    } catch (err) {
      console.error('Error fetching library stats:', err);
    } finally {
      setStatsLoading(false);
    }
  };

  const pollScanStatus = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const response = await axios.get(`${API_BASE_URL}/library/scan/status`);
        const data = response.data;
        setScanResult(data);
        if (data.status === 'done' || data.status === 'error') {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setScanning(false);
          if (data.status === 'error') {
            setScanError(data.error || 'Scan failed.');
          } else {
            setLibraryMode('all');
            setDrill(null);
            fetchLibraryTracks(0);
            fetchStats();
          }
        }
      } catch (err) {
        clearInterval(pollRef.current);
        pollRef.current = null;
        setScanning(false);
        setScanError('Lost connection while checking scan progress.');
        console.error('Error checking scan status:', err);
      }
    }, 1500);
  };

  const resumeScanIfRunning = async () => {
    try {
      const response = await axios.get(`${API_BASE_URL}/library/scan/status`);
      if (response.data.status === 'running') {
        setScanning(true);
        setScanResult(response.data);
        pollScanStatus();
      }
    } catch (err) {
      console.error('Error checking scan status:', err);
    }
  };

  const handleScan = async (e) => {
    e.preventDefault();
    setScanning(true);
    setScanError(null);
    setScanResult(null);
    try {
      await axios.post(`${API_BASE_URL}/library/scan`, { root_path: rootPath });
      pollScanStatus();
    } catch (err) {
      setScanError(err.response?.data?.detail || 'Failed to start scan. Please check the path and try again.');
      console.error('Error starting scan:', err);
      setScanning(false);
    }
  };

  // How many currently-filtered library tracks to sample when building a
  // Discover seed, and how many distinct artist names to actually send -
  // recommending "similar artists" gives Last.fm's artist.getSimilar a
  // clean input, and keeps the seed a sane size even when the active filter
  // matches thousands of tracks.
  const DISCOVER_SEED_SAMPLE_LIMIT = 40;
  const DISCOVER_SEED_ARTIST_LIMIT = 15;

  const handleDiscoverFromLibrary = async () => {
    setDiscovering(true);
    setDiscoverError(null);
    try {
      const sampleParams = { ...buildTrackFilterParams(), shuffle: true, limit: DISCOVER_SEED_SAMPLE_LIMIT };
      const sampleRes = await axios.get(`${API_BASE_URL}/tracks/known`, { params: sampleParams });
      const sampleTracks = sampleRes.data.tracks || [];
      if (sampleTracks.length === 0) {
        setDiscoverError('No tracks match your current filters to seed Discover from.');
        setDiscoveredTracks([]);
        return;
      }
      const seenArtists = new Set();
      const artists = [];
      for (const t of sampleTracks) {
        if (!seenArtists.has(t.artist_name)) {
          seenArtists.add(t.artist_name);
          artists.push(t.artist_name);
        }
        if (artists.length >= DISCOVER_SEED_ARTIST_LIMIT) break;
      }
      const response = await axios.post(`${API_BASE_URL}/discover`, {
        seed_tracks: artists.join(', '),
        genre: filterGenre || null,
        exclude_known: true,
        limit: discoverTrackCount,
        group_by_artist: discoverGroupByArtist,
      });
      const mapped = response.data.map((t, i) => ({
        id: `discover-${i}`,
        source: 'discover',
        track_name: t.track_name,
        artist_name: t.artist_name,
        album_name: t.album_name,
        // Always null for Last.fm-sourced results (real catalog names, no
        // separate native-script concept) - kept on the shape since
        // /api/discover/preview and /api/spotify/discover-match still
        // accept and use these fields if ever populated.
        native_track_name: t.native_track_name || null,
        native_artist_name: t.native_artist_name || null,
        artwork_url: null,
        preview_url: undefined, // undefined = not yet looked up, null = looked up and none found
      }));
      if (mapped.length === 0) {
        setDiscoverError('No recommendations found for this filter - try a different one.');
        setDiscoveredTracks([]);
        return;
      }
      setDiscoveredTracks(mapped);
      setDiscoveredGroupedByArtist(discoverGroupByArtist);
      setShowDiscoverPanel(true);
      // Eagerly resolve preview/artwork for every result right away (not on
      // click) - gives progressive artwork reveal within a second or two,
      // and means sampleQueueDiscoveredTracks below usually has a
      // preview_url already in hand with no extra network round trip.
      // Result sets are capped at 30 tracks (up to 90 in group-by-artist
      // mode, 30 artists x 3 tracks each) - a burst that size is still fine
      // for iTunes/Deezer's generous personal-use limits, confirmed live
      // throughout this session's testing.
      mapped.forEach((t) => {
        axios.post(`${API_BASE_URL}/discover/preview`, {
          track_name: t.track_name, artist_name: t.artist_name,
          native_track_name: t.native_track_name, native_artist_name: t.native_artist_name,
        })
          .then((r) => {
            setDiscoveredTracks((prev) => prev.map((p) => (p.id === t.id
              ? { ...p, preview_url: r.data.preview_url, artwork_url: p.artwork_url || r.data.artwork_url }
              : p)));
          })
          .catch(() => {
            setDiscoveredTracks((prev) => prev.map((p) => (p.id === t.id ? { ...p, preview_url: null } : p)));
          });
      });
    } catch (err) {
      setDiscoverError('Failed to discover music. Please try again.');
      console.error('Error discovering music:', err);
    } finally {
      setDiscovering(false);
    }
  };

  // Surfaces a genuine Spotify Connect casting failure to the user -
  // previously this only ever went to console.error, so a real failure
  // (confirmed live: main.py's /play and /play-uris routes deliberately
  // return 502 when spotify_connect.play/play_uris exhausts its own
  // confirm-playback-landed retries, e.g. a slow/flaky device that loads
  // the right track but is sluggish to actually start it) was completely
  // silent from the user's side - nothing ever told them what happened.
  const handleSpotifyCastError = (err) => {
    console.error('Error casting to Spotify device:', err);
    const deviceName = outputDevice?.name || 'the selected device';
    if (err.response?.status === 502) {
      setSpotifyPlayHint(`${deviceName} didn't confirm playback started after a few tries - it may just need a moment to catch up, or try pressing Play again.`);
    } else {
      setSpotifyPlayHint(`Couldn't cast to ${deviceName}: ${err.response?.data?.detail || err.message}`);
    }
  };

  // A track's own local (known_tracks) id, if this exact track can stream
  // from a local file - either because it genuinely IS a local library
  // track (its own id already is one), or because the known_tracks
  // cross-reference found the same track under local_id (a Spotify/YT
  // Music playlist track that also happens to be on disk - see
  // mapSpotifyTrack/mapYtMusicTrack). null means there's truly no local
  // file this track could stream from - WiiM/Chromecast (which can only
  // ever stream a URL this app serves itself, never Spotify/YouTube
  // directly) have nothing to play in that case, only Spotify Connect
  // (for a source:'spotify' track) or This Browser (which can also fall
  // back to opening YouTube directly for a source:'ytmusic' track) can.
  const resolveLocalTrackId = (t) => (
    t.local_id != null ? t.local_id
      : (t.source === 'spotify' || t.source === 'ytmusic' || t.source === 'discover') ? null
        : t.id
  );

  // Casts a resolved local track id to whichever WiiM/Chromecast device is
  // currently selected - shared by the cast-on-change effect and
  // togglePlay's initial-cast fallback below, both of which need the exact
  // same "single track_id, plus a Chromecast queue built from whichever of
  // the *rest* of the queue also resolves a local id" logic, regardless of
  // whether nowPlaying is a genuine local track or a Spotify/YT Music
  // playlist track that happens to also be one (see resolveLocalTrackId).
  const castLocalTrack = (localId) => {
    const payload = { track_id: localId };
    const isChromecast = outputDevice.type === 'chromecast';
    if (isChromecast) {
      payload.queue_track_ids = queue.map(resolveLocalTrackId).filter((id) => id != null).slice(0, CHROMECAST_QUEUE_WINDOW);
    }
    axios.post(`${deviceEndpoint(outputDevice)}/play`, payload)
      .then(() => { if (isChromecast) chromecastQueueLoadedRef.current = true; })
      .catch((err) => console.error('Error casting to device:', err));
  };

  const startQueue = (tracks, { shuffle = false } = {}) => {
    if (!tracks || tracks.length === 0) return;
    // Central guard for every "Play All"/"Shuffle" entry point (library flat
    // view, album/genre/etc. groups, playlist tracks, single-track clicks) -
    // a local-track queue against a Spotify destination (or vice versa) would
    // otherwise silently fail to cast while leaving the destination's status
    // poll to overwrite nowPlaying with whatever Spotify's device already
    // happens to be playing, which looks like "the wrong song is playing."
    // A source:'spotify' track that also resolves a local id (the
    // cross-reference above) is exempt from the first check - it's not
    // Spotify-only, so a WiiM/Chromecast destination can stream it too.
    const isSpotifyTracks = tracks[0]?.source === 'spotify';
    const needsSpotifyConnect = isSpotifyTracks && resolveLocalTrackId(tracks[0]) == null;
    if (needsSpotifyConnect && outputDevice?.type !== 'spotify') {
      setSpotifyPlayHint('Select a Spotify Connect device (destination picker) to play Spotify playlists.');
      return;
    }
    if (!isSpotifyTracks && outputDevice?.type === 'spotify') {
      setSpotifyPlayHint('Switch the destination off Spotify Connect to play local library tracks.');
      return;
    }
    const ordered = shuffle ? shuffleArray(tracks) : tracks;
    setHistory([]);
    setNowPlaying(ordered[0]);
    setQueue(ordered.slice(1));
    setIsPlaying(true);
    setShuffleEnabled(shuffle);
    setUserHasInteracted(true);
    setInitialSeekMs(null);
    preShuffleQueueRef.current = null;
    // This nowPlaying/queue just replaced whatever was there before (possibly
    // a stale restored session) - the cast-on-change effect below will send
    // it fresh, so togglePlay's separate "cast the restored session" fallback
    // is no longer applicable.
    destNeedsInitialCastRef.current = false;
  };

  // For a Spotify playlist we can't read the track listing of (not owned by
  // this account - Spotify blocks that even though playback still works):
  // start it from the top via context_uri alone, with a placeholder
  // "nowPlaying" that the status-poll reconciliation (reconcileFromSpotifyTrackUri)
  // fills in with the real title/artist/artwork within one poll tick.
  const playSpotifyContextDirectly = (contextUri) => {
    setHistory([]);
    setQueue([]);
    setNowPlaying({
      id: contextUri, source: 'spotify', uri: null, context_uri: contextUri,
      track_name: 'Loading…', artist_name: '', album_name: null,
      duration_seconds: null, artwork_url: null,
    });
    setIsPlaying(true);
    setShuffleEnabled(false);
    setUserHasInteracted(true);
    setInitialSeekMs(null);
  };

  const playTrackFromList = (track, list) => {
    const index = list.findIndex((t) => t.id === track.id);
    startQueue(index >= 0 ? list.slice(index) : [track]);
  };

  // A local track matched to its Spotify catalog equivalent, adapted into
  // the same shape mapSpotifyTrack produces from a real Spotify API response
  // - but keeps the *local* track's own title/artist/album/duration (we
  // already know exactly what this is), only taking uri/artwork from the
  // match. context_uri stays null - this isn't a playlist, just an ad-hoc
  // queue built from matched local tracks (see attemptSpotifyMatchAndPlay).
  function mapMatchedLocalTrack(localTrack, matchResult) {
    return {
      id: matchResult.uri, source: 'spotify', uri: matchResult.uri, context_uri: null,
      // The Library tab renders the *local* track (local_id), not this
      // Spotify-uri-keyed id - carried along so played/skipped tracking can
      // mark the right card once this becomes nowPlaying.
      local_id: localTrack.id,
      track_name: localTrack.track_name, artist_name: localTrack.artist_name,
      album_name: localTrack.album_name, duration_seconds: localTrack.duration_seconds,
      artwork_url: matchResult.artwork_url || localTrack.artwork_url,
    };
  }

  // Guards against a slower/older match resolving *after* a newer one the
  // user triggered by clicking a different track in the meantime - without
  // this, a stale result could win and silently replace the just-started
  // (correct) queue with the old click's.
  const spotifyMatchRequestIdRef = useRef(0);
  // The ordered pool a "play via Spotify" action is searching through, and
  // how far into it we've gotten - shared between the initial find-first-
  // match call and the background lookahead-refill effect below, so the
  // refill continues from wherever the initial search left off instead of
  // re-trying already-skipped candidates.
  const spotifyLookaheadRef = useRef({ candidates: [], cursor: 0 });
  // Set right when a fresh match attempt starts, cleared right after the
  // session-sync effect actually sends spotify_match_pool once. Without this,
  // that effect (which fires on every nowPlaying/queue change - including
  // ones the *backend* advancer causes, via the reconcile poll) would keep
  // re-sending this tab's now-stale spotifyLookaheadRef snapshot on every
  // routine sync, repeatedly stomping the server's own further-advanced
  // cursor back down to wherever this tab's last click left it - confirmed
  // live: the pool cursor kept resetting and the same already-played track
  // got matched and queued again, looking like playback going "back" a track.
  const spotifyMatchPoolDirtyRef = useRef(false);

  // Searches spotifyLookaheadRef's candidates one at a time (never a batch -
  // confirmed live that a burst of 50 searches up front is both slow and a
  // real contributor to Spotify's rate limiting), advancing the shared
  // cursor as it goes. Stops at the first match, after
  // SPOTIFY_MATCH_CONSECUTIVE_CAP consecutive no-match candidates, when the
  // pool runs out, or immediately on a rate-limited response (no point
  // burning more requests into the same wall).
  const findNextSpotifyMatch = async (requestId) => {
    const pool = spotifyLookaheadRef.current;
    let consecutiveMisses = 0;
    while (pool.cursor < pool.candidates.length && consecutiveMisses < SPOTIFY_MATCH_CONSECUTIVE_CAP) {
      if (spotifyMatchRequestIdRef.current !== requestId) return { found: null, rateLimited: false };
      const candidate = pool.candidates[pool.cursor];
      pool.cursor += 1;
      setMatchingTrackId(candidate.id);
      try {
        const response = await axios.post(`${API_BASE_URL}/spotify/tracks/${candidate.id}/match`);
        const { matched, uri, artwork_url: artworkUrl, reason } = response.data;
        if (matched) {
          return { found: mapMatchedLocalTrack(candidate, { uri, artwork_url: artworkUrl }), rateLimited: false };
        }
        if (reason === 'unavailable') {
          // Leave the cursor pointing at this same candidate rather than past
          // it - it genuinely wasn't checked (a rate-limit, not a real
          // no-match), so it should get a real retry next time instead of
          // being silently skipped forever (same fix as
          // playback_advancer._advance_spotify's identical loop).
          pool.cursor -= 1;
          return { found: null, rateLimited: true };
        }
        setSkippedTrackIds((prev) => (prev.has(candidate.id) ? prev : new Set(prev).add(candidate.id)));
        consecutiveMisses += 1;
      } catch (err) {
        console.error('Error matching track to Spotify:', err);
        return { found: null, rateLimited: false };
      }
    }
    return { found: null, rateLimited: false };
  };

  // Shared by every "play these local tracks via Spotify" entry point -
  // single-track click, Shuffle All, Play All, and Play All/Shuffle on an
  // album/genre/etc. group. Finds and plays just the *first* match from the
  // given ordered pool - the lookahead-refill effect below keeps one more
  // match buffered ahead as playback progresses, rather than searching
  // everything up front.
  const matchAndPlayLocalTracksOnSpotify = async (tracks, { noMatchHint } = {}) => {
    if (tracks.length === 0) return;
    // A user-initiated attempt to play something new - even one that ends up
    // finding no match (e.g. rate-limited) - means the stale nowPlaying/queue
    // restored from localStorage on load is no longer what should get cast on
    // the next Play press. Without this, a rate-limited Shuffle All silently
    // fails, then pressing Play falls into togglePlay's initial-cast fallback
    // and casts whatever unrelated track was left over from a prior session -
    // confirmed live (a rate-limited Shuffle All left nowPlaying untouched,
    // and the next Play press sent a leftover "Say Hello 2 Heaven" queue that
    // had nothing to do with the shuffled list on screen).
    destNeedsInitialCastRef.current = false;
    const requestId = ++spotifyMatchRequestIdRef.current;
    spotifyLookaheadRef.current = { candidates: tracks, cursor: 0 };
    spotifyMatchPoolDirtyRef.current = true;
    try {
      const { found, rateLimited } = await findNextSpotifyMatch(requestId);
      if (spotifyMatchRequestIdRef.current !== requestId) return; // superseded by a newer click
      if (!found) {
        setSpotifyPlayHint(rateLimited
          ? "Spotify's search is temporarily rate-limited - try again later."
          : (noMatchHint || 'No Spotify match found for these tracks.'));
        return;
      }
      setSpotifyPlayHint(null);
      startQueue([found]);
    } finally {
      if (spotifyMatchRequestIdRef.current === requestId) setMatchingTrackId(null);
    }
  };

  const attemptSpotifyMatchAndPlay = (track, list) => {
    const startIndex = list ? list.findIndex((t) => t.id === track.id) : -1;
    const candidates = startIndex >= 0 ? list.slice(startIndex) : [track];
    matchAndPlayLocalTracksOnSpotify(candidates, {
      noMatchHint: `No Spotify match found for "${track.track_name}"${candidates.length > 1 ? ' or the tracks after it' : ''}.`,
    });
  };

  // Discover suggestions are AI text (track/artist/album name), never a
  // local file or a known_tracks row. Unlike matchAndPlayLocalTracksOnSpotify
  // above, Discover's candidate pool is always small and bounded (5-10
  // tracks, per _build_prompt in main.py) - so rather than the incremental
  // one-ahead lookahead built for browsing a whole (potentially huge)
  // library, these two functions just resolve the *whole* pool: start the
  // first match immediately (same low-latency-first philosophy), then keep
  // resolving the rest and append them to the queue as they land, giving
  // working Next/Prev within a couple seconds. Both reuse the shared
  // spotifyMatchRequestIdRef/matchingTrackId race-guard above so a newer
  // click (of either kind) correctly supersedes an older in-flight one.
  const matchAndQueueDiscoveredTracksOnSpotify = async (candidates) => {
    if (candidates.length === 0) return;
    destNeedsInitialCastRef.current = false;
    const requestId = ++spotifyMatchRequestIdRef.current;
    let firstStarted = false;
    let hitRateLimit = false;
    setSpotifyPlayHint(null);
    // The per-card spinner icon alone isn't enough feedback - confirmed live
    // that a rate-limited match can silently take 6-7s (the backend retries
    // once with a sleep before giving up, see spotify_connect._api_request),
    // which reads as "nothing is happening" without this. Uses
    // spotifyMatchProgress (not spotifyPlayHint) - see that state's own
    // comment for why.
    setSpotifyMatchProgress(`Searching Spotify for "${candidates[0].track_name}"…`);
    for (const candidate of candidates) {
      if (spotifyMatchRequestIdRef.current !== requestId) return; // superseded
      setMatchingTrackId(candidate.id);
      let matched, uri, artworkUrl, reason;
      try {
        const response = await axios.post(`${API_BASE_URL}/spotify/discover-match`, {
          track_name: candidate.track_name, artist_name: candidate.artist_name,
          native_track_name: candidate.native_track_name, native_artist_name: candidate.native_artist_name,
        });
        ({ matched, uri, artwork_url: artworkUrl, reason } = response.data);
      } catch (err) {
        console.error('Error matching discovered track to Spotify:', err);
        break;
      }
      if (spotifyMatchRequestIdRef.current !== requestId) return;
      if (!matched) {
        if (reason === 'unavailable') {
          hitRateLimit = true;
          break; // no point burning more requests into the same rate limit
        }
        continue; // no match for this one - try the next candidate
      }
      const queueEntry = {
        // discover_id (not local_id!) carries the discover card's own id back
        // through - renderTrackCard's nowPlayingId bridge uses it to
        // highlight *this* card as playing rather than the Spotify uri.
        // local_id would be wrong here: it also drives the "switched to This
        // Browser/WiiM/Chromecast - fall back to the local file" logic
        // elsewhere, and a discover suggestion has no local file to fall
        // back to (it should behave like a genuine Spotify-only track there,
        // not like a matched library track).
        id: uri, source: 'spotify', uri, context_uri: null, discover_id: candidate.id,
        track_name: candidate.track_name, artist_name: candidate.artist_name,
        album_name: candidate.album_name, artwork_url: artworkUrl,
      };
      if (!firstStarted) {
        setSpotifyMatchProgress(null);
        startQueue([queueEntry]);
        firstStarted = true;
      } else {
        setQueue((prev) => [...prev, queueEntry]);
      }
    }
    if (spotifyMatchRequestIdRef.current === requestId) setMatchingTrackId(null);
    if (spotifyMatchRequestIdRef.current === requestId) setSpotifyMatchProgress(null);
    if (!firstStarted && spotifyMatchRequestIdRef.current === requestId) {
      // hitRateLimit must win over the generic "no match" message below it -
      // confirmed live this was previously getting silently overwritten:
      // the rate-limited hint was set inside the loop above, then this same
      // synchronous pass immediately replaced it with "No Spotify match
      // found" since firstStarted was still false either way, so the
      // accurate message never actually reached the user.
      setSpotifyPlayHint(hitRateLimit
        ? "Spotify's search is temporarily rate-limited - try again later."
        : `No Spotify match found for "${candidates[0].track_name}"${candidates.length > 1 ? ' or the tracks after it' : ''}.`);
    }
  };

  // Same shape as matchAndQueueDiscoveredTracksOnSpotify above, for YouTube
  // Music playlist tracks - reuses the identical /api/spotify/discover-match
  // endpoint (it's already generic text-in/match-out, no Discover-specific
  // coupling) since a YT Music playlist item is the same
  // title/channel-derived-artist text shape a Discover suggestion is.
  const matchAndQueueYtMusicPlaylistTracksOnSpotify = async (candidates) => {
    if (candidates.length === 0) return;
    destNeedsInitialCastRef.current = false;
    const requestId = ++spotifyMatchRequestIdRef.current;
    let firstStarted = false;
    let hitRateLimit = false;
    setSpotifyPlayHint(null);
    // Uses spotifyMatchProgress (not spotifyPlayHint) - see that state's own
    // comment for why. Still shown even when candidate.matched_spotify_uri
    // is already cached client-side, since the backend's own cross-reference
    // check (main.py's match_discovered_track_to_spotify) is a real network
    // round trip too, just a fast DB lookup rather than a live Spotify
    // search - this briefly flashing and clearing on its own is expected,
    // not an error.
    setSpotifyMatchProgress(`Searching Spotify for "${candidates[0].track_name}"…`);
    for (const candidate of candidates) {
      if (spotifyMatchRequestIdRef.current !== requestId) return;
      setMatchingTrackId(candidate.id);
      let matched, uri, artworkUrl, reason;
      if (candidate.matched_spotify_uri) {
        // Already resolved by playlist_match_prewarm.py (see the Playlists
        // tab's "All Tracks" cache) - skip the live search entirely.
        matched = true;
        uri = candidate.matched_spotify_uri;
        artworkUrl = candidate.artwork_url;
      } else {
        try {
          const response = await axios.post(`${API_BASE_URL}/spotify/discover-match`, {
            track_name: candidate.track_name, artist_name: candidate.artist_name,
            // Lets the backend try an exact-id cross-reference (known_tracks/
            // playlist_track_cache) before falling back to fuzzy search, and
            // write the result back everywhere it helps next time - see
            // main.py's match_discovered_track_to_spotify.
            ytmusic_video_id: candidate.video_id,
          });
          ({ matched, uri, artwork_url: artworkUrl, reason } = response.data);
        } catch (err) {
          console.error('Error matching YouTube Music track to Spotify:', err);
          break;
        }
      }
      if (spotifyMatchRequestIdRef.current !== requestId) return;
      if (!matched) {
        if (reason === 'unavailable') {
          hitRateLimit = true;
          break;
        }
        continue;
      }
      const queueEntry = {
        // ytmusic_id (not local_id/discover_id) carries the playlist card's
        // own id back through, same bridging role discover_id plays for
        // Discover suggestions. Deliberately NOT local_id, even though a YT
        // Music playlist track can turn out to also be a local file (see
        // mapYtMusicTrack) - the "now playing" highlight bridge
        // (nowPlayingId below) checks local_id before ytmusic_id, so
        // setting both here would highlight the wrong card (a plain
        // library card sharing that same track) instead of this playlist
        // card.
        id: uri, source: 'spotify', uri, context_uri: null, ytmusic_id: candidate.id,
        track_name: candidate.track_name, artist_name: candidate.artist_name, artwork_url: artworkUrl,
      };
      if (!firstStarted) {
        setSpotifyMatchProgress(null);
        startQueue([queueEntry]);
        firstStarted = true;
      } else {
        setQueue((prev) => [...prev, queueEntry]);
      }
    }
    if (spotifyMatchRequestIdRef.current === requestId) setMatchingTrackId(null);
    if (spotifyMatchRequestIdRef.current === requestId) setSpotifyMatchProgress(null);
    if (!firstStarted && spotifyMatchRequestIdRef.current === requestId) {
      setSpotifyPlayHint(hitRateLimit
        ? "Spotify's search is temporarily rate-limited - try again later."
        : `No Spotify match found for "${candidates[0].track_name}"${candidates.length > 1 ? ' or the tracks after it' : ''}.`);
    }
  };

  // Same shape as above, but for the 30-second-preview fallback (This
  // Browser only - previews never cast to a real device). Usually resolves
  // near-instantly since handleDiscoverFromLibrary already eagerly prefetched
  // preview_url for every result as soon as they arrived.
  const sampleQueueDiscoveredTracks = async (candidates) => {
    if (candidates.length === 0) return;
    destNeedsInitialCastRef.current = false;
    const requestId = ++spotifyMatchRequestIdRef.current;
    let firstStarted = false;
    for (const candidate of candidates) {
      if (spotifyMatchRequestIdRef.current !== requestId) return;
      let url = candidate.preview_url;
      let artworkUrl = candidate.artwork_url;
      if (url === undefined) {
        setMatchingTrackId(candidate.id);
        try {
          const response = await axios.post(`${API_BASE_URL}/discover/preview`, {
            track_name: candidate.track_name, artist_name: candidate.artist_name,
            native_track_name: candidate.native_track_name, native_artist_name: candidate.native_artist_name,
          });
          url = response.data.preview_url;
          artworkUrl = artworkUrl || response.data.artwork_url;
        } catch (err) {
          console.error('Error fetching preview for discovered track:', err);
          url = null;
        }
        setDiscoveredTracks((prev) => prev.map((t) => (t.id === candidate.id
          ? { ...t, preview_url: url, artwork_url: t.artwork_url || artworkUrl }
          : t)));
      }
      if (spotifyMatchRequestIdRef.current !== requestId) return;
      if (!url) continue; // no preview found for this one - try the next candidate
      const queueEntry = {
        id: candidate.id, source: 'discover',
        track_name: candidate.track_name, artist_name: candidate.artist_name,
        album_name: candidate.album_name, artwork_url: artworkUrl, preview_url: url,
      };
      if (!firstStarted) {
        setSpotifyPlayHint(null);
        startQueue([queueEntry]);
        firstStarted = true;
      } else {
        setQueue((prev) => [...prev, queueEntry]);
      }
    }
    if (spotifyMatchRequestIdRef.current === requestId) setMatchingTrackId(null);
    if (!firstStarted && spotifyMatchRequestIdRef.current === requestId) {
      setSpotifyPlayHint(`No preview available for "${candidates[0].track_name}"${candidates.length > 1 ? ' or the tracks after it' : ''}.`);
    }
  };

  // Toggle shuffling of the *remaining* queue, keeping the currently-playing
  // track fixed. Remembers the pre-shuffle order so toggling back off restores
  // the original upcoming sequence rather than re-shuffling again.
  const toggleShuffle = () => {
    setShuffleEnabled((prevEnabled) => {
      const next = !prevEnabled;
      if (next) {
        preShuffleQueueRef.current = queue;
        setQueue(shuffleArray(queue));
      } else if (preShuffleQueueRef.current) {
        setQueue(preShuffleQueueRef.current);
        preShuffleQueueRef.current = null;
      }
      return next;
    });
  };

  const togglePlay = () => {
    setUserHasInteracted(true);
    if (outputDevice) {
      // A restored session skips the auto-cast on mount, so the device never
      // actually got the track loaded - the first press here needs to cast
      // (load + play) rather than just resume a stream that was never sent.
      if (destNeedsInitialCastRef.current && nowPlaying) {
        destNeedsInitialCastRef.current = false;
        if (nowPlaying.source === 'spotify') {
          if (outputDevice.type !== 'spotify') {
            const localId = resolveLocalTrackId(nowPlaying);
            if (localId != null) castLocalTrack(localId);
            return;
          }
          const endpoint = nowPlaying.context_uri ? 'play' : 'play-uris';
          // Same "drain stale queue residue as part of this same play call"
          // reasoning as the cast-on-change effect above - this is the first
          // real cast of a restored session, not an in-app Next/Prev.
          const spotifyPayload = nowPlaying.context_uri
            ? { context_uri: nowPlaying.context_uri, track_uri: nowPlaying.uri, clear_queue: true }
            : { uris: [nowPlaying.uri, ...queue.slice(0, SPOTIFY_PLAY_QUEUE_LIMIT).map((t) => t.uri)], clear_queue: true };
          axios.post(`${deviceEndpoint(outputDevice)}/${endpoint}`, spotifyPayload)
            .catch(handleSpotifyCastError)
            .finally(() => setTimeout(refreshSpotifyDevices, 7000));
          return;
        }
        if (nowPlaying.source === 'ytmusic') {
          if (outputDevice.type === 'spotify') {
            matchAndQueueYtMusicPlaylistTracksOnSpotify([nowPlaying, ...queue]);
            return;
          }
          const localId = resolveLocalTrackId(nowPlaying);
          if (localId != null) castLocalTrack(localId);
          return;
        }
        if (outputDevice.type === 'spotify') {
          matchAndPlayLocalTracksOnSpotify([nowPlaying, ...queue]);
          return;
        }
        castLocalTrack(resolveLocalTrackId(nowPlaying));
        return;
      }
      const action = destStatus?.status === 'play' ? 'pause' : 'resume';
      axios.post(`${deviceEndpoint(outputDevice)}/${action}`).catch((err) => {
        console.error('Error toggling playback:', err);
      });
      return;
    }
    if (!audioRef.current) return;
    if (audioRef.current.paused) {
      audioRef.current.play();
    } else {
      audioRef.current.pause();
    }
  };

  const handleSeek = (positionMs) => {
    if (outputDevice) {
      axios.post(`${deviceEndpoint(outputDevice)}/seek`, { position_ms: Math.round(positionMs) })
        .catch((err) => console.error('Error seeking playback:', err));
      return;
    }
    if (audioRef.current) {
      audioRef.current.currentTime = positionMs / 1000;
    }
  };

  const handleSetVolume = (level) => {
    const clamped = Math.min(100, Math.max(0, Math.round(level)));
    if (outputDevice) {
      axios.post(`${deviceEndpoint(outputDevice)}/volume`, { level: clamped })
        .catch((err) => console.error('Error setting volume:', err));
      return;
    }
    setVolume(clamped);
    localStorage.setItem('playerVolume', String(clamped));
  };

  const handleTrackPlayClick = (track, list) => {
    if (nowPlaying && nowPlaying.id === track.id) {
      togglePlay();
      return;
    }
    // Discover suggestions have no local file and no known_tracks row. With
    // a Spotify Connect destination selected, match+play (+queue the rest of
    // the list) in full; with This Browser selected, fall back to a 30s
    // preview the same way, so Next/Prev still walk through the list. WiiM/
    // Chromecast can't do either (previews only ever play through this
    // browser's own <audio> element, by design - see sampleQueueDiscoveredTracks).
    if (track.source === 'discover') {
      const startIndex = list.findIndex((t) => t.id === track.id);
      const candidates = startIndex >= 0 ? list.slice(startIndex) : [track];
      if (outputDevice?.type === 'spotify') {
        matchAndQueueDiscoveredTracksOnSpotify(candidates);
      } else if (!outputDevice) {
        sampleQueueDiscoveredTracks(candidates);
      } else {
        setSpotifyPlayHint('Select a Spotify Connect device, or switch to This Browser to sample, to play Discover suggestions.');
      }
      return;
    }
    // YouTube Music playlist tracks: with a Spotify Connect destination,
    // match+play (+queue the rest) on Spotify, same pipeline Discover uses.
    // Any other destination: if this exact video also turned out to be a
    // local file (local_id, via the known_tracks cross-reference - see
    // mapYtMusicTrack), stream it there directly (This Browser, WiiM, or
    // Chromecast - all three can stream a local file the same way), no
    // different from a genuine local-library track. Otherwise, with This
    // Browser selected specifically, open the real video on
    // music.youtube.com in a new tab instead of playing it in-app - an
    // embedded IFrame player was tried and confirmed (live testing) to
    // always fail with "Video unavailable" for every track even though the
    // Data API reports them all embeddable=true and they play fine directly
    // on YouTube; this points to YouTube's bot/integrity verification
    // rejecting the embed context itself (this app runs on a plain-HTTP LAN
    // IP, not a normal registered domain), not a per-video restriction, so
    // there's no in-app fix. WiiM/Chromecast have no such fallback (nothing
    // else they could stream) if there's no local match.
    if (track.source === 'ytmusic') {
      const startIndex = list.findIndex((t) => t.id === track.id);
      const candidates = startIndex >= 0 ? list.slice(startIndex) : [track];
      if (outputDevice?.type === 'spotify') {
        matchAndQueueYtMusicPlaylistTracksOnSpotify(candidates);
      } else if (track.local_id != null) {
        startQueue(candidates.filter((t) => resolveLocalTrackId(t) != null));
      } else if (!outputDevice) {
        const playlistId = libraryMode === 'ytmusic-playlist' ? drill?.key : null;
        const url = playlistId
          ? `https://music.youtube.com/watch?v=${track.video_id}&list=${playlistId}`
          : `https://music.youtube.com/watch?v=${track.video_id}`;
        window.open(url, '_blank', 'noopener,noreferrer');
      } else {
        setSpotifyPlayHint('Select a Spotify Connect device, switch to This Browser, or pick a track already in your local library, to play YouTube Music playlist tracks on this device.');
      }
      return;
    }
    // Spotify playlist tracks stream from Spotify's own servers to a
    // Spotify Connect device - there's no local file to hand to
    // WiiM/Chromecast/This Browser instead, UNLESS this exact track also
    // happens to be a local file (local_id, via the known_tracks
    // cross-reference - see mapSpotifyTrack), in which case any of those
    // three can stream that instead. With no local match and This Browser
    // specifically selected, open Spotify's own web player in a new tab -
    // same fallback shape as the YT Music branch above (open.spotify.com is
    // a genuine, fully-featured Spotify Connect-independent player, unlike
    // the YouTube IFrame embed that was tried and confirmed broken, so this
    // one didn't need that same investigation). WiiM/Chromecast have no
    // such fallback - opening a tab on this computer's browser doesn't play
    // anything on that separate hardware device.
    if (track.source === 'spotify' && outputDevice?.type !== 'spotify') {
      if (track.local_id != null) {
        const startIndex = list.findIndex((t) => t.id === track.id);
        const candidates = (startIndex >= 0 ? list.slice(startIndex) : [track]).filter((t) => resolveLocalTrackId(t) != null);
        startQueue(candidates);
        return;
      }
      if (!outputDevice) {
        window.open(`https://open.spotify.com/track/${track.uri.split(':').pop()}`, '_blank', 'noopener,noreferrer');
        return;
      }
      setSpotifyPlayHint('Select a Spotify Connect device (destination picker) to play Spotify playlists.');
      return;
    }
    // A local track with Spotify Connect as the destination: the actual
    // local file can never reach a Connect device, so match this track (and
    // queue the rest of the list) against Spotify's catalog and play that
    // instead.
    if (track.source !== 'spotify' && outputDevice?.type === 'spotify') {
      attemptSpotifyMatchAndPlay(track, list);
      return;
    }
    playTrackFromList(track, list);
  };

  // Shared between list and grid display styles - grid mode overlays the play
  // button on the artwork instead of showing it as a separate row element.
  const renderTrackCard = (track, list) => {
    // nowPlaying.id is a Spotify uri for a locally-matched or Spotify-matched
    // discover track (see mapMatchedLocalTrack/matchAndQueueDiscoveredTracksOnSpotify),
    // not the id this card is keyed by - bridge via local_id (library tracks)
    // or discover_id (Discover suggestions) so "currently playing" still
    // highlights the right card either way. A previewing discover track
    // doesn't need bridging at all - its nowPlaying.id already equals the
    // card's own id (see sampleQueueDiscoveredTracks).
    const nowPlayingId = nowPlaying && (nowPlaying.local_id ?? nowPlaying.discover_id ?? nowPlaying.ytmusic_id ?? nowPlaying.id);
    const isDiscover = track.source === 'discover';
    const isCurrent = nowPlayingId === track.id;
    const isCardPlaying = isCurrent && effectiveIsPlaying;
    // Only true when *this* card is playing as a 30s preview specifically
    // (as opposed to a full Spotify match) - nowPlaying.source is 'discover'
    // only for preview queue entries built by sampleQueueDiscoveredTracks,
    // 'spotify' for a matched-and-playing-in-full discover suggestion.
    const isPreviewingThis = isCurrent && nowPlaying?.source === 'discover';
    const isMatching = matchingTrackId === track.id;
    // Cross-service availability badges - meaningful for a Playlists-tab
    // track (source 'spotify'/'ytmusic') and for a genuine Library-tab track
    // (no source at all - a matched-local-track queue entry from
    // mapMatchedLocalTrack never gets rendered as its own card, so this never
    // misfires there). matched_spotify_uri/matched_ytmusic_video_id come from
    // the playlist cache/live routes' cross-reference (see main.py's
    // _attach_spotify_track_extras/_attach_ytmusic_track_extras);
    // spotify_track_id/ytmusic_video_id are the same cross-reference read
    // straight off the known_tracks row for a library track (see main.py's
    // get_known_tracks/get_tracks_by_ids).
    const isPlaylistTrack = track.source === 'spotify' || track.source === 'ytmusic';
    const isLibraryTrack = !track.source;
    const availableOnSpotify = track.source === 'spotify' || Boolean(track.matched_spotify_uri) || (isLibraryTrack && Boolean(track.spotify_track_id));
    const availableOnYtMusic = track.source === 'ytmusic' || Boolean(track.matched_ytmusic_video_id) || (isLibraryTrack && Boolean(track.ytmusic_video_id));
    // WiiM (and Chromecast/This Browser, which share the exact same
    // requirement) can only ever stream a local file - never Spotify or
    // YouTube directly - so this is only ever true when the known_tracks
    // cross-reference found this exact playlist track is also on disk (see
    // resolveLocalTrackId/handleTrackPlayClick's WiiM fallback).
    const availableOnWiim = Boolean(resolveLocalTrackId(track));
    const hasPlayed = !isCurrent && playedTrackIds.has(track.id);
    const wasSkipped = !isCurrent && !hasPlayed && skippedTrackIds.has(track.id);
    const playIcon = isMatching ? '⏳' : isCardPlaying ? '❚❚' : '▶';
    const statusBadge = hasPlayed ? (
      <span className="track-status-badge played" title="Already played this session">✓</span>
    ) : wasSkipped ? (
      <span className="track-status-badge skipped" title="No Spotify match found - skipped">✕</span>
    ) : null;
    // Discover/Spotify/YT-Music-sourced tracks have no known_tracks row of
    // their own - track.id is a Spotify uri or YouTube video_id for those,
    // not the integer local track id this endpoint expects (confirmed live:
    // this was firing a guaranteed 422 on every card lacking its own
    // artwork_url). local_id bridges the cross-referenced case where the
    // same track also exists locally; otherwise there's nothing to serve.
    const artworkSrc = track.artwork_url || (
      isPlaylistTrack ? (track.local_id != null ? `${API_BASE_URL}/tracks/${track.local_id}/artwork` : null)
        : isDiscover ? null
          : `${API_BASE_URL}/tracks/${track.id}/artwork`
    );
    // Quick single-track sample, independent of the main Play button - only
    // ever plays through this browser's own <audio> element (previews never
    // cast to a real device), so it's only offered when that's the active
    // destination; otherwise it just explains why not.
    const sampleButton = isDiscover && (
      <button
        className="play-btn preview"
        onClick={(e) => {
          e.stopPropagation();
          if (isPreviewingThis) {
            togglePlay();
          } else if (outputDevice) {
            setSpotifyPlayHint('Switch to This Browser to sample tracks.');
          } else {
            sampleQueueDiscoveredTracks([track]);
          }
        }}
        aria-label={isPreviewingThis ? 'Stop preview' : 'Sample 30 seconds'}
        title={isPreviewingThis ? 'Stop preview' : 'Sample 30 seconds'}
      >
        {isPreviewingThis ? '◼' : '🎧'}
      </button>
    );
    const thumb = (
      <div className="track-thumb-wrap">
        <span className="track-thumb-fallback">{track.track_name.charAt(0).toUpperCase()}</span>
        {artworkSrc && (
          <img
            className="track-thumb"
            src={artworkSrc}
            alt=""
            loading="lazy"
            onError={(e) => { e.target.style.display = 'none'; }}
          />
        )}
        {statusBadge}
        {trackViewStyle === 'grid' && (
          <button
            className="play-btn overlay"
            onClick={() => handleTrackPlayClick(track, list)}
            disabled={isMatching}
            aria-label={isCardPlaying ? 'Pause' : 'Play'}
          >
            {playIcon}
          </button>
        )}
      </div>
    );
    return (
      <div key={track.id} className={`track-card${isCurrent ? ' playing' : ''}`}>
        {trackViewStyle !== 'grid' && (
          <button
            className="play-btn"
            onClick={() => handleTrackPlayClick(track, list)}
            disabled={isMatching}
            aria-label={isCardPlaying ? 'Pause' : 'Play'}
          >
            {playIcon}
          </button>
        )}
        {trackViewStyle !== 'grid' && sampleButton}
        {thumb}
        <div className="track-info">
          <h3>{track.track_name}</h3>
          <p className="artist">{track.artist_name}</p>
          {isDiscover && track.album_name && <p className="album">{track.album_name}</p>}
          {isPreviewingThis && <p className="preview-label">🎧 Sampling 30s preview</p>}
          {(isPlaylistTrack || isLibraryTrack) && (
            <div className="track-availability">
              <span
                className={`availability-icon${availableOnSpotify ? '' : ' unavailable'}`}
                title={availableOnSpotify ? 'Available on Spotify' : 'Not found on Spotify'}
              >
                <SpotifyIcon />
              </span>
              <span
                className={`availability-icon${availableOnYtMusic ? '' : ' unavailable'}`}
                title={availableOnYtMusic ? 'Available on YouTube Music' : 'Not found on YouTube Music'}
              >
                <YtMusicIcon />
              </span>
              <span
                className={`availability-icon${availableOnWiim ? '' : ' unavailable'}`}
                title={availableOnWiim ? (isLibraryTrack ? 'Local file - playable on WiiM' : 'Playable on WiiM (also in your local library)') : 'Not in your local library - can\'t play on WiiM'}
              >
                📡
              </span>
            </div>
          )}
        </div>
        {trackViewStyle === 'grid' && sampleButton}
      </div>
    );
  };

  const handleNext = () => {
    setQueue((prevQueue) => {
      if (prevQueue.length === 0) {
        setIsPlaying(false);
        return prevQueue;
      }
      // An active Chromecast queue already has this next item loaded - tell
      // the device to move to it natively instead of the generic cast effect
      // re-pushing/reloading the whole queue for this change.
      if (outputDevice?.type === 'chromecast' && chromecastQueueLoadedRef.current) {
        skipNextCastPushRef.current = true;
        axios.post(`${deviceEndpoint(outputDevice)}/queue-next`)
          .catch((err) => console.error('Error advancing Chromecast queue:', err));
      }
      if (outputDevice?.type === 'spotify') {
        skipNextCastPushRef.current = true;
        // Play the known next track explicitly rather than calling Spotify's
        // native /next - that just steps its own server-side queue, which
        // only ever has the single lookahead track appended by a *separate*,
        // independently-timed request (see the lookahead-refill effect
        // above). If Next is pressed before that append has landed (or
        // twice quickly), Spotify's queue is momentarily empty and it falls
        // back to its own autoplay/radio pick instead - confirmed live via
        // request timestamps, a /next call landing ~2s before the
        // corresponding /queue append for that slot. Sending the exact URI
        // we already have locally sidesteps that race entirely.
        axios.post(`${deviceEndpoint(outputDevice)}/play-uris`, { uris: [prevQueue[0].uri] })
          .catch(handleSpotifyCastError);
      }
      setHistory((h) => (nowPlaying ? [...h, nowPlaying] : h));
      setNowPlaying(prevQueue[0]);
      setIsPlaying(true);
      return prevQueue.slice(1);
    });
  };

  const handlePrev = () => {
    setHistory((prevHistory) => {
      if (prevHistory.length === 0) return prevHistory;
      if (outputDevice?.type === 'chromecast' && chromecastQueueLoadedRef.current) {
        skipNextCastPushRef.current = true;
        axios.post(`${deviceEndpoint(outputDevice)}/queue-prev`)
          .catch((err) => console.error('Error reversing Chromecast queue:', err));
      }
      const last = prevHistory[prevHistory.length - 1];
      if (outputDevice?.type === 'spotify') {
        skipNextCastPushRef.current = true;
        // Same reasoning as handleNext above: play the known previous track
        // directly instead of relying on Spotify's native /previous, which
        // steps through server-side history we don't control the timing or
        // exact contents of.
        axios.post(`${deviceEndpoint(outputDevice)}/play-uris`, { uris: [last.uri] })
          .catch(handleSpotifyCastError);
      }
      setQueue((q) => (nowPlaying ? [nowPlaying, ...q] : q));
      setNowPlaying(last);
      setIsPlaying(true);
      return prevHistory.slice(0, -1);
    });
  };

  // Jumping to a specific Up Next row: everything from the current track up
  // to (but not including) the clicked one moves into history, the clicked
  // track becomes nowPlaying, and only what came after it remains queued.
  const jumpToQueueItem = (index) => {
    setQueue((prevQueue) => {
      if (index < 0 || index >= prevQueue.length) return prevQueue;
      const skipped = prevQueue.slice(0, index);
      const target = prevQueue[index];
      setHistory((h) => [...h, ...(nowPlaying ? [nowPlaying] : []), ...skipped]);
      setNowPlaying(target);
      setIsPlaying(true);
      setUserHasInteracted(true);
      setInitialSeekMs(null);
      return prevQueue.slice(index + 1);
    });
  };

  // Shuffle needs the *entire* matching set considered, not just one page of it -
  // fetching a capped page and shuffling only that page means "shuffle all" would
  // only ever draw from whatever happened to sort first alphabetically. The count
  // query is cheap, so look up the true total first, then fetch everything in one
  // truly-randomized (server-side ORDER BY RANDOM(), no repeats) request.
  const fetchAllMatchingShuffled = async (params, maxCount) => {
    const countResponse = await axios.get(`${API_BASE_URL}/tracks/known`, { params: { ...params, limit: 1, offset: 0 } });
    const total = countResponse.data.total;
    if (total === 0) return [];
    const fetchLimit = maxCount ? Math.min(total, maxCount) : total;
    const fullResponse = await axios.get(`${API_BASE_URL}/tracks/known`, {
      params: { ...params, limit: fetchLimit, offset: 0, shuffle: true },
    });
    return fullResponse.data.tracks;
  };

  const playGroup = async (group, { shuffle = false } = {}) => {
    if (group.by === 'playlist') {
      try {
        const response = await axios.get(`${API_BASE_URL}/spotify/playlists/${group.key}/tracks`);
        const tracks = response.data.map((t) => mapSpotifyTrack(t));
        if (outputDevice?.type === 'spotify') {
          startQueue(tracks, { shuffle });
        } else if (tracks.some((t) => t.local_id != null)) {
          // WiiM/Chromecast/This Browser can stream whichever tracks in
          // this playlist also resolve a local match (the known_tracks
          // cross-reference - see mapSpotifyTrack) - filter to just those,
          // skipping the rest rather than blocking the whole playlist.
          const ordered = shuffle ? shuffleArray(tracks) : tracks;
          startQueue(ordered.filter((t) => t.local_id != null));
        } else if (!outputDevice) {
          // No local match for anything in this playlist and This Browser
          // selected - open Spotify's own web player on the playlist itself
          // (a fully-featured, Connect-independent player) rather than
          // just blocking.
          window.open(`https://open.spotify.com/playlist/${group.key}`, '_blank', 'noopener,noreferrer');
        } else {
          setSpotifyPlayHint('Select a Spotify Connect device (destination picker) to play Spotify playlists - none of these tracks are in your local library.');
        }
      } catch (err) {
        if (err.response?.status === 403) {
          if (outputDevice?.type === 'spotify') {
            playSpotifyContextDirectly(`spotify:playlist:${group.key}`);
          } else if (!outputDevice) {
            // Can't read the track listing (not owned), but the web player
            // doesn't need to - it can browse/play a followed/public
            // playlist just fine on its own.
            window.open(`https://open.spotify.com/playlist/${group.key}`, '_blank', 'noopener,noreferrer');
          } else {
            setSpotifyPlayHint("Spotify doesn't allow reading the track listing of a playlist you don't own, so this app can't tell which of its tracks are in your local library - select a Spotify Connect device to play it via its own context instead.");
          }
        } else {
          console.error('Error queuing Spotify playlist playback:', err);
        }
      }
      return;
    }
    // YouTube Music playlists were previously falling through to the generic
    // local-library branch below (paramsForGroupKey has no 'ytmusic-playlist'
    // case, so it silently queued nothing) - confirmed live this is why "Play
    // All" did nothing. With a Spotify Connect destination, match+queue the
    // whole playlist the same way an individual track does. Any other
    // destination that also resolves at least one local match (the
    // known_tracks cross-reference - see mapYtMusicTrack) streams just
    // those tracks, skipping ones with no local file. With none at all and
    // This Browser selected, there's no in-app playback path anymore (see
    // the ytmusic branch of handleTrackPlayClick) - instead open the
    // playlist's first video on music.youtube.com with list= set to this
    // playlist's id, so YouTube's own player drives playback through the
    // rest of the playlist from there. WiiM/Chromecast with no local
    // matches at all have nothing left to fall back to.
    if (group.by === 'ytmusic-playlist') {
      try {
        const response = await axios.get(`${API_BASE_URL}/ytmusic/playlists/${group.key}/tracks`);
        const tracks = (shuffle ? shuffleArray(response.data) : response.data).map((t) => mapYtMusicTrack(t));
        if (tracks.length === 0) return;
        if (outputDevice?.type === 'spotify') {
          matchAndQueueYtMusicPlaylistTracksOnSpotify(tracks);
        } else if (tracks.some((t) => t.local_id != null)) {
          startQueue(tracks.filter((t) => t.local_id != null));
        } else if (!outputDevice) {
          window.open(`https://music.youtube.com/watch?v=${tracks[0].video_id}&list=${group.key}`, '_blank', 'noopener,noreferrer');
        } else {
          setSpotifyPlayHint('Select a Spotify Connect device, or switch to This Browser, to play YouTube Music playlists on this device - none of these tracks are in your local library.');
        }
      } catch (err) {
        console.error('Error queuing YouTube Music playlist playback:', err);
      }
      return;
    }
    try {
      const params = { ...buildAmbientFilterParams(), ...paramsForGroupKey(group.by, group.key) };
      const tracks = shuffle
        ? await fetchAllMatchingShuffled(params)
        : (await axios.get(`${API_BASE_URL}/tracks/known`, { params: { ...params, limit: GROUP_QUEUE_LIMIT, offset: 0 } })).data.tracks;
      if (outputDevice?.type === 'spotify') {
        matchAndPlayLocalTracksOnSpotify(tracks);
      } else {
        startQueue(tracks);
      }
    } catch (err) {
      console.error('Error queuing group playback:', err);
    }
  };

  // Play All/Shuffle for the Playlists tab's "All Tracks" mode - the tracks
  // are already in hand (flattened across every playlist, see
  // fetchAllPlaylistTracksFlat), so unlike playGroup above this never fetches
  // anything itself. Spotify-platform tracks are already real Spotify catalog
  // tracks (mapSpotifyTrack), so startQueue handles them directly the same
  // way a Spotify playlist's own Play All does; YT Music-platform tracks need
  // the same match-to-Spotify-or-open-a-tab branching as a single YT Music
  // track click/playGroup's ytmusic-playlist case, just over the whole
  // (filtered) flat list instead of one playlist's tracks.
  const playAllPlaylistTracksFlat = (tracks, { shuffle = false } = {}) => {
    if (!tracks || tracks.length === 0) return;
    const ordered = shuffle ? shuffleArray(tracks) : tracks;
    if (libraryMode === 'playlist') {
      if (outputDevice?.type === 'spotify') {
        startQueue(ordered);
      } else if (ordered.some((t) => t.local_id != null)) {
        // WiiM/Chromecast/This Browser can stream whichever tracks also
        // resolve a local match (the known_tracks cross-reference - see
        // mapSpotifyTrack) - filter to just those.
        startQueue(ordered.filter((t) => t.local_id != null));
      } else if (!outputDevice) {
        // No local match anywhere in this (flattened, cross-playlist) batch
        // - there's no single playlist page to open here the way
        // playGroup's version can, so open the first track's own page
        // instead, same as the YT Music branch below does with its first
        // video.
        window.open(`https://open.spotify.com/track/${ordered[0].uri.split(':').pop()}`, '_blank', 'noopener,noreferrer');
      } else {
        setSpotifyPlayHint('Select a Spotify Connect device (destination picker) to play Spotify playlists - none of these tracks are in your local library.');
      }
      return;
    }
    if (outputDevice?.type === 'spotify') {
      matchAndQueueYtMusicPlaylistTracksOnSpotify(ordered);
    } else if (ordered.some((t) => t.local_id != null)) {
      // At least one track also turned out to be a local file (known_tracks
      // cross-reference) - stream just those (WiiM/Chromecast/This Browser
      // all can). Filtered out tracks with no local match rather than
      // leaving them to resolve per-track, unlike a single-track click -
      // there's no single "first" track's fallback tab to open here for a
      // whole mixed batch.
      startQueue(ordered.filter((t) => t.local_id != null));
    } else if (!outputDevice) {
      window.open(`https://music.youtube.com/watch?v=${ordered[0].video_id}`, '_blank', 'noopener,noreferrer');
    } else {
      setSpotifyPlayHint('Select a Spotify Connect device, or switch to This Browser, to play YouTube Music playlists on this device - none of these tracks are in your local library.');
    }
  };

  const playCurrentFilter = async ({ shuffle = false } = {}) => {
    try {
      const params = buildTrackFilterParams();
      const tracks = shuffle
        ? await fetchAllMatchingShuffled(params)
        : (await axios.get(`${API_BASE_URL}/tracks/known`, { params: { ...params, limit: GROUP_QUEUE_LIMIT, offset: 0 } })).data.tracks;
      if (outputDevice?.type === 'spotify') {
        matchAndPlayLocalTracksOnSpotify(tracks);
      } else {
        startQueue(tracks);
      }
    } catch (err) {
      console.error('Error queuing playback:', err);
    }
  };

  // Shuffle mode buttons for the flat library list ("Shuffle All" = 'track',
  // "Shuffle Albums" = 'album', "Shuffle Artists" = 'artist'): clicking the
  // already-active mode turns it off and reverts to the default alphabetical
  // order (doesn't touch whatever's already playing); clicking a different
  // mode switches straight to it, re-showing the list in that shuffled order
  // and starting playback from it.
  const setLibraryShuffle = async (mode) => {
    if (libraryShuffleMode === mode) {
      setLibraryShuffleMode('');
      fetchLibraryTracks(0);
      return;
    }
    setLibraryShuffleMode(mode);
    const tracks = await fetchLibraryTracksForShuffleMode(mode);
    if (tracks.length === 0) return;
    if (outputDevice?.type === 'spotify') {
      matchAndPlayLocalTracksOnSpotify(tracks);
    } else {
      startQueue(tracks);
    }
  };

  // Pushes the currently-shown library list (whatever order it's in -
  // shuffled or not) to a new private Spotify playlist. Only tracks already
  // matched to a Spotify id can go in - resolving unmatched ones on the spot
  // could mean a slow or rate-limited request for a large list, so those are
  // just skipped and reported rather than attempted.
  const pushLibraryToSpotifyPlaylist = async () => {
    if (libraryTracks.length === 0) return;
    const defaultName = `Library — ${new Date().toLocaleDateString()}`;
    const name = window.prompt('Name for the new Spotify playlist:', defaultName);
    if (!name) return;
    setPushingToSpotify(true);
    try {
      const response = await axios.post(`${API_BASE_URL}/spotify/playlists/from-library`, {
        name,
        track_ids: libraryTracks.map((t) => t.id),
      });
      const { added, skipped, playlist_url: playlistUrl } = response.data;
      setSpotifyPlayHint(
        `Created "${name}" on Spotify with ${added.toLocaleString()} track${added === 1 ? '' : 's'}` +
        (skipped > 0 ? ` (${skipped.toLocaleString()} skipped - not yet matched to Spotify)` : '') +
        (playlistUrl ? '.' : ' (no link returned).')
      );
    } catch (err) {
      console.error('Error pushing playlist to Spotify:', err);
      setSpotifyPlayHint(err.response?.data?.detail || 'Failed to create the Spotify playlist.');
    } finally {
      setPushingToSpotify(false);
    }
  };

  // Same idea as pushLibraryToSpotifyPlaylist, but for YouTube Music - unlike
  // Spotify, there's no prewarmed match cache for YT Music, so a small push
  // (<= YTMUSIC_LIBRARY_PUSH_LIMIT) is matched live and completes immediately,
  // same as before. A larger push can't fit in one request's worth of quota,
  // so the backend instead starts a paced multi-day background job and
  // responds with {job_started: true} - progress/pace/ETA for that job show
  // up in Settings > YouTube Music (YtMusicSettingsSection), not here, since
  // it keeps running long after this button click returns.
  const pushLibraryToYtMusicPlaylist = async () => {
    if (libraryTracks.length === 0) return;
    const defaultName = `Library — ${new Date().toLocaleDateString()}`;
    const name = window.prompt('Name for the new YouTube Music playlist:', defaultName);
    if (!name) return;
    setPushingToYtMusic(true);
    try {
      const response = await axios.post(`${API_BASE_URL}/ytmusic/playlists/from-library`, {
        name,
        track_ids: libraryTracks.map((t) => t.id),
      });
      if (response.data.job_started) {
        const queuePosition = response.data.queue_position || 0;
        setYtMusicPlayHint(
          `"${name}" is too large to push in one go - ` +
          (queuePosition > 0
            ? `queued behind ${queuePosition} other push${queuePosition === 1 ? '' : 'es'}.`
            : 'started as a background job that\'ll add tracks over the next several days.') +
          ' Click "Push to YouTube Music" again any time to see progress.'
        );
        return;
      }
      const { added, skipped, playlist_url: playlistUrl } = response.data;
      setYtMusicPlayHint(
        `Created "${name}" on YouTube Music with ${added.toLocaleString()} track${added === 1 ? '' : 's'}` +
        (skipped > 0 ? ` (${skipped.toLocaleString()} skipped - no YouTube Music match found)` : '') +
        (playlistUrl ? '.' : ' (no link returned).')
      );
    } catch (err) {
      console.error('Error pushing playlist to YouTube Music:', err);
      setYtMusicPlayHint(err.response?.data?.detail || 'Failed to create the YouTube Music playlist.');
    } finally {
      setPushingToYtMusic(false);
    }
  };

  // Same idea as pushLibraryToSpotifyPlaylist, but for Discover suggestions -
  // these have no known_tracks row/cached spotify_track_id, so the backend
  // matches each one live instead (only reasonable because Discover result
  // sets are always small - see /api/spotify/playlists/from-discovered).
  const pushDiscoveredToSpotifyPlaylist = async () => {
    if (discoveredTracks.length === 0) return;
    const defaultName = `Discovered — ${new Date().toLocaleDateString()}`;
    const name = window.prompt('Name for the new Spotify playlist:', defaultName);
    if (!name) return;
    setPushingToSpotify(true);
    try {
      const response = await axios.post(`${API_BASE_URL}/spotify/playlists/from-discovered`, {
        name,
        tracks: discoveredTracks.map((t) => ({
          track_name: t.track_name, artist_name: t.artist_name,
          native_track_name: t.native_track_name, native_artist_name: t.native_artist_name,
        })),
      });
      const { added, skipped, playlist_url: playlistUrl } = response.data;
      setSpotifyPlayHint(
        `Created "${name}" on Spotify with ${added.toLocaleString()} track${added === 1 ? '' : 's'}` +
        (skipped > 0 ? ` (${skipped.toLocaleString()} skipped - no Spotify match found)` : '') +
        (playlistUrl ? '.' : ' (no link returned).')
      );
    } catch (err) {
      console.error('Error pushing discovered tracks to Spotify:', err);
      setSpotifyPlayHint(err.response?.data?.detail || 'Failed to create the Spotify playlist.');
    } finally {
      setPushingToSpotify(false);
    }
  };

  // Same idea as pushDiscoveredToSpotifyPlaylist, but for YouTube Music -
  // reuses the identical request shape (POST /api/ytmusic/playlists/from-discovered
  // takes the same {name, tracks} body) since it's pure text either way.
  const pushDiscoveredToYtMusicPlaylist = async () => {
    if (discoveredTracks.length === 0) return;
    const defaultName = `Discovered — ${new Date().toLocaleDateString()}`;
    const name = window.prompt('Name for the new YouTube Music playlist:', defaultName);
    if (!name) return;
    setPushingToYtMusic(true);
    try {
      const response = await axios.post(`${API_BASE_URL}/ytmusic/playlists/from-discovered`, {
        name,
        tracks: discoveredTracks.map((t) => ({
          track_name: t.track_name, artist_name: t.artist_name,
          native_track_name: t.native_track_name, native_artist_name: t.native_artist_name,
        })),
      });
      const { added, skipped, playlist_url: playlistUrl } = response.data;
      setYtMusicPlayHint(
        `Created "${name}" on YouTube Music with ${added.toLocaleString()} track${added === 1 ? '' : 's'}` +
        (skipped > 0 ? ` (${skipped.toLocaleString()} skipped - no YouTube Music match found)` : '') +
        (playlistUrl ? '.' : ' (no link returned).')
      );
    } catch (err) {
      console.error('Error pushing discovered tracks to YouTube Music:', err);
      setYtMusicPlayHint(err.response?.data?.detail || 'Failed to create the YouTube Music playlist.');
    } finally {
      setPushingToYtMusic(false);
    }
  };

  const viewLabel = (mode) => {
    if (mode === 'all') return 'All Tracks';
    return `By ${mode.charAt(0).toUpperCase()}${mode.slice(1)}`;
  };
  const backLabel = drill && BACK_LABELS[drill.by];
  const effectiveIsPlaying = outputDevice ? destStatus?.status === 'play' : isPlaying;

  // Playlists tab search - purely client-side over whatever's already been
  // fetched in full (groups = playlist list, libraryTracks = one drilled
  // playlist's tracks). Guarded by activeTab so this never bothers filtering
  // a potentially large My Library libraryTracks array on every render.
  const playlistSearchLower = playlistSearchInput.trim().toLowerCase();
  const filteredPlaylistGroups = activeTab === 'playlists' && playlistSearchLower
    ? groups.filter((g) => g.label.toLowerCase().includes(playlistSearchLower))
    : groups;
  const filteredPlaylistTracks = activeTab === 'playlists' && playlistSearchLower
    ? libraryTracks.filter((t) => t.track_name.toLowerCase().includes(playlistSearchLower)
      || (t.artist_name || '').toLowerCase().includes(playlistSearchLower))
    : libraryTracks;
  const filteredFlatPlaylistTracks = playlistSearchLower
    ? flatPlaylistTracks.filter((t) => t.track_name.toLowerCase().includes(playlistSearchLower)
      || (t.artist_name || '').toLowerCase().includes(playlistSearchLower))
    : flatPlaylistTracks;

  // Only meaningful when discoveredGroupedByArtist is true - discoveredTracks
  // already has same-artist tracks landing consecutively (lastfm.py builds
  // results artist-by-artist), so grouping here is just splitting on
  // consecutive runs of the same artist_name, no extra data needed.
  const discoverArtistGroups = [];
  for (const track of discoveredTracks) {
    const last = discoverArtistGroups[discoverArtistGroups.length - 1];
    if (last && last.artist_name === track.artist_name) {
      last.tracks.push(track);
    } else {
      discoverArtistGroups.push({ artist_name: track.artist_name, tracks: [track] });
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-brand">
          <svg className="app-logo" viewBox="0 0 64 64" aria-hidden="true">
            <defs>
              <linearGradient id="app-logo-gradient" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#6366f1" />
                <stop offset="100%" stopColor="#818cf8" />
              </linearGradient>
            </defs>
            <rect width="64" height="64" rx="14" fill="url(#app-logo-gradient)" />
            <path d="M23 18 L23 46 L47 32 Z" fill="#f5f5f7" />
          </svg>
          <h1>Music Discovery</h1>
        </div>
        <nav className="nav-tabs">
          <button
            className={activeTab === 'library' ? 'active' : ''}
            onClick={() => {
              setActiveTab('library');
              // 'playlist'/'ytmusic-playlist' only belong to the Playlists tab
              // now - VIEW_MODES no longer has a button for either, so leaving
              // libraryMode on one here would show an orphaned view with no
              // way to switch it from this tab.
              if (libraryMode === 'playlist' || libraryMode === 'ytmusic-playlist') {
                setLibraryMode('all');
                setDrill(null);
              }
            }}
          >
            My Library
          </button>
          <button
            className={activeTab === 'taste' ? 'active' : ''}
            onClick={() => setActiveTab('taste')}
          >
            Taste Profile
          </button>
          <button
            className={activeTab === 'playlists' ? 'active' : ''}
            onClick={() => {
              setActiveTab('playlists');
              if (libraryMode !== 'playlist' && libraryMode !== 'ytmusic-playlist') {
                setLibraryMode('playlist');
                setDrill(null);
              }
            }}
          >
            Playlists
          </button>
          <button
            className={activeTab === 'cleanup' ? 'active' : ''}
            onClick={() => setActiveTab('cleanup')}
          >
            Cleanup
          </button>
        </nav>
        <button className="settings-btn" onClick={() => setSettingsOpen(true)} aria-label="Settings" title="Settings">
          &#9881;
        </button>
      </header>

      <main className={nowPlaying ? 'with-player' : ''}>
        {activeTab === 'library' ? (
          <section className="library-section">
            <InfoPopup message={spotifyPlayHint} onClose={() => setSpotifyPlayHint(null)} />
            {spotifyMatchProgress && (
              <p className="empty-state spotify-play-hint">{spotifyMatchProgress}</p>
            )}
            <InfoPopup message={ytMusicPlayHint} onClose={() => setYtMusicPlayHint(null)} />
            {ytMusicPushPanelOpen && (
              <YtMusicPushPanel
                apiBase={API_BASE_URL}
                onPush={pushLibraryToYtMusicPlaylist}
                pushing={pushingToYtMusic}
                onClose={() => setYtMusicPushPanelOpen(false)}
              />
            )}
            <div className="library-controls">
              <div className="search-row">
                <input
                  type="text"
                  className="search-input"
                  placeholder="Search tracks, artists, albums…"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                />
                <div className="artist-search-wrap">
                  <input
                    type="text"
                    className="search-input artist-search-input"
                    placeholder="🎤 Find an artist…"
                    value={artistSearchInput}
                    onChange={(e) => { setArtistSearchInput(e.target.value); setArtistSuggestionsOpen(true); }}
                    onFocus={() => { if (artistSuggestions.length > 0) setArtistSuggestionsOpen(true); }}
                    onBlur={() => setArtistSuggestionsOpen(false)}
                    onKeyDown={handleArtistSearchKeyDown}
                  />
                  {artistSuggestionsOpen && artistSuggestions.length > 0 && (
                    <div className="artist-suggestions">
                      {artistSuggestions.map((a, i) => (
                        <button
                          key={a.key}
                          type="button"
                          className={i === artistSuggestionHighlight ? 'active' : ''}
                          onMouseDown={(e) => { e.preventDefault(); selectArtistSuggestion(a.key); }}
                        >
                          <span className="artist-suggestion-name">{a.label}</span>
                          <span className="artist-suggestion-count">{a.count.toLocaleString()}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="view-style-toggle">
                  <button
                    className={trackViewStyle === 'list' ? 'active' : ''}
                    onClick={() => setTrackViewStyle('list')}
                    aria-label="List view"
                    title="List view"
                  >
                    &#9776;
                  </button>
                  <button
                    className={trackViewStyle === 'grid' ? 'active' : ''}
                    onClick={() => setTrackViewStyle('grid')}
                    aria-label="Grid view"
                    title="Grid view"
                  >
                    &#9638;
                  </button>
                </div>
              </div>
              <div className="view-tabs">
                {VIEW_MODES.map((mode) => (
                  <button
                    key={mode}
                    className={libraryMode === mode && !drill ? 'active' : ''}
                    onClick={() => { setLibraryMode(mode); setDrill(null); }}
                  >
                    {viewLabel(mode)}
                  </button>
                ))}
              </div>
              <div className="filter-row">
                <select value={filterGenre} onChange={(e) => setFilterGenre(e.target.value)}>
                  <option value="">All Genres</option>
                  {genreOptions.map((g) => <option key={g.key} value={g.key}>{g.label} ({g.count})</option>)}
                </select>
                <select value={filterDecade} onChange={(e) => setFilterDecade(e.target.value)}>
                  <option value="">All Decades</option>
                  {decadeOptions.map((d) => <option key={d.key} value={d.key}>{d.label} ({d.count})</option>)}
                </select>
                <select value={filterQuality} onChange={(e) => setFilterQuality(e.target.value)}>
                  <option value="best">Best Quality Only</option>
                  <option value="">All Qualities (Show Duplicates)</option>
                  {qualityOptions.map((q) => <option key={q.key} value={q.key}>{q.label} ({q.count})</option>)}
                </select>
                <select value={filterFormat} onChange={(e) => setFilterFormat(e.target.value)}>
                  <option value="">All Formats</option>
                  {formatOptions.map((f) => <option key={f.key} value={f.key}>{f.label} ({f.count})</option>)}
                </select>
                <label className="filter-checkbox-label" title="Only tracks with an already-cached Spotify match - no live search needed to play them">
                  <input
                    type="checkbox"
                    checked={filterSpotifyAvailable}
                    onChange={(e) => setFilterSpotifyAvailable(e.target.checked)}
                  />
                  Available on Spotify
                </label>
                <select
                  value={filterTrackLimit}
                  onChange={(e) => setFilterTrackLimit(e.target.value)}
                  title="Cap how many matching tracks are fetched/shown"
                >
                  <option value="">No Limit</option>
                  <option value="50">Max 50</option>
                  <option value="100">Max 100</option>
                  <option value="250">Max 250</option>
                  <option value="500">Max 500</option>
                  <option value="1000">Max 1,000</option>
                </select>
                <button className="clear-filters-btn" onClick={clearAllFilters}>Clear All</button>
              </div>
              <div className="discover-bar">
                <span className="discover-bar-label">✨ Discover</span>
                <select
                  value={discoverTrackCount}
                  onChange={(e) => setDiscoverTrackCount(Number(e.target.value))}
                  title="How many recommended tracks (or artists, in group-by-artist mode) to aim for - a ceiling, not a guarantee, a narrow filter may return fewer"
                >
                  {[5, 10, 15, 20, 30].map((n) => (
                    <option key={n} value={n}>{n} {discoverGroupByArtist ? 'artists' : 'tracks'}</option>
                  ))}
                </select>
                <label className="filter-checkbox-label" title="Show a few of each recommended artist's own top tracks, grouped together, instead of one flat list of individual tracks">
                  <input
                    type="checkbox"
                    checked={discoverGroupByArtist}
                    onChange={(e) => setDiscoverGroupByArtist(e.target.checked)}
                  />
                  🎤 Group by artist
                </label>
                <button
                  className="discover-filter-btn"
                  onClick={handleDiscoverFromLibrary}
                  disabled={discovering}
                  title="Find tracks similar to whatever's currently filtered"
                >
                  {discovering ? 'Discovering…' : 'Discover similar tracks'}
                </button>
                {discoverError && <p className="error-message">{discoverError}</p>}
              </div>
            </div>

            {discoveredTracks.length > 0 && (
              <div className="library-view-toggle">
                <button
                  className={!showDiscoverPanel ? 'active' : ''}
                  onClick={() => setShowDiscoverPanel(false)}
                >
                  📚 Library
                </button>
                <button
                  className={showDiscoverPanel ? 'active' : ''}
                  onClick={() => setShowDiscoverPanel(true)}
                >
                  ✨ Discovered ({discoveredTracks.length})
                </button>
              </div>
            )}

            {!showDiscoverPanel && drill && (
              <div className="drill-header">
                <button className="back-btn" onClick={() => setDrill(null)}>&larr; Back to {backLabel}</button>
                <h2>{drill.label}</h2>
                <div className="group-actions">
                  <button className="group-action-btn" onClick={() => playGroup(drill)}>&#9654; Play All</button>
                  <button className="group-action-btn" onClick={() => playGroup(drill, { shuffle: true })}>&#128256; Shuffle</button>
                </div>
              </div>
            )}

            {!showDiscoverPanel && (drill || libraryMode === 'all' ? (
              <>
                <div className="library-header">
                  {!drill && (
                    <h2>
                      Playing on:{' '}
                      <span style={{ color: isPlaying ? '#16a34a' : 'var(--text-main)' }}>
                        {outputDevice ? outputDevice.name : 'This Browser'}
                      </span>
                    </h2>
                  )}
                  {!drill && libraryTracks.length > 0 && (
                    <div className="group-actions">
                      <button className="group-action-btn" onClick={() => playCurrentFilter()}>&#9654; Play All</button>
                      <button
                        className={`group-action-btn${libraryShuffleMode === 'track' ? ' active' : ''}`}
                        onClick={() => setLibraryShuffle('track')}
                      >
                        &#128256; Shuffle All
                      </button>
                      <button
                        className={`group-action-btn${libraryShuffleMode === 'album' ? ' active' : ''}`}
                        onClick={() => setLibraryShuffle('album')}
                        title="Randomize album order, one random track per album per round, until every album has been played"
                      >
                        &#128256; Shuffle Albums
                      </button>
                      <button
                        className={`group-action-btn${libraryShuffleMode === 'artist' ? ' active' : ''}`}
                        onClick={() => setLibraryShuffle('artist')}
                        title="Randomize artist order, one random track per artist per round, until every artist has been played"
                      >
                        &#128256; Shuffle Artists
                      </button>
                      {spotifyConnected && (
                        <button
                          className="group-action-btn"
                          onClick={pushLibraryToSpotifyPlaylist}
                          disabled={pushingToSpotify}
                          title="Create a private Spotify playlist from the tracks currently shown (already-matched ones only)"
                        >
                          <SpotifyIcon /> {pushingToSpotify ? 'Pushing…' : 'Push to Spotify'}
                        </button>
                      )}
                      {ytMusicConnected && (
                        <button
                          className="group-action-btn"
                          onClick={() => setYtMusicPushPanelOpen(true)}
                          title="View YouTube Music push status, or push the current mix"
                        >
                          <YtMusicIcon /> Push to YouTube Music
                        </button>
                      )}
                    </div>
                  )}
                  <span className="library-count">
                    {libraryTotal.toLocaleString()} tracks
                    {' · '}{libraryAlbumCount.toLocaleString()} albums
                    {' · '}{libraryArtistCount.toLocaleString()} artists
                  </span>
                </div>
                {libraryTracks.length === 0 ? (
                  <p className="empty-state">
                    {libraryLoading ? 'Loading…' : 'No tracks found. Open Settings to scan a library folder.'}
                  </p>
                ) : (
                  <div className={`tracks-grid${trackViewStyle === 'grid' ? ' grid-view' : ''}`}>
                    {libraryTracks.map((track) => renderTrackCard(track, libraryTracks))}
                  </div>
                )}
                {libraryTracks.length < libraryTotal && (
                  <button
                    className="load-more-btn"
                    disabled={libraryLoading}
                    onClick={() => fetchLibraryTracks(libraryTracks.length)}
                  >
                    {libraryLoading ? 'Loading…' : `Load more (${libraryTracks.length.toLocaleString()} of ${libraryTotal.toLocaleString()})`}
                  </button>
                )}
              </>
            ) : (
              <div className={`groups-grid${trackViewStyle === 'grid' ? ' grid-view' : ''}`}>
                {groupsLoading ? (
                  <p className="empty-state">Loading…</p>
                ) : groups.length === 0 ? (
                  <p className="empty-state">No {libraryMode}s found.</p>
                ) : (
                  groups.map((g) => (
                    <div key={g.key} className="group-card">
                      <div className="group-thumb-wrap">
                        <span className="group-thumb-fallback">{g.label.charAt(0).toUpperCase()}</span>
                        {(g.artwork_url || g.sample_track_id != null) && (
                          <img
                            className="group-thumb"
                            src={g.artwork_url || `${API_BASE_URL}/tracks/${g.sample_track_id}/artwork`}
                            alt=""
                            loading="lazy"
                            onError={(e) => { e.target.style.display = 'none'; }}
                          />
                        )}
                      </div>
                      <div className="group-card-main" onClick={() => setDrill({ by: libraryMode, key: g.key, label: g.label })}>
                        <h3>{g.label}</h3>
                        <span className="group-count">{g.count.toLocaleString()} tracks</span>
                      </div>
                      <div className="group-card-actions">
                        <button title="Play all" onClick={() => playGroup({ by: libraryMode, key: g.key })}>&#9654;</button>
                        <button title="Shuffle" onClick={() => playGroup({ by: libraryMode, key: g.key }, { shuffle: true })}>&#128256;</button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            ))}

            {showDiscoverPanel && discoveredTracks.length > 0 && (
              <div className="discover-results">
                <div className="library-header">
                  <h2>Discovered for you</h2>
                  {(spotifyConnected || ytMusicConnected) && (
                    <div className="group-actions">
                      {spotifyConnected && (
                        <button
                          className="group-action-btn"
                          onClick={pushDiscoveredToSpotifyPlaylist}
                          disabled={pushingToSpotify}
                          title="Create a private Spotify playlist from these recommendations (matched live, since they're not in your library)"
                        >
                          <SpotifyIcon /> {pushingToSpotify ? 'Pushing…' : 'Push to Spotify'}
                        </button>
                      )}
                      {ytMusicConnected && (
                        <button
                          className="group-action-btn"
                          onClick={pushDiscoveredToYtMusicPlaylist}
                          disabled={pushingToYtMusic}
                          title="Create a YouTube Music playlist from these recommendations (matched live, since they're not in your library)"
                        >
                          <YtMusicIcon /> {pushingToYtMusic ? 'Pushing…' : 'Push to YouTube Music'}
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {discoveredGroupedByArtist ? (
                  discoverArtistGroups.map((group) => (
                    <div key={group.artist_name} className="discover-artist-group">
                      <h3>{group.artist_name}</h3>
                      <div className={`tracks-grid${trackViewStyle === 'grid' ? ' grid-view' : ''}`}>
                        {group.tracks.map((track) => renderTrackCard(track, discoveredTracks))}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className={`tracks-grid${trackViewStyle === 'grid' ? ' grid-view' : ''}`}>
                    {discoveredTracks.map((track) => renderTrackCard(track, discoveredTracks))}
                  </div>
                )}
              </div>
            )}
          </section>
        ) : activeTab === 'playlists' ? (
          <section className="library-section playlists-section">
            <InfoPopup message={spotifyPlayHint} onClose={() => setSpotifyPlayHint(null)} />
            {spotifyMatchProgress && (
              <p className="empty-state spotify-play-hint">{spotifyMatchProgress}</p>
            )}
            <div className="library-controls">
              <div className="search-row">
                <input
                  type="text"
                  className="search-input"
                  placeholder={
                    playlistsFlatView ? 'Search all tracks…' : drill ? 'Search this playlist’s tracks…' : 'Search playlists…'
                  }
                  value={playlistSearchInput}
                  onChange={(e) => setPlaylistSearchInput(e.target.value)}
                />
                <div className="view-style-toggle">
                  <button
                    className={trackViewStyle === 'list' ? 'active' : ''}
                    onClick={() => setTrackViewStyle('list')}
                    aria-label="List view"
                    title="List view"
                  >
                    &#9776;
                  </button>
                  <button
                    className={trackViewStyle === 'grid' ? 'active' : ''}
                    onClick={() => setTrackViewStyle('grid')}
                    aria-label="Grid view"
                    title="Grid view"
                  >
                    &#9638;
                  </button>
                </div>
              </div>
              <div className="view-tabs">
                <button
                  className={libraryMode === 'playlist' ? 'active' : ''}
                  onClick={() => { setLibraryMode('playlist'); setDrill(null); setPlaylistSearchInput(''); }}
                >
                  <SpotifyIcon /> Spotify
                </button>
                <button
                  className={libraryMode === 'ytmusic-playlist' ? 'active' : ''}
                  onClick={() => { setLibraryMode('ytmusic-playlist'); setDrill(null); setPlaylistSearchInput(''); }}
                >
                  <YtMusicIcon /> YouTube Music
                </button>
                <span className="view-tabs-divider" />
                <button
                  className={!playlistsFlatView ? 'active' : ''}
                  onClick={() => { setPlaylistsFlatView(false); setPlaylistSearchInput(''); }}
                >
                  By Playlist
                </button>
                <button
                  className={playlistsFlatView ? 'active' : ''}
                  onClick={() => { setPlaylistsFlatView(true); setDrill(null); setPlaylistSearchInput(''); }}
                >
                  All Tracks
                </button>
              </div>
            </div>

            {playlistsFlatView ? (
              <>
                <div className="library-header">
                  <h2>
                    Playing on:{' '}
                    <span style={{ color: isPlaying ? '#16a34a' : 'var(--text-main)' }}>
                      {outputDevice ? outputDevice.name : 'This Browser'}
                    </span>
                  </h2>
                  {filteredFlatPlaylistTracks.length > 0 && (
                    <div className="group-actions">
                      <button className="group-action-btn" onClick={() => playAllPlaylistTracksFlat(filteredFlatPlaylistTracks)}>&#9654; Play All</button>
                      <button className="group-action-btn" onClick={() => playAllPlaylistTracksFlat(filteredFlatPlaylistTracks, { shuffle: true })}>&#128256; Shuffle</button>
                    </div>
                  )}
                  <span className="library-count">{filteredFlatPlaylistTracks.length.toLocaleString()} tracks</span>
                </div>
                <div className="empty-state playlist-cache-status">
                  <span>
                    {flatPlaylistRefreshedAt
                      ? `Last updated ${new Date(flatPlaylistRefreshedAt).toLocaleString()}`
                      : flatPlaylistTracksLoading ? 'Loading…' : ''}
                  </span>
                  <button
                    type="button"
                    className="load-more-btn"
                    disabled={flatPlaylistTracksLoading}
                    onClick={() => fetchAllPlaylistTracksFlat(true)}
                  >
                    {flatPlaylistTracksLoading ? 'Refreshing…' : 'Refresh'}
                  </button>
                </div>
                {flatPlaylistSkippedCount > 0 && (
                  <p className="empty-state spotify-play-hint">
                    {flatPlaylistSkippedCount} playlist{flatPlaylistSkippedCount > 1 ? 's' : ''} you don't own couldn't be read individually and {flatPlaylistSkippedCount > 1 ? 'were' : 'was'} left out - use that playlist's own Play All/Shuffle from By Playlist view instead.
                  </p>
                )}
                {flatPlaylistTracksLoading && flatPlaylistTracks.length === 0 ? (
                  <p className="empty-state">Loading…</p>
                ) : filteredFlatPlaylistTracks.length === 0 ? (
                  <p className="empty-state">
                    {playlistSearchLower ? `No tracks match "${playlistSearchInput}".` : 'No tracks found.'}
                  </p>
                ) : (
                  <div className={`tracks-grid${trackViewStyle === 'grid' ? ' grid-view' : ''}`}>
                    {filteredFlatPlaylistTracks.map((track) => renderTrackCard(track, filteredFlatPlaylistTracks))}
                  </div>
                )}
              </>
            ) : (
              <>
                {drill && (
                  <div className="drill-header">
                    <button className="back-btn" onClick={() => { setDrill(null); setPlaylistSearchInput(''); }}>&larr; Back to {backLabel}</button>
                    <h2>{drill.label}</h2>
                    <div className="group-actions">
                      <button className="group-action-btn" onClick={() => playGroup(drill)}>&#9654; Play All</button>
                      <button className="group-action-btn" onClick={() => playGroup(drill, { shuffle: true })}>&#128256; Shuffle</button>
                    </div>
                  </div>
                )}

                {!drill && (
                  <div className="library-header">
                    <h2>
                      Playing on:{' '}
                      <span style={{ color: isPlaying ? '#16a34a' : 'var(--text-main)' }}>
                        {outputDevice ? outputDevice.name : 'This Browser'}
                      </span>
                    </h2>
                  </div>
                )}

                {drill ? (
                  filteredPlaylistTracks.length === 0 ? (
                    <p className="empty-state">
                      {libraryLoading
                        ? 'Loading…'
                        : playlistTracksRestricted
                          ? "Spotify doesn't allow browsing individual tracks in a playlist you don't own — use Play All / Shuffle above to play the whole playlist."
                          : playlistSearchLower
                            ? `No tracks match "${playlistSearchInput}".`
                            : 'This playlist has no tracks.'}
                    </p>
                  ) : (
                    <div className={`tracks-grid${trackViewStyle === 'grid' ? ' grid-view' : ''}`}>
                      {filteredPlaylistTracks.map((track) => renderTrackCard(track, filteredPlaylistTracks))}
                    </div>
                  )
                ) : (
                  <div className={`groups-grid${trackViewStyle === 'grid' ? ' grid-view' : ''}`}>
                    {groupsLoading ? (
                      <p className="empty-state">Loading…</p>
                    ) : libraryMode === 'playlist' && !spotifyConnected ? (
                      <p className="empty-state">Connect Spotify in Settings to browse your playlists.</p>
                    ) : libraryMode === 'ytmusic-playlist' && !ytMusicConnected ? (
                      <p className="empty-state">Connect YouTube Music in Settings to browse your playlists.</p>
                    ) : filteredPlaylistGroups.length === 0 ? (
                      <p className="empty-state">
                        {playlistSearchLower
                          ? `No playlists match "${playlistSearchInput}".`
                          : `No ${libraryMode === 'ytmusic-playlist' ? 'YouTube Music playlist' : 'Spotify playlist'}s found.`}
                      </p>
                    ) : (
                      filteredPlaylistGroups.map((g) => (
                        <div key={g.key} className="group-card">
                          <div className="group-thumb-wrap">
                            <span className="group-thumb-fallback">{g.label.charAt(0).toUpperCase()}</span>
                            {(g.artwork_url || g.sample_track_id != null) && (
                              <img
                                className="group-thumb"
                                src={g.artwork_url || `${API_BASE_URL}/tracks/${g.sample_track_id}/artwork`}
                                alt=""
                                loading="lazy"
                                onError={(e) => { e.target.style.display = 'none'; }}
                              />
                            )}
                          </div>
                          <div className="group-card-main" onClick={() => { setDrill({ by: libraryMode, key: g.key, label: g.label }); setPlaylistSearchInput(''); }}>
                            <h3>{g.label}</h3>
                            <span className="group-count">{g.count.toLocaleString()} tracks</span>
                          </div>
                          <div className="group-card-actions">
                            <button title="Play all" onClick={() => playGroup({ by: libraryMode, key: g.key })}>&#9654;</button>
                            <button title="Shuffle" onClick={() => playGroup({ by: libraryMode, key: g.key }, { shuffle: true })}>&#128256;</button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </>
            )}
          </section>
        ) : activeTab === 'taste' ? (
          <section className="taste-section">
            {statsLoading && !stats ? (
              <p className="empty-state">Loading taste profile...</p>
            ) : !stats || stats.total_tracks === 0 ? (
              <p className="empty-state">Scan your library to build a taste profile.</p>
            ) : (
              <>
                <div className="stat-tiles">
                  <div className="stat-tile">
                    <span className="stat-value">{stats.total_tracks.toLocaleString()}</span>
                    <span className="stat-label">Tracks</span>
                  </div>
                  <div className="stat-tile">
                    <span className="stat-value">{stats.top_genres.length}</span>
                    <span className="stat-label">Genres</span>
                  </div>
                  <div className="stat-tile">
                    <span className="stat-value">{stats.top_artists.length}</span>
                    <span className="stat-label">Top artists</span>
                  </div>
                  <div className="stat-tile">
                    <span className="stat-value">{stats.tracks_by_decade.length}</span>
                    <span className="stat-label">Decades spanned</span>
                  </div>
                </div>

                <BarChart title="Top Genres" entries={stats.top_genres} />
                <BarChart title="Top Artists" entries={stats.top_artists} />
                <BarChart title="Tracks by Decade" entries={stats.tracks_by_decade} />
              </>
            )}
          </section>
        ) : (
          <CleanupTab
            apiBase={API_BASE_URL}
            activeTab={activeTab}
            nowPlaying={nowPlaying}
            isPlaying={effectiveIsPlaying}
            onTrackPlayClick={handleTrackPlayClick}
          />
        )}
      </main>

      {settingsOpen && (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          rootPath={rootPath}
          setRootPath={setRootPath}
          scanning={scanning}
          scanResult={scanResult}
          scanError={scanError}
          onScan={handleScan}
          outputDevices={outputDevices}
          apiBase={API_BASE_URL}
          spotifyConnected={spotifyConnected}
          onSpotifyDisconnect={() => axios.post(`${API_BASE_URL}/spotify/auth/logout`).finally(refreshSpotifyStatus)}
          ytMusicConnected={ytMusicConnected}
          onYtMusicConnected={refreshYtMusicStatus}
          onYtMusicDisconnect={() => axios.post(`${API_BASE_URL}/ytmusic/auth/disconnect`).finally(refreshYtMusicStatus)}
        />
      )}

      <PlayerBar
        track={nowPlaying}
        queue={queue}
        isPlaying={effectiveIsPlaying}
        hasNext={queue.length > 0}
        hasPrev={history.length > 0}
        onNext={handleNext}
        onPrev={handlePrev}
        onJumpToQueueItem={jumpToQueueItem}
        onTogglePlay={togglePlay}
        setIsPlaying={setIsPlaying}
        audioRef={audioRef}
        apiBase={API_BASE_URL}
        outputDevices={outputDevices}
        outputDevice={outputDevice}
        setOutputDevice={setOutputDevice}
        onRefreshSpotifyDevices={refreshSpotifyDevices}
        destStatus={destStatus}
        volume={volume}
        onSetVolume={handleSetVolume}
        shuffleEnabled={shuffleEnabled}
        onToggleShuffle={toggleShuffle}
        onSeek={handleSeek}
        userHasInteracted={userHasInteracted}
        initialSeekMs={initialSeekMs}
        onInitialSeekApplied={() => setInitialSeekMs(null)}
      />
    </div>
  );
}

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return null;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function formatFileSize(bytes) {
  if (!bytes) return null;
  const mb = bytes / (1024 * 1024);
  return mb >= 1000 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
}

function channelLabel(channels) {
  if (!channels) return null;
  if (channels === 1) return 'Mono';
  if (channels === 2) return 'Stereo';
  return `${channels}ch`;
}

function YtMusicSettingsSection({ ytMusicConnected, apiBase, onConnected, onDisconnect, matchPrewarmStatus }) {
  const [pairing, setPairing] = useState(null); // { verification_url, user_code } while a device-code login is in progress
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };
  useEffect(() => stopPolling, []);

  const startConnect = async () => {
    setError(null);
    try {
      const response = await axios.post(`${apiBase}/ytmusic/auth/start`);
      setPairing(response.data);
      pollRef.current = setInterval(async () => {
        try {
          const pollResponse = await axios.post(`${apiBase}/ytmusic/auth/poll`);
          if (pollResponse.data.status === 'connected') {
            stopPolling();
            setPairing(null);
            onConnected();
          } else if (pollResponse.data.status === 'expired') {
            stopPolling();
            setPairing(null);
            setError('Sign-in code expired - click Connect to try again.');
          }
        } catch (err) {
          stopPolling();
          setPairing(null);
          setError(err.response?.data?.detail || 'YouTube Music sign-in failed.');
        }
      }, 3000);
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not start YouTube Music sign-in.');
    }
  };

  if (ytMusicConnected) {
    return (
      <>
        <p className="hint">Connected. Discover playlists can be pushed to YouTube Music above.</p>
        {matchPrewarmStatus && matchPrewarmStatus.status !== 'idle' && (
          <p className="hint">
            Resolving Spotify matches for YouTube Music playlist tracks (All Tracks mode): {matchPrewarmStatus.status === 'done'
              ? `done — ${(matchPrewarmStatus.matched || 0).toLocaleString()} matched of ${(matchPrewarmStatus.processed || 0).toLocaleString()} checked`
              : matchPrewarmStatus.status === 'waiting_active_use'
                ? 'paused while the app is in use'
                : matchPrewarmStatus.status === 'waiting_not_connected'
                  ? 'paused (Spotify not connected)'
                  : matchPrewarmStatus.status === 'error'
                    ? `error: ${matchPrewarmStatus.error}`
                    : `running — ${(matchPrewarmStatus.matched || 0).toLocaleString()} matched of ${(matchPrewarmStatus.processed || 0).toLocaleString()} checked so far`}
          </p>
        )}
        <button type="button" className="scan-btn" onClick={onDisconnect}>Disconnect YouTube Music</button>
      </>
    );
  }

  if (pairing) {
    return (
      <>
        <p className="hint">
          Go to <a href={pairing.verification_url} target="_blank" rel="noreferrer">{pairing.verification_url}</a> and enter this code:
        </p>
        <p className="ytmusic-pairing-code">{pairing.user_code}</p>
        <p className="hint">Waiting for you to finish signing in…</p>
      </>
    );
  }

  return (
    <>
      <p className="hint">Connect your YouTube Music (Google) account to push Discover recommendations there as a playlist.</p>
      {error && <p className="error-message">{error}</p>}
      <button type="button" className="scan-btn" onClick={startConnect}>Connect YouTube Music</button>
    </>
  );
}

function SettingsPanel({
  onClose, rootPath, setRootPath, scanning, scanResult, scanError, onScan, outputDevices, apiBase,
  spotifyConnected, onSpotifyDisconnect, ytMusicConnected, onYtMusicConnected, onYtMusicDisconnect,
}) {
  const [prewarmStatus, setPrewarmStatus] = useState(null);
  const [matchPrewarmStatus, setMatchPrewarmStatus] = useState(null);

  useEffect(() => {
    if (!spotifyConnected) return;
    let cancelled = false;
    const poll = () => {
      axios.get(`${apiBase}/spotify/prewarm/status`).then((response) => {
        if (!cancelled) setPrewarmStatus(response.data);
      }).catch((err) => console.error('Error fetching Spotify pre-warm status:', err));
    };
    poll();
    const intervalId = setInterval(poll, 10000);
    return () => { cancelled = true; clearInterval(intervalId); };
  }, [spotifyConnected, apiBase]);

  // Resolves a Spotify match for cached YouTube Music playlist tracks in the
  // background (see playlist_match_prewarm.py) - only meaningful once both
  // are connected, since it needs Spotify to match against.
  useEffect(() => {
    if (!spotifyConnected || !ytMusicConnected) return;
    let cancelled = false;
    const poll = () => {
      axios.get(`${apiBase}/playlists/match-prewarm/status`).then((response) => {
        if (!cancelled) setMatchPrewarmStatus(response.data);
      }).catch((err) => console.error('Error fetching playlist match pre-warm status:', err));
    };
    poll();
    const intervalId = setInterval(poll, 10000);
    return () => { cancelled = true; clearInterval(intervalId); };
  }, [spotifyConnected, ytMusicConnected, apiBase]);

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="settings-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>
        <form onSubmit={onScan} className="scan-form">
          <div className="form-group full">
            <label>Library folder</label>
            <div className="scan-row">
              <input
                type="text"
                value={rootPath}
                onChange={(e) => setRootPath(e.target.value)}
                placeholder="/music"
                required
              />
              <button type="submit" disabled={scanning} className="scan-btn">
                {scanning ? 'Scanning...' : 'Scan Library'}
              </button>
            </div>
            <p className="hint">Path as seen by the backend container (bind-mounted from MUSIC_LIBRARY_PATH).</p>
          </div>
          {scanError && <p className="error-message">{scanError}</p>}
          {scanResult && scanResult.status !== 'idle' && (
            <p className="scan-summary">
              {scanResult.status === 'running' ? 'Scanning… ' : scanResult.status === 'error' ? 'Scan failed after ' : 'Scan complete — '}
              {(scanResult.processed || 0).toLocaleString()} processed &middot; added {scanResult.added || 0} &middot; updated {scanResult.updated || 0}
              {scanResult.skipped > 0 ? ` · ${scanResult.skipped} unreadable` : ''}
            </p>
          )}
        </form>

        <div className="settings-section">
          <label>Playback devices</label>
          {outputDevices.length === 0 ? (
            <p className="hint">No WiiM, Chromecast, or Spotify Connect devices available.</p>
          ) : (
            <div className="device-list">
              {outputDevices.map((d) => (
                <div className="device-row" key={`${d.type}-${d.id}`}>
                  <span className="device-row-icon">{d.type === 'chromecast' ? '📺' : d.type === 'spotify' ? '🟢' : '📡'}</span>
                  <span className="device-row-name">{d.name}</span>
                  <span className="device-row-ip">{d.ip || ''}</span>
                  <span className="device-row-type">{d.type === 'chromecast' ? 'Chromecast' : d.type === 'spotify' ? 'Spotify Connect' : 'WiiM'}</span>
                  {d.type === 'spotify' && d.status && d.status !== 'unknown' && (
                    <span
                      className={`device-status-dot ${d.status}`}
                      title={d.status === 'failed' ? 'Last playback attempt on this device failed' : 'Last playback attempt on this device succeeded'}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
          <p className="hint">
            Edit WIIM_DEVICES / CHROMECAST_DEVICES in .env and rebuild to add, remove, or rename WiiM/Chromecast devices.
            Spotify Connect devices are whatever the Spotify app reports as active on your account.
          </p>
        </div>

        <div className="settings-section">
          <label>Spotify</label>
          {spotifyConnected ? (
            <>
              <p className="hint">Connected. Spotify Connect devices and playlists are available above and under the Playlists tab.</p>
              {prewarmStatus && prewarmStatus.status !== 'idle' && (
                <p className="hint">
                  Pre-warming library matches: {prewarmStatus.status === 'done'
                    ? `done — ${(prewarmStatus.matched || 0).toLocaleString()} matched of ${(prewarmStatus.processed || 0).toLocaleString()} checked`
                    : prewarmStatus.status === 'waiting_active_use'
                      ? 'paused while the app is in use'
                      : prewarmStatus.status === 'waiting_not_connected'
                        ? 'paused (not connected)'
                        : prewarmStatus.status === 'error'
                          ? `error: ${prewarmStatus.error}`
                          : `running — ${(prewarmStatus.matched || 0).toLocaleString()} matched of ${(prewarmStatus.processed || 0).toLocaleString()} checked so far`}
                </p>
              )}
              <button type="button" className="scan-btn" onClick={onSpotifyDisconnect}>Disconnect Spotify</button>
            </>
          ) : (
            <>
              <p className="hint">Connect your Spotify account to play playlists on a Spotify Connect device (phone, desktop app, speaker, etc.).</p>
              <a className="scan-btn" href={`${apiBase}/spotify/auth/login`}>Connect Spotify</a>
            </>
          )}
        </div>

        <div className="settings-section">
          <label>YouTube Music</label>
          <YtMusicSettingsSection
            ytMusicConnected={ytMusicConnected}
            apiBase={apiBase}
            onConnected={onYtMusicConnected}
            onDisconnect={onYtMusicDisconnect}
            matchPrewarmStatus={matchPrewarmStatus}
          />
        </div>
      </div>
    </div>
  );
}

function PlayerBar({
  track, queue, isPlaying, hasNext, hasPrev, onNext, onPrev, onTogglePlay, setIsPlaying, audioRef, apiBase,
  outputDevices, outputDevice, setOutputDevice, onRefreshSpotifyDevices, destStatus,
  volume, onSetVolume,
  shuffleEnabled, onToggleShuffle, onSeek, onJumpToQueueItem,
  userHasInteracted, initialSeekMs, onInitialSeekApplied,
}) {
  const [expanded, setExpanded] = useState(false);
  const [artistInfo, setArtistInfo] = useState(null);
  const [bioExpanded, setBioExpanded] = useState(false);
  const [destMenuOpen, setDestMenuOpen] = useState(false);
  const [volumeMenuOpen, setVolumeMenuOpen] = useState(false);
  const toggleDestMenu = () => {
    setDestMenuOpen((o) => {
      // Refresh right as it opens (not on every render) so a Spotify
      // device's status dot reflects the latest known reliability rather
      // than whatever was fetched once at page load.
      if (!o && onRefreshSpotifyDevices) onRefreshSpotifyDevices();
      return !o;
    });
  };
  const [localProgress, setLocalProgress] = useState({ currentTime: 0, duration: 0 });
  const [albumPosition, setAlbumPosition] = useState(null);
  const lastArtistRef = useRef(null);
  const lastAlbumPositionTrackIdRef = useRef(null);

  useEffect(() => {
    if (!expanded || !track) return;
    if (lastArtistRef.current === track.artist_name) return;
    lastArtistRef.current = track.artist_name;
    setArtistInfo(null);
    setBioExpanded(false);
    axios.get(`${apiBase}/artist-info`, { params: { name: track.artist_name } })
      .then((r) => setArtistInfo(r.data))
      .catch(() => setArtistInfo({ found: false }));
  }, [expanded, track, apiBase]);

  useEffect(() => {
    if (!expanded || !track || track.source === 'spotify') return;
    if (lastAlbumPositionTrackIdRef.current === track.id) return;
    lastAlbumPositionTrackIdRef.current = track.id;
    setAlbumPosition(null);
    axios.get(`${apiBase}/tracks/${track.id}/album-position`)
      .then((r) => setAlbumPosition(r.data))
      .catch(() => setAlbumPosition(null));
  }, [expanded, track, apiBase]);

  useEffect(() => {
    setLocalProgress({ currentTime: 0, duration: 0 });
  }, [track?.id]);

  // Applies the locally-stored volume to the <audio> element - needed on
  // every track change too since a new track_id remounts a fresh <audio>
  // node (key={localStreamId}) that otherwise starts back at full volume.
  useEffect(() => {
    if (!outputDevice && audioRef.current) {
      audioRef.current.volume = volume / 100;
    }
  }, [track?.id, outputDevice, volume, audioRef]);

  if (!track) return null;

  const metaParts = [track.genre, track.year, formatDuration(track.duration_seconds)].filter(Boolean);
  const techParts = [
    track.file_format,
    track.bitrate ? `${Math.round(track.bitrate / 1000)}kbps` : null,
    track.sample_rate ? `${(track.sample_rate / 1000).toFixed(1)}kHz` : null,
    channelLabel(track.channels),
    formatFileSize(track.file_size_bytes),
  ].filter(Boolean);

  let albumPositionLabel = null;
  if (albumPosition && albumPosition.track_number != null) {
    albumPositionLabel = `Track #${albumPosition.track_number}`;
    if (albumPosition.track_total != null) albumPositionLabel += `, of ${albumPosition.track_total}`;
    if (albumPosition.library_track_count != null) albumPositionLabel += ` (${albumPosition.library_track_count} in Lib)`;
  }

  const positionMs = outputDevice ? (destStatus?.position_ms || 0) : localProgress.currentTime * 1000;
  const durationMs = outputDevice ? (destStatus?.duration_ms || 0) : localProgress.duration * 1000;
  const progressRatio = durationMs > 0 ? Math.min(1, positionMs / durationMs) : 0;

  const handleProgressClick = (e) => {
    if (!durationMs) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    onSeek(ratio * durationMs);
  };

  const destinationLabel = outputDevice ? outputDevice.name : 'This Browser';
  const displayVolume = outputDevice ? (destStatus?.volume ?? 100) : volume;
  const handleVolumeSliderChange = (e) => onSetVolume(Number(e.target.value));
  const deviceIcon = (d) => (d.type === 'chromecast' ? '📺' : d.type === 'spotify' ? '🟢' : '📡');
  // Discover/Spotify/YT-Music-sourced tracks have no known_tracks row of
  // their own - t.id is a Spotify uri or YouTube video_id for those, not
  // the integer local track id this endpoint expects (confirmed live: a
  // guaranteed 422 whenever such a track had no artwork_url of its own).
  // local_id bridges the cross-referenced case where the same track also
  // exists locally; otherwise there's nothing to serve.
  const trackArtworkUrl = (t) => t.artwork_url || (
    (t.source === 'spotify' || t.source === 'ytmusic') ? (t.local_id != null ? `${apiBase}/tracks/${t.local_id}/artwork` : '')
      : t.source === 'discover' ? ''
        : `${apiBase}/tracks/${t.id}/artwork`
  );
  // track.id is a Spotify uri or YouTube video_id (not a real local track
  // id) whenever the current track is a Spotify/YT Music catalog/playlist
  // track - "This Browser" can only ever stream a real local file, so it
  // needs the *local* id. local_id bridges that for a track that started
  // life as a local-library match (mapMatchedLocalTrack) or turned out to
  // also exist locally via the cross-reference (mapSpotifyTrack/
  // mapYtMusicTrack's local_track_id passthrough); a genuine
  // Spotify/YT-only track (no local_id) has no local file to fall back to
  // at all - nothing this browser can play. A discover-preview track
  // (source 'discover') is a third case, handled separately below via its
  // own preview_url - it was never a local_id candidate to begin with.
  const localStreamId = track.source === 'spotify' || track.source === 'ytmusic' ? (track.local_id ?? null)
    : track.source === 'discover' ? null
    : track.id;

  return (
    <div className="player-root">
      {expanded && (
        <div className="now-playing-panel">
          <div
            className="now-playing-backdrop"
            style={{ backgroundImage: `url(${trackArtworkUrl(track)})` }}
          />
          <button className="now-playing-collapse" onClick={() => setExpanded(false)} aria-label="Collapse">&#9660;</button>

          <div className="now-playing-grid">
            <div className="np-main-col">
              <div className="np-hero-row">
                <section className="np-section np-art-section">
                  <div className="now-playing-art">
                    <img
                      key={track.id}
                      src={trackArtworkUrl(track)}
                      alt=""
                      onError={(e) => { e.target.style.display = 'none'; }}
                    />
                  </div>
                </section>

                <section className="np-section np-info-section">
                  <h2 className="now-playing-title">{track.track_name}</h2>
                  <div className="now-playing-artist-row">
                    {artistInfo?.found && (
                      <img
                        className="now-playing-artist-photo"
                        src={`${apiBase}/artist-info/photo?name=${encodeURIComponent(track.artist_name)}`}
                        alt=""
                        onError={(e) => { e.target.style.display = 'none'; }}
                      />
                    )}
                    <p className="now-playing-artist">{track.artist_name}</p>
                  </div>
                  {track.album_name && <p className="now-playing-album">{track.album_name}</p>}
                  {metaParts.length > 0 && <p className="now-playing-meta">{metaParts.join(' · ')}</p>}
                  {techParts.length > 0 && <p className="now-playing-tech">{techParts.join(' · ')}</p>}
                  {albumPositionLabel && <p className="now-playing-tech">{albumPositionLabel}</p>}
                </section>
              </div>

              {artistInfo?.found && artistInfo.biography && (
                <section className={`np-section np-bio-section${bioExpanded ? ' expanded' : ''}`}>
                  <h3>About {track.artist_name}</h3>
                  <div className="np-bio-scroll">
                    <p className={bioExpanded ? '' : 'clamped'}>{artistInfo.biography}</p>
                  </div>
                  <button className="bio-toggle" onClick={() => setBioExpanded(!bioExpanded)}>
                    {bioExpanded ? 'Show less' : 'Read more'}
                  </button>
                </section>
              )}
            </div>

            <div className="np-queue-col">
              {queue && queue.length > 0 && (
                <section className="np-section np-queue-section">
                  <div className="now-playing-queue-header">
                    <h3>Up Next</h3>
                    <span className="queue-count">
                      {queue.length.toLocaleString()} track{queue.length === 1 ? '' : 's'} queued
                      {queue.length > 200 ? ' — showing first 200' : ''}
                    </span>
                  </div>
                  <div className="queue-list">
                    {queue.slice(0, 200).map((t, idx) => (
                      <div
                        className="queue-row"
                        key={`${t.id}-${idx}`}
                        onClick={() => onJumpToQueueItem(idx)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onJumpToQueueItem(idx); } }}
                        role="button"
                        tabIndex={0}
                      >
                        <div className="queue-thumb-wrap">
                          <span className="queue-thumb-fallback">{t.track_name.charAt(0).toUpperCase()}</span>
                          <img
                            className="queue-thumb"
                            src={trackArtworkUrl(t)}
                            alt=""
                            loading="lazy"
                            onError={(e) => { e.target.style.display = 'none'; }}
                          />
                        </div>
                        <div className="queue-track-info">
                          <span className="queue-track-title">{t.track_name}</span>
                          <span className="queue-track-artist">{t.artist_name}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                  {queue.length > 200 && (
                    <p className="queue-more-note">
                      + {(queue.length - 200).toLocaleString()} more tracks queued (all {queue.length.toLocaleString()} will still play — this list just isn't showing all of them)
                    </p>
                  )}
                </section>
              )}
            </div>

            <div className="np-bottom-bar">
              <section className="np-section np-progress-section">
                <div className="np-progress-track" onClick={handleProgressClick}>
                  <div className="np-progress-fill" style={{ width: `${progressRatio * 100}%` }} />
                  <div className="np-progress-handle" style={{ left: `${progressRatio * 100}%` }} />
                </div>
                <div className="np-progress-times">
                  <span>{formatDuration(Math.floor(positionMs / 1000))}</span>
                  <span>{formatDuration(Math.floor(durationMs / 1000))}</span>
                </div>
              </section>

              <section className="np-section np-controls-section">
                <button
                  className={`np-side-btn${shuffleEnabled ? ' active' : ''}`}
                  onClick={onToggleShuffle}
                  aria-label="Shuffle"
                  aria-pressed={shuffleEnabled}
                  title="Shuffle"
                >
                  <IconShuffle />
                </button>
                <div className="np-transport">
                  <button className="player-btn large" onClick={onPrev} disabled={!hasPrev} aria-label="Previous"><IconPrev /></button>
                  <button className="player-btn xlarge" onClick={onTogglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>
                    {isPlaying ? <IconPause /> : <IconPlay />}
                  </button>
                  <button className="player-btn large" onClick={onNext} disabled={!hasNext} aria-label="Next"><IconNext /></button>
                </div>
                <div className="np-destination">
                  <button
                    className={`np-side-btn${outputDevice ? ' active' : ''}`}
                    onClick={toggleDestMenu}
                    aria-label="Playback destination"
                    title={`Playing on ${destinationLabel}`}
                  >
                    <IconDevices />
                  </button>
                  {destMenuOpen && (
                    <div className="np-destination-menu">
                      <button
                        className={!outputDevice ? 'active' : ''}
                        onClick={() => { setOutputDevice(null); setDestMenuOpen(false); }}
                      >
                        🔊 This Browser
                      </button>
                      {outputDevices.map((d) => (
                        <button
                          key={d.id}
                          className={outputDevice?.id === d.id ? 'active' : ''}
                          onClick={() => { setOutputDevice(d); setDestMenuOpen(false); }}
                        >
                          {deviceIcon(d)} {d.name}
                          {d.type === 'spotify' && d.status && d.status !== 'unknown' && (
                            <span
                              className={`device-status-dot ${d.status}`}
                              title={d.status === 'failed' ? 'Last playback attempt on this device failed' : 'Last playback attempt on this device succeeded'}
                            />
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </section>
              <p className="np-destination-label">Playing on {destinationLabel}</p>
            </div>
          </div>
        </div>
      )}
      <div className="player-bar">
        <div className="player-thumb-wrap" onClick={() => setExpanded(true)}>
          <img
            key={track.id}
            src={trackArtworkUrl(track)}
            alt=""
            onError={(e) => { e.target.style.display = 'none'; }}
          />
        </div>
        <div className="player-info" onClick={() => setExpanded(true)}>
          <span className="player-title">{track.track_name}</span>
          <span className="player-artist">{track.artist_name}</span>
        </div>

        <div className="player-center">
          <div className="player-progress-row">
            <span className="player-progress-time">{formatDuration(Math.floor(positionMs / 1000))}</span>
            <div className="np-progress-track" onClick={handleProgressClick}>
              <div className="np-progress-fill" style={{ width: `${progressRatio * 100}%` }} />
              <div className="np-progress-handle" style={{ left: `${progressRatio * 100}%` }} />
            </div>
            <span className="player-progress-time">{formatDuration(Math.floor(durationMs / 1000))}</span>
            <span className="player-destination-label" title={`Playing on ${destinationLabel}`}>
              Playing on <span className="player-destination-name">{destinationLabel}</span>
            </span>
          </div>

          <div className="player-controls">
            <button
              className={`player-btn${shuffleEnabled ? ' active' : ''}`}
              onClick={onToggleShuffle}
              aria-label="Shuffle"
              aria-pressed={shuffleEnabled}
              title="Shuffle"
            >
              <IconShuffle />
            </button>
            <button className="player-btn" onClick={onPrev} disabled={!hasPrev} aria-label="Previous"><IconPrev /></button>
            <button className="player-btn" onClick={onTogglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>
              {isPlaying ? <IconPause /> : <IconPlay />}
            </button>
            <button className="player-btn" onClick={onNext} disabled={!hasNext} aria-label="Next"><IconNext /></button>
            <div className="player-volume">
              <button
                className={`player-btn${volumeMenuOpen ? ' active' : ''}`}
                onClick={() => setVolumeMenuOpen((o) => !o)}
                aria-label="Volume"
                title={`Volume ${displayVolume}%`}
              >
                <IconVolume level={displayVolume} />
              </button>
              {volumeMenuOpen && (
                <div className="player-volume-menu">
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={displayVolume}
                    onChange={handleVolumeSliderChange}
                  />
                  <span>{displayVolume}%</span>
                </div>
              )}
            </div>
            <div className="np-destination">
              <button
                className={`player-btn${outputDevice ? ' active' : ''}`}
                onClick={toggleDestMenu}
                aria-label="Playback destination"
                title={`Playing on ${destinationLabel}`}
              >
                <IconDevices />
              </button>
              {destMenuOpen && (
                <div className="np-destination-menu">
                  <button
                    className={!outputDevice ? 'active' : ''}
                    onClick={() => { setOutputDevice(null); setDestMenuOpen(false); }}
                  >
                    🔊 This Browser
                  </button>
                  {outputDevices.map((d) => (
                    <button
                      key={d.id}
                      className={outputDevice?.id === d.id ? 'active' : ''}
                      onClick={() => { setOutputDevice(d); setDestMenuOpen(false); }}
                    >
                      {deviceIcon(d)} {d.name}
                      {d.type === 'spotify' && d.status && d.status !== 'unknown' && (
                        <span
                          className={`device-status-dot ${d.status}`}
                          title={d.status === 'failed' ? 'Last playback attempt on this device failed' : 'Last playback attempt on this device succeeded'}
                        />
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {techParts.length > 0 && <p className="player-tech">{techParts.join(' · ')}</p>}
        </div>

        {!outputDevice && (track.source === 'discover' ? (
          track.preview_url ? (
            <audio
              key={track.id}
              ref={audioRef}
              src={track.preview_url}
              autoPlay={userHasInteracted}
              className="player-audio-hidden"
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onEnded={onNext}
              onTimeUpdate={(e) => setLocalProgress({ currentTime: e.target.currentTime, duration: e.target.duration || 0 })}
              onLoadedMetadata={(e) => {
                if (initialSeekMs != null) {
                  e.target.currentTime = initialSeekMs / 1000;
                  onInitialSeekApplied();
                }
                setLocalProgress({ currentTime: e.target.currentTime, duration: e.target.duration || 0 });
              }}
            />
          ) : (
            <p className="player-no-local-file">No preview available for this track.</p>
          )
        ) : localStreamId != null ? (
          <audio
            key={localStreamId}
            ref={audioRef}
            src={`${apiBase}/tracks/${localStreamId}/stream`}
            autoPlay={userHasInteracted}
            className="player-audio-hidden"
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onEnded={onNext}
            onTimeUpdate={(e) => setLocalProgress({ currentTime: e.target.currentTime, duration: e.target.duration || 0 })}
            onLoadedMetadata={(e) => {
              if (initialSeekMs != null) {
                e.target.currentTime = initialSeekMs / 1000;
                onInitialSeekApplied();
              }
              setLocalProgress({ currentTime: e.target.currentTime, duration: e.target.duration || 0 });
            }}
          />
        ) : (
          <p className="player-no-local-file">
            {track.source === 'ytmusic'
              ? 'This track has no local copy - select a Spotify Connect device, or open it on YouTube Music.'
              : 'This track is only on Spotify - select a Spotify Connect device to play it.'}
          </p>
        ))}
      </div>
    </div>
  );
}

function BarChart({ title, entries }) {
  if (!entries || entries.length === 0) return null;
  const max = Math.max(...entries.map((e) => e.count));
  return (
    <div className="bar-chart">
      <h2>{title}</h2>
      <div className="bar-list">
        {entries.map((entry) => (
          <div className="bar-row" key={entry.name}>
            <span className="bar-label">{entry.name}</span>
            <div className="bar-track">
              <div className="bar-fill" style={{ width: `${(entry.count / max) * 100}%` }} />
            </div>
            <span className="bar-count">{entry.count.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CleanupTab({ apiBase, activeTab, nowPlaying, isPlaying, onTrackPlayClick }) {
  const [subTab, setSubTab] = useState('duplicates');

  const [duplicateGroups, setDuplicateGroups] = useState(null);
  const [duplicatesLoading, setDuplicatesLoading] = useState(false);
  const [duplicatesShown, setDuplicatesShown] = useState(30);

  const [missingTracksAlbums, setMissingTracksAlbums] = useState(null);
  const [missingTracksLoading, setMissingTracksLoading] = useState(false);

  const [artworkCheckStatus, setArtworkCheckStatus] = useState(null);
  const [missingArtworkTracks, setMissingArtworkTracks] = useState([]);
  const [missingArtworkTotal, setMissingArtworkTotal] = useState(0);
  const artworkPollRef = useRef(null);

  const [externalArtworkStatus, setExternalArtworkStatus] = useState(null);
  const [externalArtworkFoundTracks, setExternalArtworkFoundTracks] = useState([]);
  const [externalArtworkFoundTotal, setExternalArtworkFoundTotal] = useState(0);
  const externalArtworkPollRef = useRef(null);

  const [tagCleanupStatus, setTagCleanupStatus] = useState(null);
  const [tagCleanupFixedTracks, setTagCleanupFixedTracks] = useState([]);
  const [tagCleanupFixedTotal, setTagCleanupFixedTotal] = useState(0);
  const tagCleanupPollRef = useRef(null);

  const [spotifyPrewarmStatus, setSpotifyPrewarmStatus] = useState(null);
  const [spotifyPrewarmStats, setSpotifyPrewarmStats] = useState(null);
  const spotifyPrewarmPollRef = useRef(null);

  const [trackIdStats, setTrackIdStats] = useState(null);
  const [trackIdTracks, setTrackIdTracks] = useState([]);
  const [trackIdTotal, setTrackIdTotal] = useState(0);
  const trackIdPollRef = useRef(null);

  // Album-level artwork coverage - shared between the Missing Artwork and
  // Track ID tabs (both jobs can find artwork now, see
  // shazam_identify.run's opportunistic Shazam artwork save).
  const [albumArtworkStats, setAlbumArtworkStats] = useState(null);

  const fetchDuplicates = async () => {
    setDuplicatesLoading(true);
    try {
      const response = await axios.get(`${apiBase}/library/duplicates`);
      setDuplicateGroups(response.data);
    } catch (err) {
      console.error('Error fetching duplicates:', err);
    } finally {
      setDuplicatesLoading(false);
    }
  };

  const fetchMissingTracks = async () => {
    setMissingTracksLoading(true);
    try {
      const response = await axios.get(`${apiBase}/library/missing-tracks`);
      setMissingTracksAlbums(response.data);
    } catch (err) {
      console.error('Error fetching missing tracks:', err);
    } finally {
      setMissingTracksLoading(false);
    }
  };

  const fetchMissingArtwork = async (offset) => {
    try {
      const response = await axios.get(`${apiBase}/tracks/known`, { params: { has_artwork: false, limit: 100, offset } });
      setMissingArtworkTotal(response.data.total);
      setMissingArtworkTracks((prev) => (offset === 0 ? response.data.tracks : [...prev, ...response.data.tracks]));
    } catch (err) {
      console.error('Error fetching missing-artwork tracks:', err);
    }
  };

  const pollArtworkCheck = () => {
    if (artworkPollRef.current) clearInterval(artworkPollRef.current);
    artworkPollRef.current = setInterval(async () => {
      try {
        const response = await axios.get(`${apiBase}/library/check-artwork/status`);
        setArtworkCheckStatus(response.data);
        if (response.data.status === 'done' || response.data.status === 'error') {
          clearInterval(artworkPollRef.current);
          artworkPollRef.current = null;
          if (response.data.status === 'done') {
            fetchMissingArtwork(0);
            fetchAlbumArtworkStats();
          }
        }
      } catch (err) {
        clearInterval(artworkPollRef.current);
        artworkPollRef.current = null;
        console.error('Error polling artwork check status:', err);
      }
    }, 1500);
  };

  const startArtworkCheck = async () => {
    try {
      const response = await axios.post(`${apiBase}/library/check-artwork`);
      setArtworkCheckStatus(response.data);
      pollArtworkCheck();
    } catch (err) {
      console.error('Error starting artwork check:', err);
    }
  };

  const fetchExternalArtworkFound = async (offset) => {
    try {
      const response = await axios.get(`${apiBase}/tracks/known`, { params: { external_artwork_found: true, limit: 100, offset } });
      setExternalArtworkFoundTotal(response.data.total);
      setExternalArtworkFoundTracks((prev) => (offset === 0 ? response.data.tracks : [...prev, ...response.data.tracks]));
    } catch (err) {
      console.error('Error fetching externally-found artwork tracks:', err);
    }
  };

  const pollExternalArtwork = () => {
    if (externalArtworkPollRef.current) clearInterval(externalArtworkPollRef.current);
    externalArtworkPollRef.current = setInterval(async () => {
      try {
        const response = await axios.get(`${apiBase}/library/external-artwork/status`);
        setExternalArtworkStatus(response.data);
        // Keeps polling through 'waiting' (MusicBrainz/iTunes rate limits) -
        // only a real end state stops it. Re-fetching both lists while work
        // is happening shows missing-artwork visibly shrinking and the
        // found-via-external list visibly growing, not just once the whole
        // run finishes.
        if (response.data.status === 'running' || response.data.status === 'done') {
          fetchMissingArtwork(0);
          fetchExternalArtworkFound(0);
          fetchAlbumArtworkStats();
        }
        if (response.data.status === 'done' || response.data.status === 'error') {
          clearInterval(externalArtworkPollRef.current);
          externalArtworkPollRef.current = null;
        }
      } catch (err) {
        clearInterval(externalArtworkPollRef.current);
        externalArtworkPollRef.current = null;
        console.error('Error polling external artwork status:', err);
      }
    }, 1500);
  };

  const startExternalArtwork = async () => {
    try {
      const response = await axios.post(`${apiBase}/library/external-artwork`);
      setExternalArtworkStatus(response.data);
      pollExternalArtwork();
    } catch (err) {
      setExternalArtworkStatus({ status: 'error', error: err.response?.data?.detail || 'Failed to start' });
      console.error('Error starting external artwork backfill:', err);
    }
  };

  const fetchTagCleanupFixed = async (offset) => {
    try {
      const response = await axios.get(`${apiBase}/library/tag-cleanup/fixed`, { params: { limit: 100, offset } });
      setTagCleanupFixedTotal(response.data.total);
      setTagCleanupFixedTracks((prev) => (offset === 0 ? response.data.tracks : [...prev, ...response.data.tracks]));
    } catch (err) {
      console.error('Error fetching fixed tags:', err);
    }
  };

  const pollTagCleanup = () => {
    if (tagCleanupPollRef.current) clearInterval(tagCleanupPollRef.current);
    tagCleanupPollRef.current = setInterval(async () => {
      try {
        const response = await axios.get(`${apiBase}/library/tag-cleanup/status`);
        setTagCleanupStatus(response.data);
        if (response.data.status === 'done' || response.data.status === 'error') {
          clearInterval(tagCleanupPollRef.current);
          tagCleanupPollRef.current = null;
          if (response.data.status === 'done') fetchTagCleanupFixed(0);
        }
      } catch (err) {
        clearInterval(tagCleanupPollRef.current);
        tagCleanupPollRef.current = null;
        console.error('Error polling tag cleanup status:', err);
      }
    }, 1500);
  };

  const startTagCleanup = async () => {
    try {
      const response = await axios.post(`${apiBase}/library/tag-cleanup`);
      setTagCleanupStatus(response.data);
      pollTagCleanup();
    } catch (err) {
      setTagCleanupStatus({ status: 'error', error: err.response?.data?.detail || 'Failed to start' });
      console.error('Error starting tag cleanup:', err);
    }
  };

  const fetchSpotifyPrewarmInfo = async () => {
    try {
      const [statusResponse, statsResponse] = await Promise.all([
        axios.get(`${apiBase}/spotify/prewarm/status`),
        axios.get(`${apiBase}/spotify/prewarm/stats`),
      ]);
      setSpotifyPrewarmStatus(statusResponse.data);
      setSpotifyPrewarmStats(statsResponse.data);
    } catch (err) {
      console.error('Error fetching Spotify pre-warm info:', err);
    }
  };

  const pollSpotifyPrewarm = () => {
    if (spotifyPrewarmPollRef.current) clearInterval(spotifyPrewarmPollRef.current);
    spotifyPrewarmPollRef.current = setInterval(fetchSpotifyPrewarmInfo, 5000);
  };

  const fetchTrackIdTracks = async (offset) => {
    try {
      const response = await axios.get(`${apiBase}/library/track-identification/tracks`, { params: { limit: 100, offset } });
      setTrackIdTotal(response.data.total);
      setTrackIdTracks((prev) => (offset === 0 ? response.data.tracks : [...prev, ...response.data.tracks]));
    } catch (err) {
      console.error('Error fetching identified tracks:', err);
    }
  };

  const fetchTrackIdInfo = async () => {
    try {
      const response = await axios.get(`${apiBase}/library/track-identification/stats`);
      setTrackIdStats(response.data);
    } catch (err) {
      console.error('Error fetching track identification stats:', err);
    }
  };

  const pollTrackId = () => {
    if (trackIdPollRef.current) clearInterval(trackIdPollRef.current);
    trackIdPollRef.current = setInterval(() => {
      fetchTrackIdInfo();
      fetchAlbumArtworkStats();
    }, 5000);
  };

  const fetchAlbumArtworkStats = async () => {
    try {
      const response = await axios.get(`${apiBase}/library/artwork/album-stats`);
      setAlbumArtworkStats(response.data);
    } catch (err) {
      console.error('Error fetching album artwork stats:', err);
    }
  };

  useEffect(() => {
    if (activeTab !== 'cleanup') return;
    if (subTab === 'duplicates' && duplicateGroups === null) fetchDuplicates();
    if (subTab === 'missing-tracks' && missingTracksAlbums === null) fetchMissingTracks();
    if (subTab === 'missing-artwork' || subTab === 'track-id') fetchAlbumArtworkStats();
    if (subTab === 'missing-artwork' && artworkCheckStatus === null) {
      axios.get(`${apiBase}/library/check-artwork/status`).then((response) => {
        setArtworkCheckStatus(response.data);
        if (response.data.status === 'running') {
          pollArtworkCheck();
        } else {
          // 'idle' just means no check job is running right now, not that
          // has_artwork has no data - show the current state either way.
          fetchMissingArtwork(0);
        }
      }).catch((err) => console.error('Error checking artwork-check status:', err));
    }
    if (subTab === 'missing-artwork' && externalArtworkStatus === null) {
      axios.get(`${apiBase}/library/external-artwork/status`).then((response) => {
        setExternalArtworkStatus(response.data);
        if (response.data.status === 'running' || response.data.status === 'waiting') pollExternalArtwork();
        fetchExternalArtworkFound(0);
      }).catch((err) => console.error('Error checking external artwork status:', err));
    }
    if (subTab === 'bad-tags' && tagCleanupStatus === null) {
      axios.get(`${apiBase}/library/tag-cleanup/status`).then((response) => {
        setTagCleanupStatus(response.data);
        if (response.data.status === 'running') pollTagCleanup();
        fetchTagCleanupFixed(0);
      }).catch((err) => console.error('Error checking tag cleanup status:', err));
    }
    if (subTab === 'spotify-matching') {
      fetchSpotifyPrewarmInfo();
      pollSpotifyPrewarm();
    } else if (spotifyPrewarmPollRef.current) {
      // Only worth polling while this subtab is actually visible - unlike
      // the other jobs here, the pre-warm job runs continuously in the
      // background regardless, so there's no "done" state to stop polling
      // for on its own.
      clearInterval(spotifyPrewarmPollRef.current);
      spotifyPrewarmPollRef.current = null;
    }
    if (subTab === 'track-id') {
      // Same "runs continuously regardless" shape as spotify-matching above -
      // isrc gets set by search_track's Shazam fallbacks, which run as part
      // of the same background pre-warm job (and any interactive match), not
      // a separately start/stoppable job of their own.
      fetchTrackIdInfo();
      if (trackIdTracks.length === 0) fetchTrackIdTracks(0);
      pollTrackId();
    } else if (trackIdPollRef.current) {
      clearInterval(trackIdPollRef.current);
      trackIdPollRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, subTab]);

  useEffect(() => () => {
    if (artworkPollRef.current) clearInterval(artworkPollRef.current);
    if (externalArtworkPollRef.current) clearInterval(externalArtworkPollRef.current);
    if (tagCleanupPollRef.current) clearInterval(tagCleanupPollRef.current);
    if (spotifyPrewarmPollRef.current) clearInterval(spotifyPrewarmPollRef.current);
    if (trackIdPollRef.current) clearInterval(trackIdPollRef.current);
  }, []);

  const bestTrack = (tracks) => tracks.reduce((best, t) => ((t.bitrate || 0) > (best.bitrate || 0) ? t : best), tracks[0]);

  return (
    <section className="cleanup-section">
      <div className="view-tabs cleanup-subtabs">
        <button className={subTab === 'duplicates' ? 'active' : ''} onClick={() => setSubTab('duplicates')}>Duplicates</button>
        <button className={subTab === 'missing-tracks' ? 'active' : ''} onClick={() => setSubTab('missing-tracks')}>Missing Tracks</button>
        <button className={subTab === 'missing-artwork' ? 'active' : ''} onClick={() => setSubTab('missing-artwork')}>Missing Artwork</button>
        <button className={subTab === 'bad-tags' ? 'active' : ''} onClick={() => setSubTab('bad-tags')}>Bad Tags</button>
        <button className={subTab === 'spotify-matching' ? 'active' : ''} onClick={() => setSubTab('spotify-matching')}>Spotify Matching</button>
        <button className={subTab === 'track-id' ? 'active' : ''} onClick={() => setSubTab('track-id')}>Track ID</button>
      </div>

      {subTab === 'duplicates' && (
        <div className="cleanup-panel">
          {duplicatesLoading ? (
            <p className="empty-state">Scanning for duplicates…</p>
          ) : !duplicateGroups || duplicateGroups.length === 0 ? (
            <p className="empty-state">{duplicateGroups ? 'No duplicates found.' : 'Loading…'}</p>
          ) : (
            <>
              <p className="cleanup-summary">
                {duplicateGroups.length.toLocaleString()} duplicate group{duplicateGroups.length === 1 ? '' : 's'} found
                {' '}({duplicateGroups.filter((g) => g.reason === 'exact').length} same title/artist, {duplicateGroups.filter((g) => g.reason === 'similar').length} similar spelling)
              </p>
              {duplicateGroups.slice(0, duplicatesShown).map((group, idx) => {
                const keeper = bestTrack(group.tracks);
                return (
                  <div key={idx} className="dup-group">
                    <div className="dup-group-header">
                      <span className={`dup-reason-badge ${group.reason}`}>
                        {group.reason === 'exact' ? 'Same title & artist' : 'Similar spelling'}
                      </span>
                      <span className="dup-group-count">{group.tracks.length} files</span>
                    </div>
                    {group.tracks.map((t) => (
                      <div key={t.id} className={`dup-track${t.id === keeper.id ? ' suggested-keep' : ''}`}>
                        <div className="track-thumb-wrap">
                          <span className="track-thumb-fallback">{t.track_name.charAt(0).toUpperCase()}</span>
                          <img
                            className="track-thumb"
                            src={`${apiBase}/tracks/${t.id}/artwork`}
                            alt=""
                            loading="lazy"
                            onError={(e) => { e.target.style.display = 'none'; }}
                          />
                        </div>
                        <div className="dup-track-info">
                          <span className="dup-track-title">{t.track_name}</span>
                          <span className="dup-track-artist">{t.artist_name}{t.album_name ? ` · ${t.album_name}` : ''}</span>
                        </div>
                        <div className="dup-track-meta">
                          {[
                            t.bitrate ? `${Math.round(t.bitrate / 1000)}kbps` : null,
                            t.duration_seconds ? formatDuration(t.duration_seconds) : null,
                            t.file_size_bytes ? formatFileSize(t.file_size_bytes) : null,
                          ].filter(Boolean).join(' · ')}
                          {t.id === keeper.id && <span className="keep-badge">Best quality</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })}
              {duplicatesShown < duplicateGroups.length && (
                <button className="load-more-btn" onClick={() => setDuplicatesShown((n) => n + 30)}>
                  Load more ({Math.min(duplicatesShown, duplicateGroups.length)} of {duplicateGroups.length})
                </button>
              )}
            </>
          )}
        </div>
      )}

      {subTab === 'missing-tracks' && (
        <div className="cleanup-panel">
          {missingTracksLoading ? (
            <p className="empty-state">Checking track numbers…</p>
          ) : !missingTracksAlbums || missingTracksAlbums.length === 0 ? (
            <p className="empty-state">
              {missingTracksAlbums ? 'No gaps or duplicate track numbers found.' : 'Loading…'}
            </p>
          ) : (
            <>
              <p className="cleanup-summary">
                {missingTracksAlbums.length.toLocaleString()} album{missingTracksAlbums.length === 1 ? '' : 's'} with missing or duplicate tracks
              </p>
              {missingTracksAlbums.map((album, idx) => (
                <div key={idx} className="missing-album-row">
                  {album.sample_track_id != null && (
                    <div className="track-thumb-wrap">
                      <span className="track-thumb-fallback">{album.album_name.charAt(0).toUpperCase()}</span>
                      <img
                        className="track-thumb"
                        src={`${apiBase}/tracks/${album.sample_track_id}/artwork`}
                        alt=""
                        loading="lazy"
                        onError={(e) => { e.target.style.display = 'none'; }}
                      />
                    </div>
                  )}
                  <div className="missing-album-info">
                    <span className="missing-album-title">{album.album_name}</span>
                    <span className="missing-album-artist">{album.artist_name}</span>
                  </div>
                  <div className="missing-album-gap">
                    {album.have_count} available
                    {album.missing_track_numbers.length > 0 && ` · ${album.missing_track_numbers.length} missing`}
                    {album.duplicate_track_numbers.length > 0 && ` · ${album.duplicate_track_numbers.length} duplicate${album.duplicate_track_numbers.length > 1 ? 's' : ''}`}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {subTab === 'missing-artwork' && (
        <div className="cleanup-panel">
          {albumArtworkStats && (
            <p className="scan-summary">
              {albumArtworkStats.albums_with_artwork.toLocaleString()} of{' '}
              {albumArtworkStats.total_albums.toLocaleString()} albums have artwork
              {albumArtworkStats.total_albums > 0
                ? ` (${Math.round((albumArtworkStats.albums_with_artwork / albumArtworkStats.total_albums) * 100)}%)`
                : ''}
            </p>
          )}
          <button
            className="scan-btn"
            onClick={startArtworkCheck}
            disabled={artworkCheckStatus?.status === 'running'}
          >
            {artworkCheckStatus?.status === 'running' ? 'Checking…' : 'Check Artwork'}
          </button>
          {artworkCheckStatus && artworkCheckStatus.status !== 'idle' && (
            <p className="scan-summary">
              {artworkCheckStatus.status === 'running'
                ? `Checking… ${(artworkCheckStatus.processed || 0).toLocaleString()} of ${(artworkCheckStatus.total || 0).toLocaleString()}`
                : artworkCheckStatus.status === 'done'
                  ? `Done — ${(artworkCheckStatus.found || 0).toLocaleString()} have artwork, ${(artworkCheckStatus.missing || 0).toLocaleString()} missing`
                  : artworkCheckStatus.status === 'error' ? `Error: ${artworkCheckStatus.error}` : ''}
            </p>
          )}
          <button
            className="scan-btn"
            onClick={startExternalArtwork}
            disabled={externalArtworkStatus?.status === 'running' || externalArtworkStatus?.status === 'waiting'}
          >
            {externalArtworkStatus?.status === 'running'
              ? 'Fetching…'
              : externalArtworkStatus?.status === 'waiting' ? 'Waiting on source…' : 'Fetch External Artwork'}
          </button>
          {externalArtworkStatus && externalArtworkStatus.status !== 'idle' && (
            <p className="scan-summary">
              {externalArtworkStatus.status === 'running'
                ? `Fetching (MusicBrainz/Cover Art Archive/iTunes)… ${(externalArtworkStatus.processed || 0).toLocaleString()} of ${(externalArtworkStatus.total || 0).toLocaleString()}`
                : externalArtworkStatus.status === 'waiting'
                  ? `Paused by a source's rate limit (${(externalArtworkStatus.processed || 0).toLocaleString()} of ${(externalArtworkStatus.total || 0).toLocaleString()} done so far) - resuming automatically around ${externalArtworkStatus.resume_at ? new Date(externalArtworkStatus.resume_at * 1000).toLocaleString() : 'later'}`
                  : externalArtworkStatus.status === 'done'
                    ? `Done — ${(externalArtworkStatus.found || 0).toLocaleString()} found, ${(externalArtworkStatus.still_missing || 0).toLocaleString()} still missing`
                    : externalArtworkStatus.status === 'error' ? `Error: ${externalArtworkStatus.error}` : ''}
            </p>
          )}
          {externalArtworkFoundTracks.length > 0 && (
            <>
              <div className="library-header">
                <h2>Found via External Sources</h2>
                <span className="library-count">{externalArtworkFoundTotal.toLocaleString()} tracks</span>
              </div>
              <div className="tracks-grid">
                {externalArtworkFoundTracks.map((track) => {
                  const isCurrent = nowPlaying && nowPlaying.id === track.id;
                  return (
                    <div key={track.id} className={`track-card${isCurrent ? ' playing' : ''}`}>
                      <button
                        className="play-btn"
                        onClick={() => onTrackPlayClick(track, externalArtworkFoundTracks)}
                        aria-label={isCurrent && isPlaying ? 'Pause' : 'Play'}
                      >
                        {isCurrent && isPlaying ? '❚❚' : '▶'}
                      </button>
                      <div className="track-thumb-wrap">
                        <span className="track-thumb-fallback">{track.track_name.charAt(0).toUpperCase()}</span>
                        <img className="track-thumb" src={`${apiBase}/tracks/${track.id}/artwork`} alt="" loading="lazy" onError={(e) => { e.target.style.display = 'none'; }} />
                      </div>
                      <div className="track-info">
                        <h3>{track.track_name}</h3>
                        <p className="artist">{track.artist_name}</p>
                      </div>
                      {track.artwork_source_url && (
                        <a className="source-link" href={track.artwork_source_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                          Source
                        </a>
                      )}
                    </div>
                  );
                })}
              </div>
              {externalArtworkFoundTracks.length < externalArtworkFoundTotal && (
                <button className="load-more-btn" onClick={() => fetchExternalArtworkFound(externalArtworkFoundTracks.length)}>
                  Load more ({externalArtworkFoundTracks.length.toLocaleString()} of {externalArtworkFoundTotal.toLocaleString()})
                </button>
              )}
            </>
          )}
          {missingArtworkTracks.length > 0 && (
            <>
              <div className="library-header">
                <h2>Missing Artwork</h2>
                <span className="library-count">{missingArtworkTotal.toLocaleString()} tracks</span>
              </div>
              <div className="tracks-grid">
                {missingArtworkTracks.map((track) => {
                  const isCurrent = nowPlaying && nowPlaying.id === track.id;
                  return (
                    <div key={track.id} className={`track-card${isCurrent ? ' playing' : ''}`}>
                      <button
                        className="play-btn"
                        onClick={() => onTrackPlayClick(track, missingArtworkTracks)}
                        aria-label={isCurrent && isPlaying ? 'Pause' : 'Play'}
                      >
                        {isCurrent && isPlaying ? '❚❚' : '▶'}
                      </button>
                      <div className="track-thumb-wrap">
                        <span className="track-thumb-fallback">{track.track_name.charAt(0).toUpperCase()}</span>
                      </div>
                      <div className="track-info">
                        <h3>{track.track_name}</h3>
                        <p className="artist">{track.artist_name}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
              {missingArtworkTracks.length < missingArtworkTotal && (
                <button className="load-more-btn" onClick={() => fetchMissingArtwork(missingArtworkTracks.length)}>
                  Load more ({missingArtworkTracks.length.toLocaleString()} of {missingArtworkTotal.toLocaleString()})
                </button>
              )}
            </>
          )}
        </div>
      )}

      {subTab === 'bad-tags' && (
        <div className="cleanup-panel">
          <p className="hint">
            Fixes tracks whose title/artist tags got mangled by whatever ripped or tagged them - a
            bogus artist (a track number, a truncated "Various..." compilation tag) with the real
            artist and title jammed together in the title field instead, and leftover leading track
            numbers ("17 - Song Title"). Only ever touches a row when it's confident, and keeps the
            original values so this is fully reversible. Tracks it actually changes also get a fresh
            shot at Spotify matching, since a bogus artist tag guaranteed a search miss before.
          </p>
          <button
            className="scan-btn"
            onClick={startTagCleanup}
            disabled={tagCleanupStatus?.status === 'running'}
          >
            {tagCleanupStatus?.status === 'running' ? 'Fixing…' : 'Fix Tags'}
          </button>
          {tagCleanupStatus && tagCleanupStatus.status !== 'idle' && (
            <p className="scan-summary">
              {tagCleanupStatus.status === 'running'
                ? `Checking… ${(tagCleanupStatus.processed || 0).toLocaleString()} of ${(tagCleanupStatus.total || 0).toLocaleString()}`
                : tagCleanupStatus.status === 'done'
                  ? `Done — ${(tagCleanupStatus.fixed || 0).toLocaleString()} fixed, ${(tagCleanupStatus.unrecoverable || 0).toLocaleString()} left as-is (no recoverable artist/title)`
                  : tagCleanupStatus.status === 'error' ? `Error: ${tagCleanupStatus.error}` : ''}
            </p>
          )}
          {tagCleanupFixedTracks.length > 0 && (
            <>
              <div className="library-header">
                <h2>Fixed Tags</h2>
                <span className="library-count">{tagCleanupFixedTotal.toLocaleString()} tracks</span>
              </div>
              {tagCleanupFixedTracks.map((track) => (
                <div key={track.id} className="dup-track">
                  <div className="track-thumb-wrap">
                    <span className="track-thumb-fallback">{track.track_name.charAt(0).toUpperCase()}</span>
                    <img
                      className="track-thumb"
                      src={`${apiBase}/tracks/${track.id}/artwork`}
                      alt=""
                      loading="lazy"
                      onError={(e) => { e.target.style.display = 'none'; }}
                    />
                  </div>
                  <div className="dup-track-info">
                    <span className="dup-track-title">
                      {track.original_track_name && track.original_track_name !== track.track_name && (
                        <span className="tag-cleanup-before">{track.original_track_name}</span>
                      )}
                      {track.track_name}
                    </span>
                    <span className="dup-track-artist">
                      {track.original_artist_name && track.original_artist_name !== track.artist_name && (
                        <span className="tag-cleanup-before">{track.original_artist_name}</span>
                      )}
                      {track.artist_name}
                    </span>
                  </div>
                </div>
              ))}
              {tagCleanupFixedTracks.length < tagCleanupFixedTotal && (
                <button className="load-more-btn" onClick={() => fetchTagCleanupFixed(tagCleanupFixedTracks.length)}>
                  Load more ({tagCleanupFixedTracks.length.toLocaleString()} of {tagCleanupFixedTotal.toLocaleString()})
                </button>
              )}
            </>
          )}
        </div>
      )}

      {subTab === 'spotify-matching' && (
        <div className="cleanup-panel">
          <p className="hint">
            A background job slowly searches the library against Spotify's catalog while the app is
            idle (a small batch every 90 seconds, so it never bursts into Spotify's search rate
            limit) - this just shows how far it's gotten. No button here since it just runs on its
            own; see the "Available on Spotify" filter in the Library tab to browse what's matched
            so far.
          </p>
          {spotifyPrewarmStats && (
            <p className="scan-summary">
              {(spotifyPrewarmStats.matched || 0).toLocaleString()} matched &middot;{' '}
              {(spotifyPrewarmStats.checked || 0).toLocaleString()} of {(spotifyPrewarmStats.total || 0).toLocaleString()} checked
              {spotifyPrewarmStats.total > 0
                ? ` (${Math.round((spotifyPrewarmStats.checked / spotifyPrewarmStats.total) * 100)}%)`
                : ''}
            </p>
          )}
          {spotifyPrewarmStatus && (
            <p className="hint">
              Status:{' '}
              {spotifyPrewarmStatus.status === 'running'
                ? 'running'
                : spotifyPrewarmStatus.status === 'waiting_active_use'
                  ? 'paused while the app is in use'
                  : spotifyPrewarmStatus.status === 'waiting_not_connected'
                    ? 'paused (Spotify not connected)'
                    : spotifyPrewarmStatus.status === 'done'
                      ? 'done — whole library checked'
                      : spotifyPrewarmStatus.status === 'error'
                        ? `error: ${spotifyPrewarmStatus.error}`
                        : spotifyPrewarmStatus.status}
            </p>
          )}
        </div>
      )}

      {subTab === 'track-id' && (
        <div className="cleanup-panel">
          {albumArtworkStats && (
            <p className="scan-summary">
              {albumArtworkStats.albums_with_artwork.toLocaleString()} of{' '}
              {albumArtworkStats.total_albums.toLocaleString()} albums have artwork
              {albumArtworkStats.total_albums > 0
                ? ` (${Math.round((albumArtworkStats.albums_with_artwork / albumArtworkStats.total_albums) * 100)}%)`
                : ''}
            </p>
          )}
          {trackIdStats && trackIdStats.identified > 0 && (() => {
            const renamed = trackIdStats.renamed || 0;
            const alreadyCorrect = trackIdStats.already_correct || 0;
            const maxVal = Math.max(renamed, alreadyCorrect, 1);
            return (
              <div className="stat-bar-chart">
                <div className="stat-bar-row">
                  <span className="stat-bar-label">Names Corrected</span>
                  <div className="stat-bar-track">
                    <div className="stat-bar-fill series-1" style={{ width: `${(renamed / maxVal) * 100}%` }} />
                  </div>
                  <span className="stat-bar-value">{renamed.toLocaleString()}</span>
                </div>
                <div className="stat-bar-row">
                  <span className="stat-bar-label">Already Correct</span>
                  <div className="stat-bar-track">
                    <div className="stat-bar-fill series-2" style={{ width: `${(alreadyCorrect / maxVal) * 100}%` }} />
                  </div>
                  <span className="stat-bar-value">{alreadyCorrect.toLocaleString()}</span>
                </div>
              </div>
            );
          })()}
          <p className="hint">
            Some tracks never match Spotify's search directly - a translated title, a garbled tag, or
            a bare placeholder like "Track 09" with nothing real to search for. As a fallback, the
            same background job also tries Shazam's own catalog (text search) and, for files with no
            usable tag text at all, its audio-fingerprint recognition on the actual file. Whenever
            Shazam identifies a track with confidence, the correct title/artist and a real ISRC get
            saved here - independent of whether Spotify itself ever confirms a match, since a correct
            name and ISRC are useful on their own. No button here either; it rides along on the same
            background job as Spotify Matching. The chart above breaks down how many identified
            tracks actually needed a name/artist fix vs. were already tagged correctly.
          </p>
          {trackIdStats && (
            <p className="scan-summary">
              {(trackIdStats.identified || 0).toLocaleString()} identified via Shazam of{' '}
              {(trackIdStats.total || 0).toLocaleString()} tracks
              {trackIdStats.total > 0
                ? ` (${Math.round((trackIdStats.identified / trackIdStats.total) * 100)}%)`
                : ''}
            </p>
          )}
          {trackIdTracks.length > 0 && (
            <>
              <div className="library-header">
                <h2>Identified Tracks</h2>
                <span className="library-count">{trackIdTotal.toLocaleString()} tracks</span>
              </div>
              {trackIdTracks.map((track) => (
                <div key={track.id} className="dup-track">
                  <div className="track-thumb-wrap">
                    <span className="track-thumb-fallback">{track.track_name.charAt(0).toUpperCase()}</span>
                    <img
                      className="track-thumb"
                      src={`${apiBase}/tracks/${track.id}/artwork`}
                      alt=""
                      loading="lazy"
                      onError={(e) => { e.target.style.display = 'none'; }}
                    />
                  </div>
                  <div className="dup-track-info">
                    <span className="dup-track-title">
                      {track.original_track_name && track.original_track_name !== track.track_name && (
                        <span className="tag-cleanup-before">{track.original_track_name}</span>
                      )}
                      {track.track_name}
                    </span>
                    <span className="dup-track-artist">
                      {track.original_artist_name && track.original_artist_name !== track.artist_name && (
                        <span className="tag-cleanup-before">{track.original_artist_name}</span>
                      )}
                      {track.artist_name}
                    </span>
                    <span className="dup-track-artist">
                      ISRC {track.isrc}
                      {track.spotify_track_id
                        ? ' · matched on Spotify'
                        : track.spotify_checked
                          ? ' · not on Spotify'
                          : ' · Spotify not checked yet'}
                    </span>
                  </div>
                </div>
              ))}
              {trackIdTracks.length < trackIdTotal && (
                <button className="load-more-btn" onClick={() => fetchTrackIdTracks(trackIdTracks.length)}>
                  Load more ({trackIdTracks.length.toLocaleString()} of {trackIdTotal.toLocaleString()})
                </button>
              )}
            </>
          )}
        </div>
      )}

    </section>
  );
}

export default App;
