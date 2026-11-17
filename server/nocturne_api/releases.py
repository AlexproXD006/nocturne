"""
GitHub Releases resolver for app downloads and the in-app update feed.

get_releases() asks the public, unauthenticated GitHub API for the latest
releases of config.RELEASES_REPO (env NOCTURNE_RELEASES_REPO, default
AlexproXD006/nocturne; an empty value disables GitHub entirely) and returns

    {
      "repo": "owner/name",
      "stable": <release> | None,   # newest non-prerelease by SemVer
      "beta":   <release> | None,   # newest of (newest prerelease, stable)
    }

or None when nothing usable is known (disabled, network error with no earlier
good data, no releases yet). Each <release> is

    {
      "version": "1.0.5", "tag": "v1.0.5", "prerelease": False,
      "published_at": "...", "html_url": "...", "body": "...",
      "assets": { "<platform key>": {"name", "url", "size", "sha256"} },
    }

with platform keys android, windows (NSIS setup), windows-portable,
linux (AppImage), linux-deb and linux-rpm. "url" is the asset's GitHub
browser_download_url; callers must never hand it to the apps directly (they
build download URLs as serverUrl + url), only redirect to it.

Caching (in memory, per process): a good answer is kept 10 minutes; a failed
refresh is retried after 2 minutes, and meanwhile the last good data (if any)
keeps being served.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from typing import Any, Optional

import httpx

from . import config

logger = logging.getLogger("nocturne")

API_URL = "https://api.github.com/repos/{repo}/releases?per_page=20"
TIMEOUT_S = 8.0
TTL_OK_S = 600.0
TTL_FAIL_S = 120.0
HEADERS = {
    "User-Agent": "Nocturne-Server",
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}

_REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
_SEMVER_RE = re.compile(
    r"^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$"
)
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

# Optional httpx transport override (tests inject httpx.MockTransport here).
_TRANSPORT: Optional[httpx.AsyncBaseTransport] = None

# Cache state.
_cache: dict[str, Any] = {
    "key": None,        # repo the data belongs to
    "data": None,       # last good resolved data (or None)
    "expires": 0.0,     # monotonic time after which we try to refresh
}
_lock: Optional[asyncio.Lock] = None
_lock_loop: Optional[asyncio.AbstractEventLoop] = None


def reset_cache() -> None:
    """Forget everything cached (used by tests)."""
    _cache.update(key=None, data=None, expires=0.0)


def repo() -> str:
    """The configured repository, or "" when GitHub is disabled/invalid."""
    r = (getattr(config, "RELEASES_REPO", "") or "").strip().strip("/")
    if not r:
        return ""
    if not _REPO_RE.match(r):
        logger.warning("Nocturne releases: invalid NOCTURNE_RELEASES_REPO %r, GitHub disabled", r)
        return ""
    return r


def repo_url() -> Optional[str]:
    r = repo()
    return f"https://github.com/{r}" if r else None


def releases_url() -> Optional[str]:
    r = repo()
    return f"https://github.com/{r}/releases" if r else None


# ── SemVer ───────────────────────────────────────────────────────────────────

def parse_semver(tag: str) -> Optional[tuple]:
    """Sort key for a SemVer tag (leading "v" allowed), or None if not SemVer.

    Pre-release aware: 1.0.5 > 1.0.5-beta.2 > 1.0.5-beta.1 > 1.0.4.
    """
    m = _SEMVER_RE.match((tag or "").strip())
    if not m:
        return None
    major, minor, patch, pre = int(m.group(1)), int(m.group(2)), int(m.group(3)), m.group(4)
    if pre is None:
        return (major, minor, patch, 1, ())
    ids = []
    for part in pre.split("."):
        # Numeric identifiers sort before alphanumeric ones (SemVer 2.0 §11).
        ids.append((0, int(part), "") if part.isdigit() else (1, 0, part))
    return (major, minor, patch, 0, tuple(ids))


def is_newer(a: str, b: str) -> bool:
    """True if version a is strictly newer than version b (both SemVer)."""
    ka, kb = parse_semver(a), parse_semver(b)
    return ka is not None and kb is not None and ka > kb


# ── Asset matching ───────────────────────────────────────────────────────────

_PLATFORM_PATTERNS: dict[str, re.Pattern] = {
    # Debug APKs are never published, but skip them defensively anyway.
    "android": re.compile(r"^(?!.*debug).*\.apk$", re.I),
    "windows": re.compile(r"setup.*\.exe$", re.I),
    "windows-portable": re.compile(r"portable.*\.exe$", re.I),
    "linux": re.compile(r"\.appimage$", re.I),
    "linux-deb": re.compile(r"\.deb$", re.I),
    "linux-rpm": re.compile(r"\.rpm$", re.I),
}
PLATFORM_KEYS = tuple(_PLATFORM_PATTERNS)

_ARCH_X64 = re.compile(r"(x64|x86[_-]64|amd64)", re.I)
_ARCH_OTHER = re.compile(r"(arm64|aarch64|armv7l|armhf|ia32|i386|i686)", re.I)


def _asset_score(platform: str, name: str) -> int:
    score = 0
    if _ARCH_X64.search(name):
        score += 4
    elif not _ARCH_OTHER.search(name):
        score += 2  # no arch in the name: probably universal/x64
    if platform == "android" and re.search(r"release", name, re.I):
        score += 1
    return score


def _digest(asset: dict) -> Optional[str]:
    d = asset.get("digest")
    if not isinstance(d, str) or not d.lower().startswith("sha256:"):
        return None
    h = d.split(":", 1)[1].strip().lower()
    return h if _SHA256_RE.match(h) else None


def _pick_assets(raw_assets: list, repo_name: str) -> dict[str, dict]:
    prefix = f"https://github.com/{repo_name}/releases/download/".lower()
    found: dict[str, tuple[int, dict]] = {}
    for a in raw_assets or []:
        if not isinstance(a, dict):
            continue
        name = str(a.get("name") or "")
        url = str(a.get("browser_download_url") or "")
        if not name or not url.lower().startswith(prefix):
            continue  # only ever redirect to this repo's own release files
        if a.get("state", "uploaded") != "uploaded":
            continue
        for platform, pat in _PLATFORM_PATTERNS.items():
            if not pat.search(name):
                continue
            score = _asset_score(platform, name)
            if platform not in found or score > found[platform][0]:
                size = a.get("size")
                found[platform] = (score, {
                    "name": name,
                    "url": url,
                    "size": int(size) if isinstance(size, int) else None,
                    "sha256": _digest(a),
                })
    return {k: v for k, (_, v) in found.items()}


def resolve(raw: Any, repo_name: str) -> Optional[dict]:
    """Turn the GitHub API list into {repo, stable, beta}; None if empty."""
    if not isinstance(raw, list):
        raise ValueError("unexpected GitHub API payload")
    rels = []
    for r in raw:
        if not isinstance(r, dict) or r.get("draft"):
            continue
        tag = str(r.get("tag_name") or "")
        key = parse_semver(tag)
        if key is None:
            continue
        # A SemVer pre-release tag counts as a beta even if the GitHub
        # "prerelease" box was not ticked.
        pre = bool(r.get("prerelease")) or key[3] == 0
        rels.append((key, {
            "version": tag[1:] if tag[:1] in ("v", "V") else tag,
            "tag": tag,
            "prerelease": pre,
            "published_at": r.get("published_at"),
            "html_url": r.get("html_url"),
            "body": str(r.get("body") or ""),
            "assets": _pick_assets(r.get("assets") or [], repo_name),
        }))
    if not rels:
        return None
    stable = max((x for x in rels if not x[1]["prerelease"]), key=lambda x: x[0], default=None)
    newest_pre = max((x for x in rels if x[1]["prerelease"]), key=lambda x: x[0], default=None)
    candidates = [x for x in (stable, newest_pre) if x is not None]
    beta = max(candidates, key=lambda x: x[0]) if candidates else None
    return {
        "repo": repo_name,
        "stable": stable[1] if stable else None,
        "beta": beta[1] if beta else None,
    }


# ── Fetch + cache ────────────────────────────────────────────────────────────

async def _fetch(repo_name: str) -> Any:
    kwargs: dict[str, Any] = {"timeout": TIMEOUT_S, "headers": HEADERS, "follow_redirects": True}
    if _TRANSPORT is not None:
        kwargs["transport"] = _TRANSPORT
    async with httpx.AsyncClient(**kwargs) as client:
        resp = await client.get(API_URL.format(repo=repo_name))
        resp.raise_for_status()
        return resp.json()


def _get_lock() -> asyncio.Lock:
    global _lock, _lock_loop
    loop = asyncio.get_running_loop()
    if _lock is None or _lock_loop is not loop:
        _lock, _lock_loop = asyncio.Lock(), loop
    return _lock


async def get_releases() -> Optional[dict]:
    """Resolved GitHub release data, or None (see module docstring)."""
    repo_name = repo()
    if not repo_name:
        return None
    now = time.monotonic()
    if _cache["key"] == repo_name and now < _cache["expires"]:
        return _cache["data"]
    async with _get_lock():
        now = time.monotonic()
        if _cache["key"] == repo_name and now < _cache["expires"]:
            return _cache["data"]
        if _cache["key"] != repo_name:
            _cache.update(key=repo_name, data=None, expires=0.0)
        try:
            data = resolve(await _fetch(repo_name), repo_name)
        except Exception as e:  # network, HTTP status, JSON, payload shape
            logger.warning("Nocturne releases: GitHub fetch for %s failed: %s", repo_name, e)
            # Keep serving the last good data; retry in a couple of minutes.
            _cache["expires"] = time.monotonic() + TTL_FAIL_S
            return _cache["data"]
        _cache.update(data=data, expires=time.monotonic() + TTL_OK_S)
        return data
