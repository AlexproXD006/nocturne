"""ListenBrainz: token storage, validation, queue with retry/backoff (HTTP mocked)."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from nocturne_api import listenbrainz as lb

TOKEN = "11111111-2222-3333-4444-555555555555"


def H(t):
    return {"Authorization": f"Bearer {t}"}


def _uid(username):
    from nocturne_api.db import connect
    with connect() as c:
        return c.execute("SELECT id FROM v1_accounts WHERE username=?", (username,)).fetchone()["id"]


@pytest.fixture
def net(monkeypatch):
    calls: list[httpx.Request] = []
    state = {"status": 200, "valid": True}

    def handler(req: httpx.Request):
        calls.append(req)
        if req.url.path.endswith("validate-token"):
            ok = state["valid"] and req.headers["authorization"] == f"Token {TOKEN}"
            return httpx.Response(200, json={"valid": ok, "user_name": "alice" if ok else None,
                                             "code": 200 if ok else 401})
        return httpx.Response(state["status"], json={"status": "ok" if state["status"] == 200 else "err",
                                                     "error": "boom"})
    monkeypatch.setattr(lb, "_transport", httpx.MockTransport(handler))
    return calls, state


@pytest.fixture(autouse=True)
def clean():
    from nocturne_api.db import connect
    with connect() as c:
        c.execute("DELETE FROM v1_listenbrainz"); c.execute("DELETE FROM v1_listenbrainz_queue")
    yield


async def _connect(client, tok):
    r = await client.put("/listenbrainz/connection", json={"token": TOKEN}, headers=H(tok))
    assert r.status_code == 200, r.text
    return r.json()


@pytest.mark.asyncio
async def test_connect_test_and_encrypted_storage(client, user_token, net):
    assert (await client.get("/listenbrainz/status", headers=H(user_token))).json()["connected"] is False
    r = await client.post("/listenbrainz/test", json={"token": "bad-token-xx"}, headers=H(user_token))
    assert r.json()["valid"] is False
    r = await client.put("/listenbrainz/connection", json={"token": "bad-token-xx"}, headers=H(user_token))
    assert r.status_code == 400
    st = await _connect(client, user_token)
    assert st["connected"] and st["enabled"] and st["userName"] == "alice"
    assert TOKEN not in json.dumps(st)
    row = lb.get_connection(_uid("testuser"))
    assert TOKEN not in row["token"] and row["token"].startswith(("f1:", "s1:"))
    r = await client.post("/listenbrainz/test", json={}, headers=H(user_token))
    assert r.json() == {"valid": True, "userName": "alice"}
    r = await client.patch("/listenbrainz/settings", json={"enabled": False, "nowPlaying": True}, headers=H(user_token))
    assert r.json()["enabled"] is False and r.json()["nowPlaying"] is True
    assert (await client.delete("/listenbrainz/connection", headers=H(user_token))).status_code == 204
    assert (await client.get("/listenbrainz/status", headers=H(user_token))).json()["connected"] is False


@pytest.mark.asyncio
async def test_play_enqueues_dedupes_and_submits(client, user_token, net):
    calls, _ = net
    await _connect(client, user_token)
    body = {"playedSeconds": 120, "at": "2026-01-02T10:00:00Z", "playId": "play-abc-123"}
    for _ in range(2):
        assert (await client.post("/tracks/track001/played", json=body, headers=H(user_token))).status_code == 204
    st = (await client.get("/listenbrainz/status", headers=H(user_token))).json()
    assert st["pending"] == 1
    res = await lb.process_queue()
    assert res["sent"] == 1
    sub = [c for c in calls if c.url.path.endswith("submit-listens")]
    assert len(sub) == 1
    d = json.loads(sub[0].content)
    assert d["listen_type"] == "single"
    p = d["payload"][0]
    assert p["listened_at"] == int(datetime(2026, 1, 2, 10, tzinfo=timezone.utc).timestamp())
    tm = p["track_metadata"]
    assert (tm["artist_name"], tm["track_name"], tm["release_name"]) == ("Test Artist", "Test Track", "Test Album")
    assert tm["additional_info"]["duration_ms"] == 180000
    assert sub[0].headers["authorization"] == f"Token {TOKEN}"
    assert (await client.get("/listenbrainz/status", headers=H(user_token))).json()["pending"] == 0


@pytest.mark.asyncio
async def test_disabled_not_queued(client, user_token, net):
    await _connect(client, user_token)
    await client.patch("/listenbrainz/settings", json={"enabled": False}, headers=H(user_token))
    await client.post("/tracks/track001/played", json={"playId": "play-off-0001"}, headers=H(user_token))
    assert (await client.get("/listenbrainz/status", headers=H(user_token))).json()["pending"] == 0


@pytest.mark.asyncio
async def test_retry_backoff_then_success(client, user_token, net):
    calls, state = net
    await _connect(client, user_token)
    await client.post("/tracks/track001/played", json={"playId": "play-retry-01"}, headers=H(user_token))
    state["status"] = 503
    now = datetime.now(timezone.utc) + timedelta(seconds=5)
    assert (await lb.process_queue(now=now))["retry"] == 1
    # not due yet
    assert await lb.process_queue(now=now) == {"sent": 0, "retry": 0, "dropped": 0}
    from nocturne_api.db import connect
    with connect() as c:
        r = c.execute("SELECT attempts, next_attempt_at FROM v1_listenbrainz_queue").fetchone()
    assert r["attempts"] == 1
    later = now + timedelta(seconds=lb.BACKOFF_BASE + 5)
    assert (await lb.process_queue(now=later))["retry"] == 1
    assert lb._backoff(2) == 2 * lb._backoff(1)
    assert lb._backoff(40) == timedelta(seconds=lb.BACKOFF_CAP)
    state["status"] = 200
    assert (await lb.process_queue(now=later + timedelta(hours=1)))["sent"] == 1


@pytest.mark.asyncio
async def test_401_disables_and_drops(client, user_token, net):
    _, state = net
    await _connect(client, user_token)
    await client.post("/tracks/track001/played", json={"playId": "play-401-001"}, headers=H(user_token))
    state["status"] = 401
    res = await lb.process_queue(now=datetime.now(timezone.utc) + timedelta(seconds=5))
    assert res["dropped"] == 1
    st = (await client.get("/listenbrainz/status", headers=H(user_token))).json()
    assert st["enabled"] is False and st["pending"] == 0 and st["lastError"]


@pytest.mark.asyncio
async def test_now_playing_optional(client, user_token, net):
    calls, _ = net
    await _connect(client, user_token)
    await client.post("/listenbrainz/now-playing", json={"trackId": "track001"}, headers=H(user_token))
    assert not [c for c in calls if c.url.path.endswith("submit-listens")]
    await client.patch("/listenbrainz/settings", json={"nowPlaying": True}, headers=H(user_token))
    await client.post("/listenbrainz/now-playing", json={"trackId": "track001"}, headers=H(user_token))
    sub = [c for c in calls if c.url.path.endswith("submit-listens")]
    assert json.loads(sub[0].content)["listen_type"] == "playing_now"
    assert "listened_at" not in json.loads(sub[0].content)["payload"][0]


@pytest.mark.asyncio
async def test_auth_required(client):
    assert (await client.get("/listenbrainz/status")).status_code == 401
