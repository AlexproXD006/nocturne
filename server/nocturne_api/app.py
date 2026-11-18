"""
Nocturne /v1 sub-application.
Mounted as:  main_app.mount("/v1", v1_app)

Also exports:  setup_nocturne(main_app)  which does everything needed:
  1. Runs the additive DB migration.
  2. Creates an admin account if no accounts exist.
  3. Mounts the /v1 sub-app on main_app.
  4. Mounts the SPA at / on main_app.
"""
from __future__ import annotations

import logging
import os
import sys
from typing import Any

from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import config
from .db import migrate
from .routes_auth import router as auth_router
from .routes_home import router as home_router
from .routes_library import router as library_router
from .media import router as media_router
from .admin.routes import router as admin_router
from .routes_connect import router as connect_router
from .routes_updates import router as updates_router
from .routes_playlists import router as playlists_router
from .routes_spotify import router as spotify_router
from .routes_stats import router as stats_router

logger = logging.getLogger("nocturne")

# ---------------------------------------------------------------------------
# Sub-application
# ---------------------------------------------------------------------------

v1_app = FastAPI(
    title="Nocturne API",
    version="1.0.0",
    openapi_url=None,
    docs_url=None,
    redoc_url=None,
)

# CORS — allow Nocturne desktop/Android/web origins
v1_app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["Authorization", "Content-Type", "X-Requested-With"],
    expose_headers=["Retry-After", "WWW-Authenticate"],
)


# ---------------------------------------------------------------------------
# Standard response headers middleware
# ---------------------------------------------------------------------------

@v1_app.middleware("http")
async def add_standard_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    # Cache-Control: no-store on all /v1 JSON responses
    ct = response.headers.get("content-type", "")
    if "json" in ct:
        response.headers["Cache-Control"] = "no-store"
    return response


# ---------------------------------------------------------------------------
# Exception handlers
# ---------------------------------------------------------------------------

@v1_app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    # Pass through detail if it's already a dict with our shape
    if isinstance(exc.detail, dict) and "message" in exc.detail:
        content = exc.detail
    else:
        content = {"message": str(exc.detail), "code": "error"}
    headers: dict[str, str] = {}
    if exc.status_code == 401:
        headers["WWW-Authenticate"] = "Bearer"
    if hasattr(exc, "headers") and exc.headers:
        headers.update(exc.headers)
    return JSONResponse(status_code=exc.status_code, content=content, headers=headers)


@v1_app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    errors = exc.errors()
    msg = errors[0]["msg"] if errors else "Bad request"
    return JSONResponse(
        status_code=400,
        content={"message": msg, "code": "bad_request"},
    )


@v1_app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception):
    logger.exception("Unhandled exception on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"message": "Internal server error.", "code": "server_error"},
    )


# ---------------------------------------------------------------------------
# Routers
# ---------------------------------------------------------------------------

v1_app.include_router(home_router)
v1_app.include_router(auth_router)
v1_app.include_router(library_router)
v1_app.include_router(media_router)
v1_app.include_router(admin_router)
v1_app.include_router(connect_router)
v1_app.include_router(updates_router)
v1_app.include_router(playlists_router)
v1_app.include_router(spotify_router)
v1_app.include_router(stats_router)


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def setup_nocturne(main_app: Any, mount_web: bool = True) -> None:
    """
    Call this once at startup from NOVA's main.py.
    main_app: the NOVA FastAPI() instance.
    mount_web: set False to skip the SPA mount (useful during Phase 2 before
               the old frontend is removed in Phase 4).
    """
    logger.info("Nocturne: running DB migration…")
    try:
        migrate()
    except Exception as e:
        logger.error("Nocturne DB migration failed: %s", e)
        raise

    # Create the first admin account if none exists
    _ensure_first_admin()

    # Spotify imports don't survive a restart: mark interrupted ones as failed.
    try:
        from .spotify_import import recover_interrupted
        n = recover_interrupted()
        if n:
            logger.info("Nocturne: marked %d interrupted Spotify import(s) as failed", n)
    except Exception as e:
        logger.error("Nocturne: Spotify import recovery failed: %s", e)

    # Mount /v1 sub-application
    main_app.mount("/v1", v1_app)
    logger.info("Nocturne: /v1 API mounted.")

    # Landing at / (+ /l/ assets), web player SPA under /app (Phase 4 onwards)
    if mount_web:
        from .web import mount_spa, mount_downloads, mount_landing
        # Explicit routes first: downloads, then landing; SPA mount (/app) last.
        mount_downloads(main_app)
        mount_landing(main_app)
        if os.path.isdir(config.WEB_DIR):
            mount_spa(main_app)
            logger.info("Nocturne: SPA mounted at /app from %s", config.WEB_DIR)
        else:
            logger.warning(
                "Nocturne: WEB_DIR=%s not found, SPA not mounted.", config.WEB_DIR
            )


def _ensure_first_admin() -> None:
    """
    If no accounts exist, create the initial admin from env vars
    NOCTURNE_ADMIN_USER / NOCTURNE_ADMIN_PASS.
    If those are not set, skip (admin can be created via CLI).
    """
    from .auth import total_account_count, create_account
    if total_account_count() > 0:
        return

    username = os.getenv("NOCTURNE_ADMIN_USER", "").strip()
    password = os.getenv("NOCTURNE_ADMIN_PASS", "").strip()
    if not username or not password:
        logger.warning(
            "Nocturne: no accounts exist and NOCTURNE_ADMIN_USER/NOCTURNE_ADMIN_PASS "
            "not set. Use `python -m nocturne_api.cli create-admin` to create one."
        )
        return

    if len(password) < 10:
        logger.error(
            "Nocturne: NOCTURNE_ADMIN_PASS is too short (< 10 chars). Admin not created."
        )
        return

    user_id = create_account(username, password, role="admin")
    logger.info("Nocturne: created initial admin account '%s' (id=%s)", username, user_id)
