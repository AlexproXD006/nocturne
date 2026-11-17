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
