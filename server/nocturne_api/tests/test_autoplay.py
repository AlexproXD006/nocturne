"""Autoplay radio: scoring, exclusion, endpoint."""
from __future__ import annotations

import random
from collections import Counter
from datetime import datetime, timedelta, timezone

import pytest

from nocturne_api import autoplay as A


def T(i, artist="A", album="Al", **kw):
    return {"id": i, "title": i, "artist": artist, "album": album, "duration": 100, **kw}


def test_score_artist_featured_album():
    seed = T("s", artist="Bad Bunny, Drake", album="X")
    same_primary = T("a", artist="Bad Bunny")
    featured = T("b", artist="Rosalia, Drake")
    other = T("c", artist="Nobody", album="Y")
    same_album = T("d", artist="Nobody", album="X")
    sc = lambda c: A.score_track(seed, c)
    assert sc(same_primary) > sc(featured) > sc(same_album) > sc(other)
    assert sc(other) == 0


def test_score_optional_columns_and_cooccurrence():
    seed = T("s", genre="pop", year=2020, album_artist="Z")
    c = T("c", artist="Q", album="W", genre="Pop", year="2021", album_artist="z")
    assert A.score_track(seed, c) == pytest.approx(2 + 1.5 + 0.75)
    base = A.score_track(seed, T("o", artist="Q", album="W"))
    assert A.score_track(seed, T("o", artist="Q", album="W"), playlist_co=2) == pytest.approx(base + 2.4)
    assert A.score_track(seed, T("o", artist="Q", album="W"), play_co=99) == pytest.approx(base + 4.0)
    assert A.score_track(seed, T("o", artist="Q", album="W"), liked=True) == pytest.approx(base + 1)


def test_recent_repeat_penalty():
    seed = T("s")
    c = T("c")
    assert A.score_track(seed, c, recent_plays=1) < A.score_track(seed, c) - 3 + 1e-9


def test_cooccurrence_helpers():
    assert A.playlist_cooccurrence([["s", "a", "b"], ["s", "a"], ["x", "y"]], "s") == Counter({"a": 2, "b": 1})
    t0 = datetime(2026, 1, 1, 12, tzinfo=timezone.utc)
    plays = [("s", t0), ("a", t0 + timedelta(minutes=10)), ("b", t0 + timedelta(hours=3))]
    assert A.play_cooccurrence(plays, "s") == Counter({"a": 1})


def test_rank_excludes_seed_and_ids_and_caps_artist():
    seed = T("s", artist="A")
    cands = [T(f"a{i}", artist="A") for i in range(6)] + [T(f"b{i}", artist="B") for i in range(3)] + [seed]
    out = A.rank(seed, cands, exclude={"a0", "b0"}, playlist_co=Counter(), play_co=Counter(),
                 liked=set(), recent=Counter(), limit=6, rng=random.Random(1))
    ids = [c["id"] for c in out]
    assert "s" not in ids and "a0" not in ids and "b0" not in ids
    assert len(ids) == 6 and len(set(ids)) == 6
    assert sum(i.startswith("a") for i in ids[:5]) <= 3 + 1  # soft cap shows B early


def test_rank_prefers_cooccurring():
    seed = T("s", artist="A")
    cands = [T("x", artist="Q", album="1"), T("y", artist="R", album="2")]
    out = A.rank(seed, cands, exclude=set(), playlist_co=Counter({"y": 3}), play_co=Counter(),
                 liked=set(), recent=Counter(), limit=1, rng=random.Random(0))
    assert out[0]["id"] == "y"


def H(t):
    return {"Authorization": f"Bearer {t}"}


@pytest.mark.asyncio
async def test_radio_endpoint(client, user_token):
    r = await client.get("/radio?seed=track001&limit=5&exclude=track002", headers=H(user_token))
    assert r.status_code == 200
    ids = [t["id"] for t in r.json()["items"]]
    assert "track001" not in ids and "track002" not in ids
    r = await client.get("/radio?seed=track001&limit=5", headers=H(user_token))
    assert [t["id"] for t in r.json()["items"]] == ["track002"]
    assert (await client.get("/radio?seed=nope", headers=H(user_token))).status_code == 404
    assert (await client.get("/radio?seed=track001")).status_code == 401
    assert (await client.get("/radio?seed=track001&limit=0", headers=H(user_token))).status_code == 400
