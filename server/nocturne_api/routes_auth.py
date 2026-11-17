"""
POST /v1/auth/login
POST /v1/auth/refresh
POST /v1/auth/logout
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

from .auth import (
    get_account_by_username,
    update_last_login,
    create_account,
    admin_count,
    total_account_count,
    get_account_by_id,
)
from .cookies import (
    set_session_cookies,
    clear_session_cookies,
    get_refresh_token_from_cookie,
)
from .mapping import user_to_wire
from .passwords import verify_password, dummy_verify
from .ratelimit import check_login, record_login_failure, record_login_success
from .tokens import (
    create_access_token,
    create_refresh_token,
    create_token_family,
    rotate_refresh_token,
    revoke_family,
    get_family_by_token_hash,
)
from . import config

router = APIRouter(prefix="/auth", tags=["auth"])

_401 = {"message": "Invalid username or password.", "code": "unauthorized"}


class LoginBody(BaseModel):
    username: str
    password: str


class RefreshBody(BaseModel):
    refreshToken: Optional[str] = None


class LogoutBody(BaseModel):
    refreshToken: Optional[str] = None


def _build_session(account: dict) -> dict:
    family_id = create_token_family(account["id"])
    access_token, exp = create_access_token(account["id"], family_id)
    refresh_token, _ = create_refresh_token(account["id"], family_id)
    return {
        "accessToken": access_token,
        "refreshToken": refresh_token,
        "expiresIn": config.ACCESS_TOKEN_TTL,
        "user": user_to_wire(account),
        "_family_id": family_id,
    }


@router.post("/login")
async def login(body: LoginBody, request: Request, response: Response):
    check_login(request, body.username)

    account = get_account_by_username(body.username)
    if not account:
        dummy_verify()
        record_login_failure(request, body.username)
        raise HTTPException(status_code=401, detail=_401)

    ok, needs_rehash = verify_password(body.password, account["password_hash"] or "")
    if not ok:
        record_login_failure(request, body.username)
        raise HTTPException(status_code=401, detail=_401)

    if account.get("disabled"):
        raise HTTPException(
            status_code=403,
            detail={"message": "Account is disabled.", "code": "forbidden"},
        )

    if needs_rehash:
        from .passwords import hash_password
        from .db import connect
        with connect() as conn:
            conn.execute(
                "UPDATE v1_accounts SET password_hash=? WHERE id=?",
                (hash_password(body.password), account["id"]),
            )

    session = _build_session(account)
    update_last_login(account["id"])
    record_login_success(request, body.username)

    # Set cookies for web app (same-origin); Bearer clients ignore them
    set_session_cookies(response, session["accessToken"], session["refreshToken"])

    return {k: v for k, v in session.items() if k != "_family_id"}


@router.post("/refresh")
async def refresh(body: RefreshBody, request: Request, response: Response):
    # Accept token from body or cookie (cookie takes precedence for web app)
    raw = get_refresh_token_from_cookie(request) or body.refreshToken
    if not raw:
        raise HTTPException(
            status_code=400,
            detail={"message": "refreshToken is required.", "code": "bad_request"},
        )

    result = rotate_refresh_token(raw)
    if result is None:
        clear_session_cookies(response)
        raise HTTPException(
            status_code=401,
            detail={"message": "Session expired or revoked.", "code": "token_expired"},
        )

    new_raw, new_id, user_id = result
    account = get_account_by_id(user_id)
    if not account or account.get("disabled"):
        clear_session_cookies(response)
        raise HTTPException(
            status_code=401,
            detail={"message": "Session expired or revoked.", "code": "token_expired"},
        )

    # Get the family from the new token (it's in the same family)
    from .db import connect
    row = connect().execute(
        "SELECT family_id FROM v1_refresh_tokens WHERE id=?", (new_id,)
    ).fetchone()
    family_id = row["family_id"] if row else "unknown"

    access_token, _ = create_access_token(user_id, family_id)

    set_session_cookies(response, access_token, new_raw)
    return {
        "accessToken": access_token,
        "refreshToken": new_raw,
        "expiresIn": config.ACCESS_TOKEN_TTL,
        "user": user_to_wire(account),
    }


@router.post("/logout", status_code=204)
async def logout(body: LogoutBody, request: Request, response: Response):
    raw = get_refresh_token_from_cookie(request) or body.refreshToken
    if raw:
        try:
            family_id = get_family_by_token_hash(raw)
            if family_id:
                revoke_family(family_id, reason="logout")
        except Exception:
            pass

    clear_session_cookies(response)
    return Response(status_code=204)
