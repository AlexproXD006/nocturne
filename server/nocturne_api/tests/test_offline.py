"""/tracks/{id}/offline-manifest and /offline/manifest: signed URLs only, per-entry misses, limits, auth."""
from __future__ import annotations

import os

import pytest

pytestmark = pytest.mark.asyncio


@pytest.fixture
def audio():
    import database as nova_db
    from nocturne_api import config
    path = os.path.join(config.MUSIC_ROOT, "offline_t.mp3")
    with open(path, "wb") as f:
        f.write(b"\x00" * 4096)
    conn = nova_db.connect()
    conn.execute("DELETE FROM tracks WHERE id='offtrack'")
    conn.execute("INSERT INTO tracks VALUES ('offtrack','Off','A','Al',10,?,NULL,'2026-01-01T00:00:00+00:00',NULL,NULL,NULL,NULL,0,NULL)", (path,))
    conn.commit()
    conn.close()
    yield "offtrack"
    conn = nova_db.connect()
    conn.execute("DELETE FROM tracks WHERE id='offtrack'")
    conn.commit()
    conn.close()
    os.unlink(path)


def auth(tok):
    return {"Authorization": f"Bearer {tok}"}


async def test_single_manifest(client, user_token, audio):
    r = await client.get(f"/tracks/{audio}/offline-manifest", headers=auth(user_token))
    assert r.status_code == 200
    d = r.json()
    assert d["trackId"] == audio
    assert d["sizeBytes"] == 4096
    assert d["track"]["id"] == audio and d["track"]["title"] == "Off"
    assert "/media/stream/offtrack" in d["stream"]["url"] and "sig=" in d["stream"]["url"] and "exp=" in d["stream"]["url"]
    assert d["stream"]["mimeType"] == "audio/mpeg"
    assert d["art"] is None  # no cover on this track
    assert "lyrics" in d


async def test_single_requires_auth_and_404(client, user_token):
    assert (await client.get("/tracks/track001/offline-manifest")).status_code == 401
    r = await client.get("/tracks/nope/offline-manifest", headers=auth(user_token))
    assert r.status_code == 404


async def test_batch_reports_missing_and_dedupes(client, user_token, audio):
    r = await client.post("/offline/manifest", json={"trackIds": [audio, "nope", audio]}, headers=auth(user_token))
    assert r.status_code == 200
    d = r.json()
    assert [i["trackId"] for i in d["items"]] == [audio]
    assert d["missing"] == ["nope"]


async def test_batch_limits_and_auth(client, user_token):
    assert (await client.post("/offline/manifest", json={"trackIds": ["a"]})).status_code == 401
    assert (await client.post("/offline/manifest", json={"trackIds": []}, headers=auth(user_token))).status_code == 400
    too_many = [f"t{i}" for i in range(51)]
    assert (await client.post("/offline/manifest", json={"trackIds": too_many}, headers=auth(user_token))).status_code == 400
