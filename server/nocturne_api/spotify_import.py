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

Repeated entries: a song listed several times in the Spotify playlist (same id, or
the same song under another Spotify id: single vs album release) becomes several
occurrences of ONE library track at the Spotify positions; it is never downloaded
twice. Every Spotify id is recorded in v1_spotify_track_map.

Post-processing (background thread, non-fatal, per resolved library track):
  * library metadata = Spotify's clean title / artists (", "-joined) / album
    (DB only, never audio tags; old values kept in v1_spotify_meta_undo)
  * no official cover yet -> Spotify album image (largest) right away, then an
    optional iTunes/Deezer upgrade searched with the clean metadata
  * LRCLIB lyrics retried with the clean metadata when missing / not found

Restart behaviour: imports are not resumed. On startup every import still in
queued/reading/matching/downloading is marked `failed` with a clear reason.
Starting the same Spotify playlist again reuses the Nocturne playlist created
by the previous import (if it still exists), keeps what is already there and
only fills in the rest; tracks downloaded before the restart are found again
through v1_spotify_track_map / the library match, so nothing is downloaded twice.
"""
from __future__ import annotations

import asyncio
import os
import queue
import re
import json
import logging
import secrets
import threading
import time
from datetime import datetime, timezone
from typing import Any, Optional

from . import config
from . import playlists as pl
from . import spotify
from . import spotify_catalog as sc
from .db import connect

import database as nova_db  # sys.path set by playlists.py
import cover_art as ca

logger = logging.getLogger("nocturne.spotify_import")

ACTIVE = ("queued", "reading", "matching", "downloading")
TERMINAL = ("done", "failed", "cancelled")
DURATION_TOLERANCE = 2             # seconds, downloaded FILE vs Spotify (verified after download)
SAME_SONG_TOLERANCE = 15          # seconds, same recording under two Spotify ids
MAX_DURATION_DELTA = 3            # seconds, YouTube result vs Spotify: never accept more
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


_VIDEO_RE = re.compile(r"official\s+(music\s+)?video|video\s*clip|videoclip|video\s+oficial|visuali[sz]er", re.I)
_AUDIO_RE = re.compile(r"\b(official\s+audio|audio\s+oficial|audio)\b", re.I)


def _yt_class(r: dict, cand: Optional[ca.Candidate] = None) -> int:
    """2 = '<Artist> - Topic' auto-generated upload (the distributor master, same audio as
    Spotify), 1 = 'Official Audio' style title, 0 = anything else, -1 = music video."""
    chan = ca._compact(r.get("channel") or "")
    if chan.endswith("topic"):
        return 2
    title = r.get("title") or ""
    # "Provided to YouTube" auto-generated upload: the title is exactly the song title and the
    # channel is the artist's (flat search results do not always show the " - Topic" suffix).
    if cand is not None and cand.artists and ca.norm(title) == ca.norm(cand.title) and any(
            ca._compact(a) and ca._compact(a) == chan for a in cand.artists):
        return 2
    if _VIDEO_RE.search(title):
        return -1
    return 1 if _AUDIO_RE.search(title) else 0


def rank_youtube(cand: ca.Candidate, results: list[dict]) -> list[dict]:
    """Acceptable YouTube results for a Spotify track, best first. Duration must be within
    MAX_DURATION_DELTA s of Spotify's (never a different edit); Topic / Official Audio
    uploads win over videos; live/remix/slowed/... are rejected unless Spotify's title has it."""
    ranked: list[tuple] = []
    for r in results or []:
        dur = r.get("duration") or None
        if cand.duration_s and dur and abs(int(dur) - cand.duration_s) > MAX_DURATION_DELTA:
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
        cls = _yt_class(r, cand)
        chan = ca._compact(r.get("channel") or "")
        own = int(bool(chan) and (chan.endswith("topic") or "vevo" in chan or any(
            ca._compact(a) and ca._compact(a) in chan for a in cand.artists)))
        ranked.append([cls, int(delta <= 1), own, round(top_s, 2), -delta, r])
    if any(x[0] >= 1 for x in ranked):
        for x in ranked:                      # a master exists: videos go last
            if x[0] == -1:
                x[0] = -2
    ranked.sort(key=lambda x: tuple(x[:5]), reverse=True)
    return [x[5] for x in ranked]


def pick_youtube(cand: ca.Candidate, results: list[dict]) -> Optional[dict]:
    """Best YouTube search result for a Spotify track, or None if none is safe."""
    ranked = rank_youtube(cand, results)
    return ranked[0] if ranked else None


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
            "SELECT id, title, artist, album, duration, file_path, cover_path FROM tracks").fetchall()]
    finally:
        conn.close()


def _find_downloaded(video_title: str, known_before: set[str], claimed: set[str],
                     expected_s: Optional[int], spotify_title: str = "", *,
                     track_id: Optional[str] = None, file_path: Optional[str] = None
                     ) -> tuple[Optional[dict], Optional[str]]:
    """Library row of a finished YouTube download.

    NOVA's downloader reports the exact row (`track_id` / `file_path` of the job).
    Without them (older downloader) fall back to the title: the title tag is the
    video title (or yt-dlp's `track` field for YouTube Music uploads, the plain
    song title). When the video had been downloaded before (the same song listed
    twice under different Spotify ids), no new row is created and the EXISTING row
    with that title is the answer, even if another entry of this import already
    uses it - that used to fail as "Descargada, pero no aparece en la biblioteca"."""
    rows = _all_tracks()
    r = None
    if track_id:
        r = next((x for x in rows if x["id"] == track_id), None)
    if r is None and file_path:
        r = next((x for x in rows if x.get("file_path") == file_path), None)
    if r is None:
        want = ca.norm(video_title)
        song = ca._core_title(spotify_title)[0] if spotify_title else ""
        if not want and not song:
            return None, "La descarga no devolvió título"
        new_c, old_c = [], []
        for x in rows:
            got = ca.norm(x.get("title") or "")
            if x["id"] not in known_before:
                if (want and (got == want or ca.title_similarity(got, want) >= 0.9)) or (
                        song and ca.title_similarity(ca._core_title(x.get("title") or "")[0], song) >= 0.9):
                    new_c.append(x)
            elif want and got == want:
                old_c.append(x)
        cands = [x for x in new_c if x["id"] not in claimed] or new_c or old_c
        if not cands:
            return None, "Descargada, pero no aparece en la biblioteca"
        if expected_s:
            cands.sort(key=lambda x: abs((x.get("duration") or 10**6) - expected_s))
        r = cands[0]
    if expected_s and r.get("duration") and abs(r["duration"] - expected_s) > DURATION_TOLERANCE:
        return None, f"Duración descargada ({r['duration']} s) no coincide con Spotify ({expected_s} s)"
    return r, None


def same_song(a: ca.Candidate, b: ca.Candidate, key_a: Optional[tuple] = None,
              key_b: Optional[tuple] = None) -> bool:
    """Same recording under two Spotify ids (single vs album, re-release...)."""
    if (key_a or _dedupe_key(a)) != (key_b or _dedupe_key(b)):
        return False
    return not (a.duration_s and b.duration_s and abs(a.duration_s - b.duration_s) > SAME_SONG_TOLERANCE)


def find_same_song(sid: str, cands: dict, keys: dict, pool_by_key: dict) -> Optional[str]:
    """First id in pool_by_key[key of sid] that is the same song as sid."""
    for o in pool_by_key.get(keys[sid], ()):
        if o != sid and same_song(cands[o], cands[sid], keys[o], keys[sid]):
            return o
    return None


# ---------------------------------------------------------------------------
# Post-processing: clean metadata, cover, lyrics (background, non-fatal)
# ---------------------------------------------------------------------------

def _flag(name: str, default: bool = True) -> bool:
    v = os.getenv(name, "").strip().lower()
    return default if not v else v not in ("0", "false", "no", "off")


# Disabled in tests (they call postprocess_track() directly).
POSTPROCESS = os.getenv("NOCTURNE_TESTING", "").strip().lower() not in ("1", "true")
_post_q: "queue.Queue[tuple[str, dict]]" = queue.Queue()
_post_thread: Optional[threading.Thread] = None
_post_lock = threading.Lock()


def _post_worker() -> None:
    while True:
        tid, meta = _post_q.get()
        try:
            postprocess_track(tid, meta)
        except Exception as exc:  # pragma: no cover - postprocess_track never raises
            logger.warning("import post-processing failed for %s: %s", tid, type(exc).__name__)


def enqueue_postprocess(tasks: list[tuple[str, dict]]) -> None:
    """(track_id, spotify meta) pairs, processed one at a time in a daemon thread."""
    global _post_thread
    if not POSTPROCESS or not tasks:
        return
    with _post_lock:
        if _post_thread is None or not _post_thread.is_alive():
            _post_thread = threading.Thread(target=_post_worker, daemon=True, name="spotify-postprocess")
            _post_thread.start()
    for t in tasks:
        _post_q.put(t)


def postprocess_track(track_id: str, meta: dict, *, metadata: Optional[bool] = None,
                      cover: bool = True, upgrade: Optional[bool] = None,
                      lyrics: Optional[bool] = None) -> dict:
    """Give an imported library track Spotify's clean metadata, a cover and lyrics.
    Never raises; returns what was done (for logs/tests)."""
    done: dict = {}
    if metadata is None:
        metadata = _flag("NOCTURNE_SPOTIFY_METADATA")
    if upgrade is None:
        upgrade = _flag("NOCTURNE_SPOTIFY_COVER_UPGRADE") and ca.lookups_enabled()
    try:
        lib = nova_db.connect()
    except Exception as exc:
        logger.warning("post-processing %s: library unavailable: %s", track_id, exc)
        return done
    try:
        row = lib.execute("SELECT * FROM tracks WHERE id=?", (track_id,)).fetchone()
        if row is None:
            return done
        row = dict(row)
        # 1. clean metadata (DB only)
        if metadata:
            try:
                ch = sc.metadata_change(row, meta)
                if ch:
                    with connect() as noc:
                        if sc.apply_metadata_change(lib, ch, noc):
                            done["metadata"] = True
                            row.update(title=ch["new_title"], artist=ch["new_artist"], album=ch["new_album"])
                            logger.info("spotify import: metadata of %s set from Spotify", track_id)
            except Exception as exc:
                logger.warning("spotify import: metadata update failed for %s: %s", track_id, exc)
        # 2. cover: Spotify album image now, iTunes/Deezer upgrade afterwards
        if cover and not sc.is_official(row.get("cover_path")) and meta.get("image"):
            try:
                path, _w, _h = sc.set_cover_from_url(lib, track_id, meta["image"])
                done["cover"] = "spotify"
                row["cover_path"] = path
                logger.info("spotify import: Spotify album cover set for %s", track_id)
            except Exception as exc:
                logger.warning("spotify import: Spotify cover failed for %s: %s", track_id, exc)
            if done.get("cover") and upgrade:
                try:
                    m = ca.find_best_cover(row["title"], row.get("artist"), row.get("duration"), row.get("album"))
                    if m.decision == ca.DECISION_APPLY and m.candidate:
                        sc.set_cover_from_url(lib, track_id, m.candidate.art_url_max, min_px=ca.MIN_IMAGE_PX)
                        done["cover"] = m.candidate.source
                except Exception as exc:
                    logger.info("spotify import: cover upgrade skipped for %s: %s", track_id, exc)
        # 3. lyrics with the clean metadata
        if lyrics is None:
            lyrics = True
        if lyrics:
            done.update(_retry_lyrics(row, meta, force=bool(done.get("metadata"))))
    finally:
        lib.close()
    return done


def _retry_lyrics(row: dict, meta: dict, force: bool) -> dict:
    try:
        from . import lyrics_auto as la
        if not la.lookups_enabled() or la.has_lrc_file(row.get("file_path")):
            return {}
        fut = la._inflight.get(str(row["id"]))      # the downloader's own lookup
        if fut is not None:
            try:
                fut.result(timeout=120)
            except Exception:
                pass
        with connect() as noc:
            if noc.execute("SELECT 1 FROM v1_lyrics WHERE track_id=?", (row["id"],)).fetchone():
                return {}
        existing = la.get_auto(row["id"])
        if existing is not None and (existing["status"] != la.STATUS_NOT_FOUND or not force):
            return {}
        if meta.get("duration_ms"):
            row = {**row, "duration": int(round(meta["duration_ms"] / 1000))}   # Spotify's, not the file's
        res = la.lookup(row, [{"title": meta.get("name"), "artists": meta.get("artists") or [],
                               "album": meta.get("album"), "label": "spotify"}])
        if res.storable and (existing is None or res.status != la.STATUS_NOT_FOUND):
            la.store(row["id"], res)
            return {"lyrics": res.status}
    except Exception as exc:
        logger.info("spotify import: lyrics retry skipped for %s: %s", row.get("id"), exc)
    return {}


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
        self.positions: dict[str, list[int]] = {}      # Spotify id -> its positions
        self.cands: dict[str, ca.Candidate] = {}
        self.metas: dict[str, dict] = {}
        self.keys: dict[str, tuple] = {}
        self.resolved: dict[str, str] = {}             # Spotify id -> library track id
        self.post_done: set[str] = set()
        self.lock = asyncio.Lock()

    def resolve(self, sid: str, track_id: str) -> None:
        self.resolved[sid] = track_id
        for i in self.positions.get(sid, []):
            self.order[i] = track_id

    def fail_sid(self, sid: str, reason: str) -> None:
        for _ in self.positions.get(sid, [None]):
            self.fail(self.cands.get(sid), reason)

    def postprocess(self, sids: list[str]) -> None:
        tasks = []
        for sid in sids:
            tid = self.resolved.get(sid)
            if tid and tid not in self.post_done and self.metas.get(sid):
                self.post_done.add(tid)
                tasks.append((tid, self.metas[sid]))
        enqueue_postprocess(tasks)

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
    """Make the playlist follow the Spotify order, one occurrence per resolved Spotify
    entry (repeats included); entries the user added by hand stay at the end."""
    async with run.lock:
        res = await asyncio.to_thread(pl.sync_sequence, run.playlist_id, list(run.order))
        if res["added"] or res["reordered"]:
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

    # Every importable entry, in Spotify order: repeated songs are kept (each one
    # becomes an occurrence in the playlist; they are resolved/downloaded once).
    items: list[tuple[str, ca.Candidate]] = []
    metas: dict[str, dict] = {}
    for e in entries:
        t, reason = spotify.entry_track(e)
        if t is None:
            run.total += 1
            run.fail(None, reason, e)
            continue
        metas[t["id"]] = sc.track_meta(t)
        items.append((t["id"], spotify_candidate(t)))
    run.total += len(items)
    run.order = [None] * len(items)
    try:
        with connect() as conn:
            sc.store_meta(conn, metas.values())
    except Exception as exc:
        logger.warning("import %s: could not cache Spotify metadata: %s", import_id, exc)

    # 2. create (or reuse) the Nocturne playlist immediately
    pid = await asyncio.to_thread(_reusable_playlist, run.user_id, row["spotify_playlist_id"], import_id)
    if pid is None:
        created = await asyncio.to_thread(pl.create, name, run.user_id, DESCRIPTION, [])
        pid = created["id"]
    run.playlist_id = pid
    run.save(playlist_id=pid, status="matching")

    # 3. match against the library (each distinct Spotify id once)
    library = await asyncio.to_thread(_all_tracks)
    known_before = {r["id"] for r in library}
    index = await asyncio.to_thread(LibraryIndex, library)
    positions: dict[str, list[int]] = {}
    cands: dict[str, ca.Candidate] = {}
    for i, (sid, cand) in enumerate(items):
        positions.setdefault(sid, []).append(i)
        cands.setdefault(sid, cand)
    uniq = list(positions)
    mapped = await asyncio.to_thread(_map_get, uniq)
    run.positions, run.cands, run.metas = positions, cands, metas
    run.keys = {sid: _dedupe_key(c) for sid, c in cands.items()}
    claimed: set[str] = set()
    unmatched: list[str] = []

    def match_all():
        # pass 1: exact identities learnt by earlier imports
        by_key: dict[tuple, list[str]] = {}
        for sid in uniq:
            tid = mapped.get(sid)
            if tid and tid in known_before:
                run.resolve(sid, tid)
                claimed.add(tid)
                by_key.setdefault(run.keys[sid], []).append(sid)
        # pass 2: the same song under another Spotify id, then the fuzzy library match
        for sid in uniq:
            if sid in run.resolved:
                continue
            cand = cands[sid]
            sib = find_same_song(sid, cands, run.keys, by_key)
            if sib:
                run.resolve(sid, run.resolved[sib])
                _map_put(sid, run.resolved[sib], "duplicate")
                continue
            tid, s, b = index.best(cand, claimed)
            if tid and accept_library_match(s, b):
                run.resolve(sid, tid)
                claimed.add(tid)
                by_key.setdefault(run.keys[sid], []).append(sid)
                _map_put(sid, tid, "match")
            else:
                unmatched.append(sid)

    await asyncio.to_thread(match_all)
    if _cancelled(import_id):
        return
    run.matched = sum(len(positions[s]) for s in run.resolved)
    if run.resolved:
        await _sync_order(run)
        run.postprocess(list(run.resolved))
    run.save()

    # 4. downloads
    if unmatched and not run.download:
        for sid in unmatched:
            run.fail_sid(sid, "No está en la biblioteca (descarga desactivada)")
        unmatched = []
    if unmatched:
        run.save(status="downloading")
        try:
            dm = get_download_manager()
        except Exception:
            dm = None
        if dm is None:
            for sid in unmatched:
                run.fail_sid(sid, "Descargas no disponibles en este servidor")
        else:
            await _download_all(run, dm, unmatched, known_before, claimed)
        if _cancelled(import_id):
            run.save()
            return
        await _sync_order(run)

    run.save(status="done", finished_at=_now())


async def _download_all(run: _Run, dm, unmatched: list[str], known_before: set[str],
                        claimed: set[str]) -> None:
    # The same song listed under several Spotify ids: download it once; the other
    # ids follow the first one (same library track, or the same failure).
    groups: dict[str, list[str]] = {}
    todo: list[str] = []
    leads_by_key: dict[tuple, list[str]] = {}
    for sid in unmatched:
        lead = find_same_song(sid, run.cands, run.keys, leads_by_key)
        if lead:
            groups[lead].append(sid)
            continue
        groups[sid] = []
        todo.append(sid)
        leads_by_key.setdefault(run.keys[sid], []).append(sid)
    run.save()

    sem = asyncio.Semaphore(config.spotify_import_concurrency())
    tasks: list[asyncio.Task] = []

    async def one(sid: str) -> None:
        cand = run.cands[sid]
        try:
            await _wait_throttle()
            reason = await _download_one(run, dm, sid, cand, known_before, claimed)
            if reason and _is_throttled(reason) and not _cancelled(run.id):
                # YouTube is rate-limiting this IP: pause every download, then retry once.
                _trip_throttle()
                await _wait_throttle()
                reason = await _download_one(run, dm, sid, cand, known_before, claimed)
        except Exception as e:
            logger.warning("import %s: download of %r failed: %s", run.id, cand.title, type(e).__name__)
            reason = f"Error al descargar: {type(e).__name__}"
        finally:
            sem.release()
        followers = groups.get(sid, [])
        if reason:
            for s in [sid] + followers:
                run.fail_sid(s, reason)
        else:
            tid = run.resolved[sid]
            for s in followers:
                run.resolve(s, tid)
                _map_put(s, tid, "duplicate")
            run.downloaded += sum(len(run.positions[s]) for s in [sid] + followers)
            await _sync_order(run)
            run.postprocess([sid])
        run.save()

    for n, sid in enumerate(todo):
        await sem.acquire()
        if _cancelled(run.id):
            sem.release()
            break
        tasks.append(asyncio.create_task(one(sid)))
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


NOT_FOUND_REASON = "No se encontró la versión de Spotify en YouTube"
MAX_YT_ATTEMPTS = 4
SEARCH_LIMIT = 15


def youtube_queries(cand: ca.Candidate) -> list[str]:
    artist = _artists_str(cand)
    first = cand.artists[0] if cand.artists else ""
    if not artist:
        return [f'"{cand.title}" audio', cand.title]
    return [f'{first} - {cand.title} topic', f'"{cand.title}" "{first}" audio',
            f"Provided to YouTube by {cand.title} {first}", f"{artist} - {cand.title}"]


async def find_youtube_candidates(dm, cand: ca.Candidate) -> list[dict]:
    """Ranked YouTube results (Topic / Official Audio first). Searches stop as soon as a
    Topic or audio upload with a matching duration shows up."""
    seen: dict[str, dict] = {}
    ranked: list[dict] = []
    for q in youtube_queries(cand):
        for r in await dm.search_youtube(q, SEARCH_LIMIT) or []:
            seen.setdefault(r.get("id") or r.get("url") or str(len(seen)), r)
        ranked = rank_youtube(cand, list(seen.values()))
        if ranked and _yt_class(ranked[0], cand) >= 1:
            break
    return ranked


def _discard_new_file(row: Optional[dict], known_before: set[str]) -> None:
    """Delete a file this very download just created (never anything that existed before)."""
    if not row or row["id"] in known_before:
        return
    try:
        fp = row.get("file_path")
        if fp and os.path.isfile(fp):
            os.remove(fp)
        nova_db.delete_track(row["id"])
        logger.info("discarded wrong-duration download %s", row["id"])
    except Exception as exc:
        logger.warning("could not discard %s: %s", row.get("id"), type(exc).__name__)


async def download_candidate(dm, cand: ca.Candidate, known_before: set[str], claimed: set[str],
                             lock: Optional[asyncio.Lock] = None,
                             cancelled=lambda: False) -> tuple[Optional[dict], Optional[str]]:
    """Find the Spotify master on YouTube, download it, verify the file's duration against
    Spotify (+-DURATION_TOLERANCE s) and return (library row, None) or (None, reason).
    A download of the wrong length is deleted and the next candidate is tried."""
    ranked = await find_youtube_candidates(dm, cand)
    if not ranked:
        return None, NOT_FOUND_REASON
    reason = NOT_FOUND_REASON
    for choice in ranked[:MAX_YT_ATTEMPTS]:
        if cancelled():
            return None, "Cancelada"
        job_id = await dm.download_youtube(choice["url"], cand.title, _artists_str(cand))
        deadline = time.monotonic() + DOWNLOAD_TIMEOUT
        job: dict = {}
        while True:
            job = dm.get_job(job_id) or {}
            if job.get("status") in ("done", "error", "cancelled"):
                break
            if time.monotonic() > deadline:
                return None, "La descarga tardó demasiado"
            if cancelled():
                return None, "Cancelada"
            await asyncio.sleep(POLL_INTERVAL)
        if job.get("status") != "done":
            err = (job.get("error") or job.get("status") or "error").strip().splitlines()[-1][:200]
            reason = f"Falló la descarga: {err}"
            if _is_throttled(reason):
                return None, reason
            continue
        async def _find():
            return await asyncio.to_thread(
                _find_downloaded, job.get("title") or choice.get("title") or "", known_before, claimed,
                cand.duration_s, cand.title, track_id=job.get("track_id"), file_path=job.get("file_path"))
        if lock is not None:
            async with lock:
                found, why = await _find()
        else:
            found, why = await _find()
        if found:
            return found, None
        reason = why or reason
        if why and why.startswith("Duración descargada"):
            rows = await asyncio.to_thread(_all_tracks)
            _discard_new_file(next((x for x in rows if x["id"] == job.get("track_id")), None), known_before)
            continue
        return None, reason
    return None, reason if reason != NOT_FOUND_REASON else NOT_FOUND_REASON


async def _download_one(run: _Run, dm, sid: str, cand: ca.Candidate,
                        known_before: set[str], claimed: set[str]) -> Optional[str]:
    """Returns None on success, else a failure reason."""
    found, reason = await download_candidate(dm, cand, known_before, claimed, run.lock,
                                             lambda: _cancelled(run.id))
    if not found:
        return reason
    async with run.lock:
        claimed.add(found["id"])
        run.resolve(sid, found["id"])
    _map_put(sid, found["id"], "youtube")
    return None


# ---------------------------------------------------------------------------
# Single-track download (admin "search Spotify -> download")
# ---------------------------------------------------------------------------

class DownloadFailed(Exception):
    """User-facing (Spanish) reason in args[0]."""


def _write_audio_tags(file_path: str, meta: dict) -> None:
    """Clean Spotify title/artist/album in the file's own tags (only for files we just downloaded)."""
    from mutagen import File as MFile
    mf = MFile(file_path, easy=True)
    if mf is None:
        return
    if mf.tags is None:
        try:
            mf.add_tags()
        except Exception:
            return
    mf["title"] = [meta.get("name") or ""]
    mf["artist"] = [a for a in (meta.get("artists") or [])] or [""]
    if meta.get("album"):
        mf["album"] = [meta["album"]]
    mf.save()


async def download_spotify_track(meta: dict, dm=None, *, cancelled=lambda: False) -> tuple[str, bool]:
    """Make a Spotify track (meta = spotify_catalog.track_meta) available in the library.
    Returns (library track id, downloaded). Already known tracks (Spotify map or the
    library match) are returned without downloading. Raises DownloadFailed."""
    dm = dm or get_download_manager()
    sid = meta.get("id") or ""
    cand = spotify_candidate({"name": meta.get("name"), "duration_ms": meta.get("duration_ms"),
                              "artists": [{"name": a} for a in meta.get("artists") or []],
                              "album": {"name": meta.get("album")}})
    rows = await asyncio.to_thread(_all_tracks)
    by_id = {r["id"]: r for r in rows}
    if sid:
        mapped = await asyncio.to_thread(_map_get, [sid])
        if mapped.get(sid) in by_id:
            return mapped[sid], False
    best, score, bd = LibraryIndex(rows).best(cand)
    if best and accept_library_match(score, bd):
        if sid:
            _map_put(sid, best, "match")
        return best, False
    known_before = set(by_id)
    await _wait_throttle()
    found, reason = await download_candidate(dm, cand, known_before, set(), None, cancelled)
    if not found and reason and _is_throttled(reason) and not cancelled():
        _trip_throttle()
        await _wait_throttle()
        found, reason = await download_candidate(dm, cand, known_before, set(), None, cancelled)
    if not found:
        raise DownloadFailed(reason or NOT_FOUND_REASON)
    if found["id"] in known_before:                      # that video was downloaded before
        if sid:
            _map_put(sid, found["id"], "youtube")
        return found["id"], False
    try:
        await asyncio.to_thread(_write_audio_tags, found["file_path"], meta)
    except Exception as exc:
        logger.info("could not write tags to %s: %s", found["id"], type(exc).__name__)
    if sid:
        _map_put(sid, found["id"], "youtube")
    await asyncio.to_thread(postprocess_track, found["id"], meta)   # DB metadata, cover, lyrics
    return found["id"], True
