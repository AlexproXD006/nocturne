"""Tests for the playlists read/write API (ownership, visibility, editing)."""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.asyncio


async def _login(client, username: str, role: str = "user") -> dict:
    from nocturne_api.auth import create_account
    from nocturne_api.db import connect
    with connect() as conn:
        exists = conn.execute("SELECT id FROM v1_accounts WHERE username=?", (username,)).fetchone()
    if not exists:
        create_account(username, f"{username}-pass-12345", role=role)
    r = await client.post("/auth/login", json={"username": username, "password": f"{username}-pass-12345"})
    assert r.status_code == 200
    return {"Authorization": f"Bearer {r.json()['accessToken']}"}


async def _create(client, headers, **body):
    body.setdefault("name", "Mi lista")
    r = await client.post("/playlists", json=body, headers=headers)
    assert r.status_code == 201, r.text
    return r.json()


async def test_info_advertises_playlists(client):
    r = await client.get("/info")
    caps = r.json()["capabilities"]
    assert caps["playlists"] is True
    assert "spotifyImport" in caps


async def test_create_with_tracks_and_detail(client):
    h = await _login(client, "pl_alice")
    d = await _create(client, h, name="  Gym  ", description="Para entrenar",
                      trackIds=["track002", "nope", "track001", "track002"])
    assert d["name"] == "Gym"
    assert d["description"] == "Para entrenar"
    assert d["editable"] is True
    assert d["owner"]["name"] == "pl_alice"
    assert [t["id"] for t in d["tracks"]] == ["track002", "track001"]
    assert d["trackCount"] == 2
    assert isinstance(d["artwork"], list)

    r = await client.get(f"/playlists/{d['id']}", headers=h)
    assert r.status_code == 200
    assert [t["id"] for t in r.json()["tracks"]] == ["track002", "track001"]


async def test_validation(client):
    h = await _login(client, "pl_alice")
    for body in ({"name": ""}, {"name": "   "}, {"name": "x" * 101}, {},
                 {"name": "ok", "description": "d" * 301}, {"name": "ok", "trackIds": "track001"}):
        r = await client.post("/playlists", json=body, headers=h)
        assert r.status_code == 400, body
        assert r.json()["code"] == "bad_request"
    assert (await client.post("/playlists", json={"name": "x" * 100}, headers=h)).status_code == 201


async def test_private_playlists_hidden_from_others(client):
    alice = await _login(client, "pl_alice")
    bob = await _login(client, "pl_bob")
    admin = await _login(client, "pl_admin", role="admin")
    d = await _create(client, alice, name="Secreta")

    r = await client.get("/library/playlists?limit=200", headers=bob)
    assert d["id"] not in [p["id"] for p in r.json()["items"]]
    assert (await client.get(f"/playlists/{d['id']}", headers=bob)).status_code == 404
    assert (await client.patch(f"/playlists/{d['id']}", json={"name": "x"}, headers=bob)).status_code == 404
    assert (await client.delete(f"/playlists/{d['id']}", headers=bob)).status_code == 404

    # admins can open and edit it
    r = await client.get(f"/playlists/{d['id']}", headers=admin)
    assert r.status_code == 200 and r.json()["editable"] is True

    # owner sees it first in the library (newest first)
    newer = await _create(client, alice, name="Más nueva")
    items = (await client.get("/library/playlists?limit=200", headers=alice)).json()["items"]
    ids = [p["id"] for p in items]
    assert ids.index(newer["id"]) < ids.index(d["id"])
    assert all(p["editable"] for p in items if p.get("owner", {}).get("id"))


async def test_shared_legacy_playlist(client):
    import database as nova_db
    user = await _login(client, "pl_alice")
    admin = await _login(client, "pl_admin", role="admin")
    legacy = nova_db.create_playlist("Legacy shared")
    nova_db.add_track_to_playlist(legacy["id"], "track001")

    items = (await client.get("/library/playlists?limit=200", headers=user)).json()["items"]
    mine = [p for p in items if p["id"] == legacy["id"]]
    assert mine and mine[0]["editable"] is False and "owner" not in mine[0]
    assert mine[0]["trackCount"] == 1

    r = await client.patch(f"/playlists/{legacy['id']}", json={"name": "x"}, headers=user)
    assert r.status_code == 403 and r.json()["code"] == "forbidden"
    r = await client.post(f"/playlists/{legacy['id']}/tracks", json={"trackIds": ["track002"]}, headers=user)
    assert r.status_code == 403

    r = await client.patch(f"/playlists/{legacy['id']}", json={"description": "Para todos"}, headers=admin)
    assert r.status_code == 200
    assert r.json()["description"] == "Para todos" and r.json()["editable"] is True
    # still shared after the admin edit
    r = await client.get(f"/playlists/{legacy['id']}", headers=user)
    assert r.status_code == 200 and r.json()["editable"] is False


async def test_patch_rename_and_clear_description(client):
    h = await _login(client, "pl_alice")
    d = await _create(client, h, name="Antes", description="algo")
    r = await client.patch(f"/playlists/{d['id']}", json={"name": "Después"}, headers=h)
    assert r.status_code == 200
    assert r.json()["name"] == "Después" and r.json()["description"] == "algo"
    assert "tracks" not in r.json()
    r = await client.patch(f"/playlists/{d['id']}", json={"description": ""}, headers=h)
    assert "description" not in r.json()
    assert (await client.patch(f"/playlists/{d['id']}", json={"name": ""}, headers=h)).status_code == 400


async def test_add_remove_reorder(client):
    h = await _login(client, "pl_alice")
    d = await _create(client, h, name="Orden")
    r = await client.post(f"/playlists/{d['id']}/tracks",
                          json={"trackIds": ["track001", "ghost", "track001", "track002"]}, headers=h)
    assert r.status_code == 200
    body = r.json()
    assert body["added"] == ["track001", "track002"]
    assert body["skipped"] == ["ghost", "track001"]
    assert body["playlist"]["trackCount"] == 2

    r = await client.post(f"/playlists/{d['id']}/tracks", json={"trackIds": ["track002"]}, headers=h)
    assert r.json()["added"] == [] and r.json()["skipped"] == ["track002"]
    assert (await client.post(f"/playlists/{d['id']}/tracks", json={}, headers=h)).status_code == 400

    r = await client.put(f"/playlists/{d['id']}/tracks", json={"trackIds": ["track002", "track001"]}, headers=h)
    assert r.status_code == 200
    assert [t["id"] for t in r.json()["tracks"]] == ["track002", "track001"]
    for bad in (["track002"], ["track002", "track002"], ["track002", "ghost"],
                ["track002", "track001", "ghost"]):
        r = await client.put(f"/playlists/{d['id']}/tracks", json={"trackIds": bad}, headers=h)
        assert r.status_code == 400, bad

    r = await client.delete(f"/playlists/{d['id']}/tracks/track002", headers=h)
    assert r.status_code == 204
    r = await client.get(f"/playlists/{d['id']}", headers=h)
    assert [t["id"] for t in r.json()["tracks"]] == ["track001"]


async def test_delete_playlist(client):
    from nocturne_api.playlists import get_meta
    h = await _login(client, "pl_alice")
    d = await _create(client, h, name="Borrar", trackIds=["track001"])
    assert (await client.delete(f"/playlists/{d['id']}", headers=h)).status_code == 204
    assert (await client.get(f"/playlists/{d['id']}", headers=h)).status_code == 404
    assert get_meta(d["id"]) is None
    assert (await client.delete(f"/playlists/{d['id']}", headers=h)).status_code == 404


async def test_home_only_shows_visible_playlists(client):
    alice = await _login(client, "pl_alice")
    bob = await _login(client, "pl_bob")
    d = await _create(client, alice, name="Solo Alice", trackIds=["track001"])
    r = await client.get("/home", headers=bob)
    for s in r.json()["sections"]:
        if s["kind"] == "playlists":
            assert d["id"] not in [p["id"] for p in s["items"]]


async def test_requires_auth(client):
    assert (await client.post("/playlists", json={"name": "x"})).status_code == 401
    assert (await client.get("/library/playlists")).status_code == 401
