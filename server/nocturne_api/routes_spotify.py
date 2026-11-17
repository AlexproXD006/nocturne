"""
/v1/spotify/* — connect a Spotify account (OAuth) and import its playlists.

  GET    /spotify/status
  POST   /spotify/authorize        -> {url}
  GET    /spotify/callback         (no auth; browser redirect from Spotify)
  DELETE /spotify/connection
  GET    /spotify/playlists
  POST   /spotify/imports          -> 202 Import
  GET    /spotify/imports          -> Page<Import>
  GET    /spotify/imports/{id}
  DELETE /spotify/imports/{id}     -> Import (cancelled)
"""
from __future__ import annotations

import html
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel

from .auth import require_user, get_account_by_id
from . import spotify
from . import spotify_import as imports

logger = logging.getLogger("nocturne.spotify")

router = APIRouter(prefix="/spotify", tags=["spotify"])

UNREADABLE_404 = ("Spotify no deja leer esta playlist: no existe, es privada de otro usuario o es una "
                  "playlist editorial/algorítmica de Spotify (p. ej. Descubrimiento semanal), que las "
                  "apps externas no pueden importar.")
UNREADABLE_403 = ("Spotify no permite leer esta playlist con tu cuenta (solo tus playlists y las "
                  "colaborativas o públicas a las que tengas acceso).")


def _err(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"message": message, "code": code})


def _require_configured() -> None:
    if not spotify.configured():
        raise _err(503, "spotify_not_configured", "Spotify is not configured on this server.")


def _raise_spotify(e: spotify.SpotifyError):
    if isinstance(e, spotify.NotConnected):
        raise _err(409, "spotify_not_connected", str(e))
    if e.code == "spotify_not_configured":
        raise _err(503, e.code, str(e))
    if e.status == 404:
        raise _err(404, "not_found", UNREADABLE_404)
    if e.status == 403:
        raise _err(403, "forbidden", UNREADABLE_403)
    raise _err(502, "spotify_error", f"Spotify request failed: {e}")


# ---------------------------------------------------------------------------
# Connection
# ---------------------------------------------------------------------------

@router.get("/status")
async def status(account: dict = Depends(require_user)):
    return spotify.status(account["id"])


@router.post("/authorize")
async def authorize(account: dict = Depends(require_user)):
    _require_configured()
    return {"url": spotify.authorize_url(account["id"])}


_PAGE = """<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<style>
:root{{color-scheme:light dark;--bg:#f6f6f8;--fg:#15151a;--muted:#5c5c66;--card:#fff;--accent:{accent}}}
@media (prefers-color-scheme:dark){{:root{{--bg:#0d0d12;--fg:#f1f1f4;--muted:#a3a3ad;--card:#17171f}}}}
*{{box-sizing:border-box}}
body{{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:16px}}
main{{background:var(--card);border-radius:16px;padding:32px 28px;max-width:420px;width:100%;text-align:center;
box-shadow:0 8px 30px rgba(0,0,0,.12)}}
.icon{{width:56px;height:56px;border-radius:50%;margin:0 auto 16px;display:flex;align-items:center;
justify-content:center;background:var(--accent);color:#fff;font-size:30px;font-weight:700}}
h1{{font-size:1.3rem;margin:0 0 8px}}
p{{margin:0;color:var(--muted)}}
</style></head>
<body><main><div class="icon" aria-hidden="true">{icon}</div><h1>{heading}</h1><p>{message}</p></main></body></html>"""


def _page(ok: bool, heading: str, message: str, status_code: int = 200) -> HTMLResponse:
    body = _PAGE.format(
        title=html.escape(heading), heading=html.escape(heading), message=html.escape(message),
        icon="&#10003;" if ok else "!", accent="#1db954" if ok else "#d64545",
    )
    return HTMLResponse(body, status_code=status_code, headers={
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        "X-Frame-Options": "DENY",
    })


@router.get("/callback", include_in_schema=False)
async def callback(code: Optional[str] = None, state: Optional[str] = None,
                   error: Optional[str] = None):
    user_id = spotify.verify_state(state)
    if error:
        if error == "access_denied":
            return _page(False, "Conexión cancelada",
                         "No se ha conectado Spotify. Puedes volver a Nocturne e intentarlo de nuevo.")
        return _page(False, "No se pudo conectar Spotify",
                     "Spotify devolvió un error. Vuelve a Nocturne e inténtalo de nuevo.", 400)
    if not user_id or not code:
        return _page(False, "Enlace caducado o no válido",
                     "Vuelve a Nocturne y pulsa otra vez «Conectar Spotify».", 400)
    account = get_account_by_id(user_id)
    if not account or account.get("disabled"):
        return _page(False, "Cuenta no válida", "La cuenta de Nocturne ya no está disponible.", 400)
    if not spotify.configured():
        return _page(False, "Spotify no está configurado",
                     "El servidor no tiene credenciales de Spotify.", 503)
    try:
        await spotify.complete_authorization(user_id, code)
    except spotify.SpotifyError as e:
        logger.warning("Spotify authorization failed for user %s (status %s)", user_id, e.status)
        return _page(False, "No se pudo conectar Spotify",
                     "Spotify rechazó la autorización. Vuelve a Nocturne e inténtalo de nuevo.", 502)
    return _page(True, "Spotify conectado", "Ya puedes volver a Nocturne.")


@router.delete("/connection", status_code=204)
async def disconnect(account: dict = Depends(require_user)):
    spotify.delete_connection(account["id"])
    return Response(status_code=204)


@router.get("/playlists")
async def my_playlists(account: dict = Depends(require_user)):
    _require_configured()
    try:
        items = await spotify.my_playlists(account["id"])
    except spotify.SpotifyError as e:
        _raise_spotify(e)
    return {"items": items, "offset": 0, "limit": len(items), "total": len(items)}


@router.get("/playlists/{playlist_id}")
async def one_playlist(playlist_id: str, account: dict = Depends(require_user)):
    _require_configured()
    sp_id = spotify.parse_playlist_id(playlist_id)
    if not sp_id:
        raise _err(400, "bad_request", "Invalid Spotify playlist id.")
    try:
        meta = await spotify.playlist_meta(account["id"], sp_id)
    except spotify.SpotifyError as e:
        _raise_spotify(e)
    return spotify.playlist_to_wire(meta)


# ---------------------------------------------------------------------------
# Imports
# ---------------------------------------------------------------------------

class ImportBody(BaseModel):
    playlist: Optional[str] = None
    download: bool = True


@router.post("/imports", status_code=202)
async def start_import(body: ImportBody, account: dict = Depends(require_user)):
    _require_configured()
    sp_id = spotify.parse_playlist_id(body.playlist)
    if not sp_id:
        raise _err(400, "bad_request", "playlist must be a Spotify playlist id or open.spotify.com link.")
    existing = imports.active_for(account["id"], sp_id)
    if existing:
        return JSONResponse(status_code=202, content=imports.to_wire(existing))
    try:
        meta = await spotify.playlist_meta(account["id"], sp_id)
    except spotify.SpotifyError as e:
        _raise_spotify(e)
    row = imports.create(account["id"], sp_id, meta.get("name") or "",
                         spotify.best_image(meta.get("images")), body.download)
    imports.ensure_worker()
    return JSONResponse(status_code=202, content=imports.to_wire(row))


@router.get("/imports")
async def list_imports(
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    account: dict = Depends(require_user),
):
    rows, total = imports.list_for_user(account["id"], offset, limit)
    return {"items": [imports.to_wire(r) for r in rows], "offset": offset, "limit": limit, "total": total}


def _own_import(import_id: str, account: dict) -> dict:
    row = imports.get(import_id, account["id"])
    if not row:
        raise _err(404, "not_found", "Import not found.")
    return row


@router.get("/imports/{import_id}")
async def get_import(import_id: str, account: dict = Depends(require_user)):
    return imports.to_wire(_own_import(import_id, account))


@router.delete("/imports/{import_id}")
async def cancel_import(import_id: str, account: dict = Depends(require_user)):
    _own_import(import_id, account)
    imports.cancel(import_id)
    return imports.to_wire(imports.get(import_id, account["id"]))
