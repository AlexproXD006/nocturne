"""
SQLite database module for the music server library.
"""

import hashlib
import os
import sqlite3
import uuid
import shutil
from datetime import datetime, timezone
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

_MUSIC_DIR = os.getenv("MUSIC_DIR", "./music")
DB_PATH = str(Path(_MUSIC_DIR) / "library.db")
_COVERS_DIR = str(Path(_MUSIC_DIR) / ".covers")
_BACKUPS_DIR = str(Path(_MUSIC_DIR) / ".backups")
MAX_BACKUPS = 10


def connect() -> sqlite3.Connection:
    """Return a new sqlite3 connection with row_factory set to Row."""
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _ensure_cover_storage() -> None:
    Path(_COVERS_DIR).mkdir(parents=True, exist_ok=True)


def _ensure_backup_storage() -> None:
    Path(_BACKUPS_DIR).mkdir(parents=True, exist_ok=True)


def _get_cover_path_from_id(track_id: str) -> str:
    _ensure_cover_storage()
    return str(Path(_COVERS_DIR) / f"{track_id}.cover")


def _compute_cover_hash(track_id: str) -> str:
    return hashlib.sha256(track_id.encode()).hexdigest()


def _save_cover_from_path(source_path: str, track_id: str) -> str | None:
    """Copy a cover image to .covers directory using track_id hash."""
    if not source_path or not Path(source_path).exists():
        return None
    dest_path = _get_cover_path_from_id(track_id)
    try:
        shutil.copy2(source_path, dest_path)
        return dest_path
    except Exception:
        return None


def _save_cover_from_url(url: str, track_id: str) -> str | None:
    """Download cover from URL and save to .covers directory."""
    import requests
    dest_path = _get_cover_path_from_id(track_id)
    try:
        response = requests.get(url, timeout=10)
        if response.status_code == 200:
            content = response.content
            if len(content) > 0:
                with open(dest_path, "wb") as f:
                    f.write(content)
                return dest_path
    except Exception:
        pass
    return None


def _migrate_tracks_table() -> None:
    """Add missing columns to tracks table if they don't exist."""
    with connect() as conn:
        existing = {row[1] for row in conn.execute("PRAGMA table_info(tracks)").fetchall()}
        for col, col_type in [
            ("mood", "TEXT"),
            ("bpm", "REAL"),
            ("energy", "REAL"),
            ("valence", "REAL"),
            ("play_count", "INTEGER DEFAULT 0"),
            ("last_played", "TEXT"),
        ]:
            if col not in existing:
                try:
                    conn.execute(f"ALTER TABLE tracks ADD COLUMN {col} {col_type}")
                except Exception:
                    pass


def init_db() -> None:
    """Create tables if they do not already exist."""
    _migrate_tracks_table()
    with connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS tracks (
                id          TEXT PRIMARY KEY,
                title       TEXT,
                artist      TEXT,
                album       TEXT,
                duration    INTEGER,
                file_path   TEXT,
                cover_path  TEXT,
                added_at    TEXT,
                mood        TEXT,
                bpm         REAL,
                energy      REAL,
                valence     REAL,
                play_count  INTEGER DEFAULT 0,
                last_played TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
            CREATE INDEX IF NOT EXISTS idx_tracks_title  ON tracks(title);
            CREATE INDEX IF NOT EXISTS idx_tracks_mood   ON tracks(mood);
            CREATE INDEX IF NOT EXISTS idx_tracks_added  ON tracks(added_at);
            CREATE INDEX IF NOT EXISTS idx_tracks_played ON tracks(last_played);

            CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
                title, artist, album,
                content='tracks',
                content_rowid='rowid'
            );
            CREATE TRIGGER IF NOT EXISTS tracks_ai AFTER INSERT ON tracks BEGIN
                INSERT INTO tracks_fts(rowid, title, artist, album)
                VALUES (new.rowid, new.title, new.artist, new.album);
            END;
            CREATE TRIGGER IF NOT EXISTS tracks_ad AFTER DELETE ON tracks BEGIN
                INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album)
                VALUES ('delete', old.rowid, old.title, old.artist, old.album);
            END;
            CREATE TRIGGER IF NOT EXISTS tracks_au AFTER UPDATE ON tracks BEGIN
                INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album)
                VALUES ('delete', old.rowid, old.title, old.artist, old.album);
                INSERT INTO tracks_fts(rowid, title, artist, album)
                VALUES (new.rowid, new.title, new.artist, new.album);
            END;

            CREATE TABLE IF NOT EXISTS smart_playlists (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                rules       TEXT NOT NULL,
                limit_count INTEGER DEFAULT 50,
                created_at  TEXT
            );

            CREATE TABLE IF NOT EXISTS playlists (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                created_at  TEXT
            );

            CREATE TABLE IF NOT EXISTS playlist_tracks (
                playlist_id TEXT NOT NULL,
                track_id    TEXT NOT NULL,
                position    INTEGER DEFAULT 0,
                PRIMARY KEY (playlist_id, track_id),
                FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
                FOREIGN KEY (track_id)    REFERENCES tracks(id)    ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS users (
                id           TEXT PRIMARY KEY,
                username     TEXT UNIQUE NOT NULL,
                display_name TEXT,
                avatar_url   TEXT,
                bio          TEXT,
                created_at   TEXT
            );

            CREATE TABLE IF NOT EXISTS follows (
                follower_id  TEXT NOT NULL,
                following_id TEXT NOT NULL,
                created_at   TEXT,
                PRIMARY KEY (follower_id, following_id),
                FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (following_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS activities (
                id           TEXT PRIMARY KEY,
                user_id      TEXT NOT NULL,
                action_type  TEXT NOT NULL,
                track_id     TEXT,
                playlist_id  TEXT,
                created_at   TEXT,
                metadata_json TEXT,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE SET NULL,
                FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS playlist_collaborators (
                playlist_id TEXT NOT NULL,
                user_id     TEXT NOT NULL,
                role        TEXT DEFAULT 'editor',
                invited_at   TEXT,
                PRIMARY KEY (playlist_id, user_id),
                FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS listening_sessions (
                user_id    TEXT NOT NULL,
                track_id   TEXT NOT NULL,
                started_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                PRIMARY KEY (user_id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS share_links (
                code        TEXT PRIMARY KEY,
                user_id     TEXT,
                playlist_id TEXT,
                track_id    TEXT,
                created_at  TEXT,
                expires_at  TEXT,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
                FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE SET NULL,
                FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE SET NULL
            );
            """
        )


def _row_to_dict(row) -> dict:
    if row is None:
        return None
    return dict(row)


def _backup_before_write() -> str | None:
    """Create a backup of the database before write operations."""
    _ensure_backup_storage()
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    backup_id = f"backup_{timestamp}"
    backup_path = str(Path(_BACKUPS_DIR) / f"{backup_id}.db")

    try:
        src_conn = sqlite3.connect(DB_PATH)
        dst_conn = sqlite3.connect(backup_path)
        src_conn.backup(dst_conn)
        src_conn.close()
        dst_conn.close()

        _trim_backups()
        return backup_id
    except Exception:
        return None


def _trim_backups() -> None:
    """Keep only the last MAX_BACKUPS backups."""
    backups = sorted(Path(_BACKUPS_DIR).glob("backup_*.db"), key=lambda p: p.stat().st_mtime)
    while len(backups) > MAX_BACKUPS:
        old = backups.pop(0)
        try:
            old.unlink()
        except OSError:
            pass


def list_backups() -> list[dict]:
    """List all available backups with metadata."""
    _ensure_backup_storage()
    backups = []
    for bp in sorted(Path(_BACKUPS_DIR).glob("backup_*.db"), key=lambda p: p.stat().st_mtime, reverse=True):
        stat = bp.stat()
        backup_id = bp.stem
        backups.append({
            "id": backup_id,
            "filename": bp.name,
            "size_bytes": stat.st_size,
            "created_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
        })
    return backups


def restore_backup(backup_id: str) -> bool:
    """Restore database from a backup."""
    backup_path = Path(_BACKUPS_DIR) / f"{backup_id}.db"
    if not backup_path.exists():
        return False

    _backup_before_write()

    try:
        src_conn = sqlite3.connect(str(backup_path))
        dst_conn = sqlite3.connect(DB_PATH)
        src_conn.backup(dst_conn)
        src_conn.close()
        dst_conn.close()
        return True
    except Exception:
        return False


def get_all_tracks() -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM tracks ORDER BY artist, album, title"
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def get_track(track_id: str) -> dict | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM tracks WHERE id = ?", (track_id,)
        ).fetchone()
    return _row_to_dict(row)


def search_tracks(query: str) -> list[dict]:
    pattern = f"%{query}%"
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT * FROM tracks
            WHERE title  LIKE ?
               OR artist LIKE ?
               OR album  LIKE ?
            ORDER BY artist, album, title
            """,
            (pattern, pattern, pattern),
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def search_tracks_fts(query: str) -> list[dict]:
    """Full-text search using FTS5."""
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT t.* FROM tracks t
            JOIN tracks_fts f ON t.rowid = f.rowid
            WHERE tracks_fts MATCH ?
            ORDER BY rank
            """,
            (query,),
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def get_all_albums() -> list[dict]:
    """Return distinct albums with cover and track count."""
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT album, artist, COUNT(*) as track_count,
                   MAX(cover_path) as cover_path,
                   MAX(added_at) as added_at
            FROM tracks
            WHERE album IS NOT NULL AND album != ''
            GROUP BY album, artist
            ORDER BY added_at DESC
            """
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def get_album_tracks(album: str, artist: str) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM tracks WHERE album = ? AND artist = ? ORDER BY title",
            (album, artist),
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def get_all_artists() -> list[dict]:
    """Return distinct artists with track count."""
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT artist, COUNT(*) as track_count, MAX(cover_path) as cover_path
            FROM tracks
            WHERE artist IS NOT NULL AND artist != ''
            GROUP BY artist
            ORDER BY track_count DESC
            """
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def get_artist_tracks(artist: str) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM tracks WHERE artist = ? ORDER BY album, title",
            (artist,),
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def upsert_track(track: dict) -> None:
    """Insert or replace a track record."""
    if not track.get("id"):
        track["id"] = str(uuid.uuid4())
    if not track.get("added_at"):
        track["added_at"] = datetime.now(timezone.utc).isoformat()

    _backup_before_write()

    with connect() as conn:
        conn.execute(
            """
            INSERT INTO tracks (id, title, artist, album, duration, file_path, cover_path, added_at)
            VALUES (:id, :title, :artist, :album, :duration, :file_path, :cover_path, :added_at)
            ON CONFLICT(id) DO UPDATE SET
                title      = excluded.title,
                artist     = excluded.artist,
                album      = excluded.album,
                duration   = excluded.duration,
                file_path  = excluded.file_path,
                cover_path = excluded.cover_path,
                added_at   = COALESCE(tracks.added_at, excluded.added_at)
            """,
            {
                "id":         track.get("id"),
                "title":      track.get("title"),
                "artist":     track.get("artist"),
                "album":      track.get("album"),
                "duration":   track.get("duration"),
                "file_path":  track.get("file_path"),
                "cover_path": track.get("cover_path"),
                "added_at":   track.get("added_at"),
            },
        )


def delete_track(track_id: str) -> None:
    _backup_before_write()
    with connect() as conn:
        conn.execute("DELETE FROM tracks WHERE id = ?", (track_id,))


def upsert_cover_for_track(track_id: str, cover_source: str, source_type: str = "path") -> str | None:
    """Save cover to .covers/ and update track record. Returns cover path or None."""
    _backup_before_write()

    cover_path = None
    if source_type == "url":
        cover_path = _save_cover_from_url(cover_source, track_id)
    else:
        cover_path = _save_cover_from_path(cover_source, track_id)

    if cover_path:
        with connect() as conn:
            conn.execute(
                "UPDATE tracks SET cover_path = ? WHERE id = ?",
                (cover_path, track_id),
            )
        return cover_path
    return None


def get_playlists() -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM playlists ORDER BY created_at DESC"
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def get_playlist_by_name(name: str) -> dict | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM playlists WHERE lower(name) = lower(?) ORDER BY created_at DESC LIMIT 1",
            (name,),
        ).fetchone()
    return _row_to_dict(row)


def get_playlist(playlist_id: str) -> dict | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM playlists WHERE id = ?", (playlist_id,)).fetchone()
    return _row_to_dict(row)


def create_playlist(name: str) -> dict:
    _backup_before_write()
    playlist = {
        "id":         str(uuid.uuid4()),
        "name":       name,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    with connect() as conn:
        conn.execute(
            "INSERT INTO playlists (id, name, created_at) VALUES (:id, :name, :created_at)",
            playlist,
        )
    return playlist


def delete_playlist(playlist_id: str) -> None:
    _backup_before_write()
    with connect() as conn:
        conn.execute("DELETE FROM playlists WHERE id = ?", (playlist_id,))


def clear_playlist_tracks(playlist_id: str) -> None:
    _backup_before_write()
    with connect() as conn:
        conn.execute("DELETE FROM playlist_tracks WHERE playlist_id = ?", (playlist_id,))


def get_playlist_tracks(playlist_id: str) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT t.*
            FROM tracks t
            JOIN playlist_tracks pt ON pt.track_id = t.id
            WHERE pt.playlist_id = ?
            ORDER BY pt.position, t.title
            """,
            (playlist_id,),
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def add_track_to_playlist(playlist_id: str, track_id: str) -> None:
    _backup_before_write()
    with connect() as conn:
        max_pos = conn.execute(
            "SELECT COALESCE(MAX(position), -1) FROM playlist_tracks WHERE playlist_id = ?",
            (playlist_id,),
        ).fetchone()[0]
        conn.execute(
            """
            INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position)
            VALUES (?, ?, ?)
            """,
            (playlist_id, track_id, max_pos + 1),
        )


def remove_track_from_playlist(playlist_id: str, track_id: str) -> None:
    _backup_before_write()
    with connect() as conn:
        conn.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?",
            (playlist_id, track_id),
        )


def reorder_playlist_tracks(playlist_id: str, track_ids: list) -> None:
    """Reorder tracks in a playlist by providing the full ordered list of track IDs."""
    _backup_before_write()
    with connect() as conn:
        for position, track_id in enumerate(track_ids):
            conn.execute(
                """
                UPDATE playlist_tracks SET position = ?
                WHERE playlist_id = ? AND track_id = ?
                """,
                (position, playlist_id, track_id),
            )


def update_track_play_count(track_id: str) -> None:
    """Increment the play count and update last_played timestamp for a track."""
    _backup_before_write()
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    with connect() as conn:
        conn.execute(
            "UPDATE tracks SET play_count = play_count + 1, last_played = ? WHERE id = ?",
            (now, track_id),
        )


def get_new_tracks(days: int = 7, limit: int = 100) -> list[dict]:
    """Get tracks added within the last N days."""
    from datetime import datetime, timezone, timedelta
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    cutoff_str = cutoff.isoformat()
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM tracks WHERE added_at >= ? ORDER BY added_at DESC LIMIT ?",
            (cutoff_str, limit),
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def get_top_tracks(limit: int = 50) -> list[dict]:
    """Get most played tracks."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM tracks WHERE play_count > 0 ORDER BY play_count DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def get_unplayed_tracks(limit: int = 100) -> list[dict]:
    """Get tracks that have never been played."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM tracks WHERE play_count = 0 OR play_count IS NULL ORDER BY title LIMIT ?",
            (limit,),
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def get_recently_played_tracks(limit: int = 50) -> list[dict]:
    """Get tracks ordered by last_played timestamp."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM tracks WHERE last_played IS NOT NULL ORDER BY last_played DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def create_smart_playlist(name: str, rules: list[dict], limit_count: int = 50) -> dict:
    """Create a smart playlist with given rules."""
    import json
    _backup_before_write()
    playlist = {
        "id": str(uuid.uuid4()),
        "name": name,
        "rules": json.dumps(rules),
        "limit_count": limit_count,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    with connect() as conn:
        conn.execute(
            "INSERT INTO smart_playlists (id, name, rules, limit_count, created_at) VALUES (:id, :name, :rules, :limit_count, :created_at)",
            playlist,
        )
    return playlist


def get_smart_playlists() -> list[dict]:
    """Get all smart playlists."""
    import json
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM smart_playlists ORDER BY created_at DESC"
        ).fetchall()
    result = []
    for r in rows:
        d = _row_to_dict(r)
        if d and d.get("rules"):
            try:
                d["rules"] = json.loads(d["rules"])
            except Exception:
                d["rules"] = []
        result.append(d)
    return result


def get_smart_playlist(playlist_id: str) -> dict | None:
    """Get a smart playlist by ID."""
    import json
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM smart_playlists WHERE id = ?", (playlist_id,)
        ).fetchone()
    if not row:
        return None
    d = _row_to_dict(row)
    if d and d.get("rules"):
        try:
            d["rules"] = json.loads(d["rules"])
        except Exception:
            d["rules"] = []
    return d


def delete_smart_playlist(playlist_id: str) -> None:
    """Delete a smart playlist."""
    _backup_before_write()
    with connect() as conn:
        conn.execute("DELETE FROM smart_playlists WHERE id = ?", (playlist_id,))


def evaluate_smart_playlist(playlist_id: str) -> list[dict]:
    """Evaluate a smart playlist's rules against the track library."""
    import json
    smart = get_smart_playlist(playlist_id)
    if not smart:
        return []

    all_tracks = get_all_tracks()
    rules = smart.get("rules", [])
    limit_count = smart.get("limit_count", 50)

    for rule in rules:
        field = rule.get("field", "")
        op = rule.get("op", "")
        value = rule.get("value", "")

        filtered = []
        for track in all_tracks:
            track_val = track.get(field)

            if field in ("added_at", "last_played"):
                if track_val:
                    try:
                        from datetime import datetime
                        track_time = datetime.fromisoformat(track_val.replace("Z", "+00:00"))
                        now = datetime.now(timezone.utc)
                        delta = now - track_time
                        track_val = delta.days
                        value = int(value)
                    except Exception:
                        continue
                else:
                    continue

            if field == "duration":
                track_val = track_val or 0
                value = int(value) if str(value).isdigit() else 0

            if field == "mood":
                track_val = (track_val or "").lower()
                value = (str(value) or "").lower()

            if op == "equals" and track_val == value:
                filtered.append(track)
            elif op == "contains" and value in str(track_val):
                filtered.append(track)
            elif op == "greater_than" and track_val is not None and track_val > value:
                filtered.append(track)
            elif op == "less_than" and track_val is not None and track_val < value:
                filtered.append(track)
            elif op == "not_equals" and track_val != value:
                filtered.append(track)

        all_tracks = filtered

    return all_tracks[:limit_count]


def create_user(username: str, display_name: str | None = None, avatar_url: str | None = None) -> dict:
    """Create a new user."""
    _backup_before_write()
    user = {
        "id": str(uuid.uuid4()),
        "username": username,
        "display_name": display_name or username,
        "avatar_url": avatar_url or "",
        "bio": "",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    with connect() as conn:
        conn.execute(
            "INSERT INTO users (id, username, display_name, avatar_url, bio, created_at) VALUES (:id, :username, :display_name, :avatar_url, :bio, :created_at)",
            user,
        )
    return user


def get_user(user_id: str) -> dict | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return _row_to_dict(row)


def get_user_by_username(username: str) -> dict | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE lower(username) = lower(?)", (username,)).fetchone()
    return _row_to_dict(row)


def update_user(user_id: str, updates: dict) -> dict | None:
    _backup_before_write()
    valid_fields = {"display_name", "avatar_url", "bio"}
    set_parts = []
    params = []
    for key in valid_fields:
        if key in updates:
            set_parts.append(f"{key} = ?")
            params.append(updates[key])
    if not set_parts:
        return get_user(user_id)
    params.append(user_id)
    with connect() as conn:
        conn.execute(f"UPDATE users SET {', '.join(set_parts)} WHERE id = ?", params)
    return get_user(user_id)


def follow_user(follower_id: str, following_id: str) -> bool:
    if follower_id == following_id:
        return False
    _backup_before_write()
    try:
        with connect() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO follows (follower_id, following_id, created_at) VALUES (?, ?, ?)",
                (follower_id, following_id, datetime.now(timezone.utc).isoformat()),
            )
        return True
    except Exception:
        return False


def unfollow_user(follower_id: str, following_id: str) -> bool:
    _backup_before_write()
    with connect() as conn:
        conn.execute("DELETE FROM follows WHERE follower_id = ? AND following_id = ?", (follower_id, following_id))
    return True


def get_followers(user_id: str) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT u.* FROM users u
            JOIN follows f ON f.follower_id = u.id
            WHERE f.following_id = ?
            """,
            (user_id,),
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def get_following(user_id: str) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT u.* FROM users u
            JOIN follows f ON f.following_id = u.id
            WHERE f.follower_id = ?
            """,
            (user_id,),
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def create_activity(user_id: str, action_type: str, track_id: str | None = None, playlist_id: str | None = None, metadata: dict | None = None) -> dict:
    """Create an activity entry. Action types: listening, liked, added_to_playlist, created_playlist."""
    import json
    _backup_before_write()
    activity = {
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "action_type": action_type,
        "track_id": track_id,
        "playlist_id": playlist_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "metadata_json": json.dumps(metadata) if metadata else None,
    }
    with connect() as conn:
        conn.execute(
            "INSERT INTO activities (id, user_id, action_type, track_id, playlist_id, created_at, metadata_json) VALUES (:id, :user_id, :action_type, :track_id, :playlist_id, :created_at, :metadata_json)",
            activity,
        )
    return activity


def get_activities(limit: int = 50, offset: int = 0) -> list[dict]:
    import json
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM activities ORDER BY created_at DESC LIMIT ? OFFSET ?",
            (limit, offset),
        ).fetchall()
    result = []
    for r in rows:
        d = _row_to_dict(r)
        if d and d.get("metadata_json"):
            try:
                d["metadata"] = json.loads(d["metadata_json"])
            except Exception:
                d["metadata"] = {}
        result.append(d)
    return result


def get_user_activities(user_id: str, limit: int = 50) -> list[dict]:
    import json
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM activities WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
            (user_id, limit),
        ).fetchall()
    result = []
    for r in rows:
        d = _row_to_dict(r)
        if d and d.get("metadata_json"):
            try:
                d["metadata"] = json.loads(d["metadata_json"])
            except Exception:
                d["metadata"] = {}
        result.append(d)
    return result


def invite_collaborator(playlist_id: str, user_id: str, role: str = "editor") -> bool:
    _backup_before_write()
    try:
        with connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO playlist_collaborators (playlist_id, user_id, role, invited_at) VALUES (?, ?, ?, ?)",
                (playlist_id, user_id, role, datetime.now(timezone.utc).isoformat()),
            )
        return True
    except Exception:
        return False


def remove_collaborator(playlist_id: str, user_id: str) -> bool:
    _backup_before_write()
    with connect() as conn:
        conn.execute("DELETE FROM playlist_collaborators WHERE playlist_id = ? AND user_id = ?", (playlist_id, user_id))
    return True


def update_collaborator_role(playlist_id: str, user_id: str, role: str) -> bool:
    _backup_before_write()
    with connect() as conn:
        conn.execute("UPDATE playlist_collaborators SET role = ? WHERE playlist_id = ? AND user_id = ?", (role, playlist_id, user_id))
    return True


def get_collaborators(playlist_id: str) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT u.*, pc.role, pc.invited_at FROM users u
            JOIN playlist_collaborators pc ON pc.user_id = u.id
            WHERE pc.playlist_id = ?
            """,
            (playlist_id,),
        ).fetchall()
    result = []
    for r in rows:
        d = _row_to_dict(r)
        result.append(d)
    return result


def can_edit_playlist(playlist_id: str, user_id: str) -> bool:
    with connect() as conn:
        row = conn.execute(
            "SELECT role FROM playlist_collaborators WHERE playlist_id = ? AND user_id = ?",
            (playlist_id, user_id),
        ).fetchone()
        if row and row["role"] in ("owner", "editor"):
            return True
        owner = conn.execute("SELECT 1 FROM playlists WHERE id = ?", (playlist_id,)).fetchone()
        return owner is not None


def set_listening(user_id: str, track_id: str, duration_minutes: int = 30) -> None:
    from datetime import datetime, timedelta
    _backup_before_write()
    now = datetime.now(timezone.utc)
    expires = now + timedelta(minutes=duration_minutes)
    with connect() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO listening_sessions (user_id, track_id, started_at, expires_at) VALUES (?, ?, ?, ?)",
            (user_id, track_id, now.isoformat(), expires.isoformat()),
        )


def get_active_listening() -> list[dict]:
    now = datetime.now(timezone.utc).isoformat()
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT ls.*, t.title, t.artist, t.cover_path, u.username, u.display_name
            FROM listening_sessions ls
            JOIN users u ON u.id = ls.user_id
            JOIN tracks t ON t.id = ls.track_id
            WHERE ls.expires_at > ?
            ORDER BY ls.started_at DESC
            """,
            (now,),
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def expire_old_sessions() -> None:
    now = datetime.now(timezone.utc).isoformat()
    with connect() as conn:
        conn.execute("DELETE FROM listening_sessions WHERE expires_at <= ?", (now,))


def create_share_link(user_id: str | None, playlist_id: str | None = None, track_id: str | None = None, expires_hours: int = 168) -> dict:
    from datetime import datetime, timedelta
    _backup_before_write()
    code = uuid.uuid4().hex[:12]
    now = datetime.now(timezone.utc)
    expires = now + timedelta(hours=expires_hours)
    link = {
        "code": code,
        "user_id": user_id,
        "playlist_id": playlist_id,
        "track_id": track_id,
        "created_at": now.isoformat(),
        "expires_at": expires.isoformat(),
    }
    with connect() as conn:
        conn.execute(
            "INSERT INTO share_links (code, user_id, playlist_id, track_id, created_at, expires_at) VALUES (:code, :user_id, :playlist_id, :track_id, :created_at, :expires_at)",
            link,
        )
    return link


def get_share_link(code: str) -> dict | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM share_links WHERE code = ?", (code,)).fetchone()
    if not row:
        return None
    d = _row_to_dict(row)
    if d and d.get("expires_at"):
        exp = datetime.fromisoformat(d["expires_at"].replace("Z", "+00:00"))
        if exp < datetime.now(timezone.utc):
            return None
    return d