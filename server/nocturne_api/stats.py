"""
Listening statistics aggregation (pure helpers; no HTTP). Plays live in
v1_plays(user_id, track_id, played_at UTC ISO, seconds). Periods are computed in
Europe/Madrid local time; weeks start on Monday.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable, Optional
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Europe/Madrid")
RANGES = ("week", "month", "year", "all")


def _local_midnight(d: date) -> datetime:
    return datetime(d.year, d.month, d.day, tzinfo=TZ)


def _add_months(d: date, n: int) -> date:
    m = d.year * 12 + (d.month - 1) + n
    return date(m // 12, m % 12 + 1, 1)


def period_start(kind: str, today: date, offset: int = 0) -> date:
    """First local date of the period `offset` periods before the one containing `today`."""
    if kind == "week":
        return today - timedelta(days=today.weekday()) - timedelta(weeks=offset)
    if kind == "month":
        return _add_months(today.replace(day=1), -offset)
    if kind == "year":
        return date(today.year - offset, 1, 1)
    raise ValueError(kind)


def period_end(kind: str, start: date) -> date:
    """Exclusive end (local date) of the period starting at `start`."""
    if kind == "week":
        return start + timedelta(days=7)
    if kind == "month":
        return _add_months(start, 1)
    if kind == "year":
        return date(start.year + 1, 1, 1)
    raise ValueError(kind)


def to_utc_iso(d: date) -> str:
    """UTC ISO string of local midnight of `d` (matches how played_at is stored)."""
    return _local_midnight(d).astimezone(timezone.utc).isoformat()


def parse_ts(s: str) -> Optional[datetime]:
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def period_label(kind: str, start: Optional[date]) -> str:
    if kind == "all" or start is None:
        return "All time"
    if kind == "year":
        return str(start.year)
    if kind == "month":
        return start.strftime("%B %Y")
    end = start + timedelta(days=6)
    if start.year == end.year:
        left = f"{start.strftime('%b')} {start.day}"
        right = f"{end.day}" if start.month == end.month else f"{end.strftime('%b')} {end.day}"
        return f"{left} – {right}, {end.year}"
    return f"{start.strftime('%b')} {start.day}, {start.year} – {end.strftime('%b')} {end.day}, {end.year}"


def fetch_plays(conn, user_id: str, start: Optional[date], end: Optional[date]) -> list[dict]:
    sql = "SELECT track_id, played_at, seconds FROM v1_plays WHERE user_id=?"
    args: list[Any] = [user_id]
    if start is not None:
        sql += " AND played_at >= ?"
        args.append(to_utc_iso(start))
    if end is not None:
        sql += " AND played_at < ?"
        args.append(to_utc_iso(end))
    return [dict(r) for r in conn.execute(sql, args)]


def play_seconds(play: dict, durations: dict[str, float]) -> float:
    s = play.get("seconds") or 0
    if s > 0:
        return float(s)
    return float(durations.get(play["track_id"]) or 0)


def minutes(seconds: float) -> float:
    return round(seconds / 60.0, 1)


def totals(plays: Iterable[dict], durations: dict[str, float], artists_of: dict[str, list[str]]) -> dict:
    plays = list(plays)
    secs = sum(play_seconds(p, durations) for p in plays)
    tracks = {p["track_id"] for p in plays}
    artists: set[str] = set()
    for t in tracks:
        artists.update(artists_of.get(t, []))
    return {"minutes": minutes(secs), "plays": len(plays),
            "distinctTracks": len(tracks), "distinctArtists": len(artists)}


def group_by_key(plays: Iterable[dict], durations: dict[str, float], keys_of) -> list[tuple[Any, int, float]]:
    """keys_of(track_id) -> iterable of group keys. Returns [(key, plays, seconds)] sorted by plays, seconds."""
    agg: dict[Any, list[float]] = defaultdict(lambda: [0, 0.0])
    for p in plays:
        secs = play_seconds(p, durations)
        for k in keys_of(p["track_id"]):
            a = agg[k]
            a[0] += 1
            a[1] += secs
    out = [(k, int(v[0]), v[1]) for k, v in agg.items()]
    out.sort(key=lambda x: (-x[1], -x[2], str(x[0])))
    return out


def delta(cur: dict, prev: Optional[dict]) -> Optional[dict]:
    if prev is None:
        return None
    pm = prev["minutes"]
    return {
        "minutes": round(cur["minutes"] - pm, 1),
        "minutesPct": round((cur["minutes"] - pm) / pm * 100, 1) if pm > 0 else None,
        "plays": cur["plays"] - prev["plays"],
    }


def history_buckets(kind: str, count: int, today: date) -> list[date]:
    """Bucket start dates, oldest first, ending with the current period."""
    return [period_start(kind, today, o) for o in range(count - 1, -1, -1)]


def bucketize(plays: Iterable[dict], durations: dict[str, float], kind: str, buckets: list[date]) -> list[dict]:
    secs = {b: 0.0 for b in buckets}
    cnt = {b: 0 for b in buckets}
    for p in plays:
        dt = parse_ts(p["played_at"])
        if dt is None:
            continue
        b = period_start(kind, dt.astimezone(TZ).date(), 0)
        if b in secs:
            secs[b] += play_seconds(p, durations)
            cnt[b] += 1
    return [{"start": b.isoformat(), "minutes": minutes(secs[b]), "plays": cnt[b]} for b in buckets]


def heatmap(plays: Iterable[dict], durations: dict[str, float]) -> list[list[float]]:
    """7 (Mon..Sun) x 24 (local hour) matrix of minutes."""
    grid = [[0.0] * 24 for _ in range(7)]
    for p in plays:
        dt = parse_ts(p["played_at"])
        if dt is None:
            continue
        l = dt.astimezone(TZ)
        grid[l.weekday()][l.hour] += play_seconds(p, durations)
    return [[minutes(v) for v in row] for row in grid]
