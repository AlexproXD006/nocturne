"""Tests for /admin/* — RBAC, user management, stats."""
from __future__ import annotations

import pytest
pytestmark = pytest.mark.asyncio


async def test_admin_stats_requires_admin(client, user_token):
    r = await client.get("/admin/stats", headers={"Authorization": f"Bearer {user_token}"})
    assert r.status_code == 403


async def test_admin_stats(client, admin_token):
    r = await client.get("/admin/stats", headers={"Authorization": f"Bearer {admin_token}"})
    assert r.status_code == 200
    d = r.json()
    assert "tracks" in d
    assert "albums" in d
    assert "artists" in d
    assert "users" in d
    assert "storageBytes" in d
    assert "plays" in d
    assert "activeJobs" in d


async def test_admin_list_users(client, admin_token):
    r = await client.get("/admin/users", headers={"Authorization": f"Bearer {admin_token}"})
    assert r.status_code == 200
    d = r.json()
    assert "users" in d
    assert len(d["users"]) >= 1


async def test_admin_create_user(client, admin_token):
    r = await client.post("/admin/users",
        json={"username": "newuser99", "password": "newuser12345!", "role": "user"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r.status_code == 201
    d = r.json()
    assert d["username"] == "newuser99"
    assert d["role"] == "user"


async def test_admin_create_user_duplicate(client, admin_token):
    # Create once
    await client.post("/admin/users",
        json={"username": "dupuser99", "password": "dupuser12345!", "role": "user"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    # Create again — should be 409
    r = await client.post("/admin/users",
        json={"username": "dupuser99", "password": "dupuser12345!", "role": "user"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r.status_code == 409


async def test_admin_create_user_weak_password(client, admin_token):
    r = await client.post("/admin/users",
        json={"username": "weakpw99", "password": "short", "role": "user"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r.status_code == 400


async def test_admin_update_user(client, admin_token):
    # Create a user to update
    create = await client.post("/admin/users",
        json={"username": "updateme99", "password": "updateme12345!", "role": "user"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    user_id = create.json()["id"]

    r = await client.patch(f"/admin/users/{user_id}",
        json={"displayName": "Updated Name"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r.status_code == 200
    assert r.json()["displayName"] == "Updated Name"


async def test_admin_delete_user(client, admin_token):
    # Create a disposable user
    create = await client.post("/admin/users",
        json={"username": "deleteme99", "password": "deleteme12345!", "role": "user"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    user_id = create.json()["id"]

    r = await client.delete(f"/admin/users/{user_id}",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r.status_code == 204


async def test_admin_cannot_delete_self(client, admin_token):
    # Get the current admin's id
    me = await client.get("/users/me", headers={"Authorization": f"Bearer {admin_token}"})
    my_id = me.json()["id"]

    r = await client.delete(f"/admin/users/{my_id}",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r.status_code == 409


async def test_admin_last_admin_protection(client, admin_token):
    # Try to demote the only admin to user (conflict)
    me = await client.get("/users/me", headers={"Authorization": f"Bearer {admin_token}"})
    my_id = me.json()["id"]

    r = await client.patch(f"/admin/users/{my_id}",
        json={"role": "user"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r.status_code == 409


async def test_admin_library_tracks(client, admin_token):
    r = await client.get("/admin/tracks", headers={"Authorization": f"Bearer {admin_token}"})
    assert r.status_code == 200
    d = r.json()
    assert "items" in d


async def test_non_admin_cannot_access_admin_routes(client, user_token):
    for path in ["/admin/stats", "/admin/users", "/admin/tracks", "/admin/jobs"]:
        r = await client.get(path, headers={"Authorization": f"Bearer {user_token}"})
        assert r.status_code == 403, f"Expected 403 for {path}, got {r.status_code}"
