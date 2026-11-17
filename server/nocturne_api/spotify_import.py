"""
Spotify playlist import: background job that copies a user's Spotify playlist
into a Nocturne playlist, matching tracks against the library and (optionally)
downloading the missing ones from YouTube through NOVA's download manager.

Pipeline (one import at a time, progress persisted in v1_spotify_imports):
  reading      read ALL playlist entries (paginated /playlists/{id}/items)
               and create (or reuse) the Nocturne playlist right away
  matching     fuzzy match each Spotify track against `tracks` with
               backend/cover_art.py cleaning + scoring; only matches at or
               above cover_art.APPLY_THRESHOLD (0.85) without a version
               mismatch (remix/live/slowed...) are accepted
  downloading  unmatched tracks: YouTube search "<artists> - <title>", pick the
               result whose title/artist score high and whose duration is
               within ±15 s, then download_manager.download_youtube(); at most
               2 downloads in flight with a pause between starts
  done         playlist order = Spotify order (re-applied after each batch)

Restart behaviour: imports are not resumed. On startup every import still in
queued/reading/matching/downloading is marked `failed` with a clear reason.
Starting the same Spotify playlist again reuses the Nocturne playlist created
by the previous import (if it still exists), keeps what is already there and
only fills in the rest; tracks downloaded before the restart are found again
through v1_spotify_track_map / the library match, so nothing is downloaded twice.
"""
from __future__ import annotations

import asyncio
import re
import json
import logging
import secrets
import time
from datetime import datetime, timezone
from typing import Any, Optional

from . import config
from . import playlists as pl
from . import spotify
from .db import connect

import database as nova_db  # sys.path set by playlists.py
import cover_art as ca

logger = logging.getLogger("nocturne.spotify_import")

ACTIVE = ("queued", "reading", "matching", "downloading")
TERMINAL = ("done", "failed", "cancelled")
DURATION_TOLERANCE = 15            # seconds, YouTube result / downloaded file vs Spotify
YT_MIN_CONFIDENCE = 0.75
DOWNLOAD_TIMEOUT = 30 * 60         # per track
POLL_INTERVAL = 2.0
MAX_FAILURES_STORED = 1000
DESCRIPTION = "Importada de Spotify"

RESTART_REASON = ("El servidor se reinició durante la importación. Vuelve a importarla: "
                  "se reutilizará la misma playlist y no se descargará nada dos veces.")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_download_manager():
    """NOVA's DownloadManager singleton (tests monkeypatch this)."""
    from main import download_manager  # type: ignore
    return download_manager


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------

def _row(import_id: str) -> Optional[dict]:
    with connect() as conn:
        r = conn.execute("SELECT * FROM v1_spotify_imports WHERE id=?", (import_id,)).fetchone()
    return dict(r) if r else None


def to_wire(r: dict) -> dict:
    failures = json.loads(r.get("failures") or "[]")
    total = r["total"] or 0
    pending = max(0, total - (r["matched"] or 0) - (r["downloaded"] or 0) - (r["failed"] or 0))
    if r["status"] in TERMINAL:
        pending = 0
    obj = {
        "id": r["id"],
        "status": r["status"],
        "spotifyPlaylist": {"id": r["spotify_playlist_id"], "name": r["spotify_name"] or "",
                            "image": r["spotify_image"]},
        "playlistId": r["playlist_id"],
        "download": bool(r["download"]),
        "total": total,
        "matched": r["matched"] or 0,
        "downloaded": r["downloaded"] or 0,
        "failed": r["failed"] or 0,
        "pending": pending,
        "failures": failures,
        "createdAt": r["created_at"],
        "finishedAt": r["finished_at"],
    }
    if r.get("error"):
        obj["error"] = r["error"]
    return obj


def get(import_id: str, user_id: str) -> Optional[dict]:
    r = _row(import_id)
    if not r or r["user_id"] != user_id:
        return None
    return r


def list_for_user(user_id: str, offset: int = 0, limit: int = 50) -> tuple[list[dict], int]:
    with connect() as conn:
        total = conn.execute("SELECT COUNT(*) FROM v1_spotify_imports WHERE user_id=?",
                             (user_id,)).fetchone()[0]
        rows = conn.execute(
            "SELECT * FROM v1_spotify_imports WHERE user_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?",
            (user_id, limit, offset),
        ).fetchall()
    return [dict(r) for r in rows], total


def active_for(user_id: str, spotify_playlist_id: str) -> Optional[dict]:
    with connect() as conn:
        r = conn.execute(
            f"SELECT * FROM v1_spotify_imports WHERE user_id=? AND spotify_playlist_id=?"
            f" AND status IN ({','.join('?' * len(ACTIVE))}) ORDER BY created_at DESC LIMIT 1",
            (user_id, spotify_playlist_id, *ACTIVE),
        ).fetchone()
    return dict(r) if r else None


def create(user_id: str, spotify_playlist_id: str, name: str, image: Optional[str],
           download: bool) -> dict:
    import_id = "imp_" + secrets.token_hex(10)
    now = _now()
    with connect() as conn:
        conn.execute(
            """INSERT INTO v1_spotify_imports
               (id, user_id, status, spotify_playlist_id, spotify_name, spotify_image, download,
                created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)""",
            (import_id, user_id, "queued", spotify_playlist_id, name, image, 1 if download else 0,
             now, now),
        )
    return _row(import_id)


def cancel(import_id: str) -> None:
    now = _now()
    with connect() as conn:
        conn.execute(
            f"UPDATE v1_spotify_imports SET status='cancelled', finished_at=?, updated_at=?"
            f" WHERE id=? AND status IN ({','.join('?' * len(ACTIVE))})",
            (now, now, import_id, *ACTIVE),
        )


def recover_interrupted() -> int:
    """Called once at startup: imports can't survive a restart (see module doc)."""
    now = _now()
    with connect() as conn:
        cur = conn.execute(
            f"UPDATE v1_spotify_imports SET status='failed', error=?, finished_at=?, updated_at=?"
            f" WHERE status IN ({','.join('?' * len(ACTIVE))})",
            (RESTART_REASON, now, now, *ACTIVE),
        )
        return cur.rowcount or 0


def _status(import_id: str) -> Optional[str]:
    with connect() as conn:
        r = conn.execute("SELECT status FROM v1_spotify_imports WHERE id=?", (import_id,)).fetchone()
    return r[0] if r else None


def _cancelled(import_id: str) -> bool:
    return _status(import_id) in (None, "cancelled")


def _save(import_id: str, **fields: Any) -> None:
    """Persist progress. Never overwrites a cancellation."""
    if "failures" in fields and not isinstance(fields["failures"], str):
        fields["failures"] = json.dumps(fields["failures"][:MAX_FAILURES_STORED], ensure_ascii=False)
    fields["updated_at"] = _now()
    sets, args = [], []
    for k, v in fields.items():
        if k == "status":
            sets.append("status=CASE WHEN status='cancelled' THEN status ELSE ? END")
        else:
            sets.append(f"{k}=?")
        args.append(v)
    with connect() as conn:
        conn.execute(f"UPDATE v1_spotify_imports SET {', '.join(sets)} WHERE id=?", (*args, import_id))


def _map_get(spotify_ids: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    with connect() as conn:
        for i in range(0, len(spotify_ids), 500):
            chunk = spotify_ids[i:i + 500]
            rows = conn.execute(
                f"SELECT spotify_track_id, track_id FROM v1_spotify_track_map"
                f" WHERE spotify_track_id IN ({','.join('?' * len(chunk))})", chunk,
            ).fetchall()
            out.update({r[0]: r[1] for r in rows})
    return out


def _map_put(spotify_id: str, track_id: str, source: str) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO v1_spotify_track_map(spotify_track_id, track_id, source, created_at)"
            " VALUES (?,?,?,?)", (spotify_id, track_id, source, _now()),
        )


# ---------------------------------------------------------------------------
# Matching (pure functions on top of backend/cover_art.py)
# ---------------------------------------------------------------------------

def spotify_candidate(t: dict) -> ca.Candidate:
    ms = t.get("duration_ms")
    return ca.Candidate(
        source="spotify",
        title=t.get("name") or "",
        artists=[a.get("name") for a in t.get("artists") or [] if isinstance(a, dict) and a.get("name")],
        album=(t.get("album") or {}).get("name") or "",
        duration_s=int(round(ms / 1000)) if ms else None,
        art_url_max="",
        art_px=0,
    )


def _tokens(s: str) -> set[str]:
    return {w for w in ca.norm(s).split() if len(w) >= 2 or w.isdigit()}


class LibraryIndex:
    """Pre-cleaned view of the library for repeated matching."""

    def __init__(self, rows: list[dict]):
        self.entries: list[dict] = []
        for r in rows:
            self.add(r)

    def add(self, r: dict) -> None:
        title, artist, album = r.get("title") or "", r.get("artist") or "", r.get("album")
        guesses = ca.clean_query(title, artist, album)
        if not guesses:
            return
        raw = f"{title} {artist}"
        self.entries.append({
            "id": r["id"], "duration": r.get("duration"), "guesses": guesses, "raw": raw,
            "tokens": _tokens(f"{title} {album or ''}"), "compact": ca._compact(title),
        })

    def best(self, cand: ca.Candidate, exclude: set[str] = frozenset()) -> tuple[Optional[str], float, dict]:
        core, _ = ca._core_title(cand.title)
        ctoks = {w for w in core.split() if len(w) >= 2 or w.isdigit()}
        ccompact = core.replace(" ", "")
        best_id, best_s, best_b = None, 0.0, {}
        for e in self.entries:
            if e["id"] in exclude:
                continue
            if not (ctoks & e["tokens"]) and not (ccompact and ccompact in e["compact"]):
                continue
            for g in e["guesses"]:
                s, b = ca.score(cand, g, e["duration"], e["raw"])
                if s > best_s:
                    best_id, best_s, best_b = e["id"], s, b
        return best_id, best_s, best_b


def accept_library_match(score: float, breakdown: dict) -> bool:
    return score >= ca.APPLY_THRESHOLD and not breakdown.get("version_mismatch")


def pick_youtube(cand: ca.Candidate, results: list[dict]) -> Optional[dict]:
    """Best YouTube search result for a Spotify track, or None if none is safe."""
    best, best_key = None, None
    for r in results or []:
        dur = r.get("duration") or None
        if cand.duration_s and dur and abs(int(dur) - cand.duration_s) > DURATION_TOLERANCE:
            continue
        guesses = ca.clean_query(r.get("title") or "", r.get("channel") or "")
        raw = f"{r.get('title') or ''} {r.get('channel') or ''}"
        top_s, top_b = 0.0, {}
        for g in guesses:
            s, b = ca.score(cand, g, int(dur) if dur else None, raw)
            if s > top_s:
                top_s, top_b = s, b
        if not top_b or top_b.get("version_mismatch"):
            continue
        if top_b.get("title_sim", 0) < 0.8 or top_b.get("artist", 0) < 0.9:
            continue
        if not dur and top_s < ca.APPLY_THRESHOLD:
            continue
        if top_s < YT_MIN_CONFIDENCE:
            continue
        delta = abs(int(dur) - cand.duration_s) if (dur and cand.duration_s) else 99
        # prefer the artist's own channel / "Artist - Topic" / VEVO over re-uploads
        chan = ca._compact(r.get("channel") or "")
        official = int(bool(chan) and (chan.endswith("topic") or "vevo" in chan or any(
            ca._compact(a) and ca._compact(a) in chan for a in cand.artists)))
        key = (round(top_s, 2), official, -delta)
        if best_key is None or key > best_key:
            best, best_key = r, key
    return best


def _artists_str(cand: ca.Candidate) -> str:
    return ", ".join(cand.artists)


def _dedupe_key(cand: ca.Candidate) -> tuple:
    core, versions = ca._core_title(cand.title)
    return (core, ca._compact(cand.artists[0]) if cand.artists else "", tuple(sorted(versions)))


# ---------------------------------------------------------------------------
# NOVA library access (sync, run in threads)
# ---------------------------------------------------------------------------

def _all_tracks() -> list[dict]:
    conn = nova_db.connect()
    try:
        return [dict(r) for r in conn.execute(
            "SELECT id, title, artist, album, duration FROM tracks").fetchall()]
    finally:
        conn.close()


def _find_downloaded(video_title: str, known_before: set[str], claimed: set[str],
                     expected_s: Optional[int], spotify_title: str = "") -> tuple[Optional[dict], Optional[str]]:
    """Library row created by a finished YouTube download. Its title tag is the
    video title (or yt-dlp's `track` field for YouTube Music uploads, which is the
    plain song title); if the file already existed nothing new is created and the
    existing row with that title is used."""
    want = ca.norm(video_title)
    song = ca._core_title(spotify_title)[0] if spotify_title else ""
    if not want and not song:
        return None, "La descarga no devolvió título"
    cands = []
    for r in _all_tracks():
        if r["id"] in claimed:
            continue
        got = ca.norm(r.get("title") or "")
        if want and got == want:
            cands.append(r)
        elif r["id"] not in known_before and (
                (want and ca.title_similarity(got, want) >= 0.9)
                or (song and ca.title_similarity(ca._core_title(r.get("title") or "")[0], song) >= 0.9)):
            cands.append(r)
    if not cands:
        return None, "Descargada, pero no aparece en la biblioteca"
    if expected_s:
        cands.sort(key=lambda r: abs((r.get("duration") or 10**6) - expected_s))
        r = cands[0]
        if r.get("duration") and abs(r["duration"] - expected_s) > DURATION_TOLERANCE:
            return None, f"Duración descargada ({r['duration']} s) no coincide con Spotify ({expected_s} s)"
        return r, None
    return cands[0], None


# ---------------------------------------------------------------------------
# Worker
# ---------------------------------------------------------------------------

_worker_task: Optional[asyncio.Task] = None


def _next_queued() -> Optional[str]:
    with connect() as conn:
        r = conn.execute(
            "SELECT id FROM v1_spotify_imports WHERE status='queued' ORDER BY created_at LIMIT 1"
        ).fetchone()
    return r[0] if r else None


def ensure_worker() -> asyncio.Task:
    """Start the single import worker if it isn't running (call from the event loop)."""
    global _worker_task
    if _worker_task is None or _worker_task.done():
        _worker_task = asyncio.get_running_loop().create_task(_worker_loop())
    return _worker_task


async def _worker_loop() -> None:
    while True:
        import_id = _next_queued()     # sync: no await between "empty" and return
        if not import_id:
            return
        try:
            await run_import(import_id)
        except Exception as e:  # never leave an import stuck in a running state
            logger.exception("Spotify import %s crashed", import_id)
            _save(import_id, status="failed", error=f"Error interno: {type(e).__name__}",
                  finished_at=_now())


class _Run:
    def __init__(self, row: dict):
        self.id = row["id"]
        self.user_id = row["user_id"]
        self.download = bool(row["download"])
        self.total = 0
        self.matched = 0
        self.downloaded = 0
        self.failed = 0
        self.failures: list[dict] = []
        self.playlist_id: Optional[str] = None
        self.order: list[Optional[str]] = []          # track id per Spotify position
        self.lock = asyncio.Lock()

    def fail(self, cand: Optional[ca.Candidate], reason: str, raw: Optional[dict] = None) -> None:
        self.failed += 1
        if cand is not None:
            title, artists = cand.title, list(cand.artists)
        else:
            t = (raw or {}).get("item") or (raw or {}).get("track") or {}
            title = (t or {}).get("name") or "(desconocido)"
            artists = [a.get("name") for a in (t or {}).get("artists") or [] if isinstance(a, dict)]
        self.failures.append({"title": title, "artists": artists, "reason": reason})

    def counters(self) -> dict:
        return {"total": self.total, "matched": self.matched, "downloaded": self.downloaded,
                "failed": self.failed, "failures": self.failures}

    def save(self, **extra) -> None:
        _save(self.id, **self.counters(), **extra)


def _reusable_playlist(user_id: str, spotify_playlist_id: str, import_id: str) -> Optional[str]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT playlist_id FROM v1_spotify_imports WHERE user_id=? AND spotify_playlist_id=?"
            " AND playlist_id IS NOT NULL AND id<>? ORDER BY created_at DESC",
            (user_id, spotify_playlist_id, import_id),
        ).fetchall()
    for (pid,) in rows:
        if nova_db.get_playlist(pid) and pl.owner_of(pl.get_meta(pid)) == user_id:
            return pid
    return None


async def _sync_order(run: _Run) -> None:
    """Re-apply Spotify order; tracks the user added by hand stay at the end."""
    def work():
        current = pl.playlist_track_ids(run.playlist_id)
        cur = set(current)
        desired = [t for t in dict.fromkeys(x for x in run.order if x) if t in cur]
        ds = set(desired)
        new = desired + [t for t in current if t not in ds]
        if new != current:
            pl.set_order(run.playlist_id, new)
    async with run.lock:
        await asyncio.to_thread(work)


async def _add(run: _Run, track_ids: list[str]) -> None:
    async with run.lock:
        await asyncio.to_thread(pl.append_tracks, run.playlist_id, track_ids)
        pl.touch(run.playlist_id)


def _spotify_reason(e: spotify.SpotifyError) -> str:
    if isinstance(e, spotify.NotConnected):
        return "La cuenta de Spotify ya no está conectada; vuelve a conectarla."
    if e.status == 403:
        return ("Spotify no permite leer las canciones de esta playlist (en modo desarrollo solo "
                "se pueden leer playlists propias o colaborativas de la cuenta conectada).")
    if e.status == 404:
        return ("Spotify no deja leer esta playlist: ya no existe, es privada de otro usuario o es una "
                "playlist editorial/algorítmica de Spotify (p. ej. Descubrimiento semanal).")
    return f"Error de Spotify: {e}"


async def run_import(import_id: str) -> None:
    row = _row(import_id)
    if not row or row["status"] != "queued":
        return
    run = _Run(row)
    _save(import_id, status="reading", started_at=_now())

    # 1. read everything
    try:
        meta = await spotify.playlist_meta(run.user_id, row["spotify_playlist_id"])
        entries = await spotify.playlist_items(run.user_id, row["spotify_playlist_id"])
    except spotify.SpotifyError as e:
        _save(import_id, status="failed", error=_spotify_reason(e), finished_at=_now())
        return
    name = (meta.get("name") or row["spotify_name"] or "Spotify").strip()[:pl.NAME_MAX] or "Spotify"
    _save(import_id, spotify_name=name, spotify_image=spotify.best_image(meta.get("images")))
    if _cancelled(import_id):
        return

    items: list[tuple[str, ca.Candidate]] = []      # importable tracks in Spotify order
    seen_ids: set[str] = set()
    for e in entries:
        t, reason = spotify.entry_track(e)
        if t is None:
            run.total += 1
            run.fail(None, reason, e)
            continue
        if t["id"] in seen_ids:                     # same track twice in the playlist
            continue
        seen_ids.add(t["id"])
        items.append((t["id"], spotify_candidate(t)))
    run.total += len(items)
    run.order = [None] * len(items)

    # 2. create (or reuse) the Nocturne playlist immediately
    pid = await asyncio.to_thread(_reusable_playlist, run.user_id, row["spotify_playlist_id"], import_id)
    if pid is None:
        created = await asyncio.to_thread(pl.create, name, run.user_id, DESCRIPTION, [])
        pid = created["id"]
    run.playlist_id = pid
    run.save(playlist_id=pid, status="matching")

    # 3. match against the library
    library = await asyncio.to_thread(_all_tracks)
    known_before = {r["id"] for r in library}
    index = await asyncio.to_thread(LibraryIndex, library)
    mapped = await asyncio.to_thread(_map_get, [sid for sid, _ in items])
    claimed: set[str] = set()
    unmatched: list[int] = []

    def match_all():
        for i, (sid, cand) in enumerate(items):
            tid = mapped.get(sid)
            if tid and tid in known_before and tid not in claimed:
                run.order[i] = tid
                claimed.add(tid)
                continue
            tid, s, b = index.best(cand, claimed)
            if tid and accept_library_match(s, b):
                run.order[i] = tid
                claimed.add(tid)
                _map_put(sid, tid, "match")
            else:
                unmatched.append(i)

    await asyncio.to_thread(match_all)
    if _cancelled(import_id):
        return
    matched_ids = [t for t in run.order if t]
    run.matched = len(matched_ids)
    if matched_ids:
        await _add(run, matched_ids)
        await _sync_order(run)
    run.save()

    # 4. downloads
    if unmatched and not run.download:
        for i in unmatched:
            run.fail(items[i][1], "No está en la biblioteca (descarga desactivada)")
        unmatched = []
    if unmatched:
        run.save(status="downloading")
        try:
            dm = get_download_manager()
        except Exception:
            dm = None
        if dm is None:
            for i in unmatched:
                run.fail(items[i][1], "Descargas no disponibles en este servidor")
        else:
            await _download_all(run, dm, items, unmatched, known_before, claimed)
        if _cancelled(import_id):
            run.save()
            return
        await _sync_order(run)

    run.save(status="done", finished_at=_now())


async def _download_all(run: _Run, dm, items, unmatched: list[int], known_before: set[str],
                        claimed: set[str]) -> None:
    # Same song listed twice under different Spotify ids: download once.
    first_by_key: dict[tuple, int] = {}
    todo: list[int] = []
    for i in unmatched:
        k = _dedupe_key(items[i][1])
        if k in first_by_key:
            run.fail(items[i][1], "Duplicada: la misma canción ya está en esta importación")
            continue
        first_by_key[k] = i
        todo.append(i)
    run.save()

    sem = asyncio.Semaphore(config.spotify_import_concurrency())
    tasks: list[asyncio.Task] = []

    async def one(i: int) -> None:
        sid, cand = items[i]
        try:
            await _wait_throttle()
            reason = await _download_one(run, dm, i, sid, cand, known_before, claimed)
            if reason and _is_throttled(reason) and not _cancelled(run.id):
                # YouTube is rate-limiting this IP: pause every download, then retry once.
                _trip_throttle()
                await _wait_throttle()
                reason = await _download_one(run, dm, i, sid, cand, known_before, claimed)
        except Exception as e:
            logger.warning("import %s: download of %r failed: %s", run.id, cand.title, type(e).__name__)
            reason = f"Error al descargar: {type(e).__name__}"
        finally:
            sem.release()
        if reason:
            run.fail(cand, reason)
        else:
            run.downloaded += 1
        run.save()

    for n, i in enumerate(todo):
        await sem.acquire()
        if _cancelled(run.id):
            sem.release()
            break
        tasks.append(asyncio.create_task(one(i)))
        if n < len(todo) - 1 and config.SPOTIFY_IMPORT_DELAY > 0:
            await asyncio.sleep(config.SPOTIFY_IMPORT_DELAY)
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


THROTTLE_PAUSE = 90.0          # seconds every download waits after YouTube throttles us
_throttle_until = 0.0
_THROTTLE_RE = re.compile(r"429|too many requests|not a bot|sign in to confirm|http error 403", re.I)


def _is_throttled(reason: str) -> bool:
    return bool(_THROTTLE_RE.search(reason or ""))


def _trip_throttle() -> None:
    global _throttle_until
    until = time.monotonic() + THROTTLE_PAUSE
    if until > _throttle_until:
        _throttle_until = until
        logger.warning("YouTube is throttling downloads; pausing imports for %ds", int(THROTTLE_PAUSE))


async def _wait_throttle() -> None:
    while True:
        left = _throttle_until - time.monotonic()
        if left <= 0:
            return
        await asyncio.sleep(min(left, 5.0))


async def _download_one(run: _Run, dm, i: int, sid: str, cand: ca.Candidate,
                        known_before: set[str], claimed: set[str]) -> Optional[str]:
    """Returns None on success, else a failure reason."""
    query = f"{_artists_str(cand)} - {cand.title}" if cand.artists else cand.title
    results = await dm.search_youtube(query)
    choice = pick_youtube(cand, results)
    if not choice:
        return "No se encontró en YouTube una versión que coincida (título, artista y duración)"
    if _cancelled(run.id):
        return "Cancelada"
    job_id = await dm.download_youtube(choice["url"], cand.title, _artists_str(cand))
    deadline = time.monotonic() + DOWNLOAD_TIMEOUT
    job: dict = {}
    while True:
        job = dm.get_job(job_id) or {}
        if job.get("status") in ("done", "error", "cancelled"):
            break
        if time.monotonic() > deadline:
            return "La descarga tardó demasiado"
        if _cancelled(run.id):
            return "Cancelada"
        await asyncio.sleep(POLL_INTERVAL)
    if job.get("status") != "done":
        err = (job.get("error") or job.get("status") or "error").strip().splitlines()[-1][:200]
        return f"Falló la descarga: {err}"
    async with run.lock:
        found, why = await asyncio.to_thread(
            _find_downloaded, job.get("title") or choice.get("title") or "", known_before, claimed,
            cand.duration_s, cand.title)
        if not found:
            return why
        claimed.add(found["id"])
        run.order[i] = found["id"]
    _map_put(sid, found["id"], "youtube")
    await _add(run, [found["id"]])
    await _sync_order(run)
    return None
