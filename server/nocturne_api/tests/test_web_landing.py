"""Landing at /, web player under /app, old root URLs redirected."""
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from nocturne_api.web import mount_downloads, mount_landing, mount_spa

pytestmark = pytest.mark.asyncio


@pytest.fixture(autouse=True)
def _legacy_hosts(monkeypatch):
    from nocturne_api import config
    monkeypatch.setattr(config, "LEGACY_HOSTS", ["spotify.alexcloudweb.es"])


def _build(tmp_path, with_landing=True):
    web = tmp_path / "web"
    (web / "assets").mkdir(parents=True)
    (web / "index.html").write_text("<html>SPA</html>")
    (web / "assets" / "a.js").write_text("x")
    (web / "icon.svg").write_text("<svg/>")
    land = tmp_path / "landing"
    if with_landing:
        (land / "assets").mkdir(parents=True)
        (land / "index.html").write_text("<html>LANDING</html>")
        (land / "assets" / "l.css").write_text("body{}")
    app = FastAPI()

    @app.get("/v1/ping")
    async def ping():
        return {"ok": True}

    mount_downloads(app)
    mount_landing(app, str(land))
    mount_spa(app, str(web))
    return app


@pytest.fixture
async def client(tmp_path):
    app = _build(tmp_path)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        yield c


async def test_root_serves_landing(client):
    r = await client.get("/")
    assert r.status_code == 200 and "LANDING" in r.text
    assert r.headers["x-content-type-options"] == "nosniff"


async def test_landing_assets_namespaced(client):
    r = await client.get("/l/l.css")
    assert r.status_code == 200 and r.text == "body{}"


async def test_app_redirects_to_slash(client):
    r = await client.get("/app", follow_redirects=False)
    assert r.status_code == 308 and r.headers["location"] == "/app/"


async def test_app_serves_spa_and_fallback(client):
    assert "SPA" in (await client.get("/app/")).text
    assert (await client.get("/app/assets/a.js")).text == "x"
    r = await client.get("/app/some/deep/link")
    assert r.status_code == 200 and "SPA" in r.text


async def test_old_root_urls_redirect(client):
    r = await client.get("/assets/index-abc.js", follow_redirects=False)
    assert r.status_code == 307 and r.headers["location"] == "/app/assets/index-abc.js"
    r = await client.get("/icon.svg", follow_redirects=False)
    assert r.headers["location"] == "/app/icon.svg"


async def test_api_and_downloads_untouched(client):
    assert (await client.get("/v1/ping")).json() == {"ok": True}
    assert (await client.get("/descargar")).status_code in (200, 404)  # route exists, page file optional
    assert (await client.get("/changelog.json")).status_code in (200, 404)


async def test_no_landing_falls_back_to_app(tmp_path):
    app = _build(tmp_path, with_landing=False)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/", follow_redirects=False)
        assert r.status_code == 302 and r.headers["location"] == "/app/"


async def _legacy(tmp_path, headers):
    app = _build(tmp_path)
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://t", headers=headers)


async def test_legacy_host_pages_redirect(tmp_path):
    async with await _legacy(tmp_path, {"host": "spotify.alexcloudweb.es"}) as c:
        for path in ("/", "/app", "/app/", "/descargar", "/l/l.css", "/app/assets/a.js"):
            r = await c.get(path, follow_redirects=False)
            assert r.status_code == 301, path
            assert r.headers["location"] == "https://nocturne.alexcloudweb.es" + path
        r = await c.get("/app/?x=1", follow_redirects=False)
        assert r.headers["location"].endswith("/app/?x=1")


async def test_legacy_host_api_and_downloads_not_redirected(tmp_path):
    async with await _legacy(tmp_path, {"host": "spotify.alexcloudweb.es"}) as c:
        assert (await c.get("/v1/ping", follow_redirects=False)).status_code == 200
        for path in ("/nocturne.apk", "/nocturne-windows-x64.zip", "/changelog.json", "/v1/spotify/callback", "/descargar/android"):
            assert (await c.get(path, follow_redirects=False)).status_code != 301, path


async def test_canonical_host_not_redirected(tmp_path):
    async with await _legacy(tmp_path, {"host": "nocturne.alexcloudweb.es"}) as c:
        assert (await c.get("/", follow_redirects=False)).status_code == 200


async def test_forwarded_host_only_from_trusted_proxy(tmp_path, monkeypatch):
    from nocturne_api import config
    hdr = {"host": "127.0.0.1:8000", "x-forwarded-host": "spotify.alexcloudweb.es"}
    async with await _legacy(tmp_path, hdr) as c:
        assert (await c.get("/", follow_redirects=False)).status_code == 200  # untrusted peer
    monkeypatch.setattr(config, "TRUSTED_PROXIES", ["127.0.0.1"])
    (tmp_path / "b").mkdir()
    app = _build(tmp_path / "b")
    t = ASGITransport(app=app, client=("127.0.0.1", 1234))
    async with AsyncClient(transport=t, base_url="http://t", headers=hdr) as c:
        assert (await c.get("/", follow_redirects=False)).status_code == 301

