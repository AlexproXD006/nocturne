"""
FastAPI dependencies for authentication and account lookup.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fastapi import Depends, HTTPException, Request, Cookie
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from .db import connect
from .tokens import decode_access_token, is_family_revoked
from .passwords import hash_password, verify_password
from .mapping import user_to_wire

_bearer = HTTPBearer(auto_error=False)

# ---------------------------------------------------------------------------
# Internal account helpers
# ---------------------------------------------------------------------------

def get_account_by_id(user_id: str) -> Optional[dict]:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM v1_accounts WHERE id=?", (user_id,)
        ).fetchone()
    return dict(row) if row else None


def get_account_by_username(username: str) -> Optional[dict]:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM v1_accounts WHERE username=? COLLATE NOCASE", (username,)
        ).fetchone()
    return dict(row) if row else None


def update_last_login(user_id: str) -> None:
    now = datetime.now(timezone.utc).isoformat()
    with connect() as conn:
        conn.execute(
            "UPDATE v1_accounts SET last_login_at=? WHERE id=?", (now, user_id)
        )


# ---------------------------------------------------------------------------
# FastAPI dependency: require a valid, non-disabled user
# ---------------------------------------------------------------------------

async def _extract_token(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
) -> Optional[str]:
    """Extracts the bearer token from Authorization header or cookie."""
    if credentials and credentials.scheme.lower() == "bearer":
        return credentials.credentials
    # Cookie session mode fallback
    access_cookie = request.cookies.get("nocturne_access")
    if access_cookie:
        return access_cookie
    return None


async def require_user(
    request: Request,
    token: Optional[str] = Depends(_extract_token),
) -> dict:
    """Dependency — returns the account dict for the authenticated user."""
    if not token:
        raise HTTPException(
            status_code=401,
            detail={"message": "Authentication required.", "code": "unauthorized"},
            headers={"WWW-Authenticate": "Bearer"},
        )
    payload = decode_access_token(token)
    if not payload:
        raise HTTPException(
            status_code=401,
            detail={"message": "Token is invalid or expired.", "code": "token_expired"},
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Family revocation check
    family_id = payload.get("fid")
    if family_id and is_family_revoked(family_id):
        raise HTTPException(
            status_code=401,
            detail={"message": "Session has been revoked.", "code": "session_revoked"},
            headers={"WWW-Authenticate": "Bearer"},
        )

    user_id = payload["sub"]
    account = get_account_by_id(user_id)
    if not account:
        raise HTTPException(
            status_code=401,
            detail={"message": "Account not found.", "code": "unauthorized"},
            headers={"WWW-Authenticate": "Bearer"},
        )
    if account.get("disabled"):
        raise HTTPException(
            status_code=403,
            detail={"message": "Account is disabled.", "code": "forbidden"},
        )
    return account


async def optional_user(
    request: Request,
    token: Optional[str] = Depends(_extract_token),
) -> Optional[dict]:
    """Dependency — returns account dict or None (does not raise)."""
    if not token:
        return None
    try:
        return await require_user(request, token)
    except HTTPException:
        return None


# ---------------------------------------------------------------------------
# Admin setup: create the first admin if no accounts exist
# ---------------------------------------------------------------------------

def create_account(
    username: str,
    password: str,
    display_name: Optional[str] = None,
    role: str = "user",
    nova_user_id: Optional[str] = None,
) -> str:
    import secrets as _secrets
    user_id = "u_" + _secrets.token_hex(12)
    now = datetime.now(timezone.utc).isoformat()
    pw_hash = hash_password(password)
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO v1_accounts
                (id, username, display_name, password_hash, role, created_at,
                 password_changed_at, nova_user_id)
            VALUES (?,?,?,?,?,?,?,?)
            """,
            (user_id, username, display_name or username, pw_hash, role, now, now, nova_user_id),
        )
    return user_id


def admin_count() -> int:
    with connect() as conn:
        row = conn.execute(
            "SELECT COUNT(*) FROM v1_accounts WHERE role='admin' AND disabled=0"
        ).fetchone()
    return row[0] if row else 0


def total_account_count() -> int:
    with connect() as conn:
        row = conn.execute("SELECT COUNT(*) FROM v1_accounts").fetchone()
    return row[0] if row else 0
