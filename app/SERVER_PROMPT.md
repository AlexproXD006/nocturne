# Prompt para el servidor (NOVA como motor interno + Nocturne como única web)

> **Forma recomendada: el kit para Claude Code.** No hace falta copiar y pegar nada.
> En tu PC ejecuta `npm run kit` (o usa `nocturne-server-kit.tar.gz` ya generado), cópialo al servidor,
> descomprímelo, abre `claude` dentro de la carpeta y escribe **`/migrar-nocturne`**.
> El kit trae la web ya compilada y verificada con checksums, la documentación de referencia, y reglas de
> seguridad para Claude Code (pide confirmación antes de cualquier `rm`, reinicio o `git reset`, y bloquea `dd`,
> `mkfs` o borrar volúmenes de Docker). Instrucciones paso a paso en el `LEEME.md` del kit.
>
> El bloque de abajo es el mismo procedimiento por si prefieres pegarlo a mano en Claude Code **en la máquina de
> `music.example.com`** (en ese caso tendrás que copiar tú `dist-hosted/` al servidor).

**Qué ha cambiado de plan:** Nocturne ya no convive con la web de NOVA, **la sustituye por completo**.
NOVA pasa a ser solo el motor interno (base de datos, archivos de música, descargador de Spotify/YouTube, análisis).
Su interfaz web desaparece y la web de Nocturne (la misma app, compilada para navegador) se sirve en
`https://music.example.com/`, en el mismo dominio que la API `/v1`. Dentro de Nocturne hay una sección
**Admin** (descargas, subida de archivos, importación de playlists, gestión de la biblioteca, usuarios y copias de seguridad)
que usa una API nueva, `/v1/admin`, solo para usuarios con rol `admin`. Las apps de escritorio y Android siguen funcionando contra la misma `/v1`.

**Antes de pegar el prompt**, prepara la web:

1. En tu PC, dentro del proyecto Nocturne: `npm install` y `npm run build:hosted`. Eso genera la carpeta `dist-hosted/`.
2. Cópiala al servidor, por ejemplo: `scp -r dist-hosted usuario@servidor:/tmp/nocturne-web` (o con `rsync -a --delete dist-hosted/ usuario@servidor:/tmp/nocturne-web/`).
3. Alternativa: si el servidor tiene Node 22 o superior y el código de Nocturne, el agente puede compilarla allí. Te lo preguntará.

Si todavía no has copiado la carpeta, el agente hace todo lo demás y la web se activa en cuanto esté en su sitio.

Qué va a hacer el agente, en orden (se detiene y te pregunta antes de cada paso irreversible):

1. **Descubrir** tu NOVA (código, base de datos, cómo se ejecuta, carpeta de música, configuración de OpenResty / Nginx Proxy Manager) y hacer una **copia de seguridad completa** (código, base de datos, proxy). Nunca borra música. *Punto de parada: te enseña lo que ha encontrado y el plan.*
2. Implementar la API `/v1` que Nocturne espera: login real, tokens, roles (`admin` / `user`), biblioteca, búsqueda, letras, "me gusta", streaming con URLs firmadas de 5 minutos y el modo de sesión por **cookie** para la web.
3. Implementar `/v1/admin` conectándolo a las funciones internas de NOVA (descargas, subidas con validación, importaciones, borrado, usuarios, copias de seguridad, letras TTML/LRC con validación anti-XXE) y un comando para crear el primer administrador.
4. Servir la web de Nocturne en `/` (con cabeceras de seguridad y caché correctas).
5. Escribir y ejecutar los tests. *Punto de parada: te enseña el resultado antes de tocar nada en producción.*
6. **Quitar la web antigua de NOVA** (se archiva en la copia de seguridad, no se destruye) y **cerrar `/api/*` al público**. *Punto de parada: te enseña la lista exacta y no borra código sin tu permiso.*
7. Ajustar el proxy (un solo origen, Range, sin buffering del audio, subidas grandes, HSTS, `/api` y `/docs` bloqueados), reiniciar y comprobarlo con `curl`. *Puntos de parada: antes de tocar el proxy y antes de reiniciar.*

Lo que **romperá** (y por eso te lo preguntará): cualquier script, marcador o automatización que llame a `/api/*` dejará de funcionar desde fuera, porque la API antigua ya no es pública.

Al terminar te imprimirá un resumen y cómo crear tu usuario administrador. Después abre `https://music.example.com` en el navegador (o introduce esa dirección como servidor en la app de escritorio / Android) y entra con ese usuario.
Todo el detalle de despliegue (actualizar la web, volver atrás, snippets del proxy, problemas típicos) está en [docs/DEPLOY.md](docs/DEPLOY.md).

El prompt está en inglés a propósito (es lo que mejor entiende el agente) y es largo porque incluye el contrato completo de la API.

````text
You are a senior backend and security engineer working directly ON the machine that hosts "NOVA Music Server" (public URL: https://music.example.com). NOVA is an existing self-hosted FastAPI application behind OpenResty / Nginx Proxy Manager (NPM). You have shell access and access to the NOVA source code.

DECISION ALREADY TAKEN BY THE OWNER: the new music player "Nocturne" REPLACES the NOVA web UI completely. NOVA becomes only the INTERNAL ENGINE: database, music files, Spotify/YouTube downloader, analysis. NOVA's own frontend is removed. The hosted Nocturne web app (a static single-page app) is served at https://music.example.com/ from the SAME ORIGIN as the /v1 API. Nocturne has its own Admin section (downloads, uploads, imports, library management, users, backups) backed by a new /v1/admin API. The Nocturne desktop (Electron) and Android apps keep working against the same /v1 API.

Your goals, in the order you must do them:

  A. Discover NOVA, back everything up, never touch music files.
  B. Implement /v1 (full contract below) incl. roles, the cookie session mode for the web app, and the complete /v1/admin API mapped onto NOVA's internal functions.
  C. Serve the hosted Nocturne build at / (SPA fallback, cache and security headers).
  D. Remove the NOVA web UI and take the legacy /api/* off the public internet. Keep NOVA's internal modules intact.
  E. Reconfigure the reverse proxy for a single origin.
  F. Write and run a pytest suite.
  G. Restart, verify with curl, print a summary.

(Phase numbers below differ from the letters on purpose: tests (Phase 5) run BEFORE the irreversible cutover (Phases 6 to 8).)

This is a production machine with real user data. Work in phases and report briefly after each. At every line marked "CHECKPOINT" you MUST stop, present what you found or what you are about to do, and WAIT for the user's explicit answer before continuing. Do not batch checkpoints, and do not treat silence or an earlier general approval as consent.

======================================================================
0. NON-NEGOTIABLE RULES
======================================================================
- NEVER delete, truncate, overwrite or migrate-destructively any user data: music files, covers, the database, playlists, users, backups. Database changes are ADDITIVE ONLY (new tables / new columns / new indexes; never DROP, rename or change the type of existing tables or columns). If something looks like it needs a destructive change, stop and ask.
- The ONLY code path in what you write that may delete a music file is the admin "delete track" operation (Phase 3), triggered by an authenticated admin through the API. You yourself never delete, move or rewrite music files or covers while working. Tests use temporary directories only.
- Before changing anything: make the backup of Phase 1. Work on a git branch or, if there is no git repo, on a copy of the source tree made first.
- Do not print, log or commit secrets (JWT secret, media-signing secret, passwords, tokens, Spotify/YouTube credentials). Generate secrets with `python3 -c "import secrets; print(secrets.token_urlsafe(48))"`, store them in the service's environment file (mode 0600, owned by the service user, outside any git repo or in .gitignore) and never echo them back to the terminal or the final summary.
- Develop and test against a STAGING instance of the new code: a second process bound to 127.0.0.1 on a free port, using a COPY of the database (`sqlite3 .backup`) and a COPY (or a read-only bind) of the music root where uploads/deletes cannot hurt the real library. Production stays untouched until the CHECKPOINT of Phase 6. Never run the delete-track or restore operations against the real library or database while testing.
- ASK (CHECKPOINT) before: removing or deleting any code or file (archiving is fine), unexposing legacy routes, touching the reverse proxy, restarting the production service, restarting any other service, any proxy change that affects other sites on the same NPM instance, any dependency install outside the project's own virtualenv/image.
- Do not touch other sites/containers on this machine. Do not open new public ports. Do not install system packages globally unless unavoidable; use the project's virtualenv or rebuild its Docker image.
- Do not contact third-party services except package registries (PyPI, npm if the user agrees to build the web app here). The only exception is whatever NOVA itself legitimately calls (Spotify API, YouTube) when YOU exercise the admin download mapping on STAGING with the user's agreement; prefer mocking those calls in tests.
- Prefer small, well-named modules over editing large legacy files. Keep NOVA's internal behaviour identical. Where NOVA's logic lives inside a route handler and you need it as a function, EXTRACT the body into a plain function in the same module and have the old handler call it (behaviour-preserving refactor, covered by a test); do not duplicate the logic and do not call NOVA over HTTP.
- The Nocturne client source is optional reference only; everything you need is in this prompt.

======================================================================
1. PHASE 1: DISCOVERY AND BACKUP
======================================================================
1.1 Locate the NOVA FastAPI project. Find: the app entry point (FastAPI() instance), routers, how /api/* routes are defined, the database (SQLite? Postgres? path/DSN), the schema/models and how the DB is initialised/migrated, the full-text-search (FTS5) setup behind GET /api/search/fts, the music directory (the sample data shows files under /music), where covers live, lyrics storage and how GET /api/lyrics/{track_id} builds its response (also look for existing .ttml/.lrc files next to the audio files), how plays are recorded (POST /api/tracks/{track_id}/play), playlists / smart playlists storage, the users table behind /api/users, and the FUNCTIONS (not just routes) behind each of these, because the admin API calls them in-process:
    - Spotify search (GET /api/search) and the Spotify credentials/config it uses;
    - download jobs: POST /api/download, GET /api/download/status/{job_id}, GET /api/download/jobs (how job ids are generated, where job state is kept, the status vocabulary and progress format, whether cancellation exists);
    - YouTube: GET /api/yt-search, POST /api/yt-download (yt-dlp, ffmpeg usage);
    - imports: POST /api/import/spotify-playlist, POST /api/import/playlist;
    - upload: POST /api/upload (how a file becomes a track: tag reading, cover extraction, id = sha1 of what?, DB insert, FTS update, analysis);
    - delete: DELETE /api/library/{track_id} (what it removes);
    - library scan/indexing at startup (is there a rescan function?);
    - backups: GET /api/backups, POST /api/backups/restore/{backup_id}, and whatever creates backups (scheduler? function?);
    - stats: GET /api/stats;
    - the NOVA web UI: static directory, templates, manifest, service worker, favicon, the `/` route, every `app.mount(...)`, every /api call it makes.
  Known shapes (from a read-only probe):
    track:  {id (sha1 hex string), title, artist (comma-joined string, may contain duplicates such as "Paul Epworth, Adele Adkins, Paul Epworth, Adele Adkins"), album, duration (integer seconds), file_path, cover_path, added_at (ISO 8601), mood, bpm, energy, valence, play_count, last_played}
    album:  {album (name), artist, track_count, cover_path, added_at}   (albums and artists are identified by NAME in the legacy API)
    legacy route families: /api/library*, /api/stream/{id}, /api/cover/{id}, /api/lyrics/{id}* (GET, translate, generate, sync), /api/albums, /api/artists, /api/playlists* (+ smart, collaborators, export, reorder), /api/discover/{new|top|unplayed|recent}, /api/radio/*, /api/search, /api/search/fts, /api/folders*, /api/download*, /api/yt-search, /api/yt-download, /api/import/*, /api/upload, /api/backups*, /api/users*, /api/activities*, /api/share*, /api/stats, /api/tracks/{id}/{play|mood|analyze}.
1.2 Find out how it runs: systemd unit, Docker / docker compose (service name, image build context, env file, volumes, networks), or a manual process. Note the service user, working directory, listening address/port, and whether the port is reachable from outside the proxy (`ss -ltnp`). The app must only be reachable through the reverse proxy (127.0.0.1 or an internal Docker network only; if it listens on 0.0.0.0 and nothing else blocks direct access, report it and propose a fix; ask before changing).
1.3 Find the reverse proxy: OpenResty / Nginx Proxy Manager (container name, data volume, the proxy host for music.example.com, its upstream, SSL/HSTS/Force-SSL settings, its Advanced "Custom Nginx Configuration", and options such as "Cache Assets" and "Block Common Exploits").
1.4 Find other callers of the legacy API that are NOT the web UI: crontab, systemd timers, other containers, scripts under /etc, /opt, /home (grep for "/api/" and the hostname), webhooks, bots, home-automation. List them: they will stop working from the outside in Phase 6.
1.5 Decide with data (and put the decisions in the CHECKPOINT): (a) where the new v1_* tables live. PREFERRED: a separate SQLite file (env NOCTURNE_DB_PATH, next to NOVA's data directory) so that restoring a NOVA backup can never roll back accounts, sessions or admin jobs. If NOVA uses Postgres or you must share its database, document it and make the restore operation preserve the v1_* tables. (b) Where the hosted web build will live: NOCTURNE_WEB_DIR, default /opt/nocturne/web (a symlink to /opt/nocturne/web-releases/<timestamp>) or a folder inside the NOVA project. (c) How the web build gets onto the machine (copied by the user, or built here if Node >= 22 and the Nocturne sources are present).
1.6 BACKUP (mandatory, before any edit). Print every location and the exact rollback commands:
    - Database: `sqlite3 <db> ".backup '<dest>'"` for SQLite (or `pg_dump`), timestamped, outside the project, e.g. /var/backups/nova-pre-nocturne-<timestamp>/.
    - Code: `tar` of the whole NOVA source tree (including its web UI files) and, if it is a git repo, a clearly named commit of pending work ONLY if the user agrees, plus branch `nocturne-v1-api`.
    - Configuration: env file(s), systemd unit or compose file, and the NPM proxy host configuration (NPM's /data/nginx/proxy_host/<id>.conf and its database export, read-only copy).
    - A separate archive of the NOVA web UI files: nova-webui-<timestamp>.tar.gz.
    - Do NOT copy or move the music library; record its path and size only.
    CHECKPOINT 1: present the findings (stack, DB, run method, proxy, music path, legacy web UI inventory, other API callers, the decisions of 1.5) and the plan with expected downtime (a single short restart). Wait for approval.

======================================================================
2. PHASE 2: THE /v1 API (CONTRACT), ROLES AND COOKIE SESSIONS
======================================================================
Implementation structure (recommended): create a package, e.g. `nocturne_api/` next to the NOVA code, containing: `app.py` (a separate `FastAPI(openapi_url=None, docs_url=None, redoc_url=None)` sub-application mounted with `main_app.mount("/v1", v1_app)` so it has its own middleware and its own exception handlers), `auth.py`, `cookies.py` (cookie session mode, 2.9), `roles.py` (admin guard, 2.10), `tokens.py`, `passwords.py`, `ratelimit.py`, `signing.py`, `media.py`, `ids.py`, `mapping.py` (NOVA rows to wire JSON), `routes_*.py`, `admin/` (Phase 3: `routes.py`, `jobs.py`, `sources.py`, `uploads.py`, `users.py`, `backups.py`, `library.py`, `audit.py`), `web.py` (Phase 4: static hosting), `db.py` (new tables + additive migrations), `cli.py` (create-user etc.), `config.py` (env), and `tests/`. If the project already has a clear convention, follow it. Read all configuration from environment variables (table at the end of Phase 8) and fail fast at startup, with a clear message, when a required secret is missing or too short.

--------------------------------------------------------------
2.1 CONVENTIONS
--------------------------------------------------------------
- Base path /v1. JSON UTF-8, camelCase keys, `Content-Type: application/json; charset=utf-8`. Unknown request fields are ignored. Maximum JSON request body 64 KB (413 above that), except `PUT /v1/admin/tracks/{id}/lyrics` (1 MiB) and the multipart upload (upload cap).
- All JSON responses carry `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
- Timestamps are ISO 8601 UTC strings. Durations are seconds (numbers).
- Authentication: `Authorization: Bearer <accessToken>`. Missing/invalid/expired token => 401 with `WWW-Authenticate: Bearer`. A disabled account => 403.
- ERROR FORMAT, always: `{"message": "<human readable, safe, no internals>", "code": "<snake_case>"}` with the right status. Convert FastAPI/pydantic validation errors (422) into `400 {"message": "...", "code": "bad_request"}`. Unknown route 404, wrong method 405 (with `Allow`). Authorization failures: 401 = no/invalid/expired token, 403 = valid token but not allowed (role, disabled account, CSRF refusal), code `forbidden`. Other codes used below: `conflict` (409), `payload_too_large` (413), `unsupported_media_type` (415). Unhandled exceptions => 500 `{"message":"Internal server error","code":"server_error"}` and log the traceback server-side only.
- Rate limiting: 429 with integer `Retry-After` seconds (header) and the standard error body.
- Ids are opaque strings matching `[A-Za-z0-9_-]{1,128}`. An id that does not exist or is malformed => 404 (never 500).
- Pagination (list endpoints): query `offset` (integer >= 0, default 0) and `limit` (integer 1..200, default 50). Invalid values => 400. Response is `{ "items": [...], "offset": <int>, "limit": <int>, "total": <int total matching> }`.

--------------------------------------------------------------
2.2 WIRE TYPES (TypeScript, authoritative)
--------------------------------------------------------------
```ts
interface Image { url: string; width?: number; height?: number }          // url is ABSOLUTE
interface ArtistRef { id: string; name: string }
interface AlbumRef  { id: string; title: string }

interface Track {
  id: string; title: string; artists: ArtistRef[]; album: AlbumRef | null;
  duration: number;                  // seconds
  artwork: Image[];                  // ordered small -> large, [] when no cover
  explicit?: boolean; trackNumber?: number; discNumber?: number;
  liked?: boolean;                   // for the authenticated user; ALWAYS include it (true/false)
}
interface Album {
  id: string; title: string; artists: ArtistRef[]; year?: number; artwork: Image[];
  trackCount?: number; type?: 'album' | 'single' | 'ep' | 'compilation';
}
interface AlbumDetail extends Album { tracks: Track[]; totalDuration?: number }   // seconds
interface Artist { id: string; name: string; artwork: Image[]; followers?: number }
interface ArtistDetail extends Artist { bio?: string; topTracks: Track[]; albums: Album[] }
interface Playlist {
  id: string; name: string; description?: string; owner?: { id: string; name: string };
  artwork: Image[]; trackCount?: number;
}
interface PlaylistDetail extends Playlist { tracks: Track[] }
interface User { id: string; username: string; displayName: string; avatar?: Image[]; role?: 'admin' | 'user' }   // the server ALWAYS sends role
interface Session { accessToken: string; refreshToken: string; expiresIn: number /* seconds */; user: User }
interface ServerInfo {
  name: string; version: string; apiVersion: 1;
  capabilities?: {
    lyrics?: boolean; likes?: boolean; scrobble?: boolean;
    admin?: boolean;                       // server implements /v1/admin/*
    sources?: ('spotify' | 'youtube')[];   // only sources that are really usable on this server
    uploadMaxBytes?: number;               // max upload size in bytes
  };
}
interface Page<T> { items: T[]; offset: number; limit: number; total: number }
type HomeSection =
  | { id: string; title: string; kind: 'tracks';    items: Track[] }
  | { id: string; title: string; kind: 'albums';    items: Album[] }
  | { id: string; title: string; kind: 'artists';   items: Artist[] }
  | { id: string; title: string; kind: 'playlists'; items: Playlist[] };
interface Home { sections: HomeSection[] }
interface SearchResults { tracks: Track[]; albums: Album[]; artists: Artist[]; playlists: Playlist[] }
interface StreamInfo {
  url: string;                       // short-lived pre-signed ABSOLUTE URL, loadable by <audio> without auth headers
  expiresAt: string;                 // ISO 8601; the client refetches after this
  mimeType?: string; bitrate?: number /* kbps, omit if unknown */;
}
interface ServerLyrics { synced: string | null /* LRC text with [mm:ss.xx] stamps */; plain: string | null; ttml?: string | null /* stored TTML document, see 3.3 LYRICS LIBRARY */ }
```
The Admin wire types (AdminStats, SourceResult, AdminJob, AdminUser, CreateUserInput, UpdateUserInput, Backup, AdminTrack) are in section 3.1.
Omit optional fields you cannot fill truthfully (do not send null for them), except where a field is documented as nullable (e.g. AdminUser.lastLoginAt). Never send `null` for required arrays; use [].

--------------------------------------------------------------
2.3 ENDPOINTS
--------------------------------------------------------------
Auth column: "-" means no authentication, "Bearer" means a valid access token is required.

| Method | Path | Auth | Request | Success | Errors |
|---|---|---|---|---|---|
| GET | /v1/info | - | none | 200 ServerInfo: `{name:"NOVA Music Server", version:<app version>, apiVersion:1, capabilities:{lyrics:true, likes:true, scrobble:true, admin:true, sources:[<only what is really configured: "spotify" if NOVA has working Spotify credentials, "youtube" if yt-dlp and ffmpeg are available>], uploadMaxBytes:<NOCTURNE_UPLOAD_MAX_MB * 1048576>}}` | 429 |
| POST | /v1/auth/login | - | JSON `{username:string, password:string}` (both required non-empty strings, username <= 256, password <= 1024 chars). With header `X-Nocturne-Session: cookie`: cookie mode (2.9) | 200 Session (`expiresIn` = access token lifetime in seconds, 900; `user.role` included). Cookie mode: `refreshToken` is `""` and `Set-Cookie: nocturne_rt` is sent | 400 malformed; 401 `"Wrong username or password."` (identical for unknown user, wrong password, disabled user); 429 rate-limited/locked out with Retry-After |
| POST | /v1/auth/refresh | - | JSON `{refreshToken:string}`; in cookie mode (header `X-Nocturne-Session: cookie`) body `{}` and the token comes from the `nocturne_rt` cookie (2.9) | 200 Session with a NEW access token AND a NEW refresh token (rotation). The old refresh token becomes invalid. | 400 malformed; 401 invalid/expired/revoked/reused token |
| POST | /v1/auth/logout | optional | JSON `{refreshToken?:string}` (body optional); in cookie mode the cookie's family is revoked and the cookie cleared (2.9) | 204 ALWAYS (idempotent): revoke the whole token family of the supplied refresh token, and of the Bearer token's family if a valid Bearer is present. Must succeed even if the access token is expired or the refresh token was already rotated/unknown. | 429 |
| GET | /v1/me | Bearer | none | 200 User (with `role`) | 401 |
| GET | /v1/home | Bearer | none | 200 Home (see 2.4, HOME sections) | 401 |
| GET | /v1/search | Bearer | query `q` (string, <= 200 chars; empty/blank => all four arrays empty), `types` (comma list subset of `track,album,artist,playlist`; default all), `limit` (1..50, default 20, applies PER TYPE) | 200 SearchResults. ALL FOUR keys always present; types not requested are `[]`. Ranking: prefix matches first, then word-prefix, then substring. | 400 unknown type / bad limit / q too long |
| GET | /v1/library/tracks | Bearer | pagination | 200 Page<Track> = the user's LIKED songs, most recently liked first | 400, 401 |
| GET | /v1/library/albums | Bearer | pagination | 200 Page<Album> = all albums, sorted by title (case-insensitive) | 400, 401 |
| GET | /v1/library/artists | Bearer | pagination | 200 Page<Artist> = all artists, sorted by name (case-insensitive) | 400, 401 |
| GET | /v1/library/playlists | Bearer | pagination | 200 Page<Playlist> = NOVA playlists (and smart playlists if you map them), sorted by name | 400, 401 |
| PUT | /v1/library/tracks/{trackId} | Bearer | none | 204 like (idempotent) | 404 unknown track |
| DELETE | /v1/library/tracks/{trackId} | Bearer | none | 204 unlike (idempotent) | 404 unknown track |
| GET | /v1/albums/{albumId} | Bearer | none | 200 AlbumDetail (tracks ordered by track number if known, else added_at ascending then title; each Track has `liked`) | 404 |
| GET | /v1/artists/{artistId} | Bearer | none | 200 ArtistDetail: `topTracks` = up to 10 tracks by play_count desc (ties: added_at desc), `albums` = albums that contain a track credited to the artist (sorted by title). Omit `bio`/`followers` unless you really have them. | 404 |
| GET | /v1/playlists/{playlistId} | Bearer | none | 200 PlaylistDetail (tracks in playlist order) | 404 |
| GET | /v1/tracks/{trackId}/stream | Bearer | none | 200 StreamInfo with a pre-signed URL (see 2.6) | 404 |
| GET | /v1/tracks/{trackId}/lyrics | Bearer | none | 200 ServerLyrics `{synced, plain, ttml}` (always send all three keys; `ttml` is the stored TTML document or null). Resolution order: lyrics stored by an admin (3.3 LYRICS LIBRARY) first, then NOVA's own lyrics converted as below. If the track exists but has no lyrics: 200 `{synced:null, plain:null, ttml:null}`. NEVER trigger lyrics generation/transcription from this GET. | 404 unknown track |
| POST | /v1/tracks/{trackId}/played | Bearer | JSON `{playedSeconds:number 0..86400, at:string ISO 8601}` (both required) | 204; records the play (see 2.4, PLAYS) | 400 invalid body; 404 |
| GET | /v1/media/{trackId}?exp=<unix seconds>&sig=<hex> | signature | optional `Range` header | 200/206/416 audio bytes (see 2.6) | 403 bad/expired signature; 404 |
| GET | /v1/art/{trackId}?w=<300\|800> | - (unguessable ids) | none | 200 image (see 2.7) | 404 |
| * | /v1/admin/* | Bearer + role `admin` | see Phase 3 | see Phase 3 | 401 no/invalid token; 403 `{message, code:"forbidden"}` if the user is not an admin |
| OPTIONS | any /v1/* | - | CORS preflight | 204 (see 2.8) | 403 for a disallowed Origin |

--------------------------------------------------------------
2.4 DATA MAPPING (NOVA -> wire)
--------------------------------------------------------------
- Track.id = NOVA's track id (sha1 hex) unchanged. title = title. duration = duration. `album` = AlbumRef or null when the album field is empty/NULL.
- Track.artists: parse NOVA's comma-joined `artist` string. Split on "," (and ";"), strip whitespace, drop empties, de-duplicate case-insensitively while keeping first-seen order. Names that legitimately contain commas (e.g. "Tyler, The Creator", "Earth, Wind & Fire") cannot be split reliably: add a small additive table `v1_artist_exceptions(name)` (and a CLI command `add-artist-exception "Tyler, The Creator"`) consulted BEFORE splitting; the parser must first greedily match known exceptions in the string. Each artist gets an ArtistRef with a stable opaque id.
- STABLE OPAQUE IDS for albums and artists. Deterministic: `ar_` + url-safe base64 (no padding) of the first 12 bytes of sha1(normalize(name)) for artists; `al_` + the same construction over normalize(albumName) + "|" + normalize(NOVA album artist string) for albums (this mirrors NOVA's own album grouping by album + artist; reuse NOVA's exact grouping logic). normalize() = Unicode NFKC, casefold, strip, collapse internal whitespace. Keep a lookup table `v1_entities(id TEXT PRIMARY KEY, kind TEXT, name TEXT, artist_key TEXT)` populated lazily (upsert whenever an id is generated) and rebuilt/verified at startup, so ids can be resolved back to NOVA names. Ids must never change across restarts. Never expose the raw names as ids and never expose file paths.
- Artist index: build (in a table `v1_track_artists(track_id, artist_id)` or an in-memory index invalidated by a cheap library fingerprint such as `count(*)||max(added_at)` checked at most every few seconds) so "tracks by artist", "albums by artist" and artist listings are fast.
- ARTWORK: artwork is ALWAYS an array of Image with ABSOLUTE urls pointing at `/v1/art/{trackId}`: two entries when resizing is available, `{url:".../v1/art/<id>?w=300", width:300, height:300}` and `{url:".../v1/art/<id>?w=800", width:800, height:800}`, else one entry without width/height. NEVER expose cover_path or file_path anywhere. The `<id>` is the id of a representative track: for a track, itself; for an album, its first track (by album order) that has a cover; for an artist, their most played track that has a cover; for a playlist, its first track with a cover. If no cover exists, `artwork: []`. The absolute base URL comes from env `NOCTURNE_PUBLIC_URL` (e.g. https://music.example.com), NOT from the incoming Host header (fall back to X-Forwarded-Proto/Host only when the request comes from the trusted proxy).
- Album: id, title = album name, artists = parsed album artist string, trackCount = track_count, artwork as above. Omit `year` unless a real year is stored. Omit `type` unless known.
- Playlist: id = `pl_<nova id>` (and `sp_<id>` for smart playlists, if mapped), name, trackCount, artwork = first track's art, `owner` only if NOVA stores one. NOVA playlists have no per-user ownership, so they are visible to every authenticated user (read-only through /v1).
- Per-user LIKED songs: new table `v1_likes(user_id TEXT, track_id TEXT, liked_at TEXT, PRIMARY KEY(user_id, track_id))`. Every Track in every response carries `liked` for the requesting user (do it with one batched query per response, not N queries).
- HOME sections for the authenticated user (omit sections that would be empty; at most 20 items each; stable ids):
  - `recent` "Jump back in" (tracks): the user's last distinct played tracks from `v1_plays` (fallback to NOVA's GET /api/discover/recent logic if the user has no plays yet).
  - `new-albums` "New in your library" (albums): albums of the most recently added tracks (NOVA's discover/new logic), deduplicated.
  - `top` "Most played" (tracks): NOVA discover/top logic.
  - `unplayed` "Never played" (tracks): NOVA discover/unplayed logic.
  - `artists` "Artists" (artists): top artists by total play_count.
  - `playlists` "Playlists" (playlists): NOVA playlists.
  Read what each legacy discover endpoint really means in the code before wiring it, and reuse their SQL/functions directly (do not call your own HTTP API).
- SEARCH: tracks via the existing FTS (sanitise the query for FTS5 syntax: strip operators/quotes, add prefix `*` to the last term); albums/artists/playlists via normalized prefix/substring matching on names using parameterised LIKE with escaped `%` `_`. Rank prefix > word-prefix > substring.
- LYRICS: take the data from the same source/logic as NOVA's GET /api/lyrics/{track_id}. If NOVA returns timestamped lines (e.g. a list of {time, text}), convert to LRC text: one line per entry formatted `[mm:ss.xx]text` (minutes may exceed 59; two-digit centiseconds). If NOVA returns plain text, set `plain`. If both exist return both. Stored admin lyrics (3.3) take precedence: a stored TTML fills `ttml` (and NOVA's lyrics may still fill `synced`/`plain` as fallback); a stored LRC fills `synced` and wins over NOVA's synced lyrics. Never call generate/translate/sync routes from here.
- PLAYS: POST /v1/tracks/{id}/played inserts into new table `v1_plays(id INTEGER PRIMARY KEY, user_id, track_id, played_at, seconds)` and ALSO invokes the same code path NOVA uses for POST /api/tracks/{id}/play (play_count++, last_played) exactly once per accepted report. Ignore (still 204) a report with playedSeconds < 1, and de-duplicate the same user+track within 20 seconds.
- Users: `User.id` = `u_<random hex>` stored in the new accounts tables (see 2.5); `displayName` defaults to username; `avatar` omitted unless set; `role` is `'admin'` or `'user'` straight from the accounts table (2.10).

--------------------------------------------------------------
2.5 AUTHENTICATION AND TOKENS
--------------------------------------------------------------
- Add NEW tables (additive): `v1_accounts(id TEXT PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE, display_name TEXT, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user')), disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT, last_login_at TEXT NULL, password_changed_at TEXT, nova_user_id TEXT NULL)`, `v1_refresh_tokens(id TEXT PRIMARY KEY, family_id TEXT, user_id TEXT, token_hash TEXT UNIQUE, created_at TEXT, expires_at TEXT, used_at TEXT NULL, revoked_at TEXT NULL)`, `v1_token_families(id TEXT PRIMARY KEY, user_id TEXT, created_at TEXT, revoked_at TEXT NULL, revoked_reason TEXT NULL)`, `v1_login_attempts(...)` for rate limiting. Do NOT reuse or alter NOVA's legacy users table; optionally link via nova_user_id. MIGRATION: migrations are additive and idempotent, run at startup, and are recorded in `v1_schema_version`. If a `v1_accounts` table already exists from an earlier version with an `is_admin` column, `ALTER TABLE ... ADD COLUMN role TEXT NOT NULL DEFAULT 'user'` (and `last_login_at`), then `UPDATE v1_accounts SET role='admin' WHERE is_admin=1`, and leave `is_admin` in place (unused). Set `last_login_at` on every successful login.
- Passwords: Argon2id (`argon2-cffi`, library defaults or stronger, rehash on login when parameters change); bcrypt only if Argon2 cannot be installed. Minimum password length 10 (maximum 1024) when creating/resetting, from the CLI and from the admin API alike. For an unknown username, run a dummy hash verification so response time does not reveal whether the user exists.
- CLI (no passwords on the command line, no echo, use getpass or `--password-stdin`): `python -m nocturne_api.cli create-user USERNAME [--display-name NAME] [--admin]` (`--admin` sets role `admin`; without it the role is `user`), `reset-password USERNAME`, `list-users`, `disable-user USERNAME`, `enable-user USERNAME`, `revoke-sessions USERNAME`, `delete-user USERNAME --yes` (accounts only; never touches music), `add-artist-exception NAME`. The CLI must work both on the host and inside the container (document the exact `docker compose exec ...` form if Docker is used). The FIRST account the user creates must be `--admin`. The CLI refuses to disable or delete the last enabled admin unless `--force` is given. Also provide `set-role USERNAME admin|user` with the same last-admin protection.
- Access tokens: JWT HS256 (PyJWT) signed with env `NOCTURNE_JWT_SECRET` (>= 32 bytes), lifetime 900 s (15 min), claims `sub` (user id), `fid` (token family id), `iat`, `exp`, `jti`, `typ:"access"`. Do NOT put the role in the token: verify with `algorithms=["HS256"]` pinned (reject `none` and anything else), require `exp`, then load the account from the DB (cache <= 5 s) to check it is not disabled, the family is not revoked, and to read the CURRENT role, so a demotion or disable takes effect within seconds.
- Refresh tokens: 256-bit random (`secrets.token_urlsafe(32)`), returned once, stored ONLY as a SHA-256 hash, lifetime 30 days. ROTATION: on /auth/refresh, find by hash; if unknown/expired => 401. If it is valid and unused, mark it used, issue a new refresh token in the SAME family plus a new access token. REUSE DETECTION: if a token that was already used (or whose family is revoked) is presented, immediately revoke the entire family (all its tokens and its access tokens) with reason "reuse" and return 401. Do the rotation in a single DB transaction so concurrent requests cannot both succeed. Logout revokes the family. Changing/resetting a password revokes all families of that user.
- LOGIN RATE LIMITING AND LOCKOUT (persistent in the DB so it survives restarts): per client IP at most 20 failed attempts per 15 minutes; per (username, IP) pair 5 consecutive failures => lock that pair for 15 minutes with exponential backoff on repeated lockouts (cap 24 h); additionally a higher per-username-only threshold (e.g. 30 failures/hour) to stop distributed guessing without letting an attacker lock out the real user from their own IP. Respond 429 + Retry-After while locked. Cookie-mode login (2.9) shares the same counters. A successful login resets the pair's counter. Client IP = the real client address: trust X-Forwarded-For ONLY when the immediate peer is the configured proxy (env NOCTURNE_TRUSTED_PROXIES), otherwise use the socket address. Run uvicorn with `--proxy-headers --forwarded-allow-ips=<proxy ip(s)>` accordingly.
- A mild global rate limit (e.g. 300 requests/min per user, 60/min per IP for unauthenticated endpoints) is welcome; media and art endpoints are exempt from the per-user limit.
- Never log passwords, tokens or full signed URLs. Make sure the uvicorn/nginx access logs do not contain Authorization headers.

--------------------------------------------------------------
2.6 STREAMING: SIGNED URLS AND RANGE
--------------------------------------------------------------
- GET /v1/tracks/{id}/stream (Bearer) returns `{url, expiresAt, mimeType}` where `url = "<NOCTURNE_PUBLIC_URL>/v1/media/<id>?exp=<unix seconds>&sig=<hex>"`, `exp = now + 300` (5 minutes), `sig = lower-case hex of HMAC-SHA256(key = env NOCTURNE_MEDIA_SECRET (>= 32 bytes, DIFFERENT from the JWT secret), message = "<id>.<exp>")`. `expiresAt` is the same instant as `exp` in ISO 8601 UTC. `mimeType` from the file extension: mp3 audio/mpeg, flac audio/flac, m4a/mp4/aac audio/mp4 (aac => audio/aac), ogg/oga audio/ogg, opus audio/ogg, wav audio/wav, webm audio/webm; unknown => application/octet-stream.
- GET and HEAD /v1/media/{id}?exp&sig: validate `exp` is an integer in the future and `sig` is 64 hex chars, recompute the HMAC and compare with `hmac.compare_digest` (constant time). Any failure => 403 `{"message":"Invalid or expired stream URL.","code":"forbidden"}` (same response for every failure kind). Unknown track or missing file => 404. No Authorization header is required or consulted on this route (an <audio> element cannot send one); the signature is the credential and it is bound to one track.
- Resolve the file ONLY from the database record of that track id. NEVER build a path from user input; verify the resolved real path is inside the configured music root (`Path.resolve()` + `is_relative_to(root)`), and refuse symlinks that escape it.
- Serve the file with: `Content-Type` (as above), `Accept-Ranges: bytes`, `Content-Length`, `Cache-Control: private, max-age=300`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: cross-origin`, `Content-Disposition: inline`, a weak `ETag`/`Last-Modified`, honouring `If-Range`.
- FULL HTTP RANGE SUPPORT (RFC 9110): a single `Range: bytes=a-b`, `bytes=a-` and suffix `bytes=-n` => `206 Partial Content` with `Content-Range: bytes a-b/total` and the exact `Content-Length`; unsatisfiable (start >= size, `bytes=-0`, malformed numbers) => `416` with `Content-Range: bytes */total`; a Range with an unknown unit or multiple ranges => ignore it and send the whole file with 200. Stream from disk in chunks (64 KiB), never load the file into memory, and stop cleanly on client disconnect. Use the framework's streaming/FileResponse machinery only if it satisfies every rule above (test it); otherwise write the range handling yourself.

--------------------------------------------------------------
2.7 ARTWORK ENDPOINT
--------------------------------------------------------------
- GET /v1/art/{trackId}?w=300|800: no authentication (an <img> cannot send a bearer token; ids are unguessable 160-bit hashes and this exposes only cover images). `w` optional; allowed values 300 and 800 only (anything else => 400). Resolve the cover file from the DB record only, with the same root-containment check as media. If Pillow is installed, resize (keep aspect ratio, longest side = w, convert to JPEG quality 85, or keep PNG if it has transparency) and cache the result on disk under a dedicated cache directory (create it; never write into the music directory); otherwise serve the original file. Headers: correct Content-Type, `Cache-Control: public, max-age=86400`, `ETag` with `If-None-Match` => 304, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: cross-origin`, and CORS (see 2.8). 404 when the track has no cover.
- Document in the final summary that art is the only unauthenticated /v1 resource besides /v1/info and the auth endpoints, and the signed-art alternative if the user wants stricter privacy.

--------------------------------------------------------------
2.8 CORS
--------------------------------------------------------------
- Implement as middleware on the /v1 sub-application ONLY (the legacy /api must not send CORS headers; remove any existing wildcard CORS from legacy routes unless the NOVA UI is served from another origin, in which case ask).
- Allowed origins, EXACT string match, configurable by env `NOCTURNE_CORS_ORIGINS` (comma-separated), defaulting to exactly: `app://nocturne`, `https://localhost`, `capacitor://localhost`, `http://localhost:5173` (development only; recommend removing it in production and tell the user). Never `*`. Reflect the request Origin only when it is in the list, and always send `Vary: Origin`. Do NOT send `Access-Control-Allow-Credentials` (the client uses `credentials: "omit"` and bearer tokens).
- Preflight (OPTIONS): `204` with `Access-Control-Allow-Origin: <origin>`, `Access-Control-Allow-Methods: GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS`, `Access-Control-Allow-Headers: Authorization, Content-Type, Accept, Range, If-Range, If-None-Match`, `Access-Control-Max-Age: 600`. A preflight from a disallowed origin => 403 without CORS headers.
- Actual responses to an allowed Origin carry `Access-Control-Allow-Origin` and `Access-Control-Expose-Headers: Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Retry-After`. THIS MUST ALSO BE TRUE for: /v1/media (200, 206, 304, 403, 404, 416), /v1/art, and every error response (400/401/403/404/405/413/429/500). The audio engine plays media with `crossOrigin="anonymous"` to feed a Web Audio analyser, and artwork is drawn on a canvas, so missing CORS headers on media/art break visualizers and accent colours. Make sure the middleware wraps the exception handlers (add it as the outermost layer).
- Requests without an Origin header (curl, native clients) are served normally without CORS headers.
- The hosted web app is SAME-ORIGIN (https://music.example.com calling https://music.example.com), so it needs no CORS entry. Do NOT add the public URL to the allow-list just for it. Do NOT add `X-Nocturne-Session` to `Access-Control-Allow-Headers`: that makes cookie mode impossible from any cross-origin page (the preflight fails), which is intended. The desktop (`app://nocturne`) and Android (`https://localhost`, `capacitor://localhost`) clients use bearer tokens in the body/headers as before and ALSO use the admin API cross-origin, so the allow-list, `PATCH` and the multipart upload (Content-Type with boundary) must work for `/v1/admin/*` too.

--------------------------------------------------------------
2.9 COOKIE SESSION MODE (hosted web app only)
--------------------------------------------------------------
The hosted web app keeps its REFRESH token in an HttpOnly cookie so that script (including injected script) can never read it; the access token lives only in the page's memory. Implement EXACTLY this. Cookie mode is selected per request by the header `X-Nocturne-Session: cookie`. Without that header every endpoint behaves exactly as specified in 2.3 / 2.5 (refresh token in the JSON body, no cookie is ever set or read). Desktop and Android never send the header.
- POST /v1/auth/login with the header: same validation, rate limiting and lockout as body mode. On success: 200 Session JSON in which `refreshToken` is the empty string `""` (the real token is never in the body), plus
    `Set-Cookie: nocturne_rt=<token>; HttpOnly; Secure; SameSite=Strict; Path=/v1/auth; Max-Age=<refresh ttl in seconds>`
  The cookie has NO `Domain` attribute (host-only). `Secure` is always set when NOCTURNE_PUBLIC_URL is https (omit it only when the public URL is plain http on a loopback host, for local development). `Max-Age` = the refresh token lifetime (30 days = 2592000). The cookie value is the same 256-bit refresh token as in body mode, stored hashed server-side like any other.
- POST /v1/auth/refresh with the header and body `{}` (ignore any `refreshToken` in the body in cookie mode): read `nocturne_rt` from the Cookie header, ROTATE it exactly like a body token (single DB transaction, same family, reuse detection that revokes the whole family), return a Session JSON with `refreshToken: ""` and a NEW `Set-Cookie` with the same attributes. Missing, malformed, unknown, expired, revoked or reused cookie => 401 `{"message":"Session expired.","code":"unauthorized"}` AND `Set-Cookie: nocturne_rt=; Max-Age=0; Path=/v1/auth; HttpOnly; Secure; SameSite=Strict` (clears the cookie).
- POST /v1/auth/logout with the header: revoke the token family of the cookie's token (and of a valid Bearer's family if present), always answer 204 (idempotent, even with no cookie or an unknown one) and always send the clearing `Set-Cookie` above.
- The cookie is ONLY ever consulted by POST /v1/auth/refresh and POST /v1/auth/logout, and ONLY when the header is present. No other endpoint authenticates from a cookie: everything else needs the Bearer access token, /v1/media uses its signature, /v1/art is public. This keeps the CSRF surface to those two routes. (The web client sends the header on EVERY request; on routes other than login/refresh/logout it is simply ignored.)
- CSRF protection for cookie-mode requests (login, refresh, logout): (1) the custom header must be present (a cross-site page cannot send it without a CORS preflight, and the preflight is refused because the header is not in the CORS allow-list, see 2.8); (2) if an `Origin` header is present it must EQUAL the server's own public origin (scheme + host + port of NOCTURNE_PUBLIC_URL), otherwise answer 403 `{"message":"Cross-site request refused.","code":"forbidden"}` without touching the cookie or any token; (3) as extra defence in depth, if `Sec-Fetch-Site` is present and is not `same-origin` (or `none`), refuse the same way. A request with `Origin: null` is refused. Requests from curl without Origin are allowed (they cannot be forged by a victim's browser).
- All cookie-mode responses carry `Cache-Control: no-store`.
- Never log cookie values. Strip `Cookie` and `Set-Cookie` headers from any access/error log.

--------------------------------------------------------------
2.10 ROLES
--------------------------------------------------------------
- Two roles: `admin` and `user`. `GET /v1/me`, login and refresh return `User.role`. Everyone created without an explicit role is `user`. Existing NOVA data has no accounts: the first admin is created with the CLI (2.5).
- Dependency `require_admin`: no/invalid token => 401 (`WWW-Authenticate: Bearer`); valid token of a non-admin or of a role that was just demoted => 403 `{"message":"Administrator access required.","code":"forbidden"}`. It must read the current role from the DB (2.5), never from the token.
- EVERY route under `/v1/admin` (including unknown paths under it) goes through `require_admin`, applied once at the router level, not per route, so a forgotten decorator cannot leave a hole. A test enumerates the app's routes and fails if any `/v1/admin` route lacks the dependency.
- Refuse (409 `conflict`) to demote, disable or delete the LAST ENABLED admin, and refuse to let an admin delete themself. Enforce inside a DB transaction (re-count admins inside it) so two concurrent requests cannot both succeed.

======================================================================
3. PHASE 3: THE /v1/admin API
======================================================================
The admin API is the ONLY way the new web UI manages NOVA. Implement it by calling NOVA's internal service-layer functions IN-PROCESS (see rule in section 0 about extracting handler bodies into functions). Do NOT make HTTP calls to NOVA's own /api (it will not be public anymore). All routes: Bearer + role admin (2.10), JSON in/out as in 2.1, plus the extra rules in 3.3. Mutating admin routes are rate-limited (e.g. 60/min per admin) and written to an audit table (3.4).

--------------------------------------------------------------
3.1 ADMIN WIRE TYPES (TypeScript, authoritative)
--------------------------------------------------------------
```ts
type AdminSource = 'spotify' | 'youtube'
type UserRole = 'admin' | 'user'
interface AdminStats {
  tracks: number; albums: number; artists: number; playlists: number; users: number;
  storageBytes: number;               // total size of the music library on disk
  freeBytes?: number;                 // free space on the music volume, if known
  plays: number;
  activeJobs: number;                 // jobs currently queued or running
}
interface SourceResult {
  id: string;                         // opaque id understood by POST /v1/admin/downloads for this source
  source: AdminSource;
  kind: 'track' | 'album' | 'playlist';
  title: string; artist: string; album?: string; duration?: number /* seconds */;
  artworkUrl?: string;                // absolute https URL of the source's thumbnail
  url?: string;                       // public page of the item
  inLibrary?: boolean;                // true when the library already contains it
}
type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
type JobKind = 'download' | 'import' | 'rescan' | 'backup' | 'restore'
interface AdminJob {
  id: string; kind: JobKind; source?: AdminSource | 'url'; title: string; status: JobStatus;
  progress?: number;                  // 0..1 when known
  message?: string;                   // human readable step, e.g. "Downloading 3/12"
  error?: string;                     // sanitised, no paths/stack traces
  trackIds?: string[];                // tracks added by the job so far
  createdAt: string; finishedAt?: string;   // ISO 8601 UTC
}
interface AdminUser extends User {    // User = {id, username, displayName, avatar?, role?}
  role: UserRole; createdAt: string; lastLoginAt?: string | null; disabled?: boolean;
}
interface CreateUserInput { username: string; displayName?: string; password: string; role: UserRole }
interface UpdateUserInput { displayName?: string; password?: string; role?: UserRole; disabled?: boolean }
interface Backup { id: string; createdAt: string; sizeBytes: number; label?: string }   // label e.g. "database", "database+playlists"
interface AdminTrack extends Track {  // Track as in 2.2
  addedAt?: string; playCount?: number; sizeBytes?: number /* audio file size */; format?: string /* e.g. "mp3" */;
  lyrics?: 'ttml' | 'lrc' | null;     // lyrics stored on the server for this track (always send it: null when none)
}
type LyricsFormat = 'ttml' | 'lrc'
interface SetLyricsInput { format: LyricsFormat; content: string /* full document, UTF-8, <= 1 MiB */ }
```

--------------------------------------------------------------
3.2 ENDPOINTS
--------------------------------------------------------------
| Method | Path | Body / query | Success | Errors |
|---|---|---|---|---|
| GET | /v1/admin/stats | none | 200 AdminStats | 401, 403 |
| GET | /v1/admin/sources/search | `?source=spotify\|youtube&q=` (q 1..200 chars) | 200 `{results: SourceResult[]}` (max 20) | 400 bad source/q; 403; 503 `{code:"source_unavailable"}` if that source is not configured |
| POST | /v1/admin/downloads | JSON `{source, id}` OR `{source, url}`: exactly one of `id` / `url` | 201 AdminJob (kind `download`) | 400 (neither or both, bad URL, URL not belonging to that source); 404/410 unknown or expired `id`; 503 source unavailable |
| POST | /v1/admin/imports | JSON `{url}` (Spotify or YouTube playlist link) | 201 AdminJob (kind `import`) | 400 unsupported/invalid URL |
| GET | /v1/admin/jobs | none | 200 `{jobs: AdminJob[]}` newest first, last 100 | |
| GET | /v1/admin/jobs/{id} | none | 200 AdminJob | 404 |
| DELETE | /v1/admin/jobs/{id} | none | 204; cancels a queued/running job | 404; 409 if already finished |
| POST | /v1/admin/library/rescan | none | 201 AdminJob (kind `rescan`) | 409 `{code:"conflict"}` if a rescan/restore is already active |
| GET | /v1/admin/tracks | `?q=&offset=&limit=&lyrics=missing\|present` (pagination rules of 2.1, q <= 200 chars; other `lyrics` values => 400) | 200 Page<AdminTrack> (newest added first; `q` filters title/artist/album) | 400 |
| DELETE | /v1/admin/tracks/{id} | none | 204; removes the audio file, its cover/art cache AND all DB rows/playlist entries/likes/plays of that track | 404 |
| PUT | /v1/admin/tracks/{id}/lyrics | JSON `SetLyricsInput` `{format:'ttml'\|'lrc', content}` (replaces any stored lyrics) | 204 | 400 invalid format/content (3.3); 404 unknown track; 413 content > 1 MiB |
| DELETE | /v1/admin/tracks/{id}/lyrics | none | 204 (idempotent) | 404 unknown track |
| POST | /v1/admin/uploads | multipart/form-data, one field `file` | 201 AdminTrack | 400 missing field; 413 too large; 415 not audio |
| GET | /v1/admin/users | none | 200 `{users: AdminUser[]}` (all accounts, by username) | |
| POST | /v1/admin/users | CreateUserInput | 201 AdminUser | 400 invalid (username `^[A-Za-z0-9._-]{3,32}$`, password 10..1024 chars, displayName 1..64, role); 409 username taken (case-insensitive) |
| PATCH | /v1/admin/users/{id} | UpdateUserInput (at least one field) | 200 AdminUser | 400; 404; 409 last-admin protection |
| DELETE | /v1/admin/users/{id} | none | 204 | 404; 409 last admin / self |
| GET | /v1/admin/backups | none | 200 `{backups: Backup[]}` newest first | |
| POST | /v1/admin/backups | none | 201 AdminJob (kind `backup`) | 409 if a restore is active |
| POST | /v1/admin/backups/{id}/restore | JSON `{confirm: true}` | 202 AdminJob (kind `restore`) | 400 unless `confirm === true`; 404 unknown backup id; 409 if other jobs are active |

--------------------------------------------------------------
3.3 MAPPING ONTO NOVA (read the real code first; adapt names)
--------------------------------------------------------------
STATS. Combine NOVA's stats logic (GET /api/stats) with direct counts: `tracks`, `albums` and `artists` use the same grouping as /v1/library (2.4); `playlists` = NOVA playlists (+ smart); `users` = count of v1_accounts; `plays` = sum of NOVA play_count; `storageBytes` = sum of audio file sizes (stat each file once; cache the total for 60 s and refresh in the background, never stat 10k files per request); `freeBytes` = `shutil.disk_usage(music_root).free`; `activeJobs` = jobs in queued/running.

SOURCE SEARCH (`GET /v1/admin/sources/search`).
- `spotify` -> NOVA's Spotify search function (what GET /api/search uses, with the server's own credentials). Map each hit to a SourceResult: `id` = `sp:<spotify track id>`, `kind:"track"` (use albums/playlists only if NOVA's search really returns them), title, `artist` (comma-joined), album, duration in SECONDS (convert ms if needed), `artworkUrl` = the cover URL, `url` = https://open.spotify.com/track/<id>. Remember the full hit (title, artist, cover_url, duration) in a short-lived server-side cache table `v1_source_cache(id TEXT PRIMARY KEY, payload TEXT, expires_at TEXT)` (TTL 1 h) because NOVA's download request needs that metadata.
- `youtube` -> NOVA's yt-search function (GET /api/yt-search). `id` = `yt:<video id>`, `kind:"track"`, title, artist = channel name, duration in seconds, `artworkUrl` = thumbnail, `url` = https://www.youtube.com/watch?v=<id>. Cache like above.
- `inLibrary`: true when NOVA already has the item (reuse NOVA's duplicate check: stored source id if it keeps one, otherwise normalised title + first-artist + duration within 2 s). If you cannot decide reliably, omit the field.
- Only offer a source if it works: `capabilities.sources` (2.3) lists exactly those. Missing Spotify credentials => spotify absent and search returns 503.

DOWNLOADS (`POST /v1/admin/downloads`).
- Exactly one of `id`/`url`, else 400. With `id`: `sp:<id>` (source must be spotify) or `yt:<id>` (source must be youtube); the prefix must match `source`. Resolve the cached hit; if the cache entry expired, refetch that single item from the source through NOVA's own client; if that is impossible respond 410 `{code:"source_item_expired"}` ("Search again").
- With `url`: strict parsing, https only. spotify: host `open.spotify.com` (also `spotify.link` only if NOVA supports it), path `/track/<22 base62 chars>` (optionally with `/intl-xx/` prefix); youtube: hosts `youtube.com`, `www.youtube.com`, `music.youtube.com`, `m.youtube.com`, `youtu.be`, a video id of 11 chars `[A-Za-z0-9_-]`; strip playlist/radio params for a single-video download. Reject credentials in the URL, other ports, IP literals, other hosts.
- Translate to NOVA's request: spotify => the download function behind POST /api/download (url/query/track_id/title/artist/cover_url/duration); youtube => the function behind POST /api/yt-download (url, title, artist).
- Job wrapping: create your own AdminJob row `v1_jobs(id TEXT PRIMARY KEY /* "j_"+random hex */, kind, source, title, nova_job_id, status, progress REAL, message, error, track_ids TEXT /* JSON */, created_at, finished_at, created_by)` and store NOVA's job id in `nova_job_id`. Never expose NOVA's id. Status mapping: NOVA pending/queued/waiting -> `queued`; downloading/processing/converting/running -> `running`; done/completed/finished/success -> `done`; error/failed -> `failed`; cancelled -> `cancelled` (read NOVA's real vocabulary and cover every value; unknown values -> `running` while NOVA's job is alive, `failed` if it vanished). `progress`: normalise to 0..1 (divide by 100 if NOVA uses percent), omit if unknown. `message`: NOVA's step text, trimmed to 200 chars. `error`: a short sanitised message (strip absolute paths, URLs with tokens, tracebacks, anything beyond the first line, max 200 chars); log the full detail server-side only. `trackIds`: ids of tracks the job added (from NOVA's result; for imports, filled as tracks appear). `finishedAt` set when the job leaves running.
- A background poller (asyncio task or thread, 1 s interval while any job is active) refreshes linked jobs from NOVA's job state and persists them, so the state is correct even when nobody is polling. At startup mark rows left `running`/`queued` whose NOVA job no longer exists as `failed` with message "Interrupted by a server restart". Run at most N downloads concurrently (default 2, env NOCTURNE_MAX_JOBS); the rest stay `queued`. Keep job rows 30 days.
- Cancel (`DELETE /v1/admin/jobs/{id}`): if NOVA offers cancellation, use it; otherwise mark `cancelled`, stop starting its remaining sub-tasks and discard its result (best effort). 409 when already `done`/`failed`/`cancelled`.
- Subprocesses (yt-dlp, ffmpeg): argument LISTS only, never `shell=True`, timeouts, concurrency limit, output confined to the music root / a temp dir.

IMPORTS (`POST /v1/admin/imports`). Detect by URL: Spotify playlist (`open.spotify.com/playlist/<id>`) -> NOVA's function behind POST /api/import/spotify-playlist; YouTube playlist (`list=` parameter on a youtube.com / music.youtube.com URL) -> the function behind POST /api/import/playlist (read the code: if that function handles other providers or formats, accept only these two kinds). Anything else => 400. Pass `overwrite=false` so an import never clobbers an existing playlist (NOVA's own default may be true; do not inherit it). The AdminJob has `kind:"import"`, `source` spotify|youtube, `title` = playlist name when known (else "Playlist import"), progress "n/total" as `message`, and `trackIds` as tracks are added.

RESCAN (`POST /v1/admin/library/rescan`). Use NOVA's library scan/indexing function (the one that runs at startup). If none is reusable, implement an additive scan: walk the music root (no symlink escapes), for each audio file not in the DB insert it with NOVA's own insertion function (tags, cover, FTS), and NEVER delete rows or files; report files that are in the DB but missing on disk only in the job `message`. Job kind `rescan`; only one at a time.

TRACK LIST AND DELETE. `GET /v1/admin/tracks` reuses the mapping of 2.4 (`artists`, `album`, `artwork`, `liked` for the admin) plus `addedAt`, `playCount`, `sizeBytes` (os.stat of the file, omit if missing), `format` (lower-case extension) and `lyrics` (`'ttml'`, `'lrc'` or `null` from the lyrics table; batch it with one query per page). `?lyrics=missing` keeps only tracks with no stored lyrics, `?lyrics=present` only tracks with stored lyrics (apply in SQL before pagination so `total` is right). `q` filters with the same FTS/escaped-LIKE logic as search. DELETE: resolve the track from the DB; verify its file and cover are inside the music root (`resolve()` + `is_relative_to`; refuse otherwise and delete nothing); in ONE DB transaction remove the track row, its FTS row, playlist entries (and smart-playlist cache), `v1_likes`, `v1_plays`, `v1_lyrics`, `v1_track_artists`, analysis rows; AFTER the commit delete the audio file, the cover file and cached art variants (never anything else, never a directory, never a file still referenced by another track row). Prefer NOVA's own delete function if it already does all of this. Idempotent failure handling: if the file is already gone, still succeed. Record it in the audit log.

LYRICS LIBRARY (admins attach a TTML or LRC document to any track).
- Storage (additive): `v1_lyrics(track_id TEXT PRIMARY KEY, format TEXT NOT NULL CHECK(format IN ('ttml','lrc')), content TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT)`, created by an idempotent migration (record it in `v1_schema_version`). One row per track; PUT replaces. Never touch NOVA's own lyrics storage and never write lyrics into the audio file.
- `PUT /v1/admin/tracks/{id}/lyrics` body `{format, content}`: `format` must be `ttml` or `lrc` (else 400); `content` a non-empty string, UTF-8 size <= 1 MiB (1048576 bytes; larger => 413; this route may accept a JSON body above the generic 64 KB limit, but not above 1 MiB + envelope). Unknown track => 404. Validation, otherwise 400 `{message}` with a short safe reason:
    - TTML: parse with `defusedxml` (`defusedxml.ElementTree.fromstring` on the bytes, `forbid_dtd=True`, `forbid_entities=True`, `forbid_external=True`). ANY `<!DOCTYPE` or `<!ENTITY` declaration, external entity or entity expansion => 400 (XXE and billion-laughs protection), also reject when the raw text contains `<!DOCTYPE` or `<!ENTITY` before parsing. Not well-formed XML => 400. The root element's local name must be `tt` (namespace `http://www.w3.org/ns/ttml`; accept the namespace-less root too) and there must be at least one `<p>` element (any depth) with a `begin` attribute. Store the document AS-IS (do not re-serialise or sanitise it into HTML; clients render lyrics as text only). Add `defusedxml` to the requirements.
    - LRC: at least one line matching `\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]`; reject NUL bytes.
  Success: upsert, set `updated_at` (UTC ISO 8601) and `updated_by`, 204, audit-log it (track id, format, size only; never the content).
- `DELETE /v1/admin/tracks/{id}/lyrics`: remove the row, 204 even when none was stored, 404 only for an unknown track.
- `GET /v1/tracks/{id}/lyrics` (2.3) resolution: (1) stored TTML => `ttml` = the document; also fill `synced`/`plain` from NOVA's lyrics when it has them, else null; (2) stored LRC => `synced` = the stored LRC text (it wins over NOVA's), `ttml` = null, `plain` from NOVA when available; (3) nothing stored => NOVA's lyrics converted to LRC / plain as in 2.4, `ttml` = null. Keep ETag/no-store behaviour of 2.1.
- OPTIONAL ONE-TIME IMPORT of existing lyric files (CLI `python -m nocturne_api.cli import-lyrics [--dry-run]`, idempotent, never run automatically): for each track whose audio file has a sibling file with the same basename (same directory, case-insensitive) and extension `.ttml` or `.lrc`, and which has no row in `v1_lyrics`, validate the file with exactly the same rules as the PUT (size, defusedxml, structure) and insert it (`.ttml` preferred over `.lrc` when both exist). Read the files only (never modify or delete them), stay inside the music root (no symlink escapes), skip invalid files and print a summary (imported, skipped with reason, already present). Run it with `--dry-run` first and show the user the counts before the real run (CHECKPOINT).

UPLOADS (`POST /v1/admin/uploads`). This is the highest-risk route; implement every item:
- Content-Type must be `multipart/form-data`; exactly one file part named `file`; ignore the client-provided Content-Type of the part.
- Size cap = `uploadMaxBytes` (NOCTURNE_UPLOAD_MAX_MB, default 200 MB), enforced WHILE STREAMING to a temp file in the same filesystem as the destination (check `Content-Length` early for a fast 413, but do not trust it): over the cap => stop, delete the temp file, 413 `payload_too_large`. Never buffer the whole file in memory. At most 2 concurrent uploads (extra => 429 with Retry-After).
- Extension allow-list (case-insensitive, taken from the sanitised name): mp3, flac, m4a, aac, ogg, oga, opus, wav. Anything else => 415 `unsupported_media_type`.
- MAGIC-BYTE check on the first bytes of the temp file, and it must AGREE with the extension: mp3 = `ID3` tag or MPEG frame sync (`0xFF 0xE0` mask); flac = `fLaC`; m4a = bytes 4..8 equal `ftyp`; aac = ADTS sync (`0xFFF1`/`0xFFF9`) or `ADIF`; ogg/oga/opus = `OggS`; wav = `RIFF` + `WAVE` at offset 8. Mismatch => 415. Optionally also run `ffprobe` (argument list, 10 s timeout) to confirm an audio stream with duration > 0; failure => 415. Reject files with zero length (400).
- Filename: take the basename only (strip any directory part, both `/` and `\`), Unicode NFC, remove control characters and NUL, replace characters outside `[\w .,'()&+-]` with `_`, collapse dots (no `..`), trim to 120 chars keeping the extension, reject empty names. NEVER overwrite: if the destination exists, append ` (2)`, ` (3)`... Destination = NOVA's upload folder convention (read what /api/upload does; otherwise `<music_root>/uploads/`). Move into place with `os.replace` only after validation, then verify the final path is inside the music root.
- Then hand the file to NOVA's ingestion (the function behind POST /api/upload or the scan insert: tags, cover extraction, id, FTS, analysis) and return the resulting AdminTrack (201). If ingestion fails, remove the file you just wrote (only that file) and answer 422/500 with a safe message. If the same audio already exists (same NOVA id/hash), do not duplicate: answer 409 with the existing track id in `message`-safe form.
- Body limits: the 64 KB JSON limit of 2.1 does NOT apply to this route; the global rate limit does.

USERS. Backed by `v1_accounts` (2.5), NOT by NOVA's legacy users.
- List: all accounts ordered by username; `lastLoginAt` = last_login_at or null; `disabled` boolean.
- Create: validate as in the table; hash with Argon2id; `displayName` defaults to the username; 409 on duplicate (case-insensitive, catch the UNIQUE violation too).
- Patch: any of `displayName`, `password`, `role`, `disabled`. Changing the password re-hashes, sets password_changed_at and REVOKES ALL that user's token families (sessions). Disabling also revokes all their sessions. Demoting or disabling the last enabled admin => 409 `conflict` "At least one enabled administrator is required."
- Delete: removes the account, its token families/tokens, `v1_likes`, `v1_plays`; never touches music or NOVA data. 409 if it is the last enabled admin or the caller themself (also when the caller is not the last admin).
- Never return password hashes; never log passwords.

BACKUPS. Use NOVA's backup functions: list (GET /api/backups logic) -> `Backup {id, createdAt, sizeBytes, label}` (the id is NOVA's backup id, validated against `^[A-Za-z0-9_.-]{1,128}$` and checked to exist in the list; resolve the path only from the list, inside the backups directory); create = job kind `backup` using NOVA's backup-creating function (if NOVA has none, use the SQLite online backup API into NOVA's backups directory with label "database"). Restore (`POST /v1/admin/backups/{id}/restore`): require body `{confirm: true}` exactly (else 400), unknown id => 404, refuse (409) while any other job is active, take an automatic pre-restore backup first, run NOVA's restore function as a job of kind `restore` (202), and re-open DB connections/caches afterwards. A restore must NEVER roll back the v1_* tables (accounts, sessions, jobs): if they live in a separate file (Phase 1.5) this is automatic; if they share NOVA's database, copy them out before and back in after. Surface a clear `message` ("Restoring database", "Done").

--------------------------------------------------------------
3.4 HARDENING AND AUDIT
--------------------------------------------------------------
- Every query parameterised; no string-built SQL (fix any you touch).
- Every path derived from the DB or from a backup id is resolved and checked with `is_relative_to(<root>)`; reject `..`, absolute paths and NUL bytes.
- SSRF: URLs given by admins are parsed and limited to the host allow-lists above; before any outbound fetch of a user-supplied URL by our own code (artwork thumbnails, not yt-dlp internals) resolve the host and refuse loopback, private, link-local and metadata ranges, also after redirects.
- Audit table `v1_audit(id INTEGER PRIMARY KEY, at TEXT, actor_id TEXT, action TEXT, target TEXT, ip TEXT)`: log every admin mutation (download/import start, cancel, rescan, delete track, upload, user create/update/delete incl. which fields, backup create/restore). Never store secrets or file contents. Provide `python -m nocturne_api.cli audit --tail 50`.
- Error messages are safe: no stack traces, no SQL, no absolute paths, no upstream response bodies.
- Admin routes send `Cache-Control: no-store`.

======================================================================
4. PHASE 4: SERVE THE HOSTED NOCTURNE WEB APP AT /
======================================================================
The hosted build is a static single-page app produced by `npm run build:hosted` in the Nocturne project (output folder `dist-hosted/`: `index.html`, `assets/*` with content-hashed names, icons). It always talks to `location.origin`.
4.1 Get the build. If the user already copied `dist-hosted/` (ask for the path), validate it (index.html exists, an `assets/` folder exists, index.html references only relative or root-relative files) and install it as a release: `<NOCTURNE_WEB_RELEASES>/<timestamp>/` (default /opt/nocturne/web-releases/) and point the symlink `NOCTURNE_WEB_DIR` (default /opt/nocturne/web) at it. If not copied and Node >= 22 plus the Nocturne sources are present on this machine, offer to run `npm ci && npm run build:hosted` (ask first: it uses the npm registry). If neither is possible, continue with the rest; `/` will answer 503 until the build is installed, and the final summary must say so. Keep the previous releases (at least the last 3) for rollback: switching releases is repointing the symlink (atomic: create the new link under a temp name, then `mv -T`).
4.2 `nocturne_api/web.py` (mounted LAST on the main app so it never shadows /v1):
- Root = `os.path.realpath(NOCTURNE_WEB_DIR)` resolved on every request (or cached for <= 2 s) so a symlink switch needs no restart. If the directory or its index.html is missing: `/` answers 503 with a short plain text page ("Nocturne web app is not installed yet"), logged once; the server must still start.
- GET/HEAD for any path that does not start with `/v1/`: if it maps to an existing regular file inside the root (join, `resolve()`, `is_relative_to(root)`, reject `..`, NUL, backslashes, dotfiles) serve it with the right Content-Type (js `text/javascript`, css, html, svg, png, ico, webmanifest, woff2, json, map is not served); otherwise, if the last path segment has NO file extension serve `index.html` (SPA fallback, status 200); otherwise 404. So `/assets/missing.js` is a real 404 and `/library/albums/al_x` returns the app. Other methods on these paths => 405.
- Paths under `/v1/` that match no route => the JSON 404 of the v1 app, NEVER index.html. Paths `/api`, `/api/*`, `/docs`, `/redoc`, `/openapi.json`, `/static/*` of the old UI => plain 404 JSON `{"message":"Not found","code":"not_found"}` (see Phase 6).
- Cache headers: `/assets/*` (hashed files) `Cache-Control: public, max-age=31536000, immutable`; `index.html` and every other file `Cache-Control: no-cache` (always revalidate; send `ETag`/`Last-Modified` and answer 304). Support `Range` is not needed for static files.
- Security headers on EVERY response of the main app (static and /v1; the /v1 JSON ones of 2.1 stay):
    Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' https://lrclib.net; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
    Strict-Transport-Security: max-age=31536000   (no includeSubDomains/preload; env NOCTURNE_HSTS=0 disables it if the proxy already sends it, so the client never sees two)
    X-Content-Type-Options: nosniff
    Referrer-Policy: no-referrer
    Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()
  The CSP is sent on the HTML responses (index.html and the SPA fallback); the others on all. Do not weaken the CSP to make something work: if the web app is blocked by it, stop and report which directive and which resource.
- Gzip/brotli: leave compression to the proxy (or `GZipMiddleware` for text types only, never for /v1/media).
4.3 The web app itself needs no server-side templating and no CORS (same origin). Do not inject anything into index.html.

======================================================================
5. PHASE 5: TESTS (pytest)
======================================================================
Add a pytest suite (in the project's tests directory or `nocturne_api/tests`) using FastAPI's TestClient (httpx) against a TEMPORARY copy of the schema/database and a few tiny fixture audio/cover files created in tmp_path (never the real library or the real DB), a temporary web directory containing a fake `index.html` and `assets/app.abcd.js`, and fakes for NOVA's downloader/Spotify/yt-dlp/ffmpeg (no network, no real downloads). Add the test dependencies to the project's dev requirements. Cover at least:
- AUTH: create-user via the CLI function, login success (Session shape, expiresIn 900, `user.role`), wrong password and unknown user return the SAME 401 body, disabled user, malformed bodies (400), login rate limit/lockout (429 + Retry-After, resets after success/time with a fake clock), password hashing is Argon2id (hash prefix) and rehash path, minimum password length 10, `last_login_at` updated.
- TOKENS: access token expiry (fake clock) => 401 + WWW-Authenticate; tampered/`alg:none` JWT rejected; refresh ROTATION (new pair returned, old refresh token now fails), REUSE DETECTION (reusing a rotated token revokes the family: the newest refresh token and access token stop working), concurrent refresh with the same token (only one wins), logout revokes the family and is idempotent (204 even with an expired access token or already-rotated refresh token), password reset revokes all sessions, a role change is visible on the very next request (token not carrying the role).
- COOKIE MODE and CSRF: login with `X-Nocturne-Session: cookie` returns `refreshToken == ""` and a `Set-Cookie` whose attributes are exactly `nocturne_rt`, HttpOnly, Secure, SameSite=Strict, Path=/v1/auth, Max-Age=2592000 and no Domain; login without the header sets NO cookie and returns the token in the body; refresh with cookie + `{}` rotates (new Set-Cookie, old cookie value now rejected, reuse of the old cookie revokes the family and the newer cookie too); refresh without the header ignores the cookie (401/400); missing/invalid cookie => 401 + clearing Set-Cookie (`Max-Age=0`); logout with the header revokes the family, clears the cookie, 204, also 204 with no cookie; Origin check: `Origin` equal to the public origin accepted, a foreign origin, `null`, `app://nocturne` and `https://localhost` => 403 and the cookie/tokens untouched; no Origin accepted; `Sec-Fetch-Site: cross-site` => 403; a CORS preflight asking for `x-nocturne-session` from an allowed native origin is NOT granted; cookie never authenticates any other endpoint (GET /v1/me with only the cookie => 401); cookie values never appear in logs (caplog).
- ROLES / 403: parametrise over EVERY `/v1/admin` route in the app: no token 401, `user` token 403 with the standard body, admin token passes; unknown path under /v1/admin as non-admin => 401/403 (never 404 info leak for anonymous); route-introspection test that fails if a `/v1/admin` route lacks the admin dependency; demoted admin loses access immediately; disabled admin loses access.
- SIGNED URLS: stream endpoint returns a URL whose signature verifies; valid URL serves bytes without Authorization; expired, tampered id, tampered exp, tampered sig, missing params, wrong length sig => 403 identical body; a signature for track A does not work for track B; `hmac.compare_digest` is used (assert via code inspection or monkeypatch).
- RANGE: full 200; `bytes=0-99` => 206 with correct Content-Range/Length; `bytes=100-`; suffix `bytes=-50`; start beyond EOF => 416 with `Content-Range: bytes */size`; `bytes=-0` => 416; multi-range and unknown unit => 200 full body; HEAD; If-Range mismatch => full 200; Content-Type per extension; Accept-Ranges header; large file is streamed (assert chunked iteration, no full read).
- CORS: each of the four allowed origins gets ACAO echoed + Vary: Origin on /v1/info, a JSON endpoint, a 401 error, /v1/media 200/206/403/416 and /v1/art; a disallowed origin (https://evil.example, null, app://other) gets no ACAO and its preflight is 403; preflight response headers (methods incl. PATCH, headers incl. Range/Authorization, max-age); no `Access-Control-Allow-Credentials` anywhere; admin routes and multipart upload work from an allowed native origin.
- EACH /v1 ENDPOINT: success shape (assert exact required keys and types against the contract, `artwork` entries absolute https URLs, `liked` present on every Track, `role` on User, no `file_path`/`cover_path`/absolute-path substrings anywhere in any response body), pagination (offset/limit/total, invalid values => 400, limit > 200 => 400), 401 without token, 404 for unknown and malformed ids, search (all four keys always present, types filter, empty q, operators/quotes in q do not crash FTS, limit per type), likes (PUT/DELETE idempotent, per-user isolation, order and paging), album/artist/playlist details (artist parsing with duplicates and the exceptions table, stable ids across a rebuilt lookup table), home sections (ids/kinds valid, empty sections omitted), lyrics (LRC conversion, plain only, none => both null, no generation side effects), played (validation, play_count incremented exactly once, de-duplication window), `/v1/info` capabilities (`admin:true`, `sources` only for configured sources, `uploadMaxBytes`).
- EACH /v1/admin ENDPOINT (happy path, validation 400, 404, conflict 409, response shape equals section 3.1 exactly): stats (counts, `storageBytes`, `freeBytes`, `activeJobs`); source search for spotify and youtube with faked NOVA clients (mapping of ids `sp:`/`yt:`, seconds, `inLibrary`), unavailable source => 503; download by id and by url (exactly-one rule, wrong host/scheme/credentials/IP-literal URLs rejected, expired cache id => 410); import detection (spotify playlist, youtube playlist, junk => 400, `overwrite=false` passed); job lifecycle with a fake NOVA job (every NOVA status maps correctly, progress percent -> 0..1, error sanitised without paths, trackIds, cancel queued/running, cancel finished => 409, newest-first and 100 cap, restart marks stale jobs failed, concurrency limit keeps extra jobs queued); rescan (adds new files, never deletes, only one at a time); tracks list (q filter, pagination, AdminTrack fields); delete track (file, cover, DB rows, playlist entries, likes, plays gone; a file outside the music root is refused and nothing is deleted; second delete 404; no other file touched); backups (list shape, create job, restore needs `{confirm:true}` else 400, unknown id 404, traversal-looking ids 404, restore refused while jobs active, pre-restore backup made, v1 accounts survive a restore).
- LYRICS LIBRARY: PUT ttml (valid, with word-level `<span begin end>`) => 204 and GET /v1/tracks/{id}/lyrics returns the exact document in `ttml`; PUT lrc => GET returns it in `synced` and `ttml` is null; replacing and DELETE (idempotent, 404 for unknown track); GET with nothing stored falls back to NOVA's lyrics as LRC with `ttml:null`, all three keys always present; validation 400 for: not XML, wrong root, no `<p begin>`, `<!DOCTYPE` (with and without internal subset), `<!ENTITY` / billion-laughs payload, external entity (`SYSTEM "file:///etc/passwd"`), LRC without timestamps, unknown format, empty content, NUL bytes; 413 above 1 MiB; non-admin 403; `AdminTrack.lyrics` is `'ttml'|'lrc'|null`; `?lyrics=missing` / `?lyrics=present` filter with correct `total` and paging, invalid value => 400; deleting a track removes its lyrics row; `import-lyrics` imports sibling `.ttml`/`.lrc` by basename, prefers ttml, skips invalid and already-stored ones, is idempotent, honours `--dry-run`, never modifies files and ignores symlinks that escape the music root.
- UPLOADS: valid mp3/flac/m4a/ogg/wav accepted (201 AdminTrack, file placed inside the music root, no overwrite -> ` (2)` suffix); too big => 413 and temp file removed; wrong extension => 415; extension/magic mismatch (e.g. an `.mp3` that is a PNG or a shell script) => 415; zero bytes => 400; filenames with `../../etc/passwd`, absolute paths, NUL bytes, control chars, Windows separators, very long names are sanitised and stay inside the root; two concurrent uploads of the same name do not clobber each other; no file is left behind after a failure; ingestion failure removes only the new file.
- USERS: create (Argon2id hash stored, password policy 10..1024, username pattern, case-insensitive 409), list has no hashes, patch displayName/role/disabled/password (password change and disable revoke sessions), last-admin protection for demote/disable/delete including two concurrent requests, an admin cannot delete themself, deleting a user removes likes/plays but no tracks, CLI `create-user --admin` / `set-role` / `disable-user` protections.
- STATIC HOSTING: `/` returns index.html with the exact CSP string of 4.2, HSTS, nosniff, Referrer-Policy no-referrer, Permissions-Policy, `Cache-Control: no-cache`; `/assets/app.abcd.js` has `public, max-age=31536000, immutable` and the right Content-Type; unknown deep link `/library/albums/xyz` returns index.html 200; `/assets/missing.js` 404; `/v1/nope` returns JSON 404 not HTML; traversal attempts (`/../`, `/%2e%2e/`, `/assets/..%2f..%2fsecret`, backslashes, NUL) never read outside the web dir; symlink pointing outside the web dir is refused; symlink switch of NOCTURNE_WEB_DIR is picked up without restart; missing web dir => 503 and the API still works; HEAD works; POST to `/` => 405.
- LEGACY NOT PUBLIC: with the production configuration (`NOVA_LEGACY_API=off`) every path in NOVA's old route table (parametrise over the inventory from Phase 1/6, e.g. `/api/library`, `DELETE /api/library/x`, `/api/stream/x`, `/api/upload`, `/api/users`, `/api/backups`) returns 404 from the public app, and `/docs`, `/redoc`, `/openapi.json`, `/api/openapi.json`, the old UI's static files, manifest and service worker return 404; `/v1` has no OpenAPI/docs either.
Run the NOVA project's EXISTING tests too (if any) and make sure they still pass (the behaviour-preserving extractions of section 0 must keep them green); run the formatter/linter/type checker the project already uses. Fix failures; do not weaken tests to pass. Report coverage of the new package (aim >= 90 %).
CHECKPOINT 2: show the user the test results and coverage, the list of new/changed files, the new tables, and the staging URL. Ask for explicit approval to cut over production (Phases 6 to 8). Nothing public has changed so far.

======================================================================
6. PHASE 6: REMOVE THE NOVA WEB UI AND CLOSE THE LEGACY /api/*
======================================================================
6.1 Inventory (from Phase 1): every file, route and mount that belongs to NOVA's own frontend (static directory, templates, JS/CSS, manifest, service worker, favicon, the `/` and `/login`-like routes, `app.mount("/static"...)`) and every legacy route (method, path). Print two tables.
6.2 CHECKPOINT 3. Show: (a) the exact UI files/mounts that will stop being served, (b) the list of /api routes that will no longer be public and the external callers found in step 1.4 that will break, (c) the plan: archive (already in the Phase 1 backup), unmount, and keep every other NOVA module untouched. Ask separately whether the user also wants the now-unused UI files DELETED from disk. Default: do NOT delete anything; just stop serving it (leave the files where they are, or move them to `<project>/_retired_webui_<timestamp>/` only if the user says so). Wait for the answer.
6.3 Implement (after approval):
  - Stop serving the NOVA UI: remove its static mounts and HTML routes from the PUBLIC app. The only thing served at `/` is now the Nocturne web build (Phase 4).
  - Legacy router: do NOT include it in the public app. Env `NOVA_LEGACY_API=off|internal` (default `off`). `off`: not mounted anywhere (NOVA's internal modules are still imported by the admin service layer). `internal`: mounted on a SEPARATE FastAPI app listening only on 127.0.0.1:NOVA_INTERNAL_PORT (never on 0.0.0.0, never via the proxy), for operators and local cron jobs; requests whose peer is not loopback are refused. Document it as unauthenticated and local-only.
  - Defence in depth in the public app: a middleware answering 404 JSON for any path equal to or under `/api`, `/docs`, `/redoc`, `/openapi.json`, `/static` (and any other old-UI path found), BEFORE the SPA fallback. FastAPI docs/openapi are disabled on every app in production (`docs_url=None, redoc_url=None, openapi_url=None`).
  - Remove the wildcard CORS middleware NOVA may have on the main app (the /v1 sub-app has its own, section 2.8). Turn debug mode off.
  - Keep NOVA's internal modules (downloader, analysis, DB layer, Spotify client, backup code) intact and importable.
  - Anything that relied on the public legacy API from outside (step 1.4) is listed in the final summary with the suggested replacement (`NOVA_LEGACY_API=internal` on loopback, or the /v1/admin API with a dedicated admin account).
6.4 Re-run the tests on the final configuration.

======================================================================
7. PHASE 7: REVERSE PROXY (OpenResty / Nginx Proxy Manager)
======================================================================
Goal: ONE origin, https://music.example.com, everything forwarded to the single upstream (NOVA app serving /v1 and the web app), `/api` and docs blocked at the edge as well. Prefer NPM's own settings; files under /data/nginx/proxy_host/*.conf are generated and overwritten on save, so use the host's Advanced "Custom Nginx Configuration". If you cannot change NPM state yourself (it lives in NPM's database/UI), do NOT hack its SQLite file: print the exact settings and snippet for the user to paste in the NPM web UI, then verify with curl.
CHECKPOINT 4: show the final snippet and the NPM toggles you will change, say which other hosts are NOT affected, and ask before applying (or before handing the snippet to the user).
- HTTPS enforced: "Force SSL" ON, HTTP/2 ON, HSTS ON (`max-age=31536000`, no includeSubDomains/preload without asking). `curl -sI http://music.example.com/` must redirect to https. Make sure the client sees exactly ONE `Strict-Transport-Security` header: if both NPM and the app send it, set NOCTURNE_HSTS=0 in the app (or `proxy_hide_header Strict-Transport-Security;` in the locations).
- "Cache Assets" OFF for this host (it must never cache audio or API responses). "Block Common Exploits" may stay ON. WebSockets support may stay as it is.
- Custom Nginx Configuration (adapt UPSTREAM_HOST:UPSTREAM_PORT to the host's real forward address; NPM already defines `location /` for the host):
```nginx
# Single origin: block the legacy API and docs at the edge (the app also returns 404)
location ^~ /api/              { return 404; }
location = /api                { return 404; }
location = /docs               { return 404; }
location ^~ /docs/             { return 404; }
location = /redoc              { return 404; }
location = /openapi.json       { return 404; }

# Audio: pass Range, never buffer
location ^~ /v1/media/ {
    proxy_pass http://UPSTREAM_HOST:UPSTREAM_PORT;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Range $http_range;
    proxy_set_header If-Range $http_if_range;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    gzip off;
}

# Uploads: large bodies, streamed to the app, long timeouts
location ^~ /v1/admin/uploads {
    client_max_body_size 256m;   # must be >= uploadMaxBytes (NOCTURNE_UPLOAD_MAX_MB), e.g. cap + 5%
    proxy_pass http://UPSTREAM_HOST:UPSTREAM_PORT;
    proxy_http_version 1.1;
    proxy_request_buffering off;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 900s;
    proxy_send_timeout 900s;
}
```
  Every other path (`/`, `/assets/*`, `/v1/*`) uses NPM's normal `location /` with Host and `X-Forwarded-*` forwarded (NPM does this when "Websockets"/standard proxy headers are on) and the default `client_max_body_size` (1m is fine: all other bodies are <= 64 KB). The proxy must not add `Access-Control-Allow-Origin` or override the app's CORS, CSP or cache headers. Nginx `add_header` in a location replaces inherited ones, so do not add security headers in these locations; the app sends them.
- The upstream is reachable only from the proxy (127.0.0.1 or the internal Docker network); verify with `ss -ltnp` and an external-style check; propose a fix if exposed. Run uvicorn with `--proxy-headers --forwarded-allow-ips=<proxy ip>` and set NOCTURNE_TRUSTED_PROXIES accordingly.
- Do not touch other proxy hosts or NPM's TLS settings.

======================================================================
8. PHASE 8: DEPLOY AND VERIFY
======================================================================
8.1 Dependencies: add argon2-cffi, PyJWT, python-multipart, optionally Pillow and mutagen if not present (pytest/httpx for dev) to the requirements/lock files; install in the project's own environment (or rebuild the Docker image; never `pip install` into a running container as the only fix).
8.2 Environment (names; values only in the 0600 env file referenced by systemd `EnvironmentFile=` or compose `env_file:`, never echoed):
| Variable | Meaning |
|---|---|
| NOCTURNE_PUBLIC_URL | `https://music.example.com` (absolute base for artwork/stream URLs, cookie Secure decision, CSRF origin) |
| NOCTURNE_JWT_SECRET, NOCTURNE_MEDIA_SECRET | two DIFFERENT secrets, >= 32 bytes |
| NOCTURNE_CORS_ORIGINS | defaults to the four native origins; recommend removing `http://localhost:5173` in production |
| NOCTURNE_TRUSTED_PROXIES | proxy IPs allowed to set X-Forwarded-For |
| NOCTURNE_WEB_DIR | hosted build directory or symlink (default /opt/nocturne/web) |
| NOCTURNE_UPLOAD_MAX_MB | upload cap, default 200 (advertised as `capabilities.uploadMaxBytes`) |
| NOCTURNE_DB_PATH | SQLite file for the v1_* tables (Phase 1.5) |
| NOCTURNE_DATA_DIR | art cache and other generated data (never inside the music root) |
| NOCTURNE_MAX_JOBS | concurrent download jobs, default 2 |
| NOCTURNE_HSTS | `1` (default) or `0` if the proxy sends HSTS |
| NOVA_LEGACY_API | `off` (default) or `internal` (loopback only, see 6.3) |
| NOVA_INTERNAL_PORT | loopback port for the internal legacy app when enabled |
8.3 Apply additive DB migrations (at startup or via `python -m nocturne_api.cli migrate`). Create the first admin account BEFORE the cut-over verification on staging (a temporary one, see below).
8.4 CHECKPOINT 5: before restarting the production service, say what will be restarted (ONLY the NOVA service; expected downtime a few seconds), confirm the rollback commands from Phase 1.6 and the web build symlink. Ask. Then restart (systemd restart or `docker compose up -d --build <service>`) and read its logs for errors.
8.5 Verify with curl FROM THIS MACHINE (public URL; if hairpin NAT blocks it, use the local upstream with `-H "Host: music.example.com" -H "X-Forwarded-Proto: https"`). Create TWO temporary accounts with random passwords via the CLI (one `--admin`, one plain user; never print the passwords), then:
   - `curl -s https://music.example.com/v1/info` -> apiVersion 1, `capabilities.admin == true`, `sources`, `uploadMaxBytes`.
   - Body login: `POST /v1/auth/login` -> Session with `refreshToken` non-empty and `user.role`; `GET /v1/me`, `/v1/home`, `/v1/search?q=a`, `/v1/library/albums?limit=3` with the Bearer token contain no file_path/cover_path; wrong password -> 401; no token -> 401.
   - Cookie login: `curl -si -c jar.txt -H 'Content-Type: application/json' -H 'X-Nocturne-Session: cookie' -H 'Origin: https://music.example.com' -d '{"username":"…","password":"…"}' https://music.example.com/v1/auth/login` -> `refreshToken":""` and `Set-Cookie: nocturne_rt=…; HttpOnly; Secure; SameSite=Strict; Path=/v1/auth; Max-Age=2592000`; then refresh with the jar (`-b jar.txt -c jar.txt`, body `{}`) -> 200 and a new cookie; replaying the OLD cookie -> 401; the same refresh with `-H 'Origin: https://evil.example'` -> 403; logout -> 204 and cookie cleared.
   - Streaming: `GET /v1/tracks/<id>/stream` -> signed URL; `curl -s -D - -o /dev/null -H "Range: bytes=0-99" "<url>"` -> `206`, `Content-Range: bytes 0-99/...`, `Accept-Ranges: bytes`; same URL with a modified `sig` -> 403.
   - Admin authorization: `GET /v1/admin/stats` with the admin token -> 200 AdminStats; with the plain user's token -> 403; without a token -> 401. Do NOT run destructive admin calls (delete track, restore, delete user) on the real library; a read-only check of `/v1/admin/tracks?limit=3`, `/v1/admin/jobs`, `/v1/admin/backups` and `/v1/admin/users` is enough.
   - CORS: `curl -s -D - -o /dev/null -X OPTIONS -H "Origin: app://nocturne" -H "Access-Control-Request-Method: GET" -H "Access-Control-Request-Headers: authorization,range" https://music.example.com/v1/media/<id>` -> 204 with the right headers; with `Origin: https://evil.example` -> no ACAO.
   - Web app: `curl -si https://music.example.com/` -> 200, `Content-Type: text/html`, the CSP header exactly as in 4.2, `Cache-Control: no-cache`, one HSTS header, nosniff, Referrer-Policy, Permissions-Policy, and the body is Nocturne's index.html (it references `/assets/…`); a hashed asset has `Cache-Control: public, max-age=31536000, immutable`; a deep link such as `/library` returns the same index.html; `/assets/does-not-exist.js` -> 404.
   - Legacy closed: `curl -s -o /dev/null -w "%{http_code}"` on `https://music.example.com/api/library`, `/api/stats`, `/api/stream/x`, `/docs`, `/openapi.json` and the old UI's paths -> 404 (and also 404 directly against the upstream port). `curl -sI http://music.example.com/` redirects to HTTPS.
   - Upload limit at the proxy (only if the user agrees to a test upload with the temp admin): a small valid mp3 -> 201 then delete THAT test track via the admin API; a body larger than the cap -> 413 (from the proxy or the app).
   - Finally DELETE the two temporary accounts via the CLI (the only deletion you are allowed to make, only of the accounts you created, and the single test track if you uploaded one).
8.6 Print a SHORT final summary containing: what changed (files/modules, tables added, routes added: /v1, /v1/admin, static hosting), what was removed from public exposure (NOVA UI, /api/*, docs), the backup locations and rollback commands (code, DB, proxy, web build symlink), the env variable names set, how the web build gets updated later (copy `dist-hosted/`, switch the symlink), the exact commands to create their real admin account and to reset a password (host form and Docker form, e.g. `python -m nocturne_api.cli create-user alex --admin` / `docker compose exec <service> python -m nocturne_api.cli create-user alex --admin`), how to log in (open https://music.example.com in a browser, or enter that address as the server in the desktop/Android apps), anything still open or declined (CORS dev origin, art being unauthenticated, NOVA UI files left on disk, the external callers of /api that now fail, a missing web build), and remind them to rotate any credentials that may have been exposed while the legacy API was open to the internet (the Spotify and other API keys stored on this server).
````
