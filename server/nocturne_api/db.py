"""
Nocturne-specific SQLite database — additive tables only.
Never modifies NOVA's existing tables.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path
from threading import Lock

from . import config

_lock = Lock()


def connect() -> sqlite3.Connection:
    Path(config.DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(config.DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


# ---------------------------------------------------------------------------
# Additive migrations
# ---------------------------------------------------------------------------

_MIGRATIONS: list[tuple[int, str]] = [
    (1, """
        CREATE TABLE IF NOT EXISTS v1_schema_version (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS v1_accounts (
            id                  TEXT PRIMARY KEY,
            username            TEXT UNIQUE COLLATE NOCASE,
            display_name        TEXT,
            password_hash       TEXT,
            role                TEXT NOT NULL DEFAULT 'user'
                                    CHECK(role IN ('admin','user')),
            disabled            INTEGER NOT NULL DEFAULT 0,
            created_at          TEXT,
            last_login_at       TEXT,
            password_changed_at TEXT,
            nova_user_id        TEXT
        );

        CREATE TABLE IF NOT EXISTS v1_token_families (
            id              TEXT PRIMARY KEY,
            user_id         TEXT NOT NULL,
            created_at      TEXT NOT NULL,
            revoked_at      TEXT,
            revoked_reason  TEXT
        );

        CREATE TABLE IF NOT EXISTS v1_refresh_tokens (
            id          TEXT PRIMARY KEY,
            family_id   TEXT NOT NULL,
            user_id     TEXT NOT NULL,
            token_hash  TEXT UNIQUE NOT NULL,
            created_at  TEXT NOT NULL,
            expires_at  TEXT NOT NULL,
            used_at     TEXT,
            revoked_at  TEXT
        );

        CREATE TABLE IF NOT EXISTS v1_login_attempts (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            username    TEXT NOT NULL COLLATE NOCASE,
            ip          TEXT NOT NULL,
            at          TEXT NOT NULL,
            success     INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_at
            ON v1_login_attempts(ip, at);
        CREATE INDEX IF NOT EXISTS idx_login_attempts_user_ip_at
            ON v1_login_attempts(username, ip, at);

        CREATE TABLE IF NOT EXISTS v1_likes (
            user_id     TEXT NOT NULL,
            track_id    TEXT NOT NULL,
            liked_at    TEXT NOT NULL,
            PRIMARY KEY (user_id, track_id)
        );
        CREATE INDEX IF NOT EXISTS idx_v1_likes_user ON v1_likes(user_id, liked_at);

        CREATE TABLE IF NOT EXISTS v1_plays (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     TEXT NOT NULL,
            track_id    TEXT NOT NULL,
            played_at   TEXT NOT NULL,
            seconds     REAL NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_v1_plays_user_track
            ON v1_plays(user_id, track_id, played_at);

        CREATE TABLE IF NOT EXISTS v1_entities (
            id          TEXT PRIMARY KEY,
            kind        TEXT NOT NULL,
            name        TEXT NOT NULL,
            artist_key  TEXT
        );

        CREATE TABLE IF NOT EXISTS v1_track_artists (
            track_id    TEXT NOT NULL,
            artist_id   TEXT NOT NULL,
            PRIMARY KEY (track_id, artist_id)
        );
        CREATE INDEX IF NOT EXISTS idx_v1_ta_artist ON v1_track_artists(artist_id);

        CREATE TABLE IF NOT EXISTS v1_artist_exceptions (
            name TEXT PRIMARY KEY
        );

        CREATE TABLE IF NOT EXISTS v1_lyrics (
            track_id    TEXT PRIMARY KEY,
            format      TEXT NOT NULL CHECK(format IN ('ttml','lrc')),
            content     TEXT NOT NULL,
            updated_at  TEXT NOT NULL,
            updated_by  TEXT
        );

        CREATE TABLE IF NOT EXISTS v1_jobs (
            id          TEXT PRIMARY KEY,
            kind        TEXT NOT NULL,
            source      TEXT,
            title       TEXT NOT NULL DEFAULT '',
            nova_job_id TEXT,
            status      TEXT NOT NULL DEFAULT 'queued',
            progress    REAL,
            message     TEXT,
            error       TEXT,
            track_ids   TEXT NOT NULL DEFAULT '[]',
            created_at  TEXT NOT NULL,
            finished_at TEXT,
            created_by  TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_v1_jobs_created ON v1_jobs(created_at DESC);

        CREATE TABLE IF NOT EXISTS v1_source_cache (
            id          TEXT PRIMARY KEY,
            payload     TEXT NOT NULL,
            expires_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS v1_audit (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            at          TEXT NOT NULL,
            actor_id    TEXT,
            action      TEXT NOT NULL,
            target      TEXT,
            ip          TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_v1_audit_at ON v1_audit(at DESC);
    """),
    (2, """
        -- Migration guard: add last_login_at if missing (upgrade from is_admin schema)
        SELECT 1;
    """),
    (3, """
        -- Nocturne Connect: remote playback control between a user's devices.
        CREATE TABLE IF NOT EXISTS v1_connect_sessions (
            id           TEXT PRIMARY KEY,
            user_id      TEXT NOT NULL,
            name         TEXT NOT NULL,
            platform     TEXT NOT NULL DEFAULT 'web',
            controllable INTEGER NOT NULL DEFAULT 1,
            state        TEXT NOT NULL DEFAULT '{}',
            last_seen    TEXT NOT NULL,
            created_at   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_v1_connect_user ON v1_connect_sessions(user_id);
    """),
]


def migrate() -> None:
    """Run all pending additive migrations. Idempotent."""
    with _lock:
        conn = connect()
        try:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS v1_schema_version (
                    version INTEGER PRIMARY KEY,
                    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
                )
            """)
            conn.commit()

            applied = {r[0] for r in conn.execute("SELECT version FROM v1_schema_version")}

            for version, sql in _MIGRATIONS:
                if version in applied:
                    continue
                conn.executescript(sql)
                conn.execute(
                    "INSERT OR IGNORE INTO v1_schema_version(version) VALUES (?)",
                    (version,),
                )
                conn.commit()

            # Handle upgrade from an older schema that had is_admin
            cols = {r[1] for r in conn.execute("PRAGMA table_info(v1_accounts)")}
            if cols and "is_admin" in cols:
                if "role" not in cols:
                    conn.execute(
                        "ALTER TABLE v1_accounts ADD COLUMN role TEXT NOT NULL DEFAULT 'user'"
                    )
                if "last_login_at" not in cols:
                    conn.execute(
                        "ALTER TABLE v1_accounts ADD COLUMN last_login_at TEXT"
                    )
                conn.execute(
                    "UPDATE v1_accounts SET role='admin' WHERE is_admin=1 AND role='user'"
                )
                conn.commit()
        finally:
            conn.close()
