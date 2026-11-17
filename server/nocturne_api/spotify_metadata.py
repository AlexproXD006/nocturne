"""
Give every library track imported from Spotify Spotify's clean metadata.

For each track in v1_spotify_track_map (Spotify metadata from the snapshot /
v1_spotify_track_meta): tracks.title = Spotify name, tracks.artist = Spotify artists
joined with ", " (NOVA's convention), tracks.album = Spotify album. DB only: audio
files and their tags are never touched. The tracks FTS index follows via triggers.

Lyrics: auto lyrics (v1_lyrics_auto) of imported tracks that were looked up with the
messy YouTube titles are dropped so they are looked up again with the clean names
(lazy lookup on play, or `lyrics_backfill --apply --spotify`):
  --drop-lyrics not-found   (default) not_found rows of every imported track
  --drop-lyrics changed     ... plus every auto row (any status) of a renamed track
  --drop-lyrics none
Admin lyrics (v1_lyrics) and .lrc files are never touched. Dropped rows go to the
undo JSON too.

  Dry run (read-only):
    venv/bin/python -m nocturne_api.spotify_metadata --dry-run --snapshot SNAP.json --out DIR
  Apply (backs up library.db + nocturne.db with the SQLite backup API; writes
  <out>/metadata-undo-<ts>.json and records originals in v1_spotify_meta_undo):
    runuser -u musicserver -- venv/bin/python -m nocturne_api.spotify_metadata --apply --snapshot SNAP.json
  Undo:
    runuser -u musicserver -- venv/bin/python -m nocturne_api.spotify_metadata --undo <out>/metadata-undo-<ts>.json
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from . import spotify_catalog as sc

log = logging.getLogger("spotify_metadata")


def plan(args, snap: dict) -> dict:
    lib = sc.ro(args.library_db)
    noc = sc.ro(args.nocturne_db)
    try:
        rows = {r["id"]: dict(r) for r in lib.execute("SELECT id, title, artist, album, file_path FROM tracks")}
        maps = sc.track_map(noc)
        metas = dict(sc.load_meta(noc))
        metas.update(snap.get("tracks") or {})
        auto = {r[0]: r[1] for r in noc.execute("SELECT track_id, status FROM v1_lyrics_auto")} \
            if sc.table_exists(noc, "v1_lyrics_auto") else {}
    finally:
        lib.close()
        noc.close()
    primary = sc.primary_spotify_ids(maps, metas)
    mapped_tracks = {m["track_id"] for m in maps}
    changes, no_meta = [], []
    for tid in sorted(mapped_tracks):
        row = rows.get(tid)
        if row is None:
            continue
        sid = primary.get(tid)
        if not sid:
            no_meta.append(tid)
            continue
        ch = sc.metadata_change(row, metas[sid])
        if ch:
            changes.append(ch)
    changed = {c["track_id"] for c in changes}
    drop = []
    for tid in sorted(mapped_tracks & set(rows)):
        st = auto.get(tid)
        if st is None:
            continue
        if st == "not_found" and args.drop_lyrics in ("not-found", "changed"):
            drop.append(tid)
        elif tid in changed and args.drop_lyrics == "changed":
            drop.append(tid)
    stats = Counter()
    for c in changes:
        stats["title_changed"] += c["old_title"] != c["new_title"]
        stats["artist_changed"] += c["old_artist"] != c["new_artist"]
        stats["album_changed"] += c["old_album"] != c["new_album"]
    return {"mapped_tracks": len(mapped_tracks), "tracks_without_spotify_meta": no_meta,
            "changes": changes, "lyrics_rows_to_drop": drop,
            "lyrics_status_of_mapped": dict(Counter(auto.get(t, "none") for t in mapped_tracks)),
            "stats": dict(stats)}


def apply(args, p: dict, snap: dict) -> dict:
    b1 = sc.backup_sqlite(args.library_db, "spotify-meta")
    b2 = sc.backup_sqlite(args.nocturne_db, "spotify-meta")
    log.info("backups: %s, %s", b1, b2)
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    undo_path = Path(args.out) / f"metadata-undo-{ts}.json"
    undo = {"created_at": datetime.now(timezone.utc).isoformat(), "db_path": args.library_db,
            "nocturne_db": args.nocturne_db, "db_backup": b1, "nocturne_backup": b2,
            "changes": [], "dropped_lyrics": []}
    lib = sc.rw(args.library_db)
    noc = sc.rw(args.nocturne_db)
    try:
        sc.store_meta(noc, (snap.get("tracks") or {}).values())
        with lib:
            for ch in p["changes"]:
                if sc.apply_metadata_change(lib, ch, None, commit=False):
                    undo["changes"].append(ch)
        for ch in undo["changes"]:
            sc.record_undo(noc, ch)
        if p["lyrics_rows_to_drop"] and sc.table_exists(noc, "v1_lyrics_auto"):
            with noc:
                for tid in p["lyrics_rows_to_drop"]:
                    r = noc.execute("SELECT * FROM v1_lyrics_auto WHERE track_id=?", (tid,)).fetchone()
                    if r:
                        undo["dropped_lyrics"].append(dict(r))
                        noc.execute("DELETE FROM v1_lyrics_auto WHERE track_id=?", (tid,))
    finally:
        lib.close()
        noc.close()
    undo_path.write_text(json.dumps(undo, ensure_ascii=False, indent=1))
    return {"applied": len(undo["changes"]), "skipped_changed_meanwhile": len(p["changes"]) - len(undo["changes"]),
            "lyrics_rows_dropped": len(undo["dropped_lyrics"]), "undo": str(undo_path), "backups": [b1, b2]}


def undo(path: str, library_db: Optional[str], nocturne_db: Optional[str]) -> dict:
    u = json.loads(Path(path).read_text())
    library_db = library_db or u["db_path"]
    nocturne_db = nocturne_db or u.get("nocturne_db")
    lib = sc.rw(library_db)
    n = 0
    try:
        with lib:
            for ch in u["changes"]:
                n += sc.undo_metadata_change(lib, ch)
    finally:
        lib.close()
    restored = 0
    if nocturne_db and u.get("dropped_lyrics"):
        noc = sc.rw(nocturne_db)
        try:
            with noc:
                for r in u["dropped_lyrics"]:
                    cols = list(r)
                    cur = noc.execute(f"INSERT OR IGNORE INTO v1_lyrics_auto ({','.join(cols)}) VALUES "
                                      f"({','.join('?' * len(cols))})", [r[c] for c in cols])
                    restored += cur.rowcount
                for ch in u["changes"]:
                    noc.execute("DELETE FROM v1_spotify_meta_undo WHERE track_id=? AND new_title IS ?",
                                (ch["track_id"], ch["new_title"]))
        finally:
            noc.close()
    return {"reverted": n, "of": len(u["changes"]), "lyrics_rows_restored": restored}


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--undo", metavar="UNDO_JSON")
    sc.add_common_args(ap)
    ap.add_argument("--drop-lyrics", choices=("not-found", "changed", "none"), default="not-found")
    ap.add_argument("--examples", type=int, default=25)
    ap.add_argument("--report")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    sc.resolve_common(args)
    if args.undo:
        print(json.dumps(undo(args.undo, args.library_db, args.nocturne_db), indent=1))
        return 0
    snap = sc.load_snapshot(args.nocturne_db, args.snapshot, refresh=args.refresh_snapshot,
                            persist_tokens=args.apply)
    p = plan(args, snap)
    report = dict(p, generated_at=datetime.now(timezone.utc).isoformat(), mode="apply" if args.apply else "dry-run")
    if args.apply:
        report["applied"] = apply(args, p, snap)
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    path = args.report or str(Path(args.out) / f"metadata-{report['mode']}-{ts}.json")
    Path(path).write_text(json.dumps(report, ensure_ascii=False, indent=1))
    out = {"mapped_tracks": p["mapped_tracks"], "tracks_to_change": len(p["changes"]), **p["stats"],
           "tracks_without_spotify_meta": len(p["tracks_without_spotify_meta"]),
           "lyrics_rows_to_drop": len(p["lyrics_rows_to_drop"]),
           "lyrics_status_of_mapped": p["lyrics_status_of_mapped"], "report": path,
           "examples": [f"{c['old_title']} | {c['old_artist']}  ->  {c['new_title']} | {c['new_artist']}"
                        for c in p["changes"][:args.examples]]}
    if args.apply:
        out["applied"] = report["applied"]
    print(json.dumps(out, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
