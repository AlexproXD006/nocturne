"""
ListenBrainz scrobbling. The user pastes their ListenBrainz user token (profile
page); it is stored encrypted (spotify.encrypt) and never logged. Listens are
queued in v1_listenbrainz_queue when a play is recorded and submitted by a small
background worker with exponential backoff (the queue is persisted, so restarts
and outages lose nothing). Tests replace `_transport` with an httpx.MockTransport.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import httpx

from . import spotify
from .db import connect

logger = logging.getLogger("nocturne.listenbrainz")

API = "https://api.listenbrainz.org/1"
HTTP_TIMEOUT = 15.0
MAX_ATTEMPTS = 14
BACKOFF_BASE = 30          # seconds; doubles each attempt, capped
BACKOFF_CAP = 6 * 3600
POLL_SECONDS = 20
TOKEN_RE = re.compile(r"^[A-Za-z0-9._~-]{8,128}$")

_transport: Optional[httpx.AsyncBaseTransport] = None
_wake: Optional[asyncio.Event] = None


class LBError(Exception):
    def __init__(self, message: str, status: int = 0, retryable: bool = True):
        super().__init__(message)
        self.status, self.retryable = status, retryable


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(d: datetime) -> str:
    return d.isoformat()


def valid_token_format(token: Optional[str]) -> bool:
    return bool(token and TOKEN_RE.match(token))


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=_transport, timeout=HTTP_TIMEOUT,
                             headers={"User-Agent": "Nocturne/1.0 (self-hosted music server)"})


def _msg(resp: httpx.Response) -> str:
    try:
        return str(resp.json().get("error") or resp.json().get("message") or resp.status_code)
    except Exception:
        return f"HTTP {resp.status_code}"


async def validate_token(token: str) -> dict:
    """{'valid': bool, 'userName': str|None}. Raises LBError on network/5xx problems."""
    try:
        async with _client() as c:
            r = await c.get(f"{API}/validate-token", headers={"Authorization": f"Token {token}"})
    except httpx.HTTPError as e:
        raise LBError(f"ListenBrainz unreachable ({type(e).__name__})") from None
    if r.status_code >= 500 or r.status_code == 429:
        raise LBError(f"ListenBrainz error: {_msg(r)}", r.status_code)
    try:
        d = r.json()
    except ValueError:
        d = {}
    ok = r.status_code == 200 and bool(d.get("valid"))
    return {"valid": ok, "userName": d.get("user_name") if ok else None}


async def _submit(token: str, listen_type: str, payload: dict) -> None:
    body = {"listen_type": listen_type, "payload": [payload]}
    try:
        async with _client() as c:
            r = await c.post(f"{API}/submit-listens", json=body,
                             headers={"Authorization": f"Token {token}"})
    except httpx.HTTPError as e:
        raise LBError(f"network error ({type(e).__name__})") from None
    if r.status_code == 200:
        return
    retry = r.status_code >= 500 or r.status_code == 429
    raise LBError(_msg(r), r.status_code, retryable=retry)


# --------------------------------------------------------------------------
# Connection store
# --------------------------------------------------------------------------

def get_connection(user_id: str) -> Optional[dict]:
    with connect() as conn:
        row = conn.execute("SELECT * FROM v1_listenbrainz WHERE user_id=?", (user_id,)).fetchone()
    return dict(row) if row else None


def save_connection(user_id: str, token: str, lb_user: Optional[str]) -> None:
    now = _iso(_now())
    with connect() as conn:
        conn.execute(
            "INSERT INTO v1_listenbrainz(user_id, token, lb_user, enabled, now_playing, created_at, updated_at)"
            " VALUES (?,?,?,1,0,?,?) ON CONFLICT(user_id) DO UPDATE SET token=excluded.token,"
            " lb_user=excluded.lb_user, last_error=NULL, updated_at=excluded.updated_at",
            (user_id, spotify.encrypt(token), lb_user, now, now))


def update_settings(user_id: str, enabled: Optional[bool], now_playing: Optional[bool]) -> None:
    sets, args = [], []
    if enabled is not None:
        sets.append("enabled=?"); args.append(1 if enabled else 0)
    if now_playing is not None:
        sets.append("now_playing=?"); args.append(1 if now_playing else 0)
    if not sets:
        return
    sets.append("updated_at=?"); args.append(_iso(_now()))
    with connect() as conn:
        conn.execute(f"UPDATE v1_listenbrainz SET {', '.join(sets)} WHERE user_id=?", (*args, user_id))


def delete_connection(user_id: str) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM v1_listenbrainz WHERE user_id=?", (user_id,))
        conn.execute("DELETE FROM v1_listenbrainz_queue WHERE user_id=?", (user_id,))


def status(user_id: str) -> dict:
    row = get_connection(user_id)
    if not row:
        return {"connected": False, "enabled": False, "nowPlaying": False,
                "userName": None, "pending": 0, "lastError": None}
    with connect() as conn:
        pending = conn.execute("SELECT COUNT(*) FROM v1_listenbrainz_queue WHERE user_id=?",
                               (user_id,)).fetchone()[0]
    return {"connected": True, "enabled": bool(row["enabled"]), "nowPlaying": bool(row["now_playing"]),
            "userName": row["lb_user"], "pending": pending, "lastError": row["last_error"],
            "lastOkAt": row["last_ok_at"]}


# --------------------------------------------------------------------------
# Queue
# --------------------------------------------------------------------------

def track_metadata(track: dict) -> dict:
    info: dict[str, Any] = {"media_player": "Nocturne", "submission_client": "Nocturne",
                            "music_service_name": "Nocturne"}
    if track.get("duration"):
        info["duration_ms"] = int(track["duration"]) * 1000
    md: dict[str, Any] = {"artist_name": track.get("artist") or "", "track_name": track.get("title") or "",
                          "additional_info": info}
    if track.get("album"):
        md["release_name"] = track["album"]
    return md


def enqueue_listen(user_id: str, track: dict, played_at_iso: str, play_id: Optional[str]) -> bool:
    """Queue a listen if the user has ListenBrainz enabled. Never raises."""
    try:
        row = get_connection(user_id)
        if not row or not row["enabled"]:
            return False
        md = track_metadata(track)
        if not md["artist_name"] or not md["track_name"]:
            return False
        try:
            d = datetime.fromisoformat(played_at_iso.replace("Z", "+00:00"))
            if d.tzinfo is None:
                d = d.replace(tzinfo=timezone.utc)
        except ValueError:
            d = _now()
        now = _iso(_now())
        with connect() as conn:
            cur = conn.execute(
                "INSERT OR IGNORE INTO v1_listenbrainz_queue(user_id, play_id, listened_at, payload,"
                " next_attempt_at, created_at) VALUES (?,?,?,?,?,?)",
                (user_id, play_id, int(d.timestamp()), json.dumps(md), now, now))
            added = (cur.rowcount or 0) > 0
        if added and _wake is not None:
            _wake.set()
        return added
    except Exception as e:  # scrobbling must never break play recording
        logger.warning("ListenBrainz enqueue failed: %s", type(e).__name__)
        return False


def _backoff(attempts: int) -> timedelta:
    return timedelta(seconds=min(BACKOFF_CAP, BACKOFF_BASE * (2 ** max(0, attempts - 1))))


async def process_queue(limit: int = 50, now: Optional[datetime] = None) -> dict:
    """Submit due listens once. Returns counters (sent/retry/dropped)."""
    now = now or _now()
    out = {"sent": 0, "retry": 0, "dropped": 0}
    with connect() as conn:
        rows = [dict(r) for r in conn.execute(
            "SELECT * FROM v1_listenbrainz_queue WHERE next_attempt_at<=? ORDER BY id LIMIT ?",
            (_iso(now), limit))]
    blocked: set[str] = set()   # a user whose submission just failed waits for the next round
    for r in rows:
        uid = r["user_id"]
        if uid in blocked:
            continue
        conn_row = get_connection(uid)
        if not conn_row or not conn_row["enabled"]:
            _delete(r["id"]); out["dropped"] += 1
            continue
        token = spotify.decrypt(conn_row["token"])
        if not token:
            _fail(r, uid, "stored token unreadable", retryable=False, now=now, out=out)
            continue
        payload = {"listened_at": r["listened_at"], "track_metadata": json.loads(r["payload"])}
        try:
            await _submit(token, "single", payload)
        except LBError as e:
            _fail(r, uid, str(e), retryable=e.retryable, now=now, out=out, status=e.status)
            blocked.add(uid)
            continue
        _delete(r["id"])
        with connect() as conn:
            conn.execute("UPDATE v1_listenbrainz SET last_ok_at=?, last_error=NULL WHERE user_id=?",
                         (_iso(now), uid))
        out["sent"] += 1
    return out


def _delete(qid: int) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM v1_listenbrainz_queue WHERE id=?", (qid,))


def _fail(r: dict, uid: str, message: str, *, retryable: bool, now: datetime, out: dict,
          status: int = 0) -> None:
    attempts = r["attempts"] + 1
    message = message[:200]
    with connect() as conn:
        conn.execute("UPDATE v1_listenbrainz SET last_error=? WHERE user_id=?", (message, uid))
        if status == 401:
            # Token revoked: stop scrobbling until the user reconnects.
            conn.execute("UPDATE v1_listenbrainz SET enabled=0 WHERE user_id=?", (uid,))
        if not retryable or attempts >= MAX_ATTEMPTS or status == 401:
            conn.execute("DELETE FROM v1_listenbrainz_queue WHERE id=?", (r["id"],))
            out["dropped"] += 1
            return
        conn.execute(
            "UPDATE v1_listenbrainz_queue SET attempts=?, next_attempt_at=?, last_error=? WHERE id=?",
            (attempts, _iso(now + _backoff(attempts)), message, r["id"]))
    out["retry"] += 1


async def send_now_playing(user_id: str, track: dict) -> bool:
    """Best-effort 'playing now' (no retry). True when submitted."""
    row = get_connection(user_id)
    if not row or not row["enabled"] or not row["now_playing"]:
        return False
    token = spotify.decrypt(row["token"])
    md = track_metadata(track)
    if not token or not md["artist_name"] or not md["track_name"]:
        return False
    try:
        await _submit(token, "playing_now", {"track_metadata": md})
        return True
    except LBError:
        return False


async def worker_loop() -> None:
    global _wake
    _wake = asyncio.Event()
    while True:
        try:
            await process_queue()
        except Exception as e:
            logger.warning("ListenBrainz worker error: %s", type(e).__name__)
        try:
            await asyncio.wait_for(_wake.wait(), timeout=POLL_SECONDS)
        except asyncio.TimeoutError:
            pass
        _wake.clear()
