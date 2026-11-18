"""
Review of the `.lrc` files that sit next to the audio.

  Dry run (default, read-only: both DBs opened with mode=ro; writes only the JSON report):
    runuser -u musicserver -- venv/bin/python -m nocturne_api.lrc_review [--report PATH] [--limit N]

  Apply (backs up nocturne.db with the SQLite backup API first; needs migration v7,
  i.e. a service restart after deploying):
    runuser -u musicserver -- venv/bin/python -m nocturne_api.lrc_review --apply [--report PATH]

Every track with a `.lrc` is classified (la.classify_lrc):
  fake_nova     NOVA's invented 10-s grid / header without real timing (already ranks last)
  plain         no timestamps at all
  real_synced   hand-made or NOVA-with-fractions: real timing -> compared with LRCLIB

For real_synced files LRCLIB is queried (lyrics_auto.lookup, 0.5 s rate limit) and
LRCLIB wins ("prefer_auto") when its synced lyrics match the track duration (±2 s)
AND the .lrc looks worse: coarse (whole-second) or 10-s-grid timestamps, clearly
fewer timed lines, a [length:] tag / last timestamp that does not fit the track.

The decision is stored server-side in `v1_lyrics_prefs` (+ the LRCLIB lyrics in
`v1_lyrics_auto`); GET /v1/tracks/{id}/lyrics then serves LRCLIB instead of that .lrc.
.lrc files are never modified or deleted. Tracks with admin lyrics (v1_lyrics) are skipped.
Does not import nocturne_api.config (no secrets needed).
"""
from __future__ import annotations

import argparse
import json
import logging
import re
import sqlite3
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from . import lyrics_auto as la
from .lyrics_backfill import (_ro, _table_exists, backup_db, default_library_db,
                              default_nocturne_db, load_tracks)

log = logging.getLogger("lrc_review")

DURATION_TOLERANCE_S = 2        # LRCLIB duration must match the track within this
FEWER_LINES_RATIO = 0.7         # .lrc has < 70 % of the LRCLIB timed lines -> worse
COARSE_RATIO = 0.9              # >= 90 % whole-second stamps -> coarse
GRID_RATIO = 0.8                # >= 80 % of stamps on a 10-s grid -> coarse
MIN_STAMPS_FOR_PATTERN = 4
END_SLACK_S = 2                 # last timestamp may exceed the duration by this much

KIND_FAKE = "fake_nova"
KIND_PLAIN = "plain"
KIND_REAL = "real_synced"

_LENGTH_RE = re.compile(r"^\s*\[length:\s*(\d{1,3}):(\d{2})\s*\]", re.I | re.M)
_ANY_TS = re.compile(r"\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]")


def parse_stamps(text: str) -> list[tuple[float, bool]]:
    """[(seconds, has_nonzero_fraction)] of every line that starts with a timestamp."""
    out: list[tuple[float, bool]] = []
    for line in (text or "").splitlines():
        m = la._LRC_TS_RE.match(line)
        if not m:
            continue
        frac = m.group(3)
        secs = int(m.group(1)) * 60 + int(m.group(2)) + (int(frac) / 10 ** len(frac) if frac else 0.0)
        out.append((secs, bool(frac) and int(frac) != 0))
    return out


def timed_line_count(text: str) -> int:
    """Number of timed lines that carry text."""
    n = 0
    for line in (text or "").splitlines():
        if la._LRC_TS_RE.match(line) and la._LRC_ANY_TS_RE.sub("", line).strip():
            n += 1
    return n


def classify_kind(text: str) -> str:
    if not parse_stamps(text):
        return KIND_PLAIN
    return KIND_FAKE if la.classify_lrc(text) == la.LRC_FAKE else KIND_REAL


def lrc_flaws(text: str, duration: Optional[int], lrclib_lines: Optional[int] = None) -> list[str]:
    """Reasons why this (real) .lrc looks worse than a good one."""
    flaws: list[str] = []
    stamps = parse_stamps(text)
    n = len(stamps)
    if n >= MIN_STAMPS_FOR_PATTERN:
        if sum(1 for _, f in stamps if not f) / n >= COARSE_RATIO:
            flaws.append("coarse_integer_seconds")
        if sum(1 for s, _ in stamps if abs(s / 10 - round(s / 10)) < 1e-6) / n >= GRID_RATIO:
            flaws.append("coarse_10s_grid")
    if duration:
        if stamps and max(s for s, _ in stamps) > duration + END_SLACK_S:
            flaws.append("last_timestamp_beyond_track_length")
        m = _LENGTH_RE.search(text or "")
        if m and abs(int(m.group(1)) * 60 + int(m.group(2)) - duration) > 5:
            flaws.append("length_tag_mismatch")
    if lrclib_lines and timed_line_count(text) < FEWER_LINES_RATIO * lrclib_lines:
        flaws.append("fewer_timed_lines")
    return flaws


def decide(text: str, duration: Optional[int], res: Optional["la.LookupResult"]) -> tuple[str, str, dict]:
    """-> (decision, reason, details). decision: prefer_auto | keep_lrc."""
    details: dict = {}
    if res is None or res.status == la.STATUS_ERROR:
        return "keep_lrc", "lrclib_error", details
    if res.status != la.STATUS_FOUND or not res.synced:
        return "keep_lrc", "no_lrclib_synced", details
    delta = (res.breakdown or {}).get("duration_delta")
    details["lrclib_duration_delta_s"] = delta
    lines = timed_line_count(res.synced)
    details["lrclib_timed_lines"] = lines
    details["lrc_timed_lines"] = timed_line_count(text)
    flaws = lrc_flaws(text, duration, lines)
    details["flaws"] = flaws
    if delta is None or delta > DURATION_TOLERANCE_S:
        return "keep_lrc", "lrclib_duration_mismatch", details
    if not flaws:
        return "keep_lrc", "lrc_looks_fine", details
    return "prefer_auto", ",".join(flaws), details


def run(args: argparse.Namespace) -> dict:
    library_db = args.library_db or default_library_db()
    nocturne_db = args.nocturne_db or default_nocturne_db()
    tracks = load_tracks(library_db)

    admin_ids: set = set()
    if Path(nocturne_db).exists():
        conn = _ro(nocturne_db)
        try:
            if _table_exists(conn, "v1_lyrics"):
                admin_ids = {r[0] for r in conn.execute("SELECT track_id FROM v1_lyrics")}
        finally:
            conn.close()

    wconn: Optional[sqlite3.Connection] = None
    backup = None
    if args.apply:
        c = sqlite3.connect(nocturne_db)
        ok = _table_exists(c, "v1_lyrics_prefs")
        c.close()
        if not ok:
            raise SystemExit("v1_lyrics_prefs does not exist yet: restart the service first "
                             "(migration v7 runs on start), then re-run --apply.")
        backup = backup_db(nocturne_db)
        log.info("backup written: %s", backup)
        wconn = sqlite3.connect(nocturne_db, timeout=30)
        wconn.execute("PRAGMA busy_timeout=30000")

    started = time.monotonic()
    out: list[dict] = []
    stats: Counter = Counter()
    looked = 0
    try:
        for t in tracks:
            lrc = la.read_lrc(t.get("file_path"))
            if not lrc:
                continue
            text = lrc[1]
            kind = classify_kind(text)
            base = {"track_id": t["id"], "title": t["title"], "artist": t["artist"],
                    "duration": t["duration"], "lrc_kind": kind}
            stats["with_lrc"] += 1
            stats[kind] += 1
            if t["id"] in admin_ids:
                stats["skip_admin"] += 1
                out.append(dict(base, decision="skip_admin", reason="admin lyrics have priority"))
                continue
            if kind != KIND_REAL:
                stats["skip_" + kind] += 1
                out.append(dict(base, decision="skip_" + kind,
                                reason="already ranks below LRCLIB / plain text" if kind == KIND_FAKE
                                else "no timestamps"))
                continue
            if args.limit and looked >= args.limit:
                stats["not_reviewed_limit"] += 1
                continue
            looked += 1
            res = la.lookup(t, deadline_s=None)
            decision, reason, details = decide(text, t.get("duration"), res)
            rep = dict(base, decision=decision, reason=reason, **details,
                       lrclib_status=res.status, matched_title=res.matched_title,
                       matched_artist=res.matched_artist, lrclib_id=res.lrclib_id,
                       confidence=round(res.confidence, 3))
            stats[decision] += 1
            if wconn is not None:
                now = datetime.now(timezone.utc).isoformat()
                if decision == "prefer_auto":
                    la.store(t["id"], res, conn=wconn)
                    wconn.execute(
                        """INSERT INTO v1_lyrics_prefs(track_id, prefer_auto, reason, decided_at)
                           VALUES (?,1,?,?) ON CONFLICT(track_id) DO UPDATE SET
                           prefer_auto=1, reason=excluded.reason, decided_at=excluded.decided_at""",
                        (t["id"], reason, now))
                    rep["stored"] = True
                else:
                    wconn.execute("UPDATE v1_lyrics_prefs SET prefer_auto=0, reason=?, decided_at=? "
                                  "WHERE track_id=?", (reason, now, t["id"]))
                wconn.commit()
            out.append(rep)
            log.info("[%d] %s | %s -> %s (%s)", looked, (t["title"] or "")[:50], t["artist"], decision, reason)
    finally:
        if wconn is not None:
            wconn.close()

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "mode": "apply" if args.apply else "dry-run",
        "library_db": library_db, "nocturne_db": nocturne_db, "backup": backup,
        "rules": {"duration_tolerance_s": DURATION_TOLERANCE_S, "fewer_lines_ratio": FEWER_LINES_RATIO,
                  "coarse_ratio": COARSE_RATIO, "grid_ratio": GRID_RATIO},
        "elapsed_s": round(time.monotonic() - started, 1),
        "summary": {"library_tracks": len(tracks), **dict(stats)},
        "tracks": out,
    }
    if args.report:
        Path(args.report).parent.mkdir(parents=True, exist_ok=True)
        Path(args.report).write_text(json.dumps(report, ensure_ascii=False, indent=1))
    return report


def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser(description="Review .lrc files against LRCLIB (prefer_auto decisions).")
    p.add_argument("--apply", action="store_true",
                   help="store decisions (v1_lyrics_prefs) and LRCLIB lyrics; backs up nocturne.db first. "
                        "Without it: read-only dry run.")
    p.add_argument("--report", help="write a JSON report here")
    p.add_argument("--limit", type=int, default=0, help="look up at most N real synced .lrc files")
    p.add_argument("--library-db", help="NOVA library.db (default: $MUSIC_DIR/library.db)")
    p.add_argument("--nocturne-db", help="nocturne.db (default: $NOCTURNE_DB_PATH or $MUSIC_DIR/nocturne.db)")
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if not la.lookups_enabled():
        print("LRCLIB lookups are disabled (NOCTURNE_TESTING / NOCTURNE_LYRICS_LOOKUP=0).", file=sys.stderr)
        return 2
    rep = run(args)
    print(json.dumps(rep["summary"], indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
