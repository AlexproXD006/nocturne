# Hosted web app + Admin section — design spec

Nocturne replaces the old NOVA web UI at `https://music.example.com`. NOVA stays only as the
internal engine (database, files, downloader); its own UI is removed. The same Nocturne renderer is:

| Target | How it's built | Server URL | Session storage |
|---|---|---|---|
| Desktop (Electron) | `npm run build` | entered at login | access + refresh token, encrypted with OS keychain (safeStorage) |
| Android (Capacitor) | `npm run build:web` → `dist-web/` | entered at login | access + refresh token in Android Keystore |
| **Hosted web** | `npm run build:hosted` → `dist-hosted/` (`VITE_HOSTED=true`) | **always `location.origin`**, no server field | **refresh token in an HttpOnly cookie**, access token in memory only |

## 1. Hosted web mode (client)

- `import.meta.env.VITE_HOSTED === 'true'` ⇒ `platform.kind === 'web'` and `platform.hostedOrigin === location.origin`
  (otherwise `hostedOrigin === null`). In hosted mode the login screen hides the Server field and uses `hostedOrigin`.
- Nothing secret is written to localStorage/sessionStorage in hosted mode.
- On startup `restore()` calls the cookie refresh (below). 200 ⇒ signed in; 401 ⇒ signed out.
- The dev "web" fallback (not hosted, e.g. `vite preview` for testing) keeps today's sessionStorage behavior.

## 2. Cookie session (server + client)

All cookie-mode requests carry the header **`X-Nocturne-Session: cookie`** and use `credentials: 'same-origin'`.

- `POST /v1/auth/login` `{username, password}` with the header ⇒ 200 Session JSON where
  `refreshToken` is `""`, plus
  `Set-Cookie: nocturne_rt=<token>; HttpOnly; Secure; SameSite=Strict; Path=/v1/auth; Max-Age=<refresh ttl>`.
  (Without the header the server behaves exactly as before: refresh token in the body, no cookie.)
- `POST /v1/auth/refresh` with the header and body `{}` ⇒ reads `nocturne_rt`, rotates it (same reuse detection
  as body tokens), returns Session JSON with `refreshToken: ""` and a new `Set-Cookie`. Missing/invalid cookie ⇒ 401
  and `Set-Cookie: nocturne_rt=; Max-Age=0; Path=/v1/auth`.
- `POST /v1/auth/logout` with the header ⇒ revokes the cookie's token family, clears the cookie, 204.
- CSRF protection: cookie-mode requests are only honored when the `Origin` header (if present) equals the server's
  own public origin, and the custom header is present (forces a CORS preflight for cross-site callers).
- Desktop and Android never send the header and keep using body refresh tokens.

## 3. Roles

- `User.role: 'admin' | 'user'` (missing ⇒ `'user'`). Returned by login, refresh and `GET /v1/me`.
- `GET /v1/info` advertises `capabilities.admin: true`, `capabilities.sources: ['spotify','youtube']` (whatever the
  server supports) and `capabilities.uploadMaxBytes`.
- Every `/v1/admin/*` route requires a Bearer token whose user has role `admin`; otherwise **403** `{message}`.
- The Admin section is shown only when `session.user.role === 'admin'` **and** `server.capabilities.admin === true`.
- A server must refuse to demote, disable or delete the **last** enabled admin (409) and an admin can't delete
  themself (409).

## 4. Admin API (`/v1/admin`)

Types live in `src/renderer/src/api/types.ts` (`AdminStats`, `SourceResult`, `AdminJob`, `AdminUser`, `Backup`,
`AdminTrack`, `CreateUserInput`, `UpdateUserInput`); client methods in `src/renderer/src/api/client.ts` (`admin*`).

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/v1/admin/stats` | | `AdminStats` |
| GET | `/v1/admin/sources/search` | `?source=spotify\|youtube&q=` | `{results: SourceResult[]}` |
| POST | `/v1/admin/downloads` | `{source, id?}` or `{source, url?}` (exactly one of id/url) | `AdminJob` (201) |
| POST | `/v1/admin/imports` | `{url}` (Spotify or YouTube playlist link) | `AdminJob` (201) |
| GET | `/v1/admin/jobs` | | `{jobs: AdminJob[]}` newest first (last 100) |
| GET | `/v1/admin/jobs/:id` | | `AdminJob` |
| DELETE | `/v1/admin/jobs/:id` | | 204 (cancels queued/running; 409 if finished) |
| POST | `/v1/admin/library/rescan` | | `AdminJob` (201) |
| GET | `/v1/admin/tracks` | `?q=&offset=&limit=` | `Page<AdminTrack>` |
| DELETE | `/v1/admin/tracks/:id` | | 204 — removes file + DB rows + playlist entries |
| POST | `/v1/admin/uploads` | multipart field `file` (audio: mp3, flac, m4a/aac, ogg/opus, wav) | `AdminTrack` (201); 413 if too big, 415 if not audio |
| GET | `/v1/admin/users` | | `{users: AdminUser[]}` |
| POST | `/v1/admin/users` | `CreateUserInput` (password ≥ 10 chars) | `AdminUser` (201); 409 if username taken |
| PATCH | `/v1/admin/users/:id` | `UpdateUserInput` | `AdminUser`; changing password revokes that user's sessions |
| DELETE | `/v1/admin/users/:id` | | 204 |
| GET | `/v1/admin/backups` | | `{backups: Backup[]}` newest first |
| POST | `/v1/admin/backups` | | `AdminJob` (201, kind `backup`) |
| POST | `/v1/admin/backups/:id/restore` | `{confirm: true}` | `AdminJob` (202, kind `restore`); 400 without confirm |

Jobs are polled by the client every ~1.5 s while any job is `queued`/`running`.

## 5. Admin UI (client)

Route `{name:'admin', tab}` with tabs: **Overview** (stats tiles + active jobs + quick actions), **Add music**
(source search for Spotify/YouTube, paste-a-link download, playlist import, drag-and-drop multi-file upload with
per-file progress), **Jobs** (live list, cancel), **Library** (search tracks, delete with confirm), **Users**
(list, create, edit role/display name, reset password, disable, delete; can't touch yourself destructively),
**Backups** (list, create, restore with typed confirmation). Destructive actions always confirm.

## 6. TTML lyrics library

Admins can attach a lyrics file to any track. **TTML** (W3C Timed Text, Apple Music style) is preferred because it
can carry word-level timing; plain **LRC** is also accepted.

- `GET /v1/tracks/:id/lyrics` → `{synced, plain, ttml}`; `ttml` is the stored TTML document or `null`
  (a stored LRC is returned in `synced`).
- `PUT /v1/admin/tracks/:id/lyrics` `{format: 'ttml'|'lrc', content}` → 204. Max 1 MiB UTF-8. Validation:
  TTML must parse as XML with a `<tt>` root and at least one `<p>` with a `begin` time; LRC must contain at least
  one `[mm:ss.xx]` timestamp. Otherwise 400 `{message}`. Unknown track 404.
- `DELETE /v1/admin/tracks/:id/lyrics` → 204.
- `AdminTrack.lyrics: 'ttml'|'lrc'|null`; `GET /v1/admin/tracks?lyrics=missing|present` filters on it.
- Server must sanitize nothing into HTML — clients render lyrics as text only; servers must store the document as-is
  but reject DOCTYPE/ENTITY declarations (XXE / billion-laughs protection).

Client resolution order (lyrics/service.ts): **stored TTML** → LRCLIB synced → server LRC → plain (LRCLIB or server)
→ none. When lines carry word timing, the lyrics view highlights word by word; otherwise line by line.

Admin UI tab **Lyrics**: list/filter tracks missing lyrics, drop many `.ttml`/`.lrc` files at once with automatic
matching to tracks (TTML `<metadata>` title/artist, `itunes:` metadata, or filename `Artist - Title.ttml`) and a
review step before saving, per-track upload/replace/remove, and a preview that plays the track with the lyrics.
