import re
from collections import Counter

GENRE_CLEANUP_COMMIT_EVERY = 200

# Consolidates known_tracks.genre from the ~116 distinct, heavily fragmented
# raw tag values actually found in this library (casing dupes, separator
# variants, ripper-default junk, an ID3 "General X" prefix convention, and a
# mojibake-corrupted Hebrew tag) down to a much smaller set of canonical
# families. Reviewed with the user before building - the handful of
# genuinely ambiguous calls (folding Hebrew "רוק" into plain Rock rather
# than Hebrew Rock; keeping "blues, jazz" as its own Blues/Jazz bucket
# instead of picking one side) were confirmed live, not guessed silently.
#
# Keys are matched case-insensitively after trimming, so future scans hitting
# any of these same raw tags (in any casing) get normalized the same way
# without needing a re-run of this table.
GENRE_MAP = {
    # --- Rock ---
    'rock': 'Rock', 'rock & roll': 'Rock', 'early rock & roll': 'Rock',
    'classic rock': 'Rock', 'hard rock': 'Rock', 'progressive rock': 'Rock',
    'grunge': 'Rock', 'general rock': 'Rock',
    'רוק': 'Rock',  # Hebrew for "Rock" - library already has a distinct,
    # much larger "Hebrew Rock" tag for the "this is Israeli rock" concept,
    # so a bare רוק reads as "Rock" tagged in Hebrew, not that distinction.

    # --- Alternative Rock ---
    'alternative': 'Alternative Rock', 'alt. rock': 'Alternative Rock',
    'alternrock': 'Alternative Rock', 'altrock': 'Alternative Rock',
    'general alternative': 'Alternative Rock', 'alternative & punk': 'Alternative Rock',
    'alternrock alt. rock': 'Alternative Rock', 'indie': 'Alternative Rock',
    'indie rock': 'Alternative Rock', 'britpop': 'Alternative Rock',
    'classic and alternative rock': 'Alternative Rock',
    'ambient alternative': 'Alternative Rock', 'punk rock': 'Alternative Rock',

    # --- Pop Rock (fused tag kept as its own bucket, not forced to one side) ---
    'rock/pop': 'Pop Rock', 'pop/rock': 'Pop Rock', 'rock / pop': 'Pop Rock',
    'pop, rock': 'Pop Rock', 'pop, rock, variété internationale': 'Pop Rock',

    # --- Pop ---
    'pop': 'Pop', 'popular': 'Pop',

    # --- Jazz / Blues, kept separate per explicit review ---
    'jazz': 'Jazz', 'vocal jazz': 'Jazz', 'jazz funk': 'Jazz',
    'jazz instrument': 'Jazz', 'general jazz': 'Jazz',
    'blues': 'Blues',
    'blues, jazz': 'Blues/Jazz',

    # --- Classical ---
    'classical': 'Classical', 'general classical': 'Classical',

    # --- Metal ---
    'metal': 'Metal', 'heavy metal': 'Metal',

    # --- R&B/Soul ---
    'r&b': 'R&B/Soul', 'r & b': 'R&B/Soul', 'soul': 'R&B/Soul',
    'soul and r&b': 'R&B/Soul',

    # --- Rap/Hip-Hop ---
    'rap': 'Rap/Hip-Hop', 'hip hop': 'Rap/Hip-Hop', 'rap & hip-hop': 'Rap/Hip-Hop',
    'rap/r&b': 'Rap/Hip-Hop',

    # --- Electronic ---
    'electronica/dance': 'Electronic', 'electronica': 'Electronic',
    'electronic': 'Electronic', 'techno': 'Electronic', 'house': 'Electronic',
    'club-house': 'Electronic',

    # --- Folk ---
    'folk': 'Folk', 'folk/rock': 'Folk', 'folk rock': 'Folk',
    'singer & songwriter': 'Folk', 'acoustic': 'Folk', 'pop-folk': 'Folk',
    'מוסיקה עממית': 'Folk',  # Hebrew: literally "folk music"

    # --- Country ---
    'country': 'Country', 'bluegrass': 'Country',

    # --- Soundtrack ---
    'soundtrack': 'Soundtrack', 'film soundtrack': 'Soundtrack',
    'o.s.t.': 'Soundtrack', 'ost/rock': 'Soundtrack',

    # --- Ambient/Chill ---
    'ambient': 'Ambient/Chill', 'new age': 'Ambient/Chill',
    'relaxation': 'Ambient/Chill', 'easy listening': 'Ambient/Chill',
    'lo-fi': 'Ambient/Chill',

    # --- Avant-Garde ---
    'avantgarde': 'Avant-Garde',

    # --- Hebrew/Israeli (music described as Israeli, not a specific style) ---
    'hebrew': 'Hebrew/Israeli', 'ישראלי': 'Hebrew/Israeli',
    'israeli': 'Hebrew/Israeli', 'israeli/hebrew': 'Hebrew/Israeli',
    'éùøàìé': 'Hebrew/Israeli',  # mojibake of ישראלי not fixable by the
    # generic latin1-roundtrip repair below (round-trips to invalid UTF-8
    # instead) - confirmed live, handled as an explicit literal instead.

    # --- Kept distinct, casing/whitespace normalized only ---
    'other': 'Other', 'misc': 'Other',  # "Misc" is the same non-answer as "Other"
    'hebrew rock': 'Hebrew Rock',
    'vocal': 'Vocal', 'reggae': 'Reggae', 'latin': 'Latin', 'world': 'World',
    'gospel': 'Gospel', 'childrens': 'Childrens', 'christmas': 'Christmas',
    'ballad': 'Ballad', 'big band': 'Big Band', 'live bootleg': 'Live Bootleg',
    'top 40': 'Top 40', 'retro': 'Retro', 'celtic': 'Celtic',
    'bossa nova': 'Bossa Nova', 'spanish guitar': 'Spanish Guitar',
    'variété française': 'Variété Française',

    # --- Junk placeholders carrying no real genre information -> empty ---
    'genre': None, 'default': None, 'unknown genre': None,
    'desconocido': None, 'general unclassifiable': None, '': None,
    '乐曲': None,  # Chinese: generic word for "music/tune", not a genre
    'guitar': None, 'flute': None,  # instrument-name ripper defaults
    'sound clip': None,
}


def _repair_mojibake(genre):
    """UTF-8 bytes that got reinterpreted as Latin-1 and re-saved as UTF-8 -
    round-tripping back through latin-1 recovers the original text.
    Confirmed live: the actual corrupted Hebrew tag in this library repairs
    cleanly this way, while genuinely Latin-1-range text (e.g. "Variété
    Française") fails the round-trip instead of being corrupted by it, so
    this is safe to apply unconditionally rather than needing a source
    language guess."""
    try:
        return genre.encode('latin1').decode('utf-8')
    except (UnicodeDecodeError, UnicodeEncodeError):
        return genre


def clean_genre(genre):
    """(new_genre, changed) - new_genre is None if genre is empty/junk, a
    canonical family name if genre matches a known variant (after mojibake
    repair and case/whitespace normalization), or the original value
    title-cased if it's genuinely novel (so an unrecognized future tag
    still gets consistent casing instead of being left as whatever a
    tagger happened to write, without forcing it into an existing family it
    may not actually belong to)."""
    if not genre:
        return None, False
    repaired = _repair_mojibake(genre)
    key = repaired.strip().lower()
    if key in GENRE_MAP:
        new_genre = GENRE_MAP[key]
        return new_genre, (new_genre != genre)
    normalized = repaired.strip()
    return normalized, (normalized != genre)


def clean_genres(get_connection, progress):
    """Walks every known track not yet checked by this job, normalizing its
    genre tag via clean_genre. Never loses the original - preserved in
    original_genre for any row this changes, so it's fully reversible.
    Same fast, non-idle-gated, single-pass shape as tag_cleanup.clean_tags
    (pure string work, no audio decode - a 14K+ row pass is seconds, not
    hours) - see _start_genre_cleanup_background in main.py."""
    progress.update(status='running', processed=0, total=0, fixed=0, error=None)

    conn = get_connection()
    if conn is None:
        progress.update(status='error', error='Could not connect to the database')
        return

    try:
        cur = conn.cursor()
        cur.execute("SELECT id, genre FROM known_tracks WHERE genre_cleanup_checked IS NOT TRUE")
        rows = cur.fetchall()
        cur.close()
        progress['total'] = len(rows)

        cur = conn.cursor()
        for track_id, genre in rows:
            new_genre, changed = clean_genre(genre)
            if changed:
                cur.execute("""
                    UPDATE known_tracks
                    SET genre = %s, original_genre = %s, genre_cleanup_checked = TRUE
                    WHERE id = %s
                """, (new_genre, genre, track_id))
                progress['fixed'] += 1
            else:
                cur.execute("UPDATE known_tracks SET genre_cleanup_checked = TRUE WHERE id = %s", (track_id,))
            progress['processed'] += 1
            if progress['processed'] % GENRE_CLEANUP_COMMIT_EVERY == 0:
                conn.commit()
        conn.commit()
        progress['status'] = 'done'
    except Exception as e:
        conn.rollback()
        progress.update(status='error', error=str(e))
    finally:
        cur.close()
        conn.close()


def _normalize_song_key(text):
    """Same normalization as main.py's DEDUP_NORM_TITLE_SQL/
    DEDUP_NORM_ARTIST_SQL (lowercased, non-alphanumeric collapsed to a
    single space, trimmed), reimplemented in Python here rather than
    imported since main.py imports database.py, not the other way around.
    Deliberately title+artist only, NOT album - unlike the "Best Quality"
    dedup, which scopes a duplicate to the same album on purpose, this is
    meant to catch the exact case that motivated it: the same recording
    appearing on several different albums/compilations, each tagged by
    whatever source ripped that particular copy."""
    return re.sub(r'[^a-z0-9]+', ' ', text.lower()).strip()


def consolidate_song_genres(get_connection, progress):
    """Confirmed live: the same recording (e.g. 10,000 Maniacs' "Because the
    Night (MTV Unplugged Version)") can appear on 3 different albums in this
    library, each carrying a different raw genre tag from whatever ripped
    that particular copy - no per-file cleanup can fix that, since the
    files genuinely disagree. This groups tracks by normalized title+artist
    and, for any group whose members don't already agree on a genre, picks
    the majority genre within that group and applies it to every member.
    Deliberately NOT artist-level - confirmed live that would be wrong, not
    just imprecise (Eva Cassidy has ~45 tracks genuinely tagged Jazz and
    ~30 genuinely tagged Blues; forcing her whole catalog to one genre would
    erase a real distinction, not fix a tagging error the way unifying a
    single re-ripped song does).

    Ties are broken alphabetically by genre name - arbitrary but
    deterministic, so re-running this is idempotent rather than flipping
    the pick randomly. Only ever touches genre for a row whose value this
    changes; original_genre is left alone if already set (it should always
    reflect the true original file tag, not an intermediate cleanup value),
    and set to the pre-consolidation genre otherwise."""
    progress.update(status='running', processed=0, groups_changed=0, tracks_changed=0, error=None)

    conn = get_connection()
    if conn is None:
        progress.update(status='error', error='Could not connect to the database')
        return

    try:
        cur = conn.cursor()
        cur.execute("SELECT id, track_name, artist_name, genre FROM known_tracks WHERE genre IS NOT NULL AND genre <> ''")
        rows = cur.fetchall()
        cur.close()
        progress['processed'] = len(rows)

        groups = {}
        for track_id, track_name, artist_name, genre in rows:
            key = (_normalize_song_key(track_name), _normalize_song_key(artist_name))
            groups.setdefault(key, []).append((track_id, genre))

        cur = conn.cursor()
        update_count = 0
        for members in groups.values():
            genres_present = {genre for _id, genre in members}
            if len(genres_present) <= 1:
                continue  # already agree - nothing to consolidate
            counts = Counter(genre for _id, genre in members)
            best_count = max(counts.values())
            winner = min(g for g, c in counts.items() if c == best_count)  # alphabetical tie-break
            for track_id, genre in members:
                if genre != winner:
                    cur.execute("""
                        UPDATE known_tracks
                        SET genre = %s, original_genre = COALESCE(original_genre, %s)
                        WHERE id = %s
                    """, (winner, genre, track_id))
                    update_count += 1
                    if update_count % GENRE_CLEANUP_COMMIT_EVERY == 0:
                        conn.commit()
            progress['groups_changed'] += 1
        progress['tracks_changed'] = update_count
        conn.commit()
        progress['status'] = 'done'
    except Exception as e:
        conn.rollback()
        progress.update(status='error', error=str(e))
    finally:
        cur.close()
        conn.close()
