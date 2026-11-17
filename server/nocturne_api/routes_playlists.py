"""
/v1/library/playlists, /v1/playlists/* — read + write API for playlists.

Visibility/ownership rules live in nocturne_api/playlists.py.
"""
from __future__ import annotations

import asyncio
from collections import Counter
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel

from .auth import require_user
from .mapping import track_to_wire
from . import playlists as pl

import database as nova_db  # NOVA's database module (sys.path set by playlists.py)

router = APIRouter(tags=["playlists"])

MAX_TRACK_IDS = 5000


def _err(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"message": message, "code": code})


def _not_found() -> HTTPException:
    return _err(404, "not_found", "Playlist not found.")


def _load(playlist_id: str, account: dict, *, edit: bool = False) -> tuple[dict, Optional[dict]]:
    row = nova_db.get_playlist(playlist_id)
    if not row:
        raise _not_found()
    meta = pl.get_meta(playlist_id)
    if not pl.can_view(account, meta):
        raise _not_found()  # someone else's private playlist: don't reveal it exists
    if edit and not pl.can_edit(account, meta):
        raise _err(403, "forbidden", "You can't edit this playlist.")
    return row, meta


def _detail(playlist_id: str, account: dict) -> dict:
    from .routes_library import _liked_set
    row = nova_db.get_playlist(playlist_id)
    meta = pl.get_meta(playlist_id)
    obj = pl.to_wire(row, meta, account)
    liked = _liked_set(account["id"])
    tracks = nova_db.get_playlist_tracks(playlist_id)
    obj["tracks"] = [dict(track_to_wire(t, liked=t["id"] in liked), entryId=t["entry_id"]) for t in tracks]
    obj["trackCount"] = len(tracks)
    return obj


def _summary(playlist_id: str, account: dict) -> dict:
    return pl.to_wire(nova_db.get_playlist(playlist_id), pl.get_meta(playlist_id), account)


def _clean_name(name: Optional[str]) -> str:
    name = (name or "").strip()
    if not name or len(name) > pl.NAME_MAX:
        raise _err(400, "bad_request", f"Name must be 1–{pl.NAME_MAX} characters.")
    return name


def _clean_description(desc: Optional[str]) -> Optional[str]:
    if desc is None:
        return None
    desc = desc.strip()
    if len(desc) > pl.DESCRIPTION_MAX:
        raise _err(400, "bad_request", f"Description must be at most {pl.DESCRIPTION_MAX} characters.")
    return desc


def _clean_ids(ids, *, required: bool, field: str = "trackIds") -> list[str]:
    if ids is None:
        if required:
            raise _err(400, "bad_request", f"{field} is required.")
        return []
    if not isinstance(ids, list) or not all(isinstance(i, str) and i for i in ids):
        raise _err(400, "bad_request", f"{field} must be a list of ids.")
    if len(ids) > MAX_TRACK_IDS:
        raise _err(400, "bad_request", f"At most {MAX_TRACK_IDS} ids per request.")
    return ids


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------

@router.get("/library/playlists")
async def list_playlists(
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    account: dict = Depends(require_user),
):
    items, total = await asyncio.to_thread(pl.list_wire, account, offset, limit)
    return {"items": items, "offset": offset, "limit": limit, "total": total}


@router.get("/playlists/{playlist_id}")
@router.get("/library/playlists/{playlist_id}")
async def get_playlist(playlist_id: str, account: dict = Depends(require_user)):
    _load(playlist_id, account)
    return await asyncio.to_thread(_detail, playlist_id, account)


# ---------------------------------------------------------------------------
# Write
# ---------------------------------------------------------------------------

class CreateBody(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    trackIds: Optional[list] = None


class PatchBody(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None


class TrackIdsBody(BaseModel):
    trackIds: Optional[list] = None


class AddTracksBody(BaseModel):
    trackIds: Optional[list] = None
    allowDuplicates: Optional[bool] = False


class ReorderBody(BaseModel):
    trackIds: Optional[list] = None
    entryIds: Optional[list] = None


@router.post("/playlists", status_code=201)
async def create_playlist(body: CreateBody, account: dict = Depends(require_user)):
    name = _clean_name(body.name)
    desc = _clean_description(body.description)
    ids = _clean_ids(body.trackIds, required=False)
    row = await asyncio.to_thread(pl.create, name, account["id"], desc, ids)
    return await asyncio.to_thread(_detail, row["id"], account)


@router.patch("/playlists/{playlist_id}")
async def update_playlist(playlist_id: str, body: PatchBody, account: dict = Depends(require_user)):
    _load(playlist_id, account, edit=True)
    fields = body.model_fields_set if hasattr(body, "model_fields_set") else body.__fields_set__
    if "name" in fields:
        await asyncio.to_thread(pl.rename, playlist_id, _clean_name(body.name))
    if "description" in fields:
        desc = _clean_description(body.description)
        pl._upsert_meta(playlist_id, description=desc or None, set_description=True)
    else:
        pl.touch(playlist_id)
    return await asyncio.to_thread(_summary, playlist_id, account)


@router.delete("/playlists/{playlist_id}", status_code=204)
async def delete_playlist(playlist_id: str, account: dict = Depends(require_user)):
    _load(playlist_id, account, edit=True)
    await asyncio.to_thread(pl.delete, playlist_id)
    return Response(status_code=204)


@router.post("/playlists/{playlist_id}/tracks")
async def add_tracks(playlist_id: str, body: AddTracksBody, account: dict = Depends(require_user)):
    _load(playlist_id, account, edit=True)
    ids = _clean_ids(body.trackIds, required=True)
    added, skipped = await asyncio.to_thread(pl.append_tracks, playlist_id, ids,
                                             bool(body.allowDuplicates))
    pl.touch(playlist_id)
    return {
        "added": added,
        "skipped": skipped,
        "playlist": await asyncio.to_thread(_summary, playlist_id, account),
    }


@router.delete("/playlists/{playlist_id}/entries/{entry_id}", status_code=204)
async def remove_entry(playlist_id: str, entry_id: str, account: dict = Depends(require_user)):
    """Remove ONE occurrence of a track (by its entryId)."""
    _load(playlist_id, account, edit=True)
    if not await asyncio.to_thread(pl.remove_entry, playlist_id, entry_id):
        raise _err(404, "not_found", "Entry not found in this playlist.")
    pl.touch(playlist_id)
    return Response(status_code=204)


@router.delete("/playlists/{playlist_id}/tracks/{track_id}", status_code=204)
async def remove_track(playlist_id: str, track_id: str, account: dict = Depends(require_user)):
    _load(playlist_id, account, edit=True)
    if track_id in pl.playlist_track_ids(playlist_id):
        await asyncio.to_thread(nova_db.remove_track_from_playlist, playlist_id, track_id)
        pl.touch(playlist_id)
    return Response(status_code=204)


@router.put("/playlists/{playlist_id}/tracks")
async def reorder_tracks(playlist_id: str, body: ReorderBody, account: dict = Depends(require_user)):
    """Reorder with either {entryIds} (permutation of the current entry ids) or the
    legacy {trackIds} (permutation of the current multiset of track ids)."""
    _load(playlist_id, account, edit=True)
    entries = await asyncio.to_thread(pl.playlist_entries, playlist_id)
    if body.entryIds is not None:
        ids = _clean_ids(body.entryIds, required=True, field="entryIds")
        current = [e for e, _ in entries]
        if len(ids) != len(current) or len(set(ids)) != len(ids) or set(ids) != set(current):
            raise _err(400, "bad_request", "entryIds must be a permutation of the playlist's current entries.")
        if ids != current:
            await asyncio.to_thread(pl.set_entry_order, playlist_id, ids)
            pl.touch(playlist_id)
        return await asyncio.to_thread(_detail, playlist_id, account)
    ids = _clean_ids(body.trackIds, required=True)
    current = [t for _, t in entries]
    if len(ids) != len(current) or Counter(ids) != Counter(current):
        raise _err(400, "bad_request", "trackIds must be a permutation of the playlist's current tracks.")
    if ids != current:
        await asyncio.to_thread(pl.set_order, playlist_id, ids)
        pl.touch(playlist_id)
    return await asyncio.to_thread(_detail, playlist_id, account)
