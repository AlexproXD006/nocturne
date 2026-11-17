"""
Repair finished Spotify imports without downloading anything.

  * ghost rows: parallel YouTube downloads used to register other jobs' half-written
    files ("X.temp.opus", "X.webm") as tracks. Each ghost whose real file ("X.opus")
    is in the library is folded into it (playlist entries, v1_spotify_track_map,
    likes, plays) and the ghost row is deleted (--keep-ghosts to leave the rows).
  * "Descargada, pero no aparece en la biblioteca": the same song listed under a
    second Spotify id; its download reused the existing file. Linked to that track.
  * "Duplicada" and repeated entries: added as extra occurrences of the same track at
    their Spotify positions (needs the playlist_tracks entry migration, i.e. NOVA
    restarted with the new code).
  * every newly resolved Spotify id is recorded in v1_spotify_track_map; the import's
    counters/failures are updated.

  Dry run (read-only; Spotify is read with an in-memory token, nothing is written
  except the report and the optional snapshot):
    venv/bin/python -m nocturne_api.spotify_repair --dry-run --snapshot /path/snap.json --out DIR
  Apply (backs up library.db and nocturne.db with the SQLite backup API first):
    runuser -u musicserver -- venv/bin/python -m nocturne_api.spotify_repair --apply \
        --snapshot /path/snap.json [--import-id imp_...] [--keep-ghosts]
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sqlite3
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from . import spotify_catalog as sc

log = logging.getLogger("spotify_repair")

AUDIO_EXTS = (".opus", ".m4a", ".mp3", ".flac", ".ogg", ".webm", ".wav", ".mp4")
ORPHAN_REASON = "no aparece en la biblioteca"
DUP_REASON = "Duplicada"
ORPHAN_MIN_SCORE = 0.70


def find_ghosts(rows: list[dict], exists=os.path.exists) -> dict[str, str]:
    """ghost track id -> real track id (same file stem without '.temp', any audio ext)."""
    by_path = {r["file_path"]: r["id"] for r in rows if r.get("file_path")}
    out: dict[str, str] = {}
    for r in rows:
        fp = r.get("file_path")
        if not fp or exists(fp):
            continue
        p = Path(fp)
        stem = p.stem[:-5] if p.stem.endswith(".temp") else p.stem
        for ext in AUDIO_EXTS:
            cand = str(p.with_name(stem + ext))
            if cand != fp and cand in by_path and exists(cand):
                out[r["id"]] = by_path[cand]
                break
    return out


def _candidate(meta: dict):
    from .spotify_import import spotify_candidate
    return spotify_candidate({"name": meta.get("name"), "artists": [{"name": a} for a in meta.get("artists") or []],
                              "album": {"name": meta.get("album") or ""}, "duration_ms": meta.get("duration_ms")})


def plan_playlist(pl_snap: dict, metas: dict, map_tid: dict[str, str], lib_rows: list[dict],
                  current: list[str], failures: list[dict], index=None) -> dict:
    """Resolve every Spotify entry of one imported playlist to a library track."""
    from . import spotify_import as si
    lib_ids = {r["id"] for r in lib_rows}
    entries = pl_snap["entries"]
    uniq = [s for s in dict.fromkeys(e for e in entries if e) if s in metas]
    cands = {s: _candidate(metas[s]) for s in uniq}
    keys = {s: si._dedupe_key(c) for s, c in cands.items()}
    orphan_hint = {(f.get("title"), tuple(f.get("artists") or [])) for f in failures
                   if ORPHAN_REASON in (f.get("reason") or "")}
    resolved: dict[str, dict] = {}
    by_key: dict[tuple, list[str]] = {}
    for s in uniq:
        tid = map_tid.get(s)
        if tid and tid in lib_ids:
            resolved[s] = {"track_id": tid, "how": "map", "confidence": 1.0}
            by_key.setdefault(keys[s], []).append(s)
    if index is None:
        index = si.LibraryIndex(lib_rows)
    for s in uniq:
        if s in resolved:
            continue
        sib = si.find_same_song(s, cands, keys, by_key)
        if sib:
            resolved[s] = {"track_id": resolved[sib]["track_id"], "how": "same-song", "confidence": 1.0,
                           "via": sib}
            by_key.setdefault(keys[s], []).append(s)
            continue
        tid, score, br = index.best(cands[s])
        m = metas[s]
        hinted = (m.get("name"), tuple(m.get("artists") or [])) in orphan_hint
        if tid and si.accept_library_match(score, br):
            resolved[s] = {"track_id": tid, "how": "library-match", "confidence": round(score, 3)}
        elif tid and hinted and score >= ORPHAN_MIN_SCORE and br.get("title_sim", 0) >= 0.8 \
                and br.get("artist", 0) >= 0.9 and not br.get("version_mismatch"):
            resolved[s] = {"track_id": tid, "how": "downloaded-orphan", "confidence": round(score, 3)}
        else:
            continue
        by_key.setdefault(keys[s], []).append(s)
    desired = [resolved[e]["track_id"] for e in entries if e and e in resolved]
    have = Counter(current)
    need = Counter(desired)
    missing = sum(max(0, n - have.get(t, 0)) for t, n in need.items())
    return {"resolved": resolved, "desired": desired, "missing_occurrences": missing,
            "unresolved": [s for s in uniq if s not in resolved],
            "orphans": [s for s in uniq if map_tid.get(s) is None and
                        (metas[s].get("name"), tuple(metas[s].get("artists") or [])) in orphan_hint]}


def _load_lib(path: str) -> tuple[list[dict], bool]:
    conn = sc.ro(path)
    try:
        rows = [dict(r) for r in conn.execute(
            "SELECT id, title, artist, album, duration, file_path, cover_path FROM tracks").fetchall()]
        migrated = "entry_id" in {r[1] for r in conn.execute("PRAGMA table_info(playlist_tracks)")}
        return rows, migrated
    finally:
        conn.close()


def _current_tids(lib_path: str, playlist_id: str, ghosts: dict[str, str]) -> list[str]:
    conn = sc.ro(lib_path)
    try:
        rows = conn.execute("SELECT pt.track_id FROM playlist_tracks pt JOIN tracks t ON t.id=pt.track_id"
                            " WHERE pt.playlist_id=? ORDER BY pt.position, pt.rowid", (playlist_id,)).fetchall()
    finally:
        conn.close()
    present = {t for (t,) in rows}
    # a ghost entry is dropped on apply when its real track is also in the playlist
    return [ghosts.get(t, t) for (t,) in rows if not (t in ghosts and ghosts[t] in present)]


def build_plan(args, snap: dict) -> dict:
    lib_rows, migrated = _load_lib(args.library_db)
    ghosts = find_ghosts(lib_rows)
    good_rows = [r for r in lib_rows if r["id"] not in ghosts]
    noc = sc.ro(args.nocturne_db)
    try:
        maps = sc.track_map(noc)
        imports = {r["id"]: r for r in sc.latest_imports(noc)}
        all_imports = {r["id"]: dict(r) for r in noc.execute("SELECT * FROM v1_spotify_imports").fetchall()}
    finally:
        noc.close()
    map_tid = {m["spotify_track_id"]: ghosts.get(m["track_id"], m["track_id"]) for m in maps}
    from .spotify_import import LibraryIndex
    index = LibraryIndex(good_rows)
    lib_by_id = {r["id"]: r for r in lib_rows}
    playlists = []
    for p in snap["playlists"]:
        if args.import_id and p["import_id"] != args.import_id:
            continue
        imp = all_imports.get(p["import_id"]) or imports.get(p["import_id"]) or {}
        failures = json.loads(imp.get("failures") or "[]")
        current = _current_tids(args.library_db, p["playlist_id"], ghosts)
        res = plan_playlist(p, snap["tracks"], map_tid, good_rows, current, failures, index)
        new_map = {s: r["track_id"] for s, r in res["resolved"].items()
                   if r["how"] != "map" or map_tid.get(s) != next(
                       (m["track_id"] for m in maps if m["spotify_track_id"] == s), None)}
        linked = []
        for s, r in res["resolved"].items():
            if r["how"] in ("same-song", "library-match", "downloaded-orphan") or s in res["orphans"]:
                t = lib_by_id.get(r["track_id"], {})
                linked.append({"spotify_id": s, "spotify_title": snap["tracks"][s]["name"],
                               "spotify_artists": snap["tracks"][s]["artists"], "how": r["how"],
                               "confidence": r["confidence"], "track_id": r["track_id"],
                               "library_title": t.get("title"), "library_artist": t.get("artist"),
                               "was_failure": s in res["orphans"]})
        playlists.append({
            "import_id": p["import_id"], "playlist_id": p["playlist_id"], "name": p.get("name"),
            "spotify_entries": len(p["entries"]),
            "resolved_entries": len(res["desired"]),
            "current_entries": len(current),
            "occurrences_to_add": res["missing_occurrences"],
            "new_map_rows": len(new_map),
            "orphans_linked": [x for x in linked if x["was_failure"]],
            "orphans_unresolved": [{"spotify_id": s, "title": snap["tracks"][s]["name"]}
                                   for s in res["orphans"] if s not in res["resolved"]],
            "linked": linked,
            "unresolved_ids": res["unresolved"],
            "_desired": res["desired"], "_new_map": new_map, "_resolved": res["resolved"],
        })
    return {"generated_at": datetime.now(timezone.utc).isoformat(), "library_db": args.library_db,
            "nocturne_db": args.nocturne_db, "playlist_tracks_migrated": migrated,
            "ghosts": [{"ghost_id": g, "real_id": r, "ghost_path": lib_by_id[g]["file_path"],
                        "real_path": lib_by_id[r]["file_path"]} for g, r in ghosts.items()],
            "rows_without_path": [r["id"] for r in lib_rows if not r.get("file_path")],
            "playlists": playlists}


def _fold_ghosts(lib: sqlite3.Connection, noc: sqlite3.Connection, ghosts: dict[str, str], delete: bool) -> dict:
    stats = Counter()
    with lib:
        for g, real in ghosts.items():
            for (pid,) in lib.execute("SELECT DISTINCT playlist_id FROM playlist_tracks WHERE track_id=?", (g,)).fetchall():
                if lib.execute("SELECT 1 FROM playlist_tracks WHERE playlist_id=? AND track_id=?", (pid, real)).fetchone():
                    stats["playlist_entries_dropped"] += lib.execute(
                        "DELETE FROM playlist_tracks WHERE playlist_id=? AND track_id=?", (pid, g)).rowcount
                else:
                    stats["playlist_entries_repointed"] += lib.execute(
                        "UPDATE playlist_tracks SET track_id=? WHERE playlist_id=? AND track_id=?", (real, pid, g)).rowcount
    with noc:
        for g, real in ghosts.items():
            stats["map_rows_repointed"] += noc.execute(
                "UPDATE v1_spotify_track_map SET track_id=? WHERE track_id=?", (real, g)).rowcount
            if sc.table_exists(noc, "v1_likes"):
                noc.execute("UPDATE OR IGNORE v1_likes SET track_id=? WHERE track_id=?", (real, g))
                noc.execute("DELETE FROM v1_likes WHERE track_id=?", (g,))
            if sc.table_exists(noc, "v1_plays"):
                noc.execute("UPDATE v1_plays SET track_id=? WHERE track_id=?", (real, g))
            if sc.table_exists(noc, "v1_lyrics_auto"):
                noc.execute("DELETE FROM v1_lyrics_auto WHERE track_id=?", (g,))
    if delete:
        with lib:
            for g in ghosts:
                stats["ghost_rows_deleted"] += lib.execute("DELETE FROM tracks WHERE id=?", (g,)).rowcount
    return dict(stats)


def _update_import_row(noc: sqlite3.Connection, import_id: str, plan_pl: dict, metas: dict) -> None:
    row = noc.execute("SELECT failures, failed, matched FROM v1_spotify_imports WHERE id=?", (import_id,)).fetchone()
    if not row:
        return
    failures = json.loads(row["failures"] or "[]")
    fixed = Counter()
    for s, r in plan_pl["_resolved"].items():
        m = metas[s]
        fixed[(m["name"], tuple(m["artists"]))] += 1
    keep, healed = [], 0
    for f in failures:
        k = (f.get("title"), tuple(f.get("artists") or []))
        reason = f.get("reason") or ""
        if (ORPHAN_REASON in reason or DUP_REASON in reason) and fixed.get(k):
            healed += 1
            continue
        keep.append(f)
    if healed:
        with noc:
            noc.execute("UPDATE v1_spotify_imports SET failures=?, failed=MAX(0, failed-?), matched=matched+?,"
                        " updated_at=? WHERE id=?",
                        (json.dumps(keep, ensure_ascii=False), healed, healed,
                         datetime.now(timezone.utc).isoformat(), import_id))


def apply(args, plan: dict, snap: dict) -> dict:
    if not plan["playlist_tracks_migrated"]:
        raise SystemExit("library.db still has the old playlist_tracks schema: deploy the new code and "
                         "restart the service once (the migration runs on start), then re-run --apply.")
    b1 = sc.backup_sqlite(args.library_db, "spotify-repair")
    b2 = sc.backup_sqlite(args.nocturne_db, "spotify-repair")
    log.info("backups: %s, %s", b1, b2)
    import database as nova_db
    nova_db.DB_PATH = args.library_db
    from . import playlists as pl
    ghosts = {g["ghost_id"]: g["real_id"] for g in plan["ghosts"]}
    lib = sc.rw(args.library_db)
    lib.execute("PRAGMA foreign_keys=ON")
    noc = sc.rw(args.nocturne_db)
    out = {"backups": [b1, b2]}
    try:
        out["ghosts"] = _fold_ghosts(lib, noc, ghosts, delete=not args.keep_ghosts)
        out["meta_cached"] = sc.store_meta(noc, snap["tracks"].values())
        now = datetime.now(timezone.utc).isoformat()
        for p in plan["playlists"]:
            with noc:
                for s, tid in p["_new_map"].items():
                    noc.execute("INSERT OR REPLACE INTO v1_spotify_track_map(spotify_track_id, track_id, source,"
                                " created_at) VALUES (?,?,?,?)", (s, tid, "repair", now))
            if not nova_db.get_playlist(p["playlist_id"]):
                log.warning("playlist %s no longer exists; map rows recorded only", p["playlist_id"])
                continue
            res = pl.sync_sequence(p["playlist_id"], p["_desired"])
            pl.touch(p["playlist_id"]) if res["added"] or res["reordered"] else None
            _update_import_row(noc, p["import_id"], p, snap["tracks"])
            out.setdefault("playlists", []).append({"playlist_id": p["playlist_id"], **res})
    finally:
        lib.close()
        noc.close()
    return out


def _public(plan: dict) -> dict:
    return {**plan, "playlists": [{k: v for k, v in p.items() if not k.startswith("_")} for p in plan["playlists"]]}


def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--apply", action="store_true")
    sc.add_common_args(p)
    p.add_argument("--import-id", help="only this import (default: newest import of every Spotify playlist)")
    p.add_argument("--keep-ghosts", action="store_true", help="repoint ghost rows but do not delete them")
    p.add_argument("--report", help="JSON report path (default: <out>/repair-<mode>-<ts>.json)")
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    sc.resolve_common(args)
    snap = sc.load_snapshot(args.nocturne_db, args.snapshot, refresh=args.refresh_snapshot,
                            persist_tokens=args.apply, import_id=args.import_id)
    plan = build_plan(args, snap)
    report = _public(plan)
    if args.apply:
        report["applied"] = apply(args, plan, snap)
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    path = args.report or str(Path(args.out) / f"repair-{'apply' if args.apply else 'dry-run'}-{ts}.json")
    Path(path).write_text(json.dumps(report, ensure_ascii=False, indent=1))
    summary = {"ghost_rows": len(plan["ghosts"]), "rows_without_path": len(plan["rows_without_path"]),
               "playlists": [{k: (len(v) if isinstance(v, list) else v) for k, v in pp.items()
                              if k in ("name", "spotify_entries", "resolved_entries", "current_entries",
                                       "occurrences_to_add", "new_map_rows", "orphans_linked",
                                       "orphans_unresolved")} for pp in report["playlists"]],
               "report": path}
    if args.apply:
        summary["applied"] = report["applied"]
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
