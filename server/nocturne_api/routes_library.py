"""
/v1/library/* — tracks, albums, artists, playlists
/v1/tracks/{id}/liked, /v1/tracks/{id}/played
"""
from __future__ import annotations

import sys
import os
# NOVA backend modules (database, downloader, ...) live in <server root>/backend.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import Optional

from .auth import require_user
from .mapping import track_to_wire, album_to_wire, artist_to_wire, playlist_to_wire, _parse_artists
from .db import connect

import database as nova_db  # NOVA's database module

router = APIRouter(tags=["library"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _liked_set(user_id: str) -> set:
    with connect() as conn:
        rows = conn.execute(
            "SELECT track_id FROM v1_likes WHERE user_id=?", (user_id,)
        ).fetchall()
    return {r["track_id"] for r in rows}


def _paginate(items: list, offset: int, limit: int) -> dict:
    total = len(items)
    page = items[offset : offset + limit]
    return {"items": page, "offset": offset, "limit": limit, "total": total}


# ---------------------------------------------------------------------------
# Tracks
# ---------------------------------------------------------------------------

@router.get("/library/tracks")
async def list_liked_tracks(
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    account: dict = Depends(require_user),
):
    """Liked songs — most recently liked first (spec: GET /library/tracks)."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT track_id FROM v1_likes WHERE user_id=? ORDER BY liked_at DESC",
            (account["id"],),
        ).fetchall()
    track_ids = [r["track_id"] for r in rows]
    total = len(track_ids)
    page_ids = track_ids[offset : offset + limit]
    tracks = []
    for tid in page_ids:
        t = nova_db.get_track(tid)
        if t:
            tracks.append(track_to_wire(t, liked=True))
    return {"items": tracks, "offset": offset, "limit": limit, "total": total}


@router.get("/library/songs")
async def list_all_songs(
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    account: dict = Depends(require_user),
):
    """All songs in the library (not just liked) — alphabetical by title."""
    liked_set = _liked_set(account["id"])
    conn = nova_db.connect()
    try:
        rows = conn.execute(
            "SELECT * FROM tracks ORDER BY title COLLATE NOCASE"
        ).fetchall()
    finally:
        conn.close()
    tracks = [
        track_to_wire(t, liked=t["id"] in liked_set)
        for t in (dict(row) for row in rows)
    ]
    total = len(tracks)
    page = tracks[offset : offset + limit]
    return {"items": page, "offset": offset, "limit": limit, "total": total}


@router.get("/library/tracks/{track_id}")
async def get_track(track_id: str, account: dict = Depends(require_user)):
    row = nova_db.get_track(track_id)
    if not row:
        raise HTTPException(status_code=404, detail={"message": "Track not found.", "code": "not_found"})
    liked = _liked_set(account["id"])
    return track_to_wire(row, liked=track_id in liked)


# ---------------------------------------------------------------------------
# Albums
# ---------------------------------------------------------------------------

@router.get("/library/albums")
async def list_albums(
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    account: dict = Depends(require_user),
):
    rows = nova_db.get_all_albums()
    albums = []
    for r in rows:
        # get a track id for art signing
        tracks = nova_db.get_album_tracks(r["album"], r["artist"])
        tid = tracks[0]["id"] if tracks else r.get("album", "")
        row_with_art = dict(r)
        row_with_art["track_id_for_art"] = tid
        albums.append(album_to_wire(row_with_art))
    return _paginate(albums, offset, limit)


@router.get("/albums/{album_id}")
@router.get("/library/albums/{album_id}")
async def get_album(album_id: str, account: dict = Depends(require_user)):
    from .ids import lookup_entity
    entity = lookup_entity(album_id)
    if not entity or entity["kind"] != "album":
        raise HTTPException(status_code=404, detail={"message": "Album not found.", "code": "not_found"})

    # find album rows using the stored name
    album_name = entity["name"]
    # artist_key is the normalised artist; find matching artist name via tracks
    rows = nova_db.get_all_albums()
    matched = None
    for r in rows:
        from .ids import album_id as compute_album_id
        from .mapping import _parse_artists as pa
        artists = pa(r.get("artist", ""))
        first = artists[0] if artists else ""
        if compute_album_id(r["album"], first) == album_id:
            matched = r
            break

    if not matched:
        raise HTTPException(status_code=404, detail={"message": "Album not found.", "code": "not_found"})

    liked = _liked_set(account["id"])
    tracks_rows = nova_db.get_album_tracks(matched["album"], matched["artist"])
    tid = tracks_rows[0]["id"] if tracks_rows else album_id
    row_with_art = dict(matched)
    row_with_art["track_id_for_art"] = tid

    album_wire = album_to_wire(row_with_art)
    album_wire["tracks"] = [track_to_wire(t, liked=t["id"] in liked) for t in tracks_rows]
    total_dur = sum(t.get("duration") or 0 for t in tracks_rows)
    album_wire["totalDuration"] = total_dur
    return album_wire


# ---------------------------------------------------------------------------
# Artists
# ---------------------------------------------------------------------------

@router.get("/library/artists")
async def list_artists(
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    account: dict = Depends(require_user),
):
    rows = nova_db.get_all_artists()
    # NOVA groups by the raw multi-artist string; aggregate by individual artist.
    agg: dict = {}
    for r in rows:
        for name in _parse_artists(r["artist"]):
            agg[name] = agg.get(name, 0) + (r["track_count"] or 0)
    artists = [artist_to_wire(name, count) for name, count in sorted(agg.items(), key=lambda x: -x[1])]
    return _paginate(artists, offset, limit)


@router.get("/artists/{artist_id}")
@router.get("/library/artists/{artist_id}")
async def get_artist(artist_id: str, account: dict = Depends(require_user)):
    from .ids import lookup_entity
    entity = lookup_entity(artist_id)
    if not entity or entity["kind"] != "artist":
        raise HTTPException(status_code=404, detail={"message": "Artist not found.", "code": "not_found"})

    name = entity["name"]
    liked = _liked_set(account["id"])
    # NOVA's get_artist_tracks uses exact WHERE artist = ?, missing collaborations.
    # Fetch all tracks where `name` is one of the split artists.
    conn = nova_db.connect()
    try:
        raw = conn.execute(
            "SELECT * FROM tracks WHERE artist LIKE ?", (f"%{name}%",)
        ).fetchall()
    finally:
        conn.close()
    track_rows = [
        d for d in (dict(row) for row in raw)
        if name in _parse_artists(d.get("artist", ""))
    ]

    # Find artist's albums
    all_albums = nova_db.get_all_albums()
    artist_albums = []
    for r in all_albums:
        from .mapping import _parse_artists as pa
        if name in pa(r.get("artist", "")):
            tracks = nova_db.get_album_tracks(r["album"], r["artist"])
            tid = tracks[0]["id"] if tracks else name
            row_with_art = dict(r)
            row_with_art["track_id_for_art"] = tid
            artist_albums.append(album_to_wire(row_with_art))

    top_tracks = sorted(track_rows, key=lambda t: t.get("play_count") or 0, reverse=True)[:10]
    return {
        "id": artist_id,
        "name": name,
        "artwork": [],
        "topTracks": [track_to_wire(t, liked=t["id"] in liked) for t in top_tracks],
        "albums": artist_albums,
    }


# ---------------------------------------------------------------------------
# Playlists
# ---------------------------------------------------------------------------

@router.get("/library/playlists")
async def list_playlists(
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    account: dict = Depends(require_user),
):
    rows = nova_db.get_playlists()
    playlists = [playlist_to_wire(r) for r in rows]
    return _paginate(playlists, offset, limit)


@router.get("/playlists/{playlist_id}")
@router.get("/library/playlists/{playlist_id}")
async def get_playlist(playlist_id: str, account: dict = Depends(require_user)):
    row = nova_db.get_playlist(playlist_id)
    if not row:
        raise HTTPException(status_code=404, detail={"message": "Playlist not found.", "code": "not_found"})

    liked = _liked_set(account["id"])
    track_rows = nova_db.get_playlist_tracks(playlist_id)
    pl = playlist_to_wire(row)
    pl["tracks"] = [track_to_wire(t, liked=t["id"] in liked) for t in track_rows]
    pl["trackCount"] = len(track_rows)
    return pl


# ---------------------------------------------------------------------------
# Likes
# ---------------------------------------------------------------------------

@router.get("/library/liked")
async def list_liked(
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    account: dict = Depends(require_user),
):
    with connect() as conn:
        rows = conn.execute(
            "SELECT track_id FROM v1_likes WHERE user_id=? ORDER BY liked_at DESC",
            (account["id"],),
        ).fetchall()
    track_ids = [r["track_id"] for r in rows]
    total = len(track_ids)
    page_ids = track_ids[offset : offset + limit]
    tracks = []
    for tid in page_ids:
        t = nova_db.get_track(tid)
        if t:
            tracks.append(track_to_wire(t, liked=True))
    return {"items": tracks, "offset": offset, "limit": limit, "total": total}


@router.put("/library/tracks/{track_id}", status_code=204)
@router.put("/tracks/{track_id}/liked", status_code=204)
async def like_track(track_id: str, account: dict = Depends(require_user)):
    if not nova_db.get_track(track_id):
        raise HTTPException(status_code=404, detail={"message": "Track not found.", "code": "not_found"})
    from datetime import datetime, timezone
    with connect() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO v1_likes(user_id, track_id, liked_at) VALUES (?,?,?)",
            (account["id"], track_id, datetime.now(timezone.utc).isoformat()),
        )
    from fastapi import Response
    return Response(status_code=204)


@router.delete("/library/tracks/{track_id}", status_code=204)
@router.delete("/tracks/{track_id}/liked", status_code=204)
async def unlike_track(track_id: str, account: dict = Depends(require_user)):
    with connect() as conn:
        conn.execute(
            "DELETE FROM v1_likes WHERE user_id=? AND track_id=?",
            (account["id"], track_id),
        )
    from fastapi import Response
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Played (scrobble)
# ---------------------------------------------------------------------------

class PlayedBody(BaseModel):
    playedSeconds: Optional[float] = 0
    at: Optional[str] = None


@router.post("/tracks/{track_id}/played", status_code=204)
async def mark_played(
    track_id: str,
    body: PlayedBody,
    account: dict = Depends(require_user),
):
    if not nova_db.get_track(track_id):
        raise HTTPException(status_code=404, detail={"message": "Track not found.", "code": "not_found"})

    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()

    # Update NOVA's play count and last_played
    try:
        nova_db.update_track_play_count(track_id)
    except Exception:
        pass

    # Store in our plays table
    with connect() as conn:
        conn.execute(
            "INSERT INTO v1_plays(user_id, track_id, played_at, seconds) VALUES (?,?,?,?)",
            (account["id"], track_id, now, body.playedSeconds or 0),
        )
    from fastapi import Response
    return Response(status_code=204)
