"""
/v1/stats/summary, /v1/stats/history, /v1/stats/heatmap — per-user listening stats.
/v1/artists/{id}/image — Deezer artist photo (cached).
"""
from __future__ import annotations

import sys
from datetime import datetime
from typing import Literal, Optional

sys.path.insert(0, "/opt/music-server/backend")

from fastapi import APIRouter, Depends, HTTPException, Query

from . import stats as S
from .artist_images import get_artist_image, get_artist_images
from .auth import require_user
from .db import connect
from .ids import lookup_entity
from .mapping import _parse_artists, album_to_wire, artist_to_wire, track_to_wire

import database as nova_db

router = APIRouter(tags=["stats"])


def _track_rows(track_ids: set[str]) -> dict[str, dict]:
    rows: dict[str, dict] = {}
    ids = list(track_ids)
    if not ids:
        return rows
    conn = nova_db.connect()
    try:
        for i in range(0, len(ids), 500):
            chunk = ids[i : i + 500]
            q = ",".join("?" * len(chunk))
            for r in conn.execute(f"SELECT * FROM tracks WHERE id IN ({q})", chunk):
                d = dict(r)
                rows[d["id"]] = d
    finally:
        conn.close()
    return rows


def _meta(plays: list[dict]):
    rows = _track_rows({p["track_id"] for p in plays})
    durations = {tid: r.get("duration") or 0 for tid, r in rows.items()}
    artists_of = {tid: _parse_artists(r.get("artist")) for tid, r in rows.items()}
    return rows, durations, artists_of


def _album_key(row: dict) -> Optional[tuple[str, str]]:
    if not row.get("album"):
        return None
    a = _parse_artists(row.get("artist"))
    return (row["album"], a[0] if a else "")


def _today():
    return datetime.now(S.TZ).date()


def _range_totals(user_id: str, kind: str, offset: int):
    """(start, end, plays) for the period; start/end None for 'all'."""
    if kind == "all":
        start = end = None
    else:
        start = S.period_start(kind, _today(), offset)
        end = S.period_end(kind, start)
    with connect() as conn:
        plays = S.fetch_plays(conn, user_id, start, end)
    return start, end, plays


@router.get("/stats/summary")
async def stats_summary(
    range: Literal["week", "month", "year", "all"] = "week",
    offset: int = Query(0, ge=0, le=1000),
    limit: int = Query(10, ge=1, le=50),
    account: dict = Depends(require_user),
):
    uid = account["id"]
    start, end, plays = _range_totals(uid, range, offset)
    rows, durations, artists_of = _meta(plays)
    cur = S.totals(plays, durations, artists_of)

    prev = None
    if range != "all":
        _, _, pplays = _range_totals(uid, range, offset + 1)
        prows, pdur, part = _meta(pplays)
        prev = S.totals(pplays, pdur, part)

    top_tracks = []
    for tid, n, secs in S.group_by_key(plays, durations, lambda t: [t] if t in rows else [])[:limit]:
        top_tracks.append({"track": track_to_wire(rows[tid]), "plays": n, "minutes": S.minutes(secs)})

    art = S.group_by_key(plays, durations, lambda t: artists_of.get(t, []))[:limit]
    images = await get_artist_images([a[0] for a in art])
    top_artists = []
    for name, n, secs in art:
        w = artist_to_wire(name)
        w["image"] = images.get(name)
        top_artists.append({"artist": w, "plays": n, "minutes": S.minutes(secs)})

    def album_keys(t):
        k = _album_key(rows[t]) if t in rows else None
        return [k] if k else []

    first_track: dict[tuple[str, str], dict] = {}
    for p in plays:
        r = rows.get(p["track_id"])
        k = _album_key(r) if r else None
        if k and k not in first_track:
            first_track[k] = r
    top_albums = []
    for k, n, secs in S.group_by_key(plays, durations, album_keys)[:limit]:
        r = dict(first_track[k])
        r["track_id_for_art"] = r["id"]
        top_albums.append({"album": album_to_wire(r), "plays": n, "minutes": S.minutes(secs)})

    return {
        "range": range,
        "offset": 0 if range == "all" else offset,
        "start": start.isoformat() if start else None,
        "end": end.isoformat() if end else None,
        "label": S.period_label(range, start),
        "timezone": "Europe/Madrid",
        "totals": cur,
        "previous": prev,
        "delta": S.delta(cur, prev),
        "topTracks": top_tracks,
        "topArtists": top_artists,
        "topAlbums": top_albums,
    }


@router.get("/stats/history")
async def stats_history(
    period: Literal["week", "month"] = "week",
    count: int = Query(26, ge=1, le=120),
    account: dict = Depends(require_user),
):
    buckets = S.history_buckets(period, count, _today())
    with connect() as conn:
        plays = S.fetch_plays(conn, account["id"], buckets[0], None)
    _, durations, _ = _meta(plays)
    return {"period": period, "timezone": "Europe/Madrid",
            "items": S.bucketize(plays, durations, period, buckets)}


@router.get("/stats/heatmap")
async def stats_heatmap(
    range: Literal["week", "month", "year", "all"] = "year",
    offset: int = Query(0, ge=0, le=1000),
    account: dict = Depends(require_user),
):
    _, _, plays = _range_totals(account["id"], range, offset)
    _, durations, _ = _meta(plays)
    return {"range": range, "offset": offset, "timezone": "Europe/Madrid",
            "weekdays": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
            "minutes": S.heatmap(plays, durations)}


@router.get("/artists/{artist_id}/image")
async def artist_image(artist_id: str, account: dict = Depends(require_user)):
    ent = lookup_entity(artist_id)
    if not ent or ent["kind"] != "artist":
        raise HTTPException(status_code=404, detail={"message": "Artist not found.", "code": "not_found"})
    return {"id": artist_id, "name": ent["name"], "url": await get_artist_image(ent["name"])}
