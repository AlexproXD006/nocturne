"""
Autoplay / radio: library tracks similar to a seed track, for the user's
"Autoplay similar songs" setting. Pure scoring helpers + a DB-backed entry
point. GET /v1/radio lives in routes_radio.py.

Signals (library.db has no genre/year/album-artist columns on all installs, so
those are used only when the columns exist): same artist / featured artists,
same album, genre/year/album-artist when present, mood, playlist
co-occurrence, listening-session co-occurrence (v1_plays), likes, and a penalty
for tracks played recently.
"""
from __future__ import annotations

import math
import random
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Optional

from .mapping import _parse_artists

SESSION_WINDOW = timedelta(minutes=30)
RECENT_HOURS = 24
MAX_PER_ARTIST = 3


def _lc(s: Optional[str]) -> str:
    return (s or "").strip().casefold()


def artist_set(row: dict) -> set[str]:
    return {a.casefold() for a in _parse_artists(row.get("artist"))}


def primary_artist(row: dict) -> str:
    names = _parse_artists(row.get("artist"))
    return names[0].casefold() if names else ""


def _year(row: dict) -> Optional[int]:
    y = row.get("year")
    try:
        y = int(str(y)[:4])
    except (TypeError, ValueError):
        return None
    return y if 1000 < y < 3000 else None


def score_track(seed: dict, cand: dict, *, playlist_co: int = 0, play_co: int = 0,
                liked: bool = False, recent_plays: int = 0) -> float:
    """Similarity of `cand` to `seed` (higher = more similar). Pure."""
    s = 0.0
    sa, ca = artist_set(seed), artist_set(cand)
    if primary_artist(seed) and primary_artist(seed) == primary_artist(cand):
        s += 5.0
    elif sa & ca:
        s += 3.0  # featured / shared artist
    if _lc(seed.get("album")) and _lc(seed.get("album")) == _lc(cand.get("album")):
        s += 2.0
    if _lc(seed.get("album_artist")) and _lc(seed.get("album_artist")) == _lc(cand.get("album_artist")):
        s += 1.5
    if _lc(seed.get("genre")) and _lc(seed.get("genre")) == _lc(cand.get("genre")):
        s += 2.0
    ys, yc = _year(seed), _year(cand)
    if ys and yc and abs(ys - yc) <= 3:
        s += 1.0 - abs(ys - yc) * 0.25
    if _lc(seed.get("mood")) and _lc(seed.get("mood")) == _lc(cand.get("mood")):
        s += 1.5
    bs, bc = seed.get("bpm"), cand.get("bpm")
    if bs and bc and abs(bs - bc) <= 0.1 * bs:
        s += 0.5
    s += min(playlist_co, 5) * 1.2
    s += min(play_co, 5) * 0.8
    if liked:
        s += 1.0
    s += min(math.log1p(cand.get("play_count") or 0), 3) * 0.2
    if recent_plays:
        s -= 3.0 + min(recent_plays - 1, 3)
    return s


def playlist_cooccurrence(playlists: Iterable[Iterable[str]], seed_id: str) -> Counter:
    """How many of the given playlists contain both the seed and each other track."""
    c: Counter = Counter()
    for tracks in playlists:
        ids = set(tracks)
        if seed_id in ids:
            for t in ids - {seed_id}:
                c[t] += 1
    return c


def play_cooccurrence(plays: list[tuple[str, datetime]], seed_id: str,
                      window: timedelta = SESSION_WINDOW) -> Counter:
    """Tracks played within `window` of a play of the seed (same listening session)."""
    c: Counter = Counter()
    seeds = [t for tid, t in plays if tid == seed_id]
    if not seeds:
        return c
    for tid, t in plays:
        if tid == seed_id:
            continue
        if any(abs(t - st) <= window for st in seeds):
            c[tid] += 1
    return c


def rank(seed: dict, candidates: list[dict], *, exclude: set[str], playlist_co: Counter,
         play_co: Counter, liked: set[str], recent: Counter, limit: int,
         rng: Optional[random.Random] = None) -> list[dict]:
    """Best `limit` candidates: excluded/seed ids dropped, scored, artist-capped, then
    padded with liked/popular tracks when too few are related."""
    rng = rng or random.Random(0)
    skip = set(exclude) | {seed["id"]}
    scored = []
    for c in candidates:
        if c["id"] in skip:
            continue
        sc = score_track(seed, c, playlist_co=playlist_co.get(c["id"], 0),
                         play_co=play_co.get(c["id"], 0), liked=c["id"] in liked,
                         recent_plays=recent.get(c["id"], 0))
        scored.append((sc + rng.random() * 0.3, c))
    scored.sort(key=lambda x: (-x[0], x[1]["id"]))
    out: list[dict] = []
    per: Counter = Counter()
    deferred = []
    for sc, c in scored:
        if len(out) >= limit:
            break
        pa = primary_artist(c)
        if pa and per[pa] >= MAX_PER_ARTIST:
            deferred.append(c)
            continue
        per[pa] += 1
        out.append(c)
    for c in deferred:  # artist cap is soft: relax it when the library is small
        if len(out) >= limit:
            break
        out.append(c)
    return out


def _parse(ts: str) -> Optional[datetime]:
    try:
        d = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def similar_tracks(account: dict, seed_id: str, limit: int, exclude: set[str],
                   now: Optional[datetime] = None) -> Optional[tuple[dict, list[dict], set[str]]]:
    """(seed row, ranked rows, liked set) or None when the seed doesn't exist."""
    import database as nova_db
    from .db import connect
    from . import playlists as pl

    seed = nova_db.get_track(seed_id)
    if not seed:
        return None
    now = now or datetime.now(timezone.utc)
    conn = nova_db.connect()
    try:
        cands = [dict(r) for r in conn.execute("SELECT * FROM tracks")]
        visible = {row["id"] for row, _ in pl.visible_rows(account)}
        pls: dict[str, list[str]] = {}
        for r in conn.execute("SELECT playlist_id, track_id FROM playlist_tracks"):
            if r["playlist_id"] in visible:
                pls.setdefault(r["playlist_id"], []).append(r["track_id"])
    finally:
        conn.close()
    with connect() as c2:
        liked = {r["track_id"] for r in c2.execute(
            "SELECT track_id FROM v1_likes WHERE user_id=?", (account["id"],))}
        since = (now - timedelta(days=120)).isoformat()
        prow = c2.execute(
            "SELECT track_id, played_at FROM v1_plays WHERE user_id=? AND played_at>=? "
            "ORDER BY played_at", (account["id"], since)).fetchall()
    plays = [(r["track_id"], d) for r in prow if (d := _parse(r["played_at"]))]
    cutoff = now - timedelta(hours=RECENT_HOURS)
    recent = Counter(t for t, d in plays if d >= cutoff)
    ranked = rank(
        seed, cands, exclude=exclude,
        playlist_co=playlist_cooccurrence(pls.values(), seed_id),
        play_co=play_cooccurrence(plays, seed_id), liked=liked, recent=recent, limit=limit,
        rng=random.Random(seed_id + now.strftime("%Y%m%d%H")),
    )
    # A related-only list can be short in a small library: top up with liked/popular.
    if len(ranked) < limit:
        taken = {c["id"] for c in ranked} | exclude | {seed_id}
        rest = [c for c in cands if c["id"] not in taken and c["id"] not in recent]
        rest.sort(key=lambda c: (c["id"] not in liked, -(c.get("play_count") or 0), c["id"]))
        ranked += rest[: limit - len(ranked)]
    return seed, ranked, liked
