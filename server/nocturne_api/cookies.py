"""
Cookie session mode for the hosted web build.
The web app (SPA) lives on the same origin as /v1, so we can use HttpOnly
SameSite cookies for the refresh token and avoid exposing it to JS at all.

Cookie names:
  nocturne_refresh  — HttpOnly, Secure*, SameSite=Strict, Path=/v1/auth
  nocturne_access   — HttpOnly, Secure*, SameSite=Strict, Path=/v1

*Secure is only set when PUBLIC_URL starts with https://
"""
from __future__ import annotations

from fastapi import Response
from . import config

_REFRESH_COOKIE = "nocturne_refresh"
_ACCESS_COOKIE = "nocturne_access"


def set_session_cookies(response: Response, access_token: str, refresh_token: str) -> None:
    secure = config.COOKIE_SECURE
    response.set_cookie(
        key=_REFRESH_COOKIE,
        value=refresh_token,
        httponly=True,
        secure=secure,
        samesite="strict",
        path="/v1/auth",
        max_age=config.REFRESH_TOKEN_TTL,
    )
    response.set_cookie(
        key=_ACCESS_COOKIE,
        value=access_token,
        httponly=True,
        secure=secure,
        samesite="strict",
        path="/v1",
        max_age=config.ACCESS_TOKEN_TTL,
    )


def clear_session_cookies(response: Response) -> None:
    response.delete_cookie(key=_REFRESH_COOKIE, path="/v1/auth")
    response.delete_cookie(key=_ACCESS_COOKIE, path="/v1")


def get_refresh_token_from_cookie(request) -> str | None:
    return request.cookies.get(_REFRESH_COOKIE)
