from fastapi import FastAPI, Depends, HTTPException, status
from pydantic import BaseModel
from typing import List, Optional
import psycopg2
from psycopg2.extras import RealDictCursor
from .database import get_db_connection, create_tables # Assuming database.py is in the same directory

app = FastAPI()

# Pydantic models for data validation and serialization
class Track(BaseModel):
    id: Optional[int] = None
    track_name: str
    artist_name: str
    album_name: Optional[str] = None
    is_favorite: Optional[bool] = False
    last_played: Optional[str] = None # Will be datetime string

class DiscoveryHistoryEntry(BaseModel):
    id: Optional[int] = None
    generated_at: Optional[str] = None # Will be datetime string
    prompt_used: str
    track_list: List[Track] # Assuming track_list is a JSONB array of tracks

class DiscoveryParameters(BaseModel):
    seed_track: str
    mood: Optional[str] = None
    tempo: Optional[int] = None
    complexity: Optional[str] = None
    exclude_known: Optional[bool] = True

# Dependency to get a database connection
def get_db():
    conn = None
    try:
        conn = get_db_connection()
        yield conn
    finally:
        if conn:
            conn.close()

@app.on_event("startup")
async def startup_event():
    print("Starting up... Creating tables if they don't exist.")
    create_tables()
    print("Tables checked/created.")

@app.get("/")
async def read_root():
    return {"message": "Gemini Music Discovery API is running!"}

@app.get("/api/tracks/known", response_model=List[Track])
async def get_known_tracks(db: psycopg2.extensions.connection = Depends(get_db)):
    try:
        cur = db.cursor(cursor_factory=RealDictCursor)
        cur.execute("SELECT id, track_name, artist_name, album_name, is_favorite, last_played FROM known_tracks")
        tracks = cur.fetchall()
        cur.close()
        return tracks
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

@app.get("/api/history", response_model=List[DiscoveryHistoryEntry])
async def get_discovery_history(db: psycopg2.extensions.connection = Depends(get_db)):
    try:
        cur = db.cursor(cursor_factory=RealDictCursor)
        cur.execute("SELECT id, generated_at, prompt_used, track_list FROM discovery_history ORDER BY generated_at DESC")
        history = cur.fetchall()
        cur.close()
        # Convert track_list from JSONB string to List[Track]
        for entry in history:
            entry['track_list'] = [Track(**track) for track in entry['track_list']]
        return history
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

@app.post("/api/discover", response_model=List[Track])
async def discover_music(params: DiscoveryParameters, db: psycopg2.extensions.connection = Depends(get_db)):
    # This is a placeholder. The actual Gemini engine logic will go here.
    # For now, it returns dummy data.
    print(f"Received discovery request with params: {params}")
    
    # Example: Insert a dummy history entry
    try:
        cur = db.cursor()
        dummy_track_list = [
            {"track_name": "Dummy Track 1", "artist_name": "Dummy Artist", "album_name": "Dummy Album"},
            {"track_name": "Dummy Track 2", "artist_name": "Another Dummy", "album_name": "Another Album"}
        ]
        import json
        cur.execute(
            "INSERT INTO discovery_history (prompt_used, track_list) VALUES (%s, %s) RETURNING id",
            (f"Discovery based on {params.seed_track} with mood {params.mood}", json.dumps(dummy_track_list))
        )
        history_id = cur.fetchone()[0]
        db.commit()
        cur.close()
        print(f"Dummy discovery history entry created with ID: {history_id}")
    except Exception as e:
        print(f"Error inserting dummy history: {e}")
        db.rollback() # Rollback in case of error

    return [
        Track(track_name="Discovered Song A", artist_name="New Artist X", album_name="New Album Y"),
        Track(track_name="Discovered Song B", artist_name="New Artist Z", album_name="New Album W")
    ]
