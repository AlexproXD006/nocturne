"""
Crash / diagnostic reports from the apps.

POST   /v1/diagnostics/crash        any signed-in user; body <= 64 KB JSON; rate limited
GET    /v1/admin/diagnostics        admin: newest first
DELETE /v1/admin/diagnostics        admin: delete all
DELETE /v1/admin/diagnostics/{id}   admin: delete one

Reports are scrubbed again server-side (URL query strings, bearer tokens, JWTs, key=value secrets).
"""
from __future__ import annotations

import asyncio
import json
import re
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from .auth import require_user
from .db import connect
from .ratelimit import _check
from .roles import require_admin

router = APIRouter(tags=["diagnostics"])

MAX_BODY_BYTES = 64 * 1024
MAX_FIELD = 200
MAX_TEXT = 48 * 1024
RATE_LIMIT = 6          # reports
RATE_WINDOW = 600       # seconds
KEEP_ROWS = 500

_URL_QUERY = re.compile(r"(?i)(https?://[^\s?#\"'<>()]*)\?[^\s\"'<>()]*")
_JWT = re.compile(r"eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*")
_BEARER = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}")
_KEYED = re.compile(
    r"(?i)(authorization|bearer|token|password|passwd|secret|signature|api[_-]?key|cookie|session)([\"']?\s*[:=]\s*[\"']?|\s+)[^\s\"',;&)]+"
)


def scrub(text: str) -> str:
    out = _URL_QUERY.sub(r"\1?<redacted>", text)
    out = _BEARER.sub("Bearer <redacted>", out)
    out = _JWT.sub("<jwt>", out)
    out = _KEYED.sub(r"\1\2<redacted>", out)
    return out


def _field(v: Any, limit: int = MAX_FIELD) -> str:
    return scrub(v.strip())[:limit] if isinstance(v, str) else ""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _store(user_id: str, data: dict) -> str:
    kind = _field(data.get("kind"), 20)
    if kind not in ("native", "js", "log", "other"):
        kind = "other"
    source = "manual" if data.get("source") == "manual" else "crash"
    body_raw = data.get("trace") if isinstance(data.get("trace"), str) else data.get("log")
    body = scrub(body_raw if isinstance(body_raw, str) else "")[:MAX_TEXT]
    if not body.strip():
        raise HTTPException(status_code=400, detail={"message": "Report is empty.", "code": "bad_request"})
    at = data.get("at")
    occurred = datetime.fromtimestamp(at / 1000, timezone.utc).isoformat(timespec="seconds") if isinstance(at, (int, float)) and 0 < at < 4e12 else None
    rid = uuid.uuid4().hex
    with connect() as conn:
        conn.execute(
            "INSERT INTO v1_diagnostics(id, user_id, created_at, source, kind, app_version, os, device, occurred_at, body)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)",
            (rid, user_id, _now(), source, kind, _field(data.get("version"), 40), _field(data.get("android") or data.get("os")),
             _field(data.get("device")), occurred, body),
        )
        conn.execute(
            "DELETE FROM v1_diagnostics WHERE id NOT IN (SELECT id FROM v1_diagnostics ORDER BY created_at DESC, rowid DESC LIMIT ?)",
            (KEEP_ROWS,),
        )
        conn.commit()
    return rid


def _list() -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT d.*, a.username AS username FROM v1_diagnostics d LEFT JOIN v1_accounts a ON a.id = d.user_id"
            " ORDER BY d.created_at DESC, d.rowid DESC LIMIT 200"
        ).fetchall()
    return [
        {
            "id": r["id"], "userId": r["user_id"], "username": r["username"], "createdAt": r["created_at"],
            "occurredAt": r["occurred_at"], "source": r["source"], "kind": r["kind"], "version": r["app_version"],
            "os": r["os"], "device": r["device"], "body": r["body"],
        }
        for r in rows
    ]


@router.post("/diagnostics/crash", status_code=201)
async def post_crash(request: Request, account: dict = Depends(require_user)):
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail={"message": "Report too large (64 KB max).", "code": "payload_too_large"})
    raw = await request.body()
    if len(raw) > MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail={"message": "Report too large (64 KB max).", "code": "payload_too_large"})
    try:
        data = json.loads(raw or b"{}")
    except ValueError:
        raise HTTPException(status_code=400, detail={"message": "Invalid JSON.", "code": "bad_request"})
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail={"message": "Invalid report.", "code": "bad_request"})
    wait = _check(("diag", account["id"]), RATE_LIMIT, RATE_WINDOW)
    if wait:
        raise HTTPException(status_code=429, detail={"message": "Too many reports. Try again later.", "code": "rate_limited"},
                            headers={"Retry-After": str(wait)})
    rid = await asyncio.to_thread(_store, account["id"], data)
    return {"id": rid}


@router.get("/admin/diagnostics")
async def admin_list(account: dict = Depends(require_admin)):
    return {"reports": await asyncio.to_thread(_list)}


@router.delete("/admin/diagnostics", status_code=204)
async def admin_clear(account: dict = Depends(require_admin)):
    def run() -> None:
        with connect() as conn:
            conn.execute("DELETE FROM v1_diagnostics")
            conn.commit()
    await asyncio.to_thread(run)
    return Response(status_code=204)


@router.delete("/admin/diagnostics/{report_id}", status_code=204)
async def admin_delete(report_id: str, account: dict = Depends(require_admin)):
    def run() -> int:
        with connect() as conn:
            n = conn.execute("DELETE FROM v1_diagnostics WHERE id=?", (report_id,)).rowcount
            conn.commit()
            return n
    if not await asyncio.to_thread(run):
        raise HTTPException(status_code=404, detail={"message": "Report not found.", "code": "not_found"})
    return Response(status_code=204)
