"""
/v1/admin/* — Admin API (contract-exact implementation)
"""
from __future__ import annotations

import sys
import os
# NOVA backend modules (database, downloader, ...) live in <server root>/backend.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "backend"))

import io
import json
import secrets
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel

from ..roles import require_admin
from ..db import connect
from ..mapping import track_to_wire, user_to_wire
from ..auth import create_account, get_account_by_id
from ..passwords import hash_password, MIN_PASSWORD_LEN
from .. import config

import database as nova_db

router = APIRouter(prefix="/admin", tags=["admin"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _new_job_id() -> str:
    return "job_" + secrets.token_hex(10)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _nova_status_to_wire(nova_status: str) -> str:
    return {
        "pending": "queued",
        "downloading": "running",
        "done": "done",
        "error": "failed",
        "cancelled": "cancelled",
    }.get(nova_status, "queued")


def _nova_job_to_wire(job: dict) -> dict:
    progress_raw = job.get("progress", 0)
    progress = (progress_raw / 100.0) if progress_raw is not None else None
    return {
        "id": job.get("id", ""),
        "kind": job.get("kind", "download"),
        "source": job.get("source"),
        "title": job.get("title") or job.get("url", ""),
        "status": _nova_status_to_wire(job.get("status", "pending")),
        "progress": progress,
        "message": job.get("message"),
        "error": job.get("error"),
        "trackIds": job.get("track_ids", []),
        "createdAt": job.get("created_at") or _now(),
        "finishedAt": job.get("finished_at"),
    }


def _admin_track(row: dict) -> dict:
    t = track_to_wire(row)
    file_path = row.get("file_path", "")
    size = 0
    fmt = None
    if file_path and os.path.exists(file_path):
        try:
            size = os.path.getsize(file_path)
        except OSError:
            pass
        fmt = Path(file_path).suffix.lstrip(".").lower() or None

    # lyrics status
    with connect() as conn:
        lrow = conn.execute(
            "SELECT format FROM v1_lyrics WHERE track_id=?", (row["id"],)
        ).fetchone()
    lyrics_fmt = lrow["format"] if lrow else None

    t["addedAt"] = row.get("added_at")
    t["playCount"] = row.get("play_count") or 0
    t["sizeBytes"] = size
    if fmt:
        t["format"] = fmt
    t["lyrics"] = lyrics_fmt
    return t


# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------

@router.get("/stats")
async def admin_stats(account: dict = Depends(require_admin)):
    all_tracks = nova_db.get_all_tracks()

    # Distinct albums and artists
    albums = {(r.get("album") or "").strip() for r in all_tracks if r.get("album")}
    from ..mapping import _parse_artists
    artist_names: set = set()
    for r in all_tracks:
        for a in _parse_artists(r.get("artist", "")):
            artist_names.add(a)

    all_playlists = nova_db.get_playlists()

    with connect() as conn:
        user_count = conn.execute("SELECT COUNT(*) FROM v1_accounts").fetchone()[0]
        active_jobs = conn.execute(
            "SELECT COUNT(*) FROM v1_jobs WHERE status NOT IN ('done','failed','cancelled')"
        ).fetchone()[0]
        play_count = conn.execute("SELECT COUNT(*) FROM v1_plays").fetchone()[0]

    # Also count active nova jobs
    try:
        from main import download_manager
        for j in download_manager.download_queue.values():
            if j.get("status") not in ("done", "error"):
                active_jobs += 1
    except Exception:
        pass

    music_dir = Path(config.MUSIC_ROOT)
    storage = sum(f.stat().st_size for f in music_dir.rglob("*") if f.is_file())
    try:
        import shutil
        free = shutil.disk_usage(config.MUSIC_ROOT).free
    except Exception:
        free = None

    result = {
        "tracks": len(all_tracks),
        "albums": len(albums),
        "artists": len(artist_names),
        "playlists": len(all_playlists),
        "users": user_count,
        "storageBytes": storage,
        "plays": play_count,
        "activeJobs": active_jobs,
    }
    if free is not None:
        result["freeBytes"] = free
    return result


# ---------------------------------------------------------------------------
# Sources (search Spotify / YouTube)
# ---------------------------------------------------------------------------

@router.get("/sources/search")
async def search_sources(
    q: str = Query(..., min_length=1),
    source: str = Query("spotify"),
    account: dict = Depends(require_admin),
):
    from main import download_manager
    if source == "spotify":
        try:
            results = await download_manager.search_spotify(q)
            return {
                "results": [
                    {
                        "id": r.get("id") or secrets.token_hex(8),
                        "source": "spotify",
                        "kind": "track",
                        "title": r.get("title", ""),
                        "artist": r.get("artist", ""),
                        "album": r.get("album"),
                        "duration": int(r["duration_ms"] / 1000) if r.get("duration_ms") else None,
                        "artworkUrl": r.get("cover_url"),
                        "url": r.get("url"),
                    }
                    for r in results
                ]
            }
        except Exception as e:
            raise HTTPException(status_code=503, detail={"message": f"Spotify search unavailable: {e}", "code": "source_error"})
    elif source == "youtube":
        try:
            results = await download_manager.search_youtube(q)
            return {
                "results": [
                    {
                        "id": r.get("id") or secrets.token_hex(8),
                        "source": "youtube",
                        "kind": "track",
                        "title": r.get("title", ""),
                        "artist": r.get("artist", ""),
                        "artworkUrl": r.get("thumbnail"),
                        "url": r.get("url"),
                    }
                    for r in results
                ]
            }
        except Exception as e:
            raise HTTPException(status_code=503, detail={"message": f"YouTube search unavailable: {e}", "code": "source_error"})
    else:
        raise HTTPException(status_code=400, detail={"message": "Unknown source.", "code": "bad_request"})


# ---------------------------------------------------------------------------
# Jobs (unified — downloads, imports, rescan, backup, restore)
# ---------------------------------------------------------------------------

@router.get("/jobs")
async def list_jobs(account: dict = Depends(require_admin)):
    try:
        from main import download_manager
        nova_jobs = list(download_manager.download_queue.values())
    except Exception:
        nova_jobs = []

    # Also pull from nocturne DB
    with connect() as conn:
        db_jobs = conn.execute(
            "SELECT * FROM v1_jobs ORDER BY created_at DESC LIMIT 100"
        ).fetchall()

    wire = [_nova_job_to_wire(j) for j in sorted(nova_jobs, key=lambda x: x.get("created_at", ""), reverse=True)]

    # Add Nocturne-only jobs (rescan, backup, restore) not in NOVA's queue
    nova_ids = {j.get("id") for j in nova_jobs}
    for row in db_jobs:
        nova_jid = row["nova_job_id"]
        if not nova_jid or nova_jid not in nova_ids:
            wire.append({
                "id": row["id"],
                "kind": row["kind"],
                "title": row["title"],
                "status": row["status"],
                "progress": row["progress"],
                "message": row["message"],
                "error": row["error"],
                "trackIds": json.loads(row["track_ids"] or "[]"),
                "createdAt": row["created_at"],
                "finishedAt": row["finished_at"],
            })

    return {"jobs": wire[:100]}


@router.get("/jobs/{job_id}")
async def get_job(job_id: str, account: dict = Depends(require_admin)):
    # Try nova in-memory queue first
    try:
        from main import download_manager
        job = download_manager.download_queue.get(job_id)
        if job:
            return _nova_job_to_wire(job)
    except Exception:
        pass

    with connect() as conn:
        row = conn.execute("SELECT * FROM v1_jobs WHERE id=? OR nova_job_id=?", (job_id, job_id)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail={"message": "Job not found.", "code": "not_found"})
    return {
        "id": row["id"],
        "kind": row["kind"],
        "title": row["title"],
        "status": row["status"],
        "progress": row["progress"],
        "createdAt": row["created_at"],
        "finishedAt": row["finished_at"],
    }


@router.delete("/jobs/{job_id}", status_code=204)
async def cancel_job(job_id: str, account: dict = Depends(require_admin)):
    try:
        from main import download_manager
        job = download_manager.download_queue.get(job_id)
        if job:
            status = job.get("status", "")
            if status in ("done", "error"):
                raise HTTPException(status_code=409, detail={"message": "Job already finished.", "code": "conflict"})
            job["status"] = "error"
            job["error"] = "Cancelled by admin"
            return Response(status_code=204)
    except HTTPException:
        raise
    except Exception:
        pass

    with connect() as conn:
        row = conn.execute("SELECT status FROM v1_jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail={"message": "Job not found.", "code": "not_found"})
        if row["status"] in ("done", "failed", "cancelled"):
            raise HTTPException(status_code=409, detail={"message": "Job already finished.", "code": "conflict"})
        conn.execute("UPDATE v1_jobs SET status='cancelled', finished_at=? WHERE id=?", (_now(), job_id))
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Downloads (POST only — the GET is via /jobs)
# ---------------------------------------------------------------------------

class DownloadBody(BaseModel):
    source: str = "spotify"
    id: Optional[str] = None
    url: Optional[str] = None


@router.post("/downloads", status_code=201)
async def start_download(body: DownloadBody, account: dict = Depends(require_admin)):
    from main import download_manager

    target = body.url or body.id
    if not target:
        raise HTTPException(status_code=400, detail={"message": "Provide id or url.", "code": "bad_request"})

    try:
        if body.source == "youtube" or (body.url and ("youtube" in body.url or "youtu.be" in body.url)):
            nova_job_id = await download_manager.download_youtube(target, "", "")
        else:
            nova_job_id = await download_manager.download_track(target, "", "")
    except Exception as e:
        raise HTTPException(status_code=503, detail={"message": str(e), "code": "download_error"})

    # Persist in Nocturne DB
    job_id = _new_job_id()
    with connect() as conn:
        conn.execute(
            """INSERT OR IGNORE INTO v1_jobs
               (id, kind, source, title, nova_job_id, status, created_at, created_by, track_ids)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (job_id, "download", body.source, target, nova_job_id, "queued", _now(), account["id"], "[]"),
        )

    job = download_manager.download_queue.get(nova_job_id) or {"id": nova_job_id, "status": "pending", "kind": "download"}
    return _nova_job_to_wire(job)


# ---------------------------------------------------------------------------
# Imports (Spotify/YouTube playlist URL)
# ---------------------------------------------------------------------------

class ImportBody(BaseModel):
    url: str


@router.post("/imports", status_code=201)
async def import_playlist(body: ImportBody, account: dict = Depends(require_admin)):
    from main import download_manager
    if not body.url:
        raise HTTPException(status_code=400, detail={"message": "url is required.", "code": "bad_request"})

    try:
        nova_job_id = await download_manager.download_track(body.url, "", "")
    except Exception as e:
        raise HTTPException(status_code=503, detail={"message": str(e), "code": "import_error"})

    job_id = _new_job_id()
    with connect() as conn:
        conn.execute(
            """INSERT OR IGNORE INTO v1_jobs
               (id, kind, source, title, nova_job_id, status, created_at, created_by, track_ids)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (job_id, "import", "url", body.url, nova_job_id, "queued", _now(), account["id"], "[]"),
        )

    job = download_manager.download_queue.get(nova_job_id) or {"id": nova_job_id, "status": "pending", "kind": "import"}
    wire = _nova_job_to_wire(job)
    wire["kind"] = "import"
    return wire


# ---------------------------------------------------------------------------
# Library management
# ---------------------------------------------------------------------------

@router.get("/tracks")
async def list_tracks(
    q: Optional[str] = Query(None),
    lyrics: Optional[str] = Query(None),
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    account: dict = Depends(require_admin),
):
    if q:
        try:
            rows = nova_db.search_tracks_fts(q)
        except Exception:
            rows = nova_db.search_tracks(q)
    else:
        rows = nova_db.get_all_tracks()

    if lyrics == "missing":
        with connect() as conn:
            has_lyrics = {r["track_id"] for r in conn.execute("SELECT track_id FROM v1_lyrics").fetchall()}
        rows = [r for r in rows if r["id"] not in has_lyrics]
    elif lyrics == "present":
        with connect() as conn:
            has_lyrics = {r["track_id"] for r in conn.execute("SELECT track_id FROM v1_lyrics").fetchall()}
        rows = [r for r in rows if r["id"] in has_lyrics]

    total = len(rows)
    page = rows[offset: offset + limit]
    return {"items": [_admin_track(r) for r in page], "offset": offset, "limit": limit, "total": total}


@router.delete("/tracks/{track_id}", status_code=204)
async def delete_track(track_id: str, account: dict = Depends(require_admin)):
    row = nova_db.get_track(track_id)
    if not row:
        raise HTTPException(status_code=404, detail={"message": "Track not found.", "code": "not_found"})
    nova_db.delete_track(track_id)
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Rescan
# ---------------------------------------------------------------------------

@router.post("/library/rescan", status_code=201)
async def rescan_library(account: dict = Depends(require_admin)):
    import asyncio
    job_id = _new_job_id()

    with connect() as conn:
        conn.execute(
            "INSERT INTO v1_jobs(id,kind,title,status,created_at,created_by,track_ids) VALUES(?,?,?,?,?,?,?)",
            (job_id, "rescan", "Library rescan", "queued", _now(), account["id"], "[]"),
        )

    async def _do_scan():
        with connect() as c:
            c.execute("UPDATE v1_jobs SET status='running' WHERE id=?", (job_id,))
        try:
            from downloader import Downloader
            dl = Downloader(config.MUSIC_ROOT)
            added = dl.scan_and_upsert(config.MUSIC_ROOT)
            track_ids = [t["id"] for t in added] if added else []
            with connect() as c:
                c.execute(
                    "UPDATE v1_jobs SET status='done', finished_at=?, track_ids=? WHERE id=?",
                    (_now(), json.dumps(track_ids), job_id),
                )
        except Exception as e:
            with connect() as c:
                c.execute(
                    "UPDATE v1_jobs SET status='failed', error=?, finished_at=? WHERE id=?",
                    (str(e), _now(), job_id),
                )

    asyncio.create_task(_do_scan())
    return {
        "id": job_id, "kind": "rescan", "title": "Library rescan",
        "status": "queued", "createdAt": _now(), "trackIds": [],
    }


# ---------------------------------------------------------------------------
# Uploads
# ---------------------------------------------------------------------------

_UPLOAD_CHUNK = 1024 * 1024
_ALLOWED_EXTS = {".mp3", ".flac", ".ogg", ".opus", ".m4a", ".aac", ".wav"}


@router.post("/uploads", status_code=201)
async def upload_track(
    file: UploadFile = File(...),
    account: dict = Depends(require_admin),
):
    ext = Path(file.filename or "").suffix.lower()
    if ext not in _ALLOWED_EXTS:
        raise HTTPException(
            status_code=415,
            detail={"message": f"Unsupported file type: {ext}", "code": "unsupported_media_type"},
        )

    music_dir = Path(config.MUSIC_ROOT)
    uploads_dir = music_dir / "uploads"
    uploads_dir.mkdir(parents=True, exist_ok=True)
    dest = _unique_upload_dest(uploads_dir, file.filename or "", ext)

    # Stream to disk in chunks; the size limit is enforced while streaming so a
    # huge upload is never held in memory and is aborted as soon as it is over.
    written = 0
    try:
        with open(dest, "wb") as f:
            while True:
                chunk = await file.read(_UPLOAD_CHUNK)
                if not chunk:
                    break
                written += len(chunk)
                if written > config.UPLOAD_MAX_BYTES:
                    raise HTTPException(
                        status_code=413, detail={"message": "File too large.", "code": "payload_too_large"}
                    )
                f.write(chunk)
    except BaseException:
        try:
            dest.unlink()
        except Exception:
            pass
        raise

    try:
        # Module-level helpers (there is no `Downloader` class; the old import
        # raised ImportError, so every upload failed and the file was deleted).
        import downloader as nova_dl
        track_id = nova_dl._stable_id(str(dest))
        tags = nova_dl._read_tags(str(dest))
        cover_path = nova_dl._resolve_cover_path(str(dest))

        # _read_tags() defaults title to the saved file's stem; fall back to the
        # ORIGINAL filename ("Artist - Title.ext", timestamp prefixes stripped).
        title, artist = _upload_title_artist(tags, dest, file.filename or "")

        track = {
            "id": track_id,
            "title": title,
            "artist": artist,
            "album": tags.get("album", ""),
            "duration": tags.get("duration", 0),
            "file_path": str(dest),
            "cover_path": cover_path,
        }
        nova_db.upsert_track(track)
        if not cover_path:
            # No embedded/sidecar art: look up official cover art in the background
            # (non-fatal; only auto-applied at the high-confidence threshold).
            try:
                import cover_art
                cover_art.auto_apply_cover_async(track)
            except Exception as exc:  # pragma: no cover - never fail the upload
                import logging
                logging.getLogger(__name__).warning("cover lookup not started: %s", exc)
        # Synced lyrics from LRCLIB in the background (non-fatal, stored in v1_lyrics_auto).
        try:
            from .. import lyrics_auto
            lyrics_auto.auto_fetch_async(track)
        except Exception as exc:  # pragma: no cover - never fail the upload
            import logging
            logging.getLogger(__name__).warning("lyrics lookup not started: %s", exc)
        row = nova_db.get_track(track_id)
        return _admin_track(row or track)
    except Exception as e:
        try:
            dest.unlink()
        except Exception:
            pass
        raise HTTPException(status_code=500, detail={"message": f"Upload failed: {e}", "code": "server_error"})


# ---------------------------------------------------------------------------
# Upload filename helpers
# ---------------------------------------------------------------------------

import re as _re
import time as _time
import unicodedata as _ud

_UPLOAD_STEM_MAX = 120
_UPLOAD_ALLOWED_PUNCT = set(" -_.,()[]&'!+#@")
_TS_PREFIX_RE = _re.compile(r"^\s*\d{10,14}[_\-\s]+")
_TRACKNO_PREFIX_RE = _re.compile(r"^\s*\d{1,3}\s*[.\-_)]\s+")


def _sanitize_upload_stem(filename: str) -> str:
    """
    Turn a client-supplied filename into a safe stem: no directories, no control
    characters, no '..', only Unicode letters/digits/spaces and basic punctuation,
    collapsed whitespace, at most 120 chars. Never empty.
    """
    name = _ud.normalize("NFC", filename or "")
    name = name.replace("\\", "/").split("/")[-1]          # drop any directory part
    stem = name.rsplit(".", 1)[0] if "." in name.strip(".") else name
    out = []
    for ch in stem:
        # letters, digits (any script) and basic punctuation; everything else
        # (control chars, separators, symbols, quotes, <>:|?* ...) becomes a space
        ok = _ud.category(ch)[0] in "LN" or ch in _UPLOAD_ALLOWED_PUNCT
        out.append(ch if ok else " ")
    stem = "".join(out)
    stem = _re.sub(r"\.{2,}", ".", stem)
    stem = _re.sub(r"\s+", " ", stem).strip(" .-_")
    stem = stem[:_UPLOAD_STEM_MAX].strip(" .-_")
    return stem or "upload"


def _unique_upload_dest(uploads_dir: Path, filename: str, ext: str) -> Path:
    """uploads/<epoch_ms>_<sanitized original name><ext> (ext already validated)."""
    stem = _sanitize_upload_stem(filename)
    ms = int(_time.time() * 1000)
    dest = uploads_dir / f"{ms}_{stem}{ext}"
    n = 1
    while dest.exists():
        dest = uploads_dir / f"{ms}_{stem} ({n}){ext}"
        n += 1
    return dest


def _meta_from_filename(filename: str) -> tuple[str, Optional[str]]:
    """'1777975625411_Artist - Title.m4a' -> ('Title', 'Artist'); else (stem, None)."""
    stem = _sanitize_upload_stem(filename)
    stem = _TS_PREFIX_RE.sub("", stem)
    stem = _TRACKNO_PREFIX_RE.sub("", stem).strip() or stem
    parts = _re.split(r"\s+[-–—]\s+", stem, maxsplit=1)
    if len(parts) == 2 and parts[0].strip() and parts[1].strip():
        return parts[1].strip(), parts[0].strip()
    return stem.strip(), None


def _upload_title_artist(tags: dict, dest: Path, original_filename: str) -> tuple[str, str]:
    tag_title = (tags.get("title") or "").strip()
    tag_artist = (tags.get("artist") or "").strip()
    if tag_title and tag_title != dest.stem:
        return tag_title, tag_artist
    title, artist = _meta_from_filename(original_filename or dest.name)
    return title, tag_artist or (artist or "")


# ---------------------------------------------------------------------------
# Lyrics
# ---------------------------------------------------------------------------

LYRICS_MAX_BYTES = 200 * 1024   # lrc / plain


class SetLyricsBody(BaseModel):
    format: str
    content: str


@router.put("/tracks/{track_id}/lyrics", status_code=204)
async def set_lyrics(track_id: str, body: SetLyricsBody, account: dict = Depends(require_admin)):
    if not nova_db.get_track(track_id):
        raise HTTPException(status_code=404, detail={"message": "Track not found.", "code": "not_found"})

    if body.format not in ("ttml", "lrc", "plain"):
        raise HTTPException(status_code=400, detail={"message": "format must be lrc, plain or ttml.", "code": "bad_request"})

    limit = 4 * 1024 * 1024 if body.format == "ttml" else LYRICS_MAX_BYTES
    if len(body.content.encode()) > limit:
        raise HTTPException(status_code=413, detail={"message": "Lyrics too large.", "code": "payload_too_large"})
    if body.format == "plain" and not body.content.strip():
        raise HTTPException(status_code=400, detail={"message": "Lyrics are empty.", "code": "bad_request"})

    # Basic validation
    if body.format == "ttml":
        if "<tt" not in body.content:
            raise HTTPException(status_code=400, detail={"message": "Invalid TTML: missing <tt> root.", "code": "bad_request"})
        if "DOCTYPE" in body.content or "ENTITY" in body.content:
            raise HTTPException(status_code=400, detail={"message": "DOCTYPE/ENTITY not allowed.", "code": "bad_request"})
    elif body.format == "lrc":
        import re
        if not re.search(r'\[\d+:\d+(?:[.:]\d+)?\]', body.content):
            raise HTTPException(status_code=400, detail={"message": "Invalid LRC: no timestamps found.", "code": "bad_request"})

    with connect() as conn:
        conn.execute(
            """INSERT INTO v1_lyrics(track_id,format,content,updated_at,updated_by)
               VALUES(?,?,?,?,?)
               ON CONFLICT(track_id) DO UPDATE SET
               format=excluded.format,content=excluded.content,
               updated_at=excluded.updated_at,updated_by=excluded.updated_by""",
            (track_id, body.format, body.content, _now(), account["id"]),
        )
    return Response(status_code=204)


@router.delete("/tracks/{track_id}/lyrics", status_code=204)
async def delete_lyrics(track_id: str, account: dict = Depends(require_admin)):
    if not nova_db.get_track(track_id):
        raise HTTPException(status_code=404, detail={"message": "Track not found.", "code": "not_found"})
    with connect() as conn:
        conn.execute("DELETE FROM v1_lyrics WHERE track_id=?", (track_id,))
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Backups
# ---------------------------------------------------------------------------

@router.get("/backups")
async def list_backups(account: dict = Depends(require_admin)):
    backups = nova_db.list_backups()
    return {
        "backups": [
            {
                "id": b.get("id") or Path(b.get("path", "x")).stem,
                "createdAt": b.get("created_at") or b.get("timestamp", ""),
                "sizeBytes": b.get("size", 0),
                "label": "database",
            }
            for b in backups
        ]
    }


@router.post("/backups", status_code=201)
async def create_backup(account: dict = Depends(require_admin)):
    import asyncio
    job_id = _new_job_id()

    with connect() as conn:
        conn.execute(
            "INSERT INTO v1_jobs(id,kind,title,status,created_at,created_by,track_ids) VALUES(?,?,?,?,?,?,?)",
            (job_id, "backup", "Database backup", "queued", _now(), account["id"], "[]"),
        )

    async def _do_backup():
        with connect() as c:
            c.execute("UPDATE v1_jobs SET status='running' WHERE id=?", (job_id,))
        try:
            import shutil
            from datetime import datetime as dt
            ts = dt.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
            backup_dir = Path(config.MUSIC_ROOT) / ".backups"
            backup_dir.mkdir(exist_ok=True)
            dest = backup_dir / f"backup_{ts}.db"
            shutil.copy2(nova_db.DB_PATH, str(dest))
            with connect() as c:
                c.execute("UPDATE v1_jobs SET status='done', finished_at=? WHERE id=?", (_now(), job_id))
        except Exception as e:
            with connect() as c:
                c.execute("UPDATE v1_jobs SET status='failed', error=?, finished_at=? WHERE id=?", (str(e), _now(), job_id))

    asyncio.create_task(_do_backup())
    return {"id": job_id, "kind": "backup", "title": "Database backup", "status": "queued", "createdAt": _now(), "trackIds": []}


@router.post("/backups/{backup_id}/restore", status_code=202)
async def restore_backup(backup_id: str, request: Request, account: dict = Depends(require_admin)):
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not body.get("confirm"):
        raise HTTPException(status_code=400, detail={"message": "Send {\"confirm\": true} to confirm.", "code": "bad_request"})

    import asyncio
    job_id = _new_job_id()

    with connect() as conn:
        conn.execute(
            "INSERT INTO v1_jobs(id,kind,title,status,created_at,created_by,track_ids) VALUES(?,?,?,?,?,?,?)",
            (job_id, "restore", f"Restore {backup_id}", "queued", _now(), account["id"], "[]"),
        )

    async def _do_restore():
        with connect() as c:
            c.execute("UPDATE v1_jobs SET status='running' WHERE id=?", (job_id,))
        try:
            nova_db.restore_backup(backup_id)
            with connect() as c:
                c.execute("UPDATE v1_jobs SET status='done', finished_at=? WHERE id=?", (_now(), job_id))
        except Exception as e:
            with connect() as c:
                c.execute("UPDATE v1_jobs SET status='failed', error=?, finished_at=? WHERE id=?", (str(e), _now(), job_id))

    asyncio.create_task(_do_restore())
    return {"id": job_id, "kind": "restore", "title": f"Restore {backup_id}", "status": "queued", "createdAt": _now(), "trackIds": []}


# ---------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------

class CreateUserBody(BaseModel):
    username: str
    password: str
    displayName: Optional[str] = None
    role: str = "user"


class UpdateUserBody(BaseModel):
    displayName: Optional[str] = None
    role: Optional[str] = None
    disabled: Optional[bool] = None
    password: Optional[str] = None


def _admin_user(r: dict) -> dict:
    return {
        "id": r["id"],
        "username": r["username"],
        "displayName": r["display_name"] or r["username"],
        "role": r["role"],
        "disabled": bool(r.get("disabled", 0)),
        "createdAt": r["created_at"],
        "lastLoginAt": r.get("last_login_at"),
    }


@router.get("/users")
async def list_users(account: dict = Depends(require_admin)):
    with connect() as conn:
        rows = [dict(r) for r in conn.execute(
            "SELECT * FROM v1_accounts ORDER BY created_at DESC"
        ).fetchall()]
    return {"users": [_admin_user(r) for r in rows]}


@router.post("/users", status_code=201)
async def create_user(body: CreateUserBody, account: dict = Depends(require_admin)):
    if len(body.password) < MIN_PASSWORD_LEN:
        raise HTTPException(status_code=400, detail={"message": f"Password must be at least {MIN_PASSWORD_LEN} characters.", "code": "bad_request"})
    if body.role not in ("admin", "user"):
        raise HTTPException(status_code=400, detail={"message": "role must be admin or user.", "code": "bad_request"})

    with connect() as conn:
        if conn.execute("SELECT id FROM v1_accounts WHERE username=? COLLATE NOCASE", (body.username,)).fetchone():
            raise HTTPException(status_code=409, detail={"message": "Username already exists.", "code": "conflict"})

    user_id = create_account(username=body.username, password=body.password, display_name=body.displayName, role=body.role)
    return _admin_user(dict(get_account_by_id(user_id)))


@router.patch("/users/{user_id}")
async def update_user(user_id: str, body: UpdateUserBody, account: dict = Depends(require_admin)):
    target = get_account_by_id(user_id)
    if not target:
        raise HTTPException(status_code=404, detail={"message": "User not found.", "code": "not_found"})

    # Last-admin protection
    if body.role == "user" or body.disabled is True:
        if target["role"] == "admin":
            with connect() as conn:
                if conn.execute("SELECT COUNT(*) FROM v1_accounts WHERE role='admin' AND disabled=0").fetchone()[0] <= 1:
                    raise HTTPException(status_code=409, detail={"message": "Cannot demote or disable the last admin.", "code": "conflict"})

    updates, params = [], []
    if body.displayName is not None:
        updates.append("display_name=?"); params.append(body.displayName)
    if body.role is not None:
        if body.role not in ("admin", "user"):
            raise HTTPException(status_code=400, detail={"message": "role must be admin or user.", "code": "bad_request"})
        updates.append("role=?"); params.append(body.role)
    if body.disabled is not None:
        updates.append("disabled=?"); params.append(1 if body.disabled else 0)
    if body.password is not None:
        if len(body.password) < MIN_PASSWORD_LEN:
            raise HTTPException(status_code=400, detail={"message": f"Password must be at least {MIN_PASSWORD_LEN} characters.", "code": "bad_request"})
        updates.append("password_hash=?"); params.append(hash_password(body.password))
        updates.append("password_changed_at=?"); params.append(_now())
        from ..tokens import revoke_all_user_families
        revoke_all_user_families(user_id)

    if updates:
        params.append(user_id)
        with connect() as conn:
            conn.execute(f"UPDATE v1_accounts SET {', '.join(updates)} WHERE id=?", params)

    return _admin_user(dict(get_account_by_id(user_id)))


@router.delete("/users/{user_id}", status_code=204)
async def delete_user(user_id: str, account: dict = Depends(require_admin)):
    if user_id == account["id"]:
        raise HTTPException(status_code=409, detail={"message": "Cannot delete your own account.", "code": "conflict"})
    target = get_account_by_id(user_id)
    if not target:
        raise HTTPException(status_code=404, detail={"message": "User not found.", "code": "not_found"})
    if target["role"] == "admin":
        with connect() as conn:
            if conn.execute("SELECT COUNT(*) FROM v1_accounts WHERE role='admin' AND disabled=0").fetchone()[0] <= 1:
                raise HTTPException(status_code=409, detail={"message": "Cannot delete the last admin.", "code": "conflict"})
    from ..tokens import revoke_all_user_families
    revoke_all_user_families(user_id)
    with connect() as conn:
        conn.execute("DELETE FROM v1_accounts WHERE id=?", (user_id,))
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Android signing keystore backup (admin only)
# ---------------------------------------------------------------------------

@router.get("/signing/keystore", include_in_schema=False)
async def download_signing_keystore(account: dict = Depends(require_admin)):
    """Download a zip backup of the Android release keystore + its credentials.

    Admin only. The keystore is password-protected; the password is included in
    the bundle so the admin can keep a complete, usable backup. Served with
    no-store so it is never cached.
    """
    ks_path = os.getenv("NOCTURNE_ANDROID_KEYSTORE", "").strip()
    alias = os.getenv("NOCTURNE_ANDROID_KEY_ALIAS", "nocturne").strip()
    pw = os.getenv("NOCTURNE_ANDROID_KEYSTORE_PASS", "")
    p = Path(ks_path) if ks_path else None
    if not p or not p.exists():
        raise HTTPException(
            status_code=404,
            detail={"message": "No Android signing keystore is configured.", "code": "not_found"},
        )
    info = (
        "NOCTURNE - Android release signing keystore backup\n"
        "==================================================\n\n"
        "*** KEEP THIS SAFE. NEVER LOSE IT. STORE SEVERAL COPIES. ***\n\n"
        "This keystore is the signing identity of the Nocturne Android app.\n"
        "Every app update MUST be signed with this same key, or Android will\n"
        "refuse to install the update over the existing app. If you lose this\n"
        "file OR its password, you can never update the installed app again\n"
        "(users would have to uninstall and reinstall from scratch).\n\n"
        f"Keystore file  : nocturne-release.keystore\n"
        f"Key alias      : {alias}\n"
        f"Store password : {pw}\n"
        f"Key password   : {pw}\n"
        f"Key            : RSA 2048, valid until 2054\n\n"
        "Verify fingerprint:\n"
        "  keytool -list -v -keystore nocturne-release.keystore\n\n"
        "Sign an unsigned release APK manually:\n"
        f"  apksigner sign --ks nocturne-release.keystore --ks-key-alias {alias} app-release.apk\n"
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(str(p), arcname="nocturne-release.keystore")
        z.writestr("KEYSTORE-INFO.txt", info)
    data = buf.getvalue()
    return Response(
        content=data,
        media_type="application/zip",
        headers={
            "Content-Disposition": 'attachment; filename="nocturne-keystore-backup.zip"',
            "Cache-Control": "no-store",
            "Content-Length": str(len(data)),
        },
    )
