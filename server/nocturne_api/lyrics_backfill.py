"""
Backfill automatic lyrics (LRCLIB) for the existing library.

  Dry run (read-only: both DBs opened with mode=ro; writes only the JSON report):
    venv/bin/python -m nocturne_api.lyrics_backfill --dry-run --report /path/report.json \\
        [--cover-report /opt/music-server/cover-backfill/report-20261117-reviewed.json] [--limit N]

  Apply (stores results in nocturne.db table v1_lyrics_auto; backs up nocturne.db first
  with the SQLite backup API as <nocturne.db>.bak-lyrics-<timestamp>):
    runuser -u musicserver -- venv/bin/python -m nocturne_api.lyrics_backfill --apply \\
        [--cover-report ...] [--report ...] [--limit N]

Spotify imports (--spotify): tracks in v1_spotify_track_map get Spotify's clean
metadata (name, artists, album; Spotify duration when the file has none) as the
first, high-quality guess. Metadata comes from v1_spotify_track_meta and/or
--spotify-snapshot (written by the spotify_* CLIs). --only-spotify restricts the run
to those tracks; --retry-not-found looks up tracks whose auto row is `not_found`
again (found/instrumental rows are kept; a new not_found result only refreshes it).

    runuser -u musicserver -- venv/bin/python -m nocturne_api.lyrics_backfill --apply \
        --spotify --only-spotify --retry-not-found [--spotify-snapshot SNAP.json]

Tracks that already have admin lyrics (v1_lyrics), a .lrc file next to the audio or a
v1_lyrics_auto row are skipped (except not_found rows with --retry-not-found). The table is created by migration v4 (nocturne_api/db.py)
on service start, so restart the service before --apply. Never touches audio files.
This module does not import nocturne_api.config (no secrets needed).
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sqlite3
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from . import lyrics_auto as la

log = logging.getLogger("lyrics_backfill")


def _music_dir() -> str:
    return os.getenv("MUSIC_DIR", "").strip() or "./music"


def default_library_db() -> str:
    return str(Path(_music_dir()) / "library.db")


def default_nocturne_db() -> str:
    return os.getenv("NOCTURNE_DB_PATH", "").strip() or str(Path(_music_dir()) / "nocturne.db")


def _ro(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def load_tracks(library_db: str) -> list[dict]:
    conn = _ro(library_db)
    try:
        rows = conn.execute(
            "SELECT id, title, artist, album, duration, file_path FROM tracks ORDER BY added_at, id"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    return conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None


def load_existing(nocturne_db: str, retry_not_found: bool = False) -> tuple[set, set]:
    """(track ids with admin lyrics, track ids with an auto row to keep) — read-only."""
    if not Path(nocturne_db).exists():
        return set(), set()
    conn = _ro(nocturne_db)
    try:
        admin = {r[0] for r in conn.execute("SELECT track_id FROM v1_lyrics")} \
            if _table_exists(conn, "v1_lyrics") else set()
        q = "SELECT track_id FROM v1_lyrics_auto"
        if retry_not_found:
            q += " WHERE status <> 'not_found'"
        auto = {r[0] for r in conn.execute(q)} if _table_exists(conn, "v1_lyrics_auto") else set()
        return admin, auto
    finally:
        conn.close()


def load_spotify_guesses(nocturne_db: str, snapshot: Optional[str] = None) -> dict[str, dict]:
    """track_id -> {'title','artists','album','duration','label'} from Spotify metadata of
    v1_spotify_track_map tracks (oldest mapping wins). Read-only."""
    if not Path(nocturne_db).exists():
        return {}
    metas: dict[str, dict] = {}
    if snapshot:
        try:
            metas.update(json.loads(Path(snapshot).read_text()).get("tracks") or {})
        except Exception as exc:
            log.warning("spotify snapshot not usable (%s): %s", snapshot, exc)
    conn = _ro(nocturne_db)
    try:
        if not _table_exists(conn, "v1_spotify_track_map"):
            return {}
        if _table_exists(conn, "v1_spotify_track_meta"):
            for r in conn.execute("SELECT * FROM v1_spotify_track_meta"):
                if r["spotify_track_id"] not in metas:
                    metas[r["spotify_track_id"]] = {"name": r["name"], "artists": json.loads(r["artists"] or "[]"),
                                                    "album": r["album"], "duration_ms": r["duration_ms"]}
        rows = conn.execute("SELECT spotify_track_id, track_id FROM v1_spotify_track_map"
                            " ORDER BY created_at, spotify_track_id").fetchall()
    finally:
        conn.close()
    out: dict[str, dict] = {}
    for sid, tid in rows:
        m = metas.get(sid)
        if tid in out or not m or not m.get("name"):
            continue
        ms = m.get("duration_ms")
        out[tid] = {"title": m["name"], "artists": m.get("artists") or [], "album": m.get("album"),
                    "duration": int(round(ms / 1000)) if ms else None, "label": "spotify"}
    return out


def load_cover_guesses(path: Optional[str]) -> dict[str, list[dict]]:
    """track_id -> [{'title','artists'}] from a cover backfill report (decision 'apply' only)."""
    if not path:
        return {}
    try:
        data = json.loads(Path(path).read_text())
    except Exception as exc:
        log.warning("cover report not usable (%s): %s", path, exc)
        return {}
    out: dict[str, list[dict]] = {}
    for t in data.get("tracks", []) if isinstance(data, dict) else []:
        c = t.get("candidate") or {}
        if t.get("decision") == "apply" and c.get("title") and t.get("track_id"):
            out[t["track_id"]] = [{"title": c["title"], "artists": c.get("artists") or [],
                                   "label": "cover-report"}]
    return out


def backup_db(path: str) -> str:
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = f"{path}.bak-lyrics-{ts}"
    src = sqlite3.connect(path)
    dst = sqlite3.connect(dest)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    return dest


def run(args: argparse.Namespace) -> dict:
    library_db = args.library_db or default_library_db()
    nocturne_db = args.nocturne_db or default_nocturne_db()
    tracks = load_tracks(library_db)
    admin_ids, auto_ids = load_existing(nocturne_db, getattr(args, "retry_not_found", False))
    extra = load_cover_guesses(args.cover_report)
    spotify = load_spotify_guesses(nocturne_db, getattr(args, "spotify_snapshot", None)) \
        if getattr(args, "spotify", False) else {}
    if getattr(args, "only_spotify", False):
        tracks = [t for t in tracks if t["id"] in spotify]
    for tid, g in spotify.items():           # Spotify first: the highest-quality guess
        extra[tid] = [g] + [x for x in extra.get(tid, []) if x.get("title") != g["title"]]

    wconn: Optional[sqlite3.Connection] = None
    backup = None
    if args.apply:
        conn = sqlite3.connect(nocturne_db)
        ok = _table_exists(conn, "v1_lyrics_auto")
        conn.close()
        if not ok:
            raise SystemExit("v1_lyrics_auto does not exist yet: restart the service first "
                             "(migration v4 runs on start), then re-run --apply.")
        backup = backup_db(nocturne_db)
        log.info("backup written: %s", backup)
        wconn = sqlite3.connect(nocturne_db, timeout=30)
        wconn.execute("PRAGMA busy_timeout=30000")

    started = time.monotonic()
    out_tracks: list[dict] = []
    stats: Counter = Counter()
    processed = 0
    try:
        for t in tracks:
            base = {"track_id": t["id"], "title": t["title"], "artist": t["artist"], "duration": t["duration"]}
            skip = None
            if t["id"] in admin_ids:
                skip = "skip_admin"
            elif la.has_lrc_file(t.get("file_path")):
                skip = "skip_lrc_file"
            elif t["id"] in auto_ids:
                skip = "skip_auto_row"
            if skip:
                stats[skip] += 1
                out_tracks.append(dict(base, decision=skip))
                continue
            if args.limit and processed >= args.limit:
                break
            processed += 1
            sg = spotify.get(t["id"])
            if sg and not t.get("duration") and sg.get("duration"):
                t = dict(t, duration=sg["duration"])
            res = la.lookup(t, extra.get(t["id"]), deadline_s=None)
            rep = dict(base, **res.to_report())
            rep["cover_report_hint"] = bool(extra.get(t["id"]))
            rep["spotify_hint"] = t["id"] in spotify
            key = res.status
            if res.status == la.STATUS_FOUND:
                key = "found_synced" if res.synced else "found_plain_only"
            stats[key] += 1
            if wconn is not None and res.storable:
                la.store(t["id"], res, conn=wconn)
                rep["stored"] = True
            out_tracks.append(rep)
            log.info("[%d] %s | %s -> %s %.2f %s", processed, (t["title"] or "")[:60], t["artist"],
                     key, res.confidence, res.matched_title or "")
    finally:
        if wconn is not None:
            wconn.close()

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "mode": "apply" if args.apply else "dry-run",
        "library_db": library_db,
        "nocturne_db": nocturne_db,
        "cover_report": args.cover_report,
        "backup": backup,
        "rules": {"accept_threshold": la.ACCEPT_THRESHOLD, "max_duration_delta_s": la.MAX_DURATION_DELTA_S},
        "elapsed_s": round(time.monotonic() - started, 1),
        "stats": {"library_tracks": len(tracks), "looked_up": processed, **dict(stats)},
        "tracks": out_tracks,
    }
    if args.report:
        Path(args.report).parent.mkdir(parents=True, exist_ok=True)
        Path(args.report).write_text(json.dumps(report, ensure_ascii=False, indent=1))
    return report


def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser(description="Backfill LRCLIB lyrics into nocturne.db (v1_lyrics_auto).")
    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="read-only; only write the JSON report")
    mode.add_argument("--apply", action="store_true", help="store results in v1_lyrics_auto (backs up first)")
    p.add_argument("--limit", type=int, default=0, help="look up at most N tracks")
    p.add_argument("--report", help="write a JSON report here")
    p.add_argument("--cover-report", help="cover backfill report JSON (official titles as extra guesses)")
    p.add_argument("--spotify", action="store_true",
                   help="use Spotify metadata of imported tracks as the first guess")
    p.add_argument("--spotify-snapshot", help="Spotify snapshot JSON from the spotify_* CLIs")
    p.add_argument("--only-spotify", action="store_true", help="only tracks imported from Spotify (implies --spotify)")
    p.add_argument("--retry-not-found", action="store_true",
                   help="look up tracks whose auto row is not_found again")
    p.add_argument("--library-db", help="NOVA library.db (default: $MUSIC_DIR/library.db)")
    p.add_argument("--nocturne-db", help="nocturne.db (default: $NOCTURNE_DB_PATH or $MUSIC_DIR/nocturne.db)")
    args = p.parse_args(argv)
    if args.only_spotify:
        args.spotify = True
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if not la.lookups_enabled():
        print("LRCLIB lookups are disabled (NOCTURNE_TESTING / NOCTURNE_LYRICS_LOOKUP=0).", file=sys.stderr)
        return 2
    rep = run(args)
    print(json.dumps(rep["stats"], indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
