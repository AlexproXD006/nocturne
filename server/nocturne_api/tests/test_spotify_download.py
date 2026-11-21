"""Admin Spotify download without spotdl: URL parsing, metadata -> pipeline, dedupe, errors."""
from __future__ import annotations

import asyncio

import pytest

from nocturne_api import spotify, spotify_download as sd, spotify_import as si
from nocturne_api import spotify_catalog as sc

TID = "3DjGf2TjAmCGU67xgrYKxj"
AL = "1" * 22
PL = "2" * 22


def test_parse_ref_variants():
    assert sd.parse_ref(f"https://open.spotify.com/track/{TID}?si=abc") == ("track", TID)
    assert sd.parse_ref(f"https://open.spotify.com/intl-es/track/{TID}") == ("track", TID)
    assert sd.parse_ref(f"https://open.spotify.com/album/{AL}") == ("album", AL)
    assert sd.parse_ref(f"https://open.spotify.com/playlist/{PL}?x=1") == ("playlist", PL)
    assert sd.parse_ref(f"spotify:track:{TID}") == ("track", TID)
    assert sd.parse_ref(TID) == ("track", TID)
    assert sd.parse_ref("https://evil.example/track/" + TID) is None
    assert sd.parse_ref("https://open.spotify.com/artist/" + TID) is None
    assert sd.parse_ref("some free text") is None and sd.parse_ref("") is None and sd.parse_ref(None) is None


def test_reason_for_maps_spotify_errors():
    assert "no disponible" in sd.reason_for(spotify.SpotifyError("x", 401)).lower()
    assert "no encontró" in sd.reason_for(spotify.SpotifyError("x", 404)).lower()
    assert "exited non-zero" not in sd.reason_for(spotify.SpotifyError("boom", 500))
    assert "Spotify no disponible" in sd.reason_for(spotify.SpotifyError("boom", 500))


API_TRACK = {"id": TID, "name": "Song", "artists": [{"name": "Artist"}], "duration_ms": 200000,
             "album": {"name": "Album", "images": [{"url": "http://img/1", "width": 640}]}}


async def test_fetch_metas_track_uses_client_credentials(monkeypatch):
    calls = []

    async def fake_cc_get(path, params=None):
        calls.append(path)
        return API_TRACK

    monkeypatch.setattr(sd, "_cc_get", fake_cc_get)
    title, metas = await sd.fetch_metas("track", TID)
    assert calls == [f"/tracks/{TID}"] and title == "Song"
    assert metas[0]["artists"] == ["Artist"] and metas[0]["album"] == "Album" and metas[0]["duration_ms"] == 200000


async def test_album_tracks_get_album_name_and_cover(monkeypatch):
    async def fake_cc_get(path, params=None):
        return {"name": "Alb", "images": [{"url": "u", "width": 300}],
                "tracks": {"items": [{"id": "a" * 22, "name": "T1", "artists": [{"name": "X"}], "duration_ms": 1000}], "next": None}}

    monkeypatch.setattr(sd, "_cc_get", fake_cc_get)
    title, metas = await sd.fetch_metas("album", AL)
    assert title == "Alb" and metas[0]["album"] == "Alb" and metas[0]["image"] == "u"


async def test_download_ref_calls_pipeline_per_track(monkeypatch):
    metas = [sc.track_meta(API_TRACK), sc.track_meta({**API_TRACK, "id": "b" * 22, "name": "Two"})]
    seen = []

    async def fake_fetch(kind, sid):
        return "List", metas

    async def fake_dl(meta, dm=None, **kw):
        seen.append(meta["name"])
        if meta["name"] == "Two":
            raise si.DownloadFailed(si.NOT_FOUND_REASON)
        return "tid1", True

    monkeypatch.setattr(sd, "fetch_metas", fake_fetch)
    monkeypatch.setattr(si, "download_spotify_track", fake_dl)
    res = await sd.download_ref(f"https://open.spotify.com/playlist/{PL}", object())
    assert sorted(seen) == ["Song", "Two"]
    assert res["track_ids"] == ["tid1"] and res["downloaded"] == 1
    assert res["failures"][0]["reason"] == si.NOT_FOUND_REASON


async def test_download_ref_errors(monkeypatch):
    with pytest.raises(si.DownloadFailed, match="URL de Spotify"):
        await sd.download_ref("hello world")

    async def boom(kind, sid):
        raise spotify.SpotifyError("nope", 404)

    monkeypatch.setattr(sd, "fetch_metas", boom)
    with pytest.raises(si.DownloadFailed, match="no encontró"):
        await sd.download_ref(TID)

    async def fail_all(meta, dm=None, **kw):
        raise si.DownloadFailed(si.NOT_FOUND_REASON)

    async def ok(kind, sid):
        return "S", [sc.track_meta(API_TRACK)]

    monkeypatch.setattr(sd, "fetch_metas", ok)
    monkeypatch.setattr(si, "download_spotify_track", fail_all)
    with pytest.raises(si.DownloadFailed, match="No se encontró la versión de Spotify en YouTube"):
        await sd.download_ref(TID)


# --- pipeline: ranking, dedupe, duration verification -----------------------

def _yt(vid, title, channel, duration):
    return {"id": vid, "title": title, "channel": channel, "duration": duration,
            "url": f"https://www.youtube.com/watch?v={vid}"}


def _cand(name="Zyxwv Qpl", artist="Quentin Vortex", ms=228000):
    return si.spotify_candidate({"name": name, "artists": [{"name": artist}], "duration_ms": ms})


def test_rank_prefers_topic_then_audio_over_video_and_limits_duration():
    cand = _cand()
    res = [
        _yt("v", "Quentin Vortex - Zyxwv Qpl (Official Video)", "Quentin Vortex", 228),
        _yt("t", "Zyxwv Qpl", "Quentin Vortex - Topic", 228),
        _yt("a", "Quentin Vortex - Zyxwv Qpl (Official Audio)", "Quentin Vortex", 228),
        _yt("far", "Zyxwv Qpl", "Quentin Vortex - Topic", 235),          # different edit: > 3 s
        _yt("live", "Quentin Vortex - Zyxwv Qpl (Live)", "Quentin Vortex - Topic", 228),
    ]
    assert [r["id"] for r in si.rank_youtube(cand, res)] == ["t", "a", "v"]
    assert si.pick_youtube(cand, [res[3], res[4]]) is None


def test_video_only_still_accepted_when_no_master():
    res = [_yt("v", "Quentin Vortex - Zyxwv Qpl (Official Video)", "Quentin Vortex", 229)]
    assert si.pick_youtube(_cand(), res)["id"] == "v"


class FakeDM:
    def __init__(self, results, file_duration, title="Zyxwv Qpl"):
        self.results, self.file_duration, self.title = results, file_duration, title
        self.downloads, self.jobs, self.queries = [], {}, []

    async def search_youtube(self, query, limit=8):
        self.queries.append(query)
        return list(self.results)

    async def download_youtube(self, url, title="", artist=""):
        import database as db
        self.downloads.append(url)
        vid = url.rsplit("=", 1)[1]
        tid = "dl_" + vid
        dur = self.file_duration.get(vid, 228)
        conn = db.connect()
        with conn:
            conn.execute("INSERT OR REPLACE INTO tracks(id,title,artist,album,duration,file_path,added_at,play_count)"
                         " VALUES (?,?,?,?,?,?,?,0)", (tid, self.title, "Quentin Vortex", None, dur, f"/nonexistent/{tid}.opus", "2026-11-01"))
        conn.close()
        jid = f"j{len(self.downloads)}"
        self.jobs[jid] = {"status": "done", "track_id": tid, "file_path": f"/nonexistent/{tid}.opus", "title": self.title}
        return jid

    def get_job(self, jid):
        return self.jobs.get(jid)


@pytest.fixture
def no_post(monkeypatch):
    monkeypatch.setattr(si, "postprocess_track", lambda tid, meta, **kw: {})
    monkeypatch.setattr(si, "_write_audio_tags", lambda *a, **k: None)


META = {"id": "r" * 22, "name": "Zyxwv Qpl", "artists": ["Quentin Vortex"], "album": "Alb", "duration_ms": 228000, "image": None}


async def test_download_spotify_track_downloads_topic_and_maps(no_post):
    dm = FakeDM([_yt("v", "Quentin Vortex - Zyxwv Qpl (Official Video)", "Quentin Vortex", 228),
                 _yt("t", "Zyxwv Qpl", "Quentin Vortex - Topic", 228)], {})
    tid, new = await si.download_spotify_track(META, dm)
    assert new and tid == "dl_t" and dm.downloads == ["https://www.youtube.com/watch?v=t"]
    assert si._map_get([META["id"]]) == {META["id"]: "dl_t"}
    # dedupe: second call returns the existing track, no new download
    tid2, new2 = await si.download_spotify_track(META, dm)
    assert (tid2, new2) == ("dl_t", False) and len(dm.downloads) == 1


async def test_wrong_duration_file_is_discarded_and_next_candidate_tried(no_post, tmp_path):
    import database as db
    dm = FakeDM([_yt("t1", "Mmmbop Raven", "Quentin Vortex - Topic", 228),
                 _yt("a1", "Quentin Vortex - Mmmbop Raven (Official Audio)", "Quentin Vortex", 228)],
                {"t1": 240}, title="Mmmbop Raven")                       # the file is really 240 s: wrong edit
    meta = {**META, "id": "q" * 22, "name": "Mmmbop Raven"}
    tid, new = await si.download_spotify_track(meta, dm)
    assert tid == "dl_a1" and len(dm.downloads) == 2
    assert db.get_track("dl_t1") is None            # the wrong new download was removed


async def test_not_found_message(no_post):
    dm = FakeDM([_yt("x", "Plonk Strelitzia", "Quentin Vortex - Topic", 300)], {})
    with pytest.raises(si.DownloadFailed, match="No se encontró la versión de Spotify en YouTube"):
        await si.download_spotify_track({**META, "id": "z" * 22, "name": "Plonk Strelitzia"}, dm)
    assert dm.downloads == []


def test_autogenerated_upload_by_artist_channel_counts_as_master():
    cand = si.spotify_candidate({"name": "Zyxwv Qpl", "artists": [{"name": "Quentin Vortex"}], "duration_ms": 143194})
    res = [_yt("v", "Quentin Vortex - Zyxwv Qpl (Video Oficial)", "Quentin Vortex", 233),   # other edit
           _yt("m", "Zyxwv Qpl", "Quentin Vortex", 144)]
    assert [r["id"] for r in si.rank_youtube(cand, res)] == ["m"]
    assert si._yt_class(res[1], cand) == 2
