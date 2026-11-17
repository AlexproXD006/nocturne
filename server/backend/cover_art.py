"""
Official album cover art lookup for NOVA / Nocturne.

Sources (both free, no API keys):
  * iTunes Search API  https://itunes.apple.com/search   (art up to 1400x1400 via mzstatic)
  * Deezer API         https://api.deezer.com/search     (album.cover_xl = 1000x1000)

Pipeline:
  clean_query(title, artist)  -> list[Guess]   (pure)
  search_itunes / search_deezer               (network, rate-limited, cached optional)
  score(candidate, guess, local_duration)     (pure)
  find_best_cover(...)                        -> Match (best candidate + confidence + decision)
  fetch_cover_bytes(url)                      (network, validated JPEG/PNG >= 500px)
  save_official_cover(track_id, data)         -> path of <covers_dir>/<track_id>.official.jpg
  auto_apply_cover(track, ...)                -> hook used after downloads/uploads (non-fatal)

Decision thresholds (see DECISION_* below):
  confidence >= APPLY_THRESHOLD   -> "apply"     (auto-applied by hooks / backfill --apply)
  confidence >= REVIEW_THRESHOLD  -> "review"    (only applied with --include-review)
  otherwise                       -> "no_match"
"""
from __future__ import annotations

import difflib
import hashlib
import io
import json
import logging
import os
import re
import threading
import time
import unicodedata
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

logger = logging.getLogger(__name__)

USER_AGENT = "Nocturne/1.0 (self-hosted music server)"
HTTP_TIMEOUT = 12
MAX_IMAGE_BYTES = 15 * 1024 * 1024
MIN_IMAGE_PX = 500
ITUNES_ART_SIZE = 1400

APPLY_THRESHOLD = 0.85
REVIEW_THRESHOLD = 0.60

DECISION_APPLY = "apply"
DECISION_REVIEW = "review"
DECISION_NO_MATCH = "no_match"

_ALLOWED_HOST_SUFFIXES = ("itunes.apple.com", ".mzstatic.com", "api.deezer.com", ".dzcdn.net")


# ─────────────────────────────────────────────────────────────────────────────
# Text normalisation
# ─────────────────────────────────────────────────────────────────────────────

_EMOJI_RE = re.compile(
    "[\U0001F000-\U0001FAFF☀-➿⬀-⯿️‍✀-➿]+"
)


def _strip_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def norm(s: Optional[str]) -> str:
    """Lowercase, accent-free, punctuation-free, single-spaced."""
    if not s:
        return ""
    s = unicodedata.normalize("NFKC", s)
    s = _strip_accents(s).lower()
    s = s.replace("&", " and ").replace("$", "s")
    s = re.sub(r"[^\w\s]", " ", s)
    s = s.replace("_", " ")
    return re.sub(r"\s+", " ", s).strip()


def _compact(s: str) -> str:
    """Normalised without spaces: 'C.R.O' == 'cro', 'YSY A' == 'ysya'."""
    return norm(s).replace(" ", "")


# ─────────────────────────────────────────────────────────────────────────────
# Query cleaning
# ─────────────────────────────────────────────────────────────────────────────

# Words that mark a bracket group as pure noise (removed entirely).
_NOISE_WORDS = (
    r"official|oficial|video|videoclip|v[ií]deo|audio|visuali[sz]er|lyrics?|letra|"
    r"prod\b|prod\.|produced|remaster(?:ed)?|\bhd\b|\b4k\b|\b8k\b|360|shot\s+by|dir\.?\s|"
    r"directed|clip|music\s+video|premiere|estreno|sub\s|subtitulad|explicit|"
    r"официальн|премьер|color\s+coded|full\s+song|mv\b|unreleased|adelanto|preview|snippet|\bia\b|\bai\b"
)
_NOISE_RE = re.compile(_NOISE_WORDS, re.I)

# Words that mark a *version* (kept as a tag; mismatches are penalised).
_VERSION_RE = re.compile(
    r"\b(remix|rmx|slowed|sped\s*up|speed\s*up|reverb|nightcore|live|en\s+vivo|"
    r"acoustic|ac[uú]stic[oa]|instrumental|karaoke|hard-?style|phonk|"
    r"spanish\s+version|english\s+version|versi[oó]n|edit|extended|mashup|cover)\b",
    re.I,
)

_FEAT_SPLIT_RE = re.compile(r"\s+(?:feat\.?|ft\.?|featuring|con)\s+", re.I)
_ARTIST_SPLIT_RE = re.compile(
    r"\s*,\s*|\s+&\s+|\s+(?:x|X|y|and|vs\.?)\s+|\s*[✖❌×]\s*|\s+(?:feat\.?|ft\.?|featuring)\s+",
)

_CHANNEL_RE = re.compile(
    r"(\bgenius\b|records?\b|\bmusic\b|\bmusica\b|\bmúsica\b|\btv\b|tv$|vevo|\btopic\b|"
    r"official|oficial|entertainment|studios?\b|productions?\b|\blyrics?\b|\bletras?\b|"
    r"\bchannel\b|\bnetwork\b|\bmedia\b|\bhits\b|\bradio\b|\bplanet\b|\bnation\b|"
    r"\bunknown artist\b|^na$|^various artists$|lemonade|stacion|soyuzmusic|\bdeejay channel\b)",
    re.I,
)

_TIMESTAMP_PREFIX_RE = re.compile(r"^\s*\d{10,14}[_\-\s]+")
_QUOTE_RE = re.compile(r"[\"“”«»＂]([^\"“”«»＂]{2,80})[\"“”«»＂]")
_BZRP_RE = re.compile(r"bzrp\s+music\s+sessions?\s*,?\s*(?:#|vol\.?\s*)?(\d+)", re.I)
_BZRP_SESSION_RE = re.compile(r"bzrp\s+(?:freestyle\s+)?sessions?\s*,?\s*(?:#|vol\.?\s*)?(\d+)", re.I)


def is_channel_artist(name: Optional[str]) -> bool:
    if not name:
        return True
    return bool(_CHANNEL_RE.search(name.strip()))


def split_artists(s: Optional[str]) -> list[str]:
    if not s:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for p in _ARTIST_SPLIT_RE.split(s):
        p = p.strip(" .-–—:|")
        if not p or len(p) > 60:
            continue
        k = _compact(p)
        if k and k not in seen:
            seen.add(k)
            out.append(p)
    return out


@dataclass
class Guess:
    title: str                      # cleaned core title (no feat., no noise; version kept out)
    artists: list[str]              # main artists first
    album_hint: Optional[str] = None
    versions: list[str] = field(default_factory=list)   # e.g. ["remix"], ["slowed"]
    label: str = ""                 # how this guess was derived (debugging)

    def key(self) -> tuple:
        return (norm(self.title), tuple(_compact(a) for a in self.artists[:2]))


def _canonical_versions(text: str) -> list[str]:
    out = []
    for m in _VERSION_RE.finditer(text or ""):
        v = m.group(1).lower()
        v = re.sub(r"\s+", " ", v)
        if v in ("rmx",):
            v = "remix"
        if v.startswith("sped") or v.startswith("speed"):
            v = "sped up"
        if v in ("en vivo",):
            v = "live"
        if v.startswith("ac") and v != "acoustic":
            v = "acoustic"
        if v.startswith("hard"):
            v = "hardstyle"
        if v == "reverb":
            v = "slowed"
        if v.startswith("versi") or v.endswith("version"):
            v = "version"
        if v not in out:
            out.append(v)
    return out


def _strip_brackets(text: str) -> tuple[str, list[str], list[str]]:
    """
    Remove bracket groups. Returns (text_without_groups, feat_artists, version_tags).
    Noise groups are dropped; feat groups yield artists; version groups yield tags.
    """
    feats: list[str] = []
    versions: list[str] = []

    def repl(m: re.Match) -> str:
        inner = m.group(1) or m.group(2) or ""
        fm = re.match(r"\s*(?:feat\.?|ft\.?|featuring|with|con)\s+(.+)", inner, re.I)
        if fm:
            feats.extend(split_artists(fm.group(1)))
            return " "
        v = _canonical_versions(inner)
        if v:
            versions.extend(x for x in v if x not in versions)
            return " "
        if _NOISE_RE.search(inner):
            return " "
        # Unknown group, e.g. "(Shot by Ballve)" caught above, "(ROAD TO ROUTE 66)" kept
        if re.search(r"\b(19|20)\d\d\b", inner) and len(inner) < 8:
            return " "
        return m.group(0)

    prev = None
    while prev != text:
        prev = text
        text = re.sub(r"\(([^()]*)\)|\[([^\[\]]*)\]", repl, text)
    return text, feats, versions


def _clean_piece(s: str) -> str:
    s = _EMOJI_RE.sub(" ", s)
    s = re.sub(r"[\"“”«»＂]", "", s)
    s = re.sub(r"\s+(19|20)\d\d\s*$", "", s)            # trailing year
    s = re.sub(r"\s+-\s*$|^\s*-\s+", "", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip(" -–—|:·.,")


def _split_feat(s: str) -> tuple[str, list[str]]:
    parts = _FEAT_SPLIT_RE.split(s, maxsplit=1)
    if len(parts) == 2:
        return parts[0].strip(), split_artists(parts[1])
    return s.strip(), []


def clean_query(title: Optional[str], artist: Optional[str], album: Optional[str] = None) -> list[Guess]:
    """
    Turn a messy YouTube/upload title + artist field into ranked (title, artists) guesses.
    The first guess is the most plausible one.
    """
    raw = unicodedata.normalize("NFKC", title or "")
    raw = raw.replace("⧸", "/").replace("｜", "|").replace("＂", '"')
    raw = re.sub(r"\s*(?:❌|✖️|✖|×)\s*", " x ", raw)
    raw = _TIMESTAMP_PREFIX_RE.sub("", raw)
    raw = re.sub(r"^\s*\d{1,3}\s*[.\-_)]\s+(?=\S)", "", raw)   # "11 - YSY A - GANAS"
    raw = re.sub(r"\.(mp3|m4a|flac|opus|ogg|wav|webm)$", "", raw, flags=re.I)
    raw = _EMOJI_RE.sub(" ", raw)
    raw = re.sub(r"(?<!\w)#(?!\d+\b)\w+", " ", raw)                     # #hashtags (keep "#29")
    raw = re.sub(r"(?<!\w)@(\w)", r"\1", raw)                        # @Handle -> Handle
    raw = re.sub(r"[.,]?\s+(?:prod\.?\s*(?:by)?|shot\s+by)\s*[^()\[\]|]*$", "", raw, flags=re.I)
    raw = re.sub(r"\s+", " ", raw).strip()

    local_artists = [] if is_channel_artist(artist) else split_artists(artist)
    album_hint = album.strip() if album and album.strip() else None

    guesses: list[Guess] = []

    def add(t: str, arts: Iterable[str], label: str, versions: list[str], alb: Optional[str] = None):
        t, feats_in_title = _split_feat(_clean_piece(t))
        t = _clean_piece(t)
        if not t or len(norm(t)) < 1:
            return
        arts_l: list[str] = []
        seen = set()
        for a in list(arts) + feats_in_title:
            a = _clean_piece(a)
            k = _compact(a)
            if k and not k.isdigit() and k not in seen and not is_channel_artist(a):
                seen.add(k)
                arts_l.append(a)
        g = Guess(title=t, artists=arts_l, album_hint=alb or album_hint, versions=list(versions), label=label)
        if all(x.key() != g.key() for x in guesses):
            guesses.append(g)

    text, feats, versions = _strip_brackets(raw)
    versions = versions + [v for v in _canonical_versions(text) if v not in versions]
    text = re.sub(r"\s+", " ", text).strip()

    # BZRP Music Sessions: "X || BZRP Music Sessions #29/66" -> "X: Bzrp Music Sessions, Vol. 29"
    bm = _BZRP_RE.search(text) or _BZRP_SESSION_RE.search(text)
    if bm:
        num = bm.group(1)
        guest = re.split(r"\s*\|+\s*|\s+-\s+", text[: bm.start()].strip())[0].strip(" |-")
        arts = ["Bizarrap"] + ([guest] if guest else [])
        kind = "Bzrp Music Sessions" if "music" in bm.group(0).lower() else "Bzrp Freestyle Sessions"
        if guest:
            add(f"{guest}: {kind}, Vol. {num}", arts, "bzrp", versions)
        add(f"{kind}, Vol. {num}", arts, "bzrp-short", versions)

    # "| Album" / "Artist | Title" handling
    pipe_parts = [p.strip() for p in re.split(r"\s*\|+\s*", text) if p.strip()]
    # " I EENFL" pseudo-pipe (capital I used as separator)
    if len(pipe_parts) == 1:
        m = re.match(r"(.+\s-\s.+?)\s+I\s+([A-Z0-9 ]{3,})$", text)
        if m:
            pipe_parts = [m.group(1), m.group(2)]

    bases: list[tuple[str, Optional[str], str]] = []  # (text, album_hint, label)
    if len(pipe_parts) >= 2:
        left, right = pipe_parts[0], " ".join(pipe_parts[1:])
        if re.search(r"\s[-–—]\s|[-–—]\s", left):
            bases.append((left, right, "pipe-album"))
        else:
            # "Anuel AA | KEII" -> artist | title ; also "Song | Something"
            bases.append((f"{left} - {right}", None, "pipe-artist-title"))
            bases.append((left, right, "pipe-album"))
    else:
        bases.append((text, None, "plain"))

    for base, alb, label in bases:
        # Quoted title: Kidd Keo - "Y Que Si No Hay Amor?" 2016  /  Duki "Vida Eterna"
        qm = _QUOTE_RE.search(base)
        dash_re = r"\s+[-–—]\s+|\s*[–—]\s*|(?<=\S)-\s+|\s+-(?=\S)"
        if qm and re.search(dash_re, base[: qm.start()]) and \
                not re.search(r"[-–—]\s*$", base[: qm.start()]):
            # 'Song - Ozuna & Juanka "El Problematik"': the quote is a nickname, not the title
            base = _QUOTE_RE.sub(lambda m: m.group(1), base)
            qm = None
        if qm:
            qtitle = qm.group(1)
            before = base[: qm.start()].strip(" -")
            after = base[qm.end():].strip(" -")
            before_arts = split_artists(_split_feat(before)[0]) + _split_feat(before)[1] if before else []
            after_arts = split_artists(after) if after else []
            arts = before_arts + after_arts + local_artists + feats
            add(qtitle, arts, label + "+quote", versions, alb)
            if before and after_arts:
                add(f"{before} {qtitle}", after_arts + local_artists + feats, label + "+quote-prefix", versions, alb)
            base = _QUOTE_RE.sub(lambda m: m.group(1), base)

        parts = [p.strip() for p in re.split(dash_re, base) if p.strip()]
        if len(parts) >= 2:
            first, last = parts[0], parts[-1]
            mid = parts[1:-1]
            f_main, f_feats = _split_feat(first)
            l_main, l_feats = _split_feat(last)
            # Decide orientation: which side contains a known local artist?
            first_has_local = any(_compact(a) in _compact(first) for a in local_artists) if local_artists else False
            last_has_local = any(_compact(a) in _compact(last) for a in local_artists) if local_artists else False
            orient = ["artist-title", "title-artist"]
            if last_has_local and not first_has_local:
                orient.reverse()
            for o in orient:
                if o == "artist-title":
                    arts = split_artists(f_main) + f_feats
                    for m_ in mid:  # "Lucho SSJ - Lucho SSJ ft. Duki - Title"
                        mm, mf = _split_feat(m_)
                        arts += split_artists(mm) + mf
                    add(last, arts + l_feats + local_artists + feats, label + "+" + o, versions, alb)
                else:
                    add(first, split_artists(l_main) + l_feats + f_feats + local_artists + feats,
                        label + "+" + o, versions, alb)
            if mid:
                add(mid[-1], split_artists(f_main) + local_artists + feats, label + "+mid", versions, alb)
        else:
            t_main, t_feats = _split_feat(base)
            add(t_main, local_artists + t_feats + feats, label + "+title-only", versions, alb)
            # "Turbulencias-Kabasaki,Juseph,..." (bare hyphen, no spaces)
            bm2 = re.match(r"^([^-]{2,60})-([^-]{2,})$", t_main)
            if bm2:
                add(bm2.group(1), split_artists(bm2.group(2)) + local_artists, label + "+bare-hyphen", versions, alb)
                add(bm2.group(2), split_artists(bm2.group(1)) + local_artists, label + "+bare-hyphen-rev", versions, alb)
    return guesses[:6]


# ─────────────────────────────────────────────────────────────────────────────
# HTTP (rate limited, retrying, optional on-disk JSON cache)
# ─────────────────────────────────────────────────────────────────────────────

class _RateLimiter:
    def __init__(self, min_interval: float):
        self.min_interval = min_interval
        self._lock = threading.Lock()
        self._next = 0.0

    def wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            if now < self._next:
                time.sleep(self._next - now)
            self._next = max(now, self._next) + self.min_interval


# iTunes documents ~20 calls/minute; Deezer allows 50 / 5 s. Stay well below both
# (and below ~5 req/s overall).
_LIMITERS = {
    "itunes": _RateLimiter(3.1),
    "deezer": _RateLimiter(0.35),
    "image": _RateLimiter(0.4),
}

_CACHE_DIR: Optional[Path] = None
_SESSION = None
_session_lock = threading.Lock()


def set_cache_dir(path: Optional[str]) -> None:
    """Enable an on-disk JSON cache for search responses (used by the backfill CLI)."""
    global _CACHE_DIR
    _CACHE_DIR = Path(path) if path else None
    if _CACHE_DIR:
        _CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _session():
    global _SESSION
    with _session_lock:
        if _SESSION is None:
            import requests
            s = requests.Session()
            s.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json, image/*"})
            _SESSION = s
        return _SESSION


def _host_allowed(url: str) -> bool:
    from urllib.parse import urlparse
    u = urlparse(url)
    host = (u.hostname or "").lower()
    return u.scheme == "https" and any(host == s.lstrip(".") or host.endswith(s) for s in _ALLOWED_HOST_SUFFIXES)


def _http_get(url: str, params: dict, limiter: str, *, stream: bool = False, retries: int = 4):
    if not _host_allowed(url):
        raise ValueError(f"host not allowed: {url}")
    delay = 2.0
    last_exc: Optional[Exception] = None
    for attempt in range(retries):
        _LIMITERS[limiter].wait()
        try:
            r = _session().get(url, params=params, timeout=HTTP_TIMEOUT, stream=stream)
        except Exception as exc:  # network error
            last_exc = exc
            time.sleep(delay)
            delay *= 2
            continue
        if r.status_code in (403, 429) or r.status_code >= 500:
            # iTunes answers 403 when throttled
            ra = r.headers.get("Retry-After")
            wait = float(ra) if ra and ra.isdigit() else delay
            logger.info("cover_art: %s %s -> %s, backing off %.1fs", limiter, url, r.status_code, wait)
            r.close()
            time.sleep(min(wait, 60))
            delay = min(delay * 2, 60)
            last_exc = RuntimeError(f"HTTP {r.status_code}")
            continue
        return r
    raise last_exc or RuntimeError("request failed")


def _get_json(url: str, params: dict, limiter: str) -> dict:
    key = None
    if _CACHE_DIR:
        key = hashlib.sha1((url + "?" + json.dumps(params, sort_keys=True)).encode()).hexdigest()
        cp = _CACHE_DIR / f"{key}.json"
        if cp.exists():
            try:
                return json.loads(cp.read_text())
            except Exception:
                pass
    r = _http_get(url, params, limiter)
    if r.status_code != 200:
        return {}
    try:
        data = r.json()
    except ValueError:
        # iTunes sometimes returns text/javascript
        data = json.loads(r.text or "{}")
    if _CACHE_DIR and key:
        (_CACHE_DIR / f"{key}.json").write_text(json.dumps(data))
    return data


# ─────────────────────────────────────────────────────────────────────────────
# Sources
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class Candidate:
    source: str
    title: str
    artists: list[str]
    album: str
    duration_s: Optional[int]
    art_url_max: str
    art_px: int
    link: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def itunes_art_url(artwork_url_100: str, size: int = ITUNES_ART_SIZE) -> str:
    return re.sub(r"/\d+x\d+(bb|cc|sr)?\.(jpg|png|webp)$", f"/{size}x{size}bb.jpg", artwork_url_100)


def parse_itunes(data: dict) -> list[Candidate]:
    out = []
    for it in (data or {}).get("results", []) or []:
        if it.get("kind") != "song" or not it.get("artworkUrl100"):
            continue
        ms = it.get("trackTimeMillis")
        out.append(Candidate(
            source="itunes",
            title=it.get("trackName") or "",
            artists=split_artists(it.get("artistName") or ""),
            album=re.sub(r"\s+-\s+(Single|EP)$", "", it.get("collectionName") or ""),
            duration_s=int(round(ms / 1000)) if ms else None,
            art_url_max=itunes_art_url(it["artworkUrl100"]),
            art_px=ITUNES_ART_SIZE,
            link=it.get("trackViewUrl") or "",
        ))
    return out


def parse_deezer(data: dict) -> list[Candidate]:
    out = []
    for it in (data or {}).get("data", []) or []:
        alb = it.get("album") or {}
        art = alb.get("cover_xl") or alb.get("cover_big")
        if not art:
            continue
        artists = [(it.get("artist") or {}).get("name") or ""]
        for c in it.get("contributors") or []:
            if c.get("name") and c["name"] not in artists:
                artists.append(c["name"])
        out.append(Candidate(
            source="deezer",
            title=it.get("title") or "",
            artists=[a for a in artists if a],
            album=alb.get("title") or "",
            duration_s=it.get("duration"),
            art_url_max=art,
            art_px=1000 if alb.get("cover_xl") else 500,
            link=it.get("link") or "",
        ))
    return out


def search_itunes(term: str, countries: Iterable[str] = ("ES", "US"), limit: int = 10,
                  stop_when: Optional[Callable[[list[Candidate]], bool]] = None) -> list[Candidate]:
    """Search iTunes in each country in turn (stops early once `stop_when(cands)` is true)."""
    out: list[Candidate] = []
    for country in countries:
        data = _get_json("https://itunes.apple.com/search",
                         {"term": term, "entity": "song", "limit": limit, "country": country}, "itunes")
        out.extend(parse_itunes(data))
        if out and (stop_when is None or stop_when(out)):
            break
    return out


def search_deezer(query: Optional[str] = None, *, artist: Optional[str] = None,
                  track: Optional[str] = None, limit: int = 10) -> list[Candidate]:
    """Free-text (`query`) or advanced (`artist` + `track`) Deezer search."""
    if artist and track:
        q = f'artist:"{artist.replace(chr(34), "")}" track:"{track.replace(chr(34), "")}"'
    else:
        q = query or ""
    if not q.strip():
        return []
    data = _get_json("https://api.deezer.com/search", {"q": q, "limit": limit}, "deezer")
    return parse_deezer(data)


# ─────────────────────────────────────────────────────────────────────────────
# Scoring
# ─────────────────────────────────────────────────────────────────────────────

def _core_title(t: str) -> tuple[str, list[str]]:
    """Strip feat./versions/noise from a (candidate or guess) title; return (norm core, versions)."""
    t = re.sub(r"(\d+)\s*[/⧸]\s*\d+", r"\1", unicodedata.normalize("NFKC", t or ""))  # "#40/66" -> "40"
    s, _feats, versions = _strip_brackets(t)
    versions = versions + [v for v in _canonical_versions(s) if v not in versions]
    s = re.split(r"\s+-\s+", s)
    # "Song - Remix" / "Song - Live" style suffixes on store titles
    if len(s) > 1 and _canonical_versions(" ".join(s[1:])):
        s = s[:1]
    s = " ".join(s)
    s, _ = _split_feat(s)
    core = norm(s)
    for v in versions:
        core = re.sub(rf"\b{re.escape(norm(v))}\b", " ", core)
    core = re.sub(r"\b(remix|rmx|slowed|reverb|sped up|version)\b", " ", core)
    return re.sub(r"\s+", " ", core).strip(), versions


def title_similarity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    ca, cb = a.replace(" ", ""), b.replace(" ", "")
    if ca == cb:
        return 0.98
    seq = difflib.SequenceMatcher(None, ca, cb).ratio()
    ta, tb = set(a.split()), set(b.split())
    dice = 2 * len(ta & tb) / (len(ta) + len(tb)) if ta and tb else 0.0
    best = max(seq, dice)
    # containment ("bzrp music sessions vol 29" in "cro bzrp music sessions vol 29")
    short, long_ = (ta, tb) if len(ta) <= len(tb) else (tb, ta)
    if len(short) >= 2 and short <= long_:
        best = max(best, 0.80 + 0.15 * len(short) / len(long_))
    # numbers must agree (Vol. 29 vs Vol. 30, "HIIT 2" vs "HIIT")
    na = {x for x in ta if x.isdigit()}
    nb = {x for x in tb if x.isdigit()}
    if na != nb:
        best *= 0.55
    return min(best, 1.0)


def artist_overlap(cand_artists: list[str], guess_artists: list[str], raw_text: str = "") -> float:
    """1.0 if any main artist matches, 0.0 if none; 0.5 when the guess has no artists."""
    cands = [_compact(a) for a in cand_artists if a]
    if not cands:
        return 0.0
    guesses = [_compact(a) for a in guess_artists if a]
    raw_c = _compact(raw_text)
    best = 0.0
    for c in cands:
        for g in guesses:
            if not c or not g:
                continue
            if c == g:
                return 1.0
            r = difflib.SequenceMatcher(None, c, g).ratio()
            if r >= 0.86 or (min(len(c), len(g)) >= 4 and (c in g or g in c)):
                best = max(best, 0.9)
        # candidate artist literally appears in the raw local title ("DUKI x ...")
        if raw_c and len(c) >= 3 and c in raw_c:
            best = max(best, 0.9)
    if best:
        return best
    return 0.5 if not guesses else 0.0


_VIDEO_HINT_RE = re.compile(r"v[ií]deo|visuali[sz]er|videoclip|\bclip\b|\||｜|bzrp", re.I)


def duration_component(cand_s: Optional[int], local_s: Optional[int],
                       video: bool = False) -> tuple[float, Optional[int]]:
    """
    Duration agreement in [0,1]. With `video=True` (local file ripped from a music
    video) the local file may be LONGER than the release by an intro/outro/skit:
    up to +30s scores 0.7, up to +45s 0.5. A local file that is SHORTER than the
    release by more than 10s is never tolerated (edits, sped-up versions).
    """
    if not cand_s or not local_s:
        return 0.5, None
    d = abs(int(cand_s) - int(local_s))
    if video and d > 10 and int(local_s) > int(cand_s):
        if d <= 30:
            return 0.7, d
        if d <= 45:
            return 0.5, d
    if d <= 3:
        return 1.0, d
    if d <= 6:
        return 0.8, d
    if d <= 10:
        return 0.55, d
    if d <= 30:
        return 0.15, d
    return 0.0, d


def score(candidate: Candidate, guess: Guess, local_duration: Optional[int] = None,
          raw_text: str = "") -> tuple[float, dict]:
    """Return (confidence in [0,1], breakdown dict)."""
    g_core, _ = _core_title(guess.title)
    c_core, c_versions = _core_title(candidate.title)
    t = title_similarity(g_core, c_core)
    # also try candidate title with its artist names removed ("C.R.O: Bzrp Music Sessions...")
    stripped = c_core
    for a in candidate.artists:
        stripped = re.sub(rf"\b{re.escape(norm(a))}\b", " ", stripped)
    stripped = re.sub(r"\s+", " ", stripped).strip()
    if stripped and stripped != c_core:
        t = max(t, title_similarity(g_core, stripped))

    a = artist_overlap(candidate.artists, guess.artists, raw_text)
    video = bool(_VIDEO_HINT_RE.search(raw_text or ""))
    d, delta = duration_component(candidate.duration_s, local_duration, video)
    # the duration tolerance for videos only counts when title AND artist are exact
    if video and delta is not None and delta > 10 and (t < 0.97 or a < 0.9):
        d, delta = duration_component(candidate.duration_s, local_duration, False)

    conf = 0.45 * t + 0.30 * a + 0.25 * d
    album_bonus = 0.0
    if guess.album_hint and _compact(guess.album_hint) and _compact(guess.album_hint) in (
            _compact(candidate.album), _compact(re.sub(r"\s*[(\[].*$", "", candidate.album))):
        album_bonus = 0.05
    conf += album_bonus

    g_v = {v for v in guess.versions if v not in ("version", "edit")}
    c_v = {v for v in c_versions if v not in ("version", "edit")}
    version_mismatch = g_v != c_v
    if version_mismatch:
        conf -= 0.15

    # gates
    if version_mismatch:            # remix/live/slowed vs original: never auto-apply
        conf = min(conf, 0.80)
    if t < 0.6:
        conf = min(conf, 0.40)
    if a == 0.0:
        conf = min(conf, 0.65)
    if delta is not None and delta > 30:
        conf = min(conf, 0.70)
    conf = max(0.0, min(1.0, conf))
    return conf, {
        "title_sim": round(t, 3), "artist": round(a, 3), "duration": round(d, 3),
        "duration_delta": delta, "album_bonus": album_bonus, "version_mismatch": version_mismatch,
        "video_tolerance": bool(video and delta is not None and delta > 10 and d >= 0.5),
    }


def decide(confidence: float) -> str:
    if confidence >= APPLY_THRESHOLD:
        return DECISION_APPLY
    if confidence >= REVIEW_THRESHOLD:
        return DECISION_REVIEW
    return DECISION_NO_MATCH


@dataclass
class Match:
    decision: str
    confidence: float
    candidate: Optional[Candidate]
    guess: Optional[Guess]
    breakdown: dict = field(default_factory=dict)
    alternatives: list[dict] = field(default_factory=list)
    queries: list[str] = field(default_factory=list)
    error: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "decision": self.decision,
            "confidence": round(self.confidence, 3),
            "candidate": self.candidate.to_dict() if self.candidate else None,
            "guess": asdict(self.guess) if self.guess else None,
            "breakdown": self.breakdown,
            "alternatives": self.alternatives,
            "queries": self.queries,
            "error": self.error,
        }


def pick_best(cands: list[Candidate], guesses: list[Guess], local_duration: Optional[int],
              raw_text: str = "") -> tuple[Optional[Candidate], Optional[Guess], float, dict, list[dict]]:
    """Score every candidate against every guess; choose by confidence, then image size."""
    scored: list[tuple[float, int, Candidate, Guess, dict]] = []
    for c in cands:
        best = None
        for g in guesses:
            s, br = score(c, g, local_duration, raw_text)
            if best is None or s > best[0]:
                best = (s, g, br)
        if best:
            scored.append((best[0], c.art_px, c, best[1], best[2]))
    if not scored:
        return None, None, 0.0, {}, []
    # cross-source agreement bonus: the other source has a near-identical top hit
    scored.sort(key=lambda x: (-round(x[0], 2), -x[1]))
    top_s, _, top_c, top_g, top_b = scored[0]
    for s, _, c, _, _ in scored[1:]:
        if c.source != top_c.source and s >= REVIEW_THRESHOLD and \
                title_similarity(_core_title(c.title)[0], _core_title(top_c.title)[0]) >= 0.9 and \
                artist_overlap(c.artists, top_c.artists) >= 0.9 and \
                (c.duration_s is None or top_c.duration_s is None or abs(c.duration_s - top_c.duration_s) <= 3):
            top_b = dict(top_b, cross_source_agree=True)
            top_s = min(1.0, top_s + 0.04)
            break
    # prefer the larger image when confidences are within 0.02 of each other
    for s, px, c, g, b in scored[1:]:
        if px > top_c.art_px and s >= top_s - 0.02 and s >= REVIEW_THRESHOLD and \
                title_similarity(_core_title(c.title)[0], _core_title(top_c.title)[0]) >= 0.9:
            top_c, top_g, top_b = c, g, dict(b, cross_source_agree=top_b.get("cross_source_agree", False))
            break
    alts = []
    seen = set()
    for s, _, c, g, b in scored[:8]:
        k = (c.source, c.title, c.album)
        if k in seen:
            continue
        seen.add(k)
        alts.append({"source": c.source, "title": c.title, "artists": c.artists, "album": c.album,
                     "duration_s": c.duration_s, "confidence": round(s, 3), "art_url": c.art_url_max})
        if len(alts) >= 4:
            break
    return top_c, top_g, top_s, top_b, alts


def find_best_cover(title: Optional[str], artist: Optional[str], duration: Optional[int] = None,
                    album: Optional[str] = None, *, use_itunes: bool = True, use_deezer: bool = True) -> Match:
    """Run the full lookup for one track. Network errors are captured in Match.error."""
    guesses = clean_query(title, artist, album)
    if not guesses:
        return Match(DECISION_NO_MATCH, 0.0, None, None, error="empty title")
    raw_text = f"{title or ''} {artist or ''}"
    cands: list[Candidate] = []
    queries: list[str] = []
    errors: list[str] = []

    def good_enough(cs: list[Candidate]) -> bool:
        _, _, s, _, _ = pick_best(cs, guesses, duration, raw_text)
        return s >= APPLY_THRESHOLD

    if use_deezer:
        for g in guesses[:3]:
            try:
                if g.artists:
                    q = f'artist:"{g.artists[0]}" track:"{g.title}"'
                    queries.append("deezer:" + q)
                    cands += search_deezer(artist=g.artists[0], track=g.title)
                q = f"{g.artists[0]} {g.title}" if g.artists else g.title
                queries.append("deezer:" + q)
                cands += search_deezer(q)
            except Exception as exc:
                errors.append(f"deezer: {exc}")
            if good_enough(cands):
                break
    if use_itunes:
        # one iTunes query per track normally (it is heavily rate limited);
        # a second one only when nothing decent was found so far.
        for i, g in enumerate(guesses[:2]):
            if i == 1 and pick_best(cands, guesses, duration, raw_text)[2] >= REVIEW_THRESHOLD:
                break
            term = f"{g.artists[0]} {g.title}" if g.artists else g.title
            queries.append("itunes:" + term)
            try:
                cands += search_itunes(term, stop_when=lambda cs: pick_best(cs, guesses, duration, raw_text)[2] >= REVIEW_THRESHOLD)
            except Exception as exc:
                errors.append(f"itunes: {exc}")
    best_c, best_g, conf, br, alts = pick_best(cands, guesses, duration, raw_text)
    m = Match(decide(conf) if best_c else DECISION_NO_MATCH, conf, best_c, best_g or guesses[0],
              br, alts, queries, "; ".join(errors) or None)
    return m


# ─────────────────────────────────────────────────────────────────────────────
# Image download + storage
# ─────────────────────────────────────────────────────────────────────────────

def sniff_image(data: bytes) -> Optional[str]:
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    return None


def fetch_cover_bytes(url: str, min_px: int = MIN_IMAGE_PX) -> tuple[bytes, int, int, str]:
    """Download and validate a cover. Raises ValueError on anything unexpected."""
    r = _http_get(url, {}, "image", stream=True)
    if r.status_code != 200:
        raise ValueError(f"HTTP {r.status_code}")
    buf = io.BytesIO()
    for chunk in r.iter_content(65536):
        buf.write(chunk)
        if buf.tell() > MAX_IMAGE_BYTES:
            r.close()
            raise ValueError("image too large")
    data = buf.getvalue()
    mime = sniff_image(data)
    if not mime:
        raise ValueError("not a JPEG/PNG")
    from PIL import Image
    with Image.open(io.BytesIO(data)) as im:
        w, h = im.size
    if w < min_px or h < min_px:
        raise ValueError(f"image too small ({w}x{h})")
    return data, w, h, mime


def covers_dir() -> str:
    import database as db  # backend module
    return db._COVERS_DIR


def official_cover_path(track_id: str, base_dir: Optional[str] = None) -> str:
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", track_id)
    return str(Path(base_dir or covers_dir()) / f"{safe}.official.jpg")


def save_official_cover(track_id: str, data: bytes, base_dir: Optional[str] = None) -> str:
    """Write the image as JPEG to <covers_dir>/<track_id>.official.jpg (atomic). Returns the path."""
    dest = Path(official_cover_path(track_id, base_dir))
    dest.parent.mkdir(parents=True, exist_ok=True)
    if sniff_image(data) != "image/jpeg":
        from PIL import Image
        with Image.open(io.BytesIO(data)) as im:
            out = io.BytesIO()
            im.convert("RGB").save(out, format="JPEG", quality=92)
            data = out.getvalue()
    tmp = dest.with_suffix(".jpg.tmp")
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, dest)
    return str(dest)


# ─────────────────────────────────────────────────────────────────────────────
# Hook for new downloads / uploads
# ─────────────────────────────────────────────────────────────────────────────

def lookups_enabled() -> bool:
    if os.getenv("NOCTURNE_TESTING") == "1":
        return False
    return os.getenv("NOVA_COVER_LOOKUP", "1").lower() not in ("0", "false", "no", "off")


def auto_apply_cover(track: dict, *, fallback_title: Optional[str] = None,
                     raw_artist: Optional[str] = None) -> Optional[str]:
    """
    Look up official art for a freshly imported track and, only at the `apply`
    threshold, save it and point tracks.cover_path at it. Never raises.
    Returns the new cover path or None.
    """
    try:
        if not lookups_enabled():
            return None
        title = track.get("title") or ""
        if fallback_title and (not title or re.fullmatch(r"[0-9a-f]{32}", title)):
            title = fallback_title
        artist = track.get("artist") or raw_artist or ""
        m = find_best_cover(title, artist, track.get("duration"), track.get("album"))
        logger.info("cover_art: %s -> %s %.2f %s", title, m.decision, m.confidence,
                    m.candidate.title if m.candidate else "-")
        if m.decision != DECISION_APPLY or not m.candidate:
            return None
        data, _w, _h, _ = fetch_cover_bytes(m.candidate.art_url_max)
        path = save_official_cover(track["id"], data)
        import database as db
        with db.connect() as conn:
            conn.execute("UPDATE tracks SET cover_path = ? WHERE id = ?", (path, track["id"]))
        logger.info("cover_art: official cover set for %s (%s, was %s)", track["id"], path, track.get("cover_path"))
        return path
    except Exception as exc:
        logger.warning("cover_art: lookup failed for %s: %s", track.get("id"), exc)
        return None


def auto_apply_cover_async(track: dict, **kw) -> None:
    """Fire-and-forget version (daemon thread) so downloads/uploads are not delayed."""
    if not lookups_enabled():
        return
    threading.Thread(target=auto_apply_cover, args=(dict(track),), kwargs=kw,
                     daemon=True, name=f"cover-{str(track.get('id'))[:8]}").start()
