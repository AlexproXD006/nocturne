"""
/v1/connect/* — Nocturne Connect: remote playback control between a user's devices.

Each running Nocturne instance (browser tab, Android app, desktop) registers a
session, reports its playback state, and opens an SSE stream to receive commands.
A controlling device lists the user's sessions and posts commands to them.

Push mechanism: an in-process registry of asyncio.Queues keyed by session id.
This works because the server runs a single uvicorn worker. Commands for an
offline session (no live SSE listener) are reported back to the caller as such
rather than queued.
"""
from __future__ import annotations

import asyncio
import json
import secrets
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse, Response
from pydantic import BaseModel

from .auth import require_user, get_account_by_id
from .tokens import decode_access_token, is_family_revoked
from .db import connect

router = APIRouter(prefix="/connect", tags=["connect"])

# How long without a heartbeat before a session is considered offline.
SESSION_TTL_SECONDS = 60

# ---------------------------------------------------------------------------
# In-process listener registry (single worker). session_id -> set of Queues.
# ---------------------------------------------------------------------------

_listeners: dict[str, set[asyncio.Queue]] = {}


def _push(session_id: str, event: dict) -> bool:
    """Push an event to all live listeners of a session. Returns True if any."""
    queues = _listeners.get(session_id)
    if not queues:
        return False
    delivered = False
    for q in list(queues):
        try:
            q.put_nowait(event)
            delivered = True
        except asyncio.QueueFull:
            pass
    return delivered


def _is_online(session_id: str) -> bool:
    return bool(_listeners.get(session_id))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _own_session_or_404(session_id: str, user_id: str) -> dict:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM v1_connect_sessions WHERE id=? AND user_id=?",
            (session_id, user_id),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail={"message": "Session not found.", "code": "not_found"})
    return dict(row)


def _parse_state(raw: str) -> dict:
    try:
        v = json.loads(raw)
        return v if isinstance(v, dict) else {}
    except (ValueError, TypeError):
        return {}


def _session_to_wire(row: dict) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "platform": row["platform"],
        "controllable": bool(row["controllable"]),
        "state": _parse_state(row["state"]),
        "online": _is_online(row["id"]),
        "lastSeenAt": row["last_seen"],
    }


def _prune_stale(user_id: str) -> None:
    """Delete sessions for a user whose heartbeat is older than the TTL and
    that have no live SSE listener."""
    cutoff = datetime.now(timezone.utc).timestamp() - SESSION_TTL_SECONDS
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, last_seen FROM v1_connect_sessions WHERE user_id=?", (user_id,)
        ).fetchall()
        stale = []
        for r in rows:
            if _is_online(r["id"]):
                continue
            try:
                ts = datetime.fromisoformat(r["last_seen"]).timestamp()
            except (ValueError, TypeError):
                ts = 0
            if ts < cutoff:
                stale.append(r["id"])
        for sid in stale:
            conn.execute("DELETE FROM v1_connect_sessions WHERE id=?", (sid,))


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class RegisterBody(BaseModel):
    name: str
    platform: str = "web"
    controllable: bool = True


class StateBody(BaseModel):
    state: dict


_COMMAND_KINDS = {
    "play", "pause", "toggle", "next", "previous",
    "seek", "setShuffle", "setRepeat", "setVolume", "stop", "transferTo",
}


class CommandBody(BaseModel):
    kind: str
    payload: Optional[dict] = None


# ---------------------------------------------------------------------------
# Session lifecycle
# ---------------------------------------------------------------------------

@router.post("/sessions", status_code=201)
async def register_session(body: RegisterBody, account: dict = Depends(require_user)):
    name = (body.name or "").strip()[:80] or "Nocturne"
    platform = (body.platform or "web").strip()[:32] or "web"
    session_id = "cs_" + secrets.token_hex(12)
    now = _now()
    with connect() as conn:
        conn.execute(
            """INSERT INTO v1_connect_sessions
               (id, user_id, name, platform, controllable, state, last_seen, created_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (session_id, account["id"], name, platform,
             1 if body.controllable else 0, "{}", now, now),
        )
    return {"id": session_id, "name": name, "platform": platform,
            "controllable": body.controllable, "state": {}, "online": False, "lastSeenAt": now}


@router.get("/sessions")
async def list_sessions(account: dict = Depends(require_user)):
    _prune_stale(account["id"])
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM v1_connect_sessions WHERE user_id=? ORDER BY created_at",
            (account["id"],),
        ).fetchall()
    return {"sessions": [_session_to_wire(dict(r)) for r in rows]}


@router.delete("/sessions/{session_id}", status_code=204)
async def unregister_session(session_id: str, account: dict = Depends(require_user)):
    _own_session_or_404(session_id, account["id"])
    with connect() as conn:
        conn.execute("DELETE FROM v1_connect_sessions WHERE id=?", (session_id,))
    # Let any live listener know it was removed.
    _push(session_id, {"type": "closed"})
    return Response(status_code=204)


@router.put("/sessions/{session_id}/state", status_code=204)
async def update_state(session_id: str, body: StateBody, account: dict = Depends(require_user)):
    _own_session_or_404(session_id, account["id"])
    now = _now()
    with connect() as conn:
        conn.execute(
            "UPDATE v1_connect_sessions SET state=?, last_seen=? WHERE id=?",
            (json.dumps(body.state)[:16000], now, session_id),
        )
    # Notify this user's OTHER sessions that watch this one (controllers).
    _push(session_id, {"type": "state", "state": body.state})
    return Response(status_code=204)


@router.post("/sessions/{session_id}/heartbeat", status_code=204)
async def heartbeat(session_id: str, account: dict = Depends(require_user)):
    _own_session_or_404(session_id, account["id"])
    with connect() as conn:
        conn.execute(
            "UPDATE v1_connect_sessions SET last_seen=? WHERE id=?", (_now(), session_id)
        )
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

@router.post("/sessions/{session_id}/commands", status_code=202)
async def send_command(session_id: str, body: CommandBody, account: dict = Depends(require_user)):
    if body.kind not in _COMMAND_KINDS:
        raise HTTPException(status_code=400, detail={"message": "Unknown command.", "code": "bad_request"})
    row = _own_session_or_404(session_id, account["id"])
    if not row["controllable"]:
        raise HTTPException(status_code=409, detail={"message": "This device cannot be controlled.", "code": "conflict"})
    delivered = _push(session_id, {"type": "command", "kind": body.kind, "payload": body.payload or {}})
    if not delivered:
        raise HTTPException(status_code=409, detail={"message": "That device is offline.", "code": "offline"})
    return {"delivered": True}


# ---------------------------------------------------------------------------
# SSE event stream
# ---------------------------------------------------------------------------

async def _authenticate_sse(request: Request, token: Optional[str]) -> dict:
    """SSE auth: EventSource cannot send headers, so accept the access token
    from the Authorization header, the session cookie, or an access_token query
    param (HTTPS only; token is short-lived)."""
    raw = token
    if not raw:
        auth = request.headers.get("Authorization", "")
        if auth.lower().startswith("bearer "):
            raw = auth[7:]
    if not raw:
        raw = request.cookies.get("nocturne_access")
    if not raw:
        raise HTTPException(status_code=401, detail={"message": "Authentication required.", "code": "unauthorized"})
    payload = decode_access_token(raw)
    if not payload:
        raise HTTPException(status_code=401, detail={"message": "Token is invalid or expired.", "code": "token_expired"})
    fid = payload.get("fid")
    if fid and is_family_revoked(fid):
        raise HTTPException(status_code=401, detail={"message": "Session has been revoked.", "code": "session_revoked"})
    account = get_account_by_id(payload["sub"])
    if not account or account.get("disabled"):
        raise HTTPException(status_code=401, detail={"message": "Account not available.", "code": "unauthorized"})
    return account


@router.get("/sessions/{session_id}/events")
async def session_events(session_id: str, request: Request, access_token: Optional[str] = None):
    account = await _authenticate_sse(request, access_token)
    _own_session_or_404(session_id, account["id"])

    queue: asyncio.Queue = asyncio.Queue(maxsize=64)
    _listeners.setdefault(session_id, set()).add(queue)

    async def event_stream():
        try:
            yield ": connected\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=20)
                    yield f"data: {json.dumps(event)}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            qs = _listeners.get(session_id)
            if qs:
                qs.discard(queue)
                if not qs:
                    _listeners.pop(session_id, None)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
