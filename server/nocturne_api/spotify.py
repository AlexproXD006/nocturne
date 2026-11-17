"""
Spotify account connection (OAuth 2.0 Authorization Code) and Web API client.

Why user OAuth: the Spotify app is in Development mode, where client-credentials
tokens can read playlist metadata but not playlist items (/items -> 401). Each
Nocturne user connects their own Spotify account; tokens are stored per user in
v1_spotify_tokens, encrypted at rest, and refreshed automatically.

Secrets hygiene: tokens and the client secret are never logged.

Tests replace `_transport` with an httpx.MockTransport.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from urllib.parse import urlencode

import httpx

from . import config
from .db import connect

logger = logging.getLogger("nocturne.spotify")

AUTHORIZE_URL = "https://accounts.spotify.com/authorize"
TOKEN_URL = "https://accounts.spotify.com/api/token"
API_BASE = "https://api.spotify.com/v1"
SCOPES = "playlist-read-private playlist-read-collaborative"
STATE_TTL = 600                       # 10 min
REFRESH_TOKEN_LIFETIME = timedelta(days=180)
HTTP_TIMEOUT = 20.0

# Injected by tests (httpx.MockTransport). None = real network.
_transport: Optional[httpx.AsyncBaseTransport] = None

_refresh_locks: dict[tuple, asyncio.Lock] = {}


class SpotifyError(Exception):
    """Spotify call failed. `status` is the HTTP status (0 = network)."""

    def __init__(self, message: str, status: int = 0, code: str = "spotify_error"):
        super().__init__(message)
        self.status = status
        self.code = code


class NotConnected(SpotifyError):
    def __init__(self, message: str = "No hay ninguna cuenta de Spotify conectada."):
        super().__init__(message, 409, "spotify_not_connected")


def configured() -> bool:
    return bool(config.SPOTIFY_CLIENT_ID and config.SPOTIFY_CLIENT_SECRET)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _parse(ts: Optional[str]) -> Optional[datetime]:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts)
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# Encryption at rest
# ---------------------------------------------------------------------------
# Key derived from the server secret (NOCTURNE_JWT_SECRET). Uses Fernet when the
# `cryptography` package is installed ("f1:" prefix); otherwise a stdlib
# encrypt-then-MAC construction: HMAC-SHA256 as a PRF in counter mode for the
# keystream + HMAC-SHA256 tag over nonce||ciphertext ("s1:" prefix). Both
# formats stay decryptable whichever is active.

def _key(purpose: str) -> bytes:
    return hmac.new(config.JWT_SECRET.encode(), f"nocturne-spotify:{purpose}".encode(),
                    hashlib.sha256).digest()


def _fernet():
    try:
        from cryptography.fernet import Fernet  # type: ignore
    except Exception:
        return None
    return Fernet(base64.urlsafe_b64encode(_key("fernet")))


def _keystream(nonce: bytes, n: int) -> bytes:
    k = _key("enc")
    out = bytearray()
    counter = 0
    while len(out) < n:
        out += hmac.new(k, nonce + counter.to_bytes(8, "big"), hashlib.sha256).digest()
        counter += 1
    return bytes(out[:n])


def encrypt(plain: Optional[str]) -> Optional[str]:
    if plain is None:
        return None
    f = _fernet()
    if f is not None:
        return "f1:" + f.encrypt(plain.encode()).decode()
    data = plain.encode()
    nonce = secrets.token_bytes(16)
    ct = bytes(a ^ b for a, b in zip(data, _keystream(nonce, len(data))))
    tag = hmac.new(_key("mac"), b"s1" + nonce + ct, hashlib.sha256).digest()
    return "s1:" + base64.urlsafe_b64encode(nonce + ct + tag).decode()


def decrypt(token: Optional[str]) -> Optional[str]:
    """Returns None if the value can't be decrypted (e.g. the secret changed)."""
    if not token:
        return None
    try:
        if token.startswith("f1:"):
            f = _fernet()
            return f.decrypt(token[3:].encode()).decode() if f else None
        if token.startswith("s1:"):
            raw = base64.urlsafe_b64decode(token[3:].encode())
            nonce, ct, tag = raw[:16], raw[16:-32], raw[-32:]
            expect = hmac.new(_key("mac"), b"s1" + nonce + ct, hashlib.sha256).digest()
            if not hmac.compare_digest(tag, expect):
                return None
            return bytes(a ^ b for a, b in zip(ct, _keystream(nonce, len(ct)))).decode()
    except Exception:
        return None
    return None


# ---------------------------------------------------------------------------
# OAuth state (signed, short-lived, bound to the user)
# ---------------------------------------------------------------------------

def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def make_state(user_id: str, ttl: int = STATE_TTL) -> str:
    payload = _b64(json.dumps(
        {"u": user_id, "e": int(time.time()) + ttl, "n": secrets.token_urlsafe(8)},
        separators=(",", ":"),
    ).encode())
    sig = _b64(hmac.new(_key("state"), payload.encode(), hashlib.sha256).digest())
    return f"{payload}.{sig}"


def verify_state(state: Optional[str]) -> Optional[str]:
    """Returns the user id bound to a valid, unexpired state; else None."""
    if not state or "." not in state or len(state) > 512:
        return None
    payload, sig = state.rsplit(".", 1)
    expect = _b64(hmac.new(_key("state"), payload.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(sig, expect):
        return None
    try:
        data = json.loads(_unb64(payload))
    except Exception:
        return None
    if int(data.get("e", 0)) < int(time.time()):
        return None
    return data.get("u") or None


def authorize_url(user_id: str) -> str:
    return AUTHORIZE_URL + "?" + urlencode({
        "client_id": config.SPOTIFY_CLIENT_ID,
        "response_type": "code",
        "redirect_uri": config.SPOTIFY_REDIRECT_URI,
        "scope": SCOPES,
        "state": make_state(user_id),
    })


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

def client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=_transport, timeout=HTTP_TIMEOUT,
                             headers={"User-Agent": "Nocturne/1.0 (self-hosted music server)"})


def _error_message(resp: httpx.Response) -> str:
    try:
        d = resp.json()
    except Exception:
        return f"HTTP {resp.status_code}"
    err = d.get("error")
    if isinstance(err, dict):
        return str(err.get("message") or f"HTTP {resp.status_code}")
    return str(d.get("error_description") or err or f"HTTP {resp.status_code}")


async def _token_request(data: dict) -> dict:
    basic = base64.b64encode(
        f"{config.SPOTIFY_CLIENT_ID}:{config.SPOTIFY_CLIENT_SECRET}".encode()
    ).decode()
    try:
        async with client() as c:
            resp = await c.post(TOKEN_URL, data=data, headers={"Authorization": f"Basic {basic}"})
    except httpx.HTTPError as e:
        raise SpotifyError(f"Spotify unreachable: {type(e).__name__}") from None
    if resp.status_code != 200:
        try:
            err = resp.json().get("error")
        except Exception:
            err = None
        if err == "invalid_grant":
            raise SpotifyError("invalid_grant", resp.status_code, "invalid_grant")
        raise SpotifyError(f"Spotify token request failed: {_error_message(resp)}", resp.status_code)
    return resp.json()


async def api_get(access_token: str, url_or_path: str, params: Optional[dict] = None,
                  retries: int = 3) -> dict:
    url = url_or_path if url_or_path.startswith("https://") else API_BASE + url_or_path
    if not url.startswith(API_BASE + "/"):
        raise SpotifyError("Refusing to call a non-Spotify URL.")
    for attempt in range(retries + 1):
        try:
            async with client() as c:
                resp = await c.get(url, params=params,
                                   headers={"Authorization": f"Bearer {access_token}"})
        except httpx.HTTPError as e:
            if attempt < retries:
                await asyncio.sleep(1 + attempt)
                continue
            raise SpotifyError(f"Spotify unreachable: {type(e).__name__}") from None
        if resp.status_code == 429 and attempt < retries:
            try:
                wait = float(resp.headers.get("Retry-After", "2"))
            except ValueError:
                wait = 2.0
            await asyncio.sleep(min(max(wait, 1.0), 30.0))
            continue
        if resp.status_code >= 500 and attempt < retries:
            await asyncio.sleep(1 + attempt)
            continue
        if resp.status_code != 200:
            raise SpotifyError(_error_message(resp), resp.status_code)
        return resp.json()
    raise SpotifyError("Spotify request failed.")


# ---------------------------------------------------------------------------
# Token store
# ---------------------------------------------------------------------------

def get_connection(user_id: str) -> Optional[dict]:
    with connect() as conn:
        row = conn.execute("SELECT * FROM v1_spotify_tokens WHERE user_id=?", (user_id,)).fetchone()
    return dict(row) if row else None


def delete_connection(user_id: str) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM v1_spotify_tokens WHERE user_id=?", (user_id,))


def mark_revoked(user_id: str) -> None:
    """Refresh token expired/revoked: drop the tokens but keep the row (account,
    refresh_expires_at) so /spotify/status can still report expiresAt."""
    with connect() as conn:
        conn.execute(
            "UPDATE v1_spotify_tokens SET access_token=NULL, refresh_token='', updated_at=? WHERE user_id=?",
            (_iso(_now()), user_id),
        )


def _store_tokens(user_id: str, tok: dict, *, account: Optional[dict] = None) -> None:
    now = _now()
    expires_at = now + timedelta(seconds=int(tok.get("expires_in") or 3600))
    new_refresh = tok.get("refresh_token")
    with connect() as conn:
        row = conn.execute("SELECT * FROM v1_spotify_tokens WHERE user_id=?", (user_id,)).fetchone()
        if row is None:
            if not new_refresh:
                raise SpotifyError("Spotify did not return a refresh token.")
            conn.execute(
                """INSERT INTO v1_spotify_tokens
                   (user_id, access_token, refresh_token, expires_at, refresh_expires_at, scope,
                    account_id, account_name, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (user_id, encrypt(tok.get("access_token")), encrypt(new_refresh), _iso(expires_at),
                 _iso(now + REFRESH_TOKEN_LIFETIME), tok.get("scope"),
                 (account or {}).get("id"), (account or {}).get("displayName"), _iso(now), _iso(now)),
            )
            return
        fields = {"access_token": encrypt(tok.get("access_token")), "expires_at": _iso(expires_at),
                  "updated_at": _iso(now)}
        if new_refresh:
            fields["refresh_token"] = encrypt(new_refresh)
            fields["refresh_expires_at"] = _iso(now + REFRESH_TOKEN_LIFETIME)
        if tok.get("scope"):
            fields["scope"] = tok["scope"]
        if account is not None:
            fields["account_id"] = account.get("id")
            fields["account_name"] = account.get("displayName")
            fields["refresh_expires_at"] = _iso(now + REFRESH_TOKEN_LIFETIME)
        conn.execute(
            f"UPDATE v1_spotify_tokens SET {', '.join(k + '=?' for k in fields)} WHERE user_id=?",
            (*fields.values(), user_id),
        )


async def complete_authorization(user_id: str, code: str) -> dict:
    """Exchange the code, fetch the account, store tokens. Returns the account."""
    tok = await _token_request({
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": config.SPOTIFY_REDIRECT_URI,
    })
    if not tok.get("access_token") or not tok.get("refresh_token"):
        raise SpotifyError("Spotify returned an incomplete token response.")
    me = await api_get(tok["access_token"], "/me")
    account = {"id": me.get("id") or "", "displayName": me.get("display_name") or me.get("id") or ""}
    # A new authorization replaces any previous connection entirely.
    delete_connection(user_id)
    _store_tokens(user_id, tok, account=account)
    return account


async def refresh(user_id: str) -> str:
    row = get_connection(user_id)
    if not row:
        raise NotConnected()
    rt = decrypt(row["refresh_token"])
    if not rt:
        if row["refresh_token"]:
            mark_revoked(user_id)
        raise NotConnected("La conexión con Spotify ha caducado o se ha revocado; vuelve a conectarla.")
    try:
        tok = await _token_request({"grant_type": "refresh_token", "refresh_token": rt})
    except SpotifyError as e:
        if e.code == "invalid_grant":
            logger.info("Spotify refresh token revoked/expired for user %s; disconnected", user_id)
            mark_revoked(user_id)
            raise NotConnected("La conexión con Spotify ha caducado o se ha revocado; vuelve a conectarla.") from None
        raise
    _store_tokens(user_id, tok)
    return tok["access_token"]


async def access_token(user_id: str, *, force_refresh: bool = False) -> str:
    """A valid access token for the user (refreshing when needed)."""
    if not configured():
        raise SpotifyError("Spotify is not configured on this server.", 503, "spotify_not_configured")
    lock = _refresh_locks.setdefault((id(asyncio.get_running_loop()), user_id), asyncio.Lock())
    async with lock:
        row = get_connection(user_id)
        if not row or not row["refresh_token"]:
            raise NotConnected()
        exp = _parse(row["expires_at"])
        at = decrypt(row["access_token"])
        if not force_refresh and at and exp and exp - _now() > timedelta(seconds=60):
            return at
        return await refresh(user_id)


async def user_get(user_id: str, url_or_path: str, params: Optional[dict] = None) -> dict:
    """GET with the user's token; refreshes once on 401."""
    token = await access_token(user_id)
    try:
        return await api_get(token, url_or_path, params)
    except SpotifyError as e:
        if e.status != 401:
            raise
    token = await access_token(user_id, force_refresh=True)
    return await api_get(token, url_or_path, params)


def status(user_id: str) -> dict:
    out: dict[str, Any] = {"configured": configured(), "connected": False}
    row = get_connection(user_id)
    if not row:
        return out
    rexp = _parse(row["refresh_expires_at"])
    usable = bool(row["refresh_token"] and decrypt(row["refresh_token"]))
    out["connected"] = usable and (rexp is None or rexp > _now())
    if row["account_id"]:
        out["account"] = {"id": row["account_id"], "displayName": row["account_name"] or ""}
    if row["refresh_expires_at"]:
        out["expiresAt"] = row["refresh_expires_at"]
    return out


# ---------------------------------------------------------------------------
# Web API helpers
# ---------------------------------------------------------------------------

_ID_RE = re.compile(r"^[A-Za-z0-9]{22}$")
_URL_RE = re.compile(
    r"^(?:https?://)?(?:open|play)\.spotify\.com/(?:intl-[a-z]{2}(?:-[a-z]{2})?/)?(?:user/[^/]+/)?"
    r"playlist/([A-Za-z0-9]{22})(?:[/?#].*)?$",
    re.I,
)


def parse_playlist_id(value: Optional[str]) -> Optional[str]:
    v = (value or "").strip()
    if _ID_RE.match(v):
        return v
    m = re.match(r"^spotify:(?:user:[^:]+:)?playlist:([A-Za-z0-9]{22})$", v)
    if m:
        return m.group(1)
    m = _URL_RE.match(v)
    return m.group(1) if m else None


def best_image(images) -> Optional[str]:
    """URL of the image closest to 640px (Spotify lists them largest first)."""
    imgs = [i for i in (images or []) if isinstance(i, dict) and i.get("url")]
    if not imgs:
        return None
    sized = [i for i in imgs if i.get("width")]
    if sized:
        return min(sized, key=lambda i: abs((i.get("width") or 0) - 640))["url"]
    return imgs[0]["url"]


def _total(obj: dict) -> Optional[int]:
    # Spotify renamed playlist.tracks -> playlist.items (2026); accept both.
    for key in ("items", "tracks"):
        sub = obj.get(key)
        if isinstance(sub, dict) and isinstance(sub.get("total"), int):
            return sub["total"]
    return None


def playlist_to_wire(p: dict) -> dict:
    owner = p.get("owner") or {}
    return {
        "id": p.get("id") or "",
        "name": p.get("name") or "",
        "trackCount": _total(p),
        "image": best_image(p.get("images")),
        "owner": {"id": owner.get("id") or "", "name": owner.get("display_name") or owner.get("id") or ""},
        "public": p.get("public"),
    }


async def my_playlists(user_id: str, max_items: int = 2000) -> list[dict]:
    out: list[dict] = []
    url: Optional[str] = "/me/playlists"
    params: Optional[dict] = {"limit": 50, "offset": 0}
    while url and len(out) < max_items:
        page = await user_get(user_id, url, params)
        out += [playlist_to_wire(p) for p in page.get("items") or [] if isinstance(p, dict) and p.get("id")]
        url, params = page.get("next"), None
    return out


async def playlist_meta(user_id: str, playlist_id: str) -> dict:
    # No `fields` filter: Spotify renamed tracks->items in 2026 and an unknown
    # field name in the filter would make the whole request fail.
    return await user_get(user_id, f"/playlists/{playlist_id}")


async def playlist_items(user_id: str, playlist_id: str, max_items: int = 10000) -> list[dict]:
    """All raw playlist entries, in playlist order (paginates `next`)."""
    out: list[dict] = []
    url: Optional[str] = f"/playlists/{playlist_id}/items"
    params: Optional[dict] = {"limit": 50, "offset": 0, "additional_types": "track"}
    while url and len(out) < max_items:
        page = await user_get(user_id, url, params)
        out += [e for e in page.get("items") or [] if isinstance(e, dict)]
        url, params = page.get("next"), None
    return out


def entry_track(entry: dict) -> tuple[Optional[dict], Optional[str]]:
    """(track, None) for an importable track, else (None, reason)."""
    t = entry.get("item") if isinstance(entry.get("item"), dict) else entry.get("track")
    if not isinstance(t, dict):
        return None, "Elemento no disponible en Spotify"
    if t.get("type") and t.get("type") != "track":
        return None, "Episodio de podcast (no es una canción)"
    if entry.get("is_local") or t.get("is_local"):
        return None, "Archivo local de Spotify (no se puede buscar)"
    if not t.get("id") or not t.get("name"):
        return None, "Canción no disponible en Spotify"
    if t.get("is_playable") is False:
        return None, "Canción no disponible en tu país en Spotify"
    return t, None
