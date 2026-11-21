"""
Download manager for the music server.

Downloads tracks from YouTube (yt-dlp) and Spotify links (metadata from the server's own
Spotify app, audio matched on YouTube by nocturne_api.spotify_download; spotdl is NOT used).
Progress is broadcast to registered async callbacks so that the WebSocket
endpoint can push live updates to connected clients.
"""

import asyncio
import hashlib
import logging
import os
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Coroutine

from dotenv import load_dotenv
from mutagen import File as MutagenFile

import database as db
import mood_analyzer as ma

load_dotenv()

logger = logging.getLogger(__name__)

MUSIC_DIR = os.getenv("MUSIC_DIR", "./music")
DEFAULT_AUDIO_FORMAT = os.getenv("AUDIO_FORMAT", "opus").strip().lower() or "opus"

AUDIO_EXTENSIONS = {".mp3", ".flac", ".m4a", ".mp4", ".ogg", ".opus", ".wav", ".webm"}

# YouTube requires solving JS challenges; without a JS runtime yt-dlp can list
# formats but the actual media download fails with HTTP 403. yt-dlp only enables
# deno by default, so point it at the Node.js that is installed on the host.
# Needs the `yt-dlp-ejs` package (installed via `yt-dlp[default]`).
YTDLP_JS_RUNTIME = os.getenv("YTDLP_JS_RUNTIME", "node").strip()
YTDLP_JS_RUNTIMES = {YTDLP_JS_RUNTIME: {}} if YTDLP_JS_RUNTIME else {}

# ─────────────────────────────────────────────────────────────────────────────
# LYRICS
# ─────────────────────────────────────────────────────────────────────────────

def search_lyrics(artist: str, title: str) -> str | None:
    """Search lyrics using multiple APIs."""
    import urllib.parse
    
    try:
        import requests
        
        # Clean artist and title
        artist = (artist or '').replace('feat.', '').replace('ft.', '').replace('(prod.', '').split(',')[0].strip()
        title = (title or '').replace('(Visualizer)', '').replace('(Video Oficial)', '').strip()
        
        if not artist or not title:
            return None
        
        # Try lrclib.net API first (better for Latin music)
        try:
            search_url = f"https://lrclib.net/api/get?artist_name={urllib.parse.quote(artist)}&track_name={urllib.parse.quote(title)}"
            response = requests.get(search_url, timeout=3)
            if response.status_code == 200:
                data = response.json()
                # Use synced lyrics if available
                lyrics = data.get('syncedLyrics') or data.get('plainLyrics', '')
                if lyrics and len(lyrics.strip()) > 20:
                    logger.info(f"Found lyrics (lrclib) for {artist} - {title}")
                    return lyrics.strip()
        except Exception:
            pass
        
        # Try lyrics.ovh API as fallback
        url = f"https://api.lyrics.ovh/v1/{urllib.parse.quote(artist)}/{urllib.parse.quote(title)}"
        response = requests.get(url, timeout=3)
        if response.status_code == 200:
            data = response.json()
            lyrics = data.get('lyrics', '')
            if lyrics and len(lyrics.strip()) > 20:
                logger.info(f"Found lyrics (lyrics.ovh) for {artist} - {title}")
                return lyrics.strip()
    except Exception as e:
        logger.warning(f"Lyrics search failed for {artist} - {title}: {e}")
    
    return None


def save_lyrics_file(file_path: str, artist: str, title: str, lyrics: str) -> str | None:
    """Save lyrics to a .lrc file next to the audio file."""
    import re
    try:
        lrc_path = str(Path(file_path).with_suffix('.lrc'))
        
        # Check if lyrics already have timestamps like [00:00.00]
        has_timestamps = bool(re.search(r'\[\d{2}:\d{2}', lyrics[:50]))
        
        if has_timestamps:
            # Already synced, just add headers
            lrc_content = f"[ti:{title}]\n[ar:{artist}]\n[al:]\n[by:NOVA Music Server]\n\n{lyrics}"
        else:
            # Unsynced lyrics: do NOT invent timestamps (this used to write a fake
            # 10-second grid that clients showed as "synced" and that beat the real
            # LRCLIB sync). Nocturne looks lyrics up itself (v1_lyrics_auto).
            logger.info("Unsynced lyrics for %s - %s not written as .lrc", artist, title)
            return None
        
        with open(lrc_path, 'w', encoding='utf-8') as f:
            f.write(lrc_content)
        
        logger.info(f"Saved lyrics to {lrc_path}")
        return lrc_path
    except Exception as e:
        logger.warning(f"Failed to save lyrics file: {e}")
        return None


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────


def _stable_id(file_path: str) -> str:
    """Generate a deterministic ID from the file path."""
    return hashlib.sha1(file_path.encode()).hexdigest()


def _is_final_audio(file_path: str) -> bool:
    """Audio file that is not a yt-dlp/ffmpeg intermediate ("X.temp.opus", "X.part", ...)."""
    name = Path(file_path).name.lower()
    if Path(name).suffix not in AUDIO_EXTENSIONS:
        return False
    return not (".temp." in name or name.endswith((".part", ".ytdl")) or ".part-" in name
                or name.startswith("."))


def _music_path(file_path: str) -> str:
    """Spell a path inside MUSIC_DIR exactly like _snapshot_files() does (stable ids)."""
    root = os.path.abspath(MUSIC_DIR)
    ap = os.path.abspath(file_path)
    if ap == root or not ap.startswith(root + os.sep):
        return ap
    return os.path.join(str(Path(MUSIC_DIR).resolve()), os.path.relpath(ap, root))


def _yt_output_files(info: dict | None) -> list[str]:
    """Final file(s) yt-dlp produced for THIS download (after FFmpegExtractAudio)."""
    out: list[str] = []
    for d in (info or {}).get("requested_downloads") or []:
        fp = d.get("filepath") or d.get("_filename")
        if fp:
            out.append(_music_path(fp))
    return [f for f in dict.fromkeys(out) if os.path.isfile(f) and _is_final_audio(f)]


def _read_tags(file_path: str) -> dict:
    """Use mutagen to extract metadata from an audio file."""
    tags: dict[str, Any] = {
        "title":    Path(file_path).stem,
        "artist":   None,
        "album":    None,
        "duration": None,
    }
    try:
        audio = MutagenFile(file_path, easy=True)
        if audio is None:
            return tags
        if hasattr(audio, "info") and hasattr(audio.info, "length"):
            tags["duration"] = int(audio.info.length)
        for tag_key, field in (("title", "title"), ("artist", "artist"), ("album", "album")):
            val = audio.get(tag_key) or audio.get(field)
            if val:
                tags[field] = val[0] if isinstance(val, list) else val
    except Exception as exc:
        logger.warning("mutagen failed for %s: %s", file_path, exc)
    return tags


def _find_cover(directory: str, stem: str) -> str | None:
    """Look for a cover image next to the audio file."""
    for ext in (".jpg", ".jpeg", ".png", ".webp"):
        candidate = Path(directory) / f"{stem}{ext}"
        if candidate.exists():
            return str(candidate)
    # generic cover in same directory
    for name in ("cover.jpg", "cover.png", "folder.jpg", "folder.png"):
        candidate = Path(directory) / name
        if candidate.exists():
            return str(candidate)
    return None


def _extract_embedded_cover(file_path: str) -> str | None:
    """Extract embedded artwork from audio tags and save it next to the track."""
    try:
        audio = MutagenFile(file_path)
        if audio is None:
            return None

        pic_data: bytes | None = None

        tags = getattr(audio, "tags", None)
        if tags:
            # MP3/ID3 APIC frames
            for key in tags.keys():
                key_str = str(key)
                if key_str.startswith("APIC"):
                    frame = tags[key]
                    pic_data = getattr(frame, "data", None)
                    if pic_data:
                        break

            # MP4 covr atoms
            if pic_data is None and "covr" in tags:
                covr = tags.get("covr")
                if isinstance(covr, list) and covr:
                    pic_data = bytes(covr[0])

        # FLAC/Vorbis pictures
        if pic_data is None and hasattr(audio, "pictures") and getattr(audio, "pictures"):
            pic = audio.pictures[0]
            pic_data = getattr(pic, "data", None)

        if not pic_data:
            return None

        ext = ".jpg"
        if pic_data.startswith(b"\x89PNG"):
            ext = ".png"

        out_path = str(Path(file_path).with_suffix(f".cover{ext}"))
        with open(out_path, "wb") as f:
            f.write(pic_data)
        return out_path
    except Exception as exc:
        logger.warning("cover extraction failed for %s: %s", file_path, exc)
        return None


def _resolve_cover_path(file_path: str) -> str | None:
    base = Path(file_path)
    sidecar = _find_cover(str(base.parent), base.stem)
    if sidecar:
        return sidecar
    return _extract_embedded_cover(file_path)


def scan_and_upsert(directory: str) -> list[dict]:
    """
    Walk *directory*, read tags for every audio file found and upsert into DB.
    Returns the list of track dicts that were added/updated.
    """
    added: list[dict] = []
    directory = str(Path(directory).resolve())
    for root, _dirs, files in os.walk(directory):
        for fname in files:
            if Path(fname).suffix.lower() not in AUDIO_EXTENSIONS:
                continue
            full_path = os.path.join(root, fname)
            track_id  = _stable_id(full_path)
            existing  = db.get_track(track_id)
            if existing:
                continue  # already in library

            tags       = _read_tags(full_path)
            cover_path = _resolve_cover_path(full_path)
            track = {
                "id":         track_id,
                "title":      tags["title"],
                "artist":     tags["artist"],
                "album":      tags["album"],
                "duration":   tags["duration"],
                "file_path":  full_path,
                "cover_path": cover_path,
                "added_at":   datetime.now(timezone.utc).isoformat(),
            }
            db.upsert_track(track)
            added.append(track)
            logger.info("Imported: %s", full_path)
            
            # Search for lyrics after importing
            try:
                lyrics = search_lyrics(tags.get("artist", ""), tags.get("title", ""))
                if lyrics:
                    lrc_path = save_lyrics_file(full_path, tags.get("artist", ""), tags.get("title", ""), lyrics)
                    if lrc_path:
                        logger.info(f"Saved lyrics for {tags.get('title', '')}")
            except Exception as e:
                logger.warning(f"Failed to fetch lyrics for {full_path}: {e}")
    return added


# ─────────────────────────────────────────────────────────────────────────────
# DownloadManager
# ─────────────────────────────────────────────────────────────────────────────


def _notify_threadsafe(manager: "DownloadManager", loop: "asyncio.AbstractEventLoop | None", job: dict) -> None:
    """Notify listeners from a worker thread (never call get_event_loop() there)."""
    if loop is None or loop.is_closed():
        return
    coro = manager._notify(dict(job))
    try:
        asyncio.run_coroutine_threadsafe(coro, loop)
    except Exception:
        coro.close()


class DownloadManager:
    def __init__(self) -> None:
        self._tasks: set = set()
        self.download_queue: dict[str, dict] = {}
        self.active_downloads: set[str]      = set()
        self.progress_callbacks: list[Callable[..., Coroutine]] = []
        self._executor = ThreadPoolExecutor(max_workers=8)
        self._main_loop: asyncio.AbstractEventLoop | None = None
        Path(MUSIC_DIR).mkdir(parents=True, exist_ok=True)

    def _worker_done(self, job_id: str):
        """Done-callback for a download worker: never let a crash vanish silently.

        Worker exceptions used to be swallowed (nobody awaited the executor
        future), leaving jobs stuck in "pending" forever. Now the job is marked
        as failed, the error is logged and listeners are notified.
        """
        def _cb(fut) -> None:
            exc = fut.exception()
            if exc is None:
                return
            logger.error("Download worker for job %s crashed: %r", job_id, exc)
            job = self.download_queue.get(job_id)
            if job is not None and job.get("status") not in ("done", "error", "cancelled"):
                job["status"] = "error"
                job["error"] = f"{type(exc).__name__}: {exc}"
                self.active_downloads.discard(job_id)
                try:
                    asyncio.ensure_future(self._notify(dict(job)))
                except Exception:
                    pass
        return _cb

    # ── Subscription ──────────────────────────────────────────────────────

    def subscribe(self, callback: Callable[..., Coroutine]) -> None:
        """Register an async callback that receives a job dict on every update."""
        self.progress_callbacks.append(callback)

    def unsubscribe(self, callback: Callable[..., Coroutine]) -> None:
        self.progress_callbacks = [c for c in self.progress_callbacks if c is not callback]

    async def _notify(self, job: dict) -> None:
        dead: list[Callable] = []
        for cb in list(self.progress_callbacks):
            try:
                await cb(job)
            except Exception:
                dead.append(cb)
        for cb in dead:
            self.unsubscribe(cb)

    # ── Spotify search ────────────────────────────────────────────────────

    async def search_spotify(self, query: str) -> list[dict]:
        """
        Search for tracks with spotipy and the server's Spotify credentials.
        Returns a list of candidate dicts with keys: title, artist, album, url.
        """
        loop = asyncio.get_running_loop()
        results = await loop.run_in_executor(self._executor, self._search_sync, query)
        return results

    def _search_sync(self, query: str) -> list[dict]:
        candidates: list[dict] = []
        
        # spotipy with the server's own credentials (never spotdl's shared default client)
        try:
            import spotipy
            from spotipy.oauth2 import SpotifyClientCredentials
            
            client_id = os.getenv("SPOTIPY_CLIENT_ID", "")
            client_secret = os.getenv("SPOTIPY_CLIENT_SECRET", "")
            
            if client_id and client_secret:
                auth = SpotifyClientCredentials(client_id=client_id, client_secret=client_secret)
                sp = spotipy.Spotify(auth_manager=auth)
                results = sp.search(q=query, type='track', limit=10)
                
                for track in results.get('tracks', {}).get('items', []):
                    artists = ", ".join([a['name'] for a in track.get('artists', [])])
                    candidates.append({
                        "title": track.get('name', 'Unknown'),
                        "artist": artists,
                        "album": track.get('album', {}).get('name', ''),
                        "url": track.get('external_urls', {}).get('spotify', ''),
                        "id": track.get('id', ''),
                        "duration_ms": track.get('duration_ms', 0),
                        "cover_url": (track.get('album', {}).get('images', [{}])[1].get('url') or 
                                     track.get('album', {}).get('images', [{}])[0].get('url') or ''),
                    })
                logger.info("Spotify search via spotipy: %d results", len(candidates))
                return candidates
        except ImportError:
            logger.warning("spotipy not installed")
        except Exception as e:
            logger.warning("spotipy search failed: %s", e)
        
        return candidates

    # ── YouTube search ────────────────────────────────────────────────────

    async def search_youtube(self, query: str, limit: int = 8) -> list[dict]:
        """Search YouTube using yt-dlp and return up to `limit` results."""
        loop = asyncio.get_running_loop()
        results = await loop.run_in_executor(self._executor, self._search_youtube_sync, query, limit)
        return results

    def _search_youtube_sync(self, query: str, limit: int = 8) -> list[dict]:
        """Blocking YouTube search using yt-dlp."""
        candidates: list[dict] = []
        try:
            import yt_dlp  # type: ignore

            ydl_opts = {
                "quiet": True,
                "no_warnings": True,
                "extract_flat": True,
                "skip_download": True,
                "js_runtimes": YTDLP_JS_RUNTIMES,
            }
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(f"ytsearch{int(limit)}:{query}", download=False)
                entries = info.get("entries", []) if info else []
                for entry in entries:
                    if not entry:
                        continue
                    vid_id = entry.get("id", "")
                    candidates.append({
                        "id":        vid_id,
                        "title":     entry.get("title", "Unknown"),
                        "channel":   entry.get("channel") or entry.get("uploader") or "",
                        "duration":  entry.get("duration") or 0,
                        "thumbnail": entry.get("thumbnail") or f"https://i.ytimg.com/vi/{vid_id}/mqdefault.jpg",
                        "url":       f"https://www.youtube.com/watch?v={vid_id}",
                    })
        except ImportError:
            logger.error("yt-dlp not installed. Run: pip install yt-dlp")
        except Exception as exc:
            logger.error("YouTube search failed: %s", exc)
        return candidates

    # ── YouTube download ──────────────────────────────────────────────────

    async def download_youtube(self, url: str, title: str = "", artist: str = "") -> str:
        """Enqueue a YouTube download via yt-dlp and return the job_id."""
        job_id = str(uuid.uuid4())
        job = {
            "id":       job_id,
            "url":      url,
            "title":    title or url,
            "artist":   artist or "",
            "status":   "pending",
            "progress": 0,
            "error":    None,
            "added_at": datetime.now(timezone.utc).isoformat(),
        }
        self.download_queue[job_id] = job
        await self._notify(job)

        loop = asyncio.get_running_loop()
        self._main_loop = loop
        fut = loop.run_in_executor(
            self._executor,
            self._run_yt_download_sync,
            job_id,
            url,
            title,
            artist,
        )
        fut.add_done_callback(self._worker_done(job_id))
        return job_id

    def _run_yt_download_sync(self, job_id: str, url: str, title: str, artist: str) -> None:
        """Download a YouTube track using yt-dlp without forcing lossy transcoding."""
        job = self.download_queue[job_id]
        self.active_downloads.add(job_id)
        main_loop = self._main_loop

        def _update(status: str, progress: int, error: str | None = None) -> None:
            job["status"]   = status
            job["progress"] = progress
            if error is not None:
                job["error"] = error
            _notify_threadsafe(self, main_loop, job)

        try:
            import yt_dlp  # type: ignore

            _update("downloading", 5)
            files_before = self._snapshot_files()

            output_template = str(Path(MUSIC_DIR) / "%(title)s.%(ext)s")

            def _progress_hook(d: dict) -> None:
                if d.get("status") == "downloading":
                    pct_str = d.get("_percent_str", "0%").strip().replace("%", "")
                    try:
                        pct = float(pct_str)
                        _update("downloading", max(10, min(80, int(pct * 0.7))))
                    except ValueError:
                        pass

            ydl_opts = {
                "format": "bestaudio/best",
                "outtmpl": output_template,
                "js_runtimes": YTDLP_JS_RUNTIMES,
                "quiet": True,
                "no_warnings": True,
                "progress_hooks": [_progress_hook],
                "writethumbnail": False,  # Disable thumbnail download to avoid postprocessing error
            }
            
            # Respect user's preferred format from env (default opus)
            preferred = DEFAULT_AUDIO_FORMAT if DEFAULT_AUDIO_FORMAT in {"mp3", "opus", "m4a", "flac", "wav"} else "opus"
            ydl_opts["format"] = f"bestaudio[ext={preferred}]/bestaudio/best"
            # Keep "%(title)s.%(ext)s": FFmpegExtractAudio sets the final extension
            # itself. Hard-coding ".{preferred}" here produced "Song.opus.opus".

            postprocessors = [
                {"key": "FFmpegExtractAudio", "preferredcodec": preferred, "preferredquality": "0" if preferred in {"flac", "wav", "opus"} else "192"},
                {"key": "FFmpegMetadata", "add_metadata": True},
            ]
            
            ydl_opts["postprocessors"] = postprocessors

            expected_stem = None
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=True)
                if info:
                    job["title"]  = info.get("title") or title or "Unknown"
                    job["artist"] = info.get("channel") or info.get("uploader") or artist or ""
                    try:
                        expected_stem = Path(ydl.prepare_filename(info)).stem
                    except Exception:
                        expected_stem = None

            _update("downloading", 88)

            # Only THIS job's file. Several downloads run in parallel: a plain
            # before/after snapshot diff also picked up other jobs' files, even
            # half-written intermediates ("X.temp.opus", "X.webm"), which created
            # ghost rows, ran cover/lyrics/mood hooks once per job (the same
            # "official cover set" line logged up to 8 times) and made the Spotify
            # importer miss its own track.
            own_files = _yt_output_files(info)
            if not own_files:
                files_after = self._snapshot_files()
                own_files = sorted(
                    f for f in files_after - files_before
                    if _is_final_audio(f) and (expected_stem is None or Path(f).stem == expected_stem)
                )
            if not own_files:
                raise RuntimeError("yt-dlp finished but its output file was not found")

            job["file_path"] = own_files[0]
            job["track_id"] = _stable_id(own_files[0])
            job["track_ids"] = [_stable_id(f) for f in own_files]

            for file_path in own_files:
                existing = db.get_track(_stable_id(file_path))
                if file_path in files_before and existing is not None:
                    # Same video downloaded again: the file and its row already exist.
                    # Keep the row (and its metadata/cover) untouched, run no hooks.
                    logger.info("YT download reused existing file: %s", file_path)
                    continue
                tags       = _read_tags(file_path)
                cover_path = _resolve_cover_path(file_path)
                track = {
                    "id":         _stable_id(file_path),
                    "title":      tags["title"] or job["title"],
                    "artist":     tags["artist"] or job["artist"],
                    "album":      tags["album"],
                    "duration":   tags["duration"],
                    "file_path":  file_path,
                    "cover_path": cover_path,
                    "added_at":   datetime.now(timezone.utc).isoformat(),
                }
                db.upsert_track(track)

                # Official cover art (YouTube thumbnails are 16:9 video frames).
                # Non-fatal, background thread, only applied at high confidence.
                try:
                    import cover_art
                    cover_art.auto_apply_cover_async(track, raw_artist=job.get("artist"))
                except Exception as exc:
                    logger.warning("cover lookup not started for %s: %s", file_path, exc)

                # Synced lyrics from LRCLIB (cleans messy YouTube titles). Non-fatal,
                # background thread, stored in nocturne.db (v1_lyrics_auto).
                try:
                    from nocturne_api import lyrics_auto
                    lyrics_auto.auto_fetch_async(track, raw_artist=job.get("artist"))
                except Exception as exc:
                    logger.warning("lyrics lookup not started for %s: %s", file_path, exc)

                # Auto mood analysis (runs in this thread, won't block main loop)
                try:
                    ma.analyze_track_mood(track["id"])
                except Exception:
                    pass

                # Search and save lyrics
                lyrics = search_lyrics(track.get("artist", ""), track.get("title", ""))
                if lyrics:
                    lrc_path = save_lyrics_file(file_path, track.get("artist", ""), track.get("title", ""), lyrics)
                    if lrc_path:
                        logger.info(f"Lyrics saved for {track.get('title', '')}")

                logger.info("YT Downloaded & imported: %s", file_path)

                if not job["title"] or job["title"] == url:
                    job["title"] = track["title"] or "Unknown"
                if not job["artist"]:
                    job["artist"] = track["artist"] or ""

            _update("done", 100)

        except ImportError:
            _update("error", 0, "yt-dlp not installed. Run: pip install yt-dlp")
        except Exception as exc:
            logger.error("YT download job %s failed: %s", job_id, exc)
            _update("error", 0, str(exc))
        finally:
            self.active_downloads.discard(job_id)

    # ── Download ──────────────────────────────────────────────────────────

    async def download_track(
        self,
        url_or_query: str,
        title: str = "",
        artist: str = "",
        cover_url: str = "",
    ) -> str:
        """Enqueue a Spotify download (URL / URI / id) and return the job_id."""
        job_id = str(uuid.uuid4())
        job = {
            "id":        job_id,
            "url":       url_or_query,
            "title":     title or None,
            "artist":    artist or None,
            "cover_url": cover_url or None,
            "status":    "pending",
            "progress":  0,
            "error":     None,
            "added_at":  datetime.now(timezone.utc).isoformat(),
        }
        self.download_queue[job_id] = job
        await self._notify(job)

        loop = asyncio.get_running_loop()
        self._main_loop = loop
        task = asyncio.ensure_future(self._run_spotify_job(job_id, url_or_query))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return job_id

    async def _run_spotify_job(self, job_id: str, url_or_query: str) -> None:
        """Spotify link -> library through the import pipeline (no spotdl). Runs on the main
        loop (the pipeline is async and talks to this manager); errors become job.error."""
        job = self.download_queue[job_id]
        self.active_downloads.add(job_id)

        async def _update(status: str, progress: int, error: str | None = None) -> None:
            job["status"] = status
            job["progress"] = progress
            if error is not None:
                job["error"] = error
            await self._notify(job)

        try:
            from nocturne_api import spotify_download as sd
            await _update("downloading", 5)

            def _title(t: str) -> None:
                if not job.get("title"):
                    job["title"] = t

            def _progress(pct: int, _msg=None) -> None:
                job["progress"] = max(job.get("progress", 0), min(95, pct))

            res = await sd.download_ref(url_or_query, self, on_title=_title, on_progress=_progress)
            job["track_ids"] = res["track_ids"]
            job["track_id"] = res["track_ids"][0]
            if res["failures"]:
                job["message"] = "; ".join(f"{f['title']}: {f['reason']}" for f in res["failures"][:5])[:500]
            await _update("done", 100)
        except Exception as exc:
            reason = str(exc) if exc.__class__.__name__ == "DownloadFailed" else f"Error: {type(exc).__name__}: {exc}"
            logger.error("Download job %s failed: %s", job_id, reason)
            await _update("error", 0, reason)
        finally:
            self.active_downloads.discard(job_id)

    def _snapshot_files(self) -> set[str]:
        """Return the set of audio file paths currently in MUSIC_DIR."""
        found: set[str] = set()
        music_path = Path(MUSIC_DIR).resolve()
        if not music_path.exists():
            return found
        for root, _dirs, files in os.walk(music_path):
            for fname in files:
                if Path(fname).suffix.lower() in AUDIO_EXTENSIONS:
                    found.add(os.path.join(root, fname))
        return found

    # ── Job accessors ─────────────────────────────────────────────────────

    def get_job(self, job_id: str) -> dict | None:
        return self.download_queue.get(job_id)

    def get_all_jobs(self) -> list[dict]:
        return sorted(
            self.download_queue.values(),
            key=lambda j: j.get("added_at", ""),
            reverse=True,
        )
