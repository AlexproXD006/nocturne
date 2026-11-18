"""Daily mixes: clustering, composition, cache, covers, endpoints, home shelf."""
from __future__ import annotations

import random
from collections import Counter
from datetime import datetime, timedelta, timezone

import pytest

from nocturne_api import mixes as M

NOW = datetime(2026, 11, 18, 12, tzinfo=timezone.utc)


def H(t):
    return {"Authorization": f"Bearer {t}"}


def T(i, artist, **kw):
    return {"id": i, "title": i, "artist": artist, "album": "Al-" + artist, "duration": 100, "cover_path": None, **kw}


def test_subtitle():
    assert M.subtitle(["A"]) == "Con A"
    assert M.subtitle(["A", "B"]) == "Con A y B"
    assert M.subtitle(["A", "B", "C", "D"]) == "Con A, B y C"


def test_sessionize_and_cooccurrence_and_clusters():
    t0 = NOW
    plays = [("a", t0), ("b", t0 + timedelta(minutes=5)), ("c", t0 + timedelta(hours=5)), ("d", t0 + timedelta(hours=5, minutes=3))]
    assert M.sessionize(plays) == [["a", "b"], ["c", "d"]]
    edges = M.artist_cooccurrence([["x", "y"], ["z", "w"]], [["x", "y", "q"]])
    assert edges["x"]["y"] == 2 and edges["x"]["q"] == 1 and "z" not in edges["x"]
    w = Counter({"x": 10, "z": 8, "y": 5, "w": 4})
    cl = M.cluster_artists(w, edges, max_clusters=2)
    assert cl[0][:2] == ["x", "y"]
    assert "z" in cl[1]
    assert sorted(a for c in cl for a in c) == ["w", "x", "y", "z"]


def test_build_daily_mix_ratio_and_order():
    rng = random.Random(1)
    by_artist = {"a": [T(f"a{i}", "A") for i in range(30)], "b": [T(f"b{i}", "B") for i in range(30)]}
    pool = by_artist["a"] + by_artist["b"] + [T(f"z{i}", "Z") for i in range(30)]
    plays = Counter({f"a{i}": 10 - i % 10 for i in range(20)})
    plays.update({f"b{i}": 3 for i in range(10)})
    rows = M.build_daily(["a", "b"], by_artist, pool, plays=plays, liked=set(), used=set(),
                         playlist_co=Counter(), play_co=Counter(), recent=Counter(), rng=rng)
    ids = [r["id"] for r in rows]
    assert 30 <= len(ids) <= 50 and len(set(ids)) == len(ids)
    fav = [i for i in ids if plays.get(i, 0) > 0]
    assert 0.5 <= len(fav) / len(ids) <= 0.75


def _uid(username):
    from nocturne_api.db import connect
    with connect() as c:
        return c.execute("SELECT id FROM v1_accounts WHERE username=?", (username,)).fetchone()["id"]


def _seed_library(n_artists=3, per=20):
    import database as nova_db
    conn = nova_db.connect()
    conn.execute("DELETE FROM tracks WHERE id LIKE 'mx%'")
    rows = []
    for a in range(n_artists):
        for i in range(per):
            rows.append((f"mx{a}_{i}", f"Song {a}-{i}", f"Artist{a}", f"Album{a}", 180, "/tmp/x.mp3", None,
                         f"2026-0{1 + a}-0{1 + i % 9}T00:00:00+00:00", None, None, None, None, i, None))
    conn.executemany("INSERT INTO tracks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    conn.commit()
    conn.close()


def _seed_plays(uid, rows):
    from nocturne_api.db import connect
    with connect() as c:
        c.execute("DELETE FROM v1_plays WHERE user_id=?", (uid,))
        c.execute("DELETE FROM v1_likes WHERE user_id=?", (uid,))
        c.execute("DELETE FROM v1_mixes WHERE user_id=?", (uid,))
        c.executemany("INSERT INTO v1_plays(user_id,track_id,played_at,seconds) VALUES (?,?,?,?)",
                      [(uid, t, d.isoformat(), 30) for t, d in rows])


@pytest.mark.asyncio
async def test_mixes_endpoints_and_cache(client, user_token):
    _seed_library()
    uid = _uid("testuser")
    now = datetime.now(timezone.utc)
    plays = []
    for a in range(3):
        for i in range(12):  # recent plays (this month), grouped in sessions per artist
            plays.append((f"mx{a}_{i}", now - timedelta(days=a + 1, minutes=i * 3)))
    for i in range(12, 16):  # old plays -> "Redescubre"
        plays.append((f"mx0_{i}", now - timedelta(days=80)))
    plays += [(f"mx1_{i}", now - timedelta(days=100 + i)) for i in range(12, 16)]
    _seed_plays(uid, plays)

    r = await client.get("/mixes", headers=H(user_token))
    assert r.status_code == 200
    items = r.json()["items"]
    ids = [m["id"] for m in items]
    assert ids[0] == "daily-1" and "month" in ids
    assert items[0]["name"] == "Mix diario 1" and items[0]["description"].startswith("Con ")
    assert items[0]["mix"] is True and items[0]["trackCount"] >= M.MIN_TRACKS

    d = await client.get("/mixes/daily-1", headers=H(user_token))
    assert d.status_code == 200
    body = d.json()
    assert len(body["tracks"]) == body["trackCount"] and body["tracks"][0]["id"]
    assert len({t["id"] for t in body["tracks"]}) == len(body["tracks"])
    assert (await client.get("/mixes/nope", headers=H(user_token))).status_code == 404

    # cache: same generated_at until forced or older than 24 h
    gen = items[0]["generatedAt"]
    assert (await client.get("/mixes", headers=H(user_token))).json()["items"][0]["generatedAt"] == gen
    r2 = await client.post("/mixes/refresh", headers=H(user_token))
    assert r2.status_code == 200 and r2.json()["items"][0]["generatedAt"] != gen
    from nocturne_api.db import connect
    with connect() as c:
        c.execute("UPDATE v1_mixes SET generated_at=? WHERE user_id=?", ((now - timedelta(hours=25)).isoformat(), uid))
    old = (await client.get("/mixes", headers=H(user_token))).json()["items"][0]["generatedAt"]
    assert old > (now - timedelta(hours=1)).isoformat()

    assert (await client.get("/mixes")).status_code == 401


@pytest.mark.asyncio
async def test_home_shelf_and_hidden_when_small(client, user_token):
    _seed_library()
    uid = _uid("testuser")
    now = datetime.now(timezone.utc)
    _seed_plays(uid, [(f"mx0_{i}", now - timedelta(days=1, minutes=i)) for i in range(12)]
                + [(f"mx1_{i}", now - timedelta(days=2, minutes=i)) for i in range(12)])
    h = (await client.get("/home", headers=H(user_token))).json()
    shelf = next(s for s in h["sections"] if s["id"] == "made-for-you")
    assert shelf["kind"] == "playlists" and shelf["items"][0]["mix"] is True
    assert h["sections"][0]["id"] == "made-for-you"

    # Tiny library, no history -> shelf hidden
    import database as nova_db
    conn = nova_db.connect()
    saved = [tuple(r) for r in conn.execute("SELECT * FROM tracks")]
    conn.execute("DELETE FROM tracks")
    conn.commit()
    conn.close()
    try:
        _seed_plays(uid, [])
        h = (await client.get("/home", headers=H(user_token))).json()
        assert all(s["id"] != "made-for-you" for s in h["sections"])
    finally:
        conn = nova_db.connect()
        conn.executemany(f"INSERT OR REPLACE INTO tracks VALUES ({','.join('?' * len(saved[0]))})", saved)
        conn.commit()
        conn.close()
        _seed_plays(uid, [])


@pytest.mark.asyncio
async def test_low_history_fallback_and_cover(client, user_token, tmp_path):
    from PIL import Image
    import database as nova_db
    _seed_library(2, 15)
    covers = []
    for i in range(4):
        p = tmp_path / f"c{i}.png"
        Image.new("RGB", (50, 80), (40 * i, 90, 200 - 40 * i)).save(p)
        covers.append(str(p))
    conn = nova_db.connect()
    for i, p in enumerate(covers):
        conn.execute("UPDATE tracks SET cover_path=? WHERE id=?", (p, f"mx{i % 2}_{i}"))
    conn.commit()
    conn.close()
    uid = _uid("testuser")
    _seed_plays(uid, [])  # no history
    items = (await client.get("/mixes", headers=H(user_token))).json()["items"]
    assert [m["id"] for m in items] == ["daily-1"]
    art = items[0]["artwork"]
    assert art and "/v1/media/mix-art/" in art[0]["url"]
    path = art[0]["url"].replace("http://testserver/v1", "")
    r = await client.get(path)
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    import io
    assert Image.open(io.BytesIO(r.content)).size == (640, 640)
    # tampered signature / traversal rejected
    assert (await client.get(path.replace("sig=", "sig=0"))).status_code == 403
    assert (await client.get("/media/mix-art/..%2f..%2fetc%2fpasswd?sig=a&exp=1")).status_code in (403, 404)
    conn = nova_db.connect()
    conn.execute("UPDATE tracks SET cover_path=NULL WHERE id LIKE 'mx%'")
    conn.commit()
    conn.close()
