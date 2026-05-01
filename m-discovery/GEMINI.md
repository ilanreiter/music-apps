# Gemini Music Discovery CLI
A personalized music recommendation engine powered by Gemini 1.5 Pro. This tool bridges the gap between your self-hosted music history and cloud-based streaming services to find truly "new" music.
🎯 Project Goals
•	True Discovery: Filter out music already stored in your local PostgreSQL database.
•	Fine-Tuned Control: Use parameters (mood, tempo, genre) to guide the LLM's "musicologist" logic.
•	Cross-Platform: Generate playlists that can be synced to Spotify and YouTube Music.
•	Self-Hosted Integration: Keep your "source of truth" for music taste in your own infrastructure.
•	Web UI: Provide a modern and slick web interface for ongoing operation.
🏗️ System Architecture
1. Data Layer (PostgreSQL)
The app interacts with an external PostgreSQL database to track what you already know.
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

2. Backend API (Python/FastAPI)
A Python API layer built with FastAPI will serve data to the frontend, interacting with the database and the Gemini Engine.

3. The Gemini Engine
The CLI/API translates your "sliders" into a descriptive prompt.
•	Input: A seed track + mood (0-100), tempo (BPM), complexity (low-high).
•	Process: Gemini receives the seed and parameters, generates a candidate list, and the app cross-references this against your known_tracks table.
•	Output: A curated JSON list of 10-20 tracks you haven't heard before.

4. Frontend (React Application)
A modern and slick web UI built with React, utilizing Material Design principles for an intuitive user experience.

🚀 Development Phases
Phase 1: Core CLI & Database Integration
•	[x] DB Connector: Python script to query the local Postgres instance.
•	[ ] Prompt Builder: Logic to convert numerical sliders into natural language descriptions (e.g., 70% Energy becomes "High-energy, driving rhythm").
•	[ ] The "Known Filter": A post-processing step that removes any Gemini suggestions found in your DB.
Phase 2: Streaming API Integration
•	[ ] Spotify/YT Music Auth: Implement OAuth2 flows for account access.
•	[ ] Library Sync: Script to pull your "Liked Songs" and playlists into the known_tracks table.
•	[ ] Playlist Uploader: Automate the creation of a "Gemini Discovery [Date]" playlist on your chosen platform.
Phase 3: Web UI Development
•	[ ] Backend API: Implement FastAPI endpoints for known tracks, discovery history, and music discovery.
•	[ ] Frontend Setup: Create a React project with routing and basic layout.
•	[ ] UI Components: Develop components for displaying tracks, history, and discovery controls.
•	[ ] API Integration: Connect frontend components to the backend API.
🛠️ Usage Example (Concept)
To run the application using Docker Compose:
docker-compose run app python src/discovery.py --seed "Blue in Green" --mood "melancholy" --tempo 60 --exclude-known

To run the Web UI (after Phase 3 implementation):
1. Start the backend API service.
2. Start the frontend development server or serve static files.
3. Access the UI in your web browser (e.g., http://localhost:6009).

🐳 Docker Setup
To get started with Docker:
1. Ensure Docker is installed and running on your system.
2. Configure your external PostgreSQL database connection details in the `docker-compose.yml` file under the `app` service's `environment` section.
3. Build and run the application service:
   ```bash
   docker-compose up --build -d app
   ```
   This will build and start the application container, connecting to your external PostgreSQL database.
4. To run CLI commands (e.g., for initial database setup or running the main script):
   ```bash
   docker-compose run app python src/database.py
   docker-compose run app python src/main.py
   ```
5. To stop the application service:
   ```bash
   docker-compose down
   ```

📋 Required API Keys
To run this project, you will need:
•	Google AI API Key (for Gemini)
•	Spotify Developer Credentials (Client ID/Secret)
•	YouTube Data API v3 (or ytmusicapi headers)
•	PostgreSQL Connection Details (Host, Port, User, Password, Database Name - configured via `docker-compose.yml` environment variables for the `app` service)
💡 Implementation Notes
•	High-Fi Priority: Since the system uses Gemini, you can explicitly instruct the model to prefer "audiophile-grade" recordings or specific production styles common in your current collection.
•	Filtering Logic: Because your library is large, the app will perform a Local Exclusion (comparing Gemini's output to your DB) rather than sending 100,000 track titles in the LLM prompt.