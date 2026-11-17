"""
Spotify metadata for library tracks that came from a Spotify import.

Shared by the importer (nocturne_api/spotify_import.py) and the repair CLIs
(spotify_repair / spotify_metadata / spotify_covers, lyrics_backfill --spotify):

  * track_meta(t)              clean metadata of a Spotify track object (pure)
  * store_meta / load_meta     cache table v1_spotify_track_meta (nocturne.db, migration 6)
  * metadata_change / apply_metadata_change / undo_metadata_change
                               rewrite tracks.title/artist/album in library.db (DB only,
                               never audio tags); old values recorded for undo
  * set_cover_from_url         save an image as <covers>/<id>.official.jpg + cover_path
  * SpotifyReader              Web API reads for the CLIs (client credentials first,
                               then the connected user's token). With persist_tokens=False
                               (dry runs) nocturne.db is only read: an expired access token
                               is refreshed in memory and never written back.
  * load_snapshot              every imported playlist (entries in order) + track metadata,
                               optionally cached in a JSON file so later runs are offline.

Secrets hygiene: tokens / client secret are never logged or written to reports.
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Optional

log = logging.getLogger("nocturne.spotify_catalog")

DEFAULT_MUSIC_DIR = "./music"
SERVER_ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = SERVER_ROOT / ".nocturne.env"
BACKEND_DIR = str(SERVER_ROOT / "backend")


# ---------------------------------------------------------------------------
# CLI bootstrap
# ---------------------------------------------------------------------------

def bootstrap_env(env_file: Optional[str] = None) -> None:
    """For CLIs run outside systemd: default MUSIC_DIR and load the service's
    EnvironmentFile (KEY=VALUE lines) without overriding variables already set.
    Must run before nocturne_api.config / NOVA's database module are imported."""
    os.environ.setdefault("MUSIC_DIR", DEFAULT_MUSIC_DIR)
    path = Path(env_file or os.getenv("NOCTURNE_ENV_FILE") or ENV_FILE)
    try:
        text = path.read_text()
    except OSError:
        text = ""
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        if k.startswith("export "):
            k = k[7:].strip()
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
            v = v[1:-1]
        if k:
            os.environ.setdefault(k, v)
    if BACKEND_DIR not in sys.path:
        sys.path.insert(0, BACKEND_DIR)


def music_dir() -> str:
    return os.getenv("MUSIC_DIR", "").strip() or DEFAULT_MUSIC_DIR


def default_library_db() -> str:
    return str(Path(music_dir()) / "library.db")


def default_nocturne_db() -> str:
    return os.getenv("NOCTURNE_DB_PATH", "").strip() or str(Path(music_dir()) / "nocturne.db")


def ro(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def rw(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


def backup_sqlite(path: str, label: str) -> str:
    """Consistent copy with the SQLite backup API: <path>.bak-<label>-<timestamp>."""
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = f"{path}.bak-{label}-{ts}"
    src = sqlite3.connect(path, timeout=30)
    dst = sqlite3.connect(dest)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    return dest


def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    return conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
                        (name,)).fetchone() is not None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Pure metadata helpers
# ---------------------------------------------------------------------------

def largest_image(images: Any) -> Optional[str]:
    imgs = [i for i in (images or []) if isinstance(i, dict) and i.get("url")]
    if not imgs:
        return None
    sized = [i for i in imgs if i.get("width")]
    if sized:
        return max(sized, key=lambda i: i.get("width") or 0)["url"]
    return imgs[0]["url"]


def track_meta(t: dict) -> dict:
    album = t.get("album") if isinstance(t.get("album"), dict) else {}
    return {
        "id": t.get("id"),
        "name": (t.get("name") or "").strip(),
        "artists": [a.get("name").strip() for a in t.get("artists") or []
                    if isinstance(a, dict) and (a.get("name") or "").strip()],
        "album": (album.get("name") or "").strip() or None,
        "duration_ms": t.get("duration_ms") or None,
        "image": largest_image(album.get("images")),
        "isrc": ((t.get("external_ids") or {}).get("isrc") if isinstance(t.get("external_ids"), dict) else None),
    }


def artists_joined(meta: dict) -> str:
    """NOVA's convention: several artists comma-joined (mapping._parse_artists splits it)."""
    return ", ".join(a for a in meta.get("artists") or [] if a)


def duration_s(meta: dict) -> Optional[int]:
    ms = meta.get("duration_ms")
    return int(round(ms / 1000)) if ms else None


# ---------------------------------------------------------------------------
# Cache table v1_spotify_track_meta (nocturne.db)
# ---------------------------------------------------------------------------

def store_meta(conn: sqlite3.Connection, metas: Iterable[dict]) -> int:
    if not table_exists(conn, "v1_spotify_track_meta"):
        return 0
    rows = [(m["id"], m.get("name") or "", json.dumps(m.get("artists") or [], ensure_ascii=False),
             m.get("album"), m.get("duration_ms"), m.get("image"), m.get("isrc"), _now())
            for m in metas if m and m.get("id") and m.get("name")]
    with conn:
        conn.executemany(
            """INSERT INTO v1_spotify_track_meta
               (spotify_track_id, name, artists, album, duration_ms, image_url, isrc, updated_at)
               VALUES (?,?,?,?,?,?,?,?)
               ON CONFLICT(spotify_track_id) DO UPDATE SET
                 name=excluded.name, artists=excluded.artists, album=excluded.album,
                 duration_ms=excluded.duration_ms,
                 image_url=COALESCE(excluded.image_url, v1_spotify_track_meta.image_url),
                 isrc=COALESCE(excluded.isrc, v1_spotify_track_meta.isrc),
                 updated_at=excluded.updated_at""",
            rows,
        )
    return len(rows)


def load_meta(conn: sqlite3.Connection, ids: Optional[Iterable[str]] = None) -> dict[str, dict]:
    if not table_exists(conn, "v1_spotify_track_meta"):
        return {}
    if ids is None:
        rows = conn.execute("SELECT * FROM v1_spotify_track_meta").fetchall()
    else:
        ids = list(dict.fromkeys(ids))
        rows = []
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            rows += conn.execute(
                f"SELECT * FROM v1_spotify_track_meta WHERE spotify_track_id IN ({','.join('?' * len(chunk))})",
                chunk).fetchall()
    out = {}
    for r in rows:
        try:
            artists = json.loads(r["artists"] or "[]")
        except ValueError:
            artists = []
        out[r["spotify_track_id"]] = {"id": r["spotify_track_id"], "name": r["name"], "artists": artists,
                                      "album": r["album"], "duration_ms": r["duration_ms"],
                                      "image": r["image_url"], "isrc": r["isrc"]}
    return out


def track_map(conn: sqlite3.Connection) -> list[dict]:
    """v1_spotify_track_map rows, oldest first."""
    return [dict(r) for r in conn.execute(
        "SELECT spotify_track_id, track_id, source, created_at FROM v1_spotify_track_map"
        " ORDER BY created_at, spotify_track_id").fetchall()]


def primary_spotify_ids(map_rows: list[dict], metas: dict[str, dict]) -> dict[str, str]:
    """track_id -> the Spotify id whose metadata describes it (oldest mapping with metadata)."""
    out: dict[str, str] = {}
    for r in map_rows:
        if r["track_id"] not in out and r["spotify_track_id"] in metas:
            out[r["track_id"]] = r["spotify_track_id"]
    return out


# ---------------------------------------------------------------------------
# Library metadata rewrite (DB only)
# ---------------------------------------------------------------------------

def metadata_change(row: dict, meta: dict) -> Optional[dict]:
    """The tracks-row change that gives `row` Spotify's clean title/artist/album, or None."""
    title = (meta.get("name") or "").strip()
    if not title:
        return None
    artist = artists_joined(meta) or row.get("artist")
    album = (meta.get("album") or "").strip() or row.get("album")
    if (title, artist, album) == (row.get("title"), row.get("artist"), row.get("album")):
        return None
    return {"track_id": row["id"], "spotify_track_id": meta.get("id"),
            "old_title": row.get("title"), "old_artist": row.get("artist"), "old_album": row.get("album"),
            "new_title": title, "new_artist": artist, "new_album": album}


def record_undo(noc: sqlite3.Connection, ch: dict) -> None:
    """Keep the ORIGINAL values (first change wins) and the latest new ones."""
    if not table_exists(noc, "v1_spotify_meta_undo"):
        return
    with noc:
        noc.execute(
            """INSERT INTO v1_spotify_meta_undo
               (track_id, old_title, old_artist, old_album, new_title, new_artist, new_album,
                spotify_track_id, changed_at) VALUES (?,?,?,?,?,?,?,?,?)
               ON CONFLICT(track_id) DO UPDATE SET new_title=excluded.new_title,
                 new_artist=excluded.new_artist, new_album=excluded.new_album,
                 spotify_track_id=excluded.spotify_track_id, changed_at=excluded.changed_at""",
            (ch["track_id"], ch["old_title"], ch["old_artist"], ch["old_album"], ch["new_title"],
             ch["new_artist"], ch["new_album"], ch.get("spotify_track_id"), _now()),
        )


def apply_metadata_change(lib: sqlite3.Connection, ch: dict, noc: Optional[sqlite3.Connection] = None,
                          commit: bool = True) -> bool:
    """UPDATE guarded by the old values (skips rows changed meanwhile). FTS follows via triggers."""
    cur = lib.execute(
        "UPDATE tracks SET title=?, artist=?, album=? WHERE id=? AND title IS ? AND artist IS ? AND album IS ?",
        (ch["new_title"], ch["new_artist"], ch["new_album"], ch["track_id"],
         ch["old_title"], ch["old_artist"], ch["old_album"]),
    )
    if commit:
        lib.commit()
    ok = cur.rowcount > 0
    if ok and noc is not None:
        try:
            record_undo(noc, ch)
        except sqlite3.Error as exc:
            log.warning("could not record metadata undo for %s: %s", ch["track_id"], exc)
    return ok


def undo_metadata_change(lib: sqlite3.Connection, ch: dict) -> bool:
    cur = lib.execute(
        "UPDATE tracks SET title=?, artist=?, album=? WHERE id=? AND title IS ? AND artist IS ? AND album IS ?",
        (ch["old_title"], ch["old_artist"], ch["old_album"], ch["track_id"],
         ch["new_title"], ch["new_artist"], ch["new_album"]),
    )
    return cur.rowcount > 0


# ---------------------------------------------------------------------------
# Covers
# ---------------------------------------------------------------------------

def is_official(cover_path: Optional[str]) -> bool:
    return bool(cover_path) and str(cover_path).endswith(".official.jpg")


def set_cover_from_url(lib: sqlite3.Connection, track_id: str, url: str,
                       covers_dir: Optional[str] = None, min_px: int = 300) -> tuple[str, int, int]:
    """Download (validated JPEG/PNG), save as the official cover, point cover_path at it."""
    import cover_art as ca
    data, w, h, _ = ca.fetch_cover_bytes(url, min_px=min_px)
    path = ca.save_official_cover(track_id, data, covers_dir)
    with lib:
        lib.execute("UPDATE tracks SET cover_path=? WHERE id=?", (path, track_id))
    return path, w, h


# ---------------------------------------------------------------------------
# Spotify Web API reads for the CLIs
# ---------------------------------------------------------------------------

class SpotifyReader:
    """Reads tracks/playlists. Tries client credentials for track metadata, then the
    connected user's token (Development-mode apps may not allow client credentials)."""

    def __init__(self, nocturne_db: str, *, persist_tokens: bool):
        from . import spotify
        self.sp = spotify
        self.nocturne_db = nocturne_db
        self.persist = persist_tokens
        self._user_tokens: dict[str, str] = {}
        self._cc: Optional[str] = None
        self.track_mode: Optional[str] = None
        self.rotated_refresh_token = False

    # tokens -----------------------------------------------------------------
    async def user_token(self, user_id: str, force: bool = False) -> str:
        if self.persist:
            return await self.sp.access_token(user_id, force_refresh=force)
        if not force and user_id in self._user_tokens:
            return self._user_tokens[user_id]
        conn = ro(self.nocturne_db)
        try:
            row = conn.execute("SELECT * FROM v1_spotify_tokens WHERE user_id=?", (user_id,)).fetchone()
        finally:
            conn.close()
        if not row:
            raise self.sp.NotConnected()
        exp = self.sp._parse(row["expires_at"])
        at = self.sp.decrypt(row["access_token"])
        if not force and at and exp and (exp - self.sp._now()).total_seconds() > 60:
            self._user_tokens[user_id] = at
            return at
        rt = self.sp.decrypt(row["refresh_token"])
        if not rt:
            raise self.sp.NotConnected()
        tok = await self.sp._token_request({"grant_type": "refresh_token", "refresh_token": rt})
        if tok.get("refresh_token") and tok["refresh_token"] != rt:
            self.rotated_refresh_token = True
            log.warning("Spotify returned a new refresh token; read-only mode does not store it "
                        "(the stored one normally keeps working; reconnect Spotify if imports fail).")
        self._user_tokens[user_id] = tok["access_token"]
        return tok["access_token"]

    async def cc_token(self) -> str:
        if self._cc is None:
            tok = await self.sp._token_request({"grant_type": "client_credentials"})
            self._cc = tok["access_token"]
        return self._cc

    async def user_get(self, user_id: str, path: str, params: Optional[dict] = None) -> dict:
        token = await self.user_token(user_id)
        try:
            return await self.sp.api_get(token, path, params)
        except self.sp.SpotifyError as e:
            if e.status != 401:
                raise
        return await self.sp.api_get(await self.user_token(user_id, force=True), path, params)

    async def _get(self, mode: str, user_id: Optional[str], path: str, params: Optional[dict] = None) -> dict:
        if mode == "cc":
            return await self.sp.api_get(await self.cc_token(), path, params)
        return await self.user_get(user_id, path, params)

    # reads --------------------------------------------------------------------
    async def playlist_entries(self, user_id: str, playlist_id: str, max_items: int = 10000) -> list[dict]:
        out: list[dict] = []
        url: Optional[str] = f"/playlists/{playlist_id}/items"
        params: Optional[dict] = {"limit": 50, "offset": 0, "additional_types": "track"}
        while url and len(out) < max_items:
            page = await self.user_get(user_id, url, params)
            out += [e for e in page.get("items") or [] if isinstance(e, dict)]
            url, params = page.get("next"), None
        return out

    async def tracks(self, ids: Iterable[str], user_id: Optional[str] = None) -> dict[str, dict]:
        """Spotify track objects by id: batch GET /tracks?ids= (50) with client credentials,
        then with the user token, then one GET /tracks/{id} at a time (Development-mode
        apps lose the batch endpoints). The first mode that works is used for all ids."""
        want = [i for i in dict.fromkeys(ids) if i and not i.startswith("local:")]
        out: dict[str, dict] = {}
        if not want:
            return out
        modes = [("cc", True), ("user", True), ("cc", False), ("user", False)]
        for mode, batch in modes:
            if mode == "user" and not user_id:
                continue
            try:
                if batch:
                    for i in range(0, len(want), 50):
                        chunk = want[i:i + 50]
                        data = await self._get(mode, user_id, "/tracks", {"ids": ",".join(chunk)})
                        for sid, t in zip(chunk, data.get("tracks") or []):
                            if isinstance(t, dict):
                                out[sid] = t
                else:
                    first = True
                    for sid in want:
                        try:
                            out[sid] = await self._get(mode, user_id, f"/tracks/{sid}")
                        except self.sp.SpotifyError as e:
                            if first or e.status not in (400, 404):
                                raise
                        first = False
            except self.sp.SpotifyError as e:
                if out:
                    log.warning("Spotify %s %s stopped after %d tracks: HTTP %s", mode,
                                "batch" if batch else "single", len(out), e.status)
                    self.track_mode = f"{mode}/{'batch' if batch else 'single'} (partial)"
                    return out
                log.info("Spotify track lookup via %s/%s not allowed (HTTP %s); trying next",
                         mode, "batch" if batch else "single", e.status)
                continue
            self.track_mode = f"{mode}/{'batch' if batch else 'single'}"
            return out
        return out


def latest_imports(conn: sqlite3.Connection, import_id: Optional[str] = None) -> list[dict]:
    """Newest finished import per (user, Spotify playlist) that created a playlist."""
    rows = [dict(r) for r in conn.execute(
        "SELECT * FROM v1_spotify_imports WHERE playlist_id IS NOT NULL"
        " AND status IN ('done','failed','cancelled') ORDER BY created_at DESC").fetchall()]
    if import_id:
        return [r for r in rows if r["id"] == import_id]
    seen, out = set(), []
    for r in rows:
        k = (r["user_id"], r["spotify_playlist_id"])
        if k not in seen:
            seen.add(k)
            out.append(r)
    return out


async def collect_snapshot(reader: SpotifyReader, nocturne_db: str, import_id: Optional[str] = None) -> dict:
    from . import spotify
    conn = ro(nocturne_db)
    try:
        imports = latest_imports(conn, import_id)
        maps = track_map(conn)
        cached = load_meta(conn)
    finally:
        conn.close()
    tracks: dict[str, dict] = {}
    playlists = []
    for imp in imports:
        try:
            raw = await reader.playlist_entries(imp["user_id"], imp["spotify_playlist_id"])
        except spotify.SpotifyError as e:
            log.warning("cannot read Spotify playlist %s (import %s): HTTP %s %s", imp["spotify_playlist_id"],
                        imp["id"], e.status, e)
            continue
        entries: list[Optional[str]] = []
        for e in raw:
            t, _reason = spotify.entry_track(e)
            if t is None:
                entries.append(None)
                continue
            tracks[t["id"]] = track_meta(t)
            entries.append(t["id"])
        playlists.append({"import_id": imp["id"], "user_id": imp["user_id"],
                          "spotify_playlist_id": imp["spotify_playlist_id"], "playlist_id": imp["playlist_id"],
                          "name": imp["spotify_name"], "entries": entries})
    for sid, m in cached.items():
        tracks.setdefault(sid, m)
    missing = [r["spotify_track_id"] for r in maps if r["spotify_track_id"] not in tracks]
    if missing:
        uid = imports[0]["user_id"] if imports else None
        got = await reader.tracks(missing, uid)
        for sid, t in got.items():
            m = track_meta(t)
            m["id"] = sid
            tracks[sid] = m
    return {"generated_at": _now(), "track_lookup_mode": reader.track_mode,
            "playlists": playlists, "tracks": tracks}


def load_snapshot(nocturne_db: str, snapshot_path: Optional[str], *, refresh: bool = False,
                  persist_tokens: bool = False, import_id: Optional[str] = None) -> dict:
    """Snapshot from `snapshot_path` if it exists (offline), else read Spotify and save it there."""
    if snapshot_path and Path(snapshot_path).exists() and not refresh:
        snap = json.loads(Path(snapshot_path).read_text())
        log.info("using Spotify snapshot %s (%d playlists, %d tracks)", snapshot_path,
                 len(snap.get("playlists", [])), len(snap.get("tracks", {})))
        return snap
    import asyncio
    reader = SpotifyReader(nocturne_db, persist_tokens=persist_tokens)
    snap = asyncio.run(collect_snapshot(reader, nocturne_db, import_id))
    if snapshot_path:
        Path(snapshot_path).parent.mkdir(parents=True, exist_ok=True)
        Path(snapshot_path).write_text(json.dumps(snap, ensure_ascii=False, indent=1))
        log.info("Spotify snapshot written to %s", snapshot_path)
    return snap


def add_common_args(p) -> None:
    p.add_argument("--library-db", help="NOVA library.db (default: $MUSIC_DIR/library.db)")
    p.add_argument("--nocturne-db", help="nocturne.db (default: $NOCTURNE_DB_PATH or $MUSIC_DIR/nocturne.db)")
    p.add_argument("--snapshot", help="Spotify snapshot JSON: read if it exists (no Spotify calls), "
                                      "else written after reading Spotify")
    p.add_argument("--refresh-snapshot", action="store_true", help="re-read Spotify even if --snapshot exists")
    p.add_argument("--env-file", help=f"service environment file (default: {ENV_FILE})")
    p.add_argument("--out", help="directory for reports / undo files (default: <server>/spotify-fix)")


def resolve_common(args) -> None:
    bootstrap_env(args.env_file)
    args.library_db = args.library_db or default_library_db()
    args.nocturne_db = args.nocturne_db or default_nocturne_db()
    # config / spotify / NOVA's database module read these at import time
    os.environ["NOCTURNE_DB_PATH"] = args.nocturne_db
    args.out = args.out or str(SERVER_ROOT / "spotify-fix")
    Path(args.out).mkdir(parents=True, exist_ok=True)
