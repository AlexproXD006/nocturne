"""Per-user equalizer: state, custom presets, validation, isolation, and the CORS/Range stream headers."""
from __future__ import annotations

import os
import time

import pytest

pytestmark = pytest.mark.asyncio

G0 = [0] * 10
G = [3, 2.5, 1, 0, -1, -2, 0, 1.5, 2, 4]


async def _login(client, username: str) -> dict:
    from nocturne_api.auth import create_account
    from nocturne_api.db import connect
    with connect() as conn:
        exists = conn.execute("SELECT id FROM v1_accounts WHERE username=?", (username,)).fetchone()
    if not exists:
        create_account(username, f"{username}-pass-12345", role="user")
    r = await client.post("/auth/login", json={"username": username, "password": f"{username}-pass-12345"})
    assert r.status_code == 200
    return {"Authorization": f"Bearer {r.json()['accessToken']}"}


async def test_requires_auth(client):
    for method, path in [("get", "/me/eq"), ("put", "/me/eq"), ("get", "/me/eq/presets"), ("post", "/me/eq/presets")]:
        r = await getattr(client, method)(path)
        assert r.status_code == 401, (method, path)


async def test_default_state_is_flat(client):
    h = await _login(client, "eq_default")
    r = await client.get("/me/eq", headers=h)
    assert r.status_code == 200
    body = r.json()
    assert body["enabled"] is True and body["preamp"] == 0 and body["gains"] == G0 and body["presetId"] == "flat"


async def test_put_state_roundtrip_and_snap(client):
    h = await _login(client, "eq_state")
    r = await client.put("/me/eq", headers=h, json={"enabled": False, "preamp": -3.2, "gains": [3.26] + G[1:], "presetId": "rock"})
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["enabled"] is False and b["preamp"] == -3.0 and b["gains"][0] == 3.5 and b["presetId"] == "rock"
    assert (await client.get("/me/eq", headers=h)).json()["gains"] == b["gains"]
    assert b["updatedAt"]


@pytest.mark.parametrize("patch", [
    {"gains": [0] * 9},
    {"gains": [0] * 11},
    {"gains": [13] + [0] * 9},
    {"gains": [-12.5] + [0] * 9},
    {"gains": ["a"] + [0] * 9},
    {"gains": [True] + [0] * 9},
    {"gains": None},
    {"preamp": 6.5},
    {"preamp": -13},
    {"preamp": "x"},
    {"enabled": "yes"},
    {"enabled": None},
    {"presetId": "../etc"},
    {"presetId": 5},
])
async def test_put_state_validation(client, patch):
    h = await _login(client, "eq_valid")
    body = {"enabled": True, "preamp": 0, "gains": G0, "presetId": None, **patch}
    r = await client.put("/me/eq", headers=h, json=body)
    assert r.status_code == 400, r.text
    assert r.json()["code"] == "bad_request"


async def test_preset_crud(client):
    h = await _login(client, "eq_crud")
    assert (await client.get("/me/eq/presets", headers=h)).json() == {"items": []}
    r = await client.post("/me/eq/presets", headers=h, json={"name": "  Mi   curva ", "preamp": -2, "gains": G})
    assert r.status_code == 201, r.text
    p = r.json()
    assert p["name"] == "Mi curva" and p["id"].startswith("custom:") and p["gains"] == G and p["preamp"] == -2
    pid = p["id"]
    r = await client.put(f"/me/eq/presets/{pid}", headers=h, json={"name": "Renombrada"})
    assert r.status_code == 200 and r.json()["name"] == "Renombrada" and r.json()["gains"] == G
    r = await client.put(f"/me/eq/presets/{pid}", headers=h, json={"gains": G0, "preamp": 0})
    assert r.json()["gains"] == G0 and r.json()["name"] == "Renombrada"
    items = (await client.get("/me/eq/presets", headers=h)).json()["items"]
    assert [i["id"] for i in items] == [pid]
    # duplicate = another POST
    r2 = await client.post("/me/eq/presets", headers=h, json={"name": "Renombrada (copia)", "preamp": 0, "gains": G0})
    assert r2.status_code == 201 and r2.json()["id"] != pid
    # selecting stores the id in the state
    r = await client.put("/me/eq", headers=h, json={"enabled": True, "preamp": 0, "gains": G0, "presetId": pid})
    assert r.json()["presetId"] == pid
    # deleting the active preset unlinks it
    assert (await client.delete(f"/me/eq/presets/{pid}", headers=h)).status_code == 204
    assert (await client.get("/me/eq", headers=h)).json()["presetId"] is None
    assert (await client.delete(f"/me/eq/presets/{pid}", headers=h)).status_code == 404
    assert (await client.put(f"/me/eq/presets/{pid}", headers=h, json={"name": "x"})).status_code == 404


async def test_preset_validation_and_limit(client):
    h = await _login(client, "eq_limit")
    for body in [{"name": "", "preamp": 0, "gains": G0}, {"name": "x" * 41, "preamp": 0, "gains": G0},
                 {"preamp": 0, "gains": G0}, {"name": "a", "preamp": 9, "gains": G0}, {"name": "a", "preamp": 0, "gains": [0]}]:
        assert (await client.post("/me/eq/presets", headers=h, json=body)).status_code == 400, body
    for i in range(50):
        assert (await client.post("/me/eq/presets", headers=h, json={"name": f"p{i}", "preamp": 0, "gains": G0})).status_code == 201
    r = await client.post("/me/eq/presets", headers=h, json={"name": "one more", "preamp": 0, "gains": G0})
    assert r.status_code == 400


async def test_per_user_isolation(client):
    a, b = await _login(client, "eq_iso_a"), await _login(client, "eq_iso_b")
    p = (await client.post("/me/eq/presets", headers=a, json={"name": "A", "preamp": 0, "gains": G})).json()
    await client.put("/me/eq", headers=a, json={"enabled": False, "preamp": -1, "gains": G, "presetId": p["id"]})
    assert (await client.get("/me/eq/presets", headers=b)).json()["items"] == []
    sb = (await client.get("/me/eq", headers=b)).json()
    assert sb["enabled"] is True and sb["gains"] == G0
    assert (await client.put(f"/me/eq/presets/{p['id']}", headers=b, json={"name": "hack"})).status_code == 404
    assert (await client.delete(f"/me/eq/presets/{p['id']}", headers=b)).status_code == 404
    # B cannot select A's preset (the link is dropped)
    r = await client.put("/me/eq", headers=b, json={"enabled": True, "preamp": 0, "gains": G0, "presetId": p["id"]})
    assert r.json()["presetId"] is None
    assert (await client.get("/me/eq/presets", headers=a)).json()["items"][0]["name"] == "A"


# ---- stream CORS + Range ---------------------------------------------------------------------

@pytest.fixture
def audio_track():
    import database as nova_db
    from nocturne_api import config
    path = os.path.join(config.MUSIC_ROOT, "eq_cors.mp3")
    with open(path, "wb") as f:
        f.write(bytes(range(256)) * 40)
    conn = nova_db.connect()
    conn.execute("DELETE FROM tracks WHERE id='eqtrack'")
    conn.execute("INSERT INTO tracks VALUES ('eqtrack','T','A','Al',10,?,NULL,'2026-01-01T00:00:00+00:00',NULL,NULL,NULL,NULL,0,NULL)", (path,))
    conn.commit()
    conn.close()
    yield "eqtrack"


def _signed(track_id):
    from nocturne_api.signing import sign_stream_url
    url, _ = sign_stream_url(track_id)
    return url[url.index("/media/stream/"):]


async def test_stream_cors_and_range(client, audio_track):
    url = _signed(audio_track)
    r = await client.get(url, headers={"Origin": "https://other.example"})
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] in ("*", "https://other.example")
    expose = r.headers["access-control-expose-headers"].lower()
    for h in ("content-range", "accept-ranges", "content-length"):
        assert h in expose
    assert r.headers["accept-ranges"] == "bytes"
    r = await client.get(url, headers={"Range": "bytes=10-19", "Origin": "https://other.example"})
    assert r.status_code == 206
    assert r.headers["content-range"].startswith("bytes 10-19/")
    assert r.content == (bytes(range(256)) * 40)[10:20]
    assert "access-control-allow-origin" in r.headers


async def test_stream_signature_still_enforced(client, audio_track):
    url = _signed(audio_track)
    bad = url.replace("sig=", "sig=0")
    r = await client.get(bad, headers={"Origin": "https://other.example"})
    assert r.status_code == 403
    path = f"/media/stream/{audio_track}?sig=x&exp={int(time.time()) + 100}"
    assert (await client.get(path)).status_code == 403


async def test_stream_range_variants(client, audio_track):
    url = _signed(audio_track)
    data = bytes(range(256)) * 40
    n = len(data)
    r = await client.get(url, headers={"Range": "bytes=0-"})
    assert r.status_code == 206 and r.content == data and r.headers["content-range"] == f"bytes 0-{n - 1}/{n}"
    r = await client.get(url, headers={"Range": "bytes=-5"})
    assert r.status_code == 206 and r.content == data[-5:]
    r = await client.get(url, headers={"Range": f"bytes={n - 2}-999999"})
    assert r.status_code == 206 and r.content == data[-2:]
    for bad in (f"bytes={n}-", "bytes=5-2", "bytes=0-1,3-4", "items=0-1", "bytes=-"):
        r = await client.get(url, headers={"Range": bad})
        assert r.status_code == 416, bad
        assert r.headers["content-range"] == f"bytes */{n}"
