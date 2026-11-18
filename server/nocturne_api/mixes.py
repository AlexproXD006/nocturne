"""
"Hecho para ti": per-user daily mixes, cached in nocturne.db (v1_mixes).

  * "Mix diario 1..N" (up to 6): clusters of the user's top artists (plays of the
    last 90 days + likes). Artists are grouped by co-occurrence (same listening
    session / same playlist). Each mix is ~60% favourites (liked / most played
    tracks of the cluster) and ~40% related, less-played tracks ranked with the
    autoplay scorer (autoplay.score_track).
  * "Redescubre": liked or played tracks not played for 60+ days.
  * "Lo más escuchado este mes": the user's most played tracks of the last 30 days.

Users with little history get a library-wide popular/recent mix instead. Mixes
with fewer than MIN_TRACKS tracks are dropped (the Home shelf is hidden when no
mix remains). Covers are 2x2 collages rendered with Pillow into
<MUSIC_ROOT>/.covers/mixes/ and served through a signed route.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import random
import threading
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from . import config
from .autoplay import SESSION_WINDOW, _parse, artist_set, primary_artist, score_track
from .mapping import _parse_artists

logger = logging.getLogger("nocturne.mixes")

MAX_DAILY = 6
MIN_TRACKS = 10          # fewer tracks than this: the mix is dropped
DAILY_TARGET = 40        # 30-50 tracks per daily mix
DAILY_MIN = 30
LIST_MAX = 50
FAVOURITE_SHARE = 0.6
PLAY_DAYS = 90
REDISCOVER_DAYS = 60
MONTH_DAYS = 30
TTL = timedelta(hours=24)
CLUSTER_ARTISTS = 4
TOP_ARTISTS = 24
MIN_HISTORY = 10         # distinct played/liked tracks needed for personal mixes

_locks: dict[str, threading.Lock] = defaultdict(threading.Lock)


def covers_dir() -> Path:
    return Path(config.MUSIC_ROOT) / ".covers" / "mixes"


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# Pure building blocks
# ---------------------------------------------------------------------------

def artist_cooccurrence(sessions: list[list[str]], playlists: list[list[str]]) -> dict[str, Counter]:
    """Edge weights between artists that share a listening session or a playlist."""
    edges: dict[str, Counter] = defaultdict(Counter)
    for group in list(sessions) + list(playlists):
        names = sorted(set(group))
        for a in names:
            for b in names:
                if a != b:
                    edges[a][b] += 1
    return edges


def sessionize(plays: list[tuple[str, datetime]]) -> list[list[str]]:
    """Split time-ordered (track_id, time) plays into sessions (gap > SESSION_WINDOW)."""
    out: list[list[str]] = []
    cur: list[str] = []
    last: Optional[datetime] = None
    for tid, t in sorted(plays, key=lambda x: x[1]):
        if last is not None and t - last > SESSION_WINDOW:
            out.append(cur)
            cur = []
        cur.append(tid)
        last = t
    if cur:
        out.append(cur)
    return out


def cluster_artists(weights: Counter, edges: dict[str, Counter], max_clusters: int = MAX_DAILY,
                    size: int = CLUSTER_ARTISTS) -> list[list[str]]:
    """Greedy clustering: the heaviest unassigned artist seeds a cluster and pulls in the
    unassigned artists most related to it (then by own weight)."""
    order = [a for a, _ in sorted(weights.items(), key=lambda x: (-x[1], x[0]))]
    free = list(order)
    clusters: list[list[str]] = []
    while free and len(clusters) < max_clusters:
        seed = free.pop(0)
        cl = [seed]
        rel = sorted(free, key=lambda a: (-edges.get(seed, Counter()).get(a, 0), -weights[a], a))
        for a in rel:
            if len(cl) >= size:
                break
            if edges.get(seed, Counter()).get(a, 0) > 0 or len(clusters) + 1 >= max_clusters:
                cl.append(a)
                free.remove(a)
        clusters.append(cl)
    return clusters


def subtitle(artists: list[str]) -> str:
    a = artists[:3]
    if not a:
        return ""
    if len(a) == 1:
        return f"Con {a[0]}"
    return f"Con {', '.join(a[:-1])} y {a[-1]}"


def top_artists_of(rows: list[dict], n: int = 3) -> list[str]:
    c: Counter = Counter()
    display: dict[str, str] = {}
    for r in rows:
        names = _parse_artists(r.get("artist"))
        if names:
            c[names[0].casefold()] += 1
            display.setdefault(names[0].casefold(), names[0])
    return [display[k] for k, _ in sorted(c.items(), key=lambda x: (-x[1], x[0]))[:n]]


def build_daily(cluster: list[str], by_artist: dict[str, list[dict]], pool: list[dict], *, plays: Counter,
                liked: set[str], used: set[str], playlist_co: Counter, play_co: Counter,
                recent: Counter, rng: random.Random, target: int = DAILY_TARGET) -> list[dict]:
    """One mix: ~60% favourites of the cluster artists + ~40% related, less played tracks."""
    own = [t for a in cluster for t in by_artist.get(a, [])]
    own_ids = {t["id"] for t in own}
    fav_n = round(target * FAVOURITE_SHARE)

    def heat(t: dict) -> float:
        return plays.get(t["id"], 0) + (3 if t["id"] in liked else 0)

    favs = sorted((t for t in own if heat(t) > 0), key=lambda t: (-heat(t), t["id"]))
    favs = [t for t in favs if t["id"] not in used] + [t for t in favs if t["id"] in used]
    chosen: list[dict] = []
    per: Counter = Counter()
    for t in favs:  # cap per artist so one artist can't take the whole mix
        if len(chosen) >= fav_n:
            break
        pa = primary_artist(t)
        if per[pa] < max(4, fav_n // max(len(cluster), 1) + 2):
            per[pa] += 1
            chosen.append(t)
    taken = {t["id"] for t in chosen}

    # Related, less played: score against the cluster's hottest tracks.
    seeds = sorted((t for t in own if heat(t) > 0), key=lambda t: (-heat(t), t["id"]))[:3] or own[:1]
    scored = []
    for c in pool:
        if c["id"] in taken or c["id"] in used:
            continue
        sc = 0.0
        for s in seeds:
            sc = max(sc, score_track(s, c, playlist_co=playlist_co.get(c["id"], 0), play_co=play_co.get(c["id"], 0),
                                     liked=c["id"] in liked, recent_plays=recent.get(c["id"], 0)))
        # Prefer tracks the user has played little (own-artist unplayed tracks are welcome).
        sc -= min(plays.get(c["id"], 0), 5) * 0.4
        if c["id"] in own_ids:
            sc += 1.0
        scored.append((sc + rng.random() * 0.3, c))
    scored.sort(key=lambda x: (-x[0], x[1]["id"]))
    rel_n = target - len(chosen)
    related = [c for _, c in scored[:rel_n]]
    chosen_ids = taken | {c["id"] for c in related}
    if len(chosen) + len(related) < DAILY_MIN:  # small library: allow reused tracks / more favourites
        for t in favs + [c for _, c in scored[rel_n:]]:
            if len(chosen) + len(related) >= DAILY_MIN:
                break
            if t["id"] not in chosen_ids:
                related.append(t)
                chosen_ids.add(t["id"])
    # Interleave (favourite, favourite, related, ...) then lightly shuffle within windows.
    out: list[dict] = []
    fi, ri = iter(chosen), iter(related)
    f_left, r_left = len(chosen), len(related)
    while f_left or r_left:
        for _ in range(3):
            if f_left:
                out.append(next(fi)); f_left -= 1
        for _ in range(2):
            if r_left:
                out.append(next(ri)); r_left -= 1
    for i in range(0, len(out) - 4, 5):
        w = out[i:i + 5]
        rng.shuffle(w)
        out[i:i + 5] = w
    return out[:50]


# ---------------------------------------------------------------------------
# Data access
# ---------------------------------------------------------------------------

def _load(account: dict, now: datetime) -> dict:
    import database as nova_db
    from .db import connect
    from . import playlists as pl

    conn = nova_db.connect()
    try:
        tracks = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM tracks")}
        visible = {row["id"] for row, _ in pl.visible_rows(account)}
        pls: dict[str, list[str]] = {}
        for r in conn.execute("SELECT playlist_id, track_id FROM playlist_tracks"):
            if r["playlist_id"] in visible:
                pls.setdefault(r["playlist_id"], []).append(r["track_id"])
    finally:
        conn.close()
    with connect() as c2:
        liked = {r["track_id"] for r in c2.execute("SELECT track_id FROM v1_likes WHERE user_id=?", (account["id"],))}
        rows = c2.execute("SELECT track_id, played_at FROM v1_plays WHERE user_id=? ORDER BY played_at",
                          (account["id"],)).fetchall()
    allp = [(r["track_id"], d) for r in rows if (d := _parse(r["played_at"]))]
    return {"tracks": tracks, "playlists": pls, "liked": liked, "plays": allp}


def _cover_fingerprints(path: str, Image) -> tuple[str, str]:
    """(bytes hash, 16x16 quantised thumbnail hash): the second catches the same art re-encoded."""
    with open(path, "rb") as f:
        raw = hashlib.sha1(f.read()).hexdigest()
    with Image.open(path) as im:
        thumb = im.convert("RGB").resize((16, 16)).tobytes()
    return raw, hashlib.sha1(bytes(b >> 3 for b in thumb)).hexdigest()


def _distinct_covers(track_rows: list[dict], Image, limit: int = 4) -> list[str]:
    """Up to `limit` cover files that differ by path AND by image content (tracks of one album share art)."""
    seen_paths: set[str] = set()
    seen_hashes: set[str] = set()
    out: list[str] = []
    for t in track_rows:
        p = t.get("cover_path")
        if not p or p in seen_paths or not os.path.exists(p):
            continue
        seen_paths.add(p)
        try:
            h1, h2 = _cover_fingerprints(p, Image)
        except Exception:
            logger.warning("mix cover: unreadable %s", p)
            continue
        if h1 in seen_hashes or h2 in seen_hashes:
            continue
        seen_hashes.update((h1, h2))
        out.append(p)
        if len(out) >= limit:
            break
    return out


def _cover_collage(track_rows: list[dict], key: str) -> Optional[str]:
    """2x2 collage of four DISTINCT covers; with fewer than four, a single full-size cover."""
    try:
        from PIL import Image
    except ImportError:
        return None
    seen = _distinct_covers(track_rows, Image)
    size = 640
    canvas = Image.new("RGB", (size, size), (28, 28, 38))
    if seen:
        tiles = seen[:4] if len(seen) >= 4 else seen[:1]
        half = size if len(tiles) == 1 else size // 2
        for i, path in enumerate(tiles):
            try:
                with Image.open(path) as im:
                    im = im.convert("RGB")
                    w, h = im.size
                    m = min(w, h)
                    im = im.crop(((w - m) // 2, (h - m) // 2, (w + m) // 2, (h + m) // 2)).resize((half, half))
                canvas.paste(im, ((i % 2) * half, (i // 2) * half))
            except Exception:
                logger.warning("mix cover: unreadable %s", path)
    seen = seen[:4] if len(seen) >= 4 else seen[:1]
    digest = hashlib.sha1(("v2|" + "|".join(seen)).encode()).hexdigest()[:8]
    d = covers_dir()
    d.mkdir(parents=True, exist_ok=True)
    name = f"{key}-{digest}.jpg"
    for old in d.glob(f"{key}-*.jpg"):
        if old.name != name:
            try:
                old.unlink()
            except OSError:
                pass
    canvas.save(d / name, "JPEG", quality=85)
    return name


def _key(user_id: str, mix_id: str) -> str:
    return hashlib.sha1(f"{user_id}|{mix_id}".encode()).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------

def generate(account: dict, now: Optional[datetime] = None) -> list[dict]:
    """Compute the user's mixes: [{id, title, subtitle, tracks:[row, ...]}] (no I/O besides reads)."""
    now = now or _now()
    data = _load(account, now)
    tracks, liked, allp = data["tracks"], data["liked"] & set(data["tracks"]), data["plays"]
    allp = [(t, d) for t, d in allp if t in tracks]
    since90 = now - timedelta(days=PLAY_DAYS)
    p90 = [(t, d) for t, d in allp if d >= since90]
    plays90 = Counter(t for t, _ in p90)
    recent = Counter(t for t, d in allp if d >= now - timedelta(hours=24))
    rng = random.Random(f"{account['id']}{now.strftime('%Y%m%d')}")
    mixes: list[dict] = []

    known = set(plays90) | liked
    all_rows = list(tracks.values())

    # ---- daily mixes -------------------------------------------------------
    if len(known) >= MIN_HISTORY:
        weights: Counter = Counter()
        disp: dict[str, str] = {}
        for tid, n in plays90.items():
            for a in _parse_artists(tracks[tid].get("artist"))[:1]:
                weights[a.casefold()] += n
                disp.setdefault(a.casefold(), a)
        for tid in liked:
            for a in _parse_artists(tracks[tid].get("artist"))[:1]:
                weights[a.casefold()] += 2
                disp.setdefault(a.casefold(), a)
        top = Counter(dict(weights.most_common(TOP_ARTISTS)))
        art_of = lambda tid: primary_artist(tracks[tid])  # noqa: E731
        sessions = [[art_of(t) for t in s if art_of(t)] for s in sessionize(p90)]
        pl_art = [[art_of(t) for t in ids if t in tracks and art_of(t)] for ids in data["playlists"].values()]
        edges = artist_cooccurrence(sessions, pl_art)
        by_artist: dict[str, list[dict]] = defaultdict(list)
        for r in all_rows:
            for a in artist_set(r):
                by_artist[a].append(r)
        used: set[str] = set()
        for n, cl in enumerate(cluster_artists(top, edges), 1):
            cluster_ids = {t["id"] for a in cl for t in by_artist.get(a, [])}
            rel_artists = {b for a in cl for b in edges.get(a, {})} - set(cl)
            pool = [r for r in all_rows if r["id"] in cluster_ids or artist_set(r) & rel_artists]
            if len(pool) < DAILY_MIN:  # little related material: widen to the whole library
                pool = all_rows
            # playlist / session co-occurrence versus the cluster's hottest track
            hot = max(cluster_ids, key=lambda i: (plays90.get(i, 0) + (3 if i in liked else 0), i), default=None)
            from .autoplay import play_cooccurrence, playlist_cooccurrence
            pco = playlist_cooccurrence(data["playlists"].values(), hot) if hot else Counter()
            sco = play_cooccurrence(p90, hot) if hot else Counter()
            rows = build_daily(cl, by_artist, pool, plays=plays90, liked=liked, used=used,
                               playlist_co=pco, play_co=sco, recent=recent, rng=rng)
            if len(rows) < MIN_TRACKS:
                continue
            used |= {r["id"] for r in rows}
            mixes.append({"id": f"daily-{len(mixes) + 1}", "title": f"Mix diario {len(mixes) + 1}",
                          "subtitle": subtitle([disp.get(a, a.title()) for a in cl]), "tracks": rows})
    else:
        # Little history: library-wide popular + recent.
        pop = sorted(all_rows, key=lambda r: (-(r.get("play_count") or 0), r["id"]))[:20]
        new = sorted(all_rows, key=lambda r: (r.get("added_at") or ""), reverse=True)[:40]
        rows, seen = [], set()
        for r in pop + new:
            if r["id"] not in seen:
                seen.add(r["id"])
                rows.append(r)
        rows = rows[:DAILY_TARGET]
        rng.shuffle(rows)
        if len(rows) >= MIN_TRACKS:
            mixes.append({"id": "daily-1", "title": "Mix diario 1", "subtitle": subtitle(top_artists_of(rows)),
                          "tracks": rows})

    # ---- Redescubre --------------------------------------------------------
    last: dict[str, datetime] = {}
    cnt = Counter(t for t, _ in allp)
    for t, d in allp:
        last[t] = max(last.get(t, d), d)
    cutoff = now - timedelta(days=REDISCOVER_DAYS)
    old = [tid for tid in (set(last) | liked) if (tid not in last or last[tid] < cutoff)]
    old.sort(key=lambda i: (-(cnt.get(i, 0) + (3 if i in liked else 0)), i))
    rows = [tracks[i] for i in old[:LIST_MAX]]
    if len(rows) >= MIN_TRACKS:
        mixes.append({"id": "rediscover", "title": "Redescubre", "subtitle": subtitle(top_artists_of(rows)), "tracks": rows})

    # ---- Lo más escuchado este mes ----------------------------------------
    m = Counter(t for t, d in allp if d >= now - timedelta(days=MONTH_DAYS))
    rows = [tracks[i] for i, _ in sorted(m.items(), key=lambda x: (-x[1], x[0]))[:LIST_MAX]]
    if len(rows) >= MIN_TRACKS:
        mixes.append({"id": "month", "title": "Lo más escuchado este mes", "subtitle": subtitle(top_artists_of(rows)),
                      "tracks": rows})
    return mixes


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------

def _store(user_id: str, mixes: list[dict], now: datetime) -> None:
    from .db import connect
    rows = []
    for pos, m in enumerate(mixes):
        cover = None
        try:
            cover = _cover_collage(m["tracks"], _key(user_id, m["id"]))
        except Exception:
            logger.exception("mix cover failed")
        rows.append((user_id, m["id"], pos, m["title"], m["subtitle"],
                     json.dumps([t["id"] for t in m["tracks"]]), cover, now.isoformat()))
    with connect() as c:
        c.execute("DELETE FROM v1_mixes WHERE user_id=?", (user_id,))
        if rows:
            c.executemany("INSERT INTO v1_mixes(user_id,mix_id,position,title,subtitle,track_ids,cover,generated_at)"
                          " VALUES (?,?,?,?,?,?,?,?)", rows)
        else:  # remember an empty result so we don't regenerate on every request
            c.execute("INSERT INTO v1_mixes(user_id,mix_id,position,title,subtitle,track_ids,cover,generated_at)"
                      " VALUES (?,?,?,?,?,?,?,?)", (user_id, "_empty", 0, "", "", "[]", None, now.isoformat()))


def _cached(user_id: str) -> list[dict]:
    from .db import connect
    with connect() as c:
        return [dict(r) for r in c.execute("SELECT * FROM v1_mixes WHERE user_id=? ORDER BY position", (user_id,))]


def get_mixes(account: dict, *, force: bool = False, now: Optional[datetime] = None) -> list[dict]:
    """Cached mixes (rows of v1_mixes, `_empty` marker removed), regenerated when older than 24 h."""
    now = now or _now()
    uid = account["id"]
    with _locks[uid]:
        rows = _cached(uid)
        stale = force or not rows
        if not stale:
            gen = _parse(rows[0]["generated_at"])
            stale = gen is None or now - gen >= TTL
        if stale:
            _store(uid, generate(account, now), now)
            rows = _cached(uid)
    return [r for r in rows if r["mix_id"] != "_empty"]


def to_wire(row: dict, *, tracks: Optional[list[dict]] = None) -> dict:
    from .signing import sign_mix_art_url
    ids = json.loads(row["track_ids"])
    w = {
        "id": row["mix_id"],
        "name": row["title"],
        "description": row["subtitle"],
        "artwork": [],
        "trackCount": len(ids),
        "mix": True,
        "generatedAt": row["generated_at"],
    }
    if row.get("cover") and (covers_dir() / row["cover"]).exists():
        url = sign_mix_art_url(row["cover"])
        w["artwork"] = [{"url": url, "width": 640, "height": 640}]
    return w
