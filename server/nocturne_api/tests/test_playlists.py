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


# ── repeated tracks (entry ids) ─────────────────────────────────────────────

async def test_duplicates_entries_api(client):
    h = await _login(client, "pl_dups")
    d = await _create(client, h, name="Repes", trackIds=["track001", "track002"])
    assert all(isinstance(t["entryId"], str) and t["entryId"] for t in d["tracks"])

    # default: already-present ids are skipped (legacy behaviour)
    r = await client.post(f"/playlists/{d['id']}/tracks", json={"trackIds": ["track001"]}, headers=h)
    assert r.json()["added"] == [] and r.json()["skipped"] == ["track001"]
    # allowDuplicates: appended again (also when repeated inside the request); unknown ids skipped
    r = await client.post(f"/playlists/{d['id']}/tracks",
                          json={"trackIds": ["track001", "ghost", "track001"], "allowDuplicates": True}, headers=h)
    assert r.status_code == 200
    assert r.json()["added"] == ["track001", "track001"] and r.json()["skipped"] == ["ghost"]
    assert r.json()["playlist"]["trackCount"] == 4

    p = (await client.get(f"/playlists/{d['id']}", headers=h)).json()
    assert [t["id"] for t in p["tracks"]] == ["track001", "track002", "track001", "track001"]
    entries = [t["entryId"] for t in p["tracks"]]
    assert len(set(entries)) == 4

    # reorder by entry ids
    new = [entries[2], entries[1], entries[0], entries[3]]
    r = await client.put(f"/playlists/{d['id']}/tracks", json={"entryIds": new}, headers=h)
    assert r.status_code == 200
    assert [t["entryId"] for t in r.json()["tracks"]] == new
    for bad in (new[:3], new[:3] + [new[0]], new[:3] + ["nope"]):
        r = await client.put(f"/playlists/{d['id']}/tracks", json={"entryIds": bad}, headers=h)
        assert r.status_code == 400, bad

    # legacy trackIds reorder: must be a permutation of the multiset
    r = await client.put(f"/playlists/{d['id']}/tracks",
                         json={"trackIds": ["track002", "track001", "track001", "track001"]}, headers=h)
    assert r.status_code == 200
    reordered = r.json()
    assert [t["id"] for t in reordered["tracks"]] == ["track002", "track001", "track001", "track001"]
    for bad in (["track002", "track001"], ["track002", "track002", "track001", "track001"]):
        r = await client.put(f"/playlists/{d['id']}/tracks", json={"trackIds": bad}, headers=h)
        assert r.status_code == 400, bad

    # remove one occurrence
    one = reordered["tracks"][2]["entryId"]
    assert (await client.delete(f"/playlists/{d['id']}/entries/{one}", headers=h)).status_code == 204
    assert (await client.delete(f"/playlists/{d['id']}/entries/{one}", headers=h)).status_code == 404
    p = (await client.get(f"/playlists/{d['id']}", headers=h)).json()
    assert [t["id"] for t in p["tracks"]] == ["track002", "track001", "track001"]
    assert one not in {t["entryId"] for t in p["tracks"]}

    # other users can't delete entries
    h2 = await _login(client, "pl_dups_other")
    e = p["tracks"][0]["entryId"]
    assert (await client.delete(f"/playlists/{d['id']}/entries/{e}", headers=h2)).status_code == 404

    # DELETE /tracks/:trackId still removes every occurrence
    assert (await client.delete(f"/playlists/{d['id']}/tracks/track001", headers=h)).status_code == 204
    p = (await client.get(f"/playlists/{d['id']}", headers=h)).json()
    assert [t["id"] for t in p["tracks"]] == ["track002"] and p["trackCount"] == 1


async def test_sync_sequence_reuses_entries_and_keeps_manual_ones():
    from nocturne_api import playlists as pl
    row = pl.create("Sync", None)
    pid = row["id"]
    pl.append_tracks(pid, ["track002"])                 # added by hand
    res = pl.sync_sequence(pid, ["track001", None, "track001", "track002"])
    assert res["added"] == 2
    assert pl.playlist_track_ids(pid) == ["track001", "track001", "track002"]
    before = pl.playlist_entries(pid)
    assert pl.sync_sequence(pid, ["track001", "track001", "track002"]) == {"added": 0, "reordered": False}
    assert pl.playlist_entries(pid) == before           # stable entry ids
    pl.delete(pid)


async def test_nova_legacy_helpers_with_repeats():
    import database as nova_db
    from nocturne_api import playlists as pl
    pid = nova_db.create_playlist("Legacy")["id"]
    assert nova_db.add_track_to_playlist(pid, "track001")
    assert nova_db.add_track_to_playlist(pid, "track001") is None           # legacy: no repeat
    assert nova_db.add_track_to_playlist(pid, "track002")
    assert nova_db.add_track_to_playlist(pid, "track001", allow_duplicates=True)
    rows = nova_db.get_playlist_tracks(pid)
    assert [r["id"] for r in rows] == ["track001", "track002", "track001"]
    assert all(r["entry_id"] for r in rows)
    nova_db.reorder_playlist_tracks(pid, ["track002", "track001", "track001"])
    assert pl.playlist_track_ids(pid) == ["track002", "track001", "track001"]
    assert nova_db.remove_playlist_entry(pid, rows[0]["entry_id"]) is True
    assert nova_db.remove_playlist_entry(pid, "nope") is False
    nova_db.remove_track_from_playlist(pid, "track001")
    assert pl.playlist_track_ids(pid) == ["track002"]
    nova_db.delete_playlist(pid)


async def test_playlist_entries_migration(tmp_path, monkeypatch):
    """Legacy PK(playlist_id, track_id) table -> entry ids, order kept, idempotent, backed up."""
    import sqlite3
    import database as nova_db
    db = tmp_path / "library.db"
    conn = sqlite3.connect(db)
    conn.executescript("""
        CREATE TABLE tracks (id TEXT PRIMARY KEY, title TEXT);
        CREATE TABLE playlists (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT);
        CREATE TABLE playlist_tracks (
            playlist_id TEXT NOT NULL, track_id TEXT NOT NULL, position INTEGER DEFAULT 0,
            PRIMARY KEY (playlist_id, track_id),
            FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
            FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE);
        INSERT INTO tracks VALUES ('a','A'),('b','B'),('c','C');
        INSERT INTO playlists VALUES ('p1','One',NULL),('p2','Two',NULL);
        INSERT INTO playlist_tracks VALUES ('p1','c',0),('p1','a',5),('p1','b',5),('p2','a',3);
    """)
    conn.commit()
    conn.close()
    monkeypatch.setattr(nova_db, "DB_PATH", str(db))
    monkeypatch.setattr(nova_db, "_BACKUPS_DIR", str(tmp_path / "backups"))
    backup = nova_db.migrate_playlist_entries()
    assert backup and (tmp_path / "backups").exists()
    bconn = sqlite3.connect(backup)
    assert bconn.execute("SELECT COUNT(*) FROM playlist_tracks").fetchone()[0] == 4
    assert "entry_id" not in {r[1] for r in bconn.execute("PRAGMA table_info(playlist_tracks)")}
    bconn.close()
    assert nova_db.get_playlist_entries("p1") and [t for _, t in nova_db.get_playlist_entries("p1")] == ["c", "a", "b"]
    assert [t for _, t in nova_db.get_playlist_entries("p2")] == ["a"]
    assert nova_db.migrate_playlist_entries() is None                    # idempotent
    conn = sqlite3.connect(db)
    idx = {r[1] for r in conn.execute("PRAGMA index_list(playlist_tracks)")}
    assert "idx_playlist_tracks_pos" in idx
    fks = {(r[2], r[6]) for r in conn.execute("PRAGMA foreign_key_list(playlist_tracks)")}
    assert ("playlists", "CASCADE") in fks and ("tracks", "CASCADE") in fks
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("INSERT INTO playlist_tracks(entry_id, playlist_id, track_id, position) VALUES ('x','p1','a',9)")
    conn.execute("DELETE FROM tracks WHERE id='a'")                       # cascades every occurrence
    assert conn.execute("SELECT COUNT(*) FROM playlist_tracks WHERE track_id='a'").fetchone()[0] == 0
    conn.close()
