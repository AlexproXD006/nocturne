"""
Configuration — all settings read from environment variables.
Fails fast at import time if required secrets are missing or too short.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path


def _require(name: str, min_len: int = 0) -> str:
    val = os.getenv(name, "").strip()
    if not val:
        print(f"FATAL: environment variable {name} is required but not set", file=sys.stderr)
        sys.exit(1)
    if len(val) < min_len:
        print(
            f"FATAL: {name} must be at least {min_len} characters "
            f"(got {len(val)})",
            file=sys.stderr,
        )
        sys.exit(1)
    return val


def _optional(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def _bool(name: str, default: bool = True) -> bool:
    val = os.getenv(name, "").strip().lower()
    if val in ("0", "false", "no", "off"):
        return False
    if val in ("1", "true", "yes", "on"):
        return True
    return default


# ── Required secrets (fail fast) ──────────────────────────────────────────────
# These are only validated when the app is NOT running in test mode
_TESTING = os.getenv("NOCTURNE_TESTING", "").strip().lower() in ("1", "true")

if _TESTING:
    JWT_SECRET: str = os.getenv("NOCTURNE_JWT_SECRET", "test-jwt-secret-must-be-32-bytes-long!")
    MEDIA_SECRET: str = os.getenv("NOCTURNE_MEDIA_SECRET", "test-media-secret-32bytes-longxxxx!")
else:
    JWT_SECRET = _require("NOCTURNE_JWT_SECRET", min_len=32)
    MEDIA_SECRET = _require("NOCTURNE_MEDIA_SECRET", min_len=32)

if not _TESTING and JWT_SECRET == MEDIA_SECRET:
    print("FATAL: NOCTURNE_JWT_SECRET and NOCTURNE_MEDIA_SECRET must be DIFFERENT", file=sys.stderr)
    sys.exit(1)

# ── Public URL ─────────────────────────────────────────────────────────────────
PUBLIC_URL: str = _optional("NOCTURNE_PUBLIC_URL", "http://localhost:8000").rstrip("/")

# Is our public URL https?
_public_url_is_https: bool = PUBLIC_URL.startswith("https://")

# ── Database ───────────────────────────────────────────────────────────────────
_music_dir = _optional("MUSIC_DIR", "./music")
DB_PATH: str = _optional("NOCTURNE_DB_PATH", str(Path(_music_dir) / "nocturne.db"))

# ── Directories ────────────────────────────────────────────────────────────────
DATA_DIR: str = _optional("NOCTURNE_DATA_DIR", str(Path(_music_dir) / ".nocturne_data"))
WEB_DIR: str = _optional("NOCTURNE_WEB_DIR", "/opt/nocturne/web")
# Release downloads (APK / Windows zip / descargar.html) and the in-app update
# feed latest.json. Kept outside WEB_DIR so they survive web-release cutovers.
DOWNLOADS_DIR: str = _optional("NOCTURNE_DOWNLOADS_DIR", "/opt/nocturne/downloads")

# ── App releases (GitHub) ──────────────────────────────────────────────────────
# "owner/name" whose GitHub Releases provide app downloads and the in-app
# update feed. Empty string disables GitHub (local downloads/latest.json only).
RELEASES_REPO: str = os.getenv("NOCTURNE_RELEASES_REPO", "AlexproXD006/nocturne").strip()

# ── Upload ─────────────────────────────────────────────────────────────────────
UPLOAD_MAX_MB: int = int(_optional("NOCTURNE_UPLOAD_MAX_MB", "200"))
UPLOAD_MAX_BYTES: int = UPLOAD_MAX_MB * 1024 * 1024

# ── CORS ───────────────────────────────────────────────────────────────────────
_default_cors = "app://nocturne,https://localhost,capacitor://localhost,http://localhost:5173"
CORS_ORIGINS: list[str] = [
    o.strip() for o in _optional("NOCTURNE_CORS_ORIGINS", _default_cors).split(",") if o.strip()
]

# ── Trusted proxies ────────────────────────────────────────────────────────────
TRUSTED_PROXIES: list[str] = [
    p.strip() for p in _optional("NOCTURNE_TRUSTED_PROXIES", "").split(",") if p.strip()
]

# ── Token lifetimes ────────────────────────────────────────────────────────────
ACCESS_TOKEN_TTL: int = 900          # 15 min
REFRESH_TOKEN_TTL: int = 30 * 86400  # 30 days

# ── Cookie security ────────────────────────────────────────────────────────────
# Set Secure flag on cookies when public URL is HTTPS
COOKIE_SECURE: bool = _public_url_is_https

# ── HSTS ───────────────────────────────────────────────────────────────────────
HSTS_ENABLED: bool = _bool("NOCTURNE_HSTS", default=True)

# ── Jobs ───────────────────────────────────────────────────────────────────────
MAX_JOBS: int = int(_optional("NOCTURNE_MAX_JOBS", "2"))

# ── Legacy API ─────────────────────────────────────────────────────────────────
LEGACY_API_MODE: str = _optional("NOVA_LEGACY_API", "off")  # "off" | "internal"
LEGACY_INTERNAL_PORT: int = int(_optional("NOVA_INTERNAL_PORT", "8001"))

# ── Music root (for path containment checks) ──────────────────────────────────
MUSIC_ROOT: str = str(Path(_music_dir).resolve())

# ── Art cache ─────────────────────────────────────────────────────────────────
ART_CACHE_DIR: str = str(Path(DATA_DIR) / "art_cache")

# ── Spotify account connection + playlist import ──────────────────────────────
# App credentials (https://developer.spotify.com/dashboard). Both spellings are
# accepted: SPOTIPY_* is what spotipy/spotdl read, SPOTIFY_* is the older alias.
SPOTIFY_CLIENT_ID: str = _optional("SPOTIPY_CLIENT_ID") or _optional("SPOTIFY_CLIENT_ID")
SPOTIFY_CLIENT_SECRET: str = _optional("SPOTIPY_CLIENT_SECRET") or _optional("SPOTIFY_CLIENT_SECRET")
# OAuth redirect URI — must be registered EXACTLY in the Spotify app settings.
SPOTIFY_REDIRECT_URI: str = _optional(
    "NOCTURNE_SPOTIFY_REDIRECT_URI", f"{PUBLIC_URL}/v1/spotify/callback"
)
# Import downloads: max parallel YouTube downloads (capped at 2) and the pause
# between starting two downloads, in seconds.
SPOTIFY_IMPORT_CONCURRENCY: int = max(1, min(2, int(_optional("NOCTURNE_SPOTIFY_IMPORT_CONCURRENCY", "2") or 2)))
SPOTIFY_IMPORT_DELAY: float = float(_optional("NOCTURNE_SPOTIFY_IMPORT_DELAY", "3") or 3)
