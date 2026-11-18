"""
HMAC-based short-lived signed URLs for media (stream) and artwork.
The token is appended as ?sig=<token>&exp=<unix_ts>.
"""
from __future__ import annotations

import hashlib
import hmac
import time
from typing import Optional

from . import config

_STREAM_TTL = 3600      # 1 hour
_ART_TTL = 86400 * 7    # 7 days (art is static; long TTL keeps browser caches useful)


def _sign(secret: str, path: str, exp: int) -> str:
    msg = f"{path}|{exp}".encode()
    return hmac.new(secret.encode(), msg, hashlib.sha256).hexdigest()[:32]


def sign_stream_url(track_id: str) -> tuple[str, str]:
    """Returns (absolute_url, expires_at_iso)."""
    exp = int(time.time()) + _STREAM_TTL
    path = f"/v1/media/stream/{track_id}"
    sig = _sign(config.MEDIA_SECRET, path, exp)
    url = f"{config.PUBLIC_URL}{path}?sig={sig}&exp={exp}"
    from datetime import datetime, timezone
    expires_at = datetime.fromtimestamp(exp, tz=timezone.utc).isoformat()
    return url, expires_at


def _stable_art_exp() -> int:
    """Expiry rounded up to a day boundary: the same art URL is returned all day long (stable
    browser-cache key) and is always valid for at least _ART_TTL - 1 day."""
    day = 86400
    return ((int(time.time()) + _ART_TTL) // day + 1) * day


def sign_art_url(track_id: str, size: Optional[int] = None, version: Optional[str] = None) -> str:
    """Returns absolute URL for artwork, with long-lived signature.

    `version` is an optional cache-busting token (e.g. a short hash of the cover
    file's path+mtime). Only the path is signed (never the query string), so
    adding ?v= does not affect verify_media_url(); it only makes the URL change
    when the cover changes, defeating the week-long `immutable` cache.
    """
    exp = _stable_art_exp()
    path = f"/v1/media/art/{track_id}"
    query = []
    if size:
        query.append(f"s={size}")
    if version:
        query.append(f"v={version}")
    sig = _sign(config.MEDIA_SECRET, path, exp)
    query += [f"sig={sig}", f"exp={exp}"]
    return f"{config.PUBLIC_URL}{path}?{'&'.join(query)}"


def sign_mix_art_url(name: str) -> str:
    """Absolute URL of a generated mix cover (file name inside .covers/mixes/)."""
    exp = int(time.time()) + _ART_TTL
    path = f"/v1/media/mix-art/{name}"
    sig = _sign(config.MEDIA_SECRET, path, exp)
    return f"{config.PUBLIC_URL}{path}?sig={sig}&exp={exp}"


def verify_media_url(path: str, sig: str, exp_str: str) -> bool:
    """Returns True if the signature is valid and not expired."""
    try:
        exp = int(exp_str)
    except (ValueError, TypeError):
        return False
    if int(time.time()) > exp:
        return False
    expected = _sign(config.MEDIA_SECRET, path, exp)
    return hmac.compare_digest(expected, sig)
