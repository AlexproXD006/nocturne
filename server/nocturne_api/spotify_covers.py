"""
Official covers for library tracks imported from Spotify.

For each library track in v1_spotify_track_map (default --only-missing: tracks
without <covers>/<id>.official.jpg; --all-imported: every imported track):
  1. search iTunes/Deezer (backend/cover_art.py) with Spotify's CLEAN title, artists,
     album and the file's duration; use the result only at the `apply` threshold;
  2. otherwise fall back to the Spotify album image (largest, normally 640x640).
Rate limits are cover_art's (iTunes ~20 req/min, Deezer well below its limit).

  Dry run (read-only; writes only the report, the search cache and the snapshot):
    venv/bin/python -m nocturne_api.spotify_covers --dry-run --snapshot SNAP.json --out DIR [--report R.json]
  Apply (backs up library.db with the SQLite backup API, writes .official.jpg files,
  updates tracks.cover_path, writes <out>/undo-<ts>.json in backfill_covers' format).
  With --report it applies the decisions of that dry run (no new searches):
    runuser -u musicserver -- venv/bin/python -m nocturne_api.spotify_covers --apply --report R.json
  Undo (same as `backend/backfill_covers.py --apply --undo FILE`):
    runuser -u musicserver -- venv/bin/python -m nocturne_api.spotify_covers --undo <out>/undo-<ts>.json
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from . import spotify_catalog as sc

log = logging.getLogger("spotify_covers")


def targets(args, snap: dict) -> list[dict]:
    lib = sc.ro(args.library_db)
    noc = sc.ro(args.nocturne_db)
    try:
        rows = {r["id"]: dict(r) for r in lib.execute(
            "SELECT id, title, artist, album, duration, file_path, cover_path FROM tracks")}
        maps = sc.track_map(noc)
        metas = dict(sc.load_meta(noc))
        metas.update(snap.get("tracks") or {})
    finally:
        lib.close()
        noc.close()
    primary = sc.primary_spotify_ids(maps, metas)
    out = []
    for tid in dict.fromkeys(m["track_id"] for m in maps):
        row = rows.get(tid)
        if row is None:
            continue
        if args.only_missing and sc.is_official(row.get("cover_path")):
            continue
        sid = primary.get(tid)
        out.append({"track": row, "spotify_id": sid, "meta": metas.get(sid) if sid else None})
    return out


def decide_one(t: dict, *, search: bool = True) -> dict:
    import cover_art as ca
    row, meta = t["track"], t["meta"]
    rep = {"track_id": row["id"], "title": row["title"], "artist": row["artist"],
           "old_cover_path": row.get("cover_path"), "spotify_id": t["spotify_id"]}
    if not meta:
        return dict(rep, decision="no_spotify_meta")
    rep.update(spotify_title=meta["name"], spotify_artists=meta["artists"], spotify_album=meta.get("album"))
    m = None
    if search:
        m = ca.find_best_cover(meta["name"], sc.artists_joined(meta),
                               row.get("duration") or sc.duration_s(meta), meta.get("album"))
        rep.update(search_decision=m.decision, confidence=round(m.confidence, 3),
                   search_error=m.error)
    if m is not None and m.decision == ca.DECISION_APPLY and m.candidate:
        c = m.candidate
        return dict(rep, decision="apply", source=c.source,
                    candidate={"source": c.source, "title": c.title, "artists": c.artists, "album": c.album,
                               "art_url_max": c.art_url_max})
    if meta.get("image"):
        return dict(rep, decision="apply", source="spotify",
                    candidate={"source": "spotify", "title": meta["name"], "artists": meta["artists"],
                               "album": meta.get("album"), "art_url_max": meta["image"]})
    return dict(rep, decision="no_match", source=None)


def apply_decisions(args, decisions: list[dict]) -> dict:
    import cover_art as ca
    todo = [d for d in decisions if d.get("decision") == "apply" and d.get("candidate")]
    backup = sc.backup_sqlite(args.library_db, "spotify-covers")
    log.info("library.db backed up to %s; %d covers to apply", backup, len(todo))
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    undo_path = Path(args.out) / f"undo-{ts}.json"
    undo = {"created_at": datetime.now(timezone.utc).isoformat(), "db_path": args.library_db,
            "db_backup": backup, "changes": []}
    lib = sc.rw(args.library_db)
    stats = Counter()
    try:
        for d in todo:
            tid = d["track_id"]
            cur = lib.execute("SELECT cover_path FROM tracks WHERE id=?", (tid,)).fetchone()
            if cur is None:
                stats["track_gone"] += 1
                continue
            if args.only_missing and sc.is_official(cur[0]):
                stats["already_official"] += 1
                continue
            urls = [d["candidate"]]
            if d["candidate"]["source"] != "spotify" and d.get("spotify_fallback"):
                urls.append(d["spotify_fallback"])
            for cand in urls:
                try:
                    min_px = 300 if cand["source"] == "spotify" else ca.MIN_IMAGE_PX
                    path, w, h = sc.set_cover_from_url(lib, tid, cand["art_url_max"], args.covers_dir, min_px)
                except Exception as exc:
                    log.warning("skip %s (%s): %s", tid, cand["source"], exc)
                    continue
                undo["changes"].append({"track_id": tid, "old_cover_path": cur[0], "new_cover_path": path,
                                        "source": cand["source"], "art_url": cand["art_url_max"], "size": [w, h]})
                undo_path.write_text(json.dumps(undo, ensure_ascii=False, indent=1))
                stats[f"applied_{cand['source']}"] += 1
                break
            else:
                stats["failed"] += 1
    finally:
        lib.close()
    undo_path.write_text(json.dumps(undo, ensure_ascii=False, indent=1))
    return {"backup": backup, "undo": str(undo_path), **stats}


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--undo", metavar="UNDO_JSON")
    which = ap.add_mutually_exclusive_group()
    which.add_argument("--only-missing", dest="only_missing", action="store_true", default=True,
                       help="(default) only tracks without an official cover")
    which.add_argument("--all-imported", dest="only_missing", action="store_false",
                       help="every imported track (replaces existing official covers)")
    sc.add_common_args(ap)
    ap.add_argument("--report", help="dry run: where to write the report; apply: report to apply")
    ap.add_argument("--covers-dir", help="default: <MUSIC_DIR>/.covers")
    ap.add_argument("--no-search", action="store_true", help="skip iTunes/Deezer: Spotify image only")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("cover_art").setLevel(logging.WARNING)
    sc.resolve_common(args)
    import database as nova_db
    nova_db.DB_PATH = args.library_db
    args.covers_dir = args.covers_dir or nova_db._COVERS_DIR
    if args.undo:
        sys.path.insert(0, sc.BACKEND_DIR)
        import backfill_covers
        n = backfill_covers.undo_changes(args.undo, args.library_db)
        print(json.dumps({"reverted": n}))
        return 0
    import cover_art as ca
    ca.set_cache_dir(str(Path(args.out) / "search-cache"))
    if args.apply and args.report:
        rep = json.loads(Path(args.report).read_text())
        print(json.dumps(apply_decisions(args, rep["tracks"]), indent=1))
        return 0
    snap = sc.load_snapshot(args.nocturne_db, args.snapshot, refresh=args.refresh_snapshot,
                            persist_tokens=args.apply)
    ts_list = targets(args, snap)
    if args.limit:
        ts_list = ts_list[:args.limit]
    decisions, stats = [], Counter()
    started = time.monotonic()
    for n, t in enumerate(ts_list, 1):
        d = decide_one(t, search=not args.no_search)
        if d.get("source") and d["source"] != "spotify" and t["meta"] and t["meta"].get("image"):
            d["spotify_fallback"] = {"source": "spotify", "art_url_max": t["meta"]["image"]}
        decisions.append(d)
        stats[d.get("source") or d["decision"]] += 1
        if n % 25 == 0:
            log.info("%d/%d %s (%.0fs)", n, len(ts_list), dict(stats), time.monotonic() - started)
    report = {"generated_at": datetime.now(timezone.utc).isoformat(),
              "mode": "apply" if args.apply else "dry-run", "only_missing": args.only_missing,
              "stats": {"targets": len(ts_list), **stats}, "tracks": decisions}
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    path = args.report or str(Path(args.out) / f"covers-{report['mode']}-{ts}.json")
    Path(path).write_text(json.dumps(report, ensure_ascii=False, indent=1))
    out = dict(report["stats"], report=path)
    if args.apply:
        out["applied"] = apply_decisions(args, decisions)
    print(json.dumps(out, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
