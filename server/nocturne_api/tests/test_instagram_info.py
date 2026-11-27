"""NOCTURNE_FACEBOOK_APP_ID: validated in config, exposed by /info only when set."""
from __future__ import annotations

import pytest

from nocturne_api import config

pytestmark = pytest.mark.asyncio


@pytest.mark.parametrize("raw,expected", [
    ("", ""), ("  ", ""), ("1234567890123456", "1234567890123456"), (" 123456789012345 ", "123456789012345"),
    ("abc", ""), ("1234", ""), ("12345 6789", ""), ("1" * 26, ""), ("12345678;rm", ""),
])
def test_facebook_app_id_validation(raw, expected):
    assert config._facebook_app_id(raw) == expected


async def test_info_hides_instagram_without_app_id(client, monkeypatch):
    monkeypatch.setattr(config, "FACEBOOK_APP_ID", "")
    d = (await client.get("/info")).json()
    assert d["capabilities"]["instagramStories"] is False
    assert "integrations" not in d


async def test_info_exposes_instagram_app_id(client, monkeypatch):
    monkeypatch.setattr(config, "FACEBOOK_APP_ID", "1234567890123456")
    d = (await client.get("/info")).json()
    assert d["capabilities"]["instagramStories"] is True
    assert d["integrations"] == {"instagramStories": {"appId": "1234567890123456"}}
