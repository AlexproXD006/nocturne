"""
Password hashing with Argon2id. Falls back to bcrypt if argon2-cffi unavailable.
"""
from __future__ import annotations

MIN_PASSWORD_LEN = 10
MAX_PASSWORD_LEN = 1024


def _get_hasher():
    try:
        from argon2 import PasswordHasher  # type: ignore
        return PasswordHasher()
    except ImportError:
        return None


_hasher = _get_hasher()

# --- Argon2id path -----------------------------------------------------------

def hash_password(password: str) -> str:
    if _hasher:
        return _hasher.hash(password)
    # bcrypt fallback
    import bcrypt  # type: ignore
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> tuple[bool, bool]:
    """
    Returns (ok, needs_rehash).
    needs_rehash is True when the stored hash used weaker params.
    """
    if _hasher:
        from argon2.exceptions import VerifyMismatchError, VerificationError  # type: ignore
        try:
            ok = _hasher.verify(hashed, password)
            needs_rehash = ok and _hasher.check_needs_rehash(hashed)
            return ok, needs_rehash
        except VerifyMismatchError:
            return False, False
        except VerificationError:
            return False, False
        except Exception:
            return False, False
    # bcrypt fallback
    import bcrypt  # type: ignore
    try:
        ok = bcrypt.checkpw(password.encode(), hashed.encode())
        return ok, False
    except Exception:
        return False, False


def dummy_verify() -> None:
    """Run a dummy hash verification to prevent timing-based user enumeration."""
    if _hasher:
        try:
            _hasher.verify("$argon2id$v=19$m=65536,t=3,p=4$dummysaltsaltsalt$dummyhashXXXXXXXXXXXXXXXXXXXXXXX", "x")
        except Exception:
            pass
    else:
        import bcrypt  # type: ignore
        try:
            bcrypt.checkpw(b"x", b"$2b$12$invalid.hash.for.timing.protection.only")
        except Exception:
            pass
