"""Tests for official cover-art matching (backend/cover_art.py), art URL cache
busting, and admin upload filename handling. No network access."""
from __future__ import annotations

import io
import os
import struct
import wave
from pathlib import Path

import pytest

import cover_art as ca
from cover_art import Candidate, Guess


# ---------------------------------------------------------------------------
# clean_query
# ---------------------------------------------------------------------------

def _first(title, artist=None, album=None) -> Guess:
    gs = ca.clean_query(title, artist, album)
    assert gs, f"no guesses for {title!r}"
    return gs[0]


def _has(gs, title, artist=None):
    for g in gs:
        if ca.norm(g.title) == ca.norm(title) and (
            artist is None or any(ca._compact(a) == ca._compact(artist) for a in g.artists)):
            return True
    return False


def test_clean_artist_title_with_noise_and_album_suffix():
    g = _first("Bad Bunny - Un Verano Sin Ti (360° Visualizer) | Un Verano Sin Ti", "Bad Bunny")
    assert g.title == "Un Verano Sin Ti"
    assert g.artists[0] == "Bad Bunny"
    assert g.album_hint == "Un Verano Sin Ti"


def test_clean_three_part_title_with_feat():
    g = _first("Lucho SSJ - Lucho SSJ ft. Duki - Perdoname Si Llego Tarde (Videoclip Oficial)", "Lucho SSJ")
    assert g.title == "Perdoname Si Llego Tarde"
    assert "Duki" in g.artists and "Lucho SSJ" in g.artists


def test_clean_upload_timestamp_prefix_and_prod():
    g = _first("1777975625411_More Remix 2 ft Cris MJ, Jere Klein & Standly (Prod. Diegohh)", None)
    assert g.title.startswith("More Remix 2") or g.title == "More Remix 2"
    assert "1777975625411" not in g.title
    assert {"Cris MJ", "Jere Klein", "Standly"} <= set(g.artists)
    assert "remix" in g.versions


def test_clean_quoted_title_and_channel_artist_ignored():
    gs = ca.clean_query("W Sound 10 “HAPPY MONDAY” - Hades66, Westcol, Ovy On The Drums", "W Sound")
    assert _has(gs, "HAPPY MONDAY", "Westcol")
    gs = ca.clean_query("Kidd Keo - \"Y Que Si No Hay Amor?\" 2016 - (Official Video)", "Kidd Keo")
    assert _has(gs, "Y Que Si No Hay Amor?", "Kidd Keo")
    assert all("2016" not in g.artists for g in gs)


@pytest.mark.parametrize("artist", ["Genius", "MUEVA Records", "TrapUrbanoTv Music", "ElAlfaElJefeTV",
                                    "Lyrical Lemonade", "Bad Bunny - Topic", "SomeoneVEVO", None, ""])
def test_channel_artists(artist):
    assert ca.is_channel_artist(artist)


@pytest.mark.parametrize("artist", ["Duki", "Bad Bunny", "C.R.O", "Eladio Carrion", "YSY A"])
def test_real_artists_not_channels(artist):
    assert not ca.is_channel_artist(artist)


def test_clean_pipe_artist_title_and_x_separators():
    assert _has(ca.clean_query("Anuel AA | KEII", "Anuel AA"), "KEII", "Anuel AA")
    g = _first("Tokischa x Anuel AA x Ñengo Flow - Delincuente [Official Video]", "Tokischa")
    assert g.title == "Delincuente" and {"Tokischa", "Anuel AA", "Ñengo Flow"} <= set(g.artists)
    gs = ca.clean_query("Anuel AA ❌ Eladio Carrión | North Carolina", "Anuel AA")
    assert _has(gs, "North Carolina", "Eladio Carrión")


def test_clean_bzrp_sessions():
    g = _first("C.R.O || BZRP Music Sessions #29/66", "Bizarrap")
    assert "Vol. 29" in g.title and "Bizarrap" in g.artists and "C.R.O" in g.artists


def test_clean_nickname_quote_not_title():
    gs = ca.clean_query('Si Te Dejas Llevar - Ozuna & Juanka "El Problematik" ( Video Oficial )', "NazzaTV")
    assert _has(gs, "Si Te Dejas Llevar", "Ozuna")


# ---------------------------------------------------------------------------
# scoring
# ---------------------------------------------------------------------------

def _cand(title, artists, dur=None, album="", source="deezer", px=1000):
    return Candidate(source, title, artists, album, dur, f"https://x/{title}", px)


def test_score_exact_match_is_apply():
    g = _first("DUKI - Rockstar (Video Oficial)", "Duki")
    s, br = ca.score(_cand("Rockstar", ["Duki"], 113), g, 113)
    assert ca.decide(s) == ca.DECISION_APPLY, br


def test_score_duration_far_off_drops_to_review():
    g = _first("DUKI - Rockstar (Video Oficial)", "Duki")
    s, _ = ca.score(_cand("Rockstar", ["Duki"], 160), g, 113)
    assert ca.decide(s) != ca.DECISION_APPLY


def test_score_wrong_artist_never_applies():
    g = _first("DUKI - Rockstar (Video Oficial)", "Duki")
    s, _ = ca.score(_cand("Rockstar", ["Post Malone"], 113), g, 113)
    assert s <= 0.65


def test_score_wrong_title_is_no_match():
    g = _first("DUKI - Rockstar (Video Oficial)", "Duki")
    s, _ = ca.score(_cand("Goteo", ["Duki"], 113), g, 113)
    assert ca.decide(s) == ca.DECISION_NO_MATCH


def test_score_version_mismatch_penalised():
    g = _first("Him & I (slowed + reverb)", "TommyMuzzic")
    s_orig, br = ca.score(_cand("Him & I", ["G-Eazy", "Halsey"], 268), g, 334)
    assert br["version_mismatch"] and ca.decide(s_orig) != ca.DECISION_APPLY


def test_score_session_numbers_must_agree():
    g = _first("C.R.O || BZRP Music Sessions #29/66", "Bizarrap")
    good, _ = ca.score(_cand("C.R.O: Bzrp Music Sessions, Vol. 29", ["Bizarrap", "C.R.O"], 149), g, 149)
    bad, _ = ca.score(_cand("Bzrp Music Sessions, Vol. 30", ["Bizarrap"], 149), g, 149)
    assert ca.decide(good) == ca.DECISION_APPLY
    assert bad < ca.APPLY_THRESHOLD


def test_score_feat_in_store_title_and_accents():
    g = _first("Eladio Carrión - Claro Cristal (Visualizer) | Sauce Boyz 2", "Eladio Carrion")
    s, _ = ca.score(_cand("Claro Cristal", ["Eladio Carrión"], 161, album="Sauce Boyz 2"), g, 161)
    assert s >= 0.95
    g = _first("YG - I Dance ft. Duki, Cuco", "YG")
    s, _ = ca.score(_cand("I Dance (feat. Duki & Cuco)", ["YG"], 243, source="itunes", px=1400), g, 243)
    assert ca.decide(s) == ca.DECISION_APPLY


def test_pick_best_prefers_bigger_image_on_tie():
    gs = ca.clean_query("DUKI - Rockstar (Video Oficial)", "Duki")
    dz = _cand("Rockstar", ["Duki"], 113, source="deezer", px=1000)
    it = _cand("Rockstar", ["Duki"], 113, source="itunes", px=1400)
    c, g, s, br, alts = ca.pick_best([dz, it], gs, 113)
    assert c.source == "itunes" and s >= ca.APPLY_THRESHOLD
    assert br.get("cross_source_agree")


def test_pick_best_confidence_beats_size():
    gs = ca.clean_query("DUKI - Rockstar (Video Oficial)", "Duki")
    dz = _cand("Rockstar", ["Duki"], 113, source="deezer", px=1000)
    it = _cand("Rockstar", ["Somebody Else"], 200, source="itunes", px=1400)
    c, *_ = ca.pick_best([it, dz], gs, 113)
    assert c.source == "deezer"


# ---------------------------------------------------------------------------
# parsing / urls / images
# ---------------------------------------------------------------------------

def test_itunes_art_url_rewrite():
    u = "https://is1-ssl.mzstatic.com/image/thumb/Music124/v4/46/x/194491166793.jpg/100x100bb.jpg"
    assert ca.itunes_art_url(u).endswith("/194491166793.jpg/1400x1400bb.jpg")


def test_parse_sources():
    it = ca.parse_itunes({"results": [{"kind": "song", "trackName": "Goteo", "artistName": "Duki",
                                       "collectionName": "Goteo - Single", "trackTimeMillis": 164458,
                                       "artworkUrl100": "https://a.mzstatic.com/x.jpg/100x100bb.jpg"}]})
    assert it[0].album == "Goteo" and it[0].duration_s == 164 and it[0].art_px == 1400
    dz = ca.parse_deezer({"data": [{"title": "Rockstar", "duration": 112, "artist": {"name": "Duki"},
                                    "album": {"title": "Rockstar", "cover_xl": "https://e-cdns-images.dzcdn.net/1000x1000-000000-80-0-0.jpg"}}]})
    assert dz[0].artists == ["Duki"] and dz[0].art_px == 1000


def test_host_allowlist():
    assert ca._host_allowed("https://itunes.apple.com/search")
    assert ca._host_allowed("https://is1-ssl.mzstatic.com/image/x.jpg")
    assert ca._host_allowed("https://e-cdns-images.dzcdn.net/images/cover/x.jpg")
    assert not ca._host_allowed("http://api.deezer.com/search")
    assert not ca._host_allowed("https://evil.com/mzstatic.com")
    assert not ca._host_allowed("https://dzcdn.net.evil.com/x")


def _png_bytes(w, h):
    from PIL import Image
    b = io.BytesIO()
    Image.new("RGB", (w, h), (200, 30, 30)).save(b, "PNG")
    return b.getvalue()


def test_save_official_cover_converts_png_to_jpeg(tmp_path):
    p = ca.save_official_cover("abc123", _png_bytes(600, 600), str(tmp_path))
    assert p.endswith("abc123.official.jpg")
    assert Path(p).read_bytes()[:3] == b"\xff\xd8\xff"


class _Resp:
    def __init__(self, data, status=200):
        self.status_code, self._data, self.headers = status, data, {}

    def iter_content(self, n):
        yield self._data

    def close(self):
        pass


def test_fetch_cover_rejects_small_and_non_images(monkeypatch):
    monkeypatch.setattr(ca, "_http_get", lambda *a, **k: _Resp(_png_bytes(300, 300)))
    with pytest.raises(ValueError):
        ca.fetch_cover_bytes("https://a.mzstatic.com/x.jpg")
    monkeypatch.setattr(ca, "_http_get", lambda *a, **k: _Resp(b"<html>nope</html>"))
    with pytest.raises(ValueError):
        ca.fetch_cover_bytes("https://a.mzstatic.com/x.jpg")
    monkeypatch.setattr(ca, "_http_get", lambda *a, **k: _Resp(_png_bytes(800, 800)))
    data, w, h, mime = ca.fetch_cover_bytes("https://a.mzstatic.com/x.jpg")
    assert (w, h, mime) == (800, 800, "image/png")


def test_lookups_disabled_under_tests():
    assert ca.lookups_enabled() is False
    assert ca.auto_apply_cover({"id": "x", "title": "DUKI - Rockstar"}) is None


# ---------------------------------------------------------------------------
# art URL cache busting keeps signatures valid
# ---------------------------------------------------------------------------

def test_art_url_version_param_still_verifies(tmp_path):
    from urllib.parse import urlparse, parse_qs
    from nocturne_api.signing import sign_art_url, verify_media_url
    from nocturne_api.mapping import art_version
    f = tmp_path / "c.jpg"
    f.write_bytes(b"\xff\xd8\xff" + b"0" * 10)
    v1 = art_version(str(f))
    url = sign_art_url("track001", 300, v1)
    q = parse_qs(urlparse(url).query)
    assert q["v"] == [v1] and q["s"] == ["300"]
    assert verify_media_url(urlparse(url).path, q["sig"][0], q["exp"][0])
    os.utime(f, ns=(1, 10**18))
    assert art_version(str(f)) != v1
    assert art_version(str(tmp_path / "missing.jpg")) is None


async def test_serve_art_accepts_version_param(client, tmp_path):
    import database as nova_db
    from nocturne_api.signing import sign_art_url
    img = tmp_path / "cover.official.jpg"
    from PIL import Image
    Image.new("RGB", (600, 600)).save(img, "JPEG")
    conn = nova_db.connect()
    with conn:
        conn.execute("UPDATE tracks SET cover_path=? WHERE id='track002'", (str(img),))
    try:
        url = sign_art_url("track002", None, "abc123").replace("http://testserver/v1", "")
        r = await client.get(url)
        assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    finally:
        with conn:
            conn.execute("UPDATE tracks SET cover_path=NULL WHERE id='track002'")
        conn.close()


# ---------------------------------------------------------------------------
# admin upload filename sanitizer + title fallback
# ---------------------------------------------------------------------------

from nocturne_api.admin.routes import (  # noqa: E402
    _sanitize_upload_stem, _meta_from_filename, _upload_title_artist, _unique_upload_dest,
)


@pytest.mark.parametrize("raw,expected", [
    ("../../etc/passwd.mp3", "passwd"),
    ("..\\..\\windows\\evil.flac", "evil"),
    ("Lunática Remix.wav", "Lunática Remix"),
    ("Artist - Song.flac", "Artist - Song"),
    ("a\x00b\x1fc\nd.mp3", "a b c d"),
    ("....mp3", "mp3"),
    ("", "upload"),
    ("x..y...z.mp3", "x.y.z"),
    ("  spaced     out  .m4a", "spaced out"),
    ("weird/<>:|?*\"name.opus", "name"),
])
def test_sanitize_upload_stem(raw, expected):
    out = _sanitize_upload_stem(raw)
    assert out == expected
    assert "/" not in out and "\\" not in out and ".." not in out


def test_sanitize_caps_length():
    assert len(_sanitize_upload_stem("a" * 500 + ".mp3")) <= 120


def test_unique_upload_dest(tmp_path):
    d = _unique_upload_dest(tmp_path, "../../etc/passwd.mp3", ".mp3")
    assert d.parent == tmp_path and d.name.endswith("_passwd.mp3")
    assert d.name.split("_", 1)[0].isdigit()
    d.write_bytes(b"x")
    d2 = _unique_upload_dest(tmp_path, "../../etc/passwd.mp3", ".mp3")
    assert d2 != d or not d2.exists()


@pytest.mark.parametrize("fname,title,artist", [
    ("Artist - Song.flac", "Song", "Artist"),
    ("Lunática Remix.wav", "Lunática Remix", None),
    ("1777975625411_More Remix 2 ft Cris MJ.m4a", "More Remix 2 ft Cris MJ", None),
    ("1779027205926_Hola Soy Pro - Peereira7, Agustin51 (Video oficial).webm",
     "Peereira7, Agustin51 (Video oficial)", "Hola Soy Pro"),
    ("01 - Intro.mp3", "Intro", None),
    ("50 Cent - In Da Club.mp3", "In Da Club", "50 Cent"),
    ("../../etc/passwd.mp3", "passwd", None),
])
def test_meta_from_filename(fname, title, artist):
    assert _meta_from_filename(fname) == (title, artist)


def test_upload_title_fallback_when_tag_title_is_saved_stem(tmp_path):
    dest = tmp_path / "1790000000000_Artist - Song.wav"
    # _read_tags() default: title == saved file's stem, no artist
    t, a = _upload_title_artist({"title": dest.stem, "artist": None}, dest, "Artist - Song.wav")
    assert (t, a) == ("Song", "Artist")
    t, a = _upload_title_artist({"title": None}, dest, "Lunática Remix.wav")
    assert (t, a) == ("Lunática Remix", "")
    # real tags win
    t, a = _upload_title_artist({"title": "Real", "artist": "Tagged"}, dest, "Artist - Song.wav")
    assert (t, a) == ("Real", "Tagged")


async def test_upload_untagged_wav_uses_original_filename(client, admin_token):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(8000)
        w.writeframes(struct.pack("<h", 0) * 800)
    r = await client.post(
        "/admin/uploads",
        headers={"Authorization": f"Bearer {admin_token}"},
        files={"file": ("../../Some Artist - Lunática Remix.wav", buf.getvalue(), "audio/wav")},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    blob = str(body)
    assert "Lunática Remix" in blob
    assert "Some Artist" in blob
    import database as nova_db
    from nocturne_api import config
    conn = nova_db.connect()
    row = conn.execute("SELECT file_path FROM tracks WHERE title='Lunática Remix'").fetchone()
    conn.close()
    assert row is not None
    p = Path(row[0])
    assert p.parent == Path(config.MUSIC_ROOT) / "uploads"
    assert p.name.endswith("_Some Artist - Lunática Remix.wav")


def test_video_duration_tolerance_only_for_longer_local_and_exact_match():
    # music-video rip is 20s longer than the release: exact title+artist -> apply
    g = _first("DUKI - Goteo (Video Oficial)", "Duki")
    raw = "DUKI - Goteo (Video Oficial) Duki"
    s, br = ca.score(_cand("Goteo", ["Duki"], 164), g, 184, raw)
    assert ca.decide(s) == ca.DECISION_APPLY and br["video_tolerance"]
    # local SHORTER than the release by 20s is not tolerated
    s, _ = ca.score(_cand("Goteo", ["Duki"], 204), g, 184, raw)
    assert ca.decide(s) != ca.DECISION_APPLY
    # no video hint in the title -> no tolerance
    g2 = _first("DUKI - Goteo", "Duki")
    s, _ = ca.score(_cand("Goteo", ["Duki"], 164), g2, 184, "DUKI - Goteo Duki")
    assert ca.decide(s) != ca.DECISION_APPLY
    # far beyond 45s -> never apply
    s, _ = ca.score(_cand("Goteo", ["Duki"], 100), g, 184, raw)
    assert ca.decide(s) != ca.DECISION_APPLY


def test_clean_unbracketed_credits_hashtags_and_track_numbers():
    assert _first("DUKI - Si Te Sentis Sola (Video Oficial). Shot by Ballve", "Duki").title == "Si Te Sentis Sola"
    assert _first("Bhavi, Duki - Mojaa prod. Omar Varela", "MUEVA Records").title == "Mojaa"
    assert _first("El Turko, Mandale Flow - 30 Grados (Letra) #30GRADOS #FLOWBR", "x").title == "30 Grados"
    assert _has(ca.clean_query("11. MANHATTAN - NATHY PELUSO, Duki | GRASA", "NATHY PELUSO"), "MANHATTAN", "Nathy Peluso")
    g = _first("Eladio Carrión || BZRP Music Sessions #40/66", "Bizarrap")
    s, _ = ca.score(_cand("Eladio Carrion: Bzrp Music Sessions, Vol. 40/66", ["Bizarrap"], 164), g, 171,
                    "Eladio Carrión || BZRP Music Sessions #40/66")
    assert ca.decide(s) == ca.DECISION_APPLY
