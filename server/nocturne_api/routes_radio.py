"""GET /v1/radio?seed=<trackId>&limit=20&exclude=<id,id,...> — autoplay suggestions."""
from __future__ import annotations

import sys

sys.path.insert(0, "/opt/music-server/backend")

from fastapi import APIRouter, Depends, HTTPException, Query

from .auth import require_user
from .autoplay import similar_tracks
from .mapping import track_to_wire

router = APIRouter(tags=["radio"])


@router.get("/radio")
async def radio(
    seed: str = Query(..., min_length=1, max_length=128),
    limit: int = Query(20, ge=1, le=50),
    exclude: str = Query("", max_length=8000),
    account: dict = Depends(require_user),
):
    ex = {x for x in exclude.split(",") if x.strip()}
    res = similar_tracks(account, seed, limit, ex)
    if res is None:
        raise HTTPException(status_code=404, detail={"message": "Track not found.", "code": "not_found"})
    _, rows, liked = res
    return {"seed": seed, "items": [track_to_wire(r, liked=r["id"] in liked) for r in rows]}
