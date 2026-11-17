"""
Automatic lyrics lookup from LRCLIB (https://lrclib.net — free, no API key).

Used by GET /v1/tracks/{id}/lyrics (lazy lookup) after the admin-curated
`v1_lyrics` table and the `.lrc` file next to the audio, by the download/upload
hooks (background) and by the backfill CLI (`python -m nocturne_api.lyrics_backfill`).

Pipeline (title cleaning and similarity scoring are reused from backend/cover_art.py):
  guesses   = [extra guesses (e.g. the official title/artists found by the cover
               backfill)] + cover_art.clean_query(title, artist)
  queries   = /api/get (exact track+artist+duration) for the best guesses,
              then /api/search?track_name=&artist_name=, then /api/search?q=
  candidate = every LRCLIB record, scored with cover_art.score()
  accept    = see `evaluate()` (duration window, artist, versions, threshold)
  choose    = synced > plain > instrumental (instrumental only if nothing accepted
              has lyrics); highest confidence within each tier.

Results are stored in nocturne.db table `v1_lyrics_auto` (migration v4):
  status 'found'        -> synced and/or plain lyrics
  status 'instrumental' -> LRCLIB says instrumental (cached forever, no refetch)
  status 'not_found'    -> nothing acceptable (refetched after NEGATIVE_TTL_DAYS)
Network errors / incomplete searches are never stored.

Lookups are disabled under NOCTURNE_TESTING=1 unless a test injects `_TRANSPORT`
(an httpx.MockTransport), and can be switched off with NOCTURNE_LYRICS_LOOKUP=0.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import sqlite3
import sys
import threading
import time
from concurrent.futures import Future
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Optional

import httpx

# NOVA backend modules (cover_art, database, ...) live in <server root>/backend.
_BACKEND_DIR = str(Path(__file__).resolve().parents[1] / "backend")
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import cover_art as ca  # noqa: E402  (title cleaning + similarity scoring)

logger = logging.getLogger(__name__)

BASE_URL = "https://lrclib.net"
USER_AGENT = "Nocturne/1.0 (https://github.com/AlexproXD006/nocturne)"
HTTP_TIMEOUT_S = 6.0
MIN_INTERVAL_S = 0.5          # <= 2 requests / second, process-wide
MAX_RETRIES = 2               # extra attempts on 429 / 5xx
BACKOFF_BASE_S = 2.0
BACKOFF_MAX_S = 20.0
MAX_REQUESTS_PER_TRACK = 8

ACCEPT_THRESHOLD = 0.80
MIN_TITLE_SIM = 0.85
MAX_DURATION_DELTA_S = 4
NEGATIVE_TTL_DAYS = 7
REQUEST_BUDGET_S = 5.0        # how long the HTTP endpoint waits for a lazy lookup
BACKGROUND_DEADLINE_S = 60.0  # overall budget of one lookup running in the background

STATUS_FOUND = "found"
STATUS_INSTRUMENTAL = "instrumental"
STATUS_NOT_FOUND = "not_found"
STATUS_ERROR = "error"        # never stored

# Optional httpx transport override (tests inject httpx.MockTransport here).
_TRANSPORT: Optional[httpx.BaseTransport] = None

_EMPTY = {"synced": None, "plain": None, "ttml": None}


# ─────────────────────────────────────────────────────────────────────────────
# Switches
# ─────────────────────────────────────────────────────────────────────────────

def lookups_enabled() -> bool:
    if _TRANSPORT is not None:
        return True
    if os.getenv("NOCTURNE_TESTING", "").strip().lower() in ("1", "true"):
        return False
    return os.getenv("NOCTURNE_LYRICS_LOOKUP", "1").strip().lower() not in ("0", "false", "no", "off")


# ─────────────────────────────────────────────────────────────────────────────
# HTTP (rate limited, retrying)
# ─────────────────────────────────────────────────────────────────────────────

class LrclibError(Exception):
    """Network failure / repeated 429 / 5xx: the search is incomplete."""


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
                now = time.monotonic()
            self._next = now + self.min_interval

    def reset(self) -> None:
        with self._lock:
            self._next = 0.0


_LIMITER = _RateLimiter(MIN_INTERVAL_S)
_client: Optional[httpx.Client] = None
_client_transport: Any = None
_client_lock = threading.Lock()


def _get_client() -> httpx.Client:
    global _client, _client_transport
    with _client_lock:
        if _client is None or _client_transport is not _TRANSPORT:
            kwargs: dict[str, Any] = {
                "timeout": HTTP_TIMEOUT_S,
                "headers": {"User-Agent": USER_AGENT, "Accept": "application/json"},
                "follow_redirects": True,
            }
            if _TRANSPORT is not None:
                kwargs["transport"] = _TRANSPORT
            _client = httpx.Client(**kwargs)
            _client_transport = _TRANSPORT
        return _client


def _sleep(seconds: float) -> None:  # patched in tests
    time.sleep(seconds)


def _http_get_json(path: str, params: dict, deadline: Optional[float] = None) -> Any:
    """GET BASE_URL+path. Returns parsed JSON, or None on 404. Raises LrclibError."""
    delay = BACKOFF_BASE_S
    last = "request failed"
    for attempt in range(MAX_RETRIES + 1):
        if deadline is not None and time.monotonic() >= deadline:
            raise LrclibError("deadline exceeded")
        _LIMITER.wait()
        try:
            r = _get_client().get(BASE_URL + path, params=params)
        except httpx.HTTPError as exc:
            last = f"{type(exc).__name__}: {exc}"
            r = None
        if r is not None:
            if r.status_code == 404:
                return None
            if r.status_code == 200:
                try:
                    return r.json()
                except ValueError as exc:
                    raise LrclibError(f"bad JSON: {exc}") from exc
            if r.status_code != 429 and r.status_code < 500:
                # 400 etc.: the query itself is unusable; treat as "no result"
                logger.info("lyrics_auto: %s %s -> HTTP %s", path, params, r.status_code)
                return None
            last = f"HTTP {r.status_code}"
            ra = r.headers.get("Retry-After", "")
            if ra.isdigit():
                delay = max(delay, float(ra))
        if attempt >= MAX_RETRIES:
            break
        wait = min(delay, BACKOFF_MAX_S)
        if deadline is not None and time.monotonic() + wait >= deadline:
            break
        logger.info("lyrics_auto: %s -> %s, backing off %.1fs", path, last, wait)
        _sleep(wait)
        delay = min(delay * 2, BACKOFF_MAX_S)
    raise LrclibError(last)


# ─────────────────────────────────────────────────────────────────────────────
# Candidates, guesses, scoring
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class LrcRecord:
    id: Optional[int]
    title: str
    artist: str
    album: str
    duration_s: Optional[int]
    instrumental: bool
    synced: Optional[str]
    plain: Optional[str]

    @classmethod
    def from_api(cls, d: dict) -> "LrcRecord":
        dur = d.get("duration")
        synced = (d.get("syncedLyrics") or "").strip() or None
        plain = (d.get("plainLyrics") or "").strip() or None
        return cls(
            id=d.get("id"),
            title=d.get("trackName") or d.get("name") or "",
            artist=d.get("artistName") or "",
            album=d.get("albumName") or "",
            duration_s=int(round(float(dur))) if dur else None,
            instrumental=bool(d.get("instrumental")) and not synced and not plain,
            synced=synced,
            plain=plain,
        )

    @property
    def has_lyrics(self) -> bool:
        return bool(self.synced or self.plain)

    def as_candidate(self) -> "ca.Candidate":
        return ca.Candidate(source="lrclib", title=self.title, artists=ca.split_artists(self.artist),
                            album=self.album, duration_s=self.duration_s, art_url_max="", art_px=0)


@dataclass
class Evaluation:
    record: LrcRecord
    confidence: float
    accepted: bool
    reason: str
    guess: Optional["ca.Guess"]
    breakdown: dict = field(default_factory=dict)


def _to_guess(g: Any, label: str = "extra") -> Optional["ca.Guess"]:
    if isinstance(g, ca.Guess):
        return g
    if isinstance(g, dict) and g.get("title"):
        arts = g.get("artists") or []
        if isinstance(arts, str):
            arts = ca.split_artists(arts)
        _, versions = ca._core_title(g["title"])
        return ca.Guess(title=g["title"], artists=[a for a in arts if a], album_hint=g.get("album"),
                        versions=versions, label=g.get("label") or label)
    return None


def build_guesses(title: Optional[str], artist: Optional[str], album: Optional[str] = None,
                  extra_guesses: Optional[Iterable[Any]] = None) -> list["ca.Guess"]:
    """Extra (high quality) guesses first, then cover_art.clean_query() guesses, de-duplicated."""
    out: list[ca.Guess] = []
    for g in extra_guesses or []:
        gg = _to_guess(g)
        if gg and all(x.key() != gg.key() for x in out):
            out.append(gg)
    for g in ca.clean_query(title, artist, album):
        if all(x.key() != g.key() for x in out):
            out.append(g)
    return out


def _query_artist(g: "ca.Guess", local_artist: Optional[str]) -> Optional[str]:
    """The guess artist to query with: the library's own artist when the guess contains it
    (e.g. 'W Sound' rather than 'W Sound 10'), else the guess's main artist."""
    if not g.artists:
        return None
    if local_artist and not ca.is_channel_artist(local_artist):
        local = {ca._compact(a) for a in ca.split_artists(local_artist)}
        for a in g.artists:
            if ca._compact(a) in local:
                return a
    return g.artists[0]


def build_queries(guesses: list["ca.Guess"], duration: Optional[int],
                  local_artist: Optional[str] = None) -> list[tuple[str, dict]]:
    """Ordered, de-duplicated LRCLIB requests: /api/get, then search by fields, then q=."""
    qs: list[tuple[str, dict]] = []

    def add(path: str, params: dict) -> None:
        params = {k: v for k, v in params.items() if v not in (None, "")}
        if (path, params) not in qs:
            qs.append((path, params))

    with_artist = [g for g in guesses if g.artists]
    for g in with_artist[:2]:
        add("/api/get", {"track_name": g.title, "artist_name": _query_artist(g, local_artist),
                         "duration": int(duration) if duration else None})
    for g in with_artist[:3]:
        add("/api/search", {"track_name": g.title, "artist_name": _query_artist(g, local_artist)})
    for g in guesses[:2]:
        a = _query_artist(g, local_artist)
        add("/api/search", {"q": f"{g.title} {a}" if a else g.title})
    return qs


def _title_is_artist(g: "ca.Guess", cand: "ca.Candidate") -> bool:
    """A reversed guess ('DUKI - Celosa' read as title 'DUKI') would otherwise match any
    song of that artist through cover_art's containment rule: skip it."""
    t = ca._compact(g.title)
    return bool(t) and any(t == ca._compact(a) for a in g.artists)


def evaluate(rec: LrcRecord, guesses: list["ca.Guess"], local_duration: Optional[int],
             raw_text: str = "") -> Evaluation:
    """
    Score one LRCLIB record against all guesses (best guess wins) and decide acceptance:
      * |Δduration| <= MAX_DURATION_DELTA_S when both durations are known;
        with an unknown duration only a very strong title (>= 0.95) + artist (>= 0.9) match;
      * the artist must match (>= 0.9); a guess without artists only with an exact
        title (>= 0.97) and |Δduration| <= 2s;
      * title similarity >= MIN_TITLE_SIM, and guesses whose "title" is really an
        artist name (reversed 'Artist - Title') are ignored;
      * no version mismatch (remix / live / slowed / instrumental ...);
      * confidence >= ACCEPT_THRESHOLD.
    """
    cand = rec.as_candidate()
    best: Optional[tuple[float, ca.Guess, dict]] = None
    for g in guesses:
        if _title_is_artist(g, cand):
            continue
        s, br = ca.score(cand, g, local_duration, raw_text)
        if best is None or s > best[0]:
            best = (s, g, br)
    if best is None:
        return Evaluation(rec, 0.0, False, "no guesses", None)
    conf, guess, br = best
    t, a = br.get("title_sim", 0.0), br.get("artist", 0.0)
    delta = (abs(int(rec.duration_s) - int(local_duration))
             if rec.duration_s and local_duration else None)
    br = dict(br, duration_delta=delta)

    reason = "ok"
    if t < MIN_TITLE_SIM:
        reason = f"title similarity {t:.2f} < {MIN_TITLE_SIM}"
    elif delta is not None and delta > MAX_DURATION_DELTA_S:
        reason = f"duration delta {delta}s > {MAX_DURATION_DELTA_S}s"
    elif delta is None and not (t >= 0.95 and a >= 0.9):
        reason = "duration unknown and title/artist not exact"
    elif br.get("version_mismatch"):
        reason = "version mismatch"
    elif a < 0.9 and not (a >= 0.5 and not guess.artists and t >= 0.97 and delta is not None and delta <= 2):
        reason = "artist mismatch"
    elif conf < ACCEPT_THRESHOLD:
        reason = f"confidence {conf:.2f} < {ACCEPT_THRESHOLD}"
    elif not rec.has_lyrics and not rec.instrumental:
        reason = "record has no lyrics"
    return Evaluation(rec, conf, reason == "ok", reason, guess, br)


def choose(evals: list[Evaluation]) -> Optional[Evaluation]:
    """synced > plain > instrumental; highest confidence within a tier."""
    acc = [e for e in evals if e.accepted]
    for tier in (lambda e: bool(e.record.synced),
                 lambda e: bool(e.record.plain),
                 lambda e: e.record.instrumental):
        pool = [e for e in acc if tier(e)]
        if pool:
            return max(pool, key=lambda e: (round(e.confidence, 3), -(e.breakdown.get("duration_delta") or 0)))
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Lookup
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class LookupResult:
    status: str
    synced: Optional[str] = None
    plain: Optional[str] = None
    source: str = "lrclib"
    matched_title: Optional[str] = None
    matched_artist: Optional[str] = None
    lrclib_id: Optional[int] = None
    confidence: float = 0.0
    error: Optional[str] = None
    queries: list[str] = field(default_factory=list)
    guess_label: Optional[str] = None
    breakdown: dict = field(default_factory=dict)
    best_rejected: Optional[dict] = None

    @property
    def storable(self) -> bool:
        return self.status in (STATUS_FOUND, STATUS_INSTRUMENTAL, STATUS_NOT_FOUND)

    def response(self) -> dict:
        return _response(self.status, self.synced, self.plain)

    def to_report(self) -> dict:
        return {
            "decision": self.status,
            "confidence": round(self.confidence, 3),
            "matched_title": self.matched_title,
            "matched_artist": self.matched_artist,
            "lrclib_id": self.lrclib_id,
            "synced": bool(self.synced),
            "plain": bool(self.plain),
            "guess": self.guess_label,
            "breakdown": self.breakdown,
            "best_rejected": self.best_rejected,
            "queries": self.queries,
            "error": self.error,
        }


def lookup(track_row: dict, extra_guesses: Optional[Iterable[Any]] = None, *,
           raw_artist: Optional[str] = None, deadline_s: Optional[float] = BACKGROUND_DEADLINE_S
           ) -> LookupResult:
    """
    Look up lyrics for one track (`track_row` = NOVA track dict: title, artist, album,
    duration). Never raises: network trouble gives status 'error' (not to be stored).
    """
    title = track_row.get("title") or ""
    artist = track_row.get("artist") or raw_artist or ""
    duration = track_row.get("duration") or None
    try:
        duration = int(duration) if duration else None
    except (TypeError, ValueError):
        duration = None
    guesses = build_guesses(title, artist, track_row.get("album"), extra_guesses)
    if not guesses:
        return LookupResult(STATUS_NOT_FOUND, error="empty title")
    raw_text = f"{title} {artist}"
    deadline = time.monotonic() + deadline_s if deadline_s else None

    evals: list[Evaluation] = []
    seen_ids: set = set()
    queries: list[str] = []
    errors: list[str] = []

    def add_records(data: Any) -> None:
        items = data if isinstance(data, list) else ([data] if isinstance(data, dict) else [])
        for d in items:
            if not isinstance(d, dict):
                continue
            rec = LrcRecord.from_api(d)
            key = rec.id if rec.id is not None else (rec.title, rec.artist, rec.duration_s)
            if key in seen_ids:
                continue
            seen_ids.add(key)
            evals.append(evaluate(rec, guesses, duration, raw_text))

    for path, params in build_queries(guesses, duration, artist)[:MAX_REQUESTS_PER_TRACK]:
        best = choose(evals)
        if best and best.record.synced and best.confidence >= 0.9:
            break
        queries.append(f"{path}?{'&'.join(f'{k}={v}' for k, v in params.items())}")
        try:
            add_records(_http_get_json(path, params, deadline))
        except LrclibError as exc:
            errors.append(f"{path}: {exc}")
            if "deadline" in str(exc):
                break
        except Exception as exc:  # pragma: no cover - defensive
            errors.append(f"{path}: {type(exc).__name__}: {exc}")

    best = choose(evals)
    rejected = sorted((e for e in evals if not e.accepted), key=lambda e: -e.confidence)
    best_rej = None
    if rejected:
        e = rejected[0]
        best_rej = {"title": e.record.title, "artist": e.record.artist, "duration_s": e.record.duration_s,
                    "confidence": round(e.confidence, 3), "reason": e.reason, "lrclib_id": e.record.id}
    if best is None:
        # Only a complete search may be cached as negative.
        status = STATUS_ERROR if errors else STATUS_NOT_FOUND
        return LookupResult(status, queries=queries, error="; ".join(errors) or None,
                            guess_label=guesses[0].label, best_rejected=best_rej,
                            confidence=rejected[0].confidence if rejected else 0.0)
    rec = best.record
    status = STATUS_FOUND if rec.has_lyrics else STATUS_INSTRUMENTAL
    return LookupResult(
        status,
        synced=rec.synced if status == STATUS_FOUND else None,
        plain=rec.plain if status == STATUS_FOUND else None,
        matched_title=rec.title, matched_artist=rec.artist, lrclib_id=rec.id,
        confidence=best.confidence, queries=queries, error="; ".join(errors) or None,
        guess_label=best.guess.label if best.guess else None, breakdown=best.breakdown,
        best_rejected=best_rej,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Storage (nocturne.db, table v1_lyrics_auto — created by db.py migration v4)
# ─────────────────────────────────────────────────────────────────────────────

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _connect(conn: Optional[sqlite3.Connection]) -> tuple[sqlite3.Connection, bool]:
    if conn is not None:
        return conn, False
    from .db import connect
    return connect(), True


def get_auto(track_id: str, conn: Optional[sqlite3.Connection] = None) -> Optional[dict]:
    c, own = _connect(conn)
    try:
        c.row_factory = sqlite3.Row
        r = c.execute("SELECT * FROM v1_lyrics_auto WHERE track_id=?", (track_id,)).fetchone()
        return dict(r) if r else None
    finally:
        if own:
            c.close()


def store(track_id: str, res: LookupResult, conn: Optional[sqlite3.Connection] = None) -> bool:
    """Upsert a lookup result. Errors are never stored. Returns True when written."""
    if not res.storable:
        return False
    c, own = _connect(conn)
    try:
        c.execute(
            """INSERT OR REPLACE INTO v1_lyrics_auto
               (track_id, status, synced, plain, source, matched_title, matched_artist,
                lrclib_id, confidence, fetched_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (track_id, res.status, res.synced, res.plain if not res.synced else None, res.source,
             res.matched_title, res.matched_artist, res.lrclib_id, round(res.confidence, 4), _now()),
        )
        c.commit()
        return True
    finally:
        if own:
            c.close()


def is_fresh(row: dict, now: Optional[datetime] = None) -> bool:
    """found / instrumental never expire; not_found expires after NEGATIVE_TTL_DAYS."""
    if row.get("status") != STATUS_NOT_FOUND:
        return True
    try:
        at = datetime.fromisoformat(row.get("fetched_at") or "")
        if at.tzinfo is None:
            at = at.replace(tzinfo=timezone.utc)
    except ValueError:
        return False
    return (now or datetime.now(timezone.utc)) - at < timedelta(days=NEGATIVE_TTL_DAYS)


def _response(status: str, synced: Optional[str], plain: Optional[str]) -> dict:
    if status != STATUS_FOUND:
        return dict(_EMPTY)
    return {"synced": synced or None, "plain": None if synced else (plain or None), "ttml": None}


def response_from_row(row: dict) -> dict:
    return _response(row.get("status") or "", row.get("synced"), row.get("plain"))


# ─────────────────────────────────────────────────────────────────────────────
# Background execution with an in-flight guard
# ─────────────────────────────────────────────────────────────────────────────

_inflight: dict[str, Future] = {}
_inflight_lock = threading.RLock()
_workers = threading.BoundedSemaphore(2)


def _lookup_and_store(track: dict, extra_guesses: Optional[list], raw_artist: Optional[str]) -> LookupResult:
    with _workers:
        try:
            existing = get_auto(track["id"])
            if existing and is_fresh(existing):
                return LookupResult(existing["status"], synced=existing.get("synced"),
                                    plain=existing.get("plain"), matched_title=existing.get("matched_title"),
                                    matched_artist=existing.get("matched_artist"),
                                    lrclib_id=existing.get("lrclib_id"),
                                    confidence=existing.get("confidence") or 0.0)
        except Exception as exc:
            logger.warning("lyrics_auto: cannot read v1_lyrics_auto: %s", exc)
            return LookupResult(STATUS_ERROR, error=str(exc))
        res = lookup(track, extra_guesses, raw_artist=raw_artist)
        logger.info("lyrics_auto: %s %r -> %s %.2f %s", track.get("id"), track.get("title"),
                    res.status, res.confidence, res.matched_title or "-")
        if res.storable:
            try:
                store(track["id"], res)
            except Exception as exc:
                logger.warning("lyrics_auto: store failed for %s: %s", track.get("id"), exc)
        return res


def submit(track: dict, extra_guesses: Optional[list] = None, raw_artist: Optional[str] = None) -> Future:
    """Start (or join) the lookup for this track in a daemon thread. Returns a Future."""
    tid = str(track.get("id"))
    with _inflight_lock:
        fut = _inflight.get(tid)
        if fut is not None:
            return fut
        fut = Future()
        _inflight[tid] = fut

    def run() -> None:
        try:
            res = _lookup_and_store(dict(track), extra_guesses, raw_artist)
        except BaseException as exc:  # pragma: no cover - defensive
            res = LookupResult(STATUS_ERROR, error=f"{type(exc).__name__}: {exc}")
        finally:
            with _inflight_lock:
                _inflight.pop(tid, None)
        fut.set_result(res)

    threading.Thread(target=run, daemon=True, name=f"lyrics-{tid[:8]}").start()
    return fut


async def lookup_for_request(track: dict, budget_s: float = REQUEST_BUDGET_S) -> Optional[LookupResult]:
    """Lazy lookup for the HTTP endpoint: waits at most `budget_s`; the lookup keeps
    running (and stores its result) in the background if it takes longer."""
    if not lookups_enabled():
        return None
    try:
        fut = submit(track)
        return await asyncio.wait_for(asyncio.shield(asyncio.wrap_future(fut)), timeout=budget_s)
    except asyncio.TimeoutError:
        return None
    except Exception as exc:  # never fail the request
        logger.warning("lyrics_auto: lazy lookup failed for %s: %s", track.get("id"), exc)
        return None


def auto_fetch_async(track: dict, raw_artist: Optional[str] = None) -> None:
    """Fire-and-forget hook for new downloads / uploads. Never raises."""
    try:
        if not lookups_enabled() or not track.get("id"):
            return
        submit(track, raw_artist=raw_artist)
    except Exception as exc:  # pragma: no cover
        logger.warning("lyrics_auto: hook not started for %s: %s", track.get("id"), exc)


# .lrc files next to the audio. NOVA's downloader used to write UNSYNCED lyrics as a
# .lrc with invented timestamps every 10 s ("[00:00] ... [00:10] ...", header
# "[by:NOVA Music Server]"); those must not beat real LRCLIB sync.
LRC_USER = "user"            # hand-made / external .lrc: keeps priority over everything automatic
LRC_NOVA_SYNCED = "nova"     # written by NOVA with real timestamps: below v1_lyrics_auto
LRC_FAKE = "fake"            # NOVA's 10-s grid / no usable timing: plain text, last resort

_NOVA_LRC_HEADER_RE = re.compile(r"^\s*\[by:\s*NOVA Music Server\s*\]", re.I | re.M)
_LRC_TS_RE = re.compile(r"^\s*\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]")
_LRC_ANY_TS_RE = re.compile(r"\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]")
_LRC_TAG_RE = re.compile(r"^\s*\[[a-z]+:[^\]]*\]\s*$", re.I)


def classify_lrc(text: str) -> str:
    """LRC_USER, LRC_NOVA_SYNCED or LRC_FAKE (evenly spaced whole-second grid, e.g.
    every 10 s, or no timestamps at all)."""
    stamps: list[float] = []
    fractions = False
    for line in (text or "").splitlines():
        m = _LRC_TS_RE.match(line)
        if not m:
            continue
        stamps.append(int(m.group(1)) * 60 + int(m.group(2)) + (int(m.group(3)) / 10 ** len(m.group(3))
                                                                  if m.group(3) else 0))
        fractions = fractions or bool(m.group(3))
    nova = bool(_NOVA_LRC_HEADER_RE.search(text or ""))
    if not stamps:
        return LRC_FAKE
    deltas = {round(b - a, 3) for a, b in zip(stamps, stamps[1:])}
    grid = not fractions and len(stamps) >= 2 and len(deltas) == 1
    if grid or (nova and not fractions):
        return LRC_FAKE
    return LRC_NOVA_SYNCED if nova else LRC_USER


def lrc_plain_text(text: str) -> Optional[str]:
    lines = []
    for line in (text or "").splitlines():
        if _LRC_TAG_RE.match(line):
            continue
        line = _LRC_ANY_TS_RE.sub("", line).strip()
        if line:
            lines.append(line)
    return "\n".join(lines) or None


def read_lrc(file_path: Optional[str]) -> Optional[tuple[str, str]]:
    """(kind, text) of the .lrc next to the audio, or None. Never modifies the file."""
    if not file_path:
        return None
    try:
        p = Path(file_path).with_suffix(".lrc")
        if not p.exists():
            return None
        text = p.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return None
    return classify_lrc(text), text


def has_lrc_file(file_path: Optional[str]) -> bool:
    """True only for a .lrc that takes priority over automatic lyrics (a real,
    user-provided one). NOVA-generated .lrc files do not count."""
    r = read_lrc(file_path)
    return bool(r) and r[0] == LRC_USER


def empty_response() -> dict:
    return dict(_EMPTY)
