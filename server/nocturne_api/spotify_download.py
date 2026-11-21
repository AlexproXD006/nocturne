"""
Admin "search Spotify -> download": Spotify track / album / playlist URL, URI or id ->
library tracks, WITHOUT spotdl.

Metadata comes from the server's own Spotify app (client credentials, SPOTIPY_CLIENT_ID /
SPOTIPY_CLIENT_SECRET), the audio from YouTube through the Spotify import pipeline
(spotify_import.download_spotify_track): Topic / Official Audio uploads whose duration
matches Spotify's, clean tags, official cover, LRCLIB lyrics, library row.
"""
from __future__ import annotations

import asyncio
import logging
import re
from typing import Awaitable, Callable, Optional

from . import config
from . import spotify
from . import spotify_catalog as sc
from . import spotify_import as si

logger = logging.getLogger("nocturne.spotify_download")

_ID = r"[A-Za-z0-9]{22}"
_URL_RE = re.compile(
    rf"^https?://open\.spotify\.com/(?:intl-[a-z]{{2,3}}(?:-[a-z]{{2,3}})?/)?(track|album|playlist)/({_ID})(?:[/?#].*)?$", re.I)
_URI_RE = re.compile(rf"^spotify:(track|album|playlist):({_ID})$", re.I)
_BARE_RE = re.compile(rf"^{_ID}$")


def parse_ref(value: Optional[str]) -> Optional[tuple[str, str]]:
    """(kind, id) for a Spotify track/album/playlist URL or URI; a bare 22-char id is a
    track. None if it is not a Spotify reference."""
    v = (value or "").strip()
    if not v:
        return None
    m = _URL_RE.match(v) or _URI_RE.match(v)
    if m:
        return m.group(1).lower(), m.group(2)
    if _BARE_RE.match(v):
        return "track", v
    return None


def reason_for(e: Exception) -> str:
    """Meaningful (Spanish) job error for a Spotify failure."""
    if isinstance(e, spotify.SpotifyError):
        st = getattr(e, "status", None)
        if st in (400, 401):
            return "Spotify no disponible: las credenciales del servidor no son válidas."
        if st == 404:
            return "Spotify no encontró este elemento (no existe o es privado)."
        if st == 403:
            return "Spotify no permite leer este elemento con las credenciales del servidor."
        if st == 429:
            return "Spotify no disponible: demasiadas peticiones, inténtalo más tarde."
        return f"Spotify no disponible: {e}"
    return f"Error: {type(e).__name__}"


async def _cc_get(path: str, params: Optional[dict] = None) -> dict:
    if not (config.SPOTIFY_CLIENT_ID and config.SPOTIFY_CLIENT_SECRET):
        raise spotify.SpotifyError("Spotify no está configurado en el servidor.")
    tok = await spotify._token_request({"grant_type": "client_credentials"})
    return await spotify.api_get(tok["access_token"], path, params)


async def _paged(first: dict, key_next: str = "next") -> list[dict]:
    out = list(first.get("items") or [])
    nxt = first.get(key_next)
    while nxt:
        page = await spotify.api_get((await spotify._token_request({"grant_type": "client_credentials"}))["access_token"], nxt)
        out += page.get("items") or []
        nxt = page.get(key_next)
    return out


async def fetch_metas(kind: str, sid: str) -> tuple[str, list[dict]]:
    """(title, [track_meta]) for a Spotify reference."""
    if kind == "track":
        t = await _cc_get(f"/tracks/{sid}")
        m = sc.track_meta(t)
        return m["name"], [m]
    if kind == "album":
        alb = await _cc_get(f"/albums/{sid}")
        items = await _paged(alb.get("tracks") or {})
        metas = []
        for t in items:
            if isinstance(t, dict) and t.get("id"):
                metas.append(sc.track_meta({**t, "album": {"name": alb.get("name"), "images": alb.get("images")}}))
        return alb.get("name") or "", metas
    pl = await _cc_get(f"/playlists/{sid}", {"fields": "name"})
    first = await _cc_get(f"/playlists/{sid}/items", {"limit": 50, "additional_types": "track"})
    metas = []
    for e in await _paged(first):
        t, _why = spotify.entry_track(e)
        if t and t.get("id") and not str(t["id"]).startswith("local:"):
            metas.append(sc.track_meta(t))
    return pl.get("name") or "", metas


Progress = Callable[[int, Optional[str]], None]


async def download_ref(value: str, dm=None, *, on_title: Optional[Callable[[str], None]] = None,
                       on_progress: Optional[Progress] = None) -> dict:
    """Download whatever the reference points at. Returns
    {"track_ids": [...], "downloaded": n, "failures": [{"title","reason"}]}.
    Raises si.DownloadFailed with a user-facing reason when nothing could be obtained."""
    ref = parse_ref(value)
    if not ref:
        raise si.DownloadFailed("No es una URL de Spotify válida.")
    kind, sid = ref
    try:
        title, metas = await fetch_metas(kind, sid)
    except spotify.SpotifyError as e:
        raise si.DownloadFailed(reason_for(e)) from None
    if on_title and title:
        on_title(title)
    if not metas:
        raise si.DownloadFailed("Spotify no devolvió canciones para este enlace.")
    ids: list[str] = []
    failures: list[dict] = []
    downloaded = 0
    sem = asyncio.Semaphore(config.spotify_import_concurrency() if len(metas) > 1 else 1)
    done = 0

    async def one(i: int, m: dict) -> None:
        nonlocal downloaded, done
        async with sem:
            try:
                tid, new = await si.download_spotify_track(m, dm)
                ids.append(tid)
                downloaded += int(new)
            except si.DownloadFailed as e:
                failures.append({"title": m.get("name"), "reason": str(e)})
            except Exception as e:
                logger.warning("spotify download of %r failed: %s", m.get("name"), type(e).__name__)
                failures.append({"title": m.get("name"), "reason": f"Error al descargar: {type(e).__name__}"})
            done += 1
            if on_progress:
                on_progress(int(100 * done / len(metas)), None)
            if len(metas) > 1 and config.SPOTIFY_IMPORT_DELAY > 0:
                await asyncio.sleep(config.SPOTIFY_IMPORT_DELAY)

    await asyncio.gather(*(one(i, m) for i, m in enumerate(metas)))
    if not ids:
        first = failures[0]["reason"] if failures else si.NOT_FOUND_REASON
        raise si.DownloadFailed(first if len(failures) == 1 else f"{first} ({len(failures)} canciones fallaron)")
    return {"track_ids": ids, "downloaded": downloaded, "failures": failures}
