"""Tests for /connect/* — session registration, state, commands, RBAC."""
from __future__ import annotations

import pytest
pytestmark = pytest.mark.asyncio


async def _register(client, token, name="PC Chrome", platform="web", controllable=True):
    r = await client.post("/connect/sessions",
        json={"name": name, "platform": platform, "controllable": controllable},
        headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 201
    return r.json()


async def test_register_requires_auth(client):
    r = await client.post("/connect/sessions", json={"name": "x"})
    assert r.status_code == 401


async def test_register_and_list(client, user_token):
    s = await _register(client, user_token, name="My PC")
    assert s["id"].startswith("cs_")
    assert s["name"] == "My PC"
    assert s["controllable"] is True

    r = await client.get("/connect/sessions", headers={"Authorization": f"Bearer {user_token}"})
    assert r.status_code == 200
    ids = [x["id"] for x in r.json()["sessions"]]
    assert s["id"] in ids


async def test_sessions_are_per_user(client, user_token, admin_token):
    s = await _register(client, user_token, name="User device")
    # Admin must not see the user's session
    r = await client.get("/connect/sessions", headers={"Authorization": f"Bearer {admin_token}"})
    ids = [x["id"] for x in r.json()["sessions"]]
    assert s["id"] not in ids


async def test_update_state(client, user_token):
    s = await _register(client, user_token)
    r = await client.put(f"/connect/sessions/{s['id']}/state",
        json={"state": {"status": "playing", "position": 42, "shuffle": True}},
        headers={"Authorization": f"Bearer {user_token}"})
    assert r.status_code == 204

    r = await client.get("/connect/sessions", headers={"Authorization": f"Bearer {user_token}"})
    mine = next(x for x in r.json()["sessions"] if x["id"] == s["id"])
    assert mine["state"]["status"] == "playing"
    assert mine["state"]["position"] == 42


async def test_delete_session(client, user_token):
    s = await _register(client, user_token)
    r = await client.delete(f"/connect/sessions/{s['id']}", headers={"Authorization": f"Bearer {user_token}"})
    assert r.status_code == 204
    r = await client.get("/connect/sessions", headers={"Authorization": f"Bearer {user_token}"})
    ids = [x["id"] for x in r.json()["sessions"]]
    assert s["id"] not in ids


async def test_command_to_offline_session_409(client, user_token):
    s = await _register(client, user_token)
    # No SSE listener attached -> offline -> 409
    r = await client.post(f"/connect/sessions/{s['id']}/commands",
        json={"kind": "pause"},
        headers={"Authorization": f"Bearer {user_token}"})
    assert r.status_code == 409
    assert r.json()["code"] == "offline"


async def test_command_unknown_kind_400(client, user_token):
    s = await _register(client, user_token)
    r = await client.post(f"/connect/sessions/{s['id']}/commands",
        json={"kind": "selfdestruct"},
        headers={"Authorization": f"Bearer {user_token}"})
    assert r.status_code == 400


async def test_command_to_foreign_session_404(client, user_token, admin_token):
    s = await _register(client, user_token)
    # Admin tries to command the user's session
    r = await client.post(f"/connect/sessions/{s['id']}/commands",
        json={"kind": "pause"},
        headers={"Authorization": f"Bearer {admin_token}"})
    assert r.status_code == 404


async def test_command_blocked_for_non_controllable(client, user_token):
    s = await _register(client, user_token, controllable=False)
    r = await client.post(f"/connect/sessions/{s['id']}/commands",
        json={"kind": "pause"},
        headers={"Authorization": f"Bearer {user_token}"})
    # Non-controllable wins over offline check
    assert r.status_code == 409
    assert r.json()["code"] == "conflict"


async def test_connect_capability_advertised(client):
    r = await client.get("/info")
    assert r.json()["capabilities"]["connect"] is True


async def test_command_delivered_when_listener_present(client, user_token):
    """With a live listener queue registered (as the SSE handler does), a
    command POST reaches that queue and returns 202."""
    import asyncio
    from nocturne_api import routes_connect as rc

    s = await _register(client, user_token, name="PC to control")
    sid = s["id"]

    # Simulate the SSE handler registering its queue.
    q: asyncio.Queue = asyncio.Queue(maxsize=64)
    rc._listeners.setdefault(sid, set()).add(q)
    try:
        # Session should now read as online.
        r = await client.get("/connect/sessions", headers={"Authorization": f"Bearer {user_token}"})
        assert next(x for x in r.json()["sessions"] if x["id"] == sid)["online"] is True

        r = await client.post(f"/connect/sessions/{sid}/commands",
            json={"kind": "setShuffle", "payload": {"on": True}},
            headers={"Authorization": f"Bearer {user_token}"})
        assert r.status_code == 202

        event = q.get_nowait()
        assert event["type"] == "command"
        assert event["kind"] == "setShuffle"
        assert event["payload"]["on"] is True
    finally:
        rc._listeners.pop(sid, None)


async def test_state_update_pushed_to_listener(client, user_token):
    """A state PUT is broadcast to the session's live listeners (controllers)."""
    import asyncio
    from nocturne_api import routes_connect as rc

    s = await _register(client, user_token)
    sid = s["id"]
    q: asyncio.Queue = asyncio.Queue(maxsize=64)
    rc._listeners.setdefault(sid, set()).add(q)
    try:
        r = await client.put(f"/connect/sessions/{sid}/state",
            json={"state": {"status": "paused", "position": 7}},
            headers={"Authorization": f"Bearer {user_token}"})
        assert r.status_code == 204
        event = q.get_nowait()
        assert event["type"] == "state"
        assert event["state"]["status"] == "paused"
    finally:
        rc._listeners.pop(sid, None)


# ---------------------------------------------------------------------------
# Remote playback commands (playContext / addToQueue / playNext) + validation
# ---------------------------------------------------------------------------

def _listen(sid):
    import asyncio
    from nocturne_api import routes_connect as rc
    q: asyncio.Queue = asyncio.Queue(maxsize=64)
    rc._listeners.setdefault(sid, set()).add(q)
    return q


def _unlisten(*sids):
    from nocturne_api import routes_connect as rc
    for sid in sids:
        rc._listeners.pop(sid, None)


async def _cmd(client, token, sid, kind, payload=None):
    body = {"kind": kind}
    if payload is not None:
        body["payload"] = payload
    return await client.post(f"/connect/sessions/{sid}/commands", json=body,
                             headers={"Authorization": f"Bearer {token}"})


async def test_play_context_delivered(client, user_token):
    s = await _register(client, user_token)
    q = _listen(s["id"])
    try:
        payload = {"context": {"type": "album", "id": "al1", "name": "Album"},
                   "trackIds": ["t1", "t2", "t3"], "startIndex": 1, "shuffle": False}
        r = await _cmd(client, user_token, s["id"], "playContext", payload)
        assert r.status_code == 202
        event = q.get_nowait()
        assert event["kind"] == "playContext"
        assert event["payload"]["trackIds"] == ["t1", "t2", "t3"]
        assert event["payload"]["startIndex"] == 1
    finally:
        _unlisten(s["id"])


@pytest.mark.parametrize("kind", ["addToQueue", "playNext"])
async def test_queue_commands_delivered(client, user_token, kind):
    s = await _register(client, user_token)
    q = _listen(s["id"])
    try:
        r = await _cmd(client, user_token, s["id"], kind, {"trackIds": ["t9"]})
        assert r.status_code == 202
        assert q.get_nowait()["kind"] == kind
    finally:
        _unlisten(s["id"])


@pytest.mark.parametrize("kind,payload", [
    ("playContext", {"trackIds": [], "startIndex": 0}),
    ("playContext", {"trackIds": ["t1"], "startIndex": 3}),
    ("playContext", {"trackIds": ["t1"], "startIndex": True}),
    ("playContext", {"trackIds": [1, 2], "startIndex": 0}),
    ("playContext", {"trackIds": ["t1"], "startIndex": 0, "shuffle": "yes"}),
    ("playContext", {"trackIds": ["t1"], "startIndex": 0, "context": {"type": "bogus"}}),
    ("playContext", {"trackIds": ["t1"], "startIndex": 0, "context": {"type": "album", "id": 5}}),
    ("playContext", {"trackIds": ["x" * 129], "startIndex": 0}),
    ("playContext", {"trackIds": [f"t{i}" for i in range(5001)], "startIndex": 0}),
    ("addToQueue", {}),
    ("addToQueue", {"trackIds": "t1"}),
    ("playNext", {"trackIds": [""]}),
    ("setVolume", {"volume": 1.5}),
    ("setVolume", {"volume": True}),
    ("setVolume", {}),
    ("setVolume", {"muted": "no"}),
    ("seek", {"position": -1}),
    ("seek", {}),
    ("setShuffle", {"on": 1}),
    ("setRepeat", {"mode": "sometimes"}),
])
async def test_command_payload_validation(client, user_token, kind, payload):
    s = await _register(client, user_token)
    q = _listen(s["id"])
    try:
        r = await _cmd(client, user_token, s["id"], kind, payload)
        assert r.status_code == 400, r.text
        assert q.empty()
    finally:
        _unlisten(s["id"])


async def test_play_context_accepts_max_ids(client, user_token):
    s = await _register(client, user_token)
    q = _listen(s["id"])
    try:
        ids = [f"t{i}" for i in range(5000)]
        r = await _cmd(client, user_token, s["id"], "playContext", {"trackIds": ids, "startIndex": 4999})
        assert r.status_code == 202
        assert len(q.get_nowait()["payload"]["trackIds"]) == 5000
    finally:
        _unlisten(s["id"])


async def test_set_volume_with_muted(client, user_token):
    s = await _register(client, user_token)
    q = _listen(s["id"])
    try:
        r = await _cmd(client, user_token, s["id"], "setVolume", {"muted": True})
        assert r.status_code == 202
        assert q.get_nowait()["payload"] == {"muted": True}
    finally:
        _unlisten(s["id"])


async def test_state_update_broadcast_to_other_sessions(client, user_token, admin_token):
    """A controller (another session of the same user) gets the state with the sessionId;
    other users' sessions never do."""
    pc = await _register(client, user_token, name="PC")
    phone = await _register(client, user_token, name="Phone", platform="android")
    foreign = await _register(client, admin_token, name="Admin")
    qp = _listen(phone["id"])
    qf = _listen(foreign["id"])
    try:
        r = await client.put(f"/connect/sessions/{pc['id']}/state",
            json={"state": {"status": "playing", "volume": 0.4, "muted": False}},
            headers={"Authorization": f"Bearer {user_token}"})
        assert r.status_code == 204
        event = qp.get_nowait()
        assert event["type"] == "state"
        assert event["sessionId"] == pc["id"]
        assert event["state"]["volume"] == 0.4
        assert qf.empty()
    finally:
        _unlisten(phone["id"], foreign["id"])


async def test_rename_session(client, user_token, admin_token):
    s = await _register(client, user_token, name="Old")
    h = {"Authorization": f"Bearer {user_token}"}
    r = await client.patch(f"/connect/sessions/{s['id']}", json={"name": "  Living room PC  "}, headers=h)
    assert r.status_code == 204
    r = await client.get("/connect/sessions", headers=h)
    assert next(x for x in r.json()["sessions"] if x["id"] == s["id"])["name"] == "Living room PC"
    r = await client.patch(f"/connect/sessions/{s['id']}", json={"name": "   "}, headers=h)
    assert r.status_code == 400
    r = await client.patch(f"/connect/sessions/{s['id']}", json={"name": "x"},
                           headers={"Authorization": f"Bearer {admin_token}"})
    assert r.status_code == 404
