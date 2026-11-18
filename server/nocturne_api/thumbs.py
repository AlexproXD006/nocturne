"""On-disk thumbnail cache for /v1/media/art (WebP when the client accepts it, else JPEG).

Thumbnails live in <MUSIC_ROOT>/.covers/thumbs/<hash>-<bucket>.<ext>, keyed by the cover's
path + mtime + size, so a changed cover never serves a stale thumbnail. Requested sizes are
snapped to a few buckets to maximise cache hits.
"""
from __future__ import annotations

import hashlib
import logging
import os
import threading
import time
from pathlib import Path
from typing import Optional

from . import config

logger = logging.getLogger("nocturne.thumbs")

BUCKETS = (64, 96, 128, 192, 256, 384, 512, 1024)
WARM_SIZES = (96, 128)


def snap_size(s: int) -> int:
    """Smallest bucket >= s (capped at the largest bucket)."""
    for b in BUCKETS:
        if s <= b:
            return b
    return BUCKETS[-1]


def thumbs_dir() -> Path:
    return Path(config.MUSIC_ROOT) / ".covers" / "thumbs"


def accepts_webp(accept: Optional[str]) -> bool:
    return bool(accept) and "image/webp" in accept.lower()


def webp_supported() -> bool:
    try:
        from PIL import features
        return bool(features.check("webp"))
    except Exception:
        return False


def _key(cover_path: str, st: os.stat_result) -> str:
    raw = f"{cover_path}|{st.st_mtime_ns}|{st.st_size}".encode()
    return hashlib.sha1(raw).hexdigest()[:24]


def thumb_path(cover_path: str, bucket: int, webp: bool) -> Optional[Path]:
    try:
        st = os.stat(cover_path)
    except OSError:
        return None
    return thumbs_dir() / f"{_key(cover_path, st)}-{bucket}.{'webp' if webp else 'jpg'}"


def ensure_thumb(cover_path: str, bucket: int, webp: bool) -> Optional[tuple[Path, bool]]:
    """Return (path, created) of the cached thumbnail, generating it when missing; None on failure."""
    dest = thumb_path(cover_path, bucket, webp)
    if dest is None:
        return None
    if dest.is_file() and dest.stat().st_size > 0:
        return dest, False
    try:
        from PIL import Image
        dest.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(cover_path) as img:
            img.load()
            if webp:
                im = img if img.mode in ("RGB", "RGBA") else img.convert("RGBA" if "A" in img.mode or "transparency" in img.info else "RGB")
            else:
                im = img.convert("RGB")
            im.thumbnail((bucket, bucket), Image.LANCZOS)  # never upscales
            tmp = dest.with_name(f".{dest.name}.{os.getpid()}.{threading.get_ident()}.tmp")
            if webp:
                im.save(tmp, format="WEBP", quality=82, method=4)
            else:
                im.save(tmp, format="JPEG", quality=85, optimize=True, progressive=True)
        os.replace(tmp, dest)
        return dest, True
    except Exception as e:  # corrupt cover, no Pillow, disk full...
        logger.debug("thumbnail failed for %s: %s", type(e).__name__, bucket)
        return None


def etag_for(path: Path) -> str:
    st = path.stat()
    return f'"{st.st_mtime_ns:x}-{st.st_size:x}"'


def warm_all(stop: Optional[threading.Event] = None, pause: float = 0.02) -> int:
    """Pre-generate the small WebP thumbnails of every cover (low priority). Returns the number created."""
    try:
        os.nice(10)
    except Exception:
        pass
    if not webp_supported():
        return 0
    import database as nova_db
    made = 0
    seen: set[str] = set()
    try:
        rows = nova_db.get_all_tracks()
    except Exception:
        return 0
    for r in rows:
        if stop is not None and stop.is_set():
            break
        cp = r.get("cover_path") or ""
        if not cp or cp in seen:
            continue
        seen.add(cp)
        for sz in WARM_SIZES:
            res = ensure_thumb(cp, sz, True)
            if res and res[1]:
                made += 1
                time.sleep(pause)
    logger.info("Nocturne: thumbnail warm-up done (%d created, %d covers)", made, len(seen))
    return made


def start_warmup() -> Optional[threading.Thread]:
    if os.environ.get("NOCTURNE_THUMB_WARMUP", "1") == "0" or os.environ.get("NOCTURNE_TESTING"):
        return None
    t = threading.Thread(target=warm_all, name="thumb-warmup", daemon=True)
    t.start()
    return t
