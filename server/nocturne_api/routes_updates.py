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
"""
from __future__ import annotations

import json
import logging
import os

from fastapi import APIRouter, HTTPException

from . import config

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


@router.get("/updates/{platform}")
async def platform_update(platform: str):
    platform = platform.lower()
    if platform not in KNOWN_PLATFORMS:
        raise HTTPException(status_code=404, detail="Unknown platform.")

    entry = _load_latest().get(platform)
    if not isinstance(entry, dict):
        raise HTTPException(status_code=404, detail="No update information for this platform.")

    return {
        "version": str(entry.get("version", "")),
        "url": str(entry.get("url", "")),
        "sha256": str(entry.get("sha256", "")),
        "notes": str(entry.get("notes", "")),
    }
