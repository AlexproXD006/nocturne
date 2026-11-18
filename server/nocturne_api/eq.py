"""
Per-user equalizer: the active state (on/off, preamp, 10 band gains) and custom presets.

Band centres (Hz): 31, 62, 125, 250, 500, 1k, 2k, 4k, 8k, 16k. Gains are -12..+12 dB in 0.5 dB steps,
the preamp is -12..+6 dB. Built-in presets live in the clients; the server only stores the id of the
selected one (`presetId`: a built-in id such as "rock", "custom:<uuid>" or null for a hand-edited curve).
"""
from __future__ import annotations

import json
import math
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from .db import connect

BANDS = 10
GAIN_MIN, GAIN_MAX = -12.0, 12.0
PREAMP_MIN, PREAMP_MAX = -12.0, 6.0
MAX_PRESETS = 50
NAME_MAX = 40
_PRESET_ID_RE = re.compile(r"^(?:[a-z0-9][a-z0-9_-]{0,31}|custom:[0-9a-f-]{8,40})$")


class EqError(ValueError):
    """Invalid equalizer input (mapped to HTTP 400)."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _num(v: Any, lo: float, hi: float, what: str) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise EqError(f"{what} must be a number.")
    if v < lo or v > hi:
        raise EqError(f"{what} must be between {lo:g} and {hi:g} dB.")
    return round(float(v) * 2) / 2 + 0.0  # 0.5 dB steps; "+ 0.0" turns -0.0 into 0.0


def clean_gains(raw: Any) -> list[float]:
    if not isinstance(raw, list) or len(raw) != BANDS:
        raise EqError(f"gains must be a list of {BANDS} numbers.")
    return [_num(g, GAIN_MIN, GAIN_MAX, "Gain") for g in raw]


def clean_preamp(raw: Any) -> float:
    return _num(raw, PREAMP_MIN, PREAMP_MAX, "Preamp")


def clean_name(raw: Any) -> str:
    if not isinstance(raw, str):
        raise EqError("name is required.")
    name = " ".join(raw.split())
    if not name:
        raise EqError("name is required.")
    if len(name) > NAME_MAX:
        raise EqError(f"name must be at most {NAME_MAX} characters.")
    return name


def clean_preset_id(raw: Any) -> Optional[str]:
    if raw is None:
        return None
    if not isinstance(raw, str) or not _PRESET_ID_RE.match(raw):
        raise EqError("presetId is invalid.")
    return raw


def _state_wire(row) -> dict:
    return {
        "enabled": bool(row["enabled"]),
        "preamp": row["preamp"],
        "gains": json.loads(row["gains"]),
        "presetId": row["preset_id"],
        "updatedAt": row["updated_at"],
    }


def default_state() -> dict:
    return {"enabled": True, "preamp": 0.0, "gains": [0.0] * BANDS, "presetId": "flat", "updatedAt": None}


def get_state(user_id: str) -> dict:
    with connect() as c:
        row = c.execute("SELECT * FROM v1_eq_state WHERE user_id=?", (user_id,)).fetchone()
    return _state_wire(row) if row else default_state()


def put_state(user_id: str, enabled: Any, preamp: Any, gains: Any, preset_id: Any) -> dict:
    if not isinstance(enabled, bool):
        raise EqError("enabled must be a boolean.")
    p, g, pid = clean_preamp(preamp), clean_gains(gains), clean_preset_id(preset_id)
    with connect() as c:
        if pid and pid.startswith("custom:"):
            ok = c.execute("SELECT 1 FROM v1_eq_presets WHERE id=? AND user_id=?", (pid, user_id)).fetchone()
            if not ok:
                pid = None  # a preset deleted from another device: keep the curve, drop the link
        c.execute(
            """INSERT INTO v1_eq_state(user_id, enabled, preamp, gains, preset_id, updated_at)
               VALUES (?,?,?,?,?,?)
               ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled, preamp=excluded.preamp,
               gains=excluded.gains, preset_id=excluded.preset_id, updated_at=excluded.updated_at""",
            (user_id, 1 if enabled else 0, p, json.dumps(g), pid, _now()),
        )
        c.commit()
    return get_state(user_id)


def _preset_wire(row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "preamp": row["preamp"],
        "gains": json.loads(row["gains"]),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def list_presets(user_id: str) -> list[dict]:
    with connect() as c:
        rows = c.execute(
            "SELECT * FROM v1_eq_presets WHERE user_id=? ORDER BY created_at, id", (user_id,)
        ).fetchall()
    return [_preset_wire(r) for r in rows]


def get_preset(user_id: str, preset_id: str) -> Optional[dict]:
    with connect() as c:
        row = c.execute("SELECT * FROM v1_eq_presets WHERE id=? AND user_id=?", (preset_id, user_id)).fetchone()
    return _preset_wire(row) if row else None


def create_preset(user_id: str, name: Any, preamp: Any, gains: Any) -> dict:
    n, p, g = clean_name(name), clean_preamp(preamp), clean_gains(gains)
    with connect() as c:
        count = c.execute("SELECT COUNT(*) FROM v1_eq_presets WHERE user_id=?", (user_id,)).fetchone()[0]
        if count >= MAX_PRESETS:
            raise EqError(f"At most {MAX_PRESETS} custom presets are allowed.")
        pid = f"custom:{uuid.uuid4()}"
        now = _now()
        c.execute(
            "INSERT INTO v1_eq_presets(id, user_id, name, preamp, gains, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
            (pid, user_id, n, p, json.dumps(g), now, now),
        )
        c.commit()
    return get_preset(user_id, pid)  # type: ignore[return-value]


def update_preset(user_id: str, preset_id: str, fields: dict) -> Optional[dict]:
    cur = get_preset(user_id, preset_id)
    if cur is None:
        return None
    n = clean_name(fields["name"]) if "name" in fields else cur["name"]
    p = clean_preamp(fields["preamp"]) if "preamp" in fields else cur["preamp"]
    g = clean_gains(fields["gains"]) if "gains" in fields else cur["gains"]
    with connect() as c:
        c.execute(
            "UPDATE v1_eq_presets SET name=?, preamp=?, gains=?, updated_at=? WHERE id=? AND user_id=?",
            (n, p, json.dumps(g), _now(), preset_id, user_id),
        )
        c.commit()
    return get_preset(user_id, preset_id)


def delete_preset(user_id: str, preset_id: str) -> bool:
    with connect() as c:
        cur = c.execute("DELETE FROM v1_eq_presets WHERE id=? AND user_id=?", (preset_id, user_id))
        c.execute("UPDATE v1_eq_state SET preset_id=NULL WHERE user_id=? AND preset_id=?", (user_id, preset_id))
        c.commit()
        return cur.rowcount > 0
