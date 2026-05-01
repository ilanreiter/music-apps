# Gemini Music Discovery CLI
A personalized music recommendation engine powered by Gemini 1.5 Pro. This tool bridges the gap between your self-hosted music history and cloud-based streaming services to find truly "new" music.
🎯 Project Goals
•	True Discovery: Filter out music already stored in your local PostgreSQL database.
•	Fine-Tuned Control: Use parameters (mood, tempo, genre) to guide the LLM's "musicologist" logic.
•	Cross-Platform: Generate playlists that can be synced to Spotify and YouTube Music.
•	Self-Hosted Integration: Keep your "source of truth" for music taste in your own infrastructure.
🏗️ System Architecture
1. Data Layer (PostgreSQL)
The app interacts with a local PostgreSQL database, typically run as a Docker container, to track what you already know.
-- Track your existing library
CREATE TABLE known_tracks (
    id SERIAL PRIMARY KEY,
    track_name TEXT NOT NULL,
    artist_name TEXT NOT NULL,
    album_name TEXT,
    is_favorite BOOLEAN DEFAULT FALSE,
    last_played TIMESTAMP,
    UNIQUE(track_name, artist_name)
);

-- Store generated playlists for history
CREATE TABLE discovery_history (
    id SERIAL PRIMARY KEY,
    generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    prompt_used TEXT,
    track_list JSONB
);

2. The Gemini Engine
The CLI translates your "sliders" into a descriptive prompt.
•	Input: A seed track + mood (0-100), tempo (BPM), complexity (low-high).
•	Process: Gemini receives the seed and parameters, generates a candidate list, and the app cross-references this against your known_tracks table.
•	Output: A curated JSON list of 10-20 tracks you haven't heard before.
🚀 Development Phases
Phase 1: Core CLI & Database Integration
•	[ ] DB Connector: Python script to query the local Postgres instance.
•	[ ] Prompt Builder: Logic to convert numerical sliders into natural language descriptions (e.g., 70% Energy becomes "High-energy, driving rhythm").
•	[ ] The "Known Filter": A post-processing step that removes any Gemini suggestions found in your DB.
Phase 2: Streaming API Integration
•	[ ] Spotify/YT Music Auth: Implement OAuth2 flows for account access.
•	[ ] Library Sync: Script to pull your "Liked Songs" and playlists into the known_tracks table.
•	[ ] Playlist Uploader: Automate the creation of a "Gemini Discovery [Date]" playlist on your chosen platform.
🛠️ Usage Example (Concept)
To run the application using Docker Compose:
docker-compose run app python src/discovery.py --seed "Blue in Green" --mood "melancholy" --tempo 60 --exclude-known

🐳 Docker Setup
To get started with Docker:
1. Ensure Docker is installed and running on your system.
2. Build and run the services:
   ```bash
   docker-compose up --build -d
   ```
   This will start the PostgreSQL database and the application container in the background.
3. To run CLI commands (e.g., for initial database setup or running the main script):
   ```bash
   docker-compose run app python src/database.py
   docker-compose run app python src/main.py
   ```
4. To stop the services:
   ```bash
   docker-compose down
   ```

📋 Required API Keys
To run this project, you will need:
•	Google AI API Key (for Gemini)
•	Spotify Developer Credentials (Client ID/Secret)
•	YouTube Data API v3 (or ytmusicapi headers)
•	PostgreSQL Connection String (managed via `docker-compose.yml` environment variables for the `db` service)
💡 Implementation Notes
•	High-Fi Priority: Since the system uses Gemini, you can explicitly instruct the model to prefer "audiophile-grade" recordings or specific production styles common in your current collection.
•	Filtering Logic: Because your library is large, the app will perform a Local Exclusion (comparing Gemini's output to your DB) rather than sending 100,000 track titles in the LLM prompt.