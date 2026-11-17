"""Tests for Spotify connection (OAuth) and playlist import. No network: Spotify
is an httpx.MockTransport and NOVA's download manager is a fake."""
from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

pytestmark = pytest.mark.asyncio

ACCESS = "acc-token-SECRET"
REFRESH = "ref-token-SECRET"
PL_ID = "3gCyio5sPiBcOsrvFAKot4"


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------

@pytest.fixture
def sp_config(monkeypatch):
    from nocturne_api import config
    monkeypatch.setattr(config, "SPOTIFY_CLIENT_ID", "cid123")
    monkeypatch.setattr(config, "SPOTIFY_CLIENT_SECRET", "csecret456")
    monkeypatch.setattr(config, "SPOTIFY_REDIRECT_URI", "https://music.example/v1/spotify/callback")
    monkeypatch.setattr(config, "SPOTIFY_IMPORT_DELAY", 0)
    from nocturne_api import spotify_import
    monkeypatch.setattr(spotify_import, "POLL_INTERVAL", 0.01)
    return config


class FakeSpotify:
    """Minimal Spotify accounts + Web API."""

    def __init__(self):
        self.calls: list[str] = []
        self.token_requests: list[dict] = []
        self.refresh_error: str | None = None
        self.items: list[dict] = []
        self.items_status = 200
        self.playlists = []
        self.access = ACCESS

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.calls.append(f"{request.method} {path}")
        if request.url.host == "accounts.spotify.com" and path == "/api/token":
            assert request.headers["authorization"].startswith("Basic ")
            form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
            self.token_requests.append(form)
            if form["grant_type"] == "authorization_code":
                if form.get("code") != "good-code":
                    return httpx.Response(400, json={"error": "invalid_grant"})
                return httpx.Response(200, json={"access_token": self.access, "token_type": "Bearer",
                                                 "expires_in": 3600, "refresh_token": REFRESH,
                                                 "scope": "playlist-read-private"})
            if form["grant_type"] == "refresh_token":
                if self.refresh_error:
                    return httpx.Response(400, json={"error": self.refresh_error})
                self.access = "acc-token-2"
                return httpx.Response(200, json={"access_token": self.access, "expires_in": 3600})
        if request.url.host == "api.spotify.com":
            if request.headers.get("authorization") != f"Bearer {self.access}":
                return httpx.Response(401, json={"error": {"status": 401, "message": "expired"}})
            if path == "/v1/me":
                return httpx.Response(200, json={"id": "spuser", "display_name": "Spotify User"})
            if path == "/v1/me/playlists":
                off = int(request.url.params.get("offset", 0))
                if off == 0 and "page2" not in str(request.url):
                    return httpx.Response(200, json={
                        "items": self.playlists[:1],
                        "next": "https://api.spotify.com/v1/me/playlists?page2=1&offset=1&limit=1"})
                return httpx.Response(200, json={"items": self.playlists[1:], "next": None})
            if path == f"/v1/playlists/{PL_ID}":
                return httpx.Response(200, json={"id": PL_ID, "name": "Favs 2.0", "public": True,
                                                 "images": [{"url": "https://i.scdn.co/a", "width": 640}],
                                                 "owner": {"id": "spuser", "display_name": "Spotify User"}})
            if path == f"/v1/playlists/{PL_ID}/items":
                if self.items_status != 200:
                    return httpx.Response(self.items_status, json={"error": {"status": self.items_status,
                                                                             "message": "Forbidden"}})
                off = int(request.url.params.get("offset", 0))
                page = self.items[off:off + 2]
                nxt = None
                if off + 2 < len(self.items):
                    nxt = f"https://api.spotify.com/v1/playlists/{PL_ID}/items?offset={off + 2}&limit=2"
                return httpx.Response(200, json={"items": page, "next": nxt, "total": len(self.items)})
            if path.startswith("/v1/playlists/"):
                return httpx.Response(404, json={"error": {"status": 404, "message": "Not found"}})
        return httpx.Response(500, json={"error": "unexpected " + str(request.url)})


@pytest.fixture
def fake_spotify(monkeypatch, sp_config):
    from nocturne_api import spotify
    fs = FakeSpotify()
    monkeypatch.setattr(spotify, "_transport", httpx.MockTransport(fs.handler))
    return fs


async def _login(client, username: str) -> tuple[dict, str]:
    from nocturne_api.auth import create_account, get_account_by_username
    if not get_account_by_username(username):
        create_account(username, f"{username}-pass-12345")
    r = await client.post("/auth/login", json={"username": username, "password": f"{username}-pass-12345"})
    return {"Authorization": f"Bearer {r.json()['accessToken']}"}, get_account_by_username(username)["id"]


async def _connect(client, username: str) -> tuple[dict, str]:
    from nocturne_api import spotify
    h, uid = await _login(client, username)
    r = await client.get("/spotify/callback", params={"code": "good-code", "state": spotify.make_state(uid)})
    assert r.status_code == 200, r.text
    return h, uid


def _track(tid, name, artists, secs, *, shape="item", **extra):
    t = {"id": tid, "name": name, "type": "track", "duration_ms": secs * 1000,
         "artists": [{"name": a} for a in artists], "album": {"name": name}}
    t.update(extra)
    return {shape: t, "is_local": False}


def _nova_track(tid, title, artist, duration):
    import database as nova_db
    conn = nova_db.connect()
    with conn:
        conn.execute(
            "INSERT OR REPLACE INTO tracks(id,title,artist,album,duration,file_path,cover_path,added_at,play_count)"
            " VALUES (?,?,?,?,?,?,?,?,0)",
            (tid, title, artist, None, duration, f"/tmp/{tid}.opus", None, "2026-11-01T00:00:00+00:00"),
        )
    conn.close()


class FakeDownloadManager:
    """Mimics NOVA's DownloadManager: search_youtube / download_youtube / get_job."""

    def __init__(self, results: dict[str, list[dict]]):
        self.results = results
        self.queries: list[str] = []
        self.downloads: list[str] = []
        self.jobs: dict[str, dict] = {}
        self.in_flight = 0
        self.max_in_flight = 0

    async def search_youtube(self, query):
        self.queries.append(query)
        return self.results.get(query, [])

    async def download_youtube(self, url, title="", artist=""):
        self.downloads.append(url)
        job_id = f"job{len(self.downloads)}"
        self.jobs[job_id] = {"id": job_id, "status": "downloading", "title": title}
        self.in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self.in_flight)

        async def finish():
            await asyncio.sleep(0.05)
            video = next(r for rs in self.results.values() for r in rs if r["url"] == url)
            # yt-dlp tags YouTube Music uploads with the plain song title (`track`)
            _nova_track("yt_" + video["id"], video.get("track") or video["title"], video["channel"],
                        video["duration"])
            self.jobs[job_id].update(status="done", title=video["title"])
            self.in_flight -= 1

        asyncio.get_running_loop().create_task(finish())
        return job_id

    def get_job(self, job_id):
        return self.jobs.get(job_id)


def _yt(vid, title, channel, duration):
    return {"id": vid, "title": title, "channel": channel, "duration": duration,
            "url": f"https://www.youtube.com/watch?v={vid}"}


async def _wait_worker():
    from nocturne_api import spotify_import
    if spotify_import._worker_task is not None:
        await asyncio.wait_for(spotify_import._worker_task, 10)


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------

async def test_state_sign_verify():
    from nocturne_api import spotify
    s = spotify.make_state("u_abc")
    assert spotify.verify_state(s) == "u_abc"
    payload, sig = s.rsplit(".", 1)
    assert spotify.verify_state(payload + "." + sig[:-2] + "xx") is None
    assert spotify.verify_state(spotify.make_state("u_abc", ttl=-1)) is None
    assert spotify.verify_state(None) is None
    assert spotify.verify_state("garbage") is None


async def test_encrypt_roundtrip_and_tamper():
    from nocturne_api import spotify
    enc = spotify.encrypt("my-token")
    assert enc and "my-token" not in enc
    assert spotify.decrypt(enc) == "my-token"
    assert spotify.encrypt("my-token") != enc            # random nonce
    tampered = enc[:-4] + ("AAAA" if not enc.endswith("AAAA") else "BBBB")
    assert spotify.decrypt(tampered) is None
    assert spotify.decrypt("s1:%%%") is None


async def test_parse_playlist_id():
    from nocturne_api.spotify import parse_playlist_id as p
    assert p(PL_ID) == PL_ID
    assert p(f"https://open.spotify.com/playlist/{PL_ID}?si=abc") == PL_ID
    assert p(f"https://open.spotify.com/intl-es/playlist/{PL_ID}") == PL_ID
    assert p(f"spotify:playlist:{PL_ID}") == PL_ID
    assert p("https://evil.example/playlist/" + PL_ID) is None
    assert p("https://open.spotify.com/album/" + PL_ID) is None
    assert p("") is None and p(None) is None


async def test_entry_track_shapes():
    from nocturne_api.spotify import entry_track
    assert entry_track(_track("a" * 22, "X", ["Y"], 100))[0]["name"] == "X"
    assert entry_track(_track("a" * 22, "X", ["Y"], 100, shape="track"))[0]["name"] == "X"
    assert entry_track({"item": {"id": "e", "name": "Ep", "type": "episode"}})[0] is None
    # local files are kept (searched by name), with a stable synthetic id
    assert entry_track({"is_local": True, "track": {"id": None, "name": "L", "type": "track"}})[0]["id"].startswith("local:")
    assert entry_track({"track": None})[0] is None


async def test_pick_youtube_rejects_wrong_versions_and_durations():
    from nocturne_api import spotify_import as si
    cand = si.spotify_candidate({"name": "Reloj", "artists": [{"name": "Rauw Alejandro"}],
                                 "duration_ms": 228000})
    results = [
        _yt("a", "Rauw Alejandro - Reloj (Remix)", "Rauw Alejandro", 228),
        _yt("b", "Rauw Alejandro - Reloj (Official Video)", "Rauw Alejandro", 290),
        _yt("c", "Reloj - Otro Artista", "Otro Artista", 228),
        _yt("d", "Rauw Alejandro, Anuel AA - Reloj (Official Video)", "Rauw Alejandro", 231),
    ]
    assert si.pick_youtube(cand, results)["id"] == "d"
    assert si.pick_youtube(cand, results[:3]) is None


# ---------------------------------------------------------------------------
# Connection endpoints
# ---------------------------------------------------------------------------

async def test_not_configured(client, monkeypatch):
    from nocturne_api import config
    monkeypatch.setattr(config, "SPOTIFY_CLIENT_ID", "")
    monkeypatch.setattr(config, "SPOTIFY_CLIENT_SECRET", "")
    h, _ = await _login(client, "sp_none")
    r = await client.get("/spotify/status", headers=h)
    assert r.json() == {"configured": False, "connected": False}
    assert (await client.post("/spotify/authorize", headers=h)).status_code == 503
    assert (await client.get("/info")).json()["capabilities"]["spotifyImport"] is False


async def test_authorize_url(client, sp_config):
    from nocturne_api import spotify
    h, uid = await _login(client, "sp_auth")
    r = await client.post("/spotify/authorize", headers=h)
    assert r.status_code == 200
    u = urlparse(r.json()["url"])
    q = {k: v[0] for k, v in parse_qs(u.query).items()}
    assert u.netloc == "accounts.spotify.com" and u.path == "/authorize"
    assert q["client_id"] == "cid123" and q["response_type"] == "code"
    assert q["redirect_uri"] == "https://music.example/v1/spotify/callback"
    assert q["scope"] == "playlist-read-private playlist-read-collaborative"
    assert spotify.verify_state(q["state"]) == uid
    assert "csecret456" not in r.text
    assert (await client.get("/info")).json()["capabilities"]["spotifyImport"] is True
    assert (await client.post("/spotify/authorize")).status_code == 401


async def test_callback_connects_and_encrypts(client, fake_spotify):
    from nocturne_api.db import connect
    h, uid = await _connect(client, "sp_cb")
    with connect() as conn:
        row = dict(conn.execute("SELECT * FROM v1_spotify_tokens WHERE user_id=?", (uid,)).fetchone())
    assert ACCESS not in json.dumps(row) and REFRESH not in json.dumps(row)
    assert fake_spotify.token_requests[0]["redirect_uri"] == "https://music.example/v1/spotify/callback"

    r = await client.get("/spotify/status", headers=h)
    d = r.json()
    assert d["configured"] and d["connected"]
    assert d["account"] == {"id": "spuser", "displayName": "Spotify User"}
    exp = datetime.fromisoformat(d["expiresAt"])
    assert timedelta(days=179) < exp - datetime.now(timezone.utc) <= timedelta(days=180)

    assert (await client.delete("/spotify/connection", headers=h)).status_code == 204
    assert (await client.get("/spotify/status", headers=h)).json()["connected"] is False


async def test_callback_errors(client, fake_spotify):
    from nocturne_api import spotify
    _, uid = await _login(client, "sp_cberr")
    r = await client.get("/spotify/callback", params={"error": "access_denied", "state": spotify.make_state(uid)})
    assert r.status_code == 200 and "cancelada" in r.text.lower()
    assert "text/html" in r.headers["content-type"]
    r = await client.get("/spotify/callback", params={"code": "good-code", "state": "forged.state"})
    assert r.status_code == 400
    r = await client.get("/spotify/callback", params={"code": "bad", "state": spotify.make_state(uid)})
    assert r.status_code == 502
    assert spotify.get_connection(uid) is None
    r = await client.get("/spotify/callback", params={"code": "good-code", "state": spotify.make_state(uid)})
    assert "Spotify conectado" in r.text


async def test_refresh_and_invalid_grant(client, fake_spotify):
    from nocturne_api import spotify
    from nocturne_api.db import connect
    h, uid = await _connect(client, "sp_refresh")
    fake_spotify.playlists = [{"id": "p1", "name": "One", "public": False, "images": [],
                               "owner": {"id": "spuser", "display_name": "S"}, "items": {"total": 3}},
                              {"id": "p2", "name": "Two", "public": True, "images": None,
                               "owner": {"id": "o"}, "tracks": {"total": 7}}]
    # force expiry -> automatic refresh
    with connect() as conn:
        conn.execute("UPDATE v1_spotify_tokens SET expires_at=? WHERE user_id=?",
                     ((datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(), uid))
    r = await client.get("/spotify/playlists", headers=h)
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert [p["id"] for p in items] == ["p1", "p2"]
    assert items[0]["trackCount"] == 3 and items[1]["trackCount"] == 7
    assert items[1]["image"] is None and items[0]["public"] is False
    assert fake_spotify.token_requests[-1]["grant_type"] == "refresh_token"
    assert spotify.decrypt(spotify.get_connection(uid)["access_token"]) == "acc-token-2"
    # refresh token kept when Spotify doesn't send a new one
    assert spotify.decrypt(spotify.get_connection(uid)["refresh_token"]) == REFRESH

    # revoked -> disconnected
    fake_spotify.refresh_error = "invalid_grant"
    with connect() as conn:
        conn.execute("UPDATE v1_spotify_tokens SET expires_at=? WHERE user_id=?",
                     ((datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(), uid))
    r = await client.get("/spotify/playlists", headers=h)
    assert r.status_code == 409 and r.json()["code"] == "spotify_not_connected"
    st = (await client.get("/spotify/status", headers=h)).json()
    assert st["connected"] is False and st["expiresAt"]          # expiry kept when known
    r = await client.post("/spotify/imports", json={"playlist": PL_ID}, headers=h)
    assert r.status_code == 409


async def test_status_after_refresh_expiry(client, fake_spotify):
    from nocturne_api.db import connect
    h, uid = await _connect(client, "sp_expired")
    with connect() as conn:
        conn.execute("UPDATE v1_spotify_tokens SET refresh_expires_at=? WHERE user_id=?",
                     ((datetime.now(timezone.utc) - timedelta(days=1)).isoformat(), uid))
    st = (await client.get("/spotify/status", headers=h)).json()
    assert st["connected"] is False and st["expiresAt"]


async def test_not_connected_is_409_everywhere(client, fake_spotify):
    h, _ = await _login(client, "sp_never")
    for method, path in (("GET", "/spotify/playlists"), ("GET", f"/spotify/playlists/{PL_ID}"),
                         ("POST", "/spotify/imports")):
        r = await client.request(method, path, headers=h, json={"playlist": PL_ID} if method == "POST" else None)
        assert r.status_code == 409, path
        assert r.json()["code"] == "spotify_not_connected"


async def test_unreadable_playlist_message(client, fake_spotify):
    h, _ = await _connect(client, "sp_unreadable")
    r = await client.get("/spotify/playlists/" + "B" * 22, headers=h)
    assert r.status_code == 404 and "editorial" in r.json()["message"]
    r = await client.get(f"/spotify/playlists/{PL_ID}", headers=h)
    assert r.status_code == 200 and r.json()["name"] == "Favs 2.0"


async def test_import_requires_connection_and_valid_id(client, fake_spotify):
    h, _ = await _login(client, "sp_noconn")
    r = await client.post("/spotify/imports", json={"playlist": PL_ID}, headers=h)
    assert r.status_code == 409
    h, _ = await _connect(client, "sp_badid")
    r = await client.post("/spotify/imports", json={"playlist": "https://example.com/x"}, headers=h)
    assert r.status_code == 400
    r = await client.post("/spotify/imports", json={"playlist": "B" * 22}, headers=h)
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Import job
# ---------------------------------------------------------------------------

async def test_full_import(client, fake_spotify, monkeypatch):
    from nocturne_api import spotify_import
    _nova_track("lib_reloj", "Rauw Alejandro, Anuel AA - Reloj (Official Video)", "Rauw Alejandro", 228)
    _nova_track("lib_hitboy", "DUKI x KHEA - HITBOY", "Duki", 181)
    fake_spotify.items = [
        _track("1" * 22, "HITBOY", ["Duki", "KHEA"], 181),
        {"item": {"id": "ep", "name": "Some podcast", "type": "episode"}},
        _track("2" * 22, "Canción Nueva", ["Artista Nuevo"], 200, shape="track"),
        _track("3" * 22, "Reloj", ["Rauw Alejandro", "Anuel AA"], 228),
        _track("4" * 22, "Otra Nueva", ["Artista Nuevo"], 150),
        _track("5" * 22, "Sin Resultado", ["Nadie"], 100),
        _track("3" * 22, "Reloj", ["Rauw Alejandro", "Anuel AA"], 228),   # repeated entry
        {"track": {"id": None, "name": "local.mp3", "type": "track", "is_local": True}, "is_local": True},
    ]
    dm = FakeDownloadManager({
        "Artista Nuevo - Canción Nueva": [
            _yt("bad1", "Artista Nuevo - Canción Nueva (Slowed)", "Artista Nuevo", 260),
            _yt("good1", "Artista Nuevo - Canción Nueva (Video Oficial)", "Artista Nuevo", 203)],
        "Artista Nuevo - Otra Nueva": [dict(_yt("good2", "Artista Nuevo - Otra Nueva", "Artista Nuevo - Topic", 151),
                                            track="Otra Nueva")],
        "Nadie - Sin Resultado": [_yt("x", "Something else entirely", "Random", 100)],
    })
    monkeypatch.setattr(spotify_import, "get_download_manager", lambda: dm)

    h, uid = await _connect(client, "sp_importer")
    r = await client.post("/spotify/imports", json={"playlist": f"https://open.spotify.com/playlist/{PL_ID}?si=x"},
                          headers=h)
    assert r.status_code == 202, r.text
    imp = r.json()
    assert imp["status"] == "queued"
    assert imp["spotifyPlaylist"] == {"id": PL_ID, "name": "Favs 2.0", "image": "https://i.scdn.co/a"}

    # same playlist while active -> same import
    r2 = await client.post("/spotify/imports", json={"playlist": PL_ID}, headers=h)
    assert r2.json()["id"] == imp["id"]

    await _wait_worker()
    d = (await client.get(f"/spotify/imports/{imp['id']}", headers=h)).json()
    assert d["status"] == "done", d
    assert d["total"] == 7                    # 5 unique tracks + episode + local file
    assert d["matched"] == 2 and d["downloaded"] == 2 and d["failed"] == 3 and d["pending"] == 0
    reasons = {f["title"]: f["reason"] for f in d["failures"]}
    assert "Sin Resultado" in reasons and "YouTube" in reasons["Sin Resultado"]
    assert any("Episodio" in f["reason"] for f in d["failures"])
    # the local file is no longer skipped: it was searched on YouTube and not found
    assert "YouTube" in reasons["local.mp3"]
    assert d["finishedAt"]
    assert dm.downloads == ["https://www.youtube.com/watch?v=good1", "https://www.youtube.com/watch?v=good2"]
    assert dm.max_in_flight <= 2

    p = (await client.get(f"/playlists/{d['playlistId']}", headers=h)).json()
    assert p["name"] == "Favs 2.0" and p["description"] == "Importada de Spotify"
    assert p["owner"]["id"] == uid and p["editable"] is True
    assert [t["id"] for t in p["tracks"]] == ["lib_hitboy", "yt_good1", "lib_reloj", "yt_good2"]

    lst = (await client.get("/spotify/imports", headers=h)).json()
    assert lst["items"][0]["id"] == imp["id"]

    # re-import: reuses the playlist, nothing downloaded twice (track map)
    dm.downloads.clear()
    r = await client.post("/spotify/imports", json={"playlist": PL_ID}, headers=h)
    await _wait_worker()
    d2 = (await client.get(f"/spotify/imports/{r.json()['id']}", headers=h)).json()
    assert d2["playlistId"] == d["playlistId"]
    assert d2["matched"] == 4 and d2["downloaded"] == 0
    assert dm.downloads == []

    # other users can't see the import
    h2, _ = await _login(client, "sp_other")
    assert (await client.get(f"/spotify/imports/{imp['id']}", headers=h2)).status_code == 404


async def test_import_without_download(client, fake_spotify, monkeypatch):
    from nocturne_api import spotify_import
    fake_spotify.items = [_track("6" * 22, "Nunca Existió", ["Fantasma"], 120)]
    monkeypatch.setattr(spotify_import, "get_download_manager", lambda: pytest.fail("no downloads"))
    h, _ = await _connect(client, "sp_nodl")
    r = await client.post("/spotify/imports", json={"playlist": PL_ID, "download": False}, headers=h)
    await _wait_worker()
    d = (await client.get(f"/spotify/imports/{r.json()['id']}", headers=h)).json()
    assert d["status"] == "done" and d["failed"] == 1 and d["downloaded"] == 0
    assert "descarga desactivada" in d["failures"][0]["reason"]
    assert d["failures"][0]["artists"] == ["Fantasma"]


async def test_import_items_forbidden(client, fake_spotify):
    fake_spotify.items_status = 403
    h, _ = await _connect(client, "sp_forbid")
    r = await client.post("/spotify/imports", json={"playlist": PL_ID}, headers=h)
    await _wait_worker()
    d = (await client.get(f"/spotify/imports/{r.json()['id']}", headers=h)).json()
    assert d["status"] == "failed" and "Spotify" in d["error"]


async def test_cancel_and_restart_recovery(client, fake_spotify):
    from nocturne_api import spotify_import
    from nocturne_api.db import connect
    h, uid = await _connect(client, "sp_cancel")
    row = spotify_import.create(uid, PL_ID, "Favs", None, True)
    r = await client.delete(f"/spotify/imports/{row['id']}", headers=h)
    assert r.status_code == 200 and r.json()["status"] == "cancelled"

    row2 = spotify_import.create(uid, "7" * 22, "Otra", None, True)
    with connect() as conn:
        conn.execute("UPDATE v1_spotify_imports SET status='downloading' WHERE id=?", (row2["id"],))
    assert spotify_import.recover_interrupted() >= 1
    d = (await client.get(f"/spotify/imports/{row2['id']}", headers=h)).json()
    assert d["status"] == "failed" and "reinici" in d["error"]
    # cancelled stays cancelled
    d = (await client.get(f"/spotify/imports/{row['id']}", headers=h)).json()
    assert d["status"] == "cancelled"


# ── entry_track: local files and unplayable tracks are still importable ──────

def test_entry_track_local_file_gets_stable_synthetic_id():
    from nocturne_api import spotify
    entry = {"is_local": True, "track": {"id": None, "type": "track", "name": "Mi Tema",
             "artists": [{"name": "Artista Local", "id": None}], "duration_ms": 201000, "is_local": True}}
    t1, r1 = spotify.entry_track(entry)
    t2, _ = spotify.entry_track(entry)
    assert r1 is None and t1["id"].startswith("local:") and t1["id"] == t2["id"]
    other = {"is_local": True, "track": {**entry["track"], "name": "Otro Tema"}}
    assert spotify.entry_track(other)[0]["id"] != t1["id"]


def test_entry_track_unplayable_and_idless_tracks_are_kept():
    from nocturne_api import spotify
    t, r = spotify.entry_track({"track": {"id": "abc", "type": "track", "name": "X", "is_playable": False,
                                          "artists": [{"name": "Y"}], "duration_ms": 1000}})
    assert r is None and t["id"] == "abc"
    t, r = spotify.entry_track({"track": {"id": None, "type": "track", "name": "Sin Id", "artists": [], "duration_ms": 1}})
    assert r is None and t["id"].startswith("local:")


def test_entry_track_still_skips_episodes_missing_and_untitled():
    from nocturne_api import spotify
    assert spotify.entry_track({"track": None})[0] is None
    assert spotify.entry_track({"track": {"id": "e1", "type": "episode", "name": "Pod"}})[1].startswith("Episodio")
    assert spotify.entry_track({"track": {"id": "t", "type": "track", "name": "  "}})[0] is None
