"""
Simple in-process sliding-window rate limiter for auth endpoints.
Not suitable for multi-process deployments; for single-worker uvicorn this is fine.
"""
from __future__ import annotations

import time
from collections import defaultdict, deque
from threading import Lock
from typing import Optional

from fastapi import Request, HTTPException

_lock = Lock()
# Stores (ip, bucket) -> deque of timestamps
_windows: dict[tuple[str, str], deque] = defaultdict(deque)

# Default limits
_LOGIN_LIMIT = 10       # attempts
_LOGIN_WINDOW = 60      # seconds

# Per-IP login: 10 / 60 s
# Per-(IP+username): 5 / 60 s


def _get_ip(request: Request) -> str:
    # Trust X-Forwarded-For only from known proxies (config.TRUSTED_PROXIES)
    from . import config
    xff = request.headers.get("X-Forwarded-For", "")
    if xff and request.client and str(request.client.host) in config.TRUSTED_PROXIES:
        ip = xff.split(",")[0].strip()
        return ip or str(request.client.host)
    return str(request.client.host) if request.client else "unknown"


def _check(key: tuple, limit: int, window: int) -> Optional[int]:
    """Returns seconds to wait if rate-limited, else None."""
    now = time.monotonic()
    with _lock:
        dq = _windows[key]
        # Evict old entries
        while dq and now - dq[0] >= window:
            dq.popleft()
        if len(dq) >= limit:
            retry_after = int(window - (now - dq[0])) + 1
            return max(1, retry_after)
        dq.append(now)
        return None


def check_login(request: Request, username: str) -> None:
    """Raises 429 if the IP or (IP+username) has hit the rate limit."""
    ip = _get_ip(request)

    # Per-IP: 10 / 60s
    wait = _check(("login_ip", ip), _LOGIN_LIMIT, _LOGIN_WINDOW)
    if wait:
        raise HTTPException(
            status_code=429,
            detail={"message": "Too many login attempts. Try again later.", "code": "rate_limited"},
            headers={"Retry-After": str(wait)},
        )

    # Per-(IP+username): 5 / 60s
    wait = _check(("login_user", ip, username.lower()), 5, _LOGIN_WINDOW)
    if wait:
        raise HTTPException(
            status_code=429,
            detail={"message": "Too many login attempts. Try again later.", "code": "rate_limited"},
            headers={"Retry-After": str(wait)},
        )


def record_login_failure(request: Request, username: str) -> None:
    """Record a failed attempt in the DB for auditing (non-blocking)."""
    try:
        ip = _get_ip(request)
        from .db import connect
        from datetime import datetime, timezone
        with connect() as conn:
            conn.execute(
                "INSERT INTO v1_login_attempts(username, ip, at, success) VALUES (?,?,?,0)",
                (username.lower(), ip, datetime.now(timezone.utc).isoformat()),
            )
    except Exception:
        pass


def record_login_success(request: Request, username: str) -> None:
    try:
        ip = _get_ip(request)
        from .db import connect
        from datetime import datetime, timezone
        with connect() as conn:
            conn.execute(
                "INSERT INTO v1_login_attempts(username, ip, at, success) VALUES (?,?,?,1)",
                (username.lower(), ip, datetime.now(timezone.utc).isoformat()),
            )
    except Exception:
        pass
