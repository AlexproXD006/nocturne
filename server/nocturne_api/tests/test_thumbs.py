"""Thumbnail cache for /media/art: bucket snapping, cache hit/miss, 304, content types."""
from __future__ import annotations

import io
import os
import sqlite3

import pytest
from PIL import Image

from nocturne_api import config, thumbs
from nocturne_api.signing import sign_art_url, _stable_art_exp
import database as nova_db


@pytest.fixture
def cover(tmp_path):
    p = tmp_path / "cover.jpg"
    Image.new("RGB", (800, 800), (200, 30, 90)).save(p, "JPEG")
    conn = sqlite3.connect(nova_db.DB_PATH)
    conn.execute("UPDATE tracks SET cover_path=? WHERE id='track001'", (str(p),))
    conn.commit(); conn.close()
    yield p
    conn = sqlite3.connect(nova_db.DB_PATH)
    conn.execute("UPDATE tracks SET cover_path=NULL WHERE id='track001'")
    conn.commit(); conn.close()


def art_path(s=None, tid="track001"):
    url = sign_art_url(tid, s)
    return url.replace("http://testserver/v1", "")


def test_snap_size():
    assert [thumbs.snap_size(x) for x in (1, 64, 65, 96, 100, 128, 300, 513, 5000)] == [64, 64, 96, 96, 128, 128, 384, 1024, 1024]


def test_art_exp_is_stable_and_long_lived():
    import time
    a = _stable_art_exp()
    assert a == _stable_art_exp()
    assert a - time.time() >= 6 * 86400


async def test_webp_when_accepted_miss_then_hit(client, cover):
    r1 = await client.get(art_path(100), headers={"Accept": "image/avif,image/webp,*/*"})
    assert r1.status_code == 200
    assert r1.headers["content-type"] == "image/webp"
    assert r1.headers["x-thumb-cache"] == "miss"
    assert "immutable" in r1.headers["cache-control"] and "31536000" in r1.headers["cache-control"]
    assert r1.headers["access-control-allow-origin"] == "*"
    assert "accept" in r1.headers["vary"].lower()
    im = Image.open(io.BytesIO(r1.content))
    assert im.size == (128, 128)  # 100 snapped to the 128 bucket
    r2 = await client.get(art_path(100), headers={"Accept": "image/webp"})
    assert r2.headers["x-thumb-cache"] == "hit"
    assert r2.content == r1.content
    # a size in the same bucket reuses the file
    r3 = await client.get(art_path(120), headers={"Accept": "image/webp"})
    assert r3.headers["x-thumb-cache"] == "hit"


async def test_jpeg_without_webp_accept(client, cover):
    r = await client.get(art_path(96), headers={"Accept": "image/jpeg"})
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    assert Image.open(io.BytesIO(r.content)).size == (96, 96)


async def test_conditional_304(client, cover):
    r = await client.get(art_path(64), headers={"Accept": "image/webp"})
    etag = r.headers["etag"]
    r2 = await client.get(art_path(64), headers={"Accept": "image/webp", "If-None-Match": etag})
    assert r2.status_code == 304 and r2.content == b""
    assert r2.headers["access-control-allow-origin"] == "*"


async def test_changed_cover_regenerates(client, cover):
    r1 = await client.get(art_path(64), headers={"Accept": "image/webp"})
    Image.new("RGB", (900, 900), (5, 200, 5)).save(cover, "JPEG")
    os.utime(cover, (1, 2))
    r2 = await client.get(art_path(64), headers={"Accept": "image/webp"})
    assert r2.headers["x-thumb-cache"] == "miss" and r2.content != r1.content


async def test_no_size_serves_original_and_bad_sig_rejected(client, cover):
    r = await client.get(art_path(None))
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    assert r.content == cover.read_bytes()
    assert "etag" in r.headers
    bad = await client.get("/media/art/track001?s=96&sig=bad&exp=9999999999")
    assert bad.status_code == 403


def test_thumbs_live_under_covers_dir(cover):
    res = thumbs.ensure_thumb(str(cover), 96, True)
    assert res and str(res[0]).startswith(str(thumbs.thumbs_dir())) and res[0].suffix == ".webp"
