"""
Pytest fixtures for nocturne_api tests.
Uses httpx.AsyncClient with the ASGI transport (no real network).
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest

# Set up test env BEFORE importing config (which reads env at import time)
_music_tmpdir = tempfile.mkdtemp(prefix="nocturne_test_music_")
_data_tmpdir  = tempfile.mkdtemp(prefix="nocturne_test_data_")

os.environ["NOCTURNE_TESTING"]    = "1"
os.environ["NOCTURNE_JWT_SECRET"] = "test-jwt-secret-must-be-32-bytes-long!!!!"
os.environ["NOCTURNE_MEDIA_SECRET"] = "test-med-secret-must-be-32bytes-long!!!!"
os.environ["NOCTURNE_PUBLIC_URL"] = "http://testserver"
os.environ["NOCTURNE_DB_PATH"]    = str(Path(_data_tmpdir) / "test_nocturne.db")
os.environ["NOCTURNE_WEB_DIR"]    = "/nonexistent_web_dir"
os.environ["NOCTURNE_DATA_DIR"]   = _data_tmpdir
os.environ["MUSIC_DIR"]           = _music_tmpdir
# No GitHub Releases lookups in tests (tests that need them mock HTTP).
os.environ["NOCTURNE_RELEASES_REPO"] = ""
# Avoid reading real NOVA DB
os.environ["NOCTURNE_CORS_ORIGINS"] = "http://testserver"

_SERVER_ROOT = Path(__file__).resolve().parents[2]  # <repo>/server
sys.path.insert(0, str(_SERVER_ROOT / "backend"))
sys.path.insert(0, str(_SERVER_ROOT))

# Seed a fake NOVA database in the temp music dir
_FAKE_DB = str(Path(_music_tmpdir) / "library.db")
os.environ["_NOVA_TEST_DB"] = _FAKE_DB

import sqlite3 as _sqlite3

def _create_fake_nova_db():
    conn = _sqlite3.connect(_FAKE_DB)
    conn.row_factory = _sqlite3.Row
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS tracks (
            id TEXT PRIMARY KEY,
            title TEXT,
            artist TEXT,
            album TEXT,
            duration INTEGER,
            file_path TEXT,
            cover_path TEXT,
            added_at TEXT,
            mood TEXT,
            bpm REAL,
            energy REAL,
            valence REAL,
            play_count INTEGER DEFAULT 0,
            last_played TEXT
        );
        CREATE TABLE IF NOT EXISTS playlists (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at TEXT
        );
        CREATE TABLE IF NOT EXISTS playlist_tracks (
            playlist_id TEXT,
            track_id TEXT,
            position INTEGER,
            PRIMARY KEY (playlist_id, track_id)
        );
        INSERT OR IGNORE INTO tracks VALUES
            ('track001','Test Track','Test Artist','Test Album',180,'/tmp/t1.mp3',NULL,
             '2026-01-01T00:00:00+00:00',NULL,NULL,NULL,NULL,0,NULL),
            ('track002','Another Track','Other Artist','Other Album',200,'/tmp/t2.mp3',NULL,
             '2026-01-02T00:00:00+00:00',NULL,NULL,NULL,NULL,5,'2026-01-02T00:00:00+00:00');
    """)
    conn.commit()
    conn.close()

_create_fake_nova_db()

# Monkey-patch database module to use test DB
import database as _nova_db
_nova_db.DB_PATH = _FAKE_DB
# The fake DB starts with the legacy playlist_tracks schema; run NOVA's startup
# migration (entry ids, repeats allowed) exactly as production does.
_nova_db.migrate_playlist_entries()


@pytest.fixture(autouse=True)
def reset_rate_limiter():
    """Clear in-process rate limit windows before each test."""
    from nocturne_api import ratelimit
    ratelimit._windows.clear()
    yield
    ratelimit._windows.clear()


@pytest.fixture(scope="session")
def app():
    from nocturne_api.db import migrate
    migrate()
    from nocturne_api.app import v1_app
    return v1_app


@pytest.fixture
async def client(app):
    from httpx import AsyncClient, ASGITransport
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://testserver",
    ) as c:
        yield c


@pytest.fixture
async def admin_token(client):
    """Create an admin account and return a valid access token."""
    from nocturne_api.auth import create_account, total_account_count
    from nocturne_api.db import connect

    # Create admin if not exists
    with connect() as conn:
        exists = conn.execute(
            "SELECT id FROM v1_accounts WHERE username='testadmin'"
        ).fetchone()
    if not exists:
        create_account("testadmin", "testadmin12345!", role="admin")

    resp = await client.post("/auth/login", json={
        "username": "testadmin",
        "password": "testadmin12345!",
    })
    assert resp.status_code == 200
    return resp.json()["accessToken"]


@pytest.fixture
async def user_token(client):
    """Create a regular user account and return a valid access token."""
    from nocturne_api.auth import create_account
    from nocturne_api.db import connect

    with connect() as conn:
        exists = conn.execute(
            "SELECT id FROM v1_accounts WHERE username='testuser'"
        ).fetchone()
    if not exists:
        create_account("testuser", "testuser12345!", role="user")

    resp = await client.post("/auth/login", json={
        "username": "testuser",
        "password": "testuser12345!",
    })
    assert resp.status_code == 200
    return resp.json()["accessToken"]
