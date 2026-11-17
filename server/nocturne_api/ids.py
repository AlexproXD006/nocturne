"""
Stable, deterministic IDs for entities that NOVA identifies only by name
(artists, albums). IDs are stored in v1_entities and are created on demand.
"""
from __future__ import annotations

import hashlib
import unicodedata
from typing import Optional

from .db import connect


def _normalise(name: str) -> str:
    return unicodedata.normalize("NFC", name.strip().casefold())


def _name_to_id(prefix: str, name: str) -> str:
    h = hashlib.sha256(_normalise(name).encode()).hexdigest()[:20]
    return f"{prefix}_{h}"


def artist_id(name: str) -> str:
    return _name_to_id("ar", name)


def album_id(title: str, artist: str) -> str:
    h = hashlib.sha256(f"{_normalise(title)}|{_normalise(artist)}".encode()).hexdigest()[:20]
    return f"al_{h}"


def ensure_artist(name: str) -> str:
    """Returns the canonical artist id, creating the entity row if needed."""
    aid = artist_id(name)
    key = _normalise(name)
    with connect() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO v1_entities(id, kind, name, artist_key) VALUES (?,?,?,?)",
            (aid, "artist", name.strip(), key),
        )
    return aid


def ensure_album(title: str, artist: str) -> str:
    """Returns the canonical album id, creating the entity row if needed."""
    aid = album_id(title, artist)
    with connect() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO v1_entities(id, kind, name, artist_key) VALUES (?,?,?,?)",
            (aid, "album", title.strip(), _normalise(artist)),
        )
    return aid


def lookup_entity(entity_id: str) -> Optional[dict]:
    with connect() as conn:
        row = conn.execute(
            "SELECT id, kind, name, artist_key FROM v1_entities WHERE id=?", (entity_id,)
        ).fetchone()
    return dict(row) if row else None
