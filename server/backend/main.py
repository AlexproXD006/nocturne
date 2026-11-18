"""
FastAPI application entry-point for the self-hosted music server.
"""

import asyncio
import json
import logging
import mimetypes
import os
import re
import requests
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncGenerator

# Allow nocturne_api to be imported from the parent directory
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import aiofiles
from dotenv import load_dotenv
from fastapi import (
    BackgroundTasks,
    FastAPI,
    HTTPException,
    Request,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import database as db
import downloader as dl
import lyrics_generator as lg
import mood_analyzer as ma
import radio as radio

_spotify_client_ready = False

# ─────────────────────────────────────────────────────────────────────────────
# Initialisation
# ─────────────────────────────────────────────────────────────────────────────

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
)
logger = logging.getLogger(__name__)

MUSIC_DIR = os.getenv("MUSIC_DIR", "./music")
PORT      = int(os.getenv("PORT", "8000"))


def _ensure_runtime_env() -> None:
    """Provide writable HOME/XDG dirs for service users without a real home."""
    app_root = Path(__file__).resolve().parent.parent
    runtime_home = Path(os.getenv("HOME") or app_root)

    # If HOME points to a non-writable location (e.g. /home/musicserver), fall back.
    try:
        runtime_home.mkdir(parents=True, exist_ok=True)
        test_file = runtime_home / ".write_test"
        test_file.touch(exist_ok=True)
        test_file.unlink(missing_ok=True)
    except Exception:
        runtime_home = app_root
        runtime_home.mkdir(parents=True, exist_ok=True)

    cache_dir = runtime_home / ".cache"
    config_dir = runtime_home / ".config"
    cache_dir.mkdir(parents=True, exist_ok=True)
    config_dir.mkdir(parents=True, exist_ok=True)

    os.environ["HOME"] = str(runtime_home)
    os.environ.setdefault("XDG_CACHE_HOME", str(cache_dir))
    os.environ.setdefault("XDG_CONFIG_HOME", str(config_dir))


_ensure_runtime_env()


def _ensure_spotify_client() -> None:
    """Initialise spotdl Spotify client once for playlist metadata calls."""
    global _spotify_client_ready
    if _spotify_client_ready:
        return

    client_id = (
        os.getenv("SPOTIPY_CLIENT_ID")
        or os.getenv("SPOTIFY_CLIENT_ID")
        or ""
    ).strip()
    client_secret = (
        os.getenv("SPOTIPY_CLIENT_SECRET")
        or os.getenv("SPOTIFY_CLIENT_SECRET")
        or ""
    ).strip()

    if not client_id or not client_secret:
        raise HTTPException(
            status_code=400,
            detail=(
                "Spotify credentials are missing. Set SPOTIPY_CLIENT_ID and "
                "SPOTIPY_CLIENT_SECRET in the music-server service environment."
            ),
        )

    try:
        from spotdl.utils.spotify import SpotifyClient  # type: ignore

        SpotifyClient.init(
            client_id=client_id,
            client_secret=client_secret,
            user_auth=False,
            no_cache=False,
            headless=True,
        )
    except Exception as exc:
        if "already been initialized" not in str(exc).lower():
            raise HTTPException(
                status_code=400,
                detail=f"Could not initialize Spotify client: {exc}",
            ) from exc

    _spotify_client_ready = True

app = FastAPI(title="Music Server", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─────────────────────────────────────────────────────────────────────────────
# Legacy NOVA API guard
# ─────────────────────────────────────────────────────────────────────────────
# The legacy NOVA endpoints below (/api/*, /ws/*) and FastAPI's /docs, /redoc and
# /openapi.json have NO authentication. Nocturne only uses the authenticated /v1
# API, so by default they are hidden (404) instead of relying on a reverse proxy
# to block them. NOVA_LEGACY_API:
#   off       (default) hide them for every client
#   internal  allow them only from loopback (127.0.0.1 / ::1)
#   on        expose them (old behaviour; only behind a proxy that blocks them)
_LEGACY_API_MODE = os.getenv("NOVA_LEGACY_API", "off").strip().lower() or "off"
_LEGACY_PREFIXES = ("/api/", "/ws/")
_LEGACY_EXACT = {"/api", "/ws", "/docs", "/docs/oauth2-redirect", "/redoc", "/openapi.json"}


class _LegacyApiGuard:
    """Pure ASGI middleware (also covers WebSockets, unlike @app.middleware)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket") and _LEGACY_API_MODE != "on":
            path = scope.get("path", "")
            if path in _LEGACY_EXACT or path.startswith(_LEGACY_PREFIXES):
                client_host = (scope.get("client") or ("", 0))[0]
                loopback = client_host in ("127.0.0.1", "::1")
                if not (_LEGACY_API_MODE == "internal" and loopback):
                    if scope["type"] == "websocket":
                        # Closing before accept makes the server answer HTTP 403.
                        await send({"type": "websocket.close", "code": 1008})
                        return
                    response = JSONResponse({"detail": "Not Found"}, status_code=404)
                    await response(scope, receive, send)
                    return
        await self.app(scope, receive, send)


app.add_middleware(_LegacyApiGuard)

download_manager = dl.DownloadManager()

# ─────────────────────────────────────────────────────────────────────────────
# Startup
# ─────────────────────────────────────────────────────────────────────────────


@app.on_event("startup")
async def startup() -> None:
    db.init_db()
    logger.info("Database initialised at %s", db.DB_PATH)

    # Scan existing files in a thread so we don't block the event loop
    loop = asyncio.get_running_loop()
    added = await loop.run_in_executor(None, dl.scan_and_upsert, MUSIC_DIR)
    logger.info("Startup scan complete — %d new track(s) imported", len(added))

    # Mount Nocturne /v1 API and the hosted SPA at /
    try:
        from nocturne_api.app import setup_nocturne
        setup_nocturne(app, mount_web=True)
    except Exception as _nc_err:
        logger.error("Nocturne API startup failed: %s", _nc_err)
        raise


# ─────────────────────────────────────────────────────────────────────────────
# Pydantic request models
# ─────────────────────────────────────────────────────────────────────────────


class DownloadRequest(BaseModel):
    url:        str | None = None
    query:      str | None = None
    track_id:   str | None = None   # Spotify track ID
    title:      str | None = None
    artist:     str | None = None
    cover_url:  str | None = None
    duration:   int | None = None


class CreatePlaylistRequest(BaseModel):
    name: str


class AddTrackRequest(BaseModel):
    track_id: str


class YTDownloadRequest(BaseModel):
    url:    str
    title:  str = ""
    artist: str = ""


class ReorderRequest(BaseModel):
    track_ids: list[str]  # full ordered list of track IDs


class ImportSpotifyPlaylistRequest(BaseModel):
    url: str
    overwrite: bool = True


class SmartPlaylistRule(BaseModel):
    field: str
    op: str
    value: str | int


class CreateSmartPlaylistRequest(BaseModel):
    name: str
    rules: list[SmartPlaylistRule]
    limit_count: int | None = 50


def _norm(text: str | None) -> str:
    return " ".join((text or "").lower().split())


def _pick_downloaded_track(before_ids: set[str], title: str, artist: str) -> dict | None:
    tracks = db.get_all_tracks()
    fresh = [t for t in tracks if t.get("id") not in before_ids]
    if not fresh:
        return None

    target_title = _norm(title)
    target_artist = _norm(artist)

    def score(track: dict) -> tuple[int, str]:
        t_title = _norm(track.get("title"))
        t_artist = _norm(track.get("artist"))
        s = 0
        if target_title and t_title == target_title:
            s += 4
        elif target_title and (target_title in t_title or t_title in target_title):
            s += 2
        if target_artist and t_artist == target_artist:
            s += 3
        elif target_artist and (target_artist in t_artist or t_artist in target_artist):
            s += 1
        return (s, track.get("added_at") or "")

    fresh.sort(key=score, reverse=True)
    return fresh[0]


async def _wait_for_job(job_id: str, timeout_sec: int = 900) -> dict | None:
    elapsed = 0.0
    step = 0.5
    while elapsed < timeout_sec:
        job = download_manager.get_job(job_id)
        if job and job.get("status") in {"done", "error"}:
            return job
        await asyncio.sleep(step)
        elapsed += step
    return download_manager.get_job(job_id)


# ─────────────────────────────────────────────────────────────────────────────
# /api/search  — Spotify search
# ─────────────────────────────────────────────────────────────────────────────


@app.get("/api/search")
async def search_spotify(q: str = "") -> dict:
    if not q.strip():
        raise HTTPException(status_code=400, detail="Query parameter 'q' is required")
    
    results = await download_manager.search_spotify(q)
    
    # If no Spotify results, fallback to YouTube automatically
    if not results:
        logger.info("No Spotify results, falling back to YouTube search")
        yt_results = await download_manager.search_youtube(q)
        # Convert YouTube format to Spotify-like format for consistency
        converted = []
        for r in yt_results:
            converted.append({
                "id": r.get("id", ""),
                "title": r.get("title", "Unknown"),
                "artist": r.get("channel", ""),
                "album": "",
                "url": r.get("url", ""),
                "duration_ms": (r.get("duration", 0) or 0) * 1000,
                "cover_url": r.get("thumbnail", ""),
                "source": "youtube",
            })
        return {"tracks": converted, "source": "youtube"}
    
    return {"tracks": results, "source": "spotify"}


# ─────────────────────────────────────────────────────────────────────────────
# /api/download
# ─────────────────────────────────────────────────────────────────────────────


@app.post("/api/download")
async def start_download(body: DownloadRequest) -> dict:
    # Support Spotify track_id (sent as spotify:track:ID or bare ID)
    if body.track_id:
        spotify_url = (
            body.track_id
            if body.track_id.startswith("https://")
            else f"https://open.spotify.com/track/{body.track_id}"
        )
        job_id = await download_manager.download_track(
            spotify_url,
            title=body.title or "",
            artist=body.artist or "",
            cover_url=body.cover_url or "",
        )
        return {"job_id": job_id}

    target = body.url or body.query
    if not target:
        raise HTTPException(status_code=400, detail="Provide 'track_id', 'url' or 'query' in the request body")
    job_id = await download_manager.download_track(target)
    return {"job_id": job_id}


@app.get("/api/download/status/{job_id}")
async def download_status(job_id: str) -> dict:
    job = download_manager.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.get("/api/download/jobs")
async def all_jobs() -> list[dict]:
    return download_manager.get_all_jobs()


# ─────────────────────────────────────────────────────────────────────────────
# /api/library
# ─────────────────────────────────────────────────────────────────────────────


@app.get("/api/library")
async def library() -> list[dict]:
    return db.get_all_tracks()


@app.get("/api/library/search")
async def library_search(q: str = "") -> list[dict]:
    if not q.strip():
        return db.get_all_tracks()
    return db.search_tracks(q)


@app.delete("/api/library/{track_id}")
async def delete_track(track_id: str) -> dict:
    track = db.get_track(track_id)
    if track is None:
        raise HTTPException(status_code=404, detail="Track not found")

    # Remove the file from disk if it still exists
    file_path = track.get("file_path")
    if file_path and Path(file_path).exists():
        try:
            Path(file_path).unlink()
        except OSError as exc:
            logger.warning("Could not delete file %s: %s", file_path, exc)

    # Remove cover if it is specific to this track (not a shared folder cover)
    cover_path = track.get("cover_path")
    if cover_path and Path(cover_path).exists():
        stem = Path(file_path).stem if file_path else ""
        if stem and Path(cover_path).stem == stem:
            try:
                Path(cover_path).unlink()
            except OSError:
                pass

    db.delete_track(track_id)
    return {"deleted": track_id}


# ─────────────────────────────────────────────────────────────────────────────
# /api/stream/{track_id}  — Range-aware audio streaming
# ─────────────────────────────────────────────────────────────────────────────


def _guess_mime(file_path: str) -> str:
    mime, _ = mimetypes.guess_type(file_path)
    return mime or "application/octet-stream"


async def _ranged_file_response(
    file_path: str,
    range_header: str | None,
) -> StreamingResponse:
    file_size = Path(file_path).stat().st_size
    mime_type = _guess_mime(file_path)

    # Parse "bytes=start-end"
    start = 0
    end   = file_size - 1

    if range_header:
        try:
            unit, ranges = range_header.split("=", 1)
            range_start, range_end = ranges.split("-", 1)
            if range_start:
                start = int(range_start)
            if range_end:
                end = min(int(range_end), file_size - 1)
        except Exception:
            pass  # fall back to full file

    chunk_size  = 512 * 1024  # 512 KB per chunk
    content_len = end - start + 1

    async def _generate() -> AsyncGenerator[bytes, None]:
        async with aiofiles.open(file_path, "rb") as f:
            await f.seek(start)
            remaining = content_len
            while remaining > 0:
                read_size = min(chunk_size, remaining)
                data = await f.read(read_size)
                if not data:
                    break
                remaining -= len(data)
                yield data

    status_code = 206 if range_header else 200
    headers = {
        "Content-Range":  f"bytes {start}-{end}/{file_size}",
        "Accept-Ranges":  "bytes",
        "Content-Length": str(content_len),
        "Cache-Control":  "no-cache",
    }
    return StreamingResponse(
        _generate(),
        status_code=status_code,
        media_type=mime_type,
        headers=headers,
    )


@app.get("/api/stream/{track_id}")
async def stream_track(track_id: str, request: Request) -> StreamingResponse:
    track = db.get_track(track_id)
    if track is None:
        raise HTTPException(status_code=404, detail="Track not found")

    file_path = track.get("file_path")
    if not file_path or not Path(file_path).exists():
        raise HTTPException(status_code=404, detail="Audio file not found on disk")

    range_header = request.headers.get("range")
    return await _ranged_file_response(file_path, range_header)


# ─────────────────────────────────────────────────────────────────────────────
# /api/cover/{track_id}
# ─────────────────────────────────────────────────────────────────────────────


@app.get("/api/folders")
async def list_folders() -> dict:
    """List all folders in music directory."""
    folders = set()
    music_path = Path(MUSIC_DIR).resolve()
    if music_path.exists():
        for root, dirs, _ in os.walk(music_path):
            for d in dirs:
                if not d.startswith('.'):
                    rel_path = Path(root).relative_to(music_path) / d
                    folders.add(str(rel_path))
    return {"folders": sorted(folders)}


@app.get("/api/folders/{folder_path:path}")
async def folder_tracks(folder_path: str) -> list[dict]:
    """Get all tracks in a specific folder."""
    folder = Path(MUSIC_DIR) / folder_path
    if not folder.exists() or not folder.is_dir():
        raise HTTPException(status_code=404, detail="Folder not found")
    
    tracks = db.get_all_tracks()
    folder_tracks = []
    folder_abs = str(folder.resolve())
    
    for track in tracks:
        fp = track.get("file_path", "")
        if fp and Path(fp).parent.resolve() == Path(folder_abs).resolve():
            folder_tracks.append(track)
    
    return folder_tracks


@app.post("/api/folders/{folder_path:path}/playlist")
async def folder_to_playlist(folder_path: str) -> dict:
    """Create a playlist from all tracks in a folder."""
    folder = Path(MUSIC_DIR) / folder_path
    if not folder.exists() or not folder.is_dir():
        raise HTTPException(status_code=404, detail="Folder not found")

    folder_name = folder.name or "Imported Folder"
    existing = db.get_playlist_by_name(folder_name)
    target = existing if existing else db.create_playlist(folder_name)
    target_id = target["id"]

    folder_abs = str(folder.resolve())
    tracks = db.get_all_tracks()
    added = []
    for track in tracks:
        fp = track.get("file_path", "")
        if fp and Path(fp).parent.resolve() == Path(folder_abs).resolve():
            db.add_track_to_playlist(target_id, track["id"])
            added.append(track["id"])

    return {"playlist_id": target_id, "added": len(added), "playlist": target}


@app.get("/api/search/fts")
async def search_fts(q: str = "") -> list[dict]:
    if not q.strip():
        raise HTTPException(status_code=400, detail="Query parameter 'q' is required")
    return db.search_tracks_fts(q)


@app.get("/api/albums")
async def list_albums() -> list[dict]:
    return db.get_all_albums()


@app.get("/api/albums/{album:path}/tracks")
async def album_tracks(album: str, artist: str = "") -> list[dict]:
    return db.get_album_tracks(album, artist)


@app.get("/api/artists")
async def list_artists() -> list[dict]:
    return db.get_all_artists()


@app.get("/api/artists/{artist:path}/tracks")
async def artist_tracks(artist: str) -> list[dict]:
    return db.get_artist_tracks(artist)


@app.post("/api/lyrics/{track_id}/translate")
async def translate_lyrics(track_id: str, target_lang: str = "english") -> dict:
    """Translate existing lyrics using Ollama LLM."""
    track = db.get_track(track_id)
    if track is None:
        raise HTTPException(status_code=404, detail="Track not found")

    file_path = track.get("file_path")
    if not file_path:
        return {"error": "No file path"}

    lrc_path = Path(file_path).with_suffix('.lrc')
    if not lrc_path.exists():
        return {"error": "No lyrics found. Generate them first."}

    try:
        lrc_text = lrc_path.read_text(encoding='utf-8')
    except Exception:
        return {"error": "Could not read lyrics file"}

    # Strip timestamps for translation
    plain_lines = []
    for line in lrc_text.split('\n'):
        text = re.sub(r'\[\d{2}:\d{2}\.\d{2,3}\]', '', line).strip()
        if text:
            plain_lines.append(text)
    plain = '\n'.join(plain_lines)

    if len(plain) < 10:
        return {"error": "Lyrics too short to translate"}

    prompt = f"""Translate the following song lyrics to {target_lang}.
Keep the line structure exactly the same (same number of lines).
Do not add explanations or notes. Output ONLY the translated lyrics, one line per original line.

Original lyrics:
{plain}

Translation:"""

    try:
        resp = requests.post(
            f"{lg.OLLAMA_BASE}/api/generate",
            json={"model": "llama3.1:8b", "prompt": prompt, "stream": False, "options": {"temperature": 0.3, "num_predict": 1024}},
            timeout=60,
        )
        if resp.status_code == 200:
            result = resp.json()
            translated = result.get("response", "").strip()
            # Re-attach original timestamps line-by-line
            original_lines = lrc_text.split('\n')
            translated_lines = translated.split('\n')
            output_lines = []
            t_idx = 0
            for orig in original_lines:
                ts_match = re.search(r'(\[\d{2}:\d{2}\.\d{2,3}\])', orig)
                if ts_match and t_idx < len(translated_lines):
                    output_lines.append(f"{ts_match.group(1)}{translated_lines[t_idx].strip()}")
                    t_idx += 1
                else:
                    output_lines.append(orig)
            return {"lyrics": '\n'.join(output_lines), "target_lang": target_lang, "translated": True}
    except Exception as e:
        logger.warning("Translation failed: %s", e)

    return {"error": "Translation failed"}


@app.get("/api/cover/{track_id}")
async def cover_image(track_id: str) -> FileResponse:
    track = db.get_track(track_id)
    if track is None:
        raise HTTPException(status_code=404, detail="Track not found")

    cover_path = track.get("cover_path")
    if cover_path:
        p = Path(cover_path)
        if p.exists():
            return FileResponse(str(p))

    file_path = track.get("file_path")
    if file_path:
        fp = Path(file_path)
        parent = fp.parent
        base_clean = fp.stem.replace('.mp3','').replace('.m4a','').replace('.webm','').replace('.flac','').replace('.ogg','').replace('.wav','')

        for ext in ['.cover.png', '.cover.jpg', '.png', '.jpg', '.jpeg', '.webp']:
            cand = parent / f"{base_clean}{ext}"
            if cand.exists():
                return FileResponse(str(cand))

    raise HTTPException(status_code=404, detail="Cover image not found")


# ─────────────────────────────────────────────────────────────────────────────
# /api/playlists
# ─────────────────────────────────────────────────────────────────────────────


@app.get("/api/playlists")
async def get_playlists() -> list[dict]:
    return db.get_playlists()


@app.post("/api/playlists", status_code=201)
async def create_playlist(body: CreatePlaylistRequest) -> dict:
    if not body.name.strip():
        raise HTTPException(status_code=400, detail="Playlist name cannot be empty")
    return db.create_playlist(body.name.strip())


@app.delete("/api/playlists/{playlist_id}")
async def delete_playlist(playlist_id: str) -> dict:
    playlists = db.get_playlists()
    if not any(p["id"] == playlist_id for p in playlists):
        raise HTTPException(status_code=404, detail="Playlist not found")
    db.delete_playlist(playlist_id)
    return {"deleted": playlist_id}


@app.get("/api/playlists/{playlist_id}/tracks")
async def playlist_tracks(playlist_id: str) -> list[dict]:
    playlists = db.get_playlists()
    if not any(p["id"] == playlist_id for p in playlists):
        raise HTTPException(status_code=404, detail="Playlist not found")
    return db.get_playlist_tracks(playlist_id)


@app.post("/api/playlists/{playlist_id}/tracks", status_code=201)
async def add_track_to_playlist(playlist_id: str, body: AddTrackRequest) -> dict:
    playlists = db.get_playlists()
    if not any(p["id"] == playlist_id for p in playlists):
        raise HTTPException(status_code=404, detail="Playlist not found")
    if db.get_track(body.track_id) is None:
        raise HTTPException(status_code=404, detail="Track not found")
    db.add_track_to_playlist(playlist_id, body.track_id)
    return {"playlist_id": playlist_id, "track_id": body.track_id}


@app.delete("/api/playlists/{playlist_id}/tracks/{track_id}")
async def remove_track_from_playlist(playlist_id: str, track_id: str) -> dict:
    db.remove_track_from_playlist(playlist_id, track_id)
    return {"playlist_id": playlist_id, "track_id": track_id}


@app.put("/api/playlists/{playlist_id}/tracks/reorder")
async def reorder_playlist_tracks(playlist_id: str, body: ReorderRequest) -> dict:
    playlists = db.get_playlists()
    if not any(p["id"] == playlist_id for p in playlists):
        raise HTTPException(status_code=404, detail="Playlist not found")
    db.reorder_playlist_tracks(playlist_id, body.track_ids)
    return {"ok": True}


@app.get("/api/playlists/{playlist_id}/export")
async def export_playlist_m3u(playlist_id: str) -> str:
    """Export playlist as M3U format."""
    playlists = db.get_playlists()
    if not any(p["id"] == playlist_id for p in playlists):
        raise HTTPException(status_code=404, detail="Playlist not found")
    
    playlist = next((p for p in playlists if p["id"] == playlist_id), None)
    tracks = db.get_playlist_tracks(playlist_id)
    
    m3u_content = "#EXTM3U\n"
    m3u_content += f"#PLAYLIST:{playlist.get('name', 'Playlist')}\n\n"
    
    for track in tracks:
        duration = track.get("duration", 0) or 0
        title = track.get("title", "Unknown")
        artist = track.get("artist", "Unknown Artist")
        m3u_content += f"#EXTINF:{duration},{artist} - {title}\n"
        
        file_path = track.get("file_path", "")
        if file_path:
            # Use relative path for portability
            try:
                rel_path = Path(file_path).relative_to(Path(MUSIC_DIR).resolve())
                m3u_content += f"{rel_path}\n"
            except ValueError:
                m3u_content += f"{file_path}\n"
        m3u_content += "\n"
    
    return m3u_content


@app.post("/api/upload")
async def upload_file(file: UploadFile) -> dict:
    """Upload audio file directly from browser."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")
    
    # Validate file extension
    ext = Path(file.filename).suffix.lower()
    if ext not in {".mp3", ".flac", ".m4a", ".ogg", ".wav", ".opus", ".webm", ".aac"}:
        raise HTTPException(status_code=400, detail=f"Unsupported file format: {ext}")
    
    # Create upload directory if needed
    upload_dir = Path(MUSIC_DIR) / "uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)
    
    # Generate unique filename to avoid conflicts
    import time
    timestamp = int(time.time() * 1000)
    safe_name = f"{timestamp}_{file.filename}"
    file_path = upload_dir / safe_name
    
    # Save file
    content = await file.read()
    max_size = 100 * 1024 * 1024  # 100MB limit
    if len(content) > max_size:
        raise HTTPException(status_code=400, detail="File too large (max 100MB)")
    
    with open(file_path, "wb") as f:
        f.write(content)
    
    # Extract metadata and add to library
    tags = dl._read_tags(str(file_path))
    cover_path = dl._resolve_cover_path(str(file_path))
    track = {
        "id": dl._stable_id(str(file_path)),
        "title": tags["title"] or Path(file.filename).stem,
        "artist": tags["artist"] or "Unknown Artist",
        "album": tags["album"],
        "duration": tags["duration"],
        "file_path": str(file_path),
        "cover_path": cover_path,
        "added_at": datetime.now(timezone.utc).isoformat(),
    }
    db.upsert_track(track)
    
    # Search and save lyrics for the uploaded track (offload to thread)
    try:
        loop = asyncio.get_running_loop()
        lyrics = await loop.run_in_executor(None, dl.search_lyrics, track.get("artist", ""), track.get("title", ""))
        if lyrics:
            lrc_path = await loop.run_in_executor(None, dl.save_lyrics_file, str(file_path), track.get("artist", ""), track.get("title", ""), lyrics)
            if lrc_path:
                logger.info("Saved lyrics for %s", track.get("title", ""))
    except Exception as e:
        logger.warning("Failed to fetch lyrics: %s", e)

    # Auto mood analysis (offload to thread)
    try:
        await loop.run_in_executor(None, ma.analyze_track_mood, track["id"])
    except Exception as e:
        logger.warning("Mood analysis failed for upload: %s", e)
    
    logger.info("Uploaded file: %s", file_path)
    return {"success": True, "track": track}


@app.get("/api/stats")
async def get_stats() -> dict:
    import os
    tracks = db.get_all_tracks()
    total_duration = sum(t.get("duration") or 0 for t in tracks)
    total_size = 0
    artists = set()
    albums = set()
    
    for t in tracks:
        fp = t.get("file_path")
        if fp:
            try:
                total_size += Path(fp).stat().st_size
            except OSError:
                pass
        if t.get("artist"):
            artists.add(t.get("artist"))
        if t.get("album"):
            albums.add(t.get("album"))
    
    # Format duration as hours and minutes
    hours = total_duration // 3600
    minutes = (total_duration % 3600) // 60
    
    return {
        "track_count": len(tracks),
        "total_duration_seconds": total_duration,
        "total_duration_formatted": f"{hours}h {minutes}m",
        "total_size_bytes": total_size,
        "total_size_formatted": _format_size(total_size),
        "artist_count": len(artists),
        "album_count": len(albums),
    }


@app.get("/api/lyrics/{track_id}")
async def get_lyrics(track_id: str) -> dict:
    """Get lyrics for a track from .lrc file.

    This is a FAST read-only endpoint. It never runs Whisper/Ollama so the
    frontend stays responsive. If no lyrics exist, call POST
    /api/lyrics/{track_id}/generate?force_whisper=true to create them.
    """
    track = db.get_track(track_id)
    if track is None:
        raise HTTPException(status_code=404, detail="Track not found")

    file_path = track.get("file_path")
    if not file_path:
        return {"lyrics": None, "error": "No file path"}

    # 1) Return existing .lrc immediately
    lrc_path = Path(file_path).with_suffix('.lrc')
    if lrc_path.exists():
        try:
            async with aiofiles.open(lrc_path, 'r', encoding='utf-8') as f:
                lrc_content = await f.read()
            return {"lyrics": lrc_content, "has_lrc": True}
        except Exception as e:
            logger.warning("Failed to read LRC file: %s", e)

    # 2) Quick online lookup (never blocks the event loop)
    artist = track.get("artist", "")
    title = track.get("title", "")
    if artist and title:
        loop = asyncio.get_running_loop()
        try:
            lyrics = await asyncio.wait_for(
                loop.run_in_executor(None, dl.search_lyrics, artist, title),
                timeout=5.0,
            )
            if lyrics:
                lrc_path = await loop.run_in_executor(
                    None, dl.save_lyrics_file, file_path, artist, title, lyrics
                )
                return {
                    "lyrics": lyrics,
                    "has_lrc": bool(lrc_path),
                    "hint": "Timestamps are approximate; use POST /generate for AI sync",
                }
        except asyncio.TimeoutError:
            pass
        except Exception as e:
            logger.warning("Failed to fetch lyrics: %s", e)

    return {
        "lyrics": None,
        "error": "No lyrics found",
        "hint": "Use POST /api/lyrics/{track_id}/generate?force_whisper=true to create them",
    }


@app.post("/api/lyrics/{track_id}/generate")
async def generate_lyrics(track_id: str, force_whisper: bool = False) -> dict:
    """Force generate LRC lyrics for a track using Ollama/Whisper.

    Query params:
        force_whisper: If true, skip online lyrics search and Ollama;
                       transcribe directly from audio using Whisper (GPU).
    """
    track = db.get_track(track_id)
    if track is None:
        raise HTTPException(status_code=404, detail="Track not found")

    file_path = track.get("file_path")
    artist = track.get("artist") or ""
    title = track.get("title") or ""
    duration = float(track.get("duration") or 180)

    # Derive fallback metadata from filename if tags are missing
    if not artist or not title:
        from pathlib import Path
        stem = Path(file_path).stem if file_path else ""
        # Remove common upload prefixes like 1777975625411_
        clean_stem = stem
        if clean_stem and clean_stem[0].isdigit():
            idx = clean_stem.find("_")
            if idx != -1:
                clean_stem = clean_stem[idx + 1:]
        if not title:
            title = clean_stem
        if not artist:
            # Try "Artist - Title" or "Artist ft ..." heuristic
            for sep in (" - ", " – ", "—", "-"):
                if sep in clean_stem:
                    parts = clean_stem.split(sep, 1)
                    artist = parts[0].strip()
                    if not title or title == clean_stem:
                        title = parts[1].strip()
                    break
            if not artist:
                artist = "Unknown Artist"

    if not artist or not title:
        return {"error": "Track missing artist or title"}

    loop = asyncio.get_running_loop()

    try:
        # STEP 1: Always fetch real lyrics first (for forced alignment)
        lyrics_text = await loop.run_in_executor(None, lg.fetch_plain_lyrics, artist, title)

        if force_whisper:
            # STEP 2a: Whisper GPU with forced alignment using real lyrics
            # If no real lyrics found, Whisper transcribes raw audio
            lrc_content = await loop.run_in_executor(
                None, lg.generate_lrc_from_audio, file_path, artist, title, lyrics_text
            )
            if lrc_content:
                lrc_path = await loop.run_in_executor(
                    None, lg.save_lrc_file, file_path, artist, title, lrc_content
                )
                source = "whisper+alignment" if lyrics_text else "whisper"
                return {"lyrics": lrc_content, "has_lrc": True, "generated": True, "source": source, "file": lrc_path}
            return {"error": "Whisper transcription produced no output", "generated": False}

        # STEP 2b: Default path — Ollama LLM timestamps with real lyrics
        if lyrics_text:
            lrc_content = await loop.run_in_executor(
                None, lg.generate_timestamps_with_llm, artist, title, lyrics_text, duration
            )
        else:
            # No real lyrics — fallback to Whisper raw transcription
            lrc_content = await loop.run_in_executor(
                None, lg.generate_lrc, artist, title, duration, file_path
            )

        if lrc_content:
            lrc_path = await loop.run_in_executor(
                None, lg.save_lrc_file, file_path, artist, title, lrc_content
            )
            return {"lyrics": lrc_content, "has_lrc": True, "generated": True, "file": lrc_path}
    except Exception as e:
        logger.warning(f"Failed to generate lyrics for {track_id}: {e}")

    return {"error": "Failed to generate lyrics", "generated": False}


class SyncLyricsRequest(BaseModel):
    lyrics: str


@app.post("/api/lyrics/{track_id}/sync")
async def sync_custom_lyrics(track_id: str, body: SyncLyricsRequest) -> dict:
    """Sync user-provided lyrics to audio using Whisper forced alignment.

    The user pastes real lyrics; Whisper transcribes the audio and we align
    the real words to the audio timestamps.
    """
    track = db.get_track(track_id)
    if track is None:
        raise HTTPException(status_code=404, detail="Track not found")

    file_path = track.get("file_path")
    artist = track.get("artist") or ""
    title = track.get("title") or ""

    if not file_path or not os.path.exists(file_path):
        return {"error": "Audio file not found"}

    if not body.lyrics or len(body.lyrics.strip()) < 20:
        return {"error": "Lyrics too short (minimum 20 chars)"}

    loop = asyncio.get_running_loop()
    try:
        lrc_content = await loop.run_in_executor(
            None, lg.generate_lrc_from_audio, file_path, artist, title, body.lyrics.strip()
        )
        if lrc_content:
            lrc_path = await loop.run_in_executor(
                None, lg.save_lrc_file, file_path, artist, title, lrc_content
            )
            return {
                "lyrics": lrc_content,
                "has_lrc": True,
                "generated": True,
                "source": "whisper+alignment (custom)",
                "file": lrc_path,
            }
        return {"error": "Alignment failed", "generated": False}
    except Exception as e:
        logger.warning(f"Custom lyrics sync failed for {track_id}: {e}")
        return {"error": str(e), "generated": False}


@app.get("/api/tracks/{track_id}/mood")
async def get_track_mood(track_id: str) -> dict:
    """Get mood analysis for a track."""
    result = ma.get_track_mood(track_id)
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result


@app.post("/api/tracks/{track_id}/analyze")
async def analyze_track(track_id: str) -> dict:
    """Trigger mood analysis for a track."""
    track = db.get_track(track_id)
    if track is None:
        raise HTTPException(status_code=404, detail="Track not found")
    result = ma.analyze_track_mood(track_id)
    if "error" in result:
        raise HTTPException(status_code=500, detail=result["error"])
    return result


@app.get("/api/radio/{track_id}")
async def get_radio_for_track(track_id: str, limit: int = 50) -> dict:
    """Get radio station based on a seed track."""
    seed = db.get_track(track_id)
    if seed is None:
        raise HTTPException(status_code=404, detail="Track not found")
    station = radio.get_radio_station(track_id, limit=limit)
    return {"seed_track": seed, "station": station, "count": len(station)}


@app.get("/api/radio/mood/{mood}")
async def get_radio_by_mood(mood: str, limit: int = 50) -> dict:
    """Get radio station filtered by mood."""
    valid_moods = {"energetic", "relaxed", "focused", "melancholic", "happy", "sad"}
    if mood.lower() not in valid_moods:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid mood. Must be one of: {', '.join(sorted(valid_moods))}"
        )
    station = radio.get_mood_radio(mood, limit=limit)
    return {"mood": mood, "station": station, "count": len(station)}


@app.get("/api/discover/new")
async def discover_new(days: int = 7, limit: int = 100) -> dict:
    """Get tracks added in the last N days."""
    tracks = db.get_new_tracks(days=days, limit=limit)
    return {"tracks": tracks, "count": len(tracks)}


@app.get("/api/discover/top")
async def discover_top(limit: int = 50) -> dict:
    """Get most played tracks."""
    tracks = db.get_top_tracks(limit=limit)
    return {"tracks": tracks, "count": len(tracks)}


@app.get("/api/discover/unplayed")
async def discover_unplayed(limit: int = 100) -> dict:
    """Get tracks that have never been played."""
    tracks = db.get_unplayed_tracks(limit=limit)
    return {"tracks": tracks, "count": len(tracks)}


@app.get("/api/discover/recent")
async def discover_recent(limit: int = 50) -> dict:
    """Get recently played tracks."""
    tracks = db.get_recently_played_tracks(limit=limit)
    return {"tracks": tracks, "count": len(tracks)}


@app.get("/api/playlists/smart")
async def list_smart_playlists() -> list[dict]:
    """List all smart playlists."""
    return db.get_smart_playlists()


@app.post("/api/playlists/smart", status_code=201)
async def create_smart_playlist(body: CreateSmartPlaylistRequest) -> dict:
    """Create a smart playlist with rules."""
    if not body.name.strip():
        raise HTTPException(status_code=400, detail="Playlist name cannot be empty")
    if not body.rules:
        raise HTTPException(status_code=400, detail="Rules are required")
    for rule in body.rules:
        if "field" not in rule or "op" not in rule or "value" not in rule:
            raise HTTPException(status_code=400, detail="Each rule must have 'field', 'op', and 'value'")
        valid_fields = {"artist", "album", "duration", "mood", "play_count", "added_at"}
        if rule["field"] not in valid_fields:
            raise HTTPException(status_code=400, detail=f"Invalid field: {rule['field']}. Must be one of: {', '.join(sorted(valid_fields))}")
        valid_ops = {"equals", "contains", "greater_than", "less_than", "not_equals"}
        if rule["op"] not in valid_ops:
            raise HTTPException(status_code=400, detail=f"Invalid op: {rule['op']}. Must be one of: {', '.join(sorted(valid_ops))}")
    playlist = db.create_smart_playlist(body.name.strip(), body.rules, body.limit_count or 50)
    return playlist


@app.get("/api/playlists/smart/{smart_id}")
async def get_smart_playlist_tracks(smart_id: str) -> dict:
    """Get tracks matching a smart playlist's rules."""
    smart = db.get_smart_playlist(smart_id)
    if not smart:
        raise HTTPException(status_code=404, detail="Smart playlist not found")
    tracks = db.evaluate_smart_playlist(smart_id)
    return {"playlist": smart, "tracks": tracks, "count": len(tracks)}


@app.delete("/api/playlists/smart/{smart_id}")
async def delete_smart_playlist(smart_id: str) -> dict:
    """Delete a smart playlist."""
    smart = db.get_smart_playlist(smart_id)
    if not smart:
        raise HTTPException(status_code=404, detail="Smart playlist not found")
    db.delete_smart_playlist(smart_id)
    return {"deleted": smart_id}


@app.post("/api/tracks/{track_id}/play")
async def record_track_play(track_id: str) -> dict:
    """Record that a track was played (increment play count)."""
    track = db.get_track(track_id)
    if track is None:
        raise HTTPException(status_code=404, detail="Track not found")
    db.update_track_play_count(track_id)
    updated = db.get_track(track_id)
    return {"track_id": track_id, "play_count": updated.get("play_count", 0) if updated else 0}


def _format_size(size_bytes: int) -> str:
    """Format bytes to human readable string."""
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if size_bytes < 1024:
            return f"{size_bytes:.1f} {unit}"
        size_bytes /= 1024
    return f"{size_bytes:.1f} PB"


# ─────────────────────────────────────────────────────────────────────────────
# /api/yt-search  — YouTube search
# ─────────────────────────────────────────────────────────────────────────────


@app.get("/api/yt-search")
async def search_youtube(q: str = "") -> list[dict]:
    if not q.strip():
        raise HTTPException(status_code=400, detail="Query parameter 'q' is required")
    results = await download_manager.search_youtube(q)
    return results


# ─────────────────────────────────────────────────────────────────────────────
# /api/yt-download  — Download from YouTube URL
# ─────────────────────────────────────────────────────────────────────────────


@app.post("/api/yt-download")
async def download_youtube(body: YTDownloadRequest) -> dict:
    if not body.url.strip():
        raise HTTPException(status_code=400, detail="'url' is required")
    job_id = await download_manager.download_youtube(body.url, body.title, body.artist)
    return {"job_id": job_id}


@app.post("/api/import/spotify-playlist")
async def import_spotify_playlist(body: ImportSpotifyPlaylistRequest) -> dict:
    url = body.url.strip()
    if "open.spotify.com/playlist/" not in url:
        raise HTTPException(status_code=400, detail="Provide a valid Spotify playlist URL")

    try:
        from spotdl.types.playlist import Playlist  # type: ignore

        _ensure_spotify_client()
        src = Playlist.from_url(url, fetch_songs=False)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not read Spotify playlist: {exc}") from exc

    playlist_name = (getattr(src, "name", "") or "Imported Playlist").strip()
    existing = db.get_playlist_by_name(playlist_name)
    if existing:
        target_playlist = existing
    else:
        target_playlist = db.create_playlist(playlist_name)

    target_id = target_playlist["id"]
    if body.overwrite:
        db.clear_playlist_tracks(target_id)

    imported_ids: list[str] = []
    failed: list[dict] = []

    songs = list(getattr(src, "songs", []) or [])
    for idx, song in enumerate(songs, start=1):
        title = (getattr(song, "name", "") or "").strip()
        artist = (getattr(song, "artist", "") or "").strip()
        spotify_url = (getattr(song, "url", "") or "").strip()

        found_track = None

        before_ids = {t.get("id") for t in db.get_all_tracks() if t.get("id")}
        try:
            job_id = await download_manager.download_track(
                spotify_url or f"{title} {artist}".strip(),
                title=title,
                artist=artist,
            )
            job = await _wait_for_job(job_id)
            if job and job.get("status") == "done":
                found_track = _pick_downloaded_track(before_ids, title, artist)
        except Exception:
            found_track = None

        if not found_track:
            yt_query = f"{title} {artist}".strip()
            yt_results = await download_manager.search_youtube(yt_query)
            if yt_results:
                yt_url = yt_results[0].get("url") or ""
                before_ids = {t.get("id") for t in db.get_all_tracks() if t.get("id")}
                try:
                    y_job_id = await download_manager.download_youtube(yt_url, title=title, artist=artist)
                    y_job = await _wait_for_job(y_job_id)
                    if y_job and y_job.get("status") == "done":
                        found_track = _pick_downloaded_track(before_ids, title, artist)
                except Exception:
                    found_track = None

        if found_track and found_track.get("id"):
            db.add_track_to_playlist(target_id, found_track["id"])
            imported_ids.append(found_track["id"])
        else:
            failed.append({"index": idx, "title": title, "artist": artist})

    if imported_ids:
        db.reorder_playlist_tracks(target_id, imported_ids)

    return {
        "playlist": target_playlist,
        "requested": len(songs),
        "imported": len(imported_ids),
        "failed": failed,
    }


# ─────────────────────────────────────────────────────────────────────────────
# WebSocket /ws/downloads
# ─────────────────────────────────────────────────────────────────────────────


@app.websocket("/ws/downloads")
async def ws_downloads(websocket: WebSocket) -> None:
    await websocket.accept()
    logger.info("WebSocket client connected: %s", websocket.client)

    # Send current state immediately
    try:
        current_jobs = download_manager.get_all_jobs()
        await websocket.send_text(json.dumps({"type": "snapshot", "jobs": current_jobs}))
    except WebSocketDisconnect:
        return
    except Exception as exc:
        logger.warning("Error sending snapshot: %s", exc)
        return

    # Async callback that forwards updates to this specific client
    async def _forward(job: dict) -> None:
        await websocket.send_text(json.dumps({"type": "update", "job": job}))

    download_manager.subscribe(_forward)
    try:
        # Keep alive — discard any incoming pings from the client
        while True:
            try:
                await asyncio.wait_for(websocket.receive_text(), timeout=30.0)
            except asyncio.TimeoutError:
                # Send a keepalive ping
                try:
                    await websocket.send_text(json.dumps({"type": "ping"}))
                except Exception:
                    break
    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected: %s", websocket.client)
    except Exception as exc:
        logger.warning("WebSocket error: %s", exc)
    finally:
        download_manager.unsubscribe(_forward)


# ─────────────────────────────────────────────────────────────────────────────
# /api/backups
# ─────────────────────────────────────────────────────────────────────────────


@app.get("/api/backups")
async def list_backups() -> list[dict]:
    return db.list_backups()


@app.post("/api/backups/restore/{backup_id}")
async def restore_backup_endpoint(backup_id: str) -> dict:
    success = db.restore_backup(backup_id)
    if not success:
        raise HTTPException(status_code=404, detail="Backup not found")
    return {"restored": backup_id}


# ─────────────────────────────────────────────────────────────────────────────
# Dev entry-point
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=PORT, reload=True)


# ─────────────────────────────────────────────────────────────────────────────
# /api/users
# ─────────────────────────────────────────────────────────────────────────────


class CreateUserRequest(BaseModel):
    username: str
    display_name: str | None = None
    avatar_url: str | None = None


class UpdateUserRequest(BaseModel):
    display_name: str | None = None
    avatar_url: str | None = None
    bio: str | None = None


@app.post("/api/users", status_code=201)
async def create_user(body: CreateUserRequest) -> dict:
    if not body.username.strip():
        raise HTTPException(status_code=400, detail="Username is required")
    existing = db.get_user_by_username(body.username.strip())
    if existing:
        raise HTTPException(status_code=409, detail="Username already taken")
    user = db.create_user(body.username.strip(), body.display_name, body.avatar_url)
    return user


@app.get("/api/users/{user_id}")
async def get_user_profile(user_id: str) -> dict:
    user = db.get_user(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    followers = db.get_followers(user_id)
    following = db.get_following(user_id)
    result = dict(user)
    result["followers_count"] = len(followers)
    result["following_count"] = len(following)
    return result


@app.put("/api/users/{user_id}")
async def update_user_profile(user_id: str, body: UpdateUserRequest) -> dict:
    user = db.get_user(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    updates = {}
    if body.display_name is not None:
        updates["display_name"] = body.display_name
    if body.avatar_url is not None:
        updates["avatar_url"] = body.avatar_url
    if body.bio is not None:
        updates["bio"] = body.bio
    updated = db.update_user(user_id, updates)
    return updated


@app.post("/api/users/{user_id}/follow")
async def follow_user(user_id: str, request: Request) -> dict:
    follower_id = request.headers.get("X-User-ID", str(uuid.uuid4()))
    if user_id == follower_id:
        raise HTTPException(status_code=400, detail="Cannot follow yourself")
    target = db.get_user(user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    db.follow_user(follower_id, user_id)
    return {"following": True, "user_id": user_id}


@app.delete("/api/users/{user_id}/follow")
async def unfollow_user(user_id: str, request: Request) -> dict:
    follower_id = request.headers.get("X-User-ID", str(uuid.uuid4()))
    db.unfollow_user(follower_id, user_id)
    return {"following": False, "user_id": user_id}


@app.get("/api/users/{user_id}/followers")
async def get_user_followers(user_id: str) -> dict:
    user = db.get_user(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    followers = db.get_followers(user_id)
    return {"user_id": user_id, "followers": followers, "count": len(followers)}


@app.get("/api/users/{user_id}/following")
async def get_user_following(user_id: str) -> dict:
    user = db.get_user(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    following = db.get_following(user_id)
    return {"user_id": user_id, "following": following, "count": len(following)}


@app.get("/api/users/{user_id}/share")
async def get_public_profile(user_id: str) -> dict:
    user = db.get_user(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    followers = db.get_followers(user_id)
    following = db.get_following(user_id)
    activities = db.get_user_activities(user_id, limit=20)
    return {
        "user": user,
        "followers_count": len(followers),
        "following_count": len(following),
        "recent_activities": activities,
    }


# ─────────────────────────────────────────────────────────────────────────────
# /api/activities
# ─────────────────────────────────────────────────────────────────────────────


@app.get("/api/activities")
async def get_activities(limit: int = 50, offset: int = 0) -> dict:
    activities = db.get_activities(limit, offset)
    return {"activities": activities, "count": len(activities)}


@app.get("/api/users/{user_id}/activities")
async def get_user_activities_endpoint(user_id: str, limit: int = 50) -> dict:
    user = db.get_user(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    activities = db.get_user_activities(user_id, limit)
    return {"user_id": user_id, "activities": activities, "count": len(activities)}


@app.post("/api/activities")
async def create_activity_endpoint(
    action_type: str,
    request: Request,
    track_id: str | None = None,
    playlist_id: str | None = None,
) -> dict:
    user_id = request.headers.get("X-User-ID", str(uuid.uuid4()))
    valid_actions = {"listening", "liked", "added_to_playlist", "created_playlist"}
    if action_type not in valid_actions:
        raise HTTPException(status_code=400, detail=f"Invalid action_type. Must be one of: {valid_actions}")
    activity = db.create_activity(user_id, action_type, track_id, playlist_id)
    return activity


# ─────────────────────────────────────────────────────────────────────────────
# Playlist Collaboration
# ─────────────────────────────────────────────────────────────────────────────


class InviteCollaboratorRequest(BaseModel):
    user_id: str
    role: str = "editor"


@app.post("/api/playlists/{playlist_id}/collaborators")
async def invite_collaborator(playlist_id: str, body: InviteCollaboratorRequest) -> dict:
    playlist = db.get_playlist(playlist_id)
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    user = db.get_user(body.user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    valid_roles = {"owner", "editor", "viewer"}
    if body.role not in valid_roles:
        raise HTTPException(status_code=400, detail=f"Invalid role. Must be one of: {valid_roles}")
    db.invite_collaborator(playlist_id, body.user_id, body.role)
    return {"playlist_id": playlist_id, "user_id": body.user_id, "role": body.role}


@app.delete("/api/playlists/{playlist_id}/collaborators/{collaborator_id}")
async def remove_collaborator(playlist_id: str, collaborator_id: str) -> dict:
    db.remove_collaborator(playlist_id, collaborator_id)
    return {"removed": collaborator_id}


@app.get("/api/playlists/{playlist_id}/collaborators")
async def list_collaborators(playlist_id: str) -> dict:
    playlist = db.get_playlist(playlist_id)
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    collaborators = db.get_collaborators(playlist_id)
    return {"playlist_id": playlist_id, "collaborators": collaborators, "count": len(collaborators)}


@app.put("/api/playlists/{playlist_id}/collaborators/{collaborator_id}")
async def update_collaborator_role(playlist_id: str, collaborator_id: str, role: str) -> dict:
    valid_roles = {"owner", "editor", "viewer"}
    if role not in valid_roles:
        raise HTTPException(status_code=400, detail=f"Invalid role")
    db.update_collaborator_role(playlist_id, collaborator_id, role)
    return {"updated": collaborator_id, "role": role}


# ─────────────────────────────────────────────────────────────────────────────
# Listening Now
# ─────────────────────────────────────────────────────────────────────────────


@app.post("/api/users/{user_id}/listening")
async def set_now_listening(user_id: str, track_id: str, duration_minutes: int = 30) -> dict:
    track = db.get_track(track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    db.set_listening(user_id, track_id, duration_minutes)
    return {"listening": True, "track_id": track_id, "user_id": user_id}


@app.get("/api/users/active-listening")
async def get_active_listening() -> dict:
    db.expire_old_sessions()
    sessions = db.get_active_listening()
    return {"listening_now": sessions, "count": len(sessions)}


# ─────────────────────────────────────────────────────────────────────────────
# Share Links
# ─────────────────────────────────────────────────────────────────────────────


class CreateShareLinkRequest(BaseModel):
    user_id: str | None = None
    playlist_id: str | None = None
    track_id: str | None = None
    expires_hours: int = 168


@app.post("/api/share")
async def create_share_link(body: CreateShareLinkRequest) -> dict:
    if not body.playlist_id and not body.track_id:
        raise HTTPException(status_code=400, detail="Must provide playlist_id or track_id")
    link = db.create_share_link(body.user_id, body.playlist_id, body.track_id, body.expires_hours)
    return {"share_code": link["code"], "url": f"/api/share/{link['code']}", "expires_at": link["expires_at"]}


@app.get("/api/share/{share_code}")
async def get_share_link(share_code: str) -> dict:
    link = db.get_share_link(share_code)
    if not link:
        raise HTTPException(status_code=404, detail="Share link not found or expired")
    result = dict(link)
    if link.get("playlist_id"):
        playlist = db.get_playlist(link["playlist_id"])
        result["playlist"] = playlist
        if playlist:
            result["tracks"] = db.get_playlist_tracks(link["playlist_id"])
    if link.get("track_id"):
        track = db.get_track(link["track_id"])
        result["track"] = track
    return result


# ─────────────────────────────────────────────────────────────────────────────
# Import Playlist from URL
# ─────────────────────────────────────────────────────────────────────────────


class ImportPlaylistRequest(BaseModel):
    url: str
    overwrite: bool = False


@app.post("/api/import/playlist")
async def import_playlist(body: ImportPlaylistRequest) -> dict:
    url = body.url.strip()
    if "youtube.com" in url or "youtu.be" in url:
        return await _import_youtube_playlist(url, body.overwrite)
    elif "open.spotify.com" in url:
        return await _import_spotify_playlist(url, body.overwrite)
    else:
        raise HTTPException(status_code=400, detail="Unsupported URL. Use YouTube or Spotify playlist URL.")


async def _import_youtube_playlist(url: str, overwrite: bool) -> dict:
    try:
        from pytube import Playlist as YTPlaylist
    except ImportError:
        raise HTTPException(status_code=500, detail="pytube not installed. Run: pip install pytube")

    try:
        yt_playlist = YTPlaylist(url)
        playlist_name = yt_playlist.title or "Imported Playlist"
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"YouTube playlist error: {exc}")

    existing = db.get_playlist_by_name(playlist_name)
    if existing:
        target = existing
    else:
        target = db.create_playlist(playlist_name)

    target_id = target["id"]
    if overwrite:
        db.clear_playlist_tracks(target_id)

    imported_ids = []
    failed = []

    for idx, video in enumerate(yt_playlist.video_urls, start=1):
        before_ids = {t.get("id") for t in db.get_all_tracks() if t.get("id")}
        try:
            job_id = await download_manager.download_youtube(video)
            job = await _wait_for_job(job_id)
            if job and job.get("status") == "done":
                found = _pick_downloaded_track(before_ids, "", "")
                if found:
                    db.add_track_to_playlist(target_id, found["id"])
                    imported_ids.append(found["id"])
                else:
                    failed.append({"index": idx, "url": video})
        except Exception:
            failed.append({"index": idx, "url": video})

    if imported_ids:
        db.reorder_playlist_tracks(target_id, imported_ids)

    return {
        "playlist": target,
        "requested": len(yt_playlist.video_urls),
        "imported": len(imported_ids),
        "failed": failed,
    }


async def _import_spotify_playlist(url: str, overwrite: bool) -> dict:
    try:
        from spotdl.types.playlist import Playlist as SpotifyPlaylist
    except ImportError:
        raise HTTPException(status_code=500, detail="spotdl not installed. Run: pip install spotdl")

    try:
        src = SpotifyPlaylist.from_url(url, fetch_songs=False)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Spotify playlist error: {exc}")

    playlist_name = (getattr(src, "name", "") or "Imported Playlist").strip()
    existing = db.get_playlist_by_name(playlist_name)
    target = existing if existing else db.create_playlist(playlist_name)
    target_id = target["id"]

    if overwrite:
        db.clear_playlist_tracks(target_id)

    imported_ids = []
    failed = []

    songs = list(getattr(src, "songs", []) or [])
    for idx, song in enumerate(songs, start=1):
        title = (getattr(song, "name", "") or "").strip()
        artist = (getattr(song, "artist", "") or "").strip()
        spotify_url = (getattr(song, "url", "") or "").strip()

        found = None
        before_ids = {t.get("id") for t in db.get_all_tracks() if t.get("id")}
        try:
            job_id = await download_manager.download_track(spotify_url or f"{title} {artist}", title=title, artist=artist)
            job = await _wait_for_job(job_id)
            if job and job.get("status") == "done":
                found = _pick_downloaded_track(before_ids, title, artist)
        except Exception:
            pass

        if not found:
            yt_query = f"{title} {artist}".strip()
            yt_results = await download_manager.search_youtube(yt_query)
            if yt_results:
                yt_url = yt_results[0].get("url") or ""
                before_ids = {t.get("id") for t in db.get_all_tracks() if t.get("id")}
                try:
                    y_job_id = await download_manager.download_youtube(yt_url, title=title, artist=artist)
                    y_job = await _wait_for_job(y_job_id)
                    if y_job and y_job.get("status") == "done":
                        found = _pick_downloaded_track(before_ids, title, artist)
                except Exception:
                    pass

        if found and found.get("id"):
            db.add_track_to_playlist(target_id, found["id"])
            imported_ids.append(found["id"])
        else:
            failed.append({"index": idx, "title": title, "artist": artist})

    if imported_ids:
        db.reorder_playlist_tracks(target_id, imported_ids)

    return {
        "playlist": target,
        "requested": len(songs),
        "imported": len(imported_ids),
        "failed": failed,
    }
