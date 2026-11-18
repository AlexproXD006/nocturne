"""
GET/PUT /v1/me/eq                       — the user's active equalizer state
GET/POST /v1/me/eq/presets              — custom presets
PUT/DELETE /v1/me/eq/presets/{id}       — edit / remove one
"""
from __future__ import annotations

import asyncio
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel

from . import eq
from .auth import require_user

router = APIRouter(tags=["eq"])


def _bad(e: eq.EqError) -> HTTPException:
    return HTTPException(status_code=400, detail={"message": str(e), "code": "bad_request"})


class StateBody(BaseModel):
    enabled: Any = None
    preamp: Any = None
    gains: Any = None
    presetId: Any = None


class PresetBody(BaseModel):
    name: Any = None
    preamp: Any = None
    gains: Any = None


async def _run(fn, *args):
    try:
        return await asyncio.to_thread(fn, *args)
    except eq.EqError as e:
        raise _bad(e)


@router.get("/me/eq")
async def get_eq(account: dict = Depends(require_user)):
    return await asyncio.to_thread(eq.get_state, account["id"])


@router.put("/me/eq")
async def put_eq(body: StateBody, account: dict = Depends(require_user)):
    return await _run(eq.put_state, account["id"], body.enabled, body.preamp, body.gains, body.presetId)


@router.get("/me/eq/presets")
async def list_presets(account: dict = Depends(require_user)):
    return {"items": await asyncio.to_thread(eq.list_presets, account["id"])}


@router.post("/me/eq/presets", status_code=201)
async def create_preset(body: PresetBody, account: dict = Depends(require_user)):
    return await _run(eq.create_preset, account["id"], body.name, body.preamp, body.gains)


@router.put("/me/eq/presets/{preset_id}")
async def update_preset(preset_id: str, body: PresetBody, account: dict = Depends(require_user)):
    fields = {k: getattr(body, k) for k in body.model_fields_set}
    row = await _run(eq.update_preset, account["id"], preset_id, fields)
    if row is None:
        raise HTTPException(status_code=404, detail={"message": "Preset not found.", "code": "not_found"})
    return row


@router.delete("/me/eq/presets/{preset_id}", status_code=204)
async def delete_preset(preset_id: str, account: dict = Depends(require_user)):
    ok = await asyncio.to_thread(eq.delete_preset, account["id"], preset_id)
    if not ok:
        raise HTTPException(status_code=404, detail={"message": "Preset not found.", "code": "not_found"})
    return Response(status_code=204)
