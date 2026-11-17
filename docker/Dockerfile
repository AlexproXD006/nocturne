# syntax=docker/dockerfile:1
#
# Nocturne server image: FastAPI backend (NOVA engine + Nocturne /v1 API) that also
# serves the hosted Nocturne web app at "/".
#
# Build from the repository root:
#   docker build -f docker/Dockerfile -t nocturne .
# Optional local lyric timing with faster-whisper (much bigger image):
#   docker build -f docker/Dockerfile --build-arg WITH_WHISPER=true -t nocturne .

# ── Stage 1: build the hosted SPA (app/ → dist-hosted/) ──────────────────────────
# The output is plain static files, so it always builds on the native build
# platform (no QEMU emulation for npm in multi-arch builds).
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS web
WORKDIR /src/app
ENV CI=true
COPY app/package.json app/package-lock.json ./
# --ignore-scripts: skips Electron's binary download (not needed for the web build);
# Vite/Rolldown/Tailwind native binaries come from optionalDependencies.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY app/ ./
RUN npm run build:hosted \
 && test -f dist-hosted/index.html

# ── Stage 2: Python runtime ──────────────────────────────────────────────────────
FROM python:3.13-slim-bookworm AS runtime

ARG WITH_WHISPER=false

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HOME=/home/nocturne \
    PYTHONPATH=/app \
    MUSIC_DIR=/music \
    NOCTURNE_WEB_DIR=/app/web \
    NOCTURNE_DOWNLOADS_DIR=/downloads

# ffmpeg/ffprobe: used by spotdl and yt-dlp (audio extraction) and the mood analyzer.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/requirements.txt server/requirements-whisper.txt ./
RUN pip install -r requirements.txt \
 && if [ "$WITH_WHISPER" = "true" ]; then pip install -r requirements-whisper.txt; fi \
 && rm -f requirements*.txt

# Server code (tests/docs are excluded by .dockerignore) and the built SPA.
COPY server/ /app/
COPY --from=web /src/app/dist-hosted/ /app/web/

# Non-root user. The writable locations are world-writable (sticky) so the
# container also works with `user: "<uid>:<gid>"` in docker-compose.
RUN useradd --system --uid 10001 --user-group --create-home --home-dir /home/nocturne nocturne \
 && mkdir -p /music /downloads /app/.cache /app/.config \
 && chown -R nocturne:nocturne /music /downloads /app/.cache /app/.config /home/nocturne \
 && chmod 1777 /app/.cache /app/.config /home/nocturne

USER 10001:10001
WORKDIR /app/backend

# Music library + both SQLite databases + Nocturne data (art cache) live here.
VOLUME ["/music"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=300s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/v1/info', timeout=4)"]

# Same invocation as the reference systemd unit. Keep --workers 1: Nocturne
# Connect keeps its SSE queues in process memory.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--log-level", "info"]
