"""
Role-based access control guards.
"""
from __future__ import annotations

from fastapi import Depends, HTTPException

from .auth import require_user


async def require_admin(account: dict = Depends(require_user)) -> dict:
    """Dependency — raises 403 if the user is not an admin."""
    if account.get("role") != "admin":
        raise HTTPException(
            status_code=403,
            detail={"message": "Admin access required.", "code": "forbidden"},
        )
    return account
