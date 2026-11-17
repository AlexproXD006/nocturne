"""
Playlist service: ownership/visibility rules on top of NOVA's playlists tables.

Storage
  * NOVA library.db  playlists(id, name, created_at)
                     playlist_tracks(playlist_id, track_id, position)
  * Nocturne db      v1_playlist_meta(playlist_id, owner_id, description, ...)

Rules
  * No meta row, or owner_id NULL  -> shared/legacy playlist (e.g. imported by an
    admin through NOVA): visible to everyone, editable only by admins.
  * owner_id set                   -> private playlist: visible to its owner and to
    admins, editable by the same people.
"""
from __future__ import annotations

import sys
import os
# NOVA backend modules (database, downloader, ...) live in <server root>/backend.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

from datetime import datetime, timezone
from typing import Iterable, Optional

from .db import connect
from .mapping import _art_images

import database as nova_db  # NOVA's database module

NAME_MAX = 100
DESCRIPTION_MAX = 300
ARTWORK_COVERS = 4


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Meta
# ---------------------------------------------------------------------------

def get_meta(playlist_id: str) -> Optional[dict]:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM v1_playlist_meta WHERE playlist_id=?", (playlist_id,)
        ).fetchone()
    return dict(row) if row else None


def _all_meta() -> dict[str, dict]:
    with connect() as conn:
        rows = conn.execute("SELECT * FROM v1_playlist_meta").fetchall()
    return {r["playlist_id"]: dict(r) for r in rows}


def _upsert_meta(playlist_id: str, *, owner_id: Optional[str] = None,
                 description: Optional[str] = None, set_owner: bool = False,
                 set_description: bool = False) -> None:
    now = _now()
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM v1_playlist_meta WHERE playlist_id=?", (playlist_id,)
        ).fetchone()
        if row is None:
            conn.execute(
                "INSERT INTO v1_playlist_meta(playlist_id, owner_id, description, created_at, updated_at)"
                " VALUES (?,?,?,?,?)",
                (playlist_id, owner_id if set_owner else None,
                 description if set_description else None, now, now),
            )
        else:
            fields, args = ["updated_at=?"], [now]
            if set_owner:
                fields.append("owner_id=?")
                args.append(owner_id)
            if set_description:
                fields.append("description=?")
                args.append(description)
            conn.execute(
                f"UPDATE v1_playlist_meta SET {', '.join(fields)} WHERE playlist_id=?",
                (*args, playlist_id),
            )


def touch(playlist_id: str) -> None:
    _upsert_meta(playlist_id)


def _account_names(ids: Iterable[str]) -> dict[str, str]:
    ids = [i for i in set(ids) if i]
    if not ids:
        return {}
    with connect() as conn:
        rows = conn.execute(
            f"SELECT id, username, display_name FROM v1_accounts WHERE id IN ({','.join('?' * len(ids))})",
            ids,
        ).fetchall()
    return {r["id"]: (r["display_name"] or r["username"] or "") for r in rows}


# ---------------------------------------------------------------------------
# Permissions
# ---------------------------------------------------------------------------

def is_admin(account: dict) -> bool:
    return (account or {}).get("role") == "admin"


def owner_of(meta: Optional[dict]) -> Optional[str]:
    return (meta or {}).get("owner_id") or None


def can_view(account: dict, meta: Optional[dict]) -> bool:
    owner = owner_of(meta)
    return owner is None or owner == account["id"] or is_admin(account)


def can_edit(account: dict, meta: Optional[dict]) -> bool:
    owner = owner_of(meta)
    if is_admin(account):
        return True
    return owner is not None and owner == account["id"]


# ---------------------------------------------------------------------------
# NOVA track helpers (bulk, one backup per call)
# ---------------------------------------------------------------------------

def playlist_track_ids(playlist_id: str) -> list[str]:
    conn = nova_db.connect()
    try:
        rows = conn.execute(
            "SELECT pt.track_id FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id"
            " WHERE pt.playlist_id=? ORDER BY pt.position, t.title",
            (playlist_id,),
        ).fetchall()
    finally:
        conn.close()
    return [r[0] for r in rows]


def existing_track_ids(ids: Iterable[str]) -> set[str]:
    ids = list(dict.fromkeys(i for i in ids if isinstance(i, str) and i))
    found: set[str] = set()
    if not ids:
        return found
    conn = nova_db.connect()
    try:
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            rows = conn.execute(
                f"SELECT id FROM tracks WHERE id IN ({','.join('?' * len(chunk))})", chunk
            ).fetchall()
            found.update(r[0] for r in rows)
    finally:
        conn.close()
    return found


def append_tracks(playlist_id: str, track_ids: list[str]) -> tuple[list[str], list[str]]:
    """Append tracks in the given order. Returns (added, skipped). Existing,
    unknown and repeated ids are skipped. One NOVA backup for the whole batch."""
    current = set(playlist_track_ids(playlist_id))
    known = existing_track_ids(track_ids)
    added: list[str] = []
    skipped: list[str] = []
    seen: set[str] = set()
    for tid in track_ids:
        if tid in current or tid in seen or tid not in known:
            skipped.append(tid)
            continue
        seen.add(tid)
        added.append(tid)
    if added:
        nova_db._backup_before_write()
        conn = nova_db.connect()
        try:
            with conn:
                max_pos = conn.execute(
                    "SELECT COALESCE(MAX(position), -1) FROM playlist_tracks WHERE playlist_id=?",
                    (playlist_id,),
                ).fetchone()[0]
                conn.executemany(
                    "INSERT OR IGNORE INTO playlist_tracks(playlist_id, track_id, position) VALUES (?,?,?)",
                    [(playlist_id, tid, max_pos + 1 + i) for i, tid in enumerate(added)],
                )
        finally:
            conn.close()
    return added, skipped


def set_order(playlist_id: str, ordered_ids: list[str]) -> None:
    nova_db.reorder_playlist_tracks(playlist_id, ordered_ids)


def rename(playlist_id: str, name: str) -> None:
    nova_db._backup_before_write()
    conn = nova_db.connect()
    try:
        with conn:
            conn.execute("UPDATE playlists SET name=? WHERE id=?", (name, playlist_id))
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------

def create(name: str, owner_id: Optional[str], description: Optional[str] = None,
           track_ids: Optional[list[str]] = None) -> dict:
    row = nova_db.create_playlist(name)
    _upsert_meta(row["id"], owner_id=owner_id, description=description or None,
                 set_owner=True, set_description=True)
    if track_ids:
        append_tracks(row["id"], track_ids)
    return row


def delete(playlist_id: str) -> None:
    nova_db.clear_playlist_tracks(playlist_id)
    nova_db.delete_playlist(playlist_id)
    with connect() as conn:
        conn.execute("DELETE FROM v1_playlist_meta WHERE playlist_id=?", (playlist_id,))


# ---------------------------------------------------------------------------
# Wire mapping
# ---------------------------------------------------------------------------

def _summaries(playlist_ids: list[str]) -> dict[str, dict]:
    """trackCount + first covers for each playlist in one NOVA query."""
    out: dict[str, dict] = {pid: {"count": 0, "covers": []} for pid in playlist_ids}
    if not playlist_ids:
        return out
    conn = nova_db.connect()
    try:
        rows = conn.execute(
            f"""
            SELECT pt.playlist_id, t.id, t.cover_path
            FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
            WHERE pt.playlist_id IN ({','.join('?' * len(playlist_ids))})
            ORDER BY pt.playlist_id, pt.position, t.title
            """,
            playlist_ids,
        ).fetchall()
    finally:
        conn.close()
    for pid, tid, cover in rows:
        s = out[pid]
        s["count"] += 1
        if cover and len(s["covers"]) < ARTWORK_COVERS * 3 and all(c[1] != cover for c in s["covers"]):
            s["covers"].append((tid, cover))
    return out


def _artwork(covers: list[tuple[str, str]]) -> list[dict]:
    """First cover in 300 and 640, then up to 3 more distinct covers at 300
    (clients that build a 2x2 mosaic can use them; others take the first)."""
    images: list[dict] = []
    used = 0
    for tid, cover in covers:
        imgs = _art_images(tid, cover)
        if not imgs:
            continue
        images.extend(imgs if used == 0 else imgs[:1])
        used += 1
        if used >= ARTWORK_COVERS:
            break
    return images


def to_wire(row: dict, meta: Optional[dict], account: dict, summary: Optional[dict] = None,
            names: Optional[dict] = None) -> dict:
    if summary is None:
        summary = _summaries([row["id"]])[row["id"]]
    owner = owner_of(meta)
    obj: dict = {
        "id": row["id"],
        "name": row.get("name") or "",
        "artwork": _artwork(summary["covers"]),
        "trackCount": summary["count"],
        "editable": can_edit(account, meta),
    }
    desc = (meta or {}).get("description")
    if desc:
        obj["description"] = desc
    if owner:
        if names is None:
            names = _account_names([owner])
        obj["owner"] = {"id": owner, "name": names.get(owner, "")}
    return obj


def visible_rows(account: dict) -> list[tuple[dict, Optional[dict]]]:
    """Own playlists (newest first) then shared ones (newest first)."""
    metas = _all_meta()
    own, shared = [], []
    for row in nova_db.get_playlists():
        meta = metas.get(row["id"])
        owner = owner_of(meta)
        if owner is None:
            shared.append((row, meta))
        elif owner == account["id"]:
            own.append((row, meta))

    def created(item):
        row, meta = item
        return (meta or {}).get("created_at") or row.get("created_at") or ""

    own.sort(key=created, reverse=True)
    shared.sort(key=created, reverse=True)
    return own + shared


def list_wire(account: dict, offset: int = 0, limit: Optional[int] = None) -> tuple[list[dict], int]:
    items = visible_rows(account)
    total = len(items)
    page = items[offset:] if limit is None else items[offset:offset + limit]
    summaries = _summaries([r["id"] for r, _ in page])
    names = _account_names(owner_of(m) for _, m in page)
    return [to_wire(r, m, account, summaries[r["id"]], names) for r, m in page], total
