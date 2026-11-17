"""
JWT access tokens and refresh token management.
"""
from __future__ import annotations

import hashlib
import secrets
import sqlite3
from datetime import datetime, timezone
from typing import Optional

import jwt  # PyJWT

from . import config
from .db import connect

_ACCESS_ALG = "HS256"


# ---------------------------------------------------------------------------
# Access tokens
# ---------------------------------------------------------------------------

def create_access_token(user_id: str, family_id: str) -> tuple[str, int]:
    """Returns (token, expires_at unix timestamp)."""
    import time
    now = int(time.time())
    exp = now + config.ACCESS_TOKEN_TTL
    jti = secrets.token_hex(16)
    payload = {
        "sub": user_id,
        "fid": family_id,
        "iat": now,
        "exp": exp,
        "jti": jti,
        "typ": "access",
    }
    token = jwt.encode(payload, config.JWT_SECRET, algorithm=_ACCESS_ALG)
    return token, exp


def decode_access_token(token: str) -> Optional[dict]:
    """
    Returns the payload dict or None if invalid/expired.
    Strictly pins algorithm to HS256; rejects 'none' and others.
    """
    try:
        payload = jwt.decode(
            token,
            config.JWT_SECRET,
            algorithms=[_ACCESS_ALG],
            options={"require": ["exp", "sub", "fid", "jti", "typ"]},
        )
        if payload.get("typ") != "access":
            return None
        return payload
    except jwt.PyJWTError:
        return None


# ---------------------------------------------------------------------------
# Refresh tokens
# ---------------------------------------------------------------------------

def _hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def create_refresh_token(user_id: str, family_id: str) -> tuple[str, str]:
    """
    Creates a new refresh token in the given family.
    Returns (raw_token, token_id).
    """
    from datetime import timedelta
    raw = secrets.token_urlsafe(32)
    token_hash = _hash_token(raw)
    token_id = "rt_" + secrets.token_hex(16)
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(seconds=config.REFRESH_TOKEN_TTL)

    with connect() as conn:
        conn.execute(
            """
            INSERT INTO v1_refresh_tokens
                (id, family_id, user_id, token_hash, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                token_id,
                family_id,
                user_id,
                token_hash,
                now.isoformat(),
                expires_at.isoformat(),
            ),
        )
    return raw, token_id


def create_token_family(user_id: str) -> str:
    """Creates a new token family and returns its id."""
    family_id = "fam_" + secrets.token_hex(16)
    now = datetime.now(timezone.utc).isoformat()
    with connect() as conn:
        conn.execute(
            "INSERT INTO v1_token_families(id, user_id, created_at) VALUES (?,?,?)",
            (family_id, user_id, now),
        )
    return family_id


def rotate_refresh_token(raw_token: str) -> Optional[tuple[str, str, str]]:
    """
    Validates and rotates a refresh token.
    Returns (new_raw_token, new_token_id, user_id) or None on failure.
    On reuse detection, revokes the entire family and returns None.
    """
    token_hash = _hash_token(raw_token)
    now_iso = datetime.now(timezone.utc).isoformat()

    conn = connect()
    try:
        # Use a transaction for atomicity
        conn.execute("BEGIN EXCLUSIVE")

        row = conn.execute(
            """
            SELECT rt.id, rt.family_id, rt.user_id, rt.used_at, rt.revoked_at,
                   rt.expires_at, tf.revoked_at AS family_revoked_at
            FROM v1_refresh_tokens rt
            JOIN v1_token_families tf ON rt.family_id = tf.id
            WHERE rt.token_hash = ?
            """,
            (token_hash,),
        ).fetchone()

        if row is None:
            conn.execute("ROLLBACK")
            return None

        token_id = row["id"]
        family_id = row["family_id"]
        user_id = row["user_id"]
        expires_at = row["expires_at"]

        # Check expiry
        if expires_at < now_iso:
            conn.execute("ROLLBACK")
            return None

        # Reuse detection: token was already used or family revoked
        if row["used_at"] is not None or row["family_revoked_at"] is not None or row["revoked_at"] is not None:
            # Revoke the entire family
            conn.execute(
                "UPDATE v1_token_families SET revoked_at=?, revoked_reason='reuse' WHERE id=?",
                (now_iso, family_id),
            )
            conn.execute(
                "UPDATE v1_refresh_tokens SET revoked_at=? WHERE family_id=?",
                (now_iso, family_id),
            )
            conn.execute("COMMIT")
            return None

        # Mark old token as used
        conn.execute(
            "UPDATE v1_refresh_tokens SET used_at=? WHERE id=?",
            (now_iso, token_id),
        )

        # Issue new refresh token in the same family
        new_raw = secrets.token_urlsafe(32)
        new_hash = _hash_token(new_raw)
        new_id = "rt_" + secrets.token_hex(16)
        from datetime import timedelta
        new_expires = (datetime.now(timezone.utc) + timedelta(seconds=config.REFRESH_TOKEN_TTL)).isoformat()

        conn.execute(
            """
            INSERT INTO v1_refresh_tokens
                (id, family_id, user_id, token_hash, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (new_id, family_id, user_id, new_hash, now_iso, new_expires),
        )
        conn.execute("COMMIT")
        return new_raw, new_id, user_id

    except Exception:
        conn.execute("ROLLBACK")
        return None
    finally:
        conn.close()


def revoke_family(family_id: str, reason: str = "logout") -> None:
    now_iso = datetime.now(timezone.utc).isoformat()
    with connect() as conn:
        conn.execute(
            "UPDATE v1_token_families SET revoked_at=?, revoked_reason=? WHERE id=?",
            (now_iso, reason, family_id),
        )
        conn.execute(
            "UPDATE v1_refresh_tokens SET revoked_at=? WHERE family_id=?",
            (now_iso, family_id),
        )


def revoke_all_user_families(user_id: str, reason: str = "password_change") -> None:
    now_iso = datetime.now(timezone.utc).isoformat()
    with connect() as conn:
        conn.execute(
            "UPDATE v1_token_families SET revoked_at=?, revoked_reason=? WHERE user_id=? AND revoked_at IS NULL",
            (now_iso, reason, user_id),
        )
        conn.execute(
            """
            UPDATE v1_refresh_tokens SET revoked_at=?
            WHERE user_id=? AND revoked_at IS NULL
            """,
            (now_iso, user_id),
        )


def get_family_by_token_hash(raw_token: str) -> Optional[str]:
    """Returns the family_id for a raw token (without consuming it), or None."""
    h = _hash_token(raw_token)
    with connect() as conn:
        row = conn.execute(
            "SELECT family_id FROM v1_refresh_tokens WHERE token_hash=?", (h,)
        ).fetchone()
    return row["family_id"] if row else None


def is_family_revoked(family_id: str) -> bool:
    with connect() as conn:
        row = conn.execute(
            "SELECT revoked_at FROM v1_token_families WHERE id=?", (family_id,)
        ).fetchone()
    return row is None or row["revoked_at"] is not None
