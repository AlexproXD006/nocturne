"""
GET /v1/info
GET /v1/home
GET /v1/search
GET /v1/users/me
"""
from __future__ import annotations

import os
import sys
# NOVA backend modules (database, downloader, ...) live in <server root>/backend.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

from fastapi import APIRouter, Depends, Query, HTTPException
from typing import Optional

from .auth import require_user, optional_user
from .mapping import track_to_wire, album_to_wire, playlist_to_wire, user_to_wire
from . import config

import database as nova_db

router = APIRouter(tags=["home"])


@router.get("/info")
async def server_info():
    # SPOTIPY_* (what spotipy/spotdl read) or the older SPOTIFY_* alias.
    has_spotify = bool(config.SPOTIFY_CLIENT_ID and config.SPOTIFY_CLIENT_SECRET)
    sources = []
    if has_spotify:
        sources.append("spotify")
    sources.append("youtube")

    return {
        "name": "Nocturne Music Server",
        "version": "1.0.0",
        "apiVersion": 1,
        "capabilities": {
            "lyrics": True,
            "likes": True,
            "scrobble": True,
            "admin": True,
            "connect": True,
            "playlists": True,
            "radio": True,
            "listenbrainz": True,
            "spotifyImport": has_spotify,
            "sources": sources,
            "uploadMaxBytes": config.UPLOAD_MAX_BYTES,
        },
    }


@router.get("/home")
async def home(account: dict = Depends(require_user)):
    from .routes_library import _liked_set

    liked = _liked_set(account["id"])

    new_tracks = nova_db.get_new_tracks(days=30, limit=20)
    top_tracks = nova_db.get_top_tracks(limit=20)
    unplayed = nova_db.get_unplayed_tracks(limit=20)
    recent = nova_db.get_recently_played_tracks(limit=20)
    # Only playlists this user may see (own + shared), already in wire format.
    from . import playlists as _pl
    playlists, _ = _pl.list_wire(account, 0, 10)

    sections = []

    if new_tracks:
        sections.append({
            "id": "new-tracks",
            "title": "Recently Added",
            "kind": "tracks",
            "items": [track_to_wire(t, liked=t["id"] in liked) for t in new_tracks],
        })

    if top_tracks:
        sections.append({
            "id": "top-tracks",
            "title": "Most Played",
            "kind": "tracks",
            "items": [track_to_wire(t, liked=t["id"] in liked) for t in top_tracks],
        })

    if unplayed:
        sections.append({
            "id": "unplayed",
            "title": "Never Played",
            "kind": "tracks",
            "items": [track_to_wire(t, liked=t["id"] in liked) for t in unplayed],
        })

    if recent:
        sections.append({
            "id": "recently-played",
            "title": "Recently Played",
            "kind": "tracks",
            "items": [track_to_wire(t, liked=t["id"] in liked) for t in recent],
        })

    if playlists:
        sections.append({
            "id": "playlists",
            "title": "Playlists",
            "kind": "playlists",
            "items": playlists,
        })

    return {"sections": sections}


@router.get("/search")
async def search(
    q: str = Query(..., min_length=1),
    account: dict = Depends(require_user),
):
    from .routes_library import _liked_set
    from .mapping import artist_to_wire

    liked = _liked_set(account["id"])

    # LIKE search (FTS index is broken: returns 0 rows for terms that exist)
    rows = nova_db.search_tracks(q)

    tracks = [track_to_wire(t, liked=t["id"] in liked) for t in rows[:20]]

    # Collect albums and artists from results
    seen_albums: set = set()
    seen_artists: set = set()
    albums = []
    artists_list = []

    for t in rows:
        a_str = t.get("artist", "")
        al_str = t.get("album", "")
        from .mapping import _parse_artists
        for a_name in _parse_artists(a_str):
            if a_name not in seen_artists:
                seen_artists.add(a_name)
                artists_list.append(artist_to_wire(a_name))
        if al_str and al_str not in seen_albums:
            seen_albums.add(al_str)

    # Also do album-level results
    all_albums = nova_db.get_all_albums()
    q_lower = q.lower()
    for r in all_albums:
        if q_lower in (r.get("album") or "").lower() or q_lower in (r.get("artist") or "").lower():
            al_rows = nova_db.get_album_tracks(r["album"], r["artist"])
            tid = al_rows[0]["id"] if al_rows else r.get("album", "")
            row_with_art = dict(r)
            row_with_art["track_id_for_art"] = tid
            if r.get("album") not in seen_albums:
                seen_albums.add(r.get("album"))
                albums.append(album_to_wire(row_with_art))

    return {
        "tracks": tracks,
        "albums": albums[:10],
        "artists": artists_list[:10],
        "playlists": [],
    }


# API.md specifies GET /v1/me; clients call it on session restore. It used to
# exist only as /users/me, so restores 404ed and the app lost the server info
# (and with it the Admin menu). Keep both paths.
@router.get("/me")
@router.get("/users/me")
async def get_me(account: dict = Depends(require_user)):
    return user_to_wire(account)
