"""Tests for /library/*, /tracks/*/liked, /tracks/*/played."""
from __future__ import annotations

import pytest
pytestmark = pytest.mark.asyncio


async def test_list_tracks(client, user_token):
    headers = {"Authorization": f"Bearer {user_token}"}
    # /library/tracks = liked songs; like two seeded tracks first
    await client.put("/library/tracks/track001", headers=headers)
    await client.put("/library/tracks/track002", headers=headers)

    r = await client.get("/library/tracks", headers=headers)
    assert r.status_code == 200
    d = r.json()
    assert "items" in d
    assert "total" in d
    assert d["total"] >= 2
    for t in d["items"]:
        assert "id" in t
        assert "title" in t
        assert "artists" in t
        assert "duration" in t
        assert t["liked"] is True
        assert isinstance(t["artwork"], list)


async def test_list_tracks_pagination(client, user_token):
    headers = {"Authorization": f"Bearer {user_token}"}
    await client.put("/library/tracks/track001", headers=headers)
    await client.put("/library/tracks/track002", headers=headers)

    r = await client.get("/library/tracks?limit=1&offset=0", headers=headers)
    assert r.status_code == 200
    d = r.json()
    assert len(d["items"]) == 1
    assert d["limit"] == 1


async def test_list_tracks_requires_auth(client):
    r = await client.get("/library/tracks")
    assert r.status_code == 401


async def test_get_track(client, user_token):
    r = await client.get("/library/tracks/track001", headers={"Authorization": f"Bearer {user_token}"})
    assert r.status_code == 200
    d = r.json()
    assert d["id"] == "track001"
    assert d["title"] == "Test Track"


async def test_get_track_not_found(client, user_token):
    r = await client.get("/library/tracks/nonexistent_id", headers={"Authorization": f"Bearer {user_token}"})
    assert r.status_code == 404


async def test_like_and_unlike(client, user_token):
    headers = {"Authorization": f"Bearer {user_token}"}

    # Ensure clean state (idempotent unlike)
    await client.delete("/library/tracks/track001", headers=headers)

    # Should not be liked now
    r = await client.get("/library/tracks/track001", headers=headers)
    assert r.json()["liked"] is False

    # Like it (spec path)
    r = await client.put("/library/tracks/track001", headers=headers)
    assert r.status_code == 204

    # Now liked
    r = await client.get("/library/tracks/track001", headers=headers)
    assert r.json()["liked"] is True

    # Unlike (spec path)
    r = await client.delete("/library/tracks/track001", headers=headers)
    assert r.status_code == 204

    # Back to not liked
    r = await client.get("/library/tracks/track001", headers=headers)
    assert r.json()["liked"] is False


async def test_liked_library(client, user_token):
    headers = {"Authorization": f"Bearer {user_token}"}

    await client.put("/tracks/track001/liked", headers=headers)
    r = await client.get("/library/liked", headers=headers)
    assert r.status_code == 200
    ids = [t["id"] for t in r.json()["items"]]
    assert "track001" in ids


async def test_mark_played(client, user_token):
    headers = {"Authorization": f"Bearer {user_token}"}
    r = await client.post("/tracks/track001/played", json={"seconds": 180}, headers=headers)
    assert r.status_code == 204


async def test_list_albums(client, user_token):
    r = await client.get("/library/albums", headers={"Authorization": f"Bearer {user_token}"})
    assert r.status_code == 200
    d = r.json()
    assert "items" in d
    for a in d["items"]:
        assert "id" in a
        assert "title" in a
        assert "artists" in a
        assert isinstance(a["artwork"], list)


async def test_list_artists(client, user_token):
    r = await client.get("/library/artists", headers={"Authorization": f"Bearer {user_token}"})
    assert r.status_code == 200
    d = r.json()
    assert "items" in d
    for a in d["items"]:
        assert "id" in a
        assert "name" in a


async def test_search(client, user_token):
    r = await client.get("/search?q=Test", headers={"Authorization": f"Bearer {user_token}"})
    assert r.status_code == 200
    d = r.json()
    assert "tracks" in d
    assert "albums" in d
    assert "artists" in d


async def test_home(client, user_token):
    r = await client.get("/home", headers={"Authorization": f"Bearer {user_token}"})
    assert r.status_code == 200
    d = r.json()
    assert "sections" in d
    for s in d["sections"]:
        assert "id" in s
        assert "title" in s
        assert "kind" in s
        assert "items" in s


# ---------------------------------------------------------------------------
# played: playId dedupe, client timestamp
# ---------------------------------------------------------------------------

def _plays(user_track="track001"):
    from nocturne_api.db import connect
    with connect() as c:
        return c.execute("SELECT * FROM v1_plays WHERE track_id=? ORDER BY id", (user_track,)).fetchall()


async def test_played_play_id_dedupes(client, user_token):
    headers = {"Authorization": f"Bearer {user_token}"}
    before = len([r for r in _plays() if r["play_id"] == "pid-dedupe-0001"])
    body = {"playedSeconds": 12, "playId": "pid-dedupe-0001"}
    assert (await client.post("/tracks/track001/played", json=body, headers=headers)).status_code == 204
    body2 = {"playedSeconds": 99, "playId": "pid-dedupe-0001"}
    assert (await client.post("/tracks/track001/played", json=body2, headers=headers)).status_code == 204
    rows = [r for r in _plays() if r["play_id"] == "pid-dedupe-0001"]
    assert before == 0 and len(rows) == 1 and rows[0]["seconds"] == 12


async def test_played_without_play_id_is_not_deduped(client, user_token):
    headers = {"Authorization": f"Bearer {user_token}"}
    n = len(_plays())
    for _ in range(2):
        assert (await client.post("/tracks/track001/played", json={"playedSeconds": 5}, headers=headers)).status_code == 204
    assert len(_plays()) == n + 2


async def test_played_rejects_bad_play_id_and_uses_at(client, user_token):
    headers = {"Authorization": f"Bearer {user_token}"}
    r = await client.post("/tracks/track001/played", json={"playId": "x y!"}, headers=headers)
    assert r.status_code in (400, 422)
    r = await client.post("/tracks/track001/played",
                          json={"playId": "pid-at-00001", "at": "2026-01-02T03:04:05Z"}, headers=headers)
    assert r.status_code == 204
    row = [x for x in _plays() if x["play_id"] == "pid-at-00001"][0]
    assert row["played_at"].startswith("2026-01-02T03:04:05")
    r = await client.post("/tracks/track001/played",
                          json={"playId": "pid-fut-0001", "at": "2999-01-01T00:00:00Z"}, headers=headers)
    row = [x for x in _plays() if x["play_id"] == "pid-fut-0001"][0]
    assert not row["played_at"].startswith("2999")
