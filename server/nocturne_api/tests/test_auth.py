"""Tests for /auth/login, /auth/refresh, /auth/logout."""
from __future__ import annotations

import pytest
pytestmark = pytest.mark.asyncio


async def test_info_no_auth(client):
    r = await client.get("/info")
    assert r.status_code == 200
    d = r.json()
    assert d["apiVersion"] == 1
    assert "capabilities" in d


async def test_login_success(client):
    from nocturne_api.auth import create_account
    from nocturne_api.db import connect
    with connect() as conn:
        exists = conn.execute("SELECT id FROM v1_accounts WHERE username='logintest'").fetchone()
    if not exists:
        create_account("logintest", "logintest12345!", role="user")

    r = await client.post("/auth/login", json={"username": "logintest", "password": "logintest12345!"})
    assert r.status_code == 200
    d = r.json()
    assert "accessToken" in d
    assert "refreshToken" in d
    assert d["expiresIn"] > 0
    assert d["user"]["username"] == "logintest"
    assert d["user"]["role"] == "user"


async def test_login_wrong_password(client):
    from nocturne_api.auth import create_account
    from nocturne_api.db import connect
    with connect() as conn:
        exists = conn.execute("SELECT id FROM v1_accounts WHERE username='badlogintest'").fetchone()
    if not exists:
        create_account("badlogintest", "correctpassword!", role="user")

    r = await client.post("/auth/login", json={"username": "badlogintest", "password": "wrongpassword"})
    assert r.status_code == 401


async def test_login_unknown_user(client):
    r = await client.post("/auth/login", json={"username": "doesnotexist", "password": "anything"})
    assert r.status_code == 401
    # Must not reveal whether user exists
    assert r.json()["message"] == "Invalid username or password."


async def test_login_missing_body(client):
    r = await client.post("/auth/login", json={})
    assert r.status_code == 400


async def test_refresh_rotation(client):
    from nocturne_api.auth import create_account
    from nocturne_api.db import connect
    with connect() as conn:
        exists = conn.execute("SELECT id FROM v1_accounts WHERE username='refreshtest'").fetchone()
    if not exists:
        create_account("refreshtest", "refreshtest12345!", role="user")

    login = await client.post("/auth/login", json={"username": "refreshtest", "password": "refreshtest12345!"})
    assert login.status_code == 200
    old_refresh = login.json()["refreshToken"]

    refresh = await client.post("/auth/refresh", json={"refreshToken": old_refresh})
    assert refresh.status_code == 200
    d = refresh.json()
    assert "accessToken" in d
    # New refresh token should be different
    assert d["refreshToken"] != old_refresh


async def test_refresh_reuse_detection(client):
    from nocturne_api.auth import create_account
    from nocturne_api.db import connect
    with connect() as conn:
        exists = conn.execute("SELECT id FROM v1_accounts WHERE username='reusetest'").fetchone()
    if not exists:
        create_account("reusetest", "reusetest12345!", role="user")

    login = await client.post("/auth/login", json={"username": "reusetest", "password": "reusetest12345!"})
    old_refresh = login.json()["refreshToken"]

    # First use — OK
    r1 = await client.post("/auth/refresh", json={"refreshToken": old_refresh})
    assert r1.status_code == 200

    # Second use of the same (now rotated) token — reuse detection
    r2 = await client.post("/auth/refresh", json={"refreshToken": old_refresh})
    assert r2.status_code == 401
    # Even the new token from r1 should now be revoked
    new_refresh = r1.json()["refreshToken"]
    r3 = await client.post("/auth/refresh", json={"refreshToken": new_refresh})
    assert r3.status_code == 401


async def test_logout(client):
    from nocturne_api.auth import create_account
    from nocturne_api.db import connect
    with connect() as conn:
        exists = conn.execute("SELECT id FROM v1_accounts WHERE username='logouttest'").fetchone()
    if not exists:
        create_account("logouttest", "logouttest12345!", role="user")

    login = await client.post("/auth/login", json={"username": "logouttest", "password": "logouttest12345!"})
    token = login.json()["accessToken"]
    refresh = login.json()["refreshToken"]

    r = await client.post("/auth/logout", json={"refreshToken": refresh},
                          headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 204

    # After logout, the refresh token should be invalid
    r2 = await client.post("/auth/refresh", json={"refreshToken": refresh})
    assert r2.status_code == 401


async def test_bearer_required(client):
    r = await client.get("/users/me")
    assert r.status_code == 401
    assert "WWW-Authenticate" in r.headers


async def test_error_format(client):
    r = await client.get("/users/me")
    d = r.json()
    assert "message" in d
    assert "code" in d


async def test_disabled_account_blocked(client):
    from nocturne_api.auth import create_account
    from nocturne_api.db import connect
    with connect() as conn:
        exists = conn.execute("SELECT id FROM v1_accounts WHERE username='disabledtest'").fetchone()
        if not exists:
            uid = create_account("disabledtest", "disabledtest12345!", role="user")
        else:
            uid = exists["id"]
        conn.execute("UPDATE v1_accounts SET disabled=1 WHERE id=?", (uid,))

    r = await client.post("/auth/login", json={"username": "disabledtest", "password": "disabledtest12345!"})
    assert r.status_code == 403


async def test_admin_role_included_in_session(client):
    from nocturne_api.auth import create_account
    from nocturne_api.db import connect
    with connect() as conn:
        exists = conn.execute("SELECT id FROM v1_accounts WHERE username='adminroletest'").fetchone()
    if not exists:
        create_account("adminroletest", "adminroletest12345!", role="admin")

    r = await client.post("/auth/login", json={"username": "adminroletest", "password": "adminroletest12345!"})
    assert r.status_code == 200
    assert r.json()["user"]["role"] == "admin"
