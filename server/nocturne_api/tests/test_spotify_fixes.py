"""Spotify import follow-ups: repeated songs, downloads that reuse an existing file,
post-processing (clean metadata / covers), repair + metadata + covers CLIs helpers,
downloader output detection. No network (httpx.MockTransport / fakes)."""
from __future__ import annotations

import asyncio
import io
import json
import os
import sqlite3
from pathlib import Path

import httpx
import pytest

from .test_spotify import (PL_ID, FakeDownloadManager, _connect, _nova_track, _track, _wait_worker,  # noqa: F401
                           _yt, fake_spotify, sp_config)


def _jpeg(px: int = 640) -> bytes:
    from PIL import Image
    out = io.BytesIO()
    Image.new("RGB", (px, px), (200, 20, 20)).save(out, format="JPEG")
    return out.getvalue()


class ReportingDownloadManager(FakeDownloadManager):
    """Like NOVA's fixed downloader: the job reports the exact library row; a video
    that was downloaded before reuses its existing row (no new track)."""

    def __init__(self, results, existing: dict[str, str] | None = None):
        super().__init__(results)
        self.existing = existing or {}

    async def download_youtube(self, url, title="", artist=""):
        self.downloads.append(url)
        job_id = f"job{len(self.downloads)}"
        self.jobs[job_id] = {"id": job_id, "status": "downloading", "title": title}

        async def finish():
            await asyncio.sleep(0.02)
            video = next(r for rs in self.results.values() for r in rs if r["url"] == url)
            tid = self.existing.get(video["id"])
            if not tid:
                tid = "yt_" + video["id"]
                _nova_track(tid, video["title"], video["channel"], video["duration"])
            self.jobs[job_id].update(status="done", title=video["title"], track_id=tid,
                                     file_path=f"/tmp/{tid}.opus")

        asyncio.get_running_loop().create_task(finish())
        return job_id


@pytest.mark.asyncio
async def test_import_repeats_same_song_other_id_and_reused_download(client, fake_spotify, monkeypatch):
    from nocturne_api import spotify_import
    from nocturne_api.db import connect
    _nova_track("lib_pitorro", "BAD BUNNY - PIToRRO DE COCO (Visualizer)", "Bad Bunny", 206)
    a1, a2 = "A" * 22, "a" * 21 + "2"            # same song, two Spotify ids (single + album)
    b1, b2 = "B" * 22, "b" * 21 + "2"            # new song, two ids, both need a download
    c1 = "C" * 22                                 # downloads a video whose file already exists
    fake_spotify.items = [
        _track(a1, "PIToRRO DE COCO", ["Bad Bunny"], 206),
        _track(b1, "Nueva", ["Artista"], 180),
        _track(a2, "PIToRRO DE COCO", ["Bad Bunny"], 206),
        _track(b2, "Nueva", ["Artista"], 181),
        _track(a1, "PIToRRO DE COCO", ["Bad Bunny"], 206),     # same id again
        _track(c1, "Otra", ["Artista"], 150),
    ]
    dm = ReportingDownloadManager({
        "Artista - Nueva": [_yt("nv", "Artista - Nueva (Video Oficial)", "Artista", 181)],
        "Artista - Otra": [_yt("ot", "Artista - Otra", "Artista - Topic", 150)],
    }, existing={"ot": "lib_otra"})
    _nova_track("lib_otra", "VID_20190101_grabacion", "Unknown", 150)  # unmatched title; the video file exists
    monkeypatch.setattr(spotify_import, "get_download_manager", lambda: dm)
    monkeypatch.setattr(spotify_import, "accept_library_match",
                        lambda s, b: s >= 0.85 and not b.get("version_mismatch") and b.get("title_sim", 0) > 0.99)

    h, _ = await _connect(client, "sp_repeats")
    r = await client.post("/spotify/imports", json={"playlist": PL_ID}, headers=h)
    await _wait_worker()
    d = (await client.get(f"/spotify/imports/{r.json()['id']}", headers=h)).json()
    assert d["status"] == "done", d
    assert d["failed"] == 0, d["failures"]
    assert d["total"] == 6 and d["matched"] + d["downloaded"] == 6
    assert dm.downloads == ["https://www.youtube.com/watch?v=nv", "https://www.youtube.com/watch?v=ot"]
    p = (await client.get(f"/playlists/{d['playlistId']}", headers=h)).json()
    assert [t["id"] for t in p["tracks"]] == ["lib_pitorro", "yt_nv", "lib_pitorro", "yt_nv", "lib_pitorro",
                                              "lib_otra"]
    with connect() as conn:
        m = dict(conn.execute("SELECT spotify_track_id, track_id FROM v1_spotify_track_map").fetchall())
        meta = conn.execute("SELECT name, artists FROM v1_spotify_track_meta WHERE spotify_track_id=?",
                            (b2,)).fetchone()
    assert m[a2] == m[a1] == "lib_pitorro" and m[b1] == m[b2] == "yt_nv" and m[c1] == "lib_otra"
    assert meta["name"] == "Nueva" and json.loads(meta["artists"]) == ["Artista"]


def test_find_downloaded_reuses_existing_claimed_row():
    from nocturne_api import spotify_import as si
    _nova_track("old_same", "C.R.O - Superstar (Video Oficial)", "C.R.O", 185)
    found, why = si._find_downloaded("C.R.O - Superstar (Video Oficial)", {"old_same"}, {"old_same"}, 185,
                                     "Superstar")
    assert why is None and found["id"] == "old_same"
    found, why = si._find_downloaded("whatever", {"old_same"}, set(), 185, track_id="old_same")
    assert found["id"] == "old_same"
    found, why = si._find_downloaded("whatever", {"old_same"}, set(), 300, track_id="old_same")
    assert found is None and "Duración" in why


def test_postprocess_sets_clean_metadata_cover_and_records_undo(monkeypatch):
    import cover_art as ca
    import database as nova_db
    from nocturne_api import spotify_import as si
    from nocturne_api.db import connect
    _nova_track("pp1", "Eladio Carrión, Peso Pluma - Tiffany (Visualizer) | DON KBRN", "Eladio Carrion", 200)
    fetched = []
    monkeypatch.setattr(ca, "fetch_cover_bytes", lambda url, min_px=500: (fetched.append(url) or _jpeg(), 640, 640,
                                                                          "image/jpeg"))
    meta = {"id": "S" * 22, "name": "Tiffany", "artists": ["Eladio Carrion", "Peso Pluma"], "album": "DON KBRN",
            "duration_ms": 200000, "image": "https://i.scdn.co/image/abc"}
    done = si.postprocess_track("pp1", meta, upgrade=False, lyrics=False)
    assert done == {"metadata": True, "cover": "spotify"}
    t = nova_db.get_track("pp1")
    assert (t["title"], t["artist"], t["album"]) == ("Tiffany", "Eladio Carrion, Peso Pluma", "DON KBRN")
    assert t["cover_path"].endswith("pp1.official.jpg") and os.path.exists(t["cover_path"])
    assert fetched == ["https://i.scdn.co/image/abc"]
    # second change keeps the ORIGINAL old values for undo; official cover is not replaced
    done = si.postprocess_track("pp1", dict(meta, name="Tiffany (Remix)"), upgrade=False, lyrics=False)
    assert done == {"metadata": True}
    with connect() as conn:
        u = conn.execute("SELECT * FROM v1_spotify_meta_undo WHERE track_id='pp1'").fetchone()
    assert u["old_title"].startswith("Eladio Carrión, Peso Pluma - Tiffany") and u["new_title"] == "Tiffany (Remix)"
    assert ca._host_allowed("https://i.scdn.co/image/abc")


def test_track_meta_and_metadata_change_roundtrip():
    from nocturne_api import spotify_catalog as sc
    m = sc.track_meta({"id": "x", "name": " Timeless (feat. Playboi Carti) ",
                       "artists": [{"name": "The Weeknd"}, {"name": "Playboi Carti"}],
                       "album": {"name": "Hurry Up Tomorrow", "images": [
                           {"url": "https://i.scdn.co/s", "width": 64}, {"url": "https://i.scdn.co/l", "width": 640}]},
                       "duration_ms": 256000, "external_ids": {"isrc": "USUG1"}})
    assert m["name"] == "Timeless (feat. Playboi Carti)" and m["image"] == "https://i.scdn.co/l"
    assert sc.artists_joined(m) == "The Weeknd, Playboi Carti" and m["isrc"] == "USUG1"
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE tracks (id TEXT PRIMARY KEY, title TEXT, artist TEXT, album TEXT)")
    conn.execute("INSERT INTO tracks VALUES ('t','The Weeknd, Playboi Carti - Timeless','The Weeknd',NULL)")
    row = {"id": "t", "title": "The Weeknd, Playboi Carti - Timeless", "artist": "The Weeknd", "album": None}
    ch = sc.metadata_change(row, m)
    assert ch["new_album"] == "Hurry Up Tomorrow"
    assert sc.apply_metadata_change(conn, ch)
    assert not sc.apply_metadata_change(conn, ch)              # guarded by old values
    assert sc.metadata_change(dict(row, title=ch["new_title"], artist=ch["new_artist"], album=ch["new_album"]),
                              m) is None
    assert sc.undo_metadata_change(conn, ch)
    assert conn.execute("SELECT title, artist, album FROM tracks").fetchone() == (
        "The Weeknd, Playboi Carti - Timeless", "The Weeknd", None)


@pytest.mark.asyncio
async def test_reader_falls_back_from_batch_to_single_tracks(sp_config, monkeypatch):
    from nocturne_api import spotify, spotify_catalog as sc
    from nocturne_api import config
    calls = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(f"{req.method} {req.url.path}")
        if req.url.host == "accounts.spotify.com":
            return httpx.Response(200, json={"access_token": "cc-SECRET", "expires_in": 3600})
        if req.url.path == "/v1/tracks":
            return httpx.Response(403, json={"error": {"status": 403, "message": "Forbidden"}})
        tid = req.url.path.rsplit("/", 1)[1]
        if tid == "missing0000000000000000":
            return httpx.Response(404, json={"error": {"status": 404, "message": "nope"}})
        return httpx.Response(200, json={"id": tid, "name": f"Song {tid[:3]}", "artists": [{"name": "X"}],
                                         "album": {"name": "Alb", "images": []}, "duration_ms": 1000})

    monkeypatch.setattr(spotify, "_transport", httpx.MockTransport(handler))
    r = sc.SpotifyReader(config.DB_PATH, persist_tokens=False)
    got = await r.tracks(["abc0000000000000000000", "missing0000000000000000", "local:zzz"])
    assert set(got) == {"abc0000000000000000000"} and r.track_mode == "cc/single"
    assert calls.count("POST /api/token") == 1 and "GET /v1/tracks" in calls


def test_find_ghosts_and_plan_playlist():
    from nocturne_api import spotify_repair as sr
    rows = [{"id": "real", "title": "Song", "artist": "A", "album": None, "duration": 200,
             "file_path": "/m/Song.opus"},
            {"id": "ghost", "title": "Song", "artist": "B", "album": None, "duration": None,
             "file_path": "/m/Song.temp.opus"},
            {"id": "other", "title": "Artista - Otra (Video Oficial)", "artist": "Artista", "album": None,
             "duration": 150, "file_path": "/m/Otra.opus"}]
    exists = {"/m/Song.opus", "/m/Otra.opus"}.__contains__
    assert sr.find_ghosts(rows, exists) == {"ghost": "real"}
    metas = {"s1": {"name": "Song", "artists": ["A"], "album": None, "duration_ms": 200000},
             "s2": {"name": "Song", "artists": ["A"], "album": None, "duration_ms": 201000},
             "s3": {"name": "Otra", "artists": ["Artista"], "album": None, "duration_ms": 150000},
             "s4": {"name": "Nada", "artists": ["Z"], "album": None, "duration_ms": 99000}}
    good = [r for r in rows if r["id"] != "ghost"]
    failures = [{"title": "Song", "artists": ["A"], "reason": "Descargada, pero no aparece en la biblioteca"}]
    res = sr.plan_playlist({"entries": ["s1", None, "s2", "s1", "s3", "s4"]}, metas, {"s1": "real"}, good,
                           ["real"], failures)
    assert res["resolved"]["s2"]["how"] == "same-song"
    assert res["resolved"]["s3"]["track_id"] == "other"
    assert res["desired"] == ["real", "real", "real", "other"]
    assert res["missing_occurrences"] == 3 and res["unresolved"] == ["s4"] and res["orphans"] == ["s2"]


def test_downloader_only_takes_its_own_final_file(tmp_path, monkeypatch):
    import downloader
    monkeypatch.setattr(downloader, "MUSIC_DIR", str(tmp_path))
    final = tmp_path / "Song.opus"
    final.write_bytes(b"x")
    (tmp_path / "Other.temp.opus").write_bytes(b"x")
    assert downloader._is_final_audio(str(final))
    for bad in ("Other.temp.opus", "a.webm.part", "cover.jpg", ".hidden.opus"):
        assert not downloader._is_final_audio(str(tmp_path / bad)), bad
    info = {"requested_downloads": [{"filepath": str(final)}, {"filepath": str(tmp_path / "gone.opus")}]}
    assert downloader._yt_output_files(info) == [str(final)]
    assert downloader._yt_output_files(None) == []


def test_lyrics_backfill_spotify_guesses():
    from nocturne_api import config, lyrics_backfill as lb
    from nocturne_api.db import connect
    with connect() as conn:
        conn.execute("INSERT OR REPLACE INTO v1_spotify_track_map VALUES ('L'||'1'||'x', 'lyr1', 'youtube', '2026-01-01')")
        conn.execute("INSERT OR REPLACE INTO v1_spotify_track_meta(spotify_track_id, name, artists, album,"
                     " duration_ms, updated_at) VALUES ('L1x', 'Secretos', '[\"C.R.O\", \"Kidd Keo\"]', 'Alb',"
                     " 160400, '2026-01-01')")
    g = lb.load_spotify_guesses(config.DB_PATH)
    assert g["lyr1"] == {"title": "Secretos", "artists": ["C.R.O", "Kidd Keo"], "album": "Alb", "duration": 160,
                         "label": "spotify"}


def test_covers_decision_prefers_store_art_then_spotify(monkeypatch):
    import cover_art as ca
    from nocturne_api import spotify_covers
    meta = {"name": "Secretos", "artists": ["C.R.O", "Kidd Keo"], "album": "Alb", "duration_ms": 160000,
            "image": "https://i.scdn.co/image/x"}
    t = {"track": {"id": "t1", "title": "C.R.O, Kidd Keo - Secretos (Video Oficial)", "artist": "C.R.O",
                   "duration": 161, "cover_path": None}, "spotify_id": "s", "meta": meta}
    seen = {}

    def fake_find(title, artist, duration, album):
        seen.update(title=title, artist=artist, duration=duration, album=album)
        c = ca.Candidate(source="deezer", title="Secretos", artists=["C.R.O"], album="Alb", duration_s=160,
                         art_url_max="https://e-cdns-images.dzcdn.net/x.jpg", art_px=1000)
        return ca.Match(ca.DECISION_APPLY, 0.97, c, None)

    monkeypatch.setattr(ca, "find_best_cover", fake_find)
    d = spotify_covers.decide_one(t)
    assert d["source"] == "deezer" and seen == {"title": "Secretos", "artist": "C.R.O, Kidd Keo",
                                                "duration": 161, "album": "Alb"}
    monkeypatch.setattr(ca, "find_best_cover", lambda *a, **k: ca.Match(ca.DECISION_REVIEW, 0.7, None, None))
    d = spotify_covers.decide_one(t)
    assert d["source"] == "spotify" and d["candidate"]["art_url_max"] == meta["image"]
    assert spotify_covers.decide_one(dict(t, meta=dict(meta, image=None)))["decision"] == "no_match"
