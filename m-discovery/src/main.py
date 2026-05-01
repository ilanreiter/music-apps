from fastapi import FastAPI, Depends, HTTPException, status
from pydantic import BaseModel
from typing import List, Optional
import psycopg2
from psycopg2.extras import RealDictCursor
from .database import get_db_connection, create_tables
import google.generativeai as genai
import os
import json
import re

app = FastAPI()

# Configure Gemini API
genai.configure(api_key=os.getenv("GOOGLE_API_KEY"))
model = genai.GenerativeModel('gemini-1.5-pro')

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
            # Ensure track_list is a list of dicts before passing to Track
            if isinstance(entry['track_list'], list):
                entry['track_list'] = [Track(**track) for track in entry['track_list']]
            else:
                entry['track_list'] = [] # Default to empty list if unexpected format
        return history
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

def _build_prompt(params: DiscoveryParameters) -> str:
    prompt_parts = [
        f"I'm looking for music similar to '{params.seed_track}'.",
        "Suggest 5-10 tracks that I might not have heard before.",
        "For each track, provide the track name, artist name, and album name.",
        "Format the output as a JSON array of objects, where each object has 'track_name', 'artist_name', and 'album_name' keys."
    ]
    if params.mood:
        prompt_parts.append(f"The mood should be: {params.mood}.")
    if params.tempo:
        prompt_parts.append(f"The tempo should be around {params.tempo} BPM.")
    if params.complexity:
        prompt_parts.append(f"The musical complexity should be: {params.complexity}.")
    
    prompt_parts.append("Ensure the output is valid JSON and nothing else.")
    return " ".join(prompt_parts)

async def _call_gemini_api(prompt: str) -> List[Track]:
    try:
        response = await model.generate_content_async(prompt)
        # Extract JSON string from the response
        text_response = response.text.strip()
        
        # Gemini might add markdown ```json ... ```
        if text_response.startswith("```json") and text_response.endswith("```"):
            text_response = text_response[7:-3].strip()
        
        suggested_tracks_data = json.loads(text_response)
        
        # Validate and convert to Track Pydantic models
        suggested_tracks = [Track(**track_data) for track_data in suggested_tracks_data]
        return suggested_tracks
    except Exception as e:
        print(f"Error calling Gemini API or parsing response: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Error from AI: {e}")

async def _filter_known_tracks(suggested_tracks: List[Track], db: psycopg2.extensions.connection) -> List[Track]:
    if not suggested_tracks:
        return []

    known_tracks_set = set()
    try:
        cur = db.cursor()
        cur.execute("SELECT track_name, artist_name FROM known_tracks")
        for row in cur.fetchall():
            known_tracks_set.add((row[0].lower(), row[1].lower())) # Case-insensitive comparison
        cur.close()
    except Exception as e:
        print(f"Error fetching known tracks for filtering: {e}")
        # Continue without filtering if there's a DB error
        return suggested_tracks

    filtered_tracks = []
    for track in suggested_tracks:
        if (track.track_name.lower(), track.artist_name.lower()) not in known_tracks_set:
            filtered_tracks.append(track)
    return filtered_tracks

@app.post("/api/discover", response_model=List[Track])
async def discover_music(params: DiscoveryParameters, db: psycopg2.extensions.connection = Depends(get_db)):
    print(f"Received discovery request with params: {params}")

    prompt = _build_prompt(params)
    print(f"Gemini Prompt: {prompt}")

    suggested_tracks = await _call_gemini_api(prompt)
    print(f"Gemini suggested {len(suggested_tracks)} tracks.")

    final_tracks = suggested_tracks
    if params.exclude_known:
        final_tracks = await _filter_known_tracks(suggested_tracks, db)
        print(f"After filtering known tracks, {len(final_tracks)} remain.")

    # Store discovery history
    try:
        cur = db.cursor()
        # Convert list of Track objects to list of dicts for JSONB storage
        track_list_dicts = [track.model_dump() for track in final_tracks]
        cur.execute(
            "INSERT INTO discovery_history (prompt_used, track_list) VALUES (%s, %s)",
            (prompt, json.dumps(track_list_dicts))
        )
        db.commit()
        cur.close()
        print("Discovery history stored successfully.")
    except Exception as e:
        print(f"Error storing discovery history: {e}")
        db.rollback() # Rollback in case of error

    return final_tracks