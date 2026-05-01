import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './App.css';

function App() {
  const [knownTracks, setKnownTracks] = useState([]);
  const [discoveryHistory, setDiscoveryHistory] = useState([]);
  const [discoveredTracks, setDiscoveredTracks] = useState([]);
  const [seedTrack, setSeedTrack] = useState('');
  const [mood, setMood] = useState('');
  const [tempo, setTempo] = useState('');
  const [complexity, setComplexity] = '';
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const API_BASE_URL = '/api'; // Nginx will proxy /api to the backend

  useEffect(() => {
    fetchKnownTracks();
    fetchDiscoveryHistory();
  }, []);

  const fetchKnownTracks = async () => {
    try {
      const response = await axios.get(`${API_BASE_URL}/tracks/known`);
      setKnownTracks(response.data);
    } catch (err) {
      setError('Failed to fetch known tracks.');
      console.error('Error fetching known tracks:', err);
    }
  };

  const fetchDiscoveryHistory = async () => {
    try {
      const response = await axios.get(`${API_BASE_URL}/history`);
      setDiscoveryHistory(response.data);
    } catch (err) {
      setError('Failed to fetch discovery history.');
      console.error('Error fetching discovery history:', err);
    }
  };

  const handleDiscoverMusic = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const response = await axios.post(`${API_BASE_URL}/discover`, {
        seed_track: seedTrack,
        mood: mood || null,
        tempo: tempo ? parseInt(tempo) : null,
        complexity: complexity || null,
        exclude_known: true, // Always exclude known for now
      });
      setDiscoveredTracks(response.data);
      fetchDiscoveryHistory(); // Refresh history after new discovery
    } catch (err) {
      setError('Failed to discover music. Please check your input and try again.');
      console.error('Error discovering music:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="App">
      <header className="App-header">
        <h1>Gemini Music Discovery</h1>
      </header>
      <main>
        <section className="discovery-form-section">
          <h2>Discover New Music</h2>
          <form onSubmit={handleDiscoverMusic}>
            <div className="form-group">
              <label htmlFor="seedTrack">Seed Track:</label>
              <input
                type="text"
                id="seedTrack"
                value={seedTrack}
                onChange={(e) => setSeedTrack(e.target.value)}
                required
              />
            </div>
            <div className="form-group">
              <label htmlFor="mood">Mood:</label>
              <input
                type="text"
                id="mood"
                value={mood}
                onChange={(e) => setMood(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label htmlFor="tempo">Tempo (BPM):</label>
              <input
                type="number"
                id="tempo"
                value={tempo}
                onChange={(e) => setTempo(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label htmlFor="complexity">Complexity:</label>
              <select
                id="complexity"
                value={complexity}
                onChange={(e) => setComplexity(e.target.value)}
              >
                <option value="">Select Complexity</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
            <button type="submit" disabled={loading}>
              {loading ? 'Discovering...' : 'Discover!'}
            </button>
            {error && <p className="error-message">{error}</p>}
          </form>
        </section>

        <section className="discovered-tracks-section">
          <h2>Discovered Tracks</h2>
          {discoveredTracks.length === 0 ? (
            <p>No tracks discovered yet. Try a search!</p>
          ) : (
            <ul>
              {discoveredTracks.map((track, index) => (
                <li key={index}>
                  <strong>{track.track_name}</strong> by {track.artist_name} ({track.album_name})
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="known-tracks-section">
          <h2>Your Known Tracks</h2>
          {knownTracks.length === 0 ? (
            <p>No known tracks found. Sync your library to see them here.</p>
          ) : (
            <ul>
              {knownTracks.map((track) => (
                <li key={track.id}>
                  <strong>{track.track_name}</strong> by {track.artist_name} ({track.album_name})
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="discovery-history-section">
          <h2>Discovery History</h2>
          {discoveryHistory.length === 0 ? (
            <p>No discovery history yet.</p>
          ) : (
            <ul>
              {discoveryHistory.map((entry) => (
                <li key={entry.id}>
                  <h3>{entry.generated_at} - {entry.prompt_used}</h3>
                  <ul>
                    {entry.track_list.map((track, index) => (
                      <li key={index}>
                        {track.track_name} by {track.artist_name}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}

export default App;