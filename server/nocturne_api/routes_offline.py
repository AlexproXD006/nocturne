"""
Offline manifest: everything a client needs to make a track playable without the server, in one call.

GET  /v1/tracks/{id}/offline-manifest   one track
POST /v1/offline/manifest               up to MAX_BATCH tracks ({"trackIds": [...]})

Both are authenticated like the rest of the API and hand out the same short-lived signed URLs as
/tracks/{id}/stream and /media/art (no new public endpoints). Unknown or unreadable tracks are reported
per entry instead of failing a whole batch. `lyrics` may be null (no lyrics / lookup failed): never an error.
"""
from __future__ import annotations

import os
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .auth import require_user
from . import config
from .mapping import track_to_wire
from .signing import sign_stream_url, sign_art_url

import database as nova_db

router = APIRouter(tags=["offline"])

MAX_BATCH = 50
ART_SIZE = 512


class ManifestBody(BaseModel):
    trackIds: list[str] = Field(default_factory=list)


def _size(path: str) -> Optional[int]:
    try:
        return os.path.getsize(path)
    except OSError:
        return None


async def build_manifest(track_id: str) -> Optional[dict[str, Any]]:
    """Manifest of one track, or None when it does not exist / has no readable audio file."""
    from . import media

    row = nova_db.get_track(track_id)
    if not row:
        return None
    file_path = row.get("file_path", "") or ""
    if not file_path or not os.path.exists(file_path):
        return None
    if not os.path.realpath(file_path).startswith(config.MUSIC_ROOT):
        return None
    url, expires_at = sign_stream_url(track_id)
    ext = os.path.splitext(file_path)[1].lower()
    cover = row.get("cover_path") or ""
    lyrics: Optional[dict] = None
    try:
        lyrics = dict(await media._lyrics_payload(track_id))
        lyrics["offsetMs"] = media._lyrics_offset(track_id)
    except Exception:
        lyrics = None
    return {
        "trackId": track_id,
        "track": track_to_wire(row),
        "stream": {"url": url, "expiresAt": expires_at, "mimeType": media._AUDIO_TYPES.get(ext, "audio/mpeg")},
        "sizeBytes": _size(file_path),
        "art": {"url": sign_art_url(track_id, ART_SIZE), "size": ART_SIZE} if cover and os.path.exists(cover) else None,
        "lyrics": lyrics,
    }


@router.get("/tracks/{track_id}/offline-manifest")
async def offline_manifest(track_id: str, account: dict = Depends(require_user)):
    m = await build_manifest(track_id)
    if m is None:
        raise HTTPException(status_code=404, detail={"message": "Track not found.", "code": "not_found"})
    return m


@router.post("/offline/manifest")
async def offline_manifest_batch(body: ManifestBody, account: dict = Depends(require_user)):
    ids = list(dict.fromkeys(i for i in body.trackIds if isinstance(i, str) and i))
    if not ids:
        raise HTTPException(status_code=400, detail={"message": "trackIds is required.", "code": "bad_request"})
    if len(ids) > MAX_BATCH:
        raise HTTPException(status_code=400, detail={"message": f"At most {MAX_BATCH} tracks per request.", "code": "bad_request"})
    items, missing = [], []
    for tid in ids:
        m = await build_manifest(tid)
        if m is None:
            missing.append(tid)
        else:
            items.append(m)
    return {"items": items, "missing": missing}
