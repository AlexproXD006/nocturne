"""
GitHub Releases resolver, /v1/updates override rule, /v1/downloads and the
/descargar/<platform> redirects. All GitHub HTTP is mocked (httpx.MockTransport).
"""
from __future__ import annotations

import json

import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from nocturne_api import config, releases, routes_updates

REPO = "AlexproXD006/nocturne"
DL = f"https://github.com/{REPO}/releases/download"
SHA_APK = "a" * 64
SHA_SETUP = "b" * 64
SHA_BETA_APK = "c" * 64


def _asset(tag: str, name: str, size: int = 1000, sha: str | None = None) -> dict:
    a = {"name": name, "size": size, "state": "uploaded",
         "browser_download_url": f"{DL}/{tag}/{name}"}
    if sha:
        a["digest"] = f"sha256:{sha}"
    return a


def _release(tag: str, prerelease: bool = False, draft: bool = False, assets=None, body: str = "") -> dict:
    return {
        "tag_name": tag,
        "prerelease": prerelease,
        "draft": draft,
        "published_at": "2026-11-20T10:00:00Z",
        "html_url": f"https://github.com/{REPO}/releases/tag/{tag}",
        "body": body,
        "assets": assets or [],
    }


def sample_releases() -> list:
    """v1.0.6-beta.1 prerelease, v1.0.5 stable, an older v1.0.4 and a draft."""
    v5, b1 = "v1.0.5", "v1.0.6-beta.1"
    return [
        _release("v9.9.9", draft=True, assets=[_asset("v9.9.9", "Nocturne-9.9.9-android-release.apk")]),
        _release(b1, prerelease=True, body="Beta notes", assets=[
            _asset(b1, "Nocturne-1.0.6-beta.1-android-release.apk", 5_600_000, SHA_BETA_APK),
        ]),
        _release(v5, body="## What's Changed\n* Release signature", assets=[
            _asset(v5, "Nocturne-1.0.5-android-release.apk", 5_500_000, SHA_APK),
            _asset(v5, "Nocturne-Setup-1.0.5-arm64.exe", 90_000_000),
            _asset(v5, "Nocturne-Setup-1.0.5-x64.exe", 95_000_000, SHA_SETUP),
            _asset(v5, "Nocturne-Setup-1.0.5-x64.exe.blockmap", 100),
            _asset(v5, "Nocturne-Portable-1.0.5-x64.exe", 94_000_000),
            _asset(v5, "Nocturne-1.0.5-linux-arm64.AppImage", 110_000_000),
            _asset(v5, "Nocturne-1.0.5-linux-x86_64.AppImage", 120_000_000),
            _asset(v5, "nocturne_1.0.5_amd64.deb", 80_000_000),
            _asset(v5, "nocturne-1.0.5.x86_64.rpm", 81_000_000),
        ]),
        _release("v1.0.4", assets=[_asset("v1.0.4", "Nocturne-1.0.4-android-release.apk")]),
    ]


class FakeGitHub:
    def __init__(self, payload=None, status: int = 200):
        self.payload = sample_releases() if payload is None else payload
        self.status = status
        self.calls = 0
        self.last_request: httpx.Request | None = None

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        self.last_request = request
        if self.status != 200:
            return httpx.Response(self.status, json={"message": "boom"})
        return httpx.Response(200, json=self.payload)


@pytest.fixture
def downloads(tmp_path, monkeypatch):
    """A temp downloads dir with today's latest.json and local builds."""
    latest = {
        "android": {"version": "1.0.5", "url": "/descargar#reinstalar", "sha256": "d" * 64,
                    "notes": "New release signature: reinstall once."},
        "android-beta": {"version": "1.0.5", "url": "/descargar#reinstalar", "sha256": "d" * 64,
                         "notes": "New release signature: reinstall once."},
        "windows": {"version": "1.0.0", "url": "/nocturne-windows-x64.zip", "sha256": "e" * 64, "notes": ""},
        "desktop": {"version": "1.0.0", "url": "/nocturne-windows-x64.zip", "sha256": "e" * 64, "notes": ""},
    }
    p = tmp_path / "latest.json"
    p.write_text(json.dumps(latest), encoding="utf-8")
    (tmp_path / "nocturne.apk").write_bytes(b"x" * 1234)
    (tmp_path / "nocturne-windows-x64.zip").write_bytes(b"z" * 4321)
    monkeypatch.setattr(routes_updates, "LATEST_PATH", str(p))
    return p


@pytest.fixture
def github(monkeypatch):
    fake = FakeGitHub()
    monkeypatch.setattr(config, "RELEASES_REPO", REPO)
    monkeypatch.setattr(releases, "_TRANSPORT", httpx.MockTransport(fake.handler))
    releases.reset_cache()
    yield fake
    releases.reset_cache()


@pytest.fixture
async def web_client():
    from nocturne_api.web import mount_downloads
    app = FastAPI()
    mount_downloads(app)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as c:
        yield c


def _write_latest(path, **entries):
    data = json.loads(path.read_text(encoding="utf-8"))
    data.update(entries)
    path.write_text(json.dumps(data), encoding="utf-8")


# ── SemVer + resolver ────────────────────────────────────────────────────────

def test_semver_ordering():
    order = ["v1.0.4", "1.0.5-alpha", "1.0.5-beta.1", "1.0.5-beta.2", "1.0.5-beta.10", "v1.0.5", "1.0.6-beta.1", "1.1.0"]
    keys = [releases.parse_semver(v) for v in order]
    assert all(k is not None for k in keys)
    assert keys == sorted(keys)
    assert releases.parse_semver("latest") is None
    assert releases.is_newer("1.0.5", "1.0.5-beta.2")
    assert not releases.is_newer("1.0.5", "1.0.5")
    assert not releases.is_newer("garbage", "1.0.0")


def test_resolve_stable_beta_and_assets():
    data = releases.resolve(sample_releases(), REPO)
    stable, beta = data["stable"], data["beta"]
    assert stable["version"] == "1.0.5" and stable["prerelease"] is False
    assert beta["version"] == "1.0.6-beta.1" and beta["prerelease"] is True
    a = stable["assets"]
    assert set(a) == {"android", "windows", "windows-portable", "linux", "linux-deb", "linux-rpm"}
    assert a["android"] == {"name": "Nocturne-1.0.5-android-release.apk",
                            "url": f"{DL}/v1.0.5/Nocturne-1.0.5-android-release.apk",
                            "size": 5_500_000, "sha256": SHA_APK}
    assert a["windows"]["name"] == "Nocturne-Setup-1.0.5-x64.exe"      # x64 preferred over arm64
    assert a["windows"]["sha256"] == SHA_SETUP
    assert a["windows-portable"]["sha256"] is None                       # no digest -> None
    assert a["linux"]["name"] == "Nocturne-1.0.5-linux-x86_64.AppImage"
    assert a["linux-deb"]["name"] == "nocturne_1.0.5_amd64.deb"
    assert a["linux-rpm"]["name"] == "nocturne-1.0.5.x86_64.rpm"
    assert set(beta["assets"]) == {"android"}


def test_resolve_beta_falls_back_to_newer_stable():
    v = "v1.0.5"
    payload = [
        _release("v1.0.5-beta.2", prerelease=True, assets=[_asset("v1.0.5-beta.2", "Nocturne-1.0.5-beta.2-android-release.apk")]),
        _release(v, assets=[_asset(v, "Nocturne-1.0.5-android-release.apk")]),
    ]
    data = releases.resolve(payload, REPO)
    assert data["beta"]["version"] == "1.0.5"
    assert data["beta"] is data["stable"]


def test_resolve_ignores_debug_and_foreign_assets_and_treats_semver_pre_as_beta():
    tag = "v2.0.0-beta.1"
    payload = [_release(tag, prerelease=False, assets=[
        _asset(tag, "Nocturne-2.0.0-beta.1-android-debug.apk"),
        {"name": "Nocturne-Setup-2.0.0-beta.1-x64.exe", "size": 1, "state": "uploaded",
         "browser_download_url": "https://evil.example.com/Nocturne-Setup.exe"},
    ])]
    data = releases.resolve(payload, REPO)
    assert data["stable"] is None
    assert data["beta"]["version"] == "2.0.0-beta.1"   # SemVer pre-release => beta
    assert data["beta"]["assets"] == {}


def test_resolve_empty():
    assert releases.resolve([], REPO) is None
    with pytest.raises(ValueError):
        releases.resolve({"message": "Not Found"}, REPO)


# ── Fetch + cache ────────────────────────────────────────────────────────────

async def test_fetch_headers_and_cache(github):
    first = await releases.get_releases()
    second = await releases.get_releases()
    assert first is second and github.calls == 1
    req = github.last_request
    assert str(req.url) == f"https://api.github.com/repos/{REPO}/releases?per_page=20"
    assert req.headers["user-agent"] == "Nocturne-Server"
    assert req.headers["accept"] == "application/vnd.github+json"
    assert "authorization" not in req.headers


async def test_failure_is_cached_and_last_good_data_is_served(github):
    good = await releases.get_releases()
    assert good["stable"]["version"] == "1.0.5"
    # Expire the cache, then make GitHub fail: last good data is kept.
    releases._cache["expires"] = 0.0
    github.status = 503
    assert await releases.get_releases() is good
    calls = github.calls
    assert await releases.get_releases() is good       # failure cached, no new request
    assert github.calls == calls


async def test_failure_without_data_returns_none(github):
    github.status = 500
    assert await releases.get_releases() is None
    assert await releases.get_releases() is None
    assert github.calls == 1


async def test_disabled_repo_makes_no_requests(github, monkeypatch):
    monkeypatch.setattr(config, "RELEASES_REPO", "")
    assert await releases.get_releases() is None
    monkeypatch.setattr(config, "RELEASES_REPO", "not a repo/../x")
    assert await releases.get_releases() is None
    assert github.calls == 0


# ── /v1/updates ──────────────────────────────────────────────────────────────

async def test_updates_override_keeps_reinstall_page(client, github, downloads):
    r = await client.get("/updates/android")
    assert r.status_code == 200
    assert r.json() == {
        "version": "1.0.5",
        "url": "/descargar#reinstalar",          # latest.json url wins (same version)
        "sha256": SHA_APK,                         # GitHub digest
        "notes": "New release signature: reinstall once.",
    }


async def test_updates_from_github_when_versions_differ(client, github, downloads):
    _write_latest(downloads, android={"version": "1.0.4", "url": "/nocturne.apk", "sha256": "", "notes": ""})
    r = await client.get("/updates/android")
    body = r.json()
    assert body["version"] == "1.0.5"
    assert body["url"] == "/descargar/android"
    assert body["sha256"] == SHA_APK
    assert body["notes"].startswith("## What's Changed")
    assert set(body) == {"version", "url", "sha256", "notes"}


async def test_updates_beta_channel(client, github, downloads):
    r = await client.get("/updates/android-beta")
    assert r.json() == {"version": "1.0.6-beta.1", "url": "/descargar/android-beta",
                        "sha256": SHA_BETA_APK, "notes": "Beta notes"}


@pytest.mark.parametrize("platform", ["windows", "desktop"])
async def test_updates_windows_setup(client, github, downloads, platform):
    r = await client.get(f"/updates/{platform}")
    assert r.json()["version"] == "1.0.5"
    assert r.json()["url"] == "/descargar/windows"
    assert r.json()["sha256"] == SHA_SETUP


async def test_updates_local_newer_than_github_wins(client, github, downloads):
    _write_latest(downloads, android={"version": "1.0.7", "url": "/nocturne.apk", "sha256": "f" * 64, "notes": "x"})
    r = await client.get("/updates/android")
    assert r.json() == {"version": "1.0.7", "url": "/nocturne.apk", "sha256": "f" * 64, "notes": "x"}


async def test_updates_without_github_is_unchanged(client, github, downloads):
    github.status = 500
    r = await client.get("/updates/windows")
    assert r.json() == {"version": "1.0.0", "url": "/nocturne-windows-x64.zip", "sha256": "e" * 64, "notes": ""}
    r = await client.get("/updates/android")
    assert r.json()["url"] == "/descargar#reinstalar"


async def test_updates_no_releases_yet(client, github, downloads):
    github.payload = []
    r = await client.get("/updates/android-beta")
    assert r.json()["version"] == "1.0.5" and r.json()["url"] == "/descargar#reinstalar"


async def test_updates_unknown_platform(client, github, downloads):
    assert (await client.get("/updates/symbian")).status_code == 404
    assert github.calls == 0


# ── /v1/downloads ────────────────────────────────────────────────────────────

async def test_downloads_summary_github(client, github, downloads):
    r = await client.get("/downloads")
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "github"
    assert body["repo_url"] == f"https://github.com/{REPO}"
    assert body["releases_url"] == f"https://github.com/{REPO}/releases"
    st = body["stable"]
    assert st["version"] == "1.0.5"
    assert st["notes_url"] == f"https://github.com/{REPO}/releases/tag/v1.0.5"
    assert st["assets"]["android"]["url"] == "/descargar/android"
    assert st["assets"]["android"]["sha256"] == SHA_APK
    assert st["assets"]["windows"]["url"] == "/descargar/windows"
    assert st["assets"]["linux-rpm"]["url"] == "/descargar/linux-rpm"
    for a in st["assets"].values():
        assert a["url"].startswith("/descargar/")   # never an absolute GitHub URL
    assert body["beta"]["version"] == "1.0.6-beta.1"
    assert body["beta"]["assets"]["android"]["url"] == "/descargar/android-beta"


async def test_downloads_summary_no_active_beta(client, github, downloads):
    github.payload = [r for r in sample_releases() if not r["prerelease"]]
    body = (await client.get("/downloads")).json()
    assert body["stable"]["version"] == "1.0.5"
    assert body["beta"] is None


async def test_downloads_summary_local(client, github, downloads):
    github.status = 502
    body = (await client.get("/downloads")).json()
    assert body["source"] == "local"
    st = body["stable"]
    assert st["version"] == "1.0.5"
    assert st["assets"]["android"] == {"name": "nocturne.apk", "size": 1234, "sha256": "d" * 64,
                                       "url": "/descargar/android", "version": "1.0.5", "source": "local"}
    assert st["assets"]["windows"]["size"] == 4321
    assert st["assets"]["windows"]["version"] == "1.0.0"
    assert "linux" not in st["assets"]
    assert body["beta"] is None          # android-beta == android in latest.json


# ── /descargar/<platform> redirects ──────────────────────────────────────────

@pytest.mark.parametrize("target,expected", [
    ("android", f"{DL}/v1.0.5/Nocturne-1.0.5-android-release.apk"),
    ("android-beta", f"{DL}/v1.0.6-beta.1/Nocturne-1.0.6-beta.1-android-release.apk"),
    ("windows", f"{DL}/v1.0.5/Nocturne-Setup-1.0.5-x64.exe"),
    ("windows-portable", f"{DL}/v1.0.5/Nocturne-Portable-1.0.5-x64.exe"),
    ("linux", f"{DL}/v1.0.5/Nocturne-1.0.5-linux-x86_64.AppImage"),
    ("linux-deb", f"{DL}/v1.0.5/nocturne_1.0.5_amd64.deb"),
    ("linux-rpm", f"{DL}/v1.0.5/nocturne-1.0.5.x86_64.rpm"),
])
async def test_redirects_to_github(web_client, github, target, expected):
    for method in ("GET", "HEAD"):
        r = await web_client.request(method, f"/descargar/{target}")
        assert r.status_code == 302
        assert r.headers["location"] == expected
        assert r.headers["cache-control"] == "no-cache"


@pytest.mark.parametrize("target,expected", [
    ("android", "/nocturne.apk"),
    ("android-beta", "/nocturne.apk"),
    ("windows", "/nocturne-windows-x64.zip"),
])
async def test_redirect_fallbacks_to_local(web_client, github, target, expected):
    github.status = 500
    r = await web_client.get(f"/descargar/{target}")
    assert r.status_code == 302
    assert r.headers["location"] == expected


@pytest.mark.parametrize("target", ["windows-portable", "linux", "linux-deb", "linux-rpm"])
async def test_redirect_unavailable_is_404(web_client, github, target):
    github.payload = []
    r = await web_client.get(f"/descargar/{target}")
    assert r.status_code == 404
    assert "not available" in r.text


# ── iOS (unsigned .ipa, AltStore) ────────────────────────────────────────────

def _ios_payload():
    b = "v1.1.0-beta.1"
    return [
        _release(b, prerelease=True, body="iOS beta", assets=[
            _asset(b, "Nocturne-1.1.0-beta.1-android-release.apk", 5_000_000, SHA_BETA_APK),
            _asset(b, "Nocturne-1.1.0-beta.1-unsigned.ipa", 9_000_000, "9" * 64),
        ]),
        _release("v1.0.9", assets=[_asset("v1.0.9", "Nocturne-1.0.9-android-release.apk", 5_000_000, SHA_APK)]),
    ]


def test_resolve_picks_ipa():
    res = releases.resolve(_ios_payload(), REPO)
    assert res["beta"]["assets"]["ios"]["name"] == "Nocturne-1.1.0-beta.1-unsigned.ipa"
    assert "ios" not in res["stable"]["assets"]


async def test_updates_ios_beta_feed(client, github, downloads):
    github.payload = _ios_payload()
    r = await client.get("/updates/ios-beta")
    assert r.status_code == 200
    assert r.json() == {"version": "1.1.0-beta.1", "url": "/descargar/ios-beta",
                        "sha256": "9" * 64, "notes": "iOS beta"}


async def test_updates_ios_stable_has_no_build(client, github, downloads):
    github.payload = _ios_payload()
    assert (await client.get("/updates/ios")).status_code == 404


async def test_descargar_ios_redirects_to_release_page(web_client, github):
    github.payload = _ios_payload()
    r = await web_client.get("/descargar/ios-beta", follow_redirects=False)
    assert r.status_code == 302
    assert r.headers["location"] == f"https://github.com/{REPO}/releases/tag/v1.1.0-beta.1"
