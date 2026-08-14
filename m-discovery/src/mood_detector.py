import multiprocessing as mp
import os
import time
import urllib.request

import numpy as np

# Pretrained mood classifiers from Essentia/MTG (CC BY-NC-ND 4.0, non-commercial
# use only - fine for this personal library tool, but these model files
# shouldn't be redistributed). One shared embedding extractor
# (discogs-effnet) feeds five small classification heads, each a binary
# "is this mood or not" model trained independently on its own small in-house
# dataset - they don't calibrate against each other, so raw scores are
# persisted per mood rather than collapsed into one winner (see
# MOOD_SCORE_COLUMNS below) - the app decides per-mood thresholds at query
# time instead of this module guessing a single "the" mood per track.
# Confirmed live against real library tracks before wiring this up: a Sex
# Pistols punk track scored high on aggressive/party and low on
# relaxed/sad, as expected.
MODEL_BASE_URL = "https://essentia.upf.edu/models"
EMBEDDING_MODEL = "feature-extractors/discogs-effnet/discogs-effnet-bs64-1.pb"
# (classification-head path, output class index for "this mood applies") -
# confirmed live per-model, since the two-class output order is NOT
# consistent across heads (mood_happy is [happy, non_happy] but mood_sad is
# [non_sad, sad]) - assuming a shared order would silently invert some moods.
MOOD_HEADS = {
    'Happy': ("classification-heads/mood_happy/mood_happy-discogs-effnet-1.pb", 0),
    'Sad': ("classification-heads/mood_sad/mood_sad-discogs-effnet-1.pb", 1),
    'Aggressive': ("classification-heads/mood_aggressive/mood_aggressive-discogs-effnet-1.pb", 0),
    'Relaxed': ("classification-heads/mood_relaxed/mood_relaxed-discogs-effnet-1.pb", 1),
    'Party': ("classification-heads/mood_party/mood_party-discogs-effnet-1.pb", 1),
}

# Single source of truth for how each mood's raw score is stored/queried -
# shared with main.py so a mood name from a request always maps to the same
# column there as it does when this module writes it.
MOOD_SCORE_COLUMNS = {
    'Happy': 'mood_happy_score',
    'Sad': 'mood_sad_score',
    'Aggressive': 'mood_aggressive_score',
    'Relaxed': 'mood_relaxed_score',
    'Party': 'mood_party_score',
}

# Continuous valence/arousal, evaluated alongside (not instead of) the 5
# discrete heads above - a prototype for whether a 2D regression separates
# cases like Sad-vs-Relaxed (both low arousal; the discrete heads only
# distinguish them via two independently-calibrated binary classifiers)
# better than binary thresholds do. Separate embedding model (musicnn, not
# discogs-effnet) and its own emomusic-trained regression head, so this is
# tracked as its own backfill (mood_va_checked) rather than piggybacking on
# mood_checked - the two runs have nothing in common to reuse.
VA_EMBEDDING_MODEL = "feature-extractors/musicnn/msd-musicnn-1.pb"
VA_HEAD_MODEL = "classification-heads/emomusic/emomusic-msd-musicnn-2.pb"
# emomusic/DEAM-family models score on a 1-9 annotation scale (not 0-1 like
# the discrete heads' softmax outputs) - confirmed against Essentia's model
# docs. Rescaled to 0-1 at classify time so valence/arousal sit on the same
# scale as the other mood scores for UI sliders and storage.
VA_RAW_SCORE_MIN = 1.0
VA_RAW_SCORE_MAX = 9.0

VA_SCORE_COLUMNS = {
    'valence': 'mood_valence_score',
    'arousal': 'mood_arousal_score',
}

# Starting point only - these 5 heads are independently calibrated (confirmed
# live: with a single flat 0.5 "pick the winner" cutoff, 'Relaxed' alone hit
# 45% of the library, wildly disproportionate to the other four), so a flat
# 0.5 threshold here is not expected to produce comparable hit rates across
# moods. Callers can override per-request (see main.py's mood_threshold
# param) - once the whole library has real persisted scores, actual
# per-mood distributions can inform better defaults than this guess.
DEFAULT_MOOD_THRESHOLDS = {mood: 0.5 for mood in MOOD_HEADS}

MODEL_DIR = os.environ.get('MOOD_MODEL_DIR', '/app/mood_model_cache')

# ~3s/track (embedding extraction dominates, not model load) - at BATCH_SIZE
# tracks per wake, each cycle is a real chunk of CPU time, so a short sleep
# between cycles (not a long one, unlike spotify_track_matcher's API-rate-limit
# pacing - this job makes no external calls at all) still leaves the app
# responsive without needlessly slowing an already ~12-hour backfill further.
BATCH_SIZE = 5
CYCLE_SLEEP_SECONDS = 5
IDLE_POLL_INTERVAL_SECONDS = 30

_embed_model = None
_head_models = None
_va_embed_model = None
_va_head_model = None


MODEL_DOWNLOAD_TIMEOUT_SECONDS = 30


def _ensure_models():
    """Downloads the embedding extractor + mood classification heads into
    MODEL_DIR on first use, if not already cached there. ~21MB total across
    6 files - small enough to fetch lazily rather than baking into the
    Docker image and bloating every build. Confirmed live: urlretrieve has
    no timeout of its own, so a single stalled connection hung this whole
    background thread forever with 0% CPU and no error - every request here
    needs an explicit timeout, and a partial file from an interrupted
    download is removed rather than left behind to be mistaken for a
    complete one on the next run."""
    os.makedirs(MODEL_DIR, exist_ok=True)
    paths = {EMBEDDING_MODEL: None, VA_EMBEDDING_MODEL: None, VA_HEAD_MODEL: None}
    for mood, (rel_path, _idx) in MOOD_HEADS.items():
        paths[rel_path] = None
    for rel_path in paths:
        dest = os.path.join(MODEL_DIR, os.path.basename(rel_path))
        if not os.path.exists(dest):
            tmp_dest = dest + '.partial'
            try:
                with urllib.request.urlopen(f"{MODEL_BASE_URL}/{rel_path}", timeout=MODEL_DOWNLOAD_TIMEOUT_SECONDS) as resp, open(tmp_dest, 'wb') as f:
                    while True:
                        chunk = resp.read(1024 * 1024)
                        if not chunk:
                            break
                        f.write(chunk)
                os.rename(tmp_dest, dest)
            except Exception:
                if os.path.exists(tmp_dest):
                    os.remove(tmp_dest)
                raise
        paths[rel_path] = dest
    return paths


def _load_models():
    global _embed_model, _head_models, _va_embed_model, _va_head_model
    if _embed_model is not None:
        return
    import essentia
    # The per-call "No network created, or last created network has been
    # deleted" warning is Essentia's own internal noise on repeated
    # TensorflowPredict calls, not a real problem (confirmed live: results
    # stayed correct across repeated calls) - left on, it would flood the
    # app's logs for every one of ~14k tracks x 6 models.
    essentia.log.warningActive = False
    essentia.log.infoActive = False
    import essentia.standard as es

    paths = _ensure_models()
    _embed_model = es.TensorflowPredictEffnetDiscogs(
        graphFilename=paths[EMBEDDING_MODEL], output='PartitionedCall:1')
    _head_models = {
        mood: es.TensorflowPredict2D(graphFilename=paths[rel_path], output='model/Softmax')
        for mood, (rel_path, _idx) in MOOD_HEADS.items()
    }
    # musicnn's own embedding - the emomusic regression head was trained on
    # it, not on discogs-effnet's, so the two embeddings aren't
    # interchangeable despite both existing in this module.
    _va_embed_model = es.TensorflowPredictMusiCNN(
        graphFilename=paths[VA_EMBEDDING_MODEL], output='model/dense/BiasAdd')
    _va_head_model = es.TensorflowPredict2D(
        graphFilename=paths[VA_HEAD_MODEL], output='model/Identity')


def classify_track(file_path):
    """Real per-track mood scores from the audio itself - returns
    {mood_name: score} for all 5 heads, unfiltered. No winner-picking here;
    the caller (run(), then main.py's query filters) decides what counts as
    a match. Raises on a file that can't be loaded (missing, corrupt,
    unreadable format) - the caller decides how to record that."""
    _load_models()
    import essentia.standard as es

    audio = es.MonoLoader(filename=file_path, sampleRate=16000)()
    embeddings = _embed_model(audio)

    scores = {}
    for mood, (_rel_path, class_idx) in MOOD_HEADS.items():
        preds = _head_models[mood](embeddings)
        scores[mood] = float(np.mean(preds, axis=0)[class_idx])
    return scores


def classify_track_va(file_path):
    """Continuous valence/arousal for one track, rescaled from the model's
    native 1-9 scale to 0-1 so it sits on the same scale as the discrete
    mood scores. Same raises-on-unloadable-file contract as classify_track."""
    _load_models()
    import essentia.standard as es

    audio = es.MonoLoader(filename=file_path, sampleRate=16000)()
    embeddings = _va_embed_model(audio)
    preds = _va_head_model(embeddings)
    raw_valence, raw_arousal = np.mean(preds, axis=0)[:2]

    def _rescale(raw):
        span = VA_RAW_SCORE_MAX - VA_RAW_SCORE_MIN
        return float(np.clip((raw - VA_RAW_SCORE_MIN) / span, 0.0, 1.0))

    return {'valence': _rescale(raw_valence), 'arousal': _rescale(raw_arousal)}


def _classify_worker(task_q, result_q):
    """Runs in its own process so a crash inside essentia's native code stays
    contained here instead of taking down the whole app - confirmed live:
    an isolated-strings edit of a Beatles track (known_tracks id 7473)
    reliably segfaults _essentia.so, and since that happens before the row
    is ever marked mood_checked, it took the whole API down on every restart
    forever (same track is always first back up in the unordered LIMIT 1
    query)."""
    while True:
        task = task_q.get()
        if task is None:
            return
        kind, file_path = task
        classify_fn = classify_track_va if kind == 'va' else classify_track
        try:
            result_q.put(('ok', classify_fn(file_path)))
        except Exception as e:
            result_q.put(('error', str(e)))


class _IsolatedClassifier:
    """Keeps one persistent worker subprocess alive across calls (models are
    loaded once, not per track) and transparently respawns it if it dies -
    e.g. a segfault on a bad file. classify() then raises a normal Python
    exception for that one track instead of the whole process disappearing,
    which run()'s existing per-track except already turns into a skipped
    row rather than a retry loop."""

    def __init__(self):
        self._ctx = mp.get_context('spawn')
        self._proc = None
        self._task_q = None
        self._result_q = None

    def _ensure_started(self):
        if self._proc is not None and self._proc.is_alive():
            return
        self._task_q = self._ctx.Queue()
        self._result_q = self._ctx.Queue()
        self._proc = self._ctx.Process(
            target=_classify_worker, args=(self._task_q, self._result_q), daemon=True)
        self._proc.start()

    def _restart(self):
        if self._proc is not None:
            try:
                self._proc.kill()
                self._proc.join(timeout=5)
            except Exception:
                pass
        self._proc = None

    def classify(self, file_path, timeout=60, kind='mood'):
        self._ensure_started()
        self._task_q.put((kind, file_path))
        while True:
            try:
                status, payload = self._result_q.get(timeout=1)
                break
            except Exception:
                if not self._proc.is_alive():
                    self._restart()
                    raise RuntimeError(f'mood classifier worker crashed on {file_path}')
                timeout -= 1
                if timeout <= 0:
                    self._restart()
                    raise RuntimeError(f'mood classifier worker timed out on {file_path}')
        if status == 'error':
            raise RuntimeError(payload)
        return payload


_classifier = _IsolatedClassifier()


def _run_backfill(get_connection, progress, is_idle, checked_column, score_columns, classify):
    """Shared polling/backfill loop behind both run() (5 discrete mood heads)
    and run_va() (continuous valence/arousal) - same idle-gating, batching,
    per-row error isolation and DB-hiccup retry logic, parameterized only by
    which "checked" column marks a row done, which columns the scores land
    in, and which classifier fills them. Slowly works through known_tracks
    where checked_column IS NOT TRUE, BATCH_SIZE rows per cycle, only while
    the app is idle (no recent requests - see main.py's activity-tracking
    middleware). Unlike spotify_track_matcher, this makes no external calls
    at all - the only reason to gate on idleness is to avoid competing with
    live requests for CPU during the audio analysis, not to respect an API
    rate limit, so the pacing here is much less conservative. Runs in a
    background thread (started once at app startup if there's work to do)
    until the whole library is checked."""
    progress.update(status='running', processed=0, scored=0, error=None)

    while True:
        if not is_idle():
            progress['status'] = 'waiting_active_use'
            time.sleep(IDLE_POLL_INTERVAL_SECONDS)
            continue

        conn = get_connection()
        if conn is None:
            # A transient DB hiccup (confirmed live: this killed the whole
            # background thread permanently, with nothing left to restart
            # it) shouldn't be treated as fatal the way a genuinely
            # unrecoverable condition would be - back off and keep retrying
            # rather than giving up on the rest of the ~12-hour backfill.
            progress.update(status='waiting_db_error', error='Could not connect to the database - retrying')
            time.sleep(IDLE_POLL_INTERVAL_SECONDS)
            continue
        done = False
        try:
            for _ in range(BATCH_SIZE):
                cur = conn.cursor()
                cur.execute(f"""
                    SELECT id, file_path FROM known_tracks
                    WHERE {checked_column} IS NOT TRUE AND file_path IS NOT NULL
                    LIMIT 1
                """)
                row = cur.fetchone()
                cur.close()
                if row is None:
                    done = True
                    break

                track_id, file_path = row
                cur = conn.cursor()
                try:
                    scores = classify(file_path)
                    set_clause = ", ".join(f"{col} = %s" for col in score_columns.values())
                    cur.execute(
                        f"UPDATE known_tracks SET {set_clause}, {checked_column} = TRUE WHERE id = %s",
                        [scores[key] for key in score_columns] + [track_id],
                    )
                    progress['scored'] += 1
                except Exception as e:
                    # A file that can't be loaded (missing/corrupt/unsupported
                    # codec) would otherwise block this row forever - mark it
                    # checked with all scores left NULL rather than retrying
                    # it every cycle.
                    print(f"mood_detector: skipping track {track_id} ({file_path}): {e}")
                    cur.execute(f"UPDATE known_tracks SET {checked_column} = TRUE WHERE id = %s", (track_id,))
                conn.commit()
                cur.close()
                progress['processed'] += 1
            progress.update(status=('done' if done else 'running'), error=None)
        except Exception as e:
            # Same reasoning as spotify_track_matcher.run's except - an
            # uncaught exception here would silently kill this background
            # thread forever with no error ever recorded.
            progress.update(status='error', error=str(e))
        finally:
            conn.close()
        if done:
            return
        time.sleep(CYCLE_SLEEP_SECONDS)


def run(get_connection, progress, is_idle):
    """Backfills the 5 discrete mood head scores. See _run_backfill."""
    score_columns = {mood: MOOD_SCORE_COLUMNS[mood] for mood in MOOD_HEADS}
    _run_backfill(get_connection, progress, is_idle, 'mood_checked', score_columns, _classifier.classify)


def run_va(get_connection, progress, is_idle):
    """Backfills the continuous valence/arousal scores. See _run_backfill."""
    _run_backfill(get_connection, progress, is_idle, 'mood_va_checked', VA_SCORE_COLUMNS,
                  lambda file_path: _classifier.classify(file_path, kind='va'))
