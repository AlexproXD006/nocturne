"""
GET /v1/updates/{platform}

Public (no auth) in-app update feed. Reads <NOCTURNE_DOWNLOADS_DIR>/latest.json
(default /opt/nocturne/downloads/latest.json; edited by hand on each release) and returns the entry for the requested
platform. Platforms: android, android-beta, windows, desktop.

"android-beta" is the feed pre-release Android builds follow; it should always
point at the newest of the latest beta and the latest stable.

Each entry looks like:
    { "version": "1.0.1", "url": "/nocturne.apk", "sha256": "...", "notes": "" }

The `url` is a server-relative path; the client turns it into an absolute
download URL using its session server address.

GitHub Releases (see releases.py) take precedence when they have a build for
the requested channel: the feed then answers the release version with
url "/descargar/<platform>" (a server route that 302-redirects to the GitHub
asset), so the url stays server-relative and installed apps keep working.
Override rule: if latest.json has an entry for the platform with the SAME
version and a non-empty url, that url (and its notes, if any) win. This keeps
one-off exceptions such as "/descargar#reinstalar" working. If latest.json is
strictly newer than GitHub, latest.json is served unchanged. With no GitHub
data the feed behaves exactly as before (latest.json only).

GET /v1/downloads is a public summary for the download page (descargar.html).
"""
from __future__ import annotations

import json
import logging
import os

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from . import config, releases

logger = logging.getLogger("nocturne")

router = APIRouter(tags=["updates"])

LATEST_PATH = os.path.join(config.DOWNLOADS_DIR, "latest.json")

# The only platforms we publish builds for.
KNOWN_PLATFORMS = {"android", "android-beta", "windows", "desktop"}


def _load_latest() -> dict:
    try:
        with open(LATEST_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            raise ValueError("latest.json is not a JSON object")
        return data
    except FileNotFoundError:
        logger.error("Nocturne updates: %s not found", LATEST_PATH)
        raise HTTPException(status_code=503, detail="Update feed is unavailable.")
    except (ValueError, json.JSONDecodeError) as e:
        logger.error("Nocturne updates: could not parse %s: %s", LATEST_PATH, e)
        raise HTTPException(status_code=503, detail="Update feed is unavailable.")


# Update-feed platform -> (GitHub channel, GitHub asset key, /descargar route).
_FEED_SOURCES = {
    "android": ("stable", "android", "android"),
    "android-beta": ("beta", "android", "android-beta"),
    "windows": ("stable", "windows", "windows"),
    "desktop": ("stable", "windows", "windows"),
}

_NOTES_MAX = 4000


def _read_latest_quiet() -> dict:
    """latest.json as a dict, or {} if missing/invalid (no exception)."""
    try:
        with open(LATEST_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _local_entry(platform: str) -> dict:
    entry = _load_latest().get(platform)
    if not isinstance(entry, dict):
        raise HTTPException(status_code=404, detail="No update information for this platform.")
    return {
        "version": str(entry.get("version", "")),
        "url": str(entry.get("url", "")),
        "sha256": str(entry.get("sha256", "")),
        "notes": str(entry.get("notes", "")),
    }


@router.get("/updates/{platform}")
async def platform_update(platform: str):
    platform = platform.lower()
    if platform not in KNOWN_PLATFORMS:
        raise HTTPException(status_code=404, detail="Unknown platform.")

    channel, asset_key, route = _FEED_SOURCES[platform]
    gh = await releases.get_releases()
    rel = (gh or {}).get(channel)
    asset = (rel or {}).get("assets", {}).get(asset_key)
    if not rel or not asset:
        # No GitHub build for this channel: unchanged latest.json behaviour.
        return _local_entry(platform)

    version = str(rel["version"])
    result = {
        "version": version,
        "url": f"/descargar/{route}",
        "sha256": asset.get("sha256") or "",
        "notes": (rel.get("body") or "")[:_NOTES_MAX],
    }
    entry = _read_latest_quiet().get(platform)
    if isinstance(entry, dict):
        local_version = str(entry.get("version", ""))
        if releases.is_newer(local_version, version):
            # Hand-published build newer than GitHub: keep serving it.
            return _local_entry(platform)
        if local_version == version and entry.get("url"):
            # Override rule: same version with an explicit url in latest.json.
            result["url"] = str(entry["url"])
            if entry.get("notes"):
                result["notes"] = str(entry["notes"])
            if not result["sha256"] and entry.get("sha256"):
                result["sha256"] = str(entry["sha256"])
    return result


# ── Download page summary ────────────────────────────────────────────────────

def _downloads_dir() -> str:
    return os.path.dirname(LATEST_PATH)


def _file_size(name: str):
    try:
        return os.path.getsize(os.path.join(_downloads_dir(), name))
    except OSError:
        return None


def _local_asset(latest: dict, feed_key: str, filename: str, display: str, route: str):
    """Asset dict for a locally hosted build, or None if it is not there."""
    size = _file_size(filename)
    if size is None:
        return None
    entry = latest.get(feed_key) if isinstance(latest.get(feed_key), dict) else {}
    return {
        "name": display,
        "size": size,
        "sha256": str(entry.get("sha256") or "") or None,
        "url": f"/descargar/{route}",
        "version": str(entry.get("version") or "") or None,
        "source": "local",
    }


def _gh_channel(rel: dict, routes: dict, latest: dict, local_fallbacks: dict) -> dict:
    assets = {}
    for key, route in routes.items():
        a = rel["assets"].get(key)
        if a:
            assets[key] = {
                "name": a["name"],
                "size": a["size"],
                "sha256": a["sha256"],
                "url": f"/descargar/{route}",
                "version": rel["version"],
                "source": "github",
            }
        elif key in local_fallbacks:
            # /descargar/<route> falls back to the local file too.
            la = _local_asset(latest, *local_fallbacks[key])
            if la:
                assets[key] = la
    return {
        "version": rel["version"],
        "published_at": rel.get("published_at"),
        "notes_url": rel.get("html_url"),
        "assets": assets,
    }


_STABLE_ROUTES = {
    "android": "android",
    "windows": "windows",
    "windows-portable": "windows-portable",
    "linux": "linux",
    "linux-deb": "linux-deb",
    "linux-rpm": "linux-rpm",
}
_STABLE_LOCAL = {
    "android": ("android", "nocturne.apk", "nocturne.apk", "android"),
    "windows": ("windows", "nocturne-windows-x64.zip", "Nocturne-Windows-x64.zip", "windows"),
}
_BETA_ROUTES = {"android": "android-beta"}
_BETA_LOCAL = {"android": ("android", "nocturne.apk", "nocturne.apk", "android-beta")}


@router.get("/downloads")
async def downloads_summary():
    gh = await releases.get_releases()
    latest = _read_latest_quiet()
    body = {
        "source": "local",
        "repo_url": releases.repo_url(),
        "releases_url": releases.releases_url(),
        "stable": None,
        "beta": None,
    }
    if gh and gh.get("stable"):
        body["source"] = "github"
        stable = gh["stable"]
        body["stable"] = _gh_channel(stable, _STABLE_ROUTES, latest, _STABLE_LOCAL)
        beta = gh.get("beta")
        if beta and beta["version"] != stable["version"]:
            body["beta"] = _gh_channel(beta, _BETA_ROUTES, latest, _BETA_LOCAL)
            body["beta"]["prerelease"] = True
    elif gh and gh.get("beta"):
        # Only pre-releases on GitHub so far: stable stays local.
        body["source"] = "github"
        body["stable"] = _local_summary(latest)
        body["beta"] = _gh_channel(gh["beta"], _BETA_ROUTES, latest, {})
        body["beta"]["prerelease"] = True
    else:
        body["stable"] = _local_summary(latest)
        body["beta"] = _local_beta(latest)
    resp = JSONResponse(body)
    resp.headers["Cache-Control"] = "public, max-age=60"
    return resp


def _local_summary(latest: dict):
    assets = {}
    for key, args in _STABLE_LOCAL.items():
        a = _local_asset(latest, *args)
        if a:
            assets[key] = a
    android = latest.get("android") if isinstance(latest.get("android"), dict) else {}
    version = str(android.get("version") or "") or None
    if not assets and not version:
        return None
    return {"version": version, "published_at": None, "notes_url": None, "assets": assets}


def _local_beta(latest: dict):
    beta = latest.get("android-beta") if isinstance(latest.get("android-beta"), dict) else {}
    stable = latest.get("android") if isinstance(latest.get("android"), dict) else {}
    bver = str(beta.get("version") or "")
    if not bver or bver == str(stable.get("version") or ""):
        return None  # no active beta
    a = _local_asset(latest, "android-beta", "nocturne-beta.apk", "nocturne-beta.apk", "android-beta")
    if a:
        a["url"] = "/nocturne-beta.apk"  # /descargar/android-beta falls back to the stable APK
    return {
        "version": bver,
        "published_at": None,
        "notes_url": None,
        "assets": {"android": a} if a else {},
        "prerelease": True,
    }
