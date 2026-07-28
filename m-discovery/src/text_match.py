import re
from difflib import SequenceMatcher

# How close a search result's own title/artist must be to what we searched for
# before we trust it as a real match, rather than an unrelated track that
# happened to rank first (common for generic titles like "Intro" or "Home").
MATCH_THRESHOLD = 0.72


def _normalize(text):
    # [^a-z0-9]+ used to strip *any* non-ASCII character - not just
    # punctuation, but every Hebrew/Cyrillic/CJK/accented-Latin letter too,
    # collapsing e.g. a Hebrew title to an empty string. _similar() then
    # short-circuits to 0.0 whenever either side is empty, so two identical
    # Hebrew titles compared against each other still scored zero (confirmed
    # live). \w is Unicode-aware by default in Python 3's re module, so this
    # keeps letters from any script while still stripping real punctuation.
    if not text:
        return ''
    return re.sub(r'[^\w]+', ' ', text.lower()).strip()


def _similar(a, b):
    a, b = _normalize(a), _normalize(b)
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def _tokens_contained(needle_tokens, haystack_tokens):
    if not needle_tokens or not haystack_tokens or len(needle_tokens) > len(haystack_tokens):
        return False
    span = len(needle_tokens)
    return any(
        haystack_tokens[i:i + span] == needle_tokens
        for i in range(len(haystack_tokens) - span + 1)
    )


def _component_score(query_text, candidate_text):
    """1.0 if every token of query_text appears as a contiguous run inside
    candidate_text (both normalized), else falls back to a plain fuzzy
    ratio. A raw whole-string ratio penalizes a correct match in proportion
    to how much *extra* text surrounds it - which real-world candidate
    strings are full of (a YouTube video title like "Queen - Bohemian
    Rhapsody (Official Video Remastered)" scores low against a bare
    "Bohemian Rhapsody" on ratio alone, even though the query is exactly
    and unambiguously present). Containment catches that case at full
    confidence instead of quietly under-scoring it."""
    query_tokens = _normalize(query_text).split()
    candidate_tokens = _normalize(candidate_text).split()
    if _tokens_contained(query_tokens, candidate_tokens):
        return 1.0
    return _similar(query_text, candidate_text)
