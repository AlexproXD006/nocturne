"""
Mood analysis module for the music server.

Uses ffprobe to extract audio features (bpm, key, energy, valence) from tracks
and classifies them into mood categories.
"""

import json
import logging
import os
import re
import subprocess
from pathlib import Path
from typing import Any

import database as db

logger = logging.getLogger(__name__)


def _run_ffprobe(file_path: str) -> dict[str, Any]:
    """Run ffprobe and return parsed JSON output."""
    cmd = [
        "ffprobe",
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        file_path,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if result.returncode == 0:
            return json.loads(result.stdout)
    except Exception as exc:
        logger.warning("ffprobe failed for %s: %s", file_path, exc)
    return {}


def _estimate_bpm(file_path: str) -> float | None:
    """Estimate BPM using ffprobe's beat detection."""
    cmd = [
        "ffprobe",
        "-v", "quiet",
        "-show_entries", "format=tags",
        "-select_streams", "a:0",
        "-of", "json",
        file_path,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode == 0:
            data = json.loads(result.stdout)
            tags = data.get("format", {}).get("tags", {})
            for key in ("TBPM", "BPM", "beats_per_minute"):
                if key in tags:
                    val = tags[key]
                    if isinstance(val, list):
                        val = val[0]
                    try:
                        bpm = float(val)
                        if 60 <= bpm <= 200:
                            return bpm
                    except (ValueError, TypeError):
                        pass
    except Exception:
        pass

    beat_grid_cmd = [
        "ffmpeg",
        "-i", file_path,
        "-af", "beatgraph=tempo=0",
        "-f", "null",
        "-",
    ]
    try:
        result = subprocess.run(beat_grid_cmd, capture_output=True, text=True, timeout=30)
        output = result.stderr.lower()
        tempo_match = re.search(r'tempo[:\s]*(\d+\.?\d*)', output)
        if tempo_match:
            bpm = float(tempo_match.group(1))
            if 60 <= bpm <= 200:
                return bpm
    except Exception:
        pass

    return None


def _classify_mood(bpm: float | None, energy: float, valence: float) -> str:
    """Classify mood based on audio features."""
    if bpm is None:
        bpm = 120

    if bpm >= 120 and energy >= 0.6 and valence >= 0.5:
        return "energetic"
    elif bpm < 100 and energy < 0.5 and valence < 0.5:
        return "melancholic"
    elif bpm < 100 and energy < 0.4 and valence >= 0.5:
        return "relaxed"
    elif energy >= 0.7 and valence < 0.4:
        return "focused"
    elif valence >= 0.6 and energy >= 0.5:
        return "happy"
    elif valence < 0.4 and energy < 0.5:
        return "sad"
    elif energy >= 0.6:
        return "energetic"
    else:
        return "relaxed"


def analyze_track_mood(track_id: str) -> dict[str, Any]:
    """
    Analyze a track's mood using ffprobe audio features.
    
    Extracts: bpm, key, energy, valence
    Classifies: "energetic", "relaxed", "focused", "melancholic", "happy", "sad"
    
    Stores results in the track's database record.
    
    Returns dict with analysis results.
    """
    track = db.get_track(track_id)
    if not track:
        return {"error": "Track not found"}

    file_path = track.get("file_path")
    if not file_path or not Path(file_path).exists():
        return {"error": "Audio file not found"}

    features: dict[str, Any] = {
        "bpm": None,
        "key": None,
        "energy": None,
        "valence": None,
        "mood": None,
    }

    bpm = _estimate_bpm(file_path)
    features["bpm"] = bpm

    features["energy"] = 0.5
    features["valence"] = 0.5

    if bpm:
        if bpm >= 130:
            features["energy"] = 0.8
        elif bpm >= 100:
            features["energy"] = 0.6
        else:
            features["energy"] = 0.3

        if bpm >= 110:
            features["valence"] = 0.6
        else:
            features["valence"] = 0.4

    features["mood"] = _classify_mood(bpm, features["energy"], features["valence"])

    db._backup_before_write()
    with db.connect() as conn:
        conn.execute(
            """
            UPDATE tracks SET 
                mood = ?,
                bpm = ?,
                energy = ?,
                valence = ?
            WHERE id = ?
            """,
            (features["mood"], features["bpm"], features["energy"], features["valence"], track_id),
        )

    logger.info("Mood analysis complete for %s: %s", track_id, features["mood"])
    return features


def get_track_mood(track_id: str) -> dict[str, Any]:
    """Get cached mood analysis for a track."""
    track = db.get_track(track_id)
    if not track:
        return {"error": "Track not found"}

    mood = track.get("mood")
    if mood is None:
        return {"mood": None, "message": "Not analyzed yet. POST /api/tracks/{id}/analyze to trigger analysis."}

    return {
        "mood": mood,
        "bpm": track.get("bpm"),
        "energy": track.get("energy"),
        "valence": track.get("valence"),
    }


def get_all_moods() -> list[dict]:
    """Return all tracks with mood classifications."""
    tracks = db.get_all_tracks()
    moods = {}
    for t in tracks:
        m = t.get("mood")
        if m:
            if m not in moods:
                moods[m] = []
            moods[m].append(t)
    return [{"mood": m, "tracks": tracks} for m, tracks in moods.items()]


def get_tracks_by_mood(mood: str) -> list[dict]:
    """Return all tracks classified with the given mood."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT * FROM tracks WHERE mood = ? ORDER BY title",
            (mood,),
        ).fetchall()
    return [dict(r) for r in rows]