"""
Maps NOVA database rows (sqlite3.Row / dict) to Nocturne wire types.
Only call these after the v1_* tables exist (after db.migrate()).
"""
from __future__ import annotations

import hashlib
import os
import re
from typing import Optional

from . import config
from .ids import ensure_artist, ensure_album, artist_id, album_id
from .signing import sign_art_url


# ---------------------------------------------------------------------------
# Artist string parsing
# ---------------------------------------------------------------------------

def _parse_artists(artist_str: Optional[str]) -> list[str]:
    """
    NOVA stores artists as a comma-joined string, sometimes with duplicates.
    Returns a deduplicated ordered list.
    """
    if not artist_str:
        return []
    seen: set[str] = set()
    result: list[str] = []
    for part in re.split(r"\s*,\s*", artist_str):
        part = part.strip()
        if part and part not in seen:
            seen.add(part)
            result.append(part)
    return result


def _artist_refs(artist_str: Optional[str]) -> list[dict]:
    names = _parse_artists(artist_str)
    return [{"id": ensure_artist(n), "name": n} for n in names]


def art_version(cover_path: Optional[str]) -> Optional[str]:
    """Short cache-busting token for a cover file: changes when path or mtime/size change."""
    if not cover_path:
        return None
    try:
        st = os.stat(cover_path)
    except OSError:
        return None
    raw = f"{cover_path}|{st.st_mtime_ns}|{st.st_size}".encode()
    return hashlib.sha1(raw).hexdigest()[:10]


def _art_images(track_id: str, cover_path: Optional[str]) -> list[dict]:
    if not cover_path or not os.path.exists(cover_path):
        return []
    v = art_version(cover_path)
    return [
        {"url": sign_art_url(track_id, 300, v), "width": 300, "height": 300},
        {"url": sign_art_url(track_id, 640, v), "width": 640, "height": 640},
    ]


# ---------------------------------------------------------------------------
# Track mapping
# ---------------------------------------------------------------------------

def track_to_wire(row, liked: bool = False) -> dict:
    """
    row: sqlite3.Row or dict with NOVA's tracks table columns.
    """
    track_id = row["id"]
    artist_str = row["artist"] if "artist" in row.keys() else None
    album_str = row["album"] if "album" in row.keys() else None

    album_ref = None
    if album_str:
        # Build an artist name for the album (first artist)
        artists = _parse_artists(artist_str)
        first_artist = artists[0] if artists else ""
        al_id = ensure_album(album_str, first_artist)
        album_ref = {"id": al_id, "title": album_str}

    return {
        "id": track_id,
        "title": row["title"] or "",
        "artists": _artist_refs(artist_str),
        "album": album_ref,
        "duration": row["duration"] or 0,
        "artwork": _art_images(track_id, row["cover_path"] if "cover_path" in row.keys() else None),
        "liked": liked,
    }


# ---------------------------------------------------------------------------
# Album mapping
# ---------------------------------------------------------------------------

def album_to_wire(row) -> dict:
    """row: result of an aggregate query with album, artist, track_count, cover_path, added_at."""
    album_name = row["album"] or ""
    artist_str = row["artist"] or ""
    artists = _parse_artists(artist_str)
    al_id = ensure_album(album_name, artists[0] if artists else "")

    # Use the cover of the first track in this album for art
    cover_path = row["cover_path"] if "cover_path" in row.keys() else None
    track_id_for_art = row["track_id_for_art"] if "track_id_for_art" in row.keys() else al_id

    artwork: list[dict] = []
    if cover_path and os.path.exists(cover_path):
        v = art_version(cover_path)
        artwork = [
            {"url": sign_art_url(track_id_for_art, 300, v), "width": 300, "height": 300},
            {"url": sign_art_url(track_id_for_art, 640, v), "width": 640, "height": 640},
        ]

    obj: dict = {
        "id": al_id,
        "title": album_name,
        "artists": [{"id": ensure_artist(n), "name": n} for n in artists],
        "artwork": artwork,
    }
    if "track_count" in row.keys():
        obj["trackCount"] = row["track_count"]
    return obj


# ---------------------------------------------------------------------------
# Artist mapping
# ---------------------------------------------------------------------------

def artist_to_wire(name: str, track_count: Optional[int] = None) -> dict:
    obj: dict = {
        "id": ensure_artist(name),
        "name": name,
        "artwork": [],
        "image": None,
    }
    return obj


# ---------------------------------------------------------------------------
# User mapping
# ---------------------------------------------------------------------------

def user_to_wire(row) -> dict:
    return {
        "id": row["id"],
        "username": row["username"] or "",
        "displayName": row["display_name"] or row["username"] or "",
        "role": row["role"] if "role" in row.keys() else "user",
    }


# ---------------------------------------------------------------------------
# Playlist mapping (NOVA playlists table)
# ---------------------------------------------------------------------------

def playlist_to_wire(row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"] or "",
        "artwork": [],
        "trackCount": row["track_count"] if "track_count" in row.keys() else None,
    }
