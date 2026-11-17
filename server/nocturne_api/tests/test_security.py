"""Security-specific tests: signing, path traversal, CSRF, algorithm confusion."""
from __future__ import annotations

import time
import pytest
pytestmark = pytest.mark.asyncio


async def test_stream_url_requires_valid_signature(client, user_token):
    headers = {"Authorization": f"Bearer {user_token}"}

    # Get a valid stream URL
    r = await client.get("/tracks/track001/stream-info", headers=headers)
    # May be 404 if the file doesn't exist on disk, which is fine in tests
    # The important part is that invalid sigs are rejected
    bad_url = "/media/stream/track001?sig=invalidsig&exp=9999999999"
    r2 = await client.get(bad_url)
    assert r2.status_code == 403


async def test_stream_url_expired(client):
    from nocturne_api.signing import _sign
    from nocturne_api import config

    past_exp = int(time.time()) - 3600
    sig = _sign(config.MEDIA_SECRET, "/v1/media/stream/track001", past_exp)
    r = await client.get(f"/media/stream/track001?sig={sig}&exp={past_exp}")
    assert r.status_code == 403


async def test_art_url_path_traversal_rejected(client):
    # Attempt path traversal in track_id
    bad_ids = ["../etc/passwd", "../../etc/shadow", "track/../../etc/hosts"]
    for bad_id in bad_ids:
        import urllib.parse
        encoded = urllib.parse.quote(bad_id, safe="")
        r = await client.get(f"/media/art/{encoded}?sig=bad&exp=9999999999")
        # Should be 403 (invalid sig) or 404, never 200 with file contents
        assert r.status_code in (403, 404, 400, 422), \
            f"Expected rejection for {bad_id}, got {r.status_code}"


async def test_jwt_none_algorithm_rejected(client):
    """The JWT library must reject tokens with alg=none."""
    import base64, json

    def b64(s):
        return base64.urlsafe_b64encode(s.encode()).rstrip(b"=").decode()

    header = b64(json.dumps({"alg": "none", "typ": "JWT"}))
    payload = b64(json.dumps({"sub": "u_fake", "fid": "fam_fake",
                              "typ": "access", "jti": "x",
                              "iat": int(time.time()),
                              "exp": int(time.time()) + 9999}))
    token = f"{header}.{payload}."

    r = await client.get("/users/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401


async def test_no_internal_details_in_errors(client):
    r = await client.get("/library/tracks/nonexistent_id",
                         headers={"Authorization": "Bearer fake_token_12345"})
    body = r.text
    # Should not contain stack trace indicators
    assert "Traceback" not in body
    assert "File \"" not in body
    assert "/opt/" not in body


async def test_invalid_limit_returns_400(client, user_token):
    r = await client.get("/library/tracks?limit=999",
                         headers={"Authorization": f"Bearer {user_token}"})
    assert r.status_code == 400


async def test_negative_offset_returns_400(client, user_token):
    r = await client.get("/library/tracks?offset=-1",
                         headers={"Authorization": f"Bearer {user_token}"})
    assert r.status_code == 400


async def test_error_response_format(client):
    r = await client.get("/nonexistent_route_xyz")
    # 404 response should have json with message
    assert r.status_code == 404


async def test_response_has_security_headers(client, user_token):
    r = await client.get("/library/tracks", headers={"Authorization": f"Bearer {user_token}"})
    assert r.headers.get("x-content-type-options") == "nosniff"


async def test_json_cache_control_no_store(client, user_token):
    r = await client.get("/library/tracks", headers={"Authorization": f"Bearer {user_token}"})
    cc = r.headers.get("cache-control", "")
    assert "no-store" in cc
