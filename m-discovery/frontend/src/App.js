import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import './App.css';

const LIBRARY_PAGE_SIZE = 100;
const GROUP_QUEUE_LIMIT = 500;
const VIEW_MODES = ['all', 'album', 'genre', 'decade', 'quality', 'format', 'favorite', 'length', 'playlist'];
const BACK_LABELS = {
  album: 'Albums', genre: 'Genres', decade: 'Decades',
  quality: 'Quality Tiers', format: 'Formats', favorite: 'Favorites', length: 'Lengths',
  playlist: 'Playlists',
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

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
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
const IconSpeaker = (props) => (
  <svg viewBox="0 0 24 24" width="1em" height="1em" {...props}>
    <polygon points="11,5 6,9 2,9 2,15 6,15 11,19" fill="currentColor" />
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <path d="M18.07 5.93a9 9 0 0 1 0 12.14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
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

function App() {
  const [discoveredTracks, setDiscoveredTracks] = useState([]);

  const [seedTracks, setSeedTracks] = useState('');
  const [genre, setGenre] = useState('');
  const [mood, setMood] = useState('');
  const [tempo, setTempo] = useState('');
  const [complexity, setComplexity] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState(() => loadLibraryView()?.activeTab ?? 'library');
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
  // Briefly shown when a track's source (local vs. Spotify) doesn't match
  // the current output destination - null when hidden, a message when shown.
  const [spotifyPlayHint, setSpotifyPlayHint] = useState(null);
  // True when the currently-drilled Spotify playlist's tracks came back 403 -
  // Spotify blocks reading the track listing of a playlist you don't own,
  // even public/followed ones, though playing it via context_uri still works.
  const [playlistTracksRestricted, setPlaylistTracksRestricted] = useState(false);
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
  const [genreOptions, setGenreOptions] = useState([]);
  const [decadeOptions, setDecadeOptions] = useState([]);
  const [qualityOptions, setQualityOptions] = useState([]);
  const [formatOptions, setFormatOptions] = useState([]);
  const [groups, setGroups] = useState([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [libraryTracks, setLibraryTracks] = useState([]);
  const [libraryTotal, setLibraryTotal] = useState(0);
  const [libraryLoading, setLibraryLoading] = useState(false);
  // "Shuffle All" toggle: while on, the flat library list itself is fetched
  // and displayed in the same shuffled order that got queued for playback,
  // instead of the default alphabetical browse order.
  const [libraryShuffleOn, setLibraryShuffleOn] = useState(() => loadLibraryView()?.libraryShuffleOn ?? false);
  // Tracks the last filter/mode/drill/search combo the library-fetch effect
  // below actually fetched for, so it can tell "a filter genuinely changed"
  // apart from "activeTab just flipped back to library" - see that effect.
  const libraryFetchKeyRef = useRef(null);
  // True only when libraryShuffleOn was restored from a prior session (not a
  // fresh toggle click) - the very first fetch after a reload should show
  // the deterministic list, not roll a brand-new random order that's
  // immediately disconnected from whatever's actually still playing
  // (confirmed live: refreshing mid-shuffle produced a completely different
  // track list every single time, since "shuffle" always re-randomizes from
  // scratch and only the on/off *preference* was ever persisted, never a
  // specific order).
  const skipInitialShuffleFetchRef = useRef(loadLibraryView()?.libraryShuffleOn === true);
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
  const outputDevices = [...wiimDevices, ...chromecastDevices, ...spotifyDevices];
  const [outputDevice, setOutputDevice] = useState(() => loadSession()?.outputDevice || null);
  const [destStatus, setDestStatus] = useState(null);
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

  const refreshSpotifyStatus = () => {
    axios.get(`${API_BASE_URL}/spotify/auth/status`)
      .then((r) => {
        setSpotifyConnected(r.data.connected);
        if (r.data.connected) {
          axios.get(`${API_BASE_URL}/spotify/devices`)
            .then((dr) => setSpotifyDevices(dr.data.map((d) => ({ ...d, type: 'spotify' }))))
            .catch((err) => console.error('Error fetching Spotify devices:', err));
        } else {
          setSpotifyDevices([]);
        }
      })
      .catch((err) => console.error('Error fetching Spotify auth status:', err));
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
        // track came from a local-library match (mapMatchedLocalTrack sets
        // local_id), fall back to playing the original local file there
        // instead of leaving the new destination silent - a genuine Spotify
        // playlist track has no local equivalent, so there's nothing to do.
        if (nowPlaying.local_id != null) {
          const payload = { track_id: nowPlaying.local_id };
          const isChromecast = outputDevice.type === 'chromecast';
          if (isChromecast) {
            payload.queue_track_ids = queue.filter((t) => t.local_id != null).slice(0, CHROMECAST_QUEUE_WINDOW).map((t) => t.local_id);
          }
          axios.post(`${deviceEndpoint(outputDevice)}/play`, payload)
            .then(() => { if (isChromecast) chromecastQueueLoadedRef.current = true; })
            .catch((err) => console.error('Error casting to device:', err));
        }
        return;
      }
      const endpoint = nowPlaying.context_uri ? 'play' : 'play-uris';
      // For an ad-hoc (non-playlist) queue, hand Spotify the *whole* matched
      // queue in this one call, not just the current track - that's what
      // gives Spotify a real queue to advance through, so Next/Prev work
      // both via our /next//previous proxy and natively in the Spotify app.
      const payload = nowPlaying.context_uri
        ? { context_uri: nowPlaying.context_uri, track_uri: nowPlaying.uri }
        : { uris: [nowPlaying.uri, ...queue.slice(0, SPOTIFY_PLAY_QUEUE_LIMIT).map((t) => t.uri)] };
      axios.post(`${deviceEndpoint(outputDevice)}/${endpoint}`, payload)
        .catch((err) => console.error('Error casting to Spotify device:', err));
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
    const payload = { track_id: nowPlaying.id };
    const isChromecast = outputDevice.type === 'chromecast';
    if (isChromecast) {
      payload.queue_track_ids = queue.slice(0, CHROMECAST_QUEUE_WINDOW).map((t) => t.id);
    }
    axios.post(`${deviceEndpoint(outputDevice)}/play`, payload)
      .then(() => {
        if (isChromecast) chromecastQueueLoadedRef.current = true;
      })
      .catch((err) => console.error('Error casting to device:', err));
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
      libraryShuffleOn,
    });
  }, [activeTab, libraryMode, drill, search, filterGenre, filterDecade, filterQuality, filterFormat, filterSpotifyAvailable, libraryShuffleOn]);

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

  useEffect(() => {
    if (!spotifyPlayHint) return;
    const t = setTimeout(() => setSpotifyPlayHint(null), 4000);
    return () => clearTimeout(t);
  }, [spotifyPlayHint]);

  // Marks a track as "played this session" the moment it becomes nowPlaying,
  // for any destination. A local track matched to Spotify (see
  // mapMatchedLocalTrack) carries local_id alongside its Spotify uri id, so
  // the checkmark lands on the *local* track shown in the Library tab, not
  // an id nothing in that view will ever match.
  useEffect(() => {
    if (!nowPlaying) return;
    const playedId = nowPlaying.local_id ?? nowPlaying.id;
    setPlayedTrackIds((prev) => (prev.has(playedId) ? prev : new Set(prev).add(playedId)));
  }, [nowPlaying]);

  useEffect(() => {
    if (activeTab !== 'library') return;
    // activeTab has to be a dependency so this runs on first arrival at the
    // tab, but that means it *also* re-fires on every later re-arrival (e.g.
    // Cleanup and back) even though nothing filter-related changed - which
    // used to re-shuffle the displayed order every time, decoupling it from
    // whatever's actually playing (confirmed live: navigating away and back
    // reshuffled the list while playback stayed on the original order).
    // Skip the refetch when only activeTab changed - re-entering the tab
    // should show whatever was already there, not roll a new order.
    const key = JSON.stringify([libraryMode, drill, search, filterGenre, filterDecade, filterQuality, filterFormat, filterSpotifyAvailable]);
    if (key === libraryFetchKeyRef.current) return;
    libraryFetchKeyRef.current = key;
    const skipInitialShuffleFetch = skipInitialShuffleFetchRef.current;
    skipInitialShuffleFetchRef.current = false;
    // Spotify playlists aren't in known_tracks - can't reuse the SQL-backed
    // /api/tracks/known / /api/library/groups fetches below at all.
    if (libraryMode === 'playlist') {
      if (drill) fetchSpotifyPlaylistTracks(drill.key); else fetchSpotifyPlaylistsAsGroups();
      return;
    }
    if (drill || libraryMode === 'all') {
      // If Shuffle All is already on, a filter change re-shuffles the new
      // matching set rather than silently reverting to alphabetical order.
      // The Shuffle All toggle itself is handled directly in its own click
      // handler (not here), so it isn't a dependency of this effect. Except
      // right after a reload restored libraryShuffleOn=true - that first
      // fetch restores the exact persisted shuffle order instead of rolling
      // a fresh one, so it matches whatever's still playing.
      if (libraryShuffleOn && skipInitialShuffleFetch) {
        const persistedIds = loadShuffledIds();
        if (persistedIds && persistedIds.length) fetchLibraryTracksByIds(persistedIds);
        else fetchLibraryTracksShuffled();
      } else if (libraryShuffleOn) {
        fetchLibraryTracksShuffled();
      } else {
        fetchLibraryTracks(0);
      }
    } else {
      fetchGroups();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, libraryMode, drill, search, filterGenre, filterDecade, filterQuality, filterFormat, filterSpotifyAvailable]);

  useEffect(() => {
    if (activeTab !== 'library') return;
    if (genreOptions.length === 0) {
      axios.get(`${API_BASE_URL}/library/groups`, { params: { by: 'genre' } })
        .then((r) => setGenreOptions(r.data))
        .catch((err) => console.error('Error fetching genres:', err));
    }
    if (decadeOptions.length === 0) {
      axios.get(`${API_BASE_URL}/library/groups`, { params: { by: 'decade' } })
        .then((r) => setDecadeOptions(r.data))
        .catch((err) => console.error('Error fetching decades:', err));
    }
    if (qualityOptions.length === 0) {
      axios.get(`${API_BASE_URL}/library/groups`, { params: { by: 'quality' } })
        .then((r) => setQualityOptions(r.data))
        .catch((err) => console.error('Error fetching quality tiers:', err));
    }
    if (formatOptions.length === 0) {
      axios.get(`${API_BASE_URL}/library/groups`, { params: { by: 'format' } })
        .then((r) => setFormatOptions(r.data))
        .catch((err) => console.error('Error fetching formats:', err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // The genre/decade/quality/format filters stay active no matter which
  // browse-by view or drill-down you're in; a drill-down's own dimension
  // (e.g. drilling into a specific genre) takes precedence over the ambient
  // filter for that same dimension.
  const buildAmbientFilterParams = () => {
    const params = {};
    if (filterGenre) params.genre = filterGenre;
    if (filterDecade) params.decade = Number(filterDecade);
    if (filterQuality) params.quality = filterQuality;
    if (filterFormat) params.format = filterFormat;
    if (filterSpotifyAvailable) params.spotify_available = true;
    return params;
  };

  // 'best' is the default quality filter (dedup to the best copy of each
  // track), not a user-applied filter, so it doesn't count as "active".
  const hasActiveFilters = !!(filterGenre || filterDecade || (filterQuality && filterQuality !== 'best') || filterFormat || filterSpotifyAvailable);

  const clearFilters = () => {
    setFilterGenre('');
    setFilterDecade('');
    setFilterQuality('best');
    setFilterFormat('');
    setFilterSpotifyAvailable(false);
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
      const params = { ...buildTrackFilterParams(), limit: LIBRARY_PAGE_SIZE, offset };
      const response = await axios.get(`${API_BASE_URL}/tracks/known`, { params });
      setLibraryTotal(response.data.total);
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
      const tracks = await fetchAllMatchingShuffled(buildTrackFilterParams());
      setLibraryTotal(tracks.length);
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
    } catch (err) {
      if (err.response?.status === 403) {
        setPlaylistTracksRestricted(true);
      } else {
        console.error('Error fetching Spotify playlist tracks:', err);
      }
      setLibraryTracks([]);
      setLibraryTotal(0);
    } finally {
      setLibraryLoading(false);
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

  const handleDiscoverMusic = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setDiscoveredTracks([]);
    try {
      const response = await axios.post(`${API_BASE_URL}/discover`, {
        seed_tracks: seedTracks,
        genre: genre || null,
        mood: mood || null,
        tempo: tempo ? parseInt(tempo) : null,
        complexity: complexity || null,
        exclude_known: true,
      });
      setDiscoveredTracks(response.data);
    } catch (err) {
      setError('Failed to discover music. Please try again.');
      console.error('Error discovering music:', err);
    } finally {
      setLoading(false);
    }
  };

  const startQueue = (tracks, { shuffle = false } = {}) => {
    if (!tracks || tracks.length === 0) return;
    // Central guard for every "Play All"/"Shuffle" entry point (library flat
    // view, album/genre/etc. groups, playlist tracks, single-track clicks) -
    // a local-track queue against a Spotify destination (or vice versa) would
    // otherwise silently fail to cast while leaving the destination's status
    // poll to overwrite nowPlaying with whatever Spotify's device already
    // happens to be playing, which looks like "the wrong song is playing."
    const isSpotifyTracks = tracks[0]?.source === 'spotify';
    if (isSpotifyTracks && outputDevice?.type !== 'spotify') {
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
            if (nowPlaying.local_id != null) {
              const localPayload = { track_id: nowPlaying.local_id };
              const isChromecast = outputDevice.type === 'chromecast';
              if (isChromecast) {
                localPayload.queue_track_ids = queue.filter((t) => t.local_id != null).slice(0, CHROMECAST_QUEUE_WINDOW).map((t) => t.local_id);
              }
              axios.post(`${deviceEndpoint(outputDevice)}/play`, localPayload)
                .then(() => { if (isChromecast) chromecastQueueLoadedRef.current = true; })
                .catch((err) => console.error('Error casting to device:', err));
            }
            return;
          }
          const endpoint = nowPlaying.context_uri ? 'play' : 'play-uris';
          const spotifyPayload = nowPlaying.context_uri
            ? { context_uri: nowPlaying.context_uri, track_uri: nowPlaying.uri }
            : { uris: [nowPlaying.uri, ...queue.slice(0, SPOTIFY_PLAY_QUEUE_LIMIT).map((t) => t.uri)] };
          axios.post(`${deviceEndpoint(outputDevice)}/${endpoint}`, spotifyPayload)
            .catch((err) => console.error('Error casting to Spotify device:', err));
          return;
        }
        if (outputDevice.type === 'spotify') {
          matchAndPlayLocalTracksOnSpotify([nowPlaying, ...queue]);
          return;
        }
        const payload = { track_id: nowPlaying.id };
        const isChromecast = outputDevice.type === 'chromecast';
        if (isChromecast) {
          payload.queue_track_ids = queue.slice(0, CHROMECAST_QUEUE_WINDOW).map((t) => t.id);
        }
        axios.post(`${deviceEndpoint(outputDevice)}/play`, payload)
          .then(() => {
            if (isChromecast) chromecastQueueLoadedRef.current = true;
          })
          .catch((err) => console.error('Error casting to device:', err));
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

  const handleTrackPlayClick = (track, list) => {
    if (nowPlaying && nowPlaying.id === track.id) {
      togglePlay();
      return;
    }
    // Spotify tracks stream from Spotify's own servers to a Spotify Connect
    // device - there's no local file to hand to WiiM/Chromecast/this browser,
    // and the reverse (a local file to Spotify Connect) doesn't work either.
    if (track.source === 'spotify' && outputDevice?.type !== 'spotify') {
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
    // nowPlaying.id is a Spotify uri for a locally-matched track (see
    // mapMatchedLocalTrack), not the local id this card is keyed by - bridge
    // via local_id so "currently playing" still highlights the right card.
    const nowPlayingId = nowPlaying && (nowPlaying.local_id ?? nowPlaying.id);
    const isCurrent = nowPlayingId === track.id;
    const isCardPlaying = isCurrent && effectiveIsPlaying;
    const isMatching = matchingTrackId === track.id;
    const hasPlayed = !isCurrent && playedTrackIds.has(track.id);
    const wasSkipped = !isCurrent && !hasPlayed && skippedTrackIds.has(track.id);
    const playIcon = isMatching ? '⏳' : isCardPlaying ? '❚❚' : '▶';
    const statusBadge = hasPlayed ? (
      <span className="track-status-badge played" title="Already played this session">✓</span>
    ) : wasSkipped ? (
      <span className="track-status-badge skipped" title="No Spotify match found - skipped">✕</span>
    ) : null;
    const thumb = (
      <div className="track-thumb-wrap">
        <span className="track-thumb-fallback">{track.track_name.charAt(0).toUpperCase()}</span>
        <img
          className="track-thumb"
          src={track.artwork_url || `${API_BASE_URL}/tracks/${track.id}/artwork`}
          alt=""
          loading="lazy"
          onError={(e) => { e.target.style.display = 'none'; }}
        />
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
        {thumb}
        <div className="track-info">
          <h3>{track.track_name}</h3>
          <p className="artist">{track.artist_name}</p>
        </div>
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
          .catch((err) => console.error('Error advancing Spotify playback:', err));
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
          .catch((err) => console.error('Error reversing Spotify playback:', err));
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
  const fetchAllMatchingShuffled = async (params) => {
    const countResponse = await axios.get(`${API_BASE_URL}/tracks/known`, { params: { ...params, limit: 1, offset: 0 } });
    const total = countResponse.data.total;
    if (total === 0) return [];
    const fullResponse = await axios.get(`${API_BASE_URL}/tracks/known`, {
      params: { ...params, limit: total, offset: 0, shuffle: true },
    });
    return fullResponse.data.tracks;
  };

  const playGroup = async (group, { shuffle = false } = {}) => {
    if (group.by === 'playlist') {
      if (outputDevice?.type !== 'spotify') {
        setSpotifyPlayHint('Select a Spotify Connect device (destination picker) to play Spotify playlists.');
        return;
      }
      try {
        const response = await axios.get(`${API_BASE_URL}/spotify/playlists/${group.key}/tracks`);
        const tracks = response.data.map((t) => mapSpotifyTrack(t));
        startQueue(tracks, { shuffle });
      } catch (err) {
        if (err.response?.status === 403) {
          playSpotifyContextDirectly(`spotify:playlist:${group.key}`);
        } else {
          console.error('Error queuing Spotify playlist playback:', err);
        }
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

  // Shuffle All toggle for the flat library list: turning it on both re-shows
  // the list in the same shuffled order that gets queued and starts playing
  // it; turning it off just reverts the list to its default alphabetical
  // order (doesn't touch whatever's already playing).
  const toggleLibraryShuffle = async () => {
    if (libraryShuffleOn) {
      setLibraryShuffleOn(false);
      fetchLibraryTracks(0);
      return;
    }
    setLibraryShuffleOn(true);
    const tracks = await fetchLibraryTracksShuffled();
    if (tracks.length === 0) return;
    if (outputDevice?.type === 'spotify') {
      matchAndPlayLocalTracksOnSpotify(tracks);
    } else {
      startQueue(tracks);
    }
  };

  const viewLabel = (mode) => {
    if (mode === 'all') return 'All Tracks';
    if (mode === 'playlist') return 'Playlists';
    return `By ${mode.charAt(0).toUpperCase()}${mode.slice(1)}`;
  };
  const backLabel = drill && BACK_LABELS[drill.by];
  const effectiveIsPlaying = outputDevice ? destStatus?.status === 'play' : isPlaying;

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
            onClick={() => setActiveTab('library')}
          >
            My Library
          </button>
          <button
            className={activeTab === 'discover' ? 'active' : ''}
            onClick={() => setActiveTab('discover')}
          >
            Discover
          </button>
          <button
            className={activeTab === 'taste' ? 'active' : ''}
            onClick={() => setActiveTab('taste')}
          >
            Taste Profile
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
        {activeTab === 'discover' ? (
          <section className="discover-section">
            <form onSubmit={handleDiscoverMusic} className="discovery-form">
              <div className="form-row">
                <div className="form-group full">
                  <label>Seed Tracks (artists, songs, or genres)</label>
                  <input
                    type="text"
                    value={seedTracks}
                    onChange={(e) => setSeedTracks(e.target.value)}
                    placeholder="e.g., Metallica, Iron Maiden, Black Sabbath"
                    required
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Genre</label>
                  <select value={genre} onChange={(e) => setGenre(e.target.value)}>
                    <option value="">Any Genre</option>
                    <option value="rock">Rock</option>
                    <option value="metal">Metal</option>
                    <option value="electronic">Electronic</option>
                    <option value="jazz">Jazz</option>
                    <option value="classical">Classical</option>
                    <option value="hip-hop">Hip-Hop</option>
                    <option value="pop">Pop</option>
                    <option value="indie">Indie</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Mood</label>
                  <select value={mood} onChange={(e) => setMood(e.target.value)}>
                    <option value="">Any Mood</option>
                    <option value="energetic">Energetic</option>
                    <option value="melancholic">Melancholic</option>
                    <option value="uplifting">Uplifting</option>
                    <option value="dark">Dark</option>
                    <option value="calm">Calm</option>
                    <option value="aggressive">Aggressive</option>
                  </select>
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Tempo (BPM)</label>
                  <input
                    type="number"
                    value={tempo}
                    onChange={(e) => setTempo(e.target.value)}
                    placeholder="120"
                  />
                </div>
                <div className="form-group">
                  <label>Complexity</label>
                  <select value={complexity} onChange={(e) => setComplexity(e.target.value)}>
                    <option value="">Any</option>
                    <option value="simple">Simple</option>
                    <option value="moderate">Moderate</option>
                    <option value="complex">Complex</option>
                  </select>
                </div>
              </div>

              <button type="submit" disabled={loading} className="discover-btn">
                {loading ? 'Finding tracks...' : 'Discover'}
              </button>

              {error && <p className="error-message">{error}</p>}
            </form>

            {discoveredTracks.length > 0 && (
              <div className="results">
                <h2>Recommended Tracks</h2>
                <div className="tracks-grid">
                  {discoveredTracks.map((track, index) => (
                    <div key={index} className="track-card">
                      <div className="track-number">{index + 1}</div>
                      <div className="track-info">
                        <h3>{track.track_name}</h3>
                        <p className="artist">{track.artist_name}</p>
                        <p className="album">{track.album_name}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        ) : activeTab === 'library' ? (
          <section className="library-section">
            {spotifyPlayHint && (
              <p className="empty-state spotify-play-hint">{spotifyPlayHint}</p>
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
                {hasActiveFilters && (
                  <button className="clear-filters-btn" onClick={clearFilters}>Clear Filters</button>
                )}
              </div>
            </div>

            {drill && (
              <div className="drill-header">
                <button className="back-btn" onClick={() => setDrill(null)}>&larr; Back to {backLabel}</button>
                <h2>{drill.label}</h2>
                <div className="group-actions">
                  <button className="group-action-btn" onClick={() => playGroup(drill)}>&#9654; Play All</button>
                  <button className="group-action-btn" onClick={() => playGroup(drill, { shuffle: true })}>&#128256; Shuffle</button>
                </div>
              </div>
            )}

            {drill || libraryMode === 'all' ? (
              <>
                <div className="library-header">
                  <h2>{drill ? '' : `Playing on: ${outputDevice ? outputDevice.name : 'This Browser'}`}</h2>
                  {!drill && libraryTracks.length > 0 && (
                    <div className="group-actions">
                      <button className="group-action-btn" onClick={() => playCurrentFilter()}>&#9654; Play All</button>
                      <button
                        className={`group-action-btn${libraryShuffleOn ? ' active' : ''}`}
                        onClick={toggleLibraryShuffle}
                      >
                        &#128256; Shuffle All
                      </button>
                    </div>
                  )}
                  <span className="library-count">{libraryTotal.toLocaleString()} tracks</span>
                </div>
                {libraryTracks.length === 0 ? (
                  <p className="empty-state">
                    {libraryLoading
                      ? 'Loading…'
                      : playlistTracksRestricted
                        ? "Spotify doesn't allow browsing individual tracks in a playlist you don't own — use Play All / Shuffle above to play the whole playlist."
                        : drill?.by === 'playlist'
                          ? 'This playlist has no tracks.'
                          : 'No tracks found. Open Settings to scan a library folder.'}
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
                ) : libraryMode === 'playlist' && !spotifyConnected ? (
                  <p className="empty-state">Connect Spotify in Settings to browse your playlists.</p>
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
        destStatus={destStatus}
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

function SettingsPanel({ onClose, rootPath, setRootPath, scanning, scanResult, scanError, onScan, outputDevices, apiBase, spotifyConnected, onSpotifyDisconnect }) {
  const [prewarmStatus, setPrewarmStatus] = useState(null);

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
      </div>
    </div>
  );
}

function PlayerBar({
  track, queue, isPlaying, hasNext, hasPrev, onNext, onPrev, onTogglePlay, setIsPlaying, audioRef, apiBase,
  outputDevices, outputDevice, setOutputDevice, destStatus,
  shuffleEnabled, onToggleShuffle, onSeek, onJumpToQueueItem,
  userHasInteracted, initialSeekMs, onInitialSeekApplied,
}) {
  const [expanded, setExpanded] = useState(false);
  const [artistInfo, setArtistInfo] = useState(null);
  const [bioExpanded, setBioExpanded] = useState(false);
  const [destMenuOpen, setDestMenuOpen] = useState(false);
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
  const deviceIcon = (d) => (d.type === 'chromecast' ? '📺' : d.type === 'spotify' ? '🟢' : '📡');
  const trackArtworkUrl = (t) => t.artwork_url || `${apiBase}/tracks/${t.id}/artwork`;
  // track.id is a Spotify uri (not a real local track id) whenever the
  // current track is Spotify-sourced - "This Browser" can only ever stream a
  // real local file, so it needs the *local* id. local_id bridges that for a
  // track that started life as a local-library match (mapMatchedLocalTrack);
  // a genuine Spotify playlist/context track (no local_id) has no local file
  // to fall back to at all - nothing this browser can play.
  const localStreamId = track.source === 'spotify' ? (track.local_id ?? null) : track.id;

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
                    onClick={() => setDestMenuOpen((o) => !o)}
                    aria-label="Playback destination"
                    title={`Playing on ${destinationLabel}`}
                  >
                    <IconSpeaker />
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
          </div>
          {techParts.length > 0 && <p className="player-tech">{techParts.join(' · ')}</p>}
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
          <div className="np-destination">
            <button
              className={`player-btn${outputDevice ? ' active' : ''}`}
              onClick={() => setDestMenuOpen((o) => !o)}
              aria-label="Playback destination"
              title={`Playing on ${destinationLabel}`}
            >
              <IconSpeaker />
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
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {!outputDevice && (localStreamId != null ? (
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
          <p className="player-no-local-file">This track is only on Spotify - select a Spotify Connect device to play it.</p>
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
          if (response.data.status === 'done') fetchMissingArtwork(0);
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

  useEffect(() => {
    if (activeTab !== 'cleanup') return;
    if (subTab === 'duplicates' && duplicateGroups === null) fetchDuplicates();
    if (subTab === 'missing-tracks' && missingTracksAlbums === null) fetchMissingTracks();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, subTab]);

  useEffect(() => () => {
    if (artworkPollRef.current) clearInterval(artworkPollRef.current);
    if (externalArtworkPollRef.current) clearInterval(externalArtworkPollRef.current);
    if (tagCleanupPollRef.current) clearInterval(tagCleanupPollRef.current);
    if (spotifyPrewarmPollRef.current) clearInterval(spotifyPrewarmPollRef.current);
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
            idle (about one track every 5 minutes, so it never bursts into Spotify's search rate
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

    </section>
  );
}

export default App;
