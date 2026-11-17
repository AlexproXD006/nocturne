"""
Radio / Recommendation system for the music server.

Uses audio features and mood analysis to find similar tracks and generate
radio station playlists.
"""

import logging
import math
import random
from typing import Any

import database as db
import mood_analyzer as ma

logger = logging.getLogger(__name__)


def _track_distance(t1: dict, t2: dict) -> float:
    """Compute a similarity score between two tracks based on features."""
    score = 0.0

    m1 = t1.get("mood")
    m2 = t2.get("mood")
    if m1 and m2:
        if m1 == m2:
            score += 5.0
        else:
            compatible = {
                ("energetic", "happy"),
                ("relaxed", "melancholic"),
                ("focused", "relaxed"),
                ("happy", "energetic"),
                ("sad", "melancholic"),
            }
            if (m1, m2) in compatible or (m2, m1) in compatible:
                score += 2.0

    energy1 = t1.get("energy") or 0.5
    energy2 = t2.get("energy") or 0.5
    score += 1.0 - abs(energy1 - energy2)

    valence1 = t1.get("valence") or 0.5
    valence2 = t2.get("valence") or 0.5
    score += 1.0 - abs(valence1 - valence2)

    bpm1 = t1.get("bpm")
    bpm2 = t2.get("bpm")
    if bpm1 and bpm2:
        bpm_diff = abs(bpm1 - bpm2)
        if bpm_diff <= 10:
            score += 3.0
        elif bpm_diff <= 20:
            score += 1.5

    artist1 = (t1.get("artist") or "").lower().strip()
    artist2 = (t2.get("artist") or "").lower().strip()
    if artist1 and artist2:
        if artist1 == artist2:
            score += 2.0
        elif artist1 in artist2 or artist2 in artist1:
            score += 1.0

    album1 = (t1.get("album") or "").lower().strip()
    album2 = (t2.get("album") or "").lower().strip()
    if album1 and album2 and album1 == album2:
        score += 1.0

    duration1 = t1.get("duration") or 0
    duration2 = t2.get("duration") or 0
    if duration1 and duration2:
        dur_diff = abs(duration1 - duration2)
        if dur_diff <= 30:
            score += 1.0

    return score


def get_radio_station(seed_track_id: str, limit: int = 50) -> list[dict]:
    """
    Generate a radio station playlist based on a seed track.
    
    Uses audio features (mood, energy, valence, bpm) to find similar tracks.
    Falls back to same artist if not enough similar tracks are found.
    
    Args:
        seed_track_id: The track ID to base the station on
        limit: Maximum number of tracks to return (default 50)
    
    Returns:
        List of track dictionaries representing the radio station playlist
    """
    seed = db.get_track(seed_track_id)
    if not seed:
        logger.warning("Seed track %s not found for radio station", seed_track_id)
        return []

    all_tracks = db.get_all_tracks()
    candidates = [t for t in all_tracks if t.get("id") != seed_track_id]

    scored = []
    for track in candidates:
        distance = _track_distance(seed, track)
        if distance > 0:
            scored.append((distance, track))

    scored.sort(key=lambda x: x[0], reverse=True)

    station = [t for _, t in scored[:limit]]

    if len(station) < limit:
        same_artist = [t for t in candidates if (t.get("artist") or "").lower() == (seed.get("artist") or "").lower()]
        for track in same_artist:
            if track not in station:
                station.append(track)
                if len(station) >= limit:
                    break

    if len(station) < limit:
        recent = sorted(all_tracks, key=lambda t: t.get("added_at") or "", reverse=True)
        for track in recent:
            if track not in station and track.get("id") != seed_track_id:
                station.append(track)
                if len(station) >= limit:
                    break

    return station


def get_mood_radio(mood: str, limit: int = 50) -> list[dict]:
    """
    Generate a radio station based on a mood category.
    
    Args:
        mood: One of "energetic", "relaxed", "focused", "melancholic", "happy", "sad"
        limit: Maximum number of tracks to return (default 50)
    
    Returns:
        List of track dictionaries representing the mood radio playlist
    """
    valid_moods = {"energetic", "relaxed", "focused", "melancholic", "happy", "sad"}
    mood_lower = mood.lower().strip()
    
    if mood_lower not in valid_moods:
        logger.warning("Invalid mood requested: %s", mood)
        return []

    tracks = ma.get_tracks_by_mood(mood_lower)
    
    if len(tracks) < limit:
        all_tracks = db.get_all_tracks()
        analyzed_moods = {t.get("mood") for t in all_tracks if t.get("mood")}
        
        if len(tracks) < limit and analyzed_moods:
            for analyzed_mood in analyzed_moods:
                if len(tracks) >= limit:
                    break
                mood_tracks = [t for t in all_tracks if t.get("mood") == analyzed_mood]
                for t in mood_tracks:
                    if t not in tracks:
                        tracks.append(t)
                        if len(tracks) >= limit:
                            break

    if len(tracks) < limit:
        all_tracks = db.get_all_tracks()
        unanalyzed = [t for t in all_tracks if not t.get("mood")]
        random.shuffle(unanalyzed)
        for t in unanalyzed:
            if t not in tracks:
                tracks.append(t)
                if len(tracks) >= limit:
                    break

    return tracks[:limit]


def get_similar_tracks(track_id: str, limit: int = 20) -> list[dict]:
    """Get the most similar tracks to the given track."""
    seed = db.get_track(track_id)
    if not seed:
        return []

    all_tracks = db.get_all_tracks()
    candidates = [t for t in all_tracks if t.get("id") != track_id]

    scored = []
    for track in candidates:
        distance = _track_distance(seed, track)
        if distance > 0:
            scored.append((distance, track))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [t for _, t in scored[:limit]]


def get_mood_distribution() -> dict[str, int]:
    """Get count of tracks per mood."""
    all_tracks = db.get_all_tracks()
    dist = {}
    for t in all_tracks:
        m = t.get("mood") or "unknown"
        dist[m] = dist.get(m, 0) + 1
    return dist