# AGENTS.md

## Project Overview

Music discovery app - takes input (seed tracks, genre, mood, tempo, complexity, etc.) and generates matching playlist recommendations using Gemini API.

## Project Structure

- `m-discovery/` - Main project (git root at `/home/ilan/Dev2/music/m-discovery`)
  - `src/` - Python FastAPI backend
  - `frontend/` - React 19 SPA
  - `utils/` - Utility modules

## Running the App

### With Docker (recommended)
```bash
cd m-discovery && docker-compose up --build
```
Reads secrets and `MUSIC_LIBRARY_PATH` from `m-discovery/.env` (copy `.env.example` to start).
The app container bind-mounts `MUSIC_LIBRARY_PATH` read-only at `/music` — scan requests
should use `/music` (or a subfolder of it), not the host path.

### Backend only
```bash
cd m-discovery/src && uvicorn main:app --reload
```

### Frontend only
```bash
cd m-discovery/frontend && npm start
```

## Required Environment Variables

```
DB_USER, DB_PASSWORD, DB_HOST, DB_PORT, DB_NAME
GOOGLE_API_KEY
MUSIC_LIBRARY_PATH   # host path to your local music library, mounted at /music in the app container
```

## Database

- PostgreSQL required
- Tables `known_tracks` and `discovery_history` auto-created/migrated on startup
- `known_tracks` rows from a library scan are keyed by `file_path` (unique), and also carry
  `genre`, `year`, `duration_seconds`
- Manual init: `python src/database.py`

## API Endpoints

- `GET /api/tracks/known` - List known tracks
- `POST /api/library/scan` - Scan a folder (`root_path`) for audio files, upsert tags into `known_tracks`
- `GET /api/library/stats` - Taste profile: total tracks, top genres, top artists, tracks by decade
- `GET /api/history` - Discovery history
- `POST /api/discover` - Generate playlist discovery

## Key Files

- `m-discovery/src/main.py` - FastAPI app, routes, Gemini API
- `m-discovery/src/database.py` - PostgreSQL connection
- `m-discovery/src/library_scanner.py` - Local file walk + mutagen tag extraction + upsert
- `m-discovery/frontend/src/App.js` - React entrypoint (Discover / My Library / Taste Profile tabs)
- `m-discovery/docker-compose.yml` - Docker orchestration