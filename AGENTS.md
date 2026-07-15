# AGENTS.md

## Project Structure

- `m-discovery/` - Main project (git root at parent `/home/ilan/Dev2/music`)
  - `src/` - Python FastAPI backend
  - `frontend/` - React 19 SPA
  - `utils/` - Utility modules

## Required Environment Variables

Set these in your shell or `.env`:

```
DB_USER, DB_PASSWORD, DB_HOST, DB_PORT, DB_NAME
GOOGLE_API_KEY
```

## Running the App

**Backend (FastAPI):**
```bash
cd m-discovery/src && uvicorn main:app --reload
```
Requires PostgreSQL database running.

**Frontend (React):**
```bash
cd m-discovery/frontend && npm start
```

## Database

- Tables `known_tracks` and `discovery_history` are auto-created on backend startup.
- Initialize manually: `python src/database.py`

## Key Files

- `m-discovery/src/main.py` - FastAPI app, routes, Gemini API integration
- `m-discovery/src/database.py` - PostgreSQL connection and table creation
- `m-discovery/frontend/src/App.js` - React entrypoint