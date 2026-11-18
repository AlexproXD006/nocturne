"""Recovery and watchdog for rows in ``v1_jobs``.

Download/import rows are inserted as ``queued`` and the real work runs in the
in-memory NOVA download queue, so a restart (or a crashed worker) used to leave
them ``queued``/``running`` forever.  Re-enqueueing is not safe (the row does not
keep enough state to know whether the file was already downloaded), so jobs that
were in flight before a restart are marked ``failed`` ("interrupted by restart").

* ``recover_interrupted_jobs()``: call once at startup.
* ``sweep_stuck_jobs()``: fail jobs stuck for more than ``STUCK_AFTER_S``; also
  mirrors the final state of the in-memory NOVA job into the row.
* ``watchdog_loop()``: periodic asyncio task running the sweep.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from .db import connect

logger = logging.getLogger(__name__)

ACTIVE = ("queued", "running")
RESTART_REASON = "interrupted by restart"
STUCK_AFTER_S = 30 * 60
SWEEP_INTERVAL_S = 60


def _now_dt() -> datetime:
    return datetime.now(timezone.utc)


def recover_interrupted_jobs() -> int:
    """Mark every queued/running job as failed. Returns how many were changed."""
    now = _now_dt().isoformat()
    with connect() as conn:
        cur = conn.execute(
            f"UPDATE v1_jobs SET status='failed', error=?, finished_at=? "
            f"WHERE status IN ({','.join('?' * len(ACTIVE))})",
            (RESTART_REASON, now, *ACTIVE),
        )
        return cur.rowcount or 0


def _parse(ts: Optional[str]) -> Optional[datetime]:
    if not ts:
        return None
    try:
        d = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def sweep_stuck_jobs(nova_jobs: Optional[dict] = None, now: Optional[datetime] = None,
                     stuck_after_s: int = STUCK_AFTER_S) -> int:
    """Finalize active jobs whose NOVA job ended, and fail those stuck too long."""
    now = now or _now_dt()
    nova_jobs = nova_jobs or {}
    changed = 0
    with connect() as conn:
        rows = conn.execute(
            f"SELECT id, nova_job_id, created_at FROM v1_jobs WHERE status IN ({','.join('?' * len(ACTIVE))})",
            ACTIVE,
        ).fetchall()
        for r in rows:
            nj = nova_jobs.get(r["nova_job_id"]) if r["nova_job_id"] else None
            nstatus = (nj or {}).get("status")
            if nstatus == "done":
                conn.execute("UPDATE v1_jobs SET status='done', progress=100, finished_at=? WHERE id=?",
                             (now.isoformat(), r["id"]))
                changed += 1
                continue
            if nstatus in ("error", "cancelled"):
                conn.execute("UPDATE v1_jobs SET status='failed', error=?, finished_at=? WHERE id=?",
                             ((nj or {}).get("error") or "download failed", now.isoformat(), r["id"]))
                changed += 1
                continue
            created = _parse(r["created_at"])
            if created and now - created > timedelta(seconds=stuck_after_s):
                conn.execute("UPDATE v1_jobs SET status='failed', error=?, finished_at=? WHERE id=?",
                             (f"stuck for more than {stuck_after_s // 60} minutes (watchdog)", now.isoformat(), r["id"]))
                changed += 1
    return changed


def _nova_queue() -> dict:
    try:
        from main import download_manager  # type: ignore
        return dict(download_manager.download_queue)
    except Exception:
        return {}


async def watchdog_loop(interval_s: float = SWEEP_INTERVAL_S) -> None:
    while True:
        await asyncio.sleep(interval_s)
        try:
            n = await asyncio.get_running_loop().run_in_executor(None, lambda: sweep_stuck_jobs(_nova_queue()))
            if n:
                logger.info("jobs watchdog: finalized %d job(s)", n)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("jobs watchdog error: %s", exc)
