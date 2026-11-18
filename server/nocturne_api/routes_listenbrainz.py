"""
/v1/listenbrainz/* — scrobble plays to ListenBrainz with the user's own token.

  GET    /listenbrainz/status
  POST   /listenbrainz/test          {token?}  -> {valid, userName}   (saved token if omitted)
  PUT    /listenbrainz/connection    {token}   -> status (validates, then stores encrypted)
  PATCH  /listenbrainz/settings      {enabled?, nowPlaying?} -> status
  DELETE /listenbrainz/connection    -> 204
  POST   /listenbrainz/now-playing   {trackId} -> 204 (optional "playing now")
"""
from __future__ import annotations

import sys
from typing import Optional

sys.path.insert(0, "/opt/music-server/backend")

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from . import listenbrainz as lb
from . import spotify
from .auth import require_user

import database as nova_db

router = APIRouter(prefix="/listenbrainz", tags=["listenbrainz"])


def _err(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"message": message, "code": code})


class TokenBody(BaseModel):
    token: Optional[str] = Field(default=None, max_length=256)


class SettingsBody(BaseModel):
    enabled: Optional[bool] = None
    nowPlaying: Optional[bool] = None


class NowPlayingBody(BaseModel):
    trackId: str = Field(min_length=1, max_length=128)


@router.get("/status")
async def status(account: dict = Depends(require_user)):
    return lb.status(account["id"])


async def _validate(token: str) -> dict:
    if not lb.valid_token_format(token):
        return {"valid": False, "userName": None}
    try:
        return await lb.validate_token(token)
    except lb.LBError as e:
        raise _err(502, "listenbrainz_error", str(e))


@router.post("/test")
async def test(body: TokenBody, account: dict = Depends(require_user)):
    token = (body.token or "").strip()
    if not token:
        row = lb.get_connection(account["id"])
        token = (spotify.decrypt(row["token"]) if row else None) or ""
        if not token:
            raise _err(409, "listenbrainz_not_connected", "No ListenBrainz token saved.")
    return await _validate(token)


@router.put("/connection")
async def connect_(body: TokenBody, account: dict = Depends(require_user)):
    token = (body.token or "").strip()
    res = await _validate(token)
    if not res["valid"]:
        raise _err(400, "invalid_token", "ListenBrainz rejected this token.")
    lb.save_connection(account["id"], token, res["userName"])
    return lb.status(account["id"])


@router.patch("/settings")
async def settings(body: SettingsBody, account: dict = Depends(require_user)):
    if not lb.get_connection(account["id"]):
        raise _err(409, "listenbrainz_not_connected", "ListenBrainz is not connected.")
    lb.update_settings(account["id"], body.enabled, body.nowPlaying)
    return lb.status(account["id"])


@router.delete("/connection", status_code=204)
async def disconnect(account: dict = Depends(require_user)):
    lb.delete_connection(account["id"])
    return Response(status_code=204)


@router.post("/now-playing", status_code=204)
async def now_playing(body: NowPlayingBody, account: dict = Depends(require_user)):
    track = nova_db.get_track(body.trackId)
    if track:
        await lb.send_now_playing(account["id"], track)
    return Response(status_code=204)
