"""
Artist photos via the public Deezer API (no key), cached in v1_artist_images.

Positive hits are kept indefinitely; misses/errors are negatively cached for
NEGATIVE_TTL_S (7 days). Deezer's image CDN sends `Access-Control-Allow-Origin: *`,
so the URL is served as-is (canvas export works with crossOrigin="anonymous").
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Optional

import httpx

from .db import connect
from .ids import artist_id, _normalise

log = logging.getLogger("nocturne.artist_images")

SEARCH_URL = "https://api.deezer.com/search/artist"
TIMEOUT_S = 4.0
NEGATIVE_TTL_S = 7 * 24 * 3600
MIN_INTERVAL_S = 0.25          # Deezer allows ~50 req / 5 s; stay well below
_CONCURRENCY = 3

# Tests inject an httpx.MockTransport here.
_TRANSPORT: Optional[httpx.AsyncBaseTransport] = None

_last_call = 0.0
_sem: Optional[asyncio.Semaphore] = None
_sem_loop = None


def _semaphore() -> asyncio.Semaphore:
    global _sem, _sem_loop
    loop = asyncio.get_running_loop()
    if _sem is None or _sem_loop is not loop:
        _sem, _sem_loop = asyncio.Semaphore(_CONCURRENCY), loop
    return _sem


def _cached(aid: str) -> Optional[dict]:
    with connect() as conn:
        row = conn.execute("SELECT * FROM v1_artist_images WHERE artist_id=?", (aid,)).fetchone()
    return dict(row) if row else None


def _store(aid: str, name: str, url: Optional[str]) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO v1_artist_images(artist_id,name,url,found,fetched_at) VALUES (?,?,?,?,?)",
            (aid, name, url, 1 if url else 0, datetime.now(timezone.utc).isoformat()),
        )


def _fresh(row: dict) -> bool:
    if row["found"]:
        return True
    try:
        age = time.time() - datetime.fromisoformat(row["fetched_at"]).timestamp()
    except ValueError:
        return False
    return age < NEGATIVE_TTL_S


def pick_picture(results: list[dict], name: str) -> Optional[str]:
    """Prefer an exact (case/accents-folded) name match, else the first result."""
    if not results:
        return None
    want = _normalise(name)
    chosen = next((r for r in results if _normalise(r.get("name") or "") == want), results[0])
    return chosen.get("picture_xl") or chosen.get("picture_big") or chosen.get("picture_medium") or None


async def _search(name: str) -> Optional[str]:
    global _last_call
    async with _semaphore():
        wait = MIN_INTERVAL_S - (time.monotonic() - _last_call)
        if wait > 0:
            await asyncio.sleep(wait)
        _last_call = time.monotonic()
        kwargs: dict = {"timeout": TIMEOUT_S, "follow_redirects": True,
                        "headers": {"User-Agent": "Nocturne-Server"}}
        if _TRANSPORT is not None:
            kwargs["transport"] = _TRANSPORT
        async with httpx.AsyncClient(**kwargs) as client:
            resp = await client.get(SEARCH_URL, params={"q": name, "limit": 5})
            resp.raise_for_status()
            data = resp.json()
    url = pick_picture(data.get("data") or [], name)
    # Deezer returns a generic grey placeholder (empty hash) for artists without a photo.
    if url and "/images/artist//" in url:
        return None
    return url


async def get_artist_image(name: str, *, lookup: bool = True) -> Optional[str]:
    """Photo URL for an artist name, or None. Never raises."""
    name = (name or "").strip()
    if not name:
        return None
    aid = artist_id(name)
    row = _cached(aid)
    if row and _fresh(row):
        return row["url"] if row["found"] else None
    if not lookup:
        return None
    try:
        url = await _search(name)
    except Exception as e:  # network / rate limit / bad JSON: negative-cache briefly via same TTL
        log.warning("deezer lookup failed for %r: %s", name, type(e).__name__)
        url = None
    _store(aid, name, url)
    return url


async def get_artist_images(names: list[str]) -> dict[str, Optional[str]]:
    uniq = list(dict.fromkeys(names))
    urls = await asyncio.gather(*(get_artist_image(n) for n in uniq))
    return dict(zip(uniq, urls))
