import base64
import hashlib
import io
import os
import re

from mutagen.flac import FLAC, Picture
from mutagen.id3 import ID3
from mutagen.mp4 import MP4
from PIL import Image

ARTWORK_CACHE_DIR = os.environ.get('ARTWORK_CACHE_DIR', '/app/artwork_cache')
THUMBNAIL_SIZE = (300, 300)


def normalize_album_name(album_name):
    """Loose match key for album names - never stored or displayed, only used
    to decide whether two album tags refer to the same release for artwork
    sharing purposes. Strips bracket/parenthesis *characters* (not their
    contents) and collapses whitespace, so e.g. "Yellow Submarine Songtrack"
    and "Yellow Submarine [Songtrack]" are treated as the same album.
    Deliberately conservative: doesn't strip words like "Deluxe"/"Remastered",
    which could risk merging genuinely different releases."""
    if not album_name:
        return ''
    cleaned = re.sub(r'[\[\]\(\)\{\}]', ' ', album_name)
    return re.sub(r'\s+', ' ', cleaned).strip().lower()


def normalized_album_sql(column_ref='album_name'):
    """SQL equivalent of normalize_album_name(), for queries that need to
    compare albums across many rows at once (a per-row Python pass would mean
    pulling the whole table into memory first). `[][(){}]` is a POSIX
    bracket-expression trick: a `]` placed right after the opening `[` is
    treated as a literal character instead of closing the class, letting one
    class match any of `] [ ( ) { }`."""
    return (
        "trim(regexp_replace(regexp_replace(lower(" + column_ref + "), "
        "'[][(){}]', ' ', 'g'), '\\s+', ' ', 'g'))"
    )


def cache_key_for(track_id, artist_name, album_name):
    """Tracks that share an artist+album share one cache entry (and can fall
    back to a sibling's embedded art - see get_or_create_thumbnail), so all
    copies of an album show the same artwork instead of it varying file by
    file. Tracks with no album (singles, unknown album) keep a per-track key."""
    normalized_album = normalize_album_name(album_name)
    if not normalized_album:
        return str(track_id)
    raw = f"{(artist_name or '').strip().lower()}\x1f{normalized_album}"
    return hashlib.sha1(raw.encode('utf-8')).hexdigest()


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

        # A track whose own file embeds no artwork can still show artwork -
        # the endpoint falls back to a sibling's embedded art for tracks that
        # share the same artist+album (see get_or_create_thumbnail's
        # candidate_paths). Reflect that here so "missing artwork" only lists
        # tracks with genuinely no artwork anywhere in their album group.
        # Albums are matched loosely (normalized_album_sql), not by exact
        # string, so e.g. "Album Songtrack" and "Album [Songtrack]" share art.
        cur = conn.cursor()
        cur.execute(f"""
            UPDATE known_tracks kt SET has_artwork = TRUE
            WHERE has_artwork = FALSE
              AND album_name IS NOT NULL AND album_name <> ''
              AND EXISTS (
                SELECT 1 FROM known_tracks sib
                WHERE sib.artist_name = kt.artist_name
                  AND {normalized_album_sql('sib.album_name')} = {normalized_album_sql('kt.album_name')}
                  AND sib.has_artwork = TRUE
              )
        """)
        conn.commit()
        cur.close()

        progress['status'] = 'done'
    except Exception as e:
        conn.rollback()
        progress.update(status='error', error=str(e))
    finally:
        cur.close()
        conn.close()


def get_or_create_thumbnail(cache_key, candidate_paths):
    """Return the on-disk cache path for a thumbnail, extracting and downscaling
    embedded cover art from the first candidate file that has any, on first
    request. `candidate_paths` should be the track's own file first, followed
    by any album-mates' files to fall back to when this file itself embeds no
    art. Returns None if none of the candidates have artwork."""
    os.makedirs(ARTWORK_CACHE_DIR, exist_ok=True)
    cache_path = os.path.join(ARTWORK_CACHE_DIR, f"{cache_key}.jpg")
    if os.path.exists(cache_path):
        return cache_path

    # Negative cache: without this, every track in an album with no artwork
    # anywhere re-opens and re-parses every sibling file on every request
    # (only successes were cached before) - which is what made loading the
    # Missing Artwork tab, full of exactly these tracks, so slow.
    miss_marker = os.path.join(ARTWORK_CACHE_DIR, f"{cache_key}.missing")
    if os.path.exists(miss_marker):
        return None

    raw = None
    for file_path in candidate_paths:
        raw = _extract_raw_artwork(file_path)
        if raw:
            break
    if not raw:
        try:
            open(miss_marker, 'a').close()
        except OSError:
            pass
        return None

    try:
        image = Image.open(io.BytesIO(raw)).convert('RGB')
        image.thumbnail(THUMBNAIL_SIZE)
        image.save(cache_path, format='JPEG', quality=85)
    except Exception:
        return None

    return cache_path
