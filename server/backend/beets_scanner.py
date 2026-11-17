"""
Beets music scanner for automatic tagging and metadata extraction.
"""

import logging
import os
import shutil
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import database as db

logger = logging.getLogger(__name__)

MUSIC_DIR = os.getenv("MUSIC_DIR", "./music")
_COVERS_DIR = str(Path(MUSIC_DIR) / ".covers")

SCANNER_EXECUTOR = ThreadPoolExecutor(max_workers=2)


def _ensure_covers_dir() -> None:
    Path(_COVERS_DIR).mkdir(parents=True, exist_ok=True)


def _copy_cover_to_covers(source_path: str, track_id: str) -> str | None:
    """Copy cover image to .covers directory using track_id hash."""
    if not source_path or not Path(source_path).exists():
        return None
    _ensure_covers_dir()
    dest_path = str(Path(_COVERS_DIR) / f"{track_id}.cover")
    try:
        shutil.copy2(source_path, dest_path)
        return dest_path
    except Exception as exc:
        logger.warning("Failed to copy cover %s: %s", source_path, exc)
        return None


def scan_music_dir() -> dict:
    """
    Scan all music files in MUSIC_DIR using beets, extract metadata and covers.
    Returns a summary dict with counts of processed tracks.
    """
    import beets
    from beets import util
    from beets.library import Item, Library
    from beets.util import bysortkey
    import beets.plugins

    result = {
        "total": 0,
        "updated": 0,
        "errors": 0,
        "tracks": [],
    }

    music_path = Path(MUSIC_DIR).resolve()
    if not music_path.exists():
        logger.error("Music directory does not exist: %s", music_path)
        return result

    item_paths = []
    for root, _dirs, files in os.walk(music_path):
        for fname in files:
            if Path(fname).suffix.lower() in {".mp3", ".flac", ".m4a", ".ogg", ".wav", ".opus", ".webm", ".aac"}:
                item_paths.append(os.path.join(root, fname))

    result["total"] = len(item_paths)

    if not item_paths:
        return result

    try:
        from beets import config
        config.clear()
        config.read(user=False, defaults=True)

        beets_dir = str(Path(MUSIC_DIR) / ".beets")
        config["directory"] = str(music_path)
        config["library"] = str(Path(beets_dir) / "library.db")
        config["destination"] = str(music_path)
        config["as_is"] = True
        config["autotag"] = False

        lib_path = str(Path(beets_dir) / "library.db")
        Path(beets_dir).mkdir(parents=True, exist_ok=True)

        lib = Library(lib_path)

        import tempfile
        import inspect

        from beets.util import sibpath
        from beets import plugins

        logger.info("Starting beets scan of %d files", len(item_paths))

        for file_path in item_paths:
            try:
                normalized_path = util.normpath(file_path)

                item = None
                try:
                    item = lib.get_item(lib.items(file=normalized_path)[0].id) if lib.items(file=normalized_path) else None
                except Exception:
                    pass

                if item is None:
                    item = Item(file=normalized_path)
                    item.path = normalized_path

                try:
                    item.try_write()
                except Exception:
                    pass

                title = getattr(item, "title", None) or Path(file_path).stem
                artist = getattr(item, "artist", None) or "Unknown Artist"
                album = getattr(item, "album", None) or ""
                duration = getattr(item, "duration", None)
                if duration is not None:
                    duration = int(duration)
                track_number = getattr(item, "track", None) or 0
                genre = getattr(item, "genre", None) or ""

                cover_path = None

                if hasattr(item, "images") and item.images:
                    for img in item.images:
                        img_path = getattr(img, "path", None) or getattr(img, "file", None)
                        if img_path and Path(str(img_path)).exists():
                            cover_path = _copy_cover_to_covers(str(img_path), Path(file_path).stem)
                            if cover_path:
                                break

                if not cover_path:
                    for ext in (".jpg", ".jpeg", ".png", ".webp"):
                        candidate = Path(file_path).parent / f"cover{ext}"
                        if candidate.exists():
                            cover_path = _copy_cover_to_covers(str(candidate), Path(file_path).stem)
                            break
                    if not cover_path:
                        for name in ("folder.jpg", "folder.png", "cover.jpg", "cover.png"):
                            candidate = Path(file_path).parent / name
                            if candidate.exists():
                                cover_path = _copy_cover_to_covers(str(candidate), Path(file_path).stem)
                                break

                import hashlib
                track_id = hashlib.sha1(file_path.encode()).hexdigest()

                if cover_path:
                    final_cover = _copy_cover_to_covers(cover_path, track_id) or cover_path
                else:
                    final_cover = None

                track_data = {
                    "id": track_id,
                    "title": title,
                    "artist": artist,
                    "album": album,
                    "duration": duration,
                    "file_path": file_path,
                    "cover_path": final_cover,
                    "added_at": datetime.now(timezone.utc).isoformat(),
                }

                db.upsert_track(track_data)
                result["updated"] += 1
                result["tracks"].append(track_data)
                logger.info("Beets scanned: %s - %s", artist, title)

            except Exception as exc:
                logger.warning("Failed to scan %s: %s", file_path, exc)
                result["errors"] += 1

        lib._close()

    except ImportError as exc:
        logger.error("beets not installed: %s", exc)
        result["errors"] += 1
    except Exception as exc:
        logger.error("Beets scan failed: %s", exc)
        result["errors"] += 1

    return result


def scan_music_dir_async() -> dict:
    """Wrapper to run scan_music_dir in a thread executor."""
    future = SCANNER_EXECUTOR.submit(scan_music_dir)
    return future


def rescan_beats() -> str:
    """Start a beets scan in background, return job_id."""
    job_id = str(uuid.uuid4())
    import threading
    from beets import config

    config.clear()
    config.read(user=False, defaults=True)

    def _run():
        try:
            from beets import util
            from beets.library import Item, Library
            import beets.plugins

            music_path = Path(MUSIC_DIR).resolve()
            beets_dir = str(Path(MUSIC_DIR) / ".beets")
            Path(beets_dir).mkdir(parents=True, exist_ok=True)

            config["directory"] = str(music_path)
            config["library"] = str(Path(beets_dir) / "library.db")
            config["destination"] = str(music_path)
            config["as_is"] = True
            config["autotag"] = False

            lib_path = str(Path(beets_dir) / "library.db")
            lib = Library(lib_path)

            item_paths = []
            for root, _dirs, files in os.walk(music_path):
                for fname in files:
                    if Path(fname).suffix.lower() in {".mp3", ".flac", ".m4a", ".ogg", ".wav", ".opus", ".webm", ".aac"}:
                        item_paths.append(os.path.join(root, fname))

            for file_path in item_paths:
                try:
                    normalized_path = util.normpath(file_path)
                    items = list(lib.items(file=normalized_path))
                    if items:
                        item = lib.get_item(items[0].id)
                    else:
                        item = Item(file=normalized_path)
                        item.path = normalized_path

                    item.try_write()

                    title = getattr(item, "title", None) or Path(file_path).stem
                    artist = getattr(item, "artist", None) or "Unknown Artist"
                    album = getattr(item, "album", None) or ""
                    duration = getattr(item, "duration", None)
                    if duration is not None:
                        duration = int(duration)

                    cover_path = None
                    if hasattr(item, "images") and item.images:
                        for img in item.images:
                            img_path = getattr(img, "path", None)
                            if img_path and Path(str(img_path)).exists():
                                cover_path = _copy_cover_to_covers(str(img_path), Path(file_path).stem)
                                if cover_path:
                                    break

                    if not cover_path:
                        for ext in (".jpg", ".jpeg", ".png", ".webp"):
                            candidate = Path(file_path).parent / f"cover{ext}"
                            if candidate.exists():
                                cover_path = _copy_cover_to_covers(str(candidate), Path(file_path).stem)
                                break
                        if not cover_path:
                            for name in ("folder.jpg", "folder.png", "cover.jpg", "cover.png"):
                                candidate = Path(file_path).parent / name
                                if candidate.exists():
                                    cover_path = _copy_cover_to_covers(str(candidate), Path(file_path).stem)
                                    break

                    import hashlib
                    track_id = hashlib.sha1(file_path.encode()).hexdigest()

                    if cover_path:
                        final_cover = _copy_cover_to_covers(cover_path, track_id) or cover_path
                    else:
                        final_cover = None

                    track_data = {
                        "id": track_id,
                        "title": title,
                        "artist": artist,
                        "album": album,
                        "duration": duration,
                        "file_path": file_path,
                        "cover_path": final_cover,
                        "added_at": datetime.now(timezone.utc).isoformat(),
                    }
                    db.upsert_track(track_data)
                    logger.info("Beets re-scanned: %s - %s", artist, title)

                except Exception as exc:
                    logger.warning("Failed to re-scan %s: %s", file_path, exc)

            lib._close()
            logger.info("Beets rescan complete")
        except Exception as exc:
            logger.error("Beets rescan failed: %s", exc)

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
    return job_id