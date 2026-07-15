import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import './App.css';

const LIBRARY_PAGE_SIZE = 100;
const GROUP_QUEUE_LIMIT = 500;
const VIEW_MODES = ['all', 'album', 'genre', 'decade'];

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
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
  const [activeTab, setActiveTab] = useState('discover');

  const [rootPath, setRootPath] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState(null);
  const [scanError, setScanError] = useState(null);
  const [stats, setStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const pollRef = useRef(null);

  // Library browsing: flat search/filter or grouped-by-album/genre/decade with drill-down
  const [libraryMode, setLibraryMode] = useState('all');
  const [drill, setDrill] = useState(null); // { by, key, label } once a group is opened
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [filterGenre, setFilterGenre] = useState('');
  const [filterDecade, setFilterDecade] = useState('');
  const [genreOptions, setGenreOptions] = useState([]);
  const [decadeOptions, setDecadeOptions] = useState([]);
  const [groups, setGroups] = useState([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [libraryTracks, setLibraryTracks] = useState([]);
  const [libraryTotal, setLibraryTotal] = useState(0);
  const [libraryLoading, setLibraryLoading] = useState(false);

  // Playback
  const [queue, setQueue] = useState([]);
  const [history, setHistory] = useState([]);
  const [nowPlaying, setNowPlaying] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef(null);

  // Output routing: null = play in this browser, otherwise cast to a WiiM device
  const [wiimDevices, setWiimDevices] = useState([]);
  const [outputDevice, setOutputDevice] = useState(null);
  const [wiimStatus, setWiimStatus] = useState(null);
  const prevOutputDeviceRef = useRef(null);
  const wiimAdvancingRef = useRef(false);

  const API_BASE_URL = process.env.REACT_APP_API_URL || '/api';

  useEffect(() => {
    resumeScanIfRunning();
    axios.get(`${API_BASE_URL}/wiim/devices`)
      .then((r) => setWiimDevices(r.data))
      .catch((err) => console.error('Error fetching WiiM devices:', err));
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cast the current track to the selected WiiM device whenever it changes.
  useEffect(() => {
    if (!outputDevice || !nowPlaying) return;
    axios.post(`${API_BASE_URL}/wiim/devices/${outputDevice.id}/play`, { track_id: nowPlaying.id })
      .catch((err) => console.error('Error casting to WiiM:', err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outputDevice, nowPlaying]);

  // Stop the previous device when switching output (to a different device, or back to the browser).
  useEffect(() => {
    const prev = prevOutputDeviceRef.current;
    if (prev && prev.id !== outputDevice?.id) {
      axios.post(`${API_BASE_URL}/wiim/devices/${prev.id}/stop`).catch(() => {});
    }
    prevOutputDeviceRef.current = outputDevice;
    setWiimStatus(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outputDevice]);

  useEffect(() => {
    wiimAdvancingRef.current = false;
  }, [nowPlaying]);

  // Poll the device's real playback position so the UI reflects reality and we
  // can auto-advance the queue near end-of-track (there's no "onEnded" event to
  // hook into like the local <audio> element has).
  useEffect(() => {
    if (!outputDevice || !nowPlaying) return;
    const interval = setInterval(async () => {
      try {
        const response = await axios.get(`${API_BASE_URL}/wiim/devices/${outputDevice.id}/status`);
        setWiimStatus(response.data);
        const { reachable, status: playState, duration_ms: duration, position_ms: position } = response.data;
        if (
          reachable && playState === 'play' && duration > 0 &&
          duration - position < 1500 && !wiimAdvancingRef.current
        ) {
          wiimAdvancingRef.current = true;
          handleNext();
        }
      } catch (err) {
        console.error('Error polling WiiM status:', err);
      }
    }, 2000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outputDevice, nowPlaying]);

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
    if (activeTab !== 'library') return;
    if (drill || libraryMode === 'all') {
      fetchLibraryTracks(0);
    } else {
      fetchGroups();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, libraryMode, drill, search, filterGenre, filterDecade]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  const buildTrackFilterParams = () => {
    const params = {};
    if (search) params.search = search;
    if (drill) {
      if (drill.by === 'genre') params.genre = drill.key;
      else if (drill.by === 'decade') params.decade = Number(drill.key);
      else if (drill.by === 'album') {
        const [artist, album] = drill.key.split('||');
        params.artist = artist;
        params.album = album;
      }
    } else if (libraryMode === 'all') {
      if (filterGenre) params.genre = filterGenre;
      if (filterDecade) params.decade = Number(filterDecade);
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

  const fetchGroups = async () => {
    setGroupsLoading(true);
    try {
      const params = { by: libraryMode };
      if (search) params.search = search;
      const response = await axios.get(`${API_BASE_URL}/library/groups`, { params });
      setGroups(response.data);
    } catch (err) {
      console.error('Error fetching groups:', err);
    } finally {
      setGroupsLoading(false);
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
    const ordered = shuffle ? shuffleArray(tracks) : tracks;
    setHistory([]);
    setNowPlaying(ordered[0]);
    setQueue(ordered.slice(1));
    setIsPlaying(true);
  };

  const playTrackFromList = (track, list) => {
    const index = list.findIndex((t) => t.id === track.id);
    startQueue(index >= 0 ? list.slice(index) : [track]);
  };

  const togglePlay = () => {
    if (outputDevice) {
      const action = wiimStatus?.status === 'play' ? 'pause' : 'resume';
      axios.post(`${API_BASE_URL}/wiim/devices/${outputDevice.id}/${action}`).catch((err) => {
        console.error('Error toggling WiiM playback:', err);
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

  const handleTrackPlayClick = (track, list) => {
    if (nowPlaying && nowPlaying.id === track.id) {
      togglePlay();
    } else {
      playTrackFromList(track, list);
    }
  };

  const handleNext = () => {
    setQueue((prevQueue) => {
      if (prevQueue.length === 0) {
        setIsPlaying(false);
        return prevQueue;
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
      const last = prevHistory[prevHistory.length - 1];
      setQueue((q) => (nowPlaying ? [nowPlaying, ...q] : q));
      setNowPlaying(last);
      setIsPlaying(true);
      return prevHistory.slice(0, -1);
    });
  };

  const playGroup = async (group, { shuffle = false } = {}) => {
    try {
      const params = { limit: GROUP_QUEUE_LIMIT, offset: 0 };
      if (group.by === 'genre') params.genre = group.key;
      else if (group.by === 'decade') params.decade = Number(group.key);
      else if (group.by === 'album') {
        const [artist, album] = group.key.split('||');
        params.artist = artist;
        params.album = album;
      }
      const response = await axios.get(`${API_BASE_URL}/tracks/known`, { params });
      startQueue(response.data.tracks, { shuffle });
    } catch (err) {
      console.error('Error queuing group playback:', err);
    }
  };

  const playCurrentFilter = async ({ shuffle = false } = {}) => {
    try {
      const params = { ...buildTrackFilterParams(), limit: GROUP_QUEUE_LIMIT, offset: 0 };
      const response = await axios.get(`${API_BASE_URL}/tracks/known`, { params });
      startQueue(response.data.tracks, { shuffle });
    } catch (err) {
      console.error('Error queuing playback:', err);
    }
  };

  const viewLabel = (mode) => (mode === 'all' ? 'All Tracks' : `By ${mode.charAt(0).toUpperCase()}${mode.slice(1)}`);
  const backLabel = drill && (drill.by === 'album' ? 'Albums' : drill.by === 'genre' ? 'Genres' : 'Decades');
  const effectiveIsPlaying = outputDevice ? wiimStatus?.status === 'play' : isPlaying;

  return (
    <div className="app">
      <header className="app-header">
        <h1>Music Discovery</h1>
        <nav className="nav-tabs">
          <button
            className={activeTab === 'discover' ? 'active' : ''}
            onClick={() => setActiveTab('discover')}
          >
            Discover
          </button>
          <button
            className={activeTab === 'library' ? 'active' : ''}
            onClick={() => setActiveTab('library')}
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
            className={activeTab === 'cleanup' ? 'active' : ''}
            onClick={() => setActiveTab('cleanup')}
          >
            Cleanup
          </button>
        </nav>
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
            <form onSubmit={handleScan} className="scan-form">
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

            <div className="library-controls">
              <input
                type="text"
                className="search-input"
                placeholder="Search tracks, artists, albums…"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
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
              {libraryMode === 'all' && !drill && (
                <div className="filter-row">
                  <select value={filterGenre} onChange={(e) => setFilterGenre(e.target.value)}>
                    <option value="">All Genres</option>
                    {genreOptions.map((g) => <option key={g.key} value={g.key}>{g.label} ({g.count})</option>)}
                  </select>
                  <select value={filterDecade} onChange={(e) => setFilterDecade(e.target.value)}>
                    <option value="">All Decades</option>
                    {decadeOptions.map((d) => <option key={d.key} value={d.key}>{d.label} ({d.count})</option>)}
                  </select>
                </div>
              )}
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
                  <h2>{drill ? '' : 'Your Library'}</h2>
                  {!drill && libraryTracks.length > 0 && (
                    <div className="group-actions">
                      <button className="group-action-btn" onClick={() => playCurrentFilter()}>&#9654; Play All</button>
                      <button className="group-action-btn" onClick={() => playCurrentFilter({ shuffle: true })}>&#128256; Shuffle All</button>
                    </div>
                  )}
                  <span className="library-count">{libraryTotal.toLocaleString()} tracks</span>
                </div>
                {libraryTracks.length === 0 ? (
                  <p className="empty-state">
                    {libraryLoading ? 'Loading…' : 'No tracks found. Scan a folder above to get started.'}
                  </p>
                ) : (
                  <div className="tracks-grid">
                    {libraryTracks.map((track) => {
                      const isCurrent = nowPlaying && nowPlaying.id === track.id;
                      return (
                        <div key={track.id} className={`track-card${isCurrent ? ' playing' : ''}`}>
                          <button
                            className="play-btn"
                            onClick={() => handleTrackPlayClick(track, libraryTracks)}
                            aria-label={isCurrent && effectiveIsPlaying ? 'Pause' : 'Play'}
                          >
                            {isCurrent && effectiveIsPlaying ? '❚❚' : '▶'}
                          </button>
                          <div className="track-thumb-wrap">
                            <span className="track-thumb-fallback">{track.track_name.charAt(0).toUpperCase()}</span>
                            <img
                              className="track-thumb"
                              src={`${API_BASE_URL}/tracks/${track.id}/artwork`}
                              alt=""
                              loading="lazy"
                              onError={(e) => { e.target.style.display = 'none'; }}
                            />
                          </div>
                          <div className="track-info">
                            <h3>{track.track_name}</h3>
                            <p className="artist">{track.artist_name}</p>
                          </div>
                        </div>
                      );
                    })}
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
              <div className="groups-grid">
                {groupsLoading ? (
                  <p className="empty-state">Loading…</p>
                ) : groups.length === 0 ? (
                  <p className="empty-state">No {libraryMode}s found.</p>
                ) : (
                  groups.map((g) => (
                    <div key={g.key} className="group-card">
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

      <PlayerBar
        track={nowPlaying}
        isPlaying={effectiveIsPlaying}
        hasNext={queue.length > 0}
        hasPrev={history.length > 0}
        onNext={handleNext}
        onPrev={handlePrev}
        onTogglePlay={togglePlay}
        setIsPlaying={setIsPlaying}
        audioRef={audioRef}
        apiBase={API_BASE_URL}
        wiimDevices={wiimDevices}
        outputDevice={outputDevice}
        setOutputDevice={setOutputDevice}
        wiimStatus={wiimStatus}
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

function PlayerBar({
  track, isPlaying, hasNext, hasPrev, onNext, onPrev, onTogglePlay, setIsPlaying, audioRef, apiBase,
  wiimDevices, outputDevice, setOutputDevice, wiimStatus,
}) {
  const [expanded, setExpanded] = useState(false);
  const [artistInfo, setArtistInfo] = useState(null);
  const [bioExpanded, setBioExpanded] = useState(false);
  const lastArtistRef = useRef(null);

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

  if (!track) return null;

  const metaParts = [track.genre, track.year, formatDuration(track.duration_seconds)].filter(Boolean);
  const techParts = [
    track.file_format,
    track.bitrate ? `${Math.round(track.bitrate / 1000)}kbps` : null,
    track.sample_rate ? `${(track.sample_rate / 1000).toFixed(1)}kHz` : null,
    channelLabel(track.channels),
    formatFileSize(track.file_size_bytes),
  ].filter(Boolean);

  return (
    <div className="player-root">
      {expanded && (
        <div className="now-playing-panel">
          <div
            className="now-playing-backdrop"
            style={{ backgroundImage: `url(${apiBase}/tracks/${track.id}/artwork)` }}
          />
          <button className="now-playing-collapse" onClick={() => setExpanded(false)} aria-label="Collapse">&#9660;</button>
          <div className="now-playing-content">
          <div className="now-playing-body">
            <div className="now-playing-art">
              <img
                src={`${apiBase}/tracks/${track.id}/artwork`}
                alt=""
                onError={(e) => { e.target.style.display = 'none'; }}
              />
            </div>
            <div className="now-playing-details">
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
              <div className="now-playing-controls">
                <button className="player-btn large" onClick={onPrev} disabled={!hasPrev} aria-label="Previous">&#9198;</button>
                <button className="player-btn xlarge" onClick={onTogglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>
                  {isPlaying ? '❚❚' : '▶'}
                </button>
                <button className="player-btn large" onClick={onNext} disabled={!hasNext} aria-label="Next">&#9197;</button>
              </div>
            </div>
          </div>
          {artistInfo?.found && artistInfo.biography && (
            <div className="now-playing-bio">
              <h3>About {track.artist_name}</h3>
              <p className={bioExpanded ? '' : 'clamped'}>{artistInfo.biography}</p>
              <button className="bio-toggle" onClick={() => setBioExpanded(!bioExpanded)}>
                {bioExpanded ? 'Show less' : 'Read more'}
              </button>
            </div>
          )}
          </div>
        </div>
      )}
      <div className="player-bar">
        <div className="player-thumb-wrap" onClick={() => setExpanded(true)}>
          <img
            src={`${apiBase}/tracks/${track.id}/artwork`}
            alt=""
            onError={(e) => { e.target.style.display = 'none'; }}
          />
        </div>
        <div className="player-info" onClick={() => setExpanded(true)}>
          <span className="player-title">{track.track_name}</span>
          <span className="player-artist">{track.artist_name}</span>
        </div>
        <div className="player-controls">
          <button className="player-btn" onClick={onPrev} disabled={!hasPrev} aria-label="Previous">&#9198;</button>
          {outputDevice ? (
            <>
              <button className="player-btn" onClick={onTogglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>
                {isPlaying ? '❚❚' : '▶'}
              </button>
              <div className="wiim-progress">
                <span className="wiim-progress-time">{formatDuration(Math.floor((wiimStatus?.position_ms || 0) / 1000))}</span>
                <div className="bar-track wiim-progress-track">
                  <div
                    className="bar-fill"
                    style={{
                      width: wiimStatus?.duration_ms
                        ? `${Math.min(100, (wiimStatus.position_ms / wiimStatus.duration_ms) * 100)}%`
                        : '0%',
                    }}
                  />
                </div>
                <span className="wiim-progress-time">{formatDuration(Math.floor((wiimStatus?.duration_ms || 0) / 1000))}</span>
              </div>
            </>
          ) : (
            <audio
              key={track.id}
              ref={audioRef}
              src={`${apiBase}/tracks/${track.id}/stream`}
              autoPlay
              controls
              className="player-audio"
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onEnded={onNext}
            />
          )}
          <button className="player-btn" onClick={onNext} disabled={!hasNext} aria-label="Next">&#9197;</button>
        </div>
        <select
          className="output-picker"
          value={outputDevice ? outputDevice.id : ''}
          onChange={(e) => {
            const id = e.target.value;
            setOutputDevice(id ? wiimDevices.find((d) => d.id === id) || null : null);
          }}
          aria-label="Playback output"
        >
          <option value="">🔊 This Browser</option>
          {wiimDevices.map((d) => (
            <option key={d.id} value={d.id}>📡 {d.name}</option>
          ))}
        </select>
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

  useEffect(() => {
    if (activeTab !== 'cleanup') return;
    if (subTab === 'duplicates' && duplicateGroups === null) fetchDuplicates();
    if (subTab === 'missing-tracks' && missingTracksAlbums === null) fetchMissingTracks();
    if (subTab === 'missing-artwork' && artworkCheckStatus === null) {
      axios.get(`${apiBase}/library/check-artwork/status`).then((response) => {
        setArtworkCheckStatus(response.data);
        if (response.data.status === 'running') {
          pollArtworkCheck();
        } else if (response.data.status === 'done') {
          fetchMissingArtwork(0);
        }
      }).catch((err) => console.error('Error checking artwork-check status:', err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, subTab]);

  useEffect(() => () => {
    if (artworkPollRef.current) clearInterval(artworkPollRef.current);
  }, []);

  const bestTrack = (tracks) => tracks.reduce((best, t) => ((t.bitrate || 0) > (best.bitrate || 0) ? t : best), tracks[0]);

  return (
    <section className="cleanup-section">
      <div className="view-tabs cleanup-subtabs">
        <button className={subTab === 'duplicates' ? 'active' : ''} onClick={() => setSubTab('duplicates')}>Duplicates</button>
        <button className={subTab === 'missing-tracks' ? 'active' : ''} onClick={() => setSubTab('missing-tracks')}>Missing Tracks</button>
        <button className={subTab === 'missing-artwork' ? 'active' : ''} onClick={() => setSubTab('missing-artwork')}>Missing Artwork</button>
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
              {missingTracksAlbums ? 'No gaps found in albums with track numbers.' : 'Loading…'}
            </p>
          ) : (
            <>
              <p className="cleanup-summary">
                {missingTracksAlbums.length.toLocaleString()} album{missingTracksAlbums.length === 1 ? '' : 's'} with missing tracks
              </p>
              {missingTracksAlbums.map((album, idx) => (
                <div key={idx} className="missing-album-row">
                  <div className="missing-album-info">
                    <span className="missing-album-title">{album.album_name}</span>
                    <span className="missing-album-artist">{album.artist_name}</span>
                  </div>
                  <div className="missing-album-gap">
                    Have {album.have_count} of {album.expected_total} &middot; missing #{album.missing_track_numbers.join(', #')}
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
    </section>
  );
}

export default App;
