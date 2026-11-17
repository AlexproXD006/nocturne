"""
Hosts the Nocturne SPA at /.
- Static assets served with long-lived cache headers.
- index.html served for all unknown paths (SPA fallback).
- Security headers on every response.
"""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from . import config

router = APIRouter(tags=["web"])

_WEB_DIR = Path(config.WEB_DIR)
_INDEX = _WEB_DIR / "index.html"

_SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
}

_HSTS = "max-age=63072000; includeSubDomains; preload"


def _add_security(response: Response) -> Response:
    for k, v in _SECURITY_HEADERS.items():
        response.headers[k] = v
    if config.HSTS_ENABLED:
        response.headers["Strict-Transport-Security"] = _HSTS
    return response


class _SPAFiles(StaticFiles):
    """StaticFiles that falls back to index.html for unknown paths."""

    async def get_response(self, path: str, scope):
        try:
            resp = await super().get_response(path, scope)
            # If the file was found (not 404), return it
            if resp.status_code == 200:
                # Long-lived cache for hashed assets (e.g. /assets/main.abc123.js)
                if "/assets/" in path:
                    resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
                else:
                    resp.headers["Cache-Control"] = "public, max-age=86400"
                _add_security(resp)
            return resp
        except Exception:
            pass
        # Fallback to index.html (SPA routing)
        if _INDEX.exists():
            resp = FileResponse(str(_INDEX), media_type="text/html")
            resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
            _add_security(resp)
            return resp
        return Response(content="Not found", status_code=404)


_DOWNLOADS_DIR = Path(config.DOWNLOADS_DIR)  # env NOCTURNE_DOWNLOADS_DIR


def mount_downloads(app) -> None:
    """Register the Android download page and APK on the root app.

    Must be called BEFORE mount_spa so these explicit routes win over the
    SPA's catch-all mount at '/'. Served from a stable location so they
    survive web-release cutovers.
    """
    apk_path = _DOWNLOADS_DIR / "nocturne.apk"
    beta_apk_path = _DOWNLOADS_DIR / "nocturne-beta.apk"
    win_path = _DOWNLOADS_DIR / "nocturne-windows-x64.zip"
    page_path = _DOWNLOADS_DIR / "descargar.html"
    changelog_path = _DOWNLOADS_DIR / "changelog.json"

    @app.get("/descargar", include_in_schema=False)
    @app.get("/descargar/", include_in_schema=False)
    async def _download_page():
        if not page_path.exists():
            return Response(content="Download page not available.", status_code=404)
        resp = FileResponse(str(page_path), media_type="text/html")
        resp.headers["Cache-Control"] = "no-cache"
        return _add_security(resp)

    @app.api_route("/nocturne.apk", methods=["GET", "HEAD"], include_in_schema=False)
    async def _download_apk():
        if not apk_path.exists():
            return Response(content="APK not available.", status_code=404)
        resp = FileResponse(
            str(apk_path),
            media_type="application/vnd.android.package-archive",
            filename="nocturne-1.0.4.apk",
        )
        resp.headers["Cache-Control"] = "public, max-age=3600"
        return _add_security(resp)

    @app.api_route("/changelog.json", methods=["GET", "HEAD"], include_in_schema=False)
    async def _changelog():
        if not changelog_path.exists():
            return Response(content="{\"releases\": []}", media_type="application/json", status_code=404)
        resp = FileResponse(str(changelog_path), media_type="application/json")
        resp.headers["Cache-Control"] = "no-cache"
        return _add_security(resp)

    @app.api_route("/nocturne-beta.apk", methods=["GET", "HEAD"], include_in_schema=False)
    async def _download_beta_apk():
        if not beta_apk_path.exists():
            return Response(content="Beta APK not available.", status_code=404)
        resp = FileResponse(
            str(beta_apk_path),
            media_type="application/vnd.android.package-archive",
            filename="nocturne-1.0.4-beta.1.apk",
        )
        resp.headers["Cache-Control"] = "no-cache"
        return _add_security(resp)

    @app.api_route("/nocturne-windows-x64.zip", methods=["GET", "HEAD"], include_in_schema=False)
    async def _download_windows():
        if not win_path.exists():
            return Response(content="Windows build not available.", status_code=404)
        resp = FileResponse(
            str(win_path),
            media_type="application/zip",
            filename="Nocturne-Windows-x64.zip",
        )
        resp.headers["Cache-Control"] = "public, max-age=3600"
        return _add_security(resp)


def mount_spa(app) -> None:
    """Mount the SPA on the root app. Call only if WEB_DIR exists."""
    if not _WEB_DIR.is_dir():
        return
    spa = _SPAFiles(directory=str(_WEB_DIR), html=True)
    app.mount("/", spa, name="spa")
