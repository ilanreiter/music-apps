import os
from mutagen import File as MutagenFile

AUDIO_EXTENSIONS = {'.mp3', '.flac', '.m4a', '.mp4', '.ogg', '.oga', '.opus', '.wav', '.aac', '.wma'}

# mutagen's easy=True interface doesn't normalize tags for every container (e.g. ID3-in-WAV
# comes back keyed by raw frame id), so fall back to mapping the common ID3v2 frames directly.
ID3_FRAME_TO_FIELD = {
    'TIT2': 'title',
    'TPE1': 'artist',
    'TALB': 'album',
    'TCON': 'genre',
    'TDRC': 'date',
    'TYER': 'date',
}


def _first(value):
    if isinstance(value, (list, tuple)):
        return value[0] if value else None
    return value


def _extract_year(date_value):
    if not date_value:
        return None
    digits = ''.join(ch for ch in str(date_value)[:4] if ch.isdigit())
    return int(digits) if len(digits) == 4 else None


def _from_raw_id3_frames(tags):
    result = {}
    for frame_id, field in ID3_FRAME_TO_FIELD.items():
        frame = tags.get(frame_id)
        text = getattr(frame, 'text', None)
        if text and field not in result:
            result[field] = list(text)
    return result


def _fallback_from_filename(file_path):
    stem = os.path.splitext(os.path.basename(file_path))[0]
    if ' - ' in stem:
        artist, _, title = stem.partition(' - ')
        return title.strip(), artist.strip()
    return stem.strip(), 'Unknown Artist'


def read_tags(file_path):
    """Extract track metadata from an audio file. Returns None if the file can't be read."""
    try:
        audio = MutagenFile(file_path, easy=True)
    except Exception:
        return None
    if audio is None:
        return None

    tags = audio.tags or {}
    if not any(key in tags for key in ('title', 'artist', 'genre', 'date')):
        tags = _from_raw_id3_frames(tags)

    track_name = _first(tags.get('title'))
    artist_name = _first(tags.get('artist'))
    album_name = _first(tags.get('album'))
    genre = _first(tags.get('genre'))
    year = _extract_year(_first(tags.get('date')) or _first(tags.get('originaldate')))

    if not track_name or not artist_name:
        fallback_title, fallback_artist = _fallback_from_filename(file_path)
        track_name = track_name or fallback_title
        artist_name = artist_name or fallback_artist

    info = getattr(audio, 'info', None)
    duration_seconds = int(info.length) if info and getattr(info, 'length', None) else None
    bitrate = getattr(info, 'bitrate', None) if info else None
    sample_rate = getattr(info, 'sample_rate', None) if info else None
    channels = getattr(info, 'channels', None) if info else None

    try:
        file_size_bytes = os.path.getsize(file_path)
    except OSError:
        file_size_bytes = None

    return {
        'file_path': file_path,
        'track_name': track_name,
        'artist_name': artist_name,
        'album_name': album_name,
        'genre': genre,
        'year': year,
        'duration_seconds': duration_seconds,
        'bitrate': bitrate,
        'sample_rate': sample_rate,
        'channels': channels,
        'file_size_bytes': file_size_bytes,
    }


def find_audio_files(root_path):
    for dirpath, _dirnames, filenames in os.walk(root_path):
        for filename in filenames:
            if os.path.splitext(filename)[1].lower() in AUDIO_EXTENSIONS:
                yield os.path.join(dirpath, filename)


def _upsert_track(cur, metadata):
    # xmax = 0 on the returned row means it was newly inserted rather than updated by the conflict.
    cur.execute("""
        INSERT INTO known_tracks (
            track_name, artist_name, album_name, genre, year, duration_seconds,
            bitrate, sample_rate, channels, file_size_bytes, file_path
        )
        VALUES (
            %(track_name)s, %(artist_name)s, %(album_name)s, %(genre)s, %(year)s, %(duration_seconds)s,
            %(bitrate)s, %(sample_rate)s, %(channels)s, %(file_size_bytes)s, %(file_path)s
        )
        ON CONFLICT (file_path) WHERE file_path IS NOT NULL DO UPDATE SET
            track_name = EXCLUDED.track_name,
            artist_name = EXCLUDED.artist_name,
            album_name = EXCLUDED.album_name,
            genre = EXCLUDED.genre,
            year = EXCLUDED.year,
            duration_seconds = EXCLUDED.duration_seconds,
            bitrate = EXCLUDED.bitrate,
            sample_rate = EXCLUDED.sample_rate,
            channels = EXCLUDED.channels,
            file_size_bytes = EXCLUDED.file_size_bytes
        RETURNING (xmax = 0) AS inserted
    """, metadata)
    row = cur.fetchone()
    return bool(row and row[0])


COMMIT_EVERY = 200


def run_scan(root_path, get_connection, progress):
    """Walk root_path, read tags, and upsert rows into known_tracks keyed by file_path.

    Mutates `progress` in place as it goes so a separate request can report live status;
    intended to run on a background thread since a 10K+ track library on network storage
    can take minutes, far past what a synchronous HTTP request (or a reverse proxy's
    default timeout) can wait for. Commits periodically so a mid-scan failure doesn't
    discard everything found so far.
    """
    if not os.path.isdir(root_path):
        progress.update(status='error', error=f"Not a directory: {root_path}")
        return

    progress.update(
        status='running', root_path=root_path, processed=0,
        added=0, updated=0, skipped=0, unreadable_files=[], error=None,
    )

    conn = get_connection()
    if conn is None:
        progress.update(status='error', error='Could not connect to the database')
        return

    try:
        cur = conn.cursor()
        for file_path in find_audio_files(root_path):
            metadata = read_tags(file_path)
            if metadata is None:
                progress['skipped'] += 1
                if len(progress['unreadable_files']) < 20:
                    progress['unreadable_files'].append(file_path)
            elif _upsert_track(cur, metadata):
                progress['added'] += 1
            else:
                progress['updated'] += 1

            progress['processed'] += 1
            if progress['processed'] % COMMIT_EVERY == 0:
                conn.commit()

        conn.commit()
        progress['status'] = 'done'
    except Exception as e:
        conn.rollback()
        progress.update(status='error', error=str(e))
    finally:
        cur.close()
        conn.close()
