"""Startup recovery + watchdog for v1_jobs, and thread-safe downloader notification."""
from __future__ import annotations

import asyncio
import threading
from datetime import datetime, timedelta, timezone

from nocturne_api.db import connect, migrate
from nocturne_api import jobs_recovery as jr


def _add(jid, status, created, nova=None):
    with connect() as c:
        c.execute(
            "INSERT OR REPLACE INTO v1_jobs(id,kind,title,status,created_at,nova_job_id) VALUES(?,?,?,?,?,?)",
            (jid, "download", "t", status, created.isoformat(), nova),
        )


def _st(jid):
    with connect() as c:
        r = c.execute("SELECT status,error FROM v1_jobs WHERE id=?", (jid,)).fetchone()
    return r["status"], r["error"]


def test_recover_interrupted_marks_active_failed():
    migrate()
    now = datetime.now(timezone.utc)
    _add("jr-q", "queued", now); _add("jr-r", "running", now); _add("jr-d", "done", now)
    assert jr.recover_interrupted_jobs() >= 2
    assert _st("jr-q") == ("failed", "interrupted by restart")
    assert _st("jr-r")[0] == "failed"
    assert _st("jr-d")[0] == "done"


def test_sweep_stuck_and_mirror_nova():
    migrate()
    now = datetime.now(timezone.utc)
    _add("sw-old", "queued", now - timedelta(minutes=31))
    _add("sw-new", "queued", now - timedelta(minutes=5))
    _add("sw-done", "queued", now, nova="n1")
    _add("sw-err", "running", now, nova="n2")
    jr.sweep_stuck_jobs({"n1": {"status": "done"}, "n2": {"status": "error", "error": "boom"}})
    assert _st("sw-old")[0] == "failed" and "watchdog" in _st("sw-old")[1]
    assert _st("sw-new")[0] == "queued"
    assert _st("sw-done")[0] == "done"
    assert _st("sw-err") == ("failed", "boom")


def test_downloader_notify_from_worker_thread():
    import importlib.util, pathlib
    src = pathlib.Path(__file__).resolve().parents[2] / "backend" / "downloader.py"
    spec = importlib.util.spec_from_file_location("_real_downloader", src)
    downloader = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(downloader)

    got = []

    class M:
        async def _notify(self, job):
            got.append(job["id"])

    async def main():
        loop = asyncio.get_running_loop()
        t = threading.Thread(target=downloader._notify_threadsafe, args=(M(), loop, {"id": "j1"}))
        t.start(); t.join()
        await asyncio.sleep(0.05)

    asyncio.run(main())
    assert got == ["j1"]
    # no loop captured / closed loop: silently ignored, no exception
    downloader._notify_threadsafe(M(), None, {"id": "x"})


def test_lrclib_limiter_penalize_pauses_all_callers():
    import time
    from nocturne_api import lyrics_auto
    lim = lyrics_auto._RateLimiter(0.0)
    lim.penalize(5)
    assert lim._next >= time.monotonic() + 4
    lim.penalize(1)  # never shortens an existing pause
    assert lim._next >= time.monotonic() + 4
