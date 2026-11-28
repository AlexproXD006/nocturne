# Nocturne Server API v1

This is the contract a backend must implement to work with the Nocturne apps
(Electron desktop and Android via Capacitor). The wire types are defined in
`src/renderer/src/api/types.ts`; this document is normative for behaviour. A
runnable reference implementation with demo data lives in `mock-server/`.

- [Overview](#overview)
- [Conventions](#conventions)
- [Authentication](#authentication)
- [CORS](#cors)
- [Endpoints](#endpoints)
- [Streaming design](#streaming-design)
- [Lyrics](#lyrics)
- [Roles](#roles)
- [Cookie session mode](#cookie-session-mode)
- [Hosted web deployment](#hosted-web-deployment)
- [Admin API](#admin-api)
- [Capabilities](#capabilities)
- [Security checklist](#security-checklist)

## Overview

| | |
| --- | --- |
| API version | `1` (`apiVersion` in `GET /v1/info`; the app refuses any other value) |
| Transport | HTTPS (plain HTTP is tolerated by the app only for `localhost` and private LAN addresses) |
| Format | JSON, UTF-8, `Content-Type: application/json` |
| Auth | `Authorization: Bearer <accessToken>` |
| Base URL | Whatever the user types as their server address, e.g. `https://music.example.com` or `https://example.com/nocturne`. A path prefix is allowed; all paths below are relative to it. The trailing slash is stripped. |

The desktop and Android apps never send cookies (`credentials: 'omit'`). Only the hosted web build uses an
HttpOnly refresh cookie, see [Cookie session mode](#cookie-session-mode).

## Conventions

### Errors

Every non-2xx JSON response has the shape:

```json
{ "message": "Human readable explanation." }
```

`message` is shown to the user for most failures, so keep it short and free of
internal details. (`error` is also accepted as a fallback key by the client, but
`message` is the contract.)

| Status | Meaning | Client behaviour |
| --- | --- | --- |
| 400 | Malformed JSON, missing or invalid parameter | Shown as an error. |
| 401 | Missing, invalid or expired access token (or bad credentials on login) | Triggers one refresh, then one retry. |
| 403 | Forbidden: not an admin on `/v1/admin/*`, a foreign `Origin` in cookie mode, a disabled account on login, or an invalid/expired stream URL. | Shown as an error. |
| 404 | Unknown route or entity id | Shown as "not found". |
| 405 | Known path, wrong method (send an `Allow` header) | Error. |
| 409 | Conflict: duplicate username, last-admin / self-delete protection, finished job cancelled again | Shown as an error. |
| 413 | Request body larger than 64 KB (JSON), 4 MiB (lyrics) or the upload limit | Error. |
| 415 | Uploaded file is not a supported audio file | Error. |
| 429 | Rate limited; send `Retry-After: <seconds>` | The client reads `Retry-After` and tells the user to wait. |
| 5xx | Server problem | `GET` requests are retried once after 400 ms. |

Successful responses with no body use `204 No Content`. A 2xx JSON response must
carry a `Content-Type` containing `json`, otherwise the client reports an
unexpected response.

Recommended on all JSON responses: `Cache-Control: no-store` and
`X-Content-Type-Options: nosniff`.

### Identifiers

Ids are opaque, URL-safe strings chosen by the server. The client URL-encodes
them when building paths. Do not use filesystem paths as ids.

### Pagination

List endpoints under `/v1/library/*` take `offset` (default `0`) and `limit`
(default `50`, maximum `200`) and return:

```json
{ "items": [ ... ], "offset": 0, "limit": 50, "total": 137 }
```

`total` is the full number of items, so clients know when to stop. An `offset`
beyond the end returns an empty `items` array with the real `total`.

### Images

`Image` is `{ "url": string, "width"?: number, "height"?: number }`. Artwork
fields are arrays so a server can offer several sizes; the client picks the
smallest image that is at least as wide as it needs, or the largest available.
Provide at least a ~300 px and a ~640 px variant when you can. Image URLs must
be loadable without an `Authorization` header (they are used in `<img>`), so
use public cacheable URLs or pre-signed URLs, and enable CORS on them
(the app reads pixels to extract theme colors; see [CORS](#cors)).

## Authentication

Sessions are an access token plus a rotating refresh token.

```
POST /v1/auth/login    {username, password}      -> Session
POST /v1/auth/refresh  {refreshToken}            -> Session   (rotates the refresh token)
POST /v1/auth/logout   {refreshToken}            -> 204
```

```ts
interface Session {
  accessToken: string
  refreshToken: string
  expiresIn: number   // seconds until the access token expires
  user: User
}
```

### Flow

1. The app calls `GET /v1/info` (no auth) and requires `apiVersion === 1`.
2. `POST /v1/auth/login` returns a `Session`. The app stores it and computes the
   absolute expiry as `now + expiresIn`.
3. Every request sends `Authorization: Bearer <accessToken>`. The client
   proactively refreshes when the token is within 30 seconds of expiry.
4. If any authenticated request returns `401`, the client calls
   `POST /v1/auth/refresh` once (concurrent callers share a single refresh) and
   retries the original request once with the new token.
5. If refresh fails with 400, 401 or 403, the session is discarded and the user
   signs in again. Other failures (network, 5xx, 429) keep the session.
6. `logout` is sent with the current bearer token and the refresh token; the
   client discards its session regardless of the result.

### Token requirements

- Access tokens: opaque random strings with at least 128 bits of entropy
  (for example 32 random bytes, hex or base64url). Recommended lifetime
  **5 to 60 minutes** (the reference mock uses 15). `expiresIn` must be a
  positive number of seconds; the client falls back to 3600 otherwise.
- Refresh tokens: opaque random strings with at least 128 bits of entropy,
  stored server-side only as a hash. Recommended lifetime up to 30 days.
- **Rotation:** every successful `refresh` returns a new `refreshToken` and
  invalidates the one that was used. The response is a full `Session`
  (including `user`).
- **Reuse detection:** presenting a refresh token that was already rotated means
  it was probably stolen. Respond `401` and revoke the whole token family (the
  new refresh token and any access tokens issued from it).
- `logout` revokes the token family of the supplied refresh token and/or bearer
  token. It must be idempotent and return `204` even if the tokens are unknown or
  expired. (The client sends the bearer token, but a server may accept the
  request without it as long as the refresh token is valid.)

### Login failures

- Wrong credentials: `401 { "message": "Invalid username or password." }`. The
  response must not reveal whether the username exists. The app shows its own
  "Wrong username or password." text for 401 on login.
- Rate limiting: `429` with a `Retry-After` header in whole seconds. Limit per IP
  (and ideally per username); the reference mock allows 10 attempts per minute.
- Malformed body: `400`.

### Endpoints

#### `GET /v1/info` (no auth)

```json
{
  "name": "Nocturne Mock",
  "version": "1.1.0",
  "apiVersion": 1,
  "capabilities": {
    "lyrics": true,
    "likes": true,
    "scrobble": true,
    "admin": true,
    "sources": ["spotify", "youtube"],
    "uploadMaxBytes": 209715200
  }
}
```

This is the only endpoint (besides login, refresh and logout) callable without a
token. Do not return anything sensitive from it. See [Capabilities](#capabilities).

#### `POST /v1/auth/login`

Request:

```json
{ "username": "demo", "password": "demo" }
```

Response `200`:

```json
{
  "accessToken": "6f494f39...",
  "refreshToken": "ffd2b51c...",
  "expiresIn": 900,
  "user": {
    "id": "u-demo",
    "username": "demo",
    "displayName": "Demo",
    "avatar": [{ "url": "https://music.example.com/art/user/u-demo.svg?s=300", "width": 300, "height": 300 }],
    "role": "admin"
  }
}
```

#### `POST /v1/auth/refresh`

Request `{ "refreshToken": "ffd2b51c..." }`, response: a new `Session` as above.
Errors: `400` missing token, `401` unknown, expired, revoked or reused token.

#### `POST /v1/auth/logout`

Request `{ "refreshToken": "..." }` (optional body), response `204`.

#### `GET /v1/me`

Returns a `User`:

```ts
interface User { id: string; username: string; displayName: string; avatar?: Image[]; role?: 'admin' | 'user' }
```

## CORS

The apps call the API with `fetch` from these origins, so a browser-grade CORS
policy is required:

| Client | `Origin` |
| --- | --- |
| Electron desktop | `app://nocturne` |
| Android (Capacitor, `androidScheme: https`) | `https://localhost` |
| Capacitor with its default scheme / iOS | `http://localhost`, `capacitor://localhost` |
| Development (Vite) | `http://localhost:5173`, `http://127.0.0.1:5173` |

Requirements:

- Reflect the request `Origin` in `Access-Control-Allow-Origin` **only if it is in
  an allowlist** (add `Vary: Origin`). Do not use `*` together with credentials;
  the apps do not use credentials, but an allowlist is still the right default.
  Make the allowlist configurable, since self-hosters may serve a web build.
- Answer `OPTIONS` preflights (without requiring auth) with `204` and
  `Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS`,
  `Access-Control-Allow-Headers: Authorization, Content-Type, Range, If-None-Match, Accept, X-Nocturne-Session`
  and an `Access-Control-Max-Age`.
- Never send `Access-Control-Allow-Credentials`. Cookie sessions are same-origin only, so no cross-origin
  request ever needs credentials (see [Cookie session mode](#cookie-session-mode)).
- `Access-Control-Expose-Headers: Content-Range, Accept-Ranges, Content-Length, Retry-After`.
- Apply the same CORS headers to **error responses** (401, 404, 429 ...), otherwise
  the browser hides them and the client cannot read `Retry-After` or the message.
- Apply CORS to the **media and artwork URLs too**. The player loads audio with
  `crossOrigin="anonymous"` so the Web Audio analyser can drive the visualizer, and
  artwork is read with a canvas to extract theme colors. Without
  `Access-Control-Allow-Origin` on those responses, the CORS-enabled audio request
  fails; the app then retries without the analyser (non-reactive visuals) and uses
  default colors instead of artwork-derived ones. Adding
  `Cross-Origin-Resource-Policy: cross-origin` to media and art is also
  recommended.

## Endpoints

All endpoints below require `Authorization: Bearer <accessToken>` and return `401`
otherwise. Unknown ids return `404 {"message": "..."}`.

### Data model

```ts
interface ArtistRef { id: string; name: string }
interface AlbumRef { id: string; title: string }

interface Track {
  id: string
  title: string
  artists: ArtistRef[]
  album: AlbumRef | null
  duration: number          // seconds
  artwork: Image[]
  explicit?: boolean
  trackNumber?: number
  discNumber?: number
  liked?: boolean           // whether the current user liked it
}

interface Album {
  id: string; title: string; artists: ArtistRef[]; year?: number; artwork: Image[]
  trackCount?: number; type?: 'album' | 'single' | 'ep' | 'compilation'
}
interface AlbumDetail extends Album { tracks: Track[]; totalDuration?: number /* seconds */ }

interface Artist { id: string; name: string; artwork: Image[]; followers?: number }
interface ArtistDetail extends Artist { bio?: string; topTracks: Track[]; albums: Album[] }

interface Playlist {
  id: string; name: string; description?: string
  owner?: { id: string; name: string }; artwork: Image[]; trackCount?: number
}
interface PlaylistDetail extends Playlist { tracks: Track[] }
```

Always include `liked` on tracks when the `likes` capability is on, so hearts render
correctly everywhere a track appears.

### `GET /v1/home`

A list of shelves, rendered in order. Each section has a `kind` that decides the
type of `items`:

```json
{
  "sections": [
    { "id": "recent", "title": "Recently played", "kind": "tracks", "items": [ /* Track[] */ ] },
    { "id": "albums", "title": "Your albums", "kind": "albums", "items": [ /* Album[] */ ] },
    { "id": "artists", "title": "Artists you love", "kind": "artists", "items": [ /* Artist[] */ ] },
    { "id": "made-for-you", "title": "Made for you", "kind": "playlists", "items": [ /* Playlist[] */ ] },
    { "id": "new-releases", "title": "New releases", "kind": "albums", "items": [ /* Album[] */ ] }
  ]
}
```

Section ids must be unique. Empty sections may be omitted. Keep each shelf to roughly
6 to 20 items.

### `GET /v1/search`

| Param | Description |
| --- | --- |
| `q` | Query text (required in practice; a blank query should return empty arrays). Match case- and diacritic-insensitively as a substring; rank prefix matches first. Max 200 characters (else `400`). |
| `types` | Optional comma separated subset of `track,album,artist,playlist`. Default: all. Unknown value: `400`. |
| `limit` | Max results **per type** (default 20, max 50). |

Response always contains all four keys; types that were not requested are empty:

```json
{ "tracks": [], "albums": [], "artists": [], "playlists": [] }
```

### Library

| Method and path | Response |
| --- | --- |
| `GET /v1/library/tracks?offset&limit` | `Page<Track>`: the user's liked songs, most recently liked first |
| `GET /v1/library/albums?offset&limit` | `Page<Album>` |
| `GET /v1/library/artists?offset&limit` | `Page<Artist>` |
| `GET /v1/library/playlists?offset&limit` | `Page<Playlist>` |
| `PUT /v1/library/tracks/:id` | `204`; like the track (idempotent) |
| `DELETE /v1/library/tracks/:id` | `204`; unlike the track (idempotent) |

`PUT`/`DELETE` return `404` for unknown track ids. The client updates its UI
optimistically and rolls back if the call fails.

### Details

| Method and path | Response |
| --- | --- |
| `GET /v1/albums/:id` | `AlbumDetail` (tracks in disc/track order, `totalDuration` in seconds) |
| `GET /v1/artists/:id` | `ArtistDetail` (`topTracks` up to ~10, `albums` newest first) |
| `GET /v1/playlists/:id` | `PlaylistDetail` (tracks in playlist order) |

Example (`GET /v1/albums/al-glass-meridian`, truncated):

```json
{
  "id": "al-glass-meridian",
  "title": "Glass Meridian",
  "artists": [{ "id": "ar-lumen-harbor", "name": "Lumen Harbor" }],
  "year": 2024,
  "artwork": [
    { "url": "https://music.example.com/art/album/al-glass-meridian.svg?s=300", "width": 300, "height": 300 },
    { "url": "https://music.example.com/art/album/al-glass-meridian.svg?s=640", "width": 640, "height": 640 }
  ],
  "trackCount": 10,
  "type": "album",
  "totalDuration": 1124,
  "tracks": [
    {
      "id": "tr-glass-meridian-01",
      "title": "Counting Smoke",
      "artists": [{ "id": "ar-lumen-harbor", "name": "Lumen Harbor" }],
      "album": { "id": "al-glass-meridian", "title": "Glass Meridian" },
      "duration": 112,
      "artwork": [{ "url": "https://music.example.com/art/album/al-glass-meridian.svg?s=300", "width": 300, "height": 300 }],
      "explicit": false,
      "trackNumber": 1,
      "discNumber": 1,
      "liked": false
    }
  ]
}
```

### `GET /v1/tracks/:id/stream`

Returns a short-lived, pre-signed URL for the audio:

```json
{
  "url": "https://music.example.com/media/tr-glass-meridian-01?exp=1793933554&sig=78ccb7a4...",
  "expiresAt": "2026-11-06T02:52:34.000Z",
  "mimeType": "audio/wav",
  "bitrate": 352
}
```

| Field | Notes |
| --- | --- |
| `url` | Absolute URL loadable without any header. |
| `expiresAt` | ISO 8601. The player caches the URL until shortly before this time, then asks again. |
| `mimeType` | Optional; the actual audio type (`audio/mpeg`, `audio/flac`, `audio/ogg`, ...). |
| `bitrate` | Optional, kbps. |

See [Streaming design](#streaming-design) for what the media endpoint must do.

### `GET /v1/tracks/:id/offline-manifest`

Optional (`capabilities.offline`). Everything a client needs to store one track for offline use, in one call, with
the same short-lived signed URLs as `/stream` and `/media/art` (no new public endpoints):

```json
{
  "trackId": "…", "track": { "…": "Track" },
  "stream": { "url": "…", "expiresAt": "…", "mimeType": "audio/flac" },
  "sizeBytes": 31457280,
  "art": { "url": "…?s=512", "size": 512 },
  "lyrics": { "synced": "…", "plain": null, "offsetMs": 0 }
}
```

`art` and `lyrics` may be `null`; `404` when the track or its audio file does not exist. `POST /v1/offline/manifest`
takes `{ "trackIds": [...] }` (1–50 ids) and returns `{ "items": [manifest…], "missing": [ids] }`.
`capabilities.transcode` is `false` when the server only serves the original files (downloads are then original-only).

### `GET /v1/tracks/:id/lyrics`

See [Lyrics](#lyrics).

### `POST /v1/tracks/:id/played`

Scrobble. Sent when playback of a track ends or is abandoned.

```json
{ "playedSeconds": 42, "at": "2026-11-06T10:00:00.000Z" }
```

`playedSeconds` is a non-negative number (the client rounds to an integer), `at` is the
ISO 8601 time the report was made. Respond `204`. Invalid body: `400`. Only relevant
when `capabilities.scrobble` is true; servers may use it for "Recently played".

### Artwork (unauthenticated GET)

The reference server serves generated covers at `GET /art/:kind/:id.svg?s=<px>`.
A real server can serve any image URLs it likes. Image URLs referenced from
responses need no bearer token, must be cacheable (`Cache-Control: public,
max-age=...`), and must send CORS headers.

## Streaming design

`<audio>` elements cannot send an `Authorization` header, and the app must not put
the long-lived access token in a URL (it would leak into logs, referrers and
caches). So playback is a two step process:

1. The player calls `GET /v1/tracks/:id/stream` with the bearer token.
2. The server answers with a **pre-signed URL**: a URL that embeds an expiry and an
   HMAC (or equivalent) signature over the track id and expiry, using a secret
   that never leaves the server. The audio element loads this URL directly.

The media endpoint (`GET /media/...` in the reference server; the path is yours to
choose since the full URL is returned) must:

- **Not** require an `Authorization` header. Authorize solely by verifying the
  signature and expiry. Compare signatures in constant time. Respond `403` for an
  invalid, tampered or expired URL, and verify the signature before touching the
  database or filesystem so the response does not reveal whether an id exists.
- Keep the lifetime short (the mock uses 5 minutes; 1 to 15 minutes is typical).
  The player renews the URL before it expires, and **re-requests `/stream` once when
  the media element reports an error** (the typical cause is an expired URL), then
  resumes from the same position. A `403` on expired URLs is therefore the expected
  and handled failure mode.
- **Support HTTP range requests.** Seeking in `<audio>` relies on them.
  - Send `Accept-Ranges: bytes` on every response.
  - `Range: bytes=a-b`, `bytes=a-`, and `bytes=-n` -> `206 Partial Content` with
    `Content-Range: bytes a-b/total` and the matching `Content-Length`.
  - A range that cannot be satisfied (start beyond the end, `bytes=-0`, start > end)
    -> `416 Range Not Satisfiable` with `Content-Range: bytes */total`.
  - No `Range` header -> `200` with the full body and `Content-Length`.
  - `HEAD` support is recommended.
- Send the correct `Content-Type`, `X-Content-Type-Options: nosniff`, and
  `Cache-Control: private, max-age=<short>`.
- **Send CORS headers** (`Access-Control-Allow-Origin` per the allowlist, and
  `Access-Control-Expose-Headers: Content-Range, Accept-Ranges, Content-Length`). The
  player sets `crossOrigin="anonymous"` to feed the audio into a Web Audio
  `AnalyserNode` for the visualizer. If the media response lacks CORS headers the
  element errors; the player then reloads the track once without `crossOrigin`, at
  the same position, and the visualizer falls back to non-reactive visuals.
  Playback keeps working, but the reactive visualizer is lost.
- Never include filesystem paths in the URL or in any response.

## Lyrics

`GET /v1/tracks/:id/lyrics` is optional. The app uses a stored `ttml` document first when the server has one (word-by-word highlighting), then asks LRCLIB. If LRCLIB has no
synced lyrics, and the server advertises `capabilities.lyrics: true`, the app asks
the server (server lyrics win over a plain-text LRCLIB result, and are used as the
fallback when LRCLIB has nothing). A server without lyrics should leave the
capability off (or return `404`); the app treats any failure as "no lyrics". Response:

```json
{
  "synced": "[00:04.71]Say it is soft, say it is golden\n[00:09.41]A thousand windows linger\n[00:14.12]",
  "plain": "Say it is soft, say it is golden\nA thousand windows linger",
  "ttml": null
}
```

- `synced`: LRC text with `[mm:ss.xx]` timestamps (minutes, seconds, hundredths), one
  line per timestamp, in ascending order. Offsets are seconds from the start of the
  audio served by `/stream`. A trailing empty line with a timestamp marks the end of
  the last lyric. Use `null` if no timed lyrics exist.
- `plain`: unsynchronized text with `\n` line breaks, or `null`.
- `ttml` (optional): a stored TTML document (W3C Timed Text, Apple Music style, usually with word-level
  `<span begin end>` timing, `ttm:agent` voices and `ttm:role="x-bg"` background vocals), or `null`. See
  [Lyrics library](#lyrics-library-admin).
- Instrumental tracks (or tracks without lyrics): `{ "synced": null, "plain": null, "ttml": null }`
  with status `200`.

## Roles

`User.role` is `"admin"` or `"user"` (missing means `"user"`). It is returned by login, refresh and `GET /v1/me`.

- Every `/v1/admin/*` route needs a bearer token whose user is an admin. No token: `401`. A regular user: `403`
  `{ "message": "Administrator access is required." }`. The role is looked up on every request, so a demotion
  takes effect immediately.
- The client shows the Admin section only when `session.user.role === 'admin'` **and**
  `capabilities.admin === true`.
- A server must refuse (`409`) to demote, disable or delete the **last enabled admin**, and an admin cannot delete
  their own account (`409`).
- Reference mock: `MOCK_USERS="name:password[:role],..."` (role `admin` or `user`, default `user`). The default is
  `demo:demo:admin,guest:guestguest:user`. A password may contain `:`; only a final `:admin` / `:user` segment is
  read as the role.

## Cookie session mode

The hosted web build (served from the same origin as the API) must not keep a refresh token in JavaScript-readable
storage. In **cookie mode** the refresh token lives in an `HttpOnly` cookie and only the short-lived access token is
held in memory. Cookie mode is opt-in per request with the header `X-Nocturne-Session: cookie`; without it the server
behaves exactly as described above (token in the body, no cookie). Desktop and Android never send the header.

| Request (all with `X-Nocturne-Session: cookie`) | Behaviour |
| --- | --- |
| `POST /v1/auth/login` `{username, password}` | `200` Session with `"refreshToken": ""` and `Set-Cookie: nocturne_rt=<token>; HttpOnly; Secure; SameSite=Strict; Path=/v1/auth; Max-Age=<refresh ttl>` |
| `POST /v1/auth/refresh` (body `{}` or empty) | Reads `nocturne_rt`, rotates it with the same reuse detection as body tokens, returns Session with `refreshToken: ""` and a new `Set-Cookie`. Missing, unknown, expired, revoked or reused cookie: `401` plus `Set-Cookie: nocturne_rt=; Max-Age=0; Path=/v1/auth` |
| `POST /v1/auth/logout` | Revokes the token family of the cookie (and of the bearer token, if sent), clears the cookie, `204` |

```
POST /v1/auth/refresh HTTP/1.1
X-Nocturne-Session: cookie
Cookie: nocturne_rt=ffd2b51c...

HTTP/1.1 200 OK
Set-Cookie: nocturne_rt=0c9a41e7...; HttpOnly; Secure; SameSite=Strict; Path=/v1/auth; Max-Age=2592000
{ "accessToken": "...", "refreshToken": "", "expiresIn": 900, "user": { ... } }
```

Why it is built this way:

- **XSS cannot steal the refresh token**: `HttpOnly` keeps it out of reach of scripts, and `Path=/v1/auth` means the
  browser sends it only to the three auth endpoints, never to media, art or the rest of the API.
- **CSRF**: `SameSite=Strict` stops browsers sending the cookie on cross-site requests. As defence in depth the
  server honours cookie-mode requests only if the `Origin` header (when present) equals the server's own origin
  (`MOCK_PUBLIC_URL`, or the `Host` header, `https` when `MOCK_TRUST_PROXY=1` and `X-Forwarded-Proto: https`);
  otherwise `403`. The custom header forces a CORS preflight for any cross-site caller, and a plain form post cannot
  set it.
- **Same-origin only**: CORS never allows credentials (`Access-Control-Allow-Credentials` is not sent). Allowing
  `X-Nocturne-Session` in `Access-Control-Allow-Headers` only lets the preflight succeed; the origin check still
  rejects foreign origins.
- **Shared families**: a cookie token and a body token live in the same token store, so rotation and reuse
  detection behave identically.
- **`Secure`** is always set, except when the effective origin is plain `http` on `localhost` or `127.0.0.1`
  (local testing of the hosted build). Behind a TLS-terminating proxy, set `MOCK_PUBLIC_URL` / `MOCK_TRUST_PROXY=1`
  so the server knows the origin is `https`.

## Hosted web deployment

The hosted build (`npm run build:hosted` -> `dist-hosted/`) is served by the same server that implements the API:

- **Same origin.** The page, `/v1/*`, `/media/*` and `/art/*` share one origin, so cookie mode, media and artwork
  need no CORS at all. The client always talks to `location.origin`.
- **SPA routing.** Any `GET`/`HEAD` that is not `/v1`, `/media` or `/art` and does not match a file falls back to
  `index.html` (missing assets with a file extension answer `404` instead, unless the browser asks for HTML).
- **Content Security Policy** on the HTML document:

  ```
  Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:;
    connect-src 'self' https://lrclib.net; style-src 'self' 'unsafe-inline'; font-src 'self' data:;
    object-src 'none'; base-uri 'none'; frame-ancestors 'none'
  X-Frame-Options: DENY
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  ```

  `https://lrclib.net` is the only third-party origin the player contacts. Audio is loaded from the same origin
  (signed `/media` URLs) or `blob:`.
- **HTTPS** with HSTS in production; set the cookie `Secure` flag (default) and send `Cache-Control: no-store` on API
  JSON. Hashed files under `/assets/` can be cached immutably; `index.html` must not be.
- **Path safety.** Resolve files inside the build directory only: reject `..`, encoded separators, NUL and symlinks
  that leave the directory (`403`).
- The reference mock does all of this when started with `MOCK_STATIC_DIR=dist-hosted node mock-server/server.mjs`
  (see `mock-server/README.md`).

## Admin API

All routes live under `/v1/admin`, require an admin bearer token (see [Roles](#roles)) and use the shapes from
`src/renderer/src/api/types.ts`. Unknown ids answer `404`, malformed input `400`. Long-running work is modelled
as **jobs** the client polls (about every 1.5 s while any job is `queued` or `running`).

| Method | Path | Body / query | Response |
| --- | --- | --- | --- |
| GET | `/v1/admin/stats` | | `AdminStats` |
| GET | `/v1/admin/sources/search` | `?source=spotify\|youtube&q=` | `{ results: SourceResult[] }` |
| POST | `/v1/admin/downloads` | `{source, id}` or `{source, url}` (exactly one) | `AdminJob` `201` |
| POST | `/v1/admin/imports` | `{url}` (playlist link) | `AdminJob` `201` |
| GET | `/v1/admin/jobs` | | `{ jobs: AdminJob[] }` newest first, at most 100 |
| GET | `/v1/admin/jobs/:id` | | `AdminJob` |
| DELETE | `/v1/admin/jobs/:id` | | `204`; `409` if the job already finished |
| POST | `/v1/admin/library/rescan` | | `AdminJob` `201` |
| GET | `/v1/admin/tracks` | `?q=&offset=&limit=&lyrics=missing\|present` | `Page<AdminTrack>` |
| DELETE | `/v1/admin/tracks/:id` | | `204` |
| PUT | `/v1/admin/tracks/:id/lyrics` | `{format: 'ttml'\|'lrc', content}` | `204` |
| DELETE | `/v1/admin/tracks/:id/lyrics` | | `204` |
| POST | `/v1/admin/uploads` | `multipart/form-data`, field `file` | `AdminTrack` `201`; `413` / `415` |
| GET | `/v1/admin/users` | | `{ users: AdminUser[] }` |
| POST | `/v1/admin/users` | `CreateUserInput` | `AdminUser` `201` |
| PATCH | `/v1/admin/users/:id` | `UpdateUserInput` | `AdminUser` |
| DELETE | `/v1/admin/users/:id` | | `204` |
| GET | `/v1/admin/backups` | | `{ backups: Backup[] }` newest first |
| POST | `/v1/admin/backups` | | `AdminJob` `201` (kind `backup`) |
| POST | `/v1/admin/backups/:id/restore` | `{confirm: true}` | `AdminJob` `202` (kind `restore`); `400` without confirm |

### Stats

```json
{ "tracks": 110, "albums": 14, "artists": 8, "playlists": 6, "users": 2,
  "storageBytes": 512799640, "freeBytes": 549243014248, "plays": 13446, "activeJobs": 0 }
```

`activeJobs` counts jobs that are `queued` or `running`.

### Source search

`GET /v1/admin/sources/search?source=spotify&q=glass` -> `{ "results": [ ... ] }` (a blank `q` gives `[]`; an unknown
`source` is `400`). The reference mock returns 8 to 15 deterministic, invented results per query with a mix of
`track`, `album` and `playlist` kinds; nothing is fetched from the real services.

```json
{
  "results": [
    {
      "id": "spotify:album:0:glass",
      "source": "spotify",
      "kind": "album",
      "title": "Glass Meridian",
      "artist": "Lumen Harbor",
      "album": "Glass Meridian",
      "artworkUrl": "https://music.example.com/art/source/spotify%3Aalbum%3A0%3Aglass.svg?s=300",
      "url": "https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy",
      "inLibrary": true
    },
    {
      "id": "spotify:track:1:glass",
      "source": "spotify",
      "kind": "track",
      "title": "Paper Glass",
      "artist": "Silk & Cinder",
      "album": "Late Letters",
      "duration": 121,
      "artworkUrl": "https://music.example.com/art/source/spotify%3Atrack%3A1%3Aglass.svg?s=300",
      "url": "https://open.spotify.com/track/2takcwOaAZWiXQijPHIx7B",
      "inLibrary": false
    }
  ]
}
```

`id` is opaque to clients; `inLibrary` is true when an item with the same title is already in the library.

### Downloads and imports

`POST /v1/admin/downloads` takes `{ "source": "spotify", "id": "<SourceResult.id>" }` or
`{ "source": "youtube", "url": "https://youtu.be/<id>" }`. Providing both or neither is `400`, as is an `id` from the
other source or a link that is not a Spotify / YouTube track, album or playlist link of the chosen source.
`POST /v1/admin/imports` takes `{ "url": "<playlist link>" }`, downloads every track and creates a playlist.

Result: `201` with an `AdminJob`. For jobs started from a pasted link `source` is `"url"`; for imports it is the
detected source. The reference mock adds new tracks (with audio and lyrics like the demo tracks) plus a new
artist / album as needed, skips tracks that already exist (message `Already in your library` when nothing was new)
and fails any item whose id or link contains `fail` (to exercise the failed state).

### Jobs

```json
{
  "id": "job-0003",
  "kind": "download",
  "source": "spotify",
  "title": "Paper Glass - Silk & Cinder",
  "status": "running",
  "progress": 0.5,
  "message": "Downloading 1/1",
  "trackIds": [],
  "createdAt": "2026-11-06T10:00:00.000Z"
}
```

Lifecycle: `queued` -> `running` (with `progress` 0..1 and a human `message`) -> `done` (`progress: 1`,
`finishedAt`) or `failed` (`error`, `finishedAt`) or `cancelled`. `trackIds` lists tracks added so far.
`DELETE /v1/admin/jobs/:id` cancels a queued or running job (`204`; tracks already added stay); a finished job
answers `409`. `kind` is one of `download`, `import`, `rescan`, `backup`, `restore`. The mock advances every job by
one step every `MOCK_JOB_TICK_MS` (default 700 ms).

### Tracks

`GET /v1/admin/tracks?q=night&offset=0&limit=50` returns a `Page<AdminTrack>`, newest added first; `q` matches
title, artist and album case- and diacritic-insensitively; `lyrics=missing|present` filters on stored lyrics.

```json
{
  "items": [
    {
      "id": "tr-uploads-01",
      "title": "Paper Moons",
      "artists": [{ "id": "ar-nova-static", "name": "Nova Static" }],
      "album": { "id": "al-uploads", "title": "Uploads" },
      "duration": 1,
      "artwork": [{ "url": "https://music.example.com/art/album/al-uploads.svg?s=300", "width": 300, "height": 300 }],
      "explicit": false,
      "trackNumber": 1,
      "discNumber": 1,
      "liked": false,
      "addedAt": "2026-11-06T10:05:00.000Z",
      "playCount": 0,
      "sizeBytes": 4010,
      "format": "mp3",
      "lyrics": null
    }
  ],
  "offset": 0, "limit": 50, "total": 1
}
```

`DELETE /v1/admin/tracks/:id` removes the track from the library, its album (which disappears when empty), its
artist (when nothing is left), every playlist, every user's likes and history, and search. The signed media URL
then answers `404`.

### Uploads

`POST /v1/admin/uploads` with `multipart/form-data` and a single audio file in the field `file` (mp3, aac, m4a,
flac, ogg, opus or wav). The response is the new `AdminTrack` (`201`).

- Title and artist come from the filename `Artist - Title.ext`; otherwise the artist is `Unknown Artist` and the
  whole name is the title.
- The server checks extension **and** magic bytes (`ID3` / MPEG frame sync, `fLaC`, `OggS`, `RIFF....WAVE`,
  `ftyp`) and answers `415` when either is wrong, `400` for a missing field or an empty file.
- `413` when the file exceeds `capabilities.uploadMaxBytes` (the mock reads the body as a stream and stops
  buffering at the limit; `MOCK_UPLOAD_MAX`, default 200 MiB). The mock also caps the total upload storage
  (`MOCK_UPLOAD_STORE_MAX`, default 512 MiB).
- The file is served by `GET /v1/tracks/:id/stream` with its real MIME type (`audio/mpeg`, `audio/flac`, ...) and full
  Range support.

### Lyrics library (admin)

Admins can attach a lyrics file to any track. **TTML** is preferred because it carries word-level timing; plain
**LRC** is also accepted.

`PUT /v1/admin/tracks/:id/lyrics`:

```json
{ "format": "ttml", "content": "<?xml version=\"1.0\"?><tt xmlns=\"http://www.w3.org/ns/ttml\" ...>...</tt>" }
```

Validation (`400 {message}`), at most 1 MiB of UTF-8:

- TTML must be well formed XML with a `<tt>` root (any prefix) and at least one `<p>` with a `begin` time;
  `<!DOCTYPE` and `<!ENTITY` declarations and custom entity references are rejected (XXE / billion laughs).
  The mock checks this with a small hand-written scanner, no XML library.
- LRC must contain at least one `[mm:ss.xx]` timestamp.
- Unknown track: `404`. `DELETE` is idempotent and answers `204`.

`GET /v1/tracks/:id/lyrics` then returns the stored document: TTML in `ttml` (with `plain` extracted from the
paragraphs and `synced: null`), LRC in `synced` (`ttml: null`). `AdminTrack.lyrics` is `"ttml"`, `"lrc"` or
`null`. About ten demo tracks ship with an Apple-Music-style TTML aligned to the generated audio: word timing
(`itunes:timing="Word"`), two `ttm:agent` voices alternating on verses (a duet) and `ttm:role="x-bg"` background
vocals.

Clients render lyrics as text only and never as HTML.

### Users

```json
{
  "id": "u-guest",
  "username": "guest",
  "displayName": "Guest",
  "avatar": [{ "url": "https://music.example.com/art/user/u-guest.svg?s=300", "width": 300, "height": 300 }],
  "role": "user",
  "createdAt": "2026-11-06T09:00:00.000Z",
  "lastLoginAt": null,
  "disabled": false
}
```

- `POST` takes `{ username, displayName?, password, role }`. `username` must match `^[a-z0-9_.-]{3,32}$` and the
  password needs at least 10 characters, otherwise `400`. A taken username is `409`.
- `PATCH` takes any of `displayName`, `password`, `role`, `disabled` (unknown fields are `400`).
  **Changing a password revokes all of that user's sessions** (access and refresh tokens). Disabling a user
  does too; disabled users cannot log in (`403`) or refresh (`401`).
- `DELETE` revokes sessions and removes the user and their library state. `409` when it would remove the last enabled
  admin or when an admin deletes themself; the same `409` protects demoting or disabling the last enabled admin.

### Backups

`GET /v1/admin/backups` lists `Backup` objects, newest first (the mock starts with two):

```json
{ "backups": [ { "id": "bk-0002", "createdAt": "2026-11-05T10:00:00.000Z", "sizeBytes": 187422, "label": "database+playlists" } ] }
```

`POST /v1/admin/backups` starts a `backup` job; when it reaches `done` the new backup is listed. In the mock a backup
snapshots the catalog (tracks, albums, artists, playlists, uploaded audio, stored lyrics, play counts) and every
user's likes and history; accounts and passwords are not part of it. At most 10 backups are kept.

`POST /v1/admin/backups/:id/restore` requires `{ "confirm": true }` (`400` otherwise, `404` for an unknown id,
`409` if a restore is already running) and returns `202` with a `restore` job. The data is replaced when the job
reaches its restore step; cancelling the job before that leaves everything untouched.

## Capabilities

`GET /v1/info` may include `capabilities`; absent keys are treated as unsupported.

| Flag | If true the server implements | If false/absent the app |
| --- | --- | --- |
| `lyrics` | `GET /v1/tracks/:id/lyrics` | uses LRCLIB only (the server is never asked unless this is exactly `true`) |
| `likes` | `PUT`/`DELETE /v1/library/tracks/:id`, `liked` on tracks, `GET /v1/library/tracks` | informational: a server without likes should still answer these routes, so advertise it truthfully |
| `admin` | the whole [Admin API](#admin-api) and `User.role` | the Admin section is hidden |
| `sources` | `GET /v1/admin/sources/search` and downloads for the listed sources (`spotify`, `youtube`) | no source search / download UI |
| `uploadMaxBytes` | `POST /v1/admin/uploads`; the value is the maximum file size in bytes | the upload area is hidden |
| `scrobble` | `POST /v1/tracks/:id/played` | stops sending play reports only when explicitly `false`; when absent the app still sends them, and ignores failures, so answer `204` or `404` |

`name` and `version` are free-form display strings. `apiVersion` must be the number
`1`; a different value makes the app refuse the server.

## Security checklist

- [ ] Serve over **HTTPS only** in production (terminate TLS at a reverse proxy if
  needed) and set `Strict-Transport-Security`. Plain HTTP is for local development.
- [ ] **Rate limit login** (per IP and per username) and return `429` with
  `Retry-After`. Consider exponential back-off or lockouts for repeated failures.
- [ ] Hash stored passwords with a slow algorithm (argon2id, scrypt or bcrypt) and
  compare in constant time. Return the same error for unknown users and wrong
  passwords.
- [ ] **Rotate refresh tokens** on every use, detect reuse and revoke the token
  family, store only hashes of refresh tokens, and expire them.
- [ ] Access tokens are short-lived (minutes) and revocable on logout.
- [ ] **Never expose filesystem paths** (in ids, URLs, errors or stack traces).
  Return generic 500 messages and log details server-side.
- [ ] **Signed URLs expire** quickly and are verified with a constant-time compare
  using a server-side secret. Rotate that secret periodically (invalidating
  outstanding URLs is harmless because clients re-request them).
- [ ] **No unauthenticated mutating endpoints.** The only unauthenticated
  endpoints are `info`, `login`, `refresh`, `logout` (which require a valid
  credential in the body), signed media and artwork `GET`s, and CORS preflights.
- [ ] CORS uses an explicit origin allowlist, never a blanket `*` for authenticated
  routes.
- [ ] Limit request bodies (the reference server caps JSON at 64 KB) and validate
  every parameter (`offset`, `limit`, `types`, ids).
- [ ] Send `X-Content-Type-Options: nosniff` and `Cache-Control: no-store` on
  authenticated JSON; never log `Authorization` headers, tokens or signed query
  strings.
- [ ] Authorize per user: a user may only read and modify their own library, likes
  and play history.
- [ ] **Admin routes check the role on every request**, refuse to remove the last enabled admin, revoke a
  user's sessions when their password changes or they are disabled, validate uploads by extension **and** magic
  bytes with a size limit enforced while streaming, and reject XML with DOCTYPE / ENTITY declarations.
- [ ] Hosted web build: same origin, HttpOnly + `SameSite=Strict` refresh cookie scoped to `/v1/auth`, `Origin`
  check on cookie-mode requests, the CSP from [Hosted web deployment](#hosted-web-deployment), and no
  `Access-Control-Allow-Credentials`.
