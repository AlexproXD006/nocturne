"""
Backfill official album covers for the existing NOVA library.

  Dry run (default, read-only — opens the DB with mode=ro, writes only to --out):
    venv/bin/python backend/backfill_covers.py --out /path/to/report-dir

  Apply a reviewed dry-run report (backs up the DB, writes <covers>/<id>.official.jpg,
  updates tracks.cover_path for `apply` rows only unless --include-review, writes undo JSON):
    venv/bin/python backend/backfill_covers.py --apply --report /path/report.json --out /path/dir
        [--include-review] [--only-ids ids.txt] [--exclude-ids ids.txt]

  Undo a previous apply:
    venv/bin/python backend/backfill_covers.py --apply --undo /path/undo-<ts>.json

Never touches audio files. Old cover files are left in place (only cover_path changes),
so the undo JSON simply restores the previous cover_path values.
"""
from __future__ import annotations

import argparse
import html
import json
import logging
import os
import shutil
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import cover_art as ca  # noqa: E402

log = logging.getLogger("backfill_covers")


def _default_db_path() -> str:
    import database as db
    return db.DB_PATH


def _default_covers_dir() -> str:
    import database as db
    return db._COVERS_DIR


def _load_tracks_ro(db_path: str) -> list[dict]:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT id, title, artist, album, duration, file_path, cover_path FROM tracks ORDER BY added_at, id"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def _thumb_url(c: dict | None) -> str:
    if not c:
        return ""
    u = c.get("art_url_max") or ""
    if c.get("source") == "itunes":
        return ca.itunes_art_url(u, 200)
    return u.replace("/1000x1000-", "/250x250-")


def _make_current_thumb(cover_path: str | None, thumbs_dir: Path, track_id: str) -> str | None:
    if not cover_path or not os.path.exists(cover_path):
        return None
    try:
        from PIL import Image
        dest = thumbs_dir / f"{track_id}.jpg"
        if not dest.exists():
            with Image.open(cover_path) as im:
                im = im.convert("RGB")
                im.thumbnail((320, 200))
                im.save(dest, "JPEG", quality=80)
        return f"thumbs/{dest.name}"
    except Exception:
        return None


# ─────────────────────────────────────────────────────────────────────────────
# Dry run
# ─────────────────────────────────────────────────────────────────────────────

def dry_run(db_path: str, out_dir: Path, limit: int | None = None, ids: set[str] | None = None) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    thumbs = out_dir / "thumbs"
    thumbs.mkdir(exist_ok=True)
    ca.set_cache_dir(str(out_dir / "cache"))
    tracks = _load_tracks_ro(db_path)
    if ids:
        tracks = [t for t in tracks if t["id"] in ids]
    if limit:
        tracks = tracks[:limit]
    rows = []
    t0 = time.time()
    for i, t in enumerate(tracks, 1):
        try:
            m = ca.find_best_cover(t["title"], t["artist"], t["duration"], t["album"])
            md = m.to_dict()
        except Exception as exc:  # never abort the whole run
            md = {"decision": ca.DECISION_NO_MATCH, "confidence": 0.0, "candidate": None,
                  "guess": None, "breakdown": {}, "alternatives": [], "queries": [], "error": str(exc)}
        row = {
            "track_id": t["id"], "title": t["title"], "artist": t["artist"], "album": t["album"],
            "duration": t["duration"], "file_path": t["file_path"], "current_cover_path": t["cover_path"],
            "current_cover_thumb": _make_current_thumb(t["cover_path"], thumbs, t["id"]),
            **md,
        }
        rows.append(row)
        c = md.get("candidate") or {}
        log.info("[%d/%d] %-8s %.2f  %s  ->  %s / %s", i, len(tracks), md["decision"], md["confidence"],
                 (t["title"] or "")[:60], c.get("title"), ", ".join(c.get("artists") or []))
    stats = _stats(rows)
    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "db_path": db_path, "thresholds": {"apply": ca.APPLY_THRESHOLD, "review": ca.REVIEW_THRESHOLD},
        "elapsed_s": round(time.time() - t0, 1), "stats": stats, "tracks": rows,
    }
    (out_dir / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1))
    (out_dir / "report.html").write_text(render_html(report))
    (out_dir / "report.md").write_text(render_md(report))
    return report


def _stats(rows: list[dict]) -> dict:
    s: dict = {"total": len(rows), "by_decision": {}, "by_decision_source": {}}
    for r in rows:
        d = r["decision"]
        s["by_decision"][d] = s["by_decision"].get(d, 0) + 1
        src = (r.get("candidate") or {}).get("source") or "-"
        key = f"{d}:{src}"
        s["by_decision_source"][key] = s["by_decision_source"].get(key, 0) + 1
    return s


def render_md(report: dict) -> str:
    st = report["stats"]
    lines = [f"# Cover backfill dry run ({report['generated_at']})", "",
             f"Thresholds: apply >= {report['thresholds']['apply']}, review >= {report['thresholds']['review']}", "",
             "| decision | count |", "|---|---|"]
    for k, v in sorted(st["by_decision"].items()):
        lines.append(f"| {k} | {v} |")
    lines += ["", "| by decision:source | count |", "|---|---|"]
    for k, v in sorted(st["by_decision_source"].items()):
        lines.append(f"| {k} | {v} |")
    lines += ["", "| decision | conf | local title | local artist | dur | match | match artists | album | dur | src |",
              "|---|---|---|---|---|---|---|---|---|---|"]
    order = {"apply": 0, "review": 1, "no_match": 2}
    for r in sorted(report["tracks"], key=lambda r: (order.get(r["decision"], 3), -r["confidence"])):
        c = r.get("candidate") or {}
        esc = lambda x: str(x or "").replace("|", "\\|")
        lines.append(f"| {r['decision']} | {r['confidence']:.2f} | {esc(r['title'])} | {esc(r['artist'])} | "
                     f"{r['duration'] or ''} | {esc(c.get('title'))} | {esc(', '.join(c.get('artists') or []))} | "
                     f"{esc(c.get('album'))} | {c.get('duration_s') or ''} | {c.get('source') or ''} |")
    return "\n".join(lines) + "\n"


def render_html(report: dict) -> str:
    st = report["stats"]
    e = lambda x: html.escape(str(x if x is not None else ""))
    order = {"apply": 0, "review": 1, "no_match": 2}
    rows_html = []
    for r in sorted(report["tracks"], key=lambda r: (order.get(r["decision"], 3), -r["confidence"])):
        c = r.get("candidate") or {}
        g = r.get("guess") or {}
        b = r.get("breakdown") or {}
        cur = f'<img src="{e(r["current_cover_thumb"])}" loading="lazy">' if r.get("current_cover_thumb") else "<i>none</i>"
        new = (f'<a href="{e(c.get("art_url_max"))}" target="_blank"><img src="{e(_thumb_url(c))}" loading="lazy" class="sq"></a>'
               if c else "")
        rows_html.append(f"""<tr class="{e(r['decision'])}">
<td><b>{e(r['decision'])}</b><br>{r['confidence']:.2f}</td>
<td>{cur}</td><td>{new}</td>
<td><div class="t">{e(r['title'])}</div><div class="a">{e(r['artist'])} · {e(r['duration'])}s</div>
<div class="g">guess: {e(g.get('title'))} — {e(', '.join(g.get('artists') or []))} <small>[{e(g.get('label'))}]</small></div></td>
<td><div class="t">{e(c.get('title'))}</div><div class="a">{e(', '.join(c.get('artists') or []))}</div>
<div class="g">{e(c.get('album'))} · {e(c.get('duration_s'))}s · {e(c.get('source'))}</div></td>
<td class="b">title {e(b.get('title_sim'))}<br>artist {e(b.get('artist'))}<br>dur Δ {e(b.get('duration_delta'))}
{'<br>version≠' if b.get('version_mismatch') else ''}{'<br>2-src ✓' if b.get('cross_source_agree') else ''}</td>
<td class="id">{e(r['track_id'][:10])}</td></tr>""")
    summary = " · ".join(f"{k}: {v}" for k, v in sorted(st["by_decision"].items()))
    by_src = " · ".join(f"{k}: {v}" for k, v in sorted(st["by_decision_source"].items()))
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>Cover backfill report</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{{--bg:#fff;--fg:#111;--mut:#666;--line:#ddd;--apply:#e6f6ea;--review:#fff6db;--no:#f7e6e6}}
@media (prefers-color-scheme: dark){{:root{{--bg:#141414;--fg:#eee;--mut:#999;--line:#333;--apply:#16301d;--review:#332b10;--no:#331717}}}}
body{{background:var(--bg);color:var(--fg);font:14px system-ui,sans-serif;margin:16px}}
table{{border-collapse:collapse;width:100%}} td{{border-bottom:1px solid var(--line);padding:6px;vertical-align:top}}
img{{max-width:160px;max-height:100px}} img.sq{{width:100px;height:100px;object-fit:cover}}
tr.apply td:first-child{{background:var(--apply)}} tr.review td:first-child{{background:var(--review)}}
tr.no_match td:first-child{{background:var(--no)}} .a,.g,.b,.id{{color:var(--mut);font-size:12px}} .t{{font-weight:600}}
</style></head><body>
<h1>Cover backfill — dry run</h1>
<p>{e(report['generated_at'])} · {st['total']} tracks · {e(summary)}<br><small>{e(by_src)}</small><br>
<small>apply ≥ {report['thresholds']['apply']} · review ≥ {report['thresholds']['review']}</small></p>
<table><tr><th>decision</th><th>current</th><th>proposed</th><th>local</th><th>best match</th><th>score</th><th>id</th></tr>
{''.join(rows_html)}</table></body></html>"""


# ─────────────────────────────────────────────────────────────────────────────
# Apply / undo  (writes production data — run manually, service ideally stopped)
# ─────────────────────────────────────────────────────────────────────────────

def _backup_db(db_path: str, out_dir: Path) -> str:
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = out_dir / f"library.db.bak-covers-{ts}"
    src = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    dst = sqlite3.connect(str(dest))
    with dst:
        src.backup(dst)
    src.close()
    dst.close()
    return str(dest)


def _read_ids(path: str | None) -> set[str] | None:
    if not path:
        return None
    return {l.strip() for l in Path(path).read_text().splitlines() if l.strip() and not l.startswith("#")}


def apply(report_path: str, db_path: str, covers_dir: str, out_dir: Path, include_review: bool,
          only_ids: set[str] | None, exclude_ids: set[str] | None) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    report = json.loads(Path(report_path).read_text())
    wanted = {ca.DECISION_APPLY} | ({ca.DECISION_REVIEW} if include_review else set())
    todo = [r for r in report["tracks"] if r["decision"] in wanted and r.get("candidate")]
    if only_ids is not None:
        todo = [r for r in todo if r["track_id"] in only_ids]
    if exclude_ids:
        todo = [r for r in todo if r["track_id"] not in exclude_ids]
    backup = _backup_db(db_path, out_dir)
    log.info("DB backed up to %s; %d covers to apply", backup, len(todo))
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    undo = {"created_at": datetime.now(timezone.utc).isoformat(), "db_path": db_path,
            "db_backup": backup, "changes": []}
    undo_path = out_dir / f"undo-{ts}.json"
    conn = sqlite3.connect(db_path, timeout=30)
    try:
        for r in todo:
            tid = r["track_id"]
            cur = conn.execute("SELECT cover_path FROM tracks WHERE id=?", (tid,)).fetchone()
            if cur is None:
                log.warning("skip %s: track no longer exists", tid)
                continue
            try:
                data, w, h, _ = ca.fetch_cover_bytes(r["candidate"]["art_url_max"])
                new_path = ca.save_official_cover(tid, data, covers_dir)
            except Exception as exc:
                log.warning("skip %s: %s", tid, exc)
                continue
            with conn:
                conn.execute("UPDATE tracks SET cover_path=? WHERE id=?", (new_path, tid))
            undo["changes"].append({"track_id": tid, "old_cover_path": cur[0], "new_cover_path": new_path,
                                    "source": r["candidate"]["source"], "art_url": r["candidate"]["art_url_max"],
                                    "size": [w, h]})
            undo_path.write_text(json.dumps(undo, ensure_ascii=False, indent=1))  # incremental
            log.info("applied %s -> %s", tid, new_path)
    finally:
        conn.close()
    undo_path.write_text(json.dumps(undo, ensure_ascii=False, indent=1))
    log.info("done: %d applied, undo file %s", len(undo["changes"]), undo_path)
    return undo


def undo_changes(undo_path: str, db_path: str | None = None) -> int:
    undo = json.loads(Path(undo_path).read_text())
    db_path = db_path or undo["db_path"]
    n = 0
    conn = sqlite3.connect(db_path, timeout=30)
    try:
        with conn:
            for ch in undo["changes"]:
                # only revert rows still pointing at the cover we set
                cur = conn.execute("UPDATE tracks SET cover_path=? WHERE id=? AND cover_path=?",
                                   (ch["old_cover_path"], ch["track_id"], ch["new_cover_path"]))
                n += cur.rowcount
    finally:
        conn.close()
    log.info("reverted %d of %d cover_path values (official .jpg files left on disk)", n, len(undo["changes"]))
    return n


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", help="report / undo output directory")
    ap.add_argument("--db", default=None, help="library.db path (default: NOVA's DB_PATH)")
    ap.add_argument("--covers-dir", default=None, help="where official covers are written (default: <MUSIC_DIR>/.covers)")
    ap.add_argument("--dry-run", action="store_true", default=True, help="(default) match and report only")
    ap.add_argument("--apply", action="store_true", help="write covers + update DB from --report")
    ap.add_argument("--report", help="report.json from a dry run (required for --apply)")
    ap.add_argument("--include-review", action="store_true", help="also apply `review` decisions")
    ap.add_argument("--only-ids", help="file with track ids (one per line) to restrict to")
    ap.add_argument("--exclude-ids", help="file with track ids to skip")
    ap.add_argument("--undo", help="undo JSON written by a previous --apply (requires --apply)")
    ap.add_argument("--limit", type=int, help="dry run: only the first N tracks")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO if a.verbose or True else logging.WARNING,
                        format="%(asctime)s %(levelname)s %(message)s")
    db_path = a.db or _default_db_path()
    if a.undo:
        if not a.apply:
            ap.error("--undo modifies the DB; pass --apply --undo <file>")
        undo_changes(a.undo, a.db)
        return 0
    if a.apply:
        if not a.report or not a.out:
            ap.error("--apply needs --report <report.json> and --out <dir>")
        apply(a.report, db_path, a.covers_dir or _default_covers_dir(), Path(a.out),
              a.include_review, _read_ids(a.only_ids), _read_ids(a.exclude_ids))
        return 0
    if not a.out:
        ap.error("--out is required")
    rep = dry_run(db_path, Path(a.out), a.limit, _read_ids(a.only_ids))
    print(json.dumps(rep["stats"], indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
