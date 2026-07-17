import re

TAG_CLEANUP_COMMIT_EVERY = 200

# Real song titles essentially never start with "digits, then a dash or
# period, then a space" - that shape is a ripper/tagger artifact (a leftover
# track-number prefix baked into the title tag itself), so this is safe to
# strip unconditionally, not just when the artist field looks bogus.
LEADING_TRACK_NUMBER_RE = re.compile(r'^\s*\d{1,3}\s*[-.]\s+')

# Requires a space on at least one side of the hyphen, so a genuinely
# hyphenated word in a title ("Sci-Fi", "T-Bone") never gets split - only
# triggered when the artist field already looks bogus (see _is_bogus_artist),
# so the risk of misreading a correctly-tagged title is low to begin with.
ARTIST_TITLE_SPLIT_RE = re.compile(r'^(.+?)(?:\s+-\s*|\s*-\s+)(.+)$')

BOGUS_ARTIST_LITERALS = {'artist', 'unknown', 'unknown artist', 'various', 'various artists'}


def _is_bogus_artist(artist_name):
    if not artist_name or not artist_name.strip():
        return True
    stripped = artist_name.strip()
    if stripped.isdigit():
        return True
    lowered = stripped.lower()
    if lowered in BOGUS_ARTIST_LITERALS:
        return True
    # Covers truncated compilation tags like "Various - All Times Greatest H"
    if lowered.startswith('various -') or lowered.startswith('various artists -'):
        return True
    return False


def clean_track_tags(track_name, artist_name):
    """Returns (new_track_name, new_artist_name, changed, still_bogus).

    still_bogus is True only when the artist field looked bogus and no
    artist/title split could be recovered from the title (e.g. fully generic
    placeholder tags like "Track 05" by "artist") - those are left as-is
    rather than guessed at, and reported separately so they're not silently
    conflated with tracks that got fixed.
    """
    working_name = (track_name or '').strip()
    new_artist_name = artist_name

    stripped_name = LEADING_TRACK_NUMBER_RE.sub('', working_name, count=1).strip()
    if stripped_name:
        working_name = stripped_name

    bogus = _is_bogus_artist(artist_name)
    if bogus:
        match = ARTIST_TITLE_SPLIT_RE.match(working_name)
        if match:
            candidate_artist, candidate_title = match.group(1).strip(), match.group(2).strip()
            if candidate_artist and candidate_title:
                new_artist_name = candidate_artist
                working_name = candidate_title

    still_bogus = _is_bogus_artist(new_artist_name)
    changed = (working_name != (track_name or '').strip()) or (new_artist_name != artist_name)
    return working_name, new_artist_name, changed, still_bogus


def clean_tags(get_connection, progress):
    """Walks every known track not yet checked by this job, fixing a leftover
    track-number prefix in the title and, where the artist field looks bogus
    (a track number, a truncated "Various..." compilation tag, or a literal
    placeholder), attempting to recover the real artist/title split out of
    the title field. Never overwrites a row it can't confidently improve -
    original values are preserved in original_track_name/original_artist_name
    for any row it does change, so this is fully reversible.

    Runs in the background since a 14K+ row pass, even at pure-Python regex
    speed, is enough to want progress reporting rather than blocking a
    request - see _start_tag_cleanup_background in main.py.
    """
    progress.update(status='running', processed=0, total=0, fixed=0, unrecoverable=0, error=None)

    conn = get_connection()
    if conn is None:
        progress.update(status='error', error='Could not connect to the database')
        return

    try:
        cur = conn.cursor()
        cur.execute("SELECT id, track_name, artist_name FROM known_tracks WHERE tag_cleanup_checked IS NOT TRUE")
        rows = cur.fetchall()
        cur.close()
        progress['total'] = len(rows)

        cur = conn.cursor()
        for track_id, track_name, artist_name in rows:
            new_track_name, new_artist_name, changed, still_bogus = clean_track_tags(track_name, artist_name)
            if changed:
                # A tag fix can turn a previously-unmatchable track into a
                # matchable one (a bogus artist like "001" guaranteed a
                # search miss) - clear any prior Spotify check so it gets a
                # fresh shot with the corrected data, instead of staying
                # permanently cached as "no match" against the old bad tags.
                cur.execute("""
                    UPDATE known_tracks
                    SET track_name = %s, artist_name = %s,
                        original_track_name = %s, original_artist_name = %s,
                        tag_cleanup_checked = TRUE,
                        spotify_checked = FALSE, spotify_track_id = NULL,
                        spotify_url = NULL, spotify_album_art_url = NULL
                    WHERE id = %s
                """, (new_track_name, new_artist_name, track_name, artist_name, track_id))
                progress['fixed'] += 1
            else:
                cur.execute("UPDATE known_tracks SET tag_cleanup_checked = TRUE WHERE id = %s", (track_id,))
            if still_bogus:
                progress['unrecoverable'] += 1
            progress['processed'] += 1
            if progress['processed'] % TAG_CLEANUP_COMMIT_EVERY == 0:
                conn.commit()
        conn.commit()
        progress['status'] = 'done'
    except Exception as e:
        conn.rollback()
        progress.update(status='error', error=str(e))
    finally:
        cur.close()
        conn.close()
