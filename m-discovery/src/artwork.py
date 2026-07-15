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
