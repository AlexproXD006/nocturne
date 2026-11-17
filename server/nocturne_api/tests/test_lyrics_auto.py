"""
Automatic LRCLIB lyrics (nocturne_api/lyrics_auto.py), the /tracks/{id}/lyrics
priority chain (admin v1_lyrics > .lrc file > v1_lyrics_auto / lazy lookup) and the
backfill CLI. All LRCLIB HTTP is mocked (httpx.MockTransport); no network.
"""
from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest

from nocturne_api import lyrics_auto as la

MESSY_TITLE = "W Sound 10 “HAPPY MONDAY” - Hades66, Westcol, Ovy On The Drums"
SYNCED = "[00:01.00] Oye\n[00:03.00] Happy Monday"
PLAIN = "Oye\nHappy Monday"


def rec(id_, title, artist, duration, synced=SYNCED, plain=PLAIN, instrumental=False, album=""):
    return {"id": id_, "name": title, "trackName": title, "artistName": artist, "albumName": album,
            "duration": float(duration), "instrumental": instrumental,
            "plainLyrics": plain, "syncedLyrics": synced}


HAPPY = rec(39996650, "Happy Monday", "W Sound", 186)


class FakeLrclib:
    """Very small LRCLIB imitation: /api/get (exact, ±2s) and /api/search."""

    def __init__(self, records=None, fail: str | None = None):
        self.records = list(records if records is not None else [HAPPY])
        self.fail = fail          # None | "network" | "500"
        self.calls: list[httpx.Request] = []
        self.gate: threading.Event | None = None

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        if self.gate is not None:
            self.gate.wait(5)
        if self.fail == "network":
            raise httpx.ConnectError("boom", request=request)
        if self.fail == "500":
            return httpx.Response(503, json={"message": "busy"})
        p = request.url.params
        low = lambda s: (s or "").lower().strip()  # noqa: E731
        if request.url.path == "/api/get":
            for r in self.records:
                if low(r["trackName"]) == low(p.get("track_name")) and \
                        low(r["artistName"]) == low(p.get("artist_name")) and \
                        (not p.get("duration") or abs(r["duration"] - float(p["duration"])) <= 2):
                    return httpx.Response(200, json=r)
            return httpx.Response(404, json={"code": 404, "name": "TrackNotFound"})
        if request.url.path == "/api/search":
            out = []
            for r in self.records:
                hay = low(r["trackName"] + " " + r["artistName"])
                if p.get("q"):
                    ok = all(w in hay for w in low(p["q"]).split())
                else:
                    ok = low(p.get("track_name")) in low(r["trackName"]) and \
                        (not p.get("artist_name") or low(p["artist_name"]) in low(r["artistName"]))
                if ok:
                    out.append(r)
            return httpx.Response(200, json=out)
        return httpx.Response(404)

    @property
    def n(self) -> int:
        return len(self.calls)


@pytest.fixture
def lrclib(monkeypatch):
    fake = FakeLrclib()
    monkeypatch.setattr(la, "_TRANSPORT", httpx.MockTransport(fake.handler))
    monkeypatch.setattr(la, "_sleep", lambda s: None)
    monkeypatch.setattr(la._LIMITER, "min_interval", 0.0)
    la._LIMITER.reset()
    la._inflight.clear()
    yield fake
    la._inflight.clear()


def T(title=MESSY_TITLE, artist="W Sound", duration=188, **kw):
    return dict({"id": "t-x", "title": title, "artist": artist, "album": None, "duration": duration}, **kw)


# ---------------------------------------------------------------------------
# Switches, cleaning -> query building
# ---------------------------------------------------------------------------

def test_lookups_disabled_under_testing_without_transport(monkeypatch):
    monkeypatch.setattr(la, "_TRANSPORT", None)
    assert os.environ.get("NOCTURNE_TESTING") == "1"
    assert la.lookups_enabled() is False


def test_query_building_cleans_messy_youtube_title():
    gs = la.build_guesses(MESSY_TITLE, "W Sound")
    assert gs[0].title == "HAPPY MONDAY"
    qs = la.build_queries(gs, 188, "W Sound")
    assert qs[0] == ("/api/get", {"track_name": "HAPPY MONDAY", "artist_name": "W Sound", "duration": 188})
    assert ("/api/search", {"track_name": "HAPPY MONDAY", "artist_name": "W Sound"}) in qs
    assert any(p == "/api/search" and "q" in q for p, q in qs)
    # no duplicate requests
    assert len(qs) == len({(p, tuple(sorted(q.items()))) for p, q in qs})


def test_extra_guesses_come_first():
    gs = la.build_guesses("DUKI x KHEA - HITBOY (Video Oficial)", "Duki",
                          extra_guesses=[{"title": "Hitboy", "artists": ["Duki", "Khea"], "label": "cover-report"}])
    assert gs[0].label == "cover-report" and gs[0].title == "Hitboy"
    assert la.build_queries(gs, 181, "Duki")[0][1]["track_name"] == "Hitboy"


# ---------------------------------------------------------------------------
# Scoring / acceptance
# ---------------------------------------------------------------------------

def _eval(record, duration=188, title=MESSY_TITLE, artist="W Sound"):
    gs = la.build_guesses(title, artist)
    return la.evaluate(la.LrcRecord.from_api(record), gs, duration, f"{title} {artist}")


def test_duration_window():
    assert _eval(rec(1, "Happy Monday", "W Sound", 184)).accepted          # Δ4
    e = _eval(rec(1, "Happy Monday", "W Sound", 183))                       # Δ5
    assert not e.accepted and "duration" in e.reason


def test_unknown_duration_needs_exact_title_and_artist():
    assert _eval(rec(1, "Happy Monday", "W Sound", 186), duration=None).accepted
    e = _eval(rec(1, "Happy Mondays Remastered", "W Sound", 186), duration=None)
    assert not e.accepted


def test_artist_and_version_mismatch_rejected():
    assert not _eval(rec(1, "Happy Monday", "Somebody Else", 187)).accepted
    e = _eval(rec(1, "Happy Monday (Remix)", "W Sound", 187))
    assert not e.accepted and e.reason == "version mismatch"


def test_reversed_guess_does_not_match_other_song_of_artist():
    # 'DUKI - Celosa' also yields the reversed guess title='DUKI'; it must not match 'Duki Troya'.
    e = _eval(rec(1, "duki troya", "Duki", 171), duration=171, title="DUKI - Celosa (Video Oficial)", artist="Duki")
    assert not e.accepted
    e = _eval(rec(2, "C.R.O - RUINAS", "MDBCrew", 200), duration=200,
              title="C.R.O ft. DUKI - BASURA (prod. Negro Dub)", artist="MDBCrew, C.R.O")
    assert not e.accepted
    assert _eval(rec(3, "Celosa", "Duki", 171), duration=171, title="DUKI - Celosa (Video Oficial)",
                 artist="Duki").accepted


def test_prefers_synced_over_plain(lrclib):
    lrclib.records = [rec(1, "Happy Monday", "W Sound", 188, synced=None),     # Δ0, plain only
                      rec(2, "Happy Monday", "W Sound", 185)]                  # Δ3, synced
    r = la.lookup(T())
    assert r.status == la.STATUS_FOUND and r.lrclib_id == 2 and r.synced == SYNCED
    assert r.response() == {"synced": SYNCED, "plain": None, "ttml": None}


def test_plain_only_result(lrclib):
    lrclib.records = [rec(1, "Happy Monday", "W Sound", 188, synced=None)]
    r = la.lookup(T())
    assert r.status == la.STATUS_FOUND and r.synced is None
    assert r.response() == {"synced": None, "plain": PLAIN, "ttml": None}


def test_instrumental(lrclib):
    lrclib.records = [rec(5, "Happy Monday", "W Sound", 188, synced=None, plain=None, instrumental=True)]
    r = la.lookup(T())
    assert r.status == la.STATUS_INSTRUMENTAL and r.response() == la.empty_response()
    # a matching record with lyrics wins over an instrumental flag
    lrclib.records.append(rec(6, "Happy Monday", "W Sound", 187))
    assert la.lookup(T()).status == la.STATUS_FOUND


def test_lookup_messy_title_end_to_end(lrclib):
    r = la.lookup(T())
    assert r.status == la.STATUS_FOUND and r.confidence >= 0.9
    assert r.matched_title == "Happy Monday" and r.lrclib_id == 39996650
    # first request is the exact /api/get with the cleaned title
    first = lrclib.calls[0]
    assert first.url.path == "/api/get" and first.url.params["track_name"] == "HAPPY MONDAY"
    assert first.headers["user-agent"].startswith("Nocturne/1.0 (https://github.com/")


def test_not_found_when_nothing_matches(lrclib):
    lrclib.records = [rec(1, "Other Song", "W Sound", 188)]
    r = la.lookup(T())
    assert r.status == la.STATUS_NOT_FOUND and r.storable


def test_network_errors_are_not_negative(lrclib):
    lrclib.fail = "network"
    r = la.lookup(T())
    assert r.status == la.STATUS_ERROR and not r.storable


def test_backoff_on_5xx_then_error(lrclib, monkeypatch):
    slept = []
    monkeypatch.setattr(la, "_sleep", lambda s: slept.append(s))
    lrclib.fail = "500"
    with pytest.raises(la.LrclibError):
        la._http_get_json("/api/get", {"track_name": "x", "artist_name": "y"})
    assert lrclib.n == la.MAX_RETRIES + 1 and slept == [2.0, 4.0]


# ---------------------------------------------------------------------------
# Endpoint priority + lazy lookup + negative cache
# ---------------------------------------------------------------------------

_counter = [0]


def _add_track(title=MESSY_TITLE, artist="W Sound", duration=188, lrc: str | None = None) -> str:
    _counter[0] += 1
    tid = f"lyr{_counter[0]:04d}"
    d = Path(tempfile.mkdtemp(prefix="nocturne_lyr_"))
    audio = d / f"{tid}.mp3"
    if lrc is not None:
        (d / f"{tid}.lrc").write_text(lrc, encoding="utf-8")
    conn = sqlite3.connect(os.environ["_NOVA_TEST_DB"])
    conn.execute("INSERT INTO tracks (id,title,artist,album,duration,file_path) VALUES (?,?,?,?,?,?)",
                 (tid, title, artist, None, duration, str(audio)))
    conn.commit()
    conn.close()
    return tid


def _auto_row(tid):
    from nocturne_api.db import connect
    with connect() as c:
        r = c.execute("SELECT * FROM v1_lyrics_auto WHERE track_id=?", (tid,)).fetchone()
        return dict(r) if r else None


async def _get(client, token, tid):
    r = await client.get(f"/tracks/{tid}/lyrics", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    return r.json()


async def test_endpoint_lazy_lookup_stores_and_reuses(client, user_token, lrclib):
    tid = _add_track()
    assert await _get(client, user_token, tid) == {"synced": SYNCED, "plain": None, "ttml": None}
    row = _auto_row(tid)
    assert row["status"] == "found" and row["lrclib_id"] == 39996650 and row["synced"] == SYNCED
    n = lrclib.n
    assert await _get(client, user_token, tid) == {"synced": SYNCED, "plain": None, "ttml": None}
    assert lrclib.n == n  # served from v1_lyrics_auto


async def test_endpoint_priority_admin_then_lrc_then_auto(client, user_token, lrclib):
    from nocturne_api.db import connect
    tid = _add_track(lrc="[00:00.00] from file")
    now = datetime.now(timezone.utc).isoformat()
    with connect() as c:
        c.execute("INSERT INTO v1_lyrics (track_id, format, content, updated_at) VALUES (?,?,?,?)",
                  (tid, "ttml", "<tt/>", now))
        c.execute("INSERT INTO v1_lyrics_auto (track_id,status,synced,fetched_at) VALUES (?,?,?,?)",
                  (tid, "found", "[00:00.00] auto", now))
    assert await _get(client, user_token, tid) == {"synced": None, "plain": None, "ttml": "<tt/>"}
    with connect() as c:
        c.execute("DELETE FROM v1_lyrics WHERE track_id=?", (tid,))
    assert (await _get(client, user_token, tid))["synced"] == "[00:00.00] from file"
    import database as nova_db
    Path(nova_db.get_track(tid)["file_path"]).with_suffix(".lrc").unlink()
    assert (await _get(client, user_token, tid))["synced"] == "[00:00.00] auto"
    assert lrclib.n == 0


async def test_endpoint_instrumental_is_not_refetched(client, user_token, lrclib):
    from nocturne_api.db import connect
    tid = _add_track()
    old = (datetime.now(timezone.utc) - timedelta(days=60)).isoformat()
    with connect() as c:
        c.execute("INSERT INTO v1_lyrics_auto (track_id,status,fetched_at) VALUES (?,?,?)",
                  (tid, "instrumental", old))
    assert await _get(client, user_token, tid) == la.empty_response()
    assert lrclib.n == 0


async def test_negative_cache_refetched_after_7_days(client, user_token, lrclib):
    from nocturne_api.db import connect
    fresh, stale = _add_track(), _add_track()
    now = datetime.now(timezone.utc)
    with connect() as c:
        c.execute("INSERT INTO v1_lyrics_auto (track_id,status,fetched_at) VALUES (?,?,?)",
                  (fresh, "not_found", (now - timedelta(days=6)).isoformat()))
        c.execute("INSERT INTO v1_lyrics_auto (track_id,status,fetched_at) VALUES (?,?,?)",
                  (stale, "not_found", (now - timedelta(days=8)).isoformat()))
    assert await _get(client, user_token, fresh) == la.empty_response()
    assert lrclib.n == 0
    assert (await _get(client, user_token, stale))["synced"] == SYNCED
    assert lrclib.n > 0 and _auto_row(stale)["status"] == "found"


async def test_endpoint_errors_return_empty_and_are_not_cached(client, user_token, lrclib):
    lrclib.fail = "network"
    tid = _add_track()
    assert await _get(client, user_token, tid) == la.empty_response()
    assert _auto_row(tid) is None


async def test_endpoint_stores_not_found(client, user_token, lrclib):
    lrclib.records = []
    tid = _add_track()
    assert await _get(client, user_token, tid) == la.empty_response()
    assert _auto_row(tid)["status"] == "not_found"


async def test_endpoint_without_lookups_returns_empty(client, user_token, monkeypatch):
    monkeypatch.setattr(la, "_TRANSPORT", None)
    tid = _add_track()
    assert await _get(client, user_token, tid) == la.empty_response()
    assert _auto_row(tid) is None


def test_inflight_guard_single_fetch(lrclib, app):
    tid = _add_track()
    lrclib.gate = threading.Event()
    track = T(id=tid)
    f1 = la.submit(track)
    f2 = la.submit(track)
    assert f1 is f2
    lrclib.gate.set()
    assert f1.result(10).status == la.STATUS_FOUND
    assert lrclib.n == 1  # one /api/get hit, the second submit joined it


# ---------------------------------------------------------------------------
# Backfill CLI
# ---------------------------------------------------------------------------

def _mk_dbs(tmp_path: Path):
    lib = tmp_path / "library.db"
    noc = tmp_path / "nocturne.db"
    c = sqlite3.connect(lib)
    c.execute("CREATE TABLE tracks (id TEXT PRIMARY KEY, title TEXT, artist TEXT, album TEXT, "
              "duration INTEGER, file_path TEXT, cover_path TEXT, added_at TEXT)")
    (tmp_path / "b.lrc").write_text("[00:00.00] x")
    rows = [("a", MESSY_TITLE, "W Sound", None, 188, str(tmp_path / "a.mp3"), None, "1"),
            ("b", "Has Lrc", "X", None, 100, str(tmp_path / "b.mp3"), None, "2"),
            ("c", "Admin One", "X", None, 100, str(tmp_path / "c.mp3"), None, "3"),
            ("d", "Nothing Here", "Nobody", None, 100, str(tmp_path / "d.mp3"), None, "4")]
    c.executemany("INSERT INTO tracks VALUES (?,?,?,?,?,?,?,?)", rows)
    c.commit()
    c.close()
    c = sqlite3.connect(noc)
    c.execute("CREATE TABLE v1_lyrics (track_id TEXT PRIMARY KEY, format TEXT, content TEXT, "
              "updated_at TEXT, updated_by TEXT)")
    c.execute("INSERT INTO v1_lyrics VALUES ('c','lrc','[00:00.00] admin','now',NULL)")
    from nocturne_api.db import _MIGRATIONS
    c.executescript(dict(_MIGRATIONS)[4])
    c.commit()
    c.close()
    return lib, noc


def test_backfill_dry_run_is_read_only(tmp_path, lrclib):
    from nocturne_api import lyrics_backfill as lb
    lib, noc = _mk_dbs(tmp_path)
    before = noc.read_bytes()
    out = tmp_path / "rep.json"
    assert lb.main(["--dry-run", "--report", str(out), "--library-db", str(lib), "--nocturne-db", str(noc)]) == 0
    rep = json.loads(out.read_text())
    by = {t["track_id"]: t for t in rep["tracks"]}
    assert by["a"]["decision"] == "found" and by["a"]["synced"] is True
    assert by["b"]["decision"] == "skip_lrc_file" and by["c"]["decision"] == "skip_admin"
    assert by["d"]["decision"] == "not_found"
    assert rep["stats"]["found_synced"] == 1 and rep["stats"]["not_found"] == 1
    assert noc.read_bytes() == before
    assert not list(tmp_path.glob("nocturne.db.bak-lyrics-*"))


def test_backfill_apply_stores_and_backs_up(tmp_path, lrclib):
    from nocturne_api import lyrics_backfill as lb
    lib, noc = _mk_dbs(tmp_path)
    assert lb.main(["--apply", "--library-db", str(lib), "--nocturne-db", str(noc)]) == 0
    assert len(list(tmp_path.glob("nocturne.db.bak-lyrics-*"))) == 1
    c = sqlite3.connect(noc)
    rows = dict(c.execute("SELECT track_id, status FROM v1_lyrics_auto").fetchall())
    c.close()
    assert rows == {"a": "found", "d": "not_found"}
    # second run skips tracks that already have an auto row
    n = lrclib.n
    out = tmp_path / "r2.json"
    lb.main(["--apply", "--report", str(out), "--library-db", str(lib), "--nocturne-db", str(noc)])
    assert lrclib.n == n
    assert json.loads(out.read_text())["stats"]["skip_auto_row"] == 2


# ---------------------------------------------------------------------------
# .lrc files written by NOVA with invented timings
# ---------------------------------------------------------------------------

FAKE_GRID = ("[ti:Castillo]\n[ar:X]\n[al:]\n[by:NOVA Music Server]\n\n"
             "[00:00] Jajaja\n[00:10] Vivo asombrado\n[00:20] Me hizo encontrarme\n")
NOVA_REAL = "[ti:19]\n[by:NOVA Music Server]\n\n[00:10.03] Ella baila\n[00:14.12] Anda con 18\n"


def test_classify_lrc():
    assert la.classify_lrc(FAKE_GRID) == la.LRC_FAKE                              # NOVA header + 10-s grid
    assert la.classify_lrc("[00:00] a\n[00:10] b\n[00:20] c") == la.LRC_FAKE     # grid without header
    assert la.classify_lrc("[by:NOVA Music Server]\n[00:03] a\n[00:11] b") == la.LRC_FAKE  # NOVA, no fractions
    assert la.classify_lrc("[ti:x]\nno timestamps at all") == la.LRC_FAKE
    assert la.classify_lrc(NOVA_REAL) == la.LRC_NOVA_SYNCED
    assert la.classify_lrc("[00:16.40] Castillo\n[00:19.95] de arena\n[00:24.10] y mar") == la.LRC_USER
    assert la.classify_lrc("[00:00.00] from file") == la.LRC_USER
    assert la.lrc_plain_text(FAKE_GRID) == "Jajaja\nVivo asombrado\nMe hizo encontrarme"


def test_fake_lrc_does_not_block_backfill_or_lookup(tmp_path):
    audio = tmp_path / "a.opus"
    (tmp_path / "a.lrc").write_text(FAKE_GRID, encoding="utf-8")
    assert la.has_lrc_file(str(audio)) is False
    (tmp_path / "a.lrc").write_text("[00:16.40] real\n[00:19.95] sync", encoding="utf-8")
    assert la.has_lrc_file(str(audio)) is True


async def test_endpoint_fake_lrc_loses_to_auto_and_is_plain_fallback(client, user_token, lrclib):
    from nocturne_api.db import connect
    tid = _add_track(lrc=FAKE_GRID)
    lrc_file = Path(__import__("database").get_track(tid)["file_path"]).with_suffix(".lrc")
    # the LRCLIB lookup (lazy) wins over the fake grid
    assert await _get(client, user_token, tid) == {"synced": SYNCED, "plain": None, "ttml": None}
    # nothing found anywhere -> the fake file's text as PLAIN lyrics
    tid2 = _add_track(title="Nada Que Ver", artist="Nadie", lrc=FAKE_GRID)
    assert await _get(client, user_token, tid2) == {
        "synced": None, "plain": "Jajaja\nVivo asombrado\nMe hizo encontrarme", "ttml": None}
    assert _auto_row(tid2)["status"] == "not_found"
    # NOVA file with real timings: below auto, but used as synced when auto has nothing
    tid3 = _add_track(title="Nada Que Ver", artist="Nadie", lrc=NOVA_REAL)
    with connect() as c:
        c.execute("INSERT INTO v1_lyrics_auto (track_id,status,fetched_at) VALUES (?,?,?)",
                  (tid3, "not_found", datetime.now(timezone.utc).isoformat()))
    assert (await _get(client, user_token, tid3))["synced"] == NOVA_REAL
    assert lrc_file.read_text(encoding="utf-8") == FAKE_GRID          # files are never modified


def test_downloader_no_longer_invents_timestamps(tmp_path):
    import downloader
    audio = tmp_path / "song.opus"
    assert downloader.save_lyrics_file(str(audio), "A", "T", "line one\nline two") is None
    assert not (tmp_path / "song.lrc").exists()
    p = downloader.save_lyrics_file(str(audio), "A", "T", "[00:01.20] line one\n[00:04.50] line two")
    assert p and "[00:01.20] line one" in (tmp_path / "song.lrc").read_text(encoding="utf-8")
