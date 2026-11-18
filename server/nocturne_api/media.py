"""
/v1/media/stream/{track_id}  — signed audio stream
/v1/media/art/{track_id}     — signed artwork (resize on the fly if Pillow available)
/v1/tracks/{id}/stream       — returns StreamInfo JSON (pre-signed URL + mimeType)
/v1/tracks/{id}/lyrics       — returns ServerLyrics JSON
"""
from __future__ import annotations

from typing import Optional

import os
import re
import sys
# NOVA backend modules (database, downloader, ...) live in <server root>/backend.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

import mimetypes
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, Query, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from .auth import require_user
from .signing import sign_stream_url, verify_media_url
from . import config

import database as nova_db

router = APIRouter(tags=["media"])

_AUDIO_TYPES = {
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg; codecs=opus",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".wav": "audio/wav",
    ".weba": "audio/webm",
}


@router.get("/tracks/{track_id}/stream")
async def stream_info(track_id: str, account: dict = Depends(require_user)):
    row = nova_db.get_track(track_id)
    if not row:
        raise HTTPException(status_code=404, detail={"message": "Track not found.", "code": "not_found"})

    file_path = row.get("file_path", "")
    if not file_path or not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail={"message": "Audio file not found.", "code": "not_found"})

    # Verify path containment
    if not os.path.realpath(file_path).startswith(config.MUSIC_ROOT):
        raise HTTPException(status_code=403, detail={"message": "Forbidden.", "code": "forbidden"})

    url, expires_at = sign_stream_url(track_id)
    ext = Path(file_path).suffix.lower()
    mime = _AUDIO_TYPES.get(ext, "audio/mpeg")
    return {"url": url, "expiresAt": expires_at, "mimeType": mime}


@router.get("/media/stream/{track_id}")
async def stream_audio(
    track_id: str,
    request: Request,
    sig: str = Query(...),
    exp: str = Query(...),
):
    path = f"/v1/media/stream/{track_id}"
    if not verify_media_url(path, sig, exp):
        raise HTTPException(status_code=403, detail={"message": "Invalid or expired stream URL.", "code": "forbidden"})

    row = nova_db.get_track(track_id)
    if not row:
        raise HTTPException(status_code=404, detail={"message": "Track not found.", "code": "not_found"})

    file_path = row.get("file_path", "")
    if not file_path or not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail={"message": "Audio file not found.", "code": "not_found"})

    # Path containment check
    real = os.path.realpath(file_path)
    if not real.startswith(config.MUSIC_ROOT):
        raise HTTPException(status_code=403, detail={"message": "Forbidden.", "code": "forbidden"})

    ext = Path(file_path).suffix.lower()
    mime = _AUDIO_TYPES.get(ext, "audio/mpeg")
    headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=3600",
        # The web/desktop player routes the <audio> element through Web Audio (equalizer,
        # visualizer), which needs a CORS-enabled stream. The URL is signed, so "*" leaks nothing.
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length",
    }
    size = os.path.getsize(file_path)
    rng = request.headers.get("range")
    if not rng:
        return FileResponse(file_path, media_type=mime, headers=headers)
    span = parse_byte_range(rng, size)
    if span is None:
        return Response(status_code=416, headers={**headers, "Content-Range": f"bytes */{size}"})
    start, end = span
    length = end - start + 1
    headers.update({"Content-Range": f"bytes {start}-{end}/{size}", "Content-Length": str(length)})
    return StreamingResponse(_iter_file(file_path, start, length), status_code=206, media_type=mime, headers=headers)


_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")


def parse_byte_range(header: str, size: int) -> Optional[tuple[int, int]]:
    """Parses a single `bytes=a-b` range into inclusive (start, end); None when unsatisfiable or malformed.

    Multi-range requests are not supported (416).
    """
    m = _RANGE_RE.match(header.strip())
    if not m or size <= 0:
        return None
    a, b = m.group(1), m.group(2)
    if a == "" and b == "":
        return None
    if a == "":  # suffix: last N bytes
        n = int(b)
        if n == 0:
            return None
        return max(0, size - n), size - 1
    start = int(a)
    end = size - 1 if b == "" else min(int(b), size - 1)
    if start >= size or end < start:
        return None
    return start, end


def _iter_file(path: str, start: int, length: int, chunk: int = 256 * 1024):
    with open(path, "rb") as f:
        f.seek(start)
        remaining = length
        while remaining > 0:
            data = f.read(min(chunk, remaining))
            if not data:
                break
            remaining -= len(data)
            yield data


@router.get("/media/art/{track_id}")
async def serve_art(
    track_id: str,
    request: Request,
    sig: str = Query(...),
    exp: str = Query(...),
    s: int = Query(None),
):
    path = f"/v1/media/art/{track_id}"
    if not verify_media_url(path, sig, exp):
        raise HTTPException(status_code=403, detail={"message": "Invalid or expired art URL.", "code": "forbidden"})

    row = nova_db.get_track(track_id)
    if not row:
        raise HTTPException(status_code=404, detail={"message": "Track not found.", "code": "not_found"})

    cover_path = row.get("cover_path", "")
    if not cover_path or not os.path.exists(cover_path):
        raise HTTPException(status_code=404, detail={"message": "Artwork not found.", "code": "not_found"})

    _ART_HEADERS = {"Cache-Control": "public, max-age=31536000, immutable", "Access-Control-Allow-Origin": "*", "Vary": "Accept"}

    # Resized thumbnail: served from the on-disk cache (generated once per cover + bucket + format).
    if s and s > 0:
        from . import thumbs
        bucket = thumbs.snap_size(s)
        webp = thumbs.accepts_webp(request.headers.get("accept")) and thumbs.webp_supported()
        res = await run_in_threadpool(thumbs.ensure_thumb, cover_path, bucket, webp)
        if res is not None:
            tp, created = res
            etag = thumbs.etag_for(tp)
            hdrs = dict(_ART_HEADERS, ETag=etag, **{"X-Thumb-Cache": "miss" if created else "hit"})
            inm = request.headers.get("if-none-match")
            if inm and etag in [t.strip().removeprefix("W/") for t in inm.split(",")]:
                return Response(status_code=304, headers=hdrs)
            return FileResponse(tp, media_type="image/webp" if webp else "image/jpeg", headers=hdrs)

    # Original file (no size requested, or thumbnailing unavailable).
    with open(cover_path, "rb") as f:
        header = f.read(12)
    if header[:3] == b"\xff\xd8\xff":
        content_type = "image/jpeg"
    elif header[:8] == b"\x89PNG\r\n\x1a\n":
        content_type = "image/png"
    elif header[:4] == b"RIFF" and header[8:12] == b"WEBP":
        content_type = "image/webp"
    else:
        content_type = "image/jpeg"
    st = os.stat(cover_path)
    etag = f'"{st.st_mtime_ns:x}-{st.st_size:x}"'
    hdrs = dict(_ART_HEADERS, ETag=etag)
    inm = request.headers.get("if-none-match")
    if inm and etag in [t.strip().removeprefix("W/") for t in inm.split(",")]:
        return Response(status_code=304, headers=hdrs)
    return FileResponse(cover_path, media_type=content_type, headers=hdrs)


_MIX_ART_RE = re.compile(r"^[A-Za-z0-9._-]{1,80}\.jpg$")


@router.get("/media/mix-art/{name}")
async def serve_mix_art(name: str, sig: str = Query(...), exp: str = Query(...)):
    """Signed collage cover of a daily mix (generated by nocturne_api/mixes.py)."""
    if not verify_media_url(f"/v1/media/mix-art/{name}", sig, exp):
        raise HTTPException(status_code=403, detail={"message": "Invalid or expired art URL.", "code": "forbidden"})
    from .mixes import covers_dir
    base = covers_dir()
    p = base / name
    if not _MIX_ART_RE.match(name) or not os.path.realpath(p).startswith(os.path.realpath(base) + os.sep) or not p.is_file():
        raise HTTPException(status_code=404, detail={"message": "Artwork not found.", "code": "not_found"})
    return FileResponse(p, media_type="image/jpeg", headers={
        "Cache-Control": "public, max-age=604800, immutable", "Access-Control-Allow-Origin": "*"})


OFFSET_MAX_MS = 30000


def _lyrics_offset(track_id: str) -> int:
    from .db import connect
    nc = connect()
    try:
        r = nc.execute("SELECT offset_ms FROM v1_lyrics_offset WHERE track_id=?", (track_id,)).fetchone()
    except Exception:
        return 0
    finally:
        nc.close()
    return int(r["offset_ms"]) if r else 0


def _prefer_auto(track_id: str) -> bool:
    from .db import connect
    nc = connect()
    try:
        r = nc.execute("SELECT prefer_auto FROM v1_lyrics_prefs WHERE track_id=?", (track_id,)).fetchone()
    except Exception:
        return False
    finally:
        nc.close()
    return bool(r and r["prefer_auto"])


@router.get("/tracks/{track_id}/lyrics")
async def get_lyrics(track_id: str, account: dict = Depends(require_user)):
    resp = dict(await _lyrics_payload(track_id))
    resp["offsetMs"] = _lyrics_offset(track_id)
    return resp


class LyricsOffsetBody(BaseModel):
    offsetMs: int


@router.put("/tracks/{track_id}/lyrics/offset")
async def put_lyrics_offset(track_id: str, body: LyricsOffsetBody, account: dict = Depends(require_user)):
    if not nova_db.get_track(track_id):
        raise HTTPException(status_code=404, detail={"message": "Track not found.", "code": "not_found"})
    ms = max(-OFFSET_MAX_MS, min(OFFSET_MAX_MS, int(body.offsetMs)))
    from datetime import datetime, timezone
    from .db import connect
    nc = connect()
    try:
        nc.execute(
            """INSERT INTO v1_lyrics_offset(track_id, offset_ms, updated_at, updated_by) VALUES (?,?,?,?)
               ON CONFLICT(track_id) DO UPDATE SET offset_ms=excluded.offset_ms,
               updated_at=excluded.updated_at, updated_by=excluded.updated_by""",
            (track_id, ms, datetime.now(timezone.utc).isoformat(), account.get("id")),
        )
        nc.commit()
    finally:
        nc.close()
    return {"offsetMs": ms}


async def _lyrics_payload(track_id: str) -> dict:
    row = nova_db.get_track(track_id)
    if not row:
        raise HTTPException(status_code=404, detail={"message": "Track not found.", "code": "not_found"})

    # Check Nocturne DB for TTML lyrics first
    from .db import connect
    nc = connect()
    lyric_row = nc.execute(
        "SELECT format, content FROM v1_lyrics WHERE track_id=?", (track_id,)
    ).fetchone()
    nc.close()

    if lyric_row:
        fmt = lyric_row["format"]
        content = lyric_row["content"]
        if fmt == "ttml":
            return {"synced": None, "plain": None, "ttml": content}
        elif fmt == "lrc":
            return {"synced": content, "plain": None, "ttml": None, "source": "admin"}
        elif fmt == "plain":
            return {"synced": None, "plain": content, "ttml": None, "source": "admin"}

    # .lrc next to the audio: a real (user-provided) one keeps priority. NOVA-made
    # ones (invented 10-s grid / NOVA header) rank below the LRCLIB lyrics and are
    # only used when nothing better exists - a fake grid as plain text.
    from . import lyrics_auto
    lrc = lyrics_auto.read_lrc(row.get("file_path") or "")
    # prefer_auto (set by `python -m nocturne_api.lrc_review --apply`): the .lrc is worse
    # than the LRCLIB lyrics; it stays on disk and is used only as a fallback.
    if lrc and lrc[0] == lyrics_auto.LRC_USER and _prefer_auto(track_id):
        auto0 = None
        try:
            auto0 = lyrics_auto.get_auto(track_id)
        except Exception:
            pass
        if auto0 and auto0.get("status") == lyrics_auto.STATUS_FOUND and auto0.get("synced"):
            return lyrics_auto.response_from_row(auto0)
    if lrc and lrc[0] == lyrics_auto.LRC_USER:
        return {"synced": lrc[1], "plain": None, "ttml": None}

    def _lrc_fallback() -> Optional[dict]:
        if not lrc:
            return None
        if lrc[0] == lyrics_auto.LRC_NOVA_SYNCED:
            return {"synced": lrc[1], "plain": None, "ttml": None}
        plain = lyrics_auto.lrc_plain_text(lrc[1])
        return {"synced": None, "plain": plain, "ttml": None} if plain else None

    # Automatic lyrics from LRCLIB (v1_lyrics_auto), lazily looked up on first request.
    try:
        auto = lyrics_auto.get_auto(track_id)
    except Exception:
        auto = None
    if auto and lyrics_auto.is_fresh(auto):
        resp = lyrics_auto.response_from_row(auto)
    else:
        res = await lyrics_auto.lookup_for_request(row)
        resp = res.response() if res is not None else None
    if resp and (resp.get("synced") or resp.get("plain")):
        return resp
    fb = _lrc_fallback()
    if fb:
        return fb
    if resp:
        return resp

    return {"synced": None, "plain": None, "ttml": None}
