"""
GET  /v1/mixes            — the user's "Hecho para ti" mixes (regenerated when older than 24 h)
GET  /v1/mixes/{id}       — one mix with its tracks
POST /v1/mixes/refresh    — regenerate now
"""
from __future__ import annotations

import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

from fastapi import APIRouter, Depends, HTTPException

from . import mixes as mx
from .auth import require_user
from .mapping import track_to_wire

import database as nova_db

router = APIRouter(tags=["mixes"])


def _detail(account: dict, row: dict) -> dict:
    from .routes_library import _liked_set
    liked = _liked_set(account["id"])
    out = []
    for tid in json.loads(row["track_ids"]):
        t = nova_db.get_track(tid)
        if t:
            out.append(track_to_wire(t, liked=tid in liked))
    w = mx.to_wire(row)
    w["trackCount"] = len(out)
    w["tracks"] = out
    return w


@router.get("/mixes")
async def list_mixes(account: dict = Depends(require_user)):
    rows = await asyncio.to_thread(mx.get_mixes, account)
    return {"items": [mx.to_wire(r) for r in rows]}


@router.post("/mixes/refresh")
async def refresh_mixes(account: dict = Depends(require_user)):
    rows = await asyncio.to_thread(lambda: mx.get_mixes(account, force=True))
    return {"items": [mx.to_wire(r) for r in rows]}


@router.get("/mixes/{mix_id}")
async def get_mix(mix_id: str, account: dict = Depends(require_user)):
    rows = await asyncio.to_thread(mx.get_mixes, account)
    row = next((r for r in rows if r["mix_id"] == mix_id), None)
    if row is None:
        raise HTTPException(status_code=404, detail={"message": "Mix not found.", "code": "not_found"})
    return await asyncio.to_thread(_detail, account, row)
