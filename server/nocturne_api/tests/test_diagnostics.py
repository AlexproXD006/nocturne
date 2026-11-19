"""Crash/diagnostic reports: auth, size limit, rate limit, scrubbing, admin list/delete."""
from __future__ import annotations

import json

import pytest

pytestmark = pytest.mark.asyncio


async def _user(client, username: str) -> dict:
    from nocturne_api.auth import create_account
    from nocturne_api.db import connect
    with connect() as conn:
        exists = conn.execute("SELECT id FROM v1_accounts WHERE username=?", (username,)).fetchone()
    if not exists:
        create_account(username, f"{username}-pass-12345", role="user")
    r = await client.post("/auth/login", json={"username": username, "password": f"{username}-pass-12345"})
    assert r.status_code == 200
    return {"Authorization": f"Bearer {r.json()['accessToken']}"}


REPORT = {"kind": "native", "version": "1.1.1-beta.10", "android": "Android 14 (API 34)", "device": "samsung SM-S918B", "at": 1_760_000_000_000,
          "trace": "java.lang.NullPointerException\n at X.y(X.java:1)\n GET https://h/a?token=SECRETVALUE&sig=abc"}


async def test_requires_auth(client):
    assert (await client.post("/diagnostics/crash", json=REPORT)).status_code == 401
    assert (await client.get("/admin/diagnostics")).status_code == 401


async def test_post_and_admin_roundtrip_scrubbed(client, admin_token, user_token):
    uh = {"Authorization": f"Bearer {user_token}"}
    ah = {"Authorization": f"Bearer {admin_token}"}
    r = await client.post("/diagnostics/crash", headers=uh, json=REPORT)
    assert r.status_code == 201, r.text
    rid = r.json()["id"]
    assert (await client.get("/admin/diagnostics", headers=uh)).status_code == 403
    lst = (await client.get("/admin/diagnostics", headers=ah)).json()["reports"]
    mine = next(x for x in lst if x["id"] == rid)
    assert mine["version"] == "1.1.1-beta.10" and mine["device"] == "samsung SM-S918B" and mine["kind"] == "native"
    assert "SECRETVALUE" not in mine["body"] and "NullPointerException" in mine["body"]
    assert mine["userId"] and mine["createdAt"]
    assert (await client.delete(f"/admin/diagnostics/{rid}", headers=uh)).status_code == 403
    assert (await client.delete(f"/admin/diagnostics/{rid}", headers=ah)).status_code == 204
    assert (await client.delete(f"/admin/diagnostics/{rid}", headers=ah)).status_code == 404


async def test_size_limit_and_validation(client):
    h = await _user(client, "diag_size")
    big = dict(REPORT, trace="x" * 70_000)
    r = await client.post("/diagnostics/crash", headers=h, content=json.dumps(big), )
    assert r.status_code == 413
    assert (await client.post("/diagnostics/crash", headers=h, content="not json")).status_code == 400
    assert (await client.post("/diagnostics/crash", headers=h, json=dict(REPORT, trace="  "))).status_code == 400
    assert (await client.post("/diagnostics/crash", headers=h, json=[1])).status_code == 400


async def test_rate_limited_per_user(client):
    h = await _user(client, "diag_rate")
    codes = [(await client.post("/diagnostics/crash", headers=h, json=REPORT)).status_code for _ in range(8)]
    assert codes[:6] == [201] * 6 and codes[6] == 429
    other = await _user(client, "diag_rate2")
    assert (await client.post("/diagnostics/crash", headers=other, json=REPORT)).status_code == 201


async def test_manual_log_report_and_clear_all(client, admin_token):
    h = await _user(client, "diag_manual")
    ah = {"Authorization": f"Bearer {admin_token}"}
    r = await client.post("/diagnostics/crash", headers=h, json={"source": "manual", "kind": "log", "version": "1", "log": "W/NocturneWidget: ok Authorization: Bearer abcdefghijkl"})
    assert r.status_code == 201
    got = (await client.get("/admin/diagnostics", headers=ah)).json()["reports"]
    row = next(x for x in got if x["id"] == r.json()["id"])
    assert row["source"] == "manual" and "abcdefghijkl" not in row["body"]
    assert (await client.delete("/admin/diagnostics", headers=ah)).status_code == 204
    assert (await client.get("/admin/diagnostics", headers=ah)).json()["reports"] == []
