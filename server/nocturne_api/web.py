"""
Hosts the product landing at / and the Nocturne SPA (web player) at /app.
- Static assets served with long-lived cache headers.
- index.html served for all unknown paths (SPA fallback).
- Security headers on every response.
"""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

from . import config, releases

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
    altstore_path = _DOWNLOADS_DIR / "altstore.json"

    @app.get("/descargar", dependencies=[Depends(_legacy_guard)], include_in_schema=False)
    @app.get("/descargar/", dependencies=[Depends(_legacy_guard)], include_in_schema=False)
    async def _download_page():
        if not page_path.exists():
            return Response(content="Download page not available.", status_code=404)
        resp = FileResponse(str(page_path), media_type="text/html")
        resp.headers["Cache-Control"] = "no-cache"
        return _add_security(resp)

    # /descargar/<target> -> 302 to the GitHub release asset (see releases.py).
    # target: (GitHub channel, asset key, local fallback path or None)
    redirect_targets = {
        "android": ("stable", "android", "/nocturne.apk"),
        "android-beta": ("beta", "android", "/nocturne.apk"),
        "windows": ("stable", "windows", "/nocturne-windows-x64.zip"),
        "windows-portable": ("stable", "windows-portable", None),
        "linux": ("stable", "linux", None),
        "linux-deb": ("stable", "linux-deb", None),
        "linux-rpm": ("stable", "linux-rpm", None),
        "ios": ("stable", "ios", None),
        "ios-beta": ("beta", "ios", None),
    }

    def _make_redirect(channel: str, asset_key: str, fallback, page: bool = False):
        async def _redirect():
            gh = await releases.get_releases()
            rel = (gh or {}).get(channel) or {}
            asset = (rel.get("assets") or {}).get(asset_key)
            if page and asset and rel.get("html_url"):
                # iOS: an .ipa cannot be installed from a browser, so send people to the release page.
                target = rel["html_url"]
            elif asset and asset.get("url"):
                target = asset["url"]
            elif fallback:
                target = fallback
            else:
                resp = Response(
                    content="This download is not available right now.",
                    media_type="text/plain",
                    status_code=404,
                )
                resp.headers["Cache-Control"] = "no-cache"
                return _add_security(resp)
            resp = RedirectResponse(target, status_code=302)
            resp.headers["Cache-Control"] = "no-cache"
            return _add_security(resp)
        return _redirect

    for _name, (_channel, _key, _fallback) in redirect_targets.items():
        app.add_api_route(
            f"/descargar/{_name}",
            _make_redirect(_channel, _key, _fallback, page=_key == "ios"),
            methods=["GET", "HEAD"],
            include_in_schema=False,
            dependencies=[Depends(_legacy_guard)],
        )

    # AltStore/SideStore source for the iOS build. Public, CORS-open and never
    # redirected (AltStore fetches it directly, also from the legacy host).
    @app.api_route("/altstore.json", methods=["GET", "HEAD"], include_in_schema=False)
    async def _altstore():
        if not altstore_path.is_file():
            return Response(content="AltStore source not available.", media_type="text/plain", status_code=404)
        resp = FileResponse(str(altstore_path), media_type="application/json")
        resp.headers["Cache-Control"] = "no-cache"
        resp.headers["Access-Control-Allow-Origin"] = "*"
        return _add_security(resp)

    @app.api_route("/nocturne.apk", methods=["GET", "HEAD"], include_in_schema=False)
    async def _download_apk():
        if not apk_path.exists():
            return Response(content="APK not available.", status_code=404)
        resp = FileResponse(
            str(apk_path),
            media_type="application/vnd.android.package-archive",
            filename="nocturne-1.0.5.apk",
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


class _LandingAssets(StaticFiles):
    """Landing assets (served under /l/): unhashed names, so a short cache."""

    async def get_response(self, path: str, scope):
        resp = await super().get_response(path, scope)
        if resp.status_code == 200:
            resp.headers["Cache-Control"] = "public, max-age=3600"
            _add_security(resp)
        return resp


# Pages that move to the canonical host (landing, /app, /descargar, landing assets).
# /v1 (API, media, Spotify callback) and the APK/zip/changelog file routes never
# redirect: installed apps and OAuth still use the legacy host. Redirects are done
# per route (dependency) and per mount (ASGI guard): middleware cannot be added
# once the app has started, and setup_nocturne runs during startup.


def _request_host(headers, client) -> str:
    """Host the browser used. X-Forwarded-Host only counts from a trusted proxy."""
    host = headers.get("host", "")
    fwd = headers.get("x-forwarded-host", "")
    if fwd and client and str(client[0] if isinstance(client, tuple) else client.host) in config.TRUSTED_PROXIES:
        host = fwd.split(",")[0].strip()
    return host.split(":")[0].strip().lower()


def _canonical_target(method: str, headers, client, path: str, query: str) -> str | None:
    if method not in ("GET", "HEAD") or not config.LEGACY_HOSTS:
        return None
    # /descargar/<target> are file-download redirects (apps may call them on the legacy host).
    if path.startswith("/descargar/") and path != "/descargar/":
        return None
    if _request_host(headers, client) not in config.LEGACY_HOSTS:
        return None
    return config.CANONICAL_WEB_URL + path + ("?" + query if query else "")


def _legacy_guard(request: Request) -> None:
    target = _canonical_target(request.method, request.headers, request.client,
                               request.url.path, request.url.query)
    if target:
        raise HTTPException(status_code=301, headers={"Location": target, **_SECURITY_HEADERS})


class _CanonicalGuard:
    """ASGI wrapper for a mounted app: 301 to the canonical host from the legacy one."""

    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            from starlette.datastructures import Headers
            rp, p = scope.get("root_path", ""), scope["path"]
            raw = scope.get("raw_path")
            if raw:  # full original path as sent by the client
                p, rp = raw.decode("latin-1").split("?", 1)[0], ""
            target = _canonical_target(
                scope["method"], Headers(scope=scope), scope.get("client"),
                p if p.startswith(rp) else rp + p,
                scope.get("query_string", b"").decode("latin-1"))
            if target:
                resp = _add_security(RedirectResponse(target, status_code=301))
                return await resp(scope, receive, send)
        return await self.inner(scope, receive, send)


def mount_landing(app, landing_dir: str | None = None) -> None:
    """Serve the static landing page at '/' and its assets under '/l/'.

    Falls back to redirecting '/' to /app/ when no landing build is installed,
    so the server can be deployed before the landing is. Also keeps old root-level
    SPA URLs working for stale browser tabs (/assets/* and /icon.svg -> /app/...).
    """
    root = Path(landing_dir or config.LANDING_DIR)
    index = root / "index.html"

    @app.api_route("/", methods=["GET", "HEAD"], dependencies=[Depends(_legacy_guard)], include_in_schema=False)
    async def _landing():
        if not index.exists():
            return RedirectResponse("/app/", status_code=302)
        resp = FileResponse(str(index), media_type="text/html")
        resp.headers["Cache-Control"] = "no-cache"
        return _add_security(resp)

    for name, mt in (("robots.txt", "text/plain"), ("sitemap.xml", "application/xml"),
                     ("favicon.svg", "image/svg+xml"), ("favicon.ico", "image/x-icon")):
        def _make(fname: str, media: str):
            async def _file():
                p = root / fname
                if not p.is_file():
                    return Response(status_code=404)
                resp = FileResponse(str(p), media_type=media)
                resp.headers["Cache-Control"] = "public, max-age=3600"
                return _add_security(resp)
            return _file
        app.add_api_route(f"/{name}", _make(name, mt), methods=["GET", "HEAD"], dependencies=[Depends(_legacy_guard)], include_in_schema=False)

    @app.api_route("/assets/{rest:path}", methods=["GET", "HEAD"], dependencies=[Depends(_legacy_guard)], include_in_schema=False)
    async def _old_assets(rest: str):
        return RedirectResponse(f"/app/assets/{rest}", status_code=307)

    @app.api_route("/icon.svg", methods=["GET", "HEAD"], dependencies=[Depends(_legacy_guard)], include_in_schema=False)
    async def _old_icon():
        return RedirectResponse("/app/icon.svg", status_code=307)

    if (root / "assets").is_dir():
        app.mount("/l", _CanonicalGuard(_LandingAssets(directory=str(root / "assets"))), name="landing-assets")


def mount_spa(app, web_dir: str | None = None) -> None:
    """Mount the SPA (hosted web player) under /app. Call only if WEB_DIR exists.

    Must run after mount_downloads/mount_landing. The SPA keeps its route in
    memory (no URL routing), so /app/* only needs real files plus the
    index.html fallback.
    """
    global _INDEX
    wd = Path(web_dir or config.WEB_DIR)
    if not wd.is_dir():
        return
    _INDEX = wd / "index.html"

    @app.api_route("/app", methods=["GET", "HEAD"], dependencies=[Depends(_legacy_guard)], include_in_schema=False)
    async def _app_slash():
        return RedirectResponse("/app/", status_code=308)

    spa = _SPAFiles(directory=str(wd), html=True)
    app.mount("/app", _CanonicalGuard(spa), name="spa")
