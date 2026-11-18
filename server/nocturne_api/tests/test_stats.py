"""Tests for /stats/* aggregation, ranges, timezone week boundaries and artist images."""
from __future__ import annotations

import json
from datetime import date

import httpx
import pytest


TODAY = date(2026, 11, 18)  # Wednesday


def _uid(username):
    from nocturne_api.db import connect
    with connect() as c:
        return c.execute("SELECT id FROM v1_accounts WHERE username=?", (username,)).fetchone()["id"]


def _seed(uid, rows):
    from nocturne_api.db import connect
    with connect() as c:
        c.execute("DELETE FROM v1_plays WHERE user_id=?", (uid,))
        c.executemany("INSERT INTO v1_plays(user_id,track_id,played_at,seconds) VALUES (?,?,?,?)",
                      [(uid, *r) for r in rows])


@pytest.fixture(autouse=True)
def fixed_today(monkeypatch):
    from nocturne_api import routes_stats
    monkeypatch.setattr(routes_stats, "_today", lambda: TODAY)


def H(t):
    return {"Authorization": f"Bearer {t}"}


# ---- pure helpers ----------------------------------------------------------

def test_period_start_and_end():
    from nocturne_api import stats as S
    assert S.period_start("week", TODAY) == date(2026, 11, 16)
    assert S.period_start("week", TODAY, 1) == date(2026, 11, 9)
    assert S.period_start("month", TODAY, 0) == date(2026, 11, 1)
    assert S.period_start("month", TODAY, 11) == date(2025, 12, 1)
    assert S.period_start("month", date(2026, 1, 5), 1) == date(2025, 12, 1)
    assert S.period_start("year", TODAY, 1) == date(2025, 1, 1)
    assert S.period_end("week", date(2026, 11, 16)) == date(2026, 11, 23)
    assert S.period_end("month", date(2025, 12, 1)) == date(2026, 1, 1)


def test_timezone_week_boundary():
    from nocturne_api import stats as S
    # Monday 00:00 Madrid in winter (CET, UTC+1) is Sunday 23:00 UTC.
    assert S.to_utc_iso(date(2026, 11, 16)).startswith("2026-11-15T23:00:00")
    # In summer (CEST, UTC+2) it is 22:00 UTC.
    assert S.to_utc_iso(date(2026, 7, 6)).startswith("2026-07-05T22:00:00")
    plays = [{"played_at": "2026-11-15T23:30:00+00:00", "seconds": 60, "track_id": "x"}]
    b = S.bucketize(plays, {}, "week", [date(2026, 11, 9), date(2026, 11, 16)])
    assert [x["plays"] for x in b] == [0, 1]  # Sun 23:30 UTC == Mon 00:30 Madrid


def test_label_and_delta():
    from nocturne_api import stats as S
    assert S.period_label("week", date(2026, 11, 16)) == "Nov 16 – 22, 2026"
    assert S.period_label("month", date(2026, 11, 1)) == "November 2026"
    assert S.period_label("all", None) == "All time"
    assert S.delta({"minutes": 15, "plays": 3}, {"minutes": 10, "plays": 5}) == \
        {"minutes": 5.0, "minutesPct": 50.0, "plays": -2}
    assert S.delta({"minutes": 1, "plays": 1}, {"minutes": 0, "plays": 0})["minutesPct"] is None
    assert S.delta({"minutes": 1, "plays": 1}, None) is None


def test_seconds_fallback_to_duration():
    from nocturne_api import stats as S
    assert S.play_seconds({"track_id": "a", "seconds": 0}, {"a": 200}) == 200
    assert S.play_seconds({"track_id": "a", "seconds": 90}, {"a": 200}) == 90


# ---- endpoints -------------------------------------------------------------

@pytest.mark.asyncio
async def test_summary_week_and_previous(client, user_token):
    uid = _uid("testuser")
    _seed(uid, [
        ("track001", "2026-11-16T10:00:00+00:00", 120),
        ("track001", "2026-11-17T10:00:00+00:00", 60),
        ("track002", "2026-11-18T10:00:00+00:00", 180),
        ("track002", "2026-11-10T10:00:00+00:00", 60),   # previous week
        ("track001", "2026-11-15T22:59:00+00:00", 600),  # Sun 23:59 Madrid -> previous week
    ])
    r = await client.get("/stats/summary?range=week", headers=H(user_token))
    assert r.status_code == 200
    d = r.json()
    assert d["start"] == "2026-11-16" and d["end"] == "2026-11-23"
    assert d["totals"] == {"minutes": 6.0, "plays": 3, "distinctTracks": 2, "distinctArtists": 2}
    assert d["totals"]["minutes"] == 6.0
    assert d["previous"]["plays"] == 2 and d["previous"]["minutes"] == 11.0
    assert d["delta"]["minutes"] == -5.0
    assert d["topTracks"][0]["track"]["id"] == "track001"
    assert d["topTracks"][0]["plays"] == 2 and d["topTracks"][0]["minutes"] == 3.0
    assert d["topArtists"][0]["artist"]["name"] == "Test Artist"
    assert "image" in d["topArtists"][0]["artist"]
    assert d["topAlbums"][0]["album"]["title"] == "Test Album"

    r = await client.get("/stats/summary?range=week&offset=1&limit=1", headers=H(user_token))
    d = r.json()
    assert d["start"] == "2026-11-09" and d["totals"]["plays"] == 2 and len(d["topTracks"]) == 1


@pytest.mark.asyncio
async def test_summary_month_year_all(client, user_token):
    uid = _uid("testuser")
    _seed(uid, [
        ("track001", "2026-11-02T10:00:00+00:00", 60),
        ("track001", "2026-10-02T10:00:00+00:00", 120),
        ("track002", "2025-06-02T10:00:00+00:00", 60),
    ])
    m = (await client.get("/stats/summary?range=month", headers=H(user_token))).json()
    assert m["totals"]["plays"] == 1 and m["previous"]["plays"] == 1 and m["label"] == "November 2026"
    y = (await client.get("/stats/summary?range=year", headers=H(user_token))).json()
    assert y["totals"]["plays"] == 2 and y["previous"]["plays"] == 1
    a = (await client.get("/stats/summary?range=all&offset=3", headers=H(user_token))).json()
    assert a["totals"]["plays"] == 3 and a["previous"] is None and a["delta"] is None and a["offset"] == 0


@pytest.mark.asyncio
async def test_stats_per_user_and_auth(client, user_token, admin_token):
    _seed(_uid("testadmin"), [("track001", "2026-11-17T10:00:00+00:00", 600)])
    _seed(_uid("testuser"), [])
    d = (await client.get("/stats/summary?range=week", headers=H(user_token))).json()
    assert d["totals"]["plays"] == 0
    d = (await client.get("/stats/summary?range=week", headers=H(admin_token))).json()
    assert d["totals"]["plays"] == 1
    assert (await client.get("/stats/summary")).status_code in (401, 403)
    assert (await client.get("/stats/summary?range=decade", headers=H(user_token))).status_code in (400, 422)
    _seed(_uid("testadmin"), [])


@pytest.mark.asyncio
async def test_history_and_heatmap(client, user_token):
    _seed(_uid("testuser"), [
        ("track001", "2026-11-17T10:00:00+00:00", 120),
        ("track002", "2026-11-09T10:00:00+00:00", 60),
        ("track002", "2026-09-09T10:00:00+00:00", 60),
    ])
    d = (await client.get("/stats/history?period=week&count=4", headers=H(user_token))).json()
    starts = [i["start"] for i in d["items"]]
    assert starts == ["2026-10-26", "2026-11-02", "2026-11-09", "2026-11-16"]
    assert [i["minutes"] for i in d["items"]] == [0, 0, 1.0, 2.0]
    d = (await client.get("/stats/history?period=month&count=3", headers=H(user_token))).json()
    assert [i["start"] for i in d["items"]] == ["2026-09-01", "2026-10-01", "2026-11-01"]
    assert [i["plays"] for i in d["items"]] == [1, 0, 2]
    h = (await client.get("/stats/heatmap?range=all", headers=H(user_token))).json()
    assert len(h["minutes"]) == 7 and len(h["minutes"][0]) == 24
    assert h["minutes"][1][11] == 2.0  # Tuesday 11:00 Madrid
    _seed(_uid("testuser"), [])


# ---- artist images ---------------------------------------------------------

def _mock(calls, payload):
    def handler(request: httpx.Request):
        calls.append(str(request.url))
        return httpx.Response(200, json=payload)
    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_artist_image_cache_and_negative(client, user_token, monkeypatch):
    from nocturne_api import artist_images as AI
    from nocturne_api.db import connect
    monkeypatch.setattr(AI, "MIN_INTERVAL_S", 0)
    calls: list = []
    monkeypatch.setattr(AI, "_TRANSPORT", _mock(calls, {"data": [
        {"name": "Someone Else", "picture_xl": "https://cdn/x.jpg"},
        {"name": "test artist", "picture_xl": "https://cdn/ta.jpg"}]}))
    with connect() as c:
        c.execute("DELETE FROM v1_artist_images")
    t = (await client.get("/library/tracks/track001", headers=H(user_token))).json()
    aid = t["artists"][0]["id"]
    r = await client.get(f"/artists/{aid}/image", headers=H(user_token))
    assert r.json()["url"] == "https://cdn/ta.jpg"
    assert (await client.get(f"/artists/{aid}/image", headers=H(user_token))).json()["url"] == "https://cdn/ta.jpg"
    assert len(calls) == 1  # second answer from cache
    art = (await client.get(f"/artists/{aid}", headers=H(user_token))).json()
    assert art["image"] == "https://cdn/ta.jpg" and len(calls) == 1

    # negative cache
    calls.clear()
    monkeypatch.setattr(AI, "_TRANSPORT", _mock(calls, {"data": []}))
    t2 = (await client.get("/library/tracks/track002", headers=H(user_token))).json()
    aid2 = t2["artists"][0]["id"]
    assert (await client.get(f"/artists/{aid2}/image", headers=H(user_token))).json()["url"] is None
    assert (await client.get(f"/artists/{aid2}/image", headers=H(user_token))).json()["url"] is None
    assert len(calls) == 1
    # expire negative entry (> 7 days) -> refetched
    with connect() as c:
        c.execute("UPDATE v1_artist_images SET fetched_at='2020-01-01T00:00:00+00:00' WHERE artist_id=?", (aid2,))
    await client.get(f"/artists/{aid2}/image", headers=H(user_token))
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_artist_image_errors_and_404(client, user_token, monkeypatch):
    from nocturne_api import artist_images as AI
    monkeypatch.setattr(AI, "MIN_INTERVAL_S", 0)
    monkeypatch.setattr(AI, "_TRANSPORT", httpx.MockTransport(lambda r: httpx.Response(500)))
    assert await AI.get_artist_image("Broken Artist Zed") is None
    assert (await client.get("/artists/ar_nope/image", headers=H(user_token))).status_code == 404
