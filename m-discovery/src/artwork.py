import base64
import io
import os

from mutagen.flac import FLAC, Picture
from mutagen.id3 import ID3
from mutagen.mp4 import MP4
from PIL import Image

ARTWORK_CACHE_DIR = os.environ.get('ARTWORK_CACHE_DIR', '/app/artwork_cache')
THUMBNAIL_SIZE = (300, 300)


def _extract_raw_artwork(file_path):
    # mutagen's "easy" tag interface (used for text tags elsewhere) hides picture frames
    # for MP3/M4A, so those need a direct format-specific parse; FLAC exposes .pictures
    # either way.
    ext = os.path.splitext(file_path)[1].lower()
    try:
        if ext == '.flac':
            pics = FLAC(file_path).pictures
            return pics[0].data if pics else None
        if ext == '.mp3':
            apics = ID3(file_path).getall('APIC')
            return apics[0].data if apics else None
        if ext in ('.m4a', '.mp4'):
            tags = MP4(file_path).tags
            covr = tags.get('covr') if tags else None
            return bytes(covr[0]) if covr else None
        if ext in ('.ogg', '.oga', '.opus'):
            from mutagen import File as MutagenFile
            tags = MutagenFile(file_path).tags or {}
            b64_list = tags.get('metadata_block_picture') or tags.get('METADATA_BLOCK_PICTURE')
            if b64_list:
                return Picture(base64.b64decode(b64_list[0])).data
    except Exception:
        return None
    return None


ARTWORK_CHECK_COMMIT_EVERY = 200


def check_artwork_presence(get_connection, progress):
    """Walk every known track and record whether it has embedded artwork, without
    doing the full extract+resize+cache (that stays lazy, only done when a
    thumbnail is actually requested for display). Runs on a background thread
    since checking 10K+ files means re-opening and tag-parsing every one of them.
    """
    progress.update(status='running', processed=0, total=0, found=0, missing=0, error=None)

    conn = get_connection()
    if conn is None:
        progress.update(status='error', error='Could not connect to the database')
        return

    try:
        cur = conn.cursor()
        cur.execute("SELECT id, file_path FROM known_tracks WHERE file_path IS NOT NULL")
        rows = cur.fetchall()
        cur.close()
        progress['total'] = len(rows)

        cur = conn.cursor()
        for track_id, file_path in rows:
            has_art = bool(_extract_raw_artwork(file_path))
            cur.execute("UPDATE known_tracks SET has_artwork = %s WHERE id = %s", (has_art, track_id))
            if has_art:
                progress['found'] += 1
            else:
                progress['missing'] += 1
            progress['processed'] += 1
            if progress['processed'] % ARTWORK_CHECK_COMMIT_EVERY == 0:
                conn.commit()

        conn.commit()
        progress['status'] = 'done'
    except Exception as e:
        conn.rollback()
        progress.update(status='error', error=str(e))
    finally:
        cur.close()
        conn.close()


def get_or_create_thumbnail(track_id, file_path):
    """Return the on-disk cache path for a track's thumbnail, extracting and downscaling
    embedded cover art on first request. Returns None if the file has no artwork."""
    os.makedirs(ARTWORK_CACHE_DIR, exist_ok=True)
    cache_path = os.path.join(ARTWORK_CACHE_DIR, f"{track_id}.jpg")
    if os.path.exists(cache_path):
        return cache_path

    raw = _extract_raw_artwork(file_path)
    if not raw:
        return None

    try:
        image = Image.open(io.BytesIO(raw)).convert('RGB')
        image.thumbnail(THUMBNAIL_SIZE)
        image.save(cache_path, format='JPEG', quality=85)
    except Exception:
        return None

    return cache_path
