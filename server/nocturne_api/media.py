"""
/v1/media/stream/{track_id}  — signed audio stream
/v1/media/art/{track_id}     — signed artwork (resize on the fly if Pillow available)
/v1/tracks/{id}/stream       — returns StreamInfo JSON (pre-signed URL + mimeType)
/v1/tracks/{id}/lyrics       — returns ServerLyrics JSON
"""
from __future__ import annotations

from typing import Optional

import os
import sys
# NOVA backend modules (database, downloader, ...) live in <server root>/backend.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

import mimetypes
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, Query, Response
from fastapi.responses import FileResponse, StreamingResponse

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
    # Starlette FileResponse handles Accept-Ranges / 206 Partial Content (requires Starlette >= 0.14)
    return FileResponse(
        file_path,
        media_type=mime,
        headers={
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, max-age=3600",
        },
    )


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

    # Detect image type from magic bytes
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

    # Try to resize if Pillow is available and size requested
    if s and s > 0:
        try:
            from PIL import Image as PILImage
            import io
            img = PILImage.open(cover_path)
            img.thumbnail((s, s), PILImage.LANCZOS)
            buf = io.BytesIO()
            fmt = "JPEG" if content_type == "image/jpeg" else "PNG"
            img.save(buf, format=fmt, quality=85)
            buf.seek(0)
            return StreamingResponse(
                buf,
                media_type=content_type,
                headers={
                    "Cache-Control": "public, max-age=604800, immutable",
                    "Access-Control-Allow-Origin": "*",
                },
            )
        except ImportError:
            pass
        except Exception:
            pass

    return FileResponse(
        cover_path,
        media_type=content_type,
        headers={
            "Cache-Control": "public, max-age=604800, immutable",
            "Access-Control-Allow-Origin": "*",
        },
    )


@router.get("/tracks/{track_id}/lyrics")
async def get_lyrics(track_id: str, account: dict = Depends(require_user)):
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
            return {"synced": content, "plain": None, "ttml": None}

    # .lrc next to the audio: a real (user-provided) one keeps priority. NOVA-made
    # ones (invented 10-s grid / NOVA header) rank below the LRCLIB lyrics and are
    # only used when nothing better exists - a fake grid as plain text.
    from . import lyrics_auto
    lrc = lyrics_auto.read_lrc(row.get("file_path") or "")
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
