"""
.lrc reviewer (nocturne_api/lrc_review.py), per-track lyrics offset and the admin
lyrics upload endpoints. LRCLIB HTTP is mocked; no network.
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from nocturne_api import lrc_review as rv
from nocturne_api import lyrics_auto as la
from .test_lyrics_auto import FakeLrclib, _add_track, _auto_row, lrclib, rec  # noqa: F401

REAL = "\n".join(f"[00:{i * 3 + 1:02d}.{(i * 37) % 100:02d}] line {i}" for i in range(12))
COARSE = "\n".join(f"[00:{i * 3 + 1:02d}] line {i}" for i in range(12)) + "\n[00:50] x"
GOOD_SYNCED = "\n".join(f"[00:{i * 3 + 1:02d}.{(i * 37) % 100:02d}] l{i}" for i in range(20))


def H(token):
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------- classification

def test_classify_kind():
    assert rv.classify_kind("just words\nno stamps") == rv.KIND_PLAIN
    assert rv.classify_kind("[by:NOVA Music Server]\n[00:00] a\n[00:10] b\n[00:20] c") == rv.KIND_FAKE
    assert rv.classify_kind(REAL) == rv.KIND_REAL


def test_flaws():
    assert rv.lrc_flaws(REAL, 60) == []
    assert "coarse_integer_seconds" in rv.lrc_flaws(COARSE, 60)
    grid = "\n".join(f"[00:{s:02d}.00] a" for s in (0, 10, 20, 30, 40, 50))
    assert "coarse_10s_grid" in rv.lrc_flaws(grid, 100)
    assert "coarse_10s_grid" not in rv.lrc_flaws("\n".join(f"[00:{s:02d}.12] a" for s in (0, 10, 20, 30, 40, 50)), 100)
    assert "last_timestamp_beyond_track_length" in rv.lrc_flaws(REAL, 20)
    assert "length_tag_mismatch" in rv.lrc_flaws("[length:03:30]\n" + REAL, 60)
    assert "fewer_timed_lines" in rv.lrc_flaws(REAL, 60, lrclib_lines=40)


def _res(synced=GOOD_SYNCED, delta=1, status=la.STATUS_FOUND):
    return la.LookupResult(status, synced=synced, breakdown={"duration_delta": delta})


def test_decide():
    assert rv.decide(COARSE, 60, _res())[0] == "prefer_auto"
    assert rv.decide(REAL, 60, _res(synced="\n".join(REAL.splitlines()[:12])))[:2] == ("keep_lrc", "lrc_looks_fine")
    assert rv.decide(COARSE, 60, _res(delta=5))[:2] == ("keep_lrc", "lrclib_duration_mismatch")
    assert rv.decide(COARSE, 60, _res(delta=None))[1] == "lrclib_duration_mismatch"
    assert rv.decide(COARSE, 60, _res(synced=None))[1] == "no_lrclib_synced"
    assert rv.decide(COARSE, 60, la.LookupResult(la.STATUS_NOT_FOUND))[1] == "no_lrclib_synced"
    assert rv.decide(COARSE, 60, None)[1] == "lrclib_error"


# ---------------------------------------------------------------- CLI + get_lyrics

def _mk(tmp_path, app):
    """library.db with three tracks (+ .lrc files) and a migrated nocturne.db copy."""
    from nocturne_api import config
    lib = tmp_path / "library.db"
    c = sqlite3.connect(lib)
    c.execute("CREATE TABLE tracks (id TEXT, title TEXT, artist TEXT, album TEXT, duration INTEGER, "
              "file_path TEXT, added_at TEXT)")
    for tid, lrc in (("a", COARSE), ("b", REAL), ("c", "[by:NOVA Music Server]\n[00:00] a\n[00:10] b")):
        (tmp_path / f"{tid}.lrc").write_text(lrc)
        c.execute("INSERT INTO tracks VALUES (?,?,?,?,?,?,?)",
                  (tid, "Happy Monday", "W Sound", None, 186, str(tmp_path / f"{tid}.mp3"), tid))
    c.commit()
    c.close()
    noc = tmp_path / "nocturne.db"
    noc.write_bytes(Path(config.DB_PATH).read_bytes())
    return lib, noc


def test_cli_dry_run_read_only_then_apply(tmp_path, lrclib, app):
    lrclib.records = [rec(1, "Happy Monday", "W Sound", 186, synced=GOOD_SYNCED)]
    lib, noc = _mk(tmp_path, app)
    lrcs = {p.name: p.read_text() for p in tmp_path.glob("*.lrc")}
    before = noc.read_bytes()
    out = tmp_path / "r.json"
    assert rv.main(["--report", str(out), "--library-db", str(lib), "--nocturne-db", str(noc)]) == 0
    rep = json.loads(out.read_text())
    by = {t["track_id"]: t for t in rep["tracks"]}
    assert by["a"]["decision"] == "prefer_auto" and by["a"]["lrc_kind"] == "real_synced"
    assert by["b"]["decision"] == "prefer_auto" and "fewer_timed_lines" in by["b"]["reason"]
    assert by["c"]["decision"] == "skip_fake_nova"
    assert rep["summary"]["prefer_auto"] == 2 and rep["summary"]["with_lrc"] == 3
    assert noc.read_bytes() == before and not list(tmp_path.glob("*.bak-lyrics-*"))

    assert rv.main(["--apply", "--library-db", str(lib), "--nocturne-db", str(noc)]) == 0
    assert len(list(tmp_path.glob("nocturne.db.bak-lyrics-*"))) == 1
    c = sqlite3.connect(noc)
    assert dict(c.execute("SELECT track_id, prefer_auto FROM v1_lyrics_prefs")) == {"a": 1, "b": 1}
    assert {r[0] for r in c.execute("SELECT track_id FROM v1_lyrics_auto")} >= {"a", "b"}
    c.close()
    assert {p.name: p.read_text() for p in tmp_path.glob("*.lrc")} == lrcs   # .lrc untouched


async def test_get_lyrics_prefer_auto(client, user_token, lrclib):
    from nocturne_api.db import connect
    tid = _add_track(lrc=COARSE)
    with connect() as c:
        c.execute("INSERT INTO v1_lyrics_auto (track_id,status,synced,fetched_at) VALUES (?,?,?,?)",
                  (tid, "found", "[00:01.50] auto", "2026-01-01T00:00:00+00:00"))
    r = await client.get(f"/tracks/{tid}/lyrics", headers=H(user_token))
    assert r.json()["synced"] == COARSE
    with connect() as c:
        c.execute("INSERT INTO v1_lyrics_prefs (track_id,prefer_auto,reason,decided_at) VALUES (?,1,'t','x')", (tid,))
    r = await client.get(f"/tracks/{tid}/lyrics", headers=H(user_token))
    assert r.json()["synced"] == "[00:01.50] auto"
    with connect() as c:  # admin lyrics still win
        c.execute("INSERT INTO v1_lyrics (track_id,format,content,updated_at) VALUES (?,?,?,?)",
                  (tid, "plain", "admin text", "x"))
    r = await client.get(f"/tracks/{tid}/lyrics", headers=H(user_token))
    assert r.json() == {"synced": None, "plain": "admin text", "ttml": None, "source": "admin", "offsetMs": 0}


# ---------------------------------------------------------------- offset

async def test_offset_endpoint(client, user_token, lrclib):
    tid = _add_track(lrc=REAL)
    url = f"/tracks/{tid}/lyrics/offset"
    r = await client.put(url, json={"offsetMs": 1500}, headers=H(user_token))
    assert r.status_code == 200 and r.json() == {"offsetMs": 1500}
    assert (await client.get(f"/tracks/{tid}/lyrics", headers=H(user_token))).json()["offsetMs"] == 1500
    r = await client.put(url, json={"offsetMs": -99999}, headers=H(user_token))
    assert r.json()["offsetMs"] == -30000
    r = await client.put(url, json={"offsetMs": 99999}, headers=H(user_token))
    assert r.json()["offsetMs"] == 30000
    r = await client.put(url, json={"offsetMs": 0}, headers=H(user_token))
    assert r.json()["offsetMs"] == 0


async def test_offset_requires_auth_and_track(client, user_token, lrclib):
    tid = _add_track(lrc=REAL)
    assert (await client.put(f"/tracks/{tid}/lyrics/offset", json={"offsetMs": 1})).status_code == 401
    r = await client.put("/tracks/nope/lyrics/offset", json={"offsetMs": 1}, headers=H(user_token))
    assert r.status_code == 404
    r = await client.put(f"/tracks/{tid}/lyrics/offset", json={"offsetMs": "x"}, headers=H(user_token))
    assert r.status_code in (400, 422)


# ---------------------------------------------------------------- admin lyrics

async def test_admin_lyrics_put_get_delete(client, admin_token, user_token, lrclib):
    tid = _add_track(lrc=REAL)
    url = f"/admin/tracks/{tid}/lyrics"
    # non-admin refused
    r = await client.put(url, json={"format": "plain", "content": "x"}, headers=H(user_token))
    assert r.status_code == 403
    r = await client.put(url, json={"format": "lrc", "content": "[00:01.00] hi"}, headers=H(admin_token))
    assert r.status_code == 204
    g = (await client.get(f"/tracks/{tid}/lyrics", headers=H(user_token))).json()
    assert g["synced"] == "[00:01.00] hi" and g["source"] == "admin"   # beats the .lrc file
    r = await client.put(url, json={"format": "plain", "content": "line one\nline two"}, headers=H(admin_token))
    assert r.status_code == 204
    g = (await client.get(f"/tracks/{tid}/lyrics", headers=H(user_token))).json()
    assert g["plain"] == "line one\nline two" and g["synced"] is None
    assert (await client.delete(url, headers=H(admin_token))).status_code == 204
    g = (await client.get(f"/tracks/{tid}/lyrics", headers=H(user_token))).json()
    assert g["synced"] == REAL                      # back to the .lrc file
    assert (await client.delete(url, headers=H(user_token))).status_code == 403


async def test_admin_lyrics_validation(client, admin_token, lrclib):
    tid = _add_track()
    url = f"/admin/tracks/{tid}/lyrics"
    h = H(admin_token)
    assert (await client.put(url, json={"format": "lrc", "content": "no stamps"}, headers=h)).status_code == 400
    assert (await client.put(url, json={"format": "plain", "content": "  "}, headers=h)).status_code == 400
    assert (await client.put(url, json={"format": "xml", "content": "a"}, headers=h)).status_code == 400
    big = "a" * (200 * 1024 + 1)
    assert (await client.put(url, json={"format": "plain", "content": big}, headers=h)).status_code == 413
    assert (await client.put("/admin/tracks/nope/lyrics", json={"format": "plain", "content": "a"},
                             headers=h)).status_code == 404
    assert (await client.put(url, json={"format": "lrc", "content": "[1:02] ok"}, headers=h)).status_code == 204
