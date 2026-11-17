# Security

This document describes what Nocturne protects, against whom, every measure in place, and what your
music server must do to complete the picture. To report a vulnerability, open a private security advisory on the repository.

## Threat model

**Assets**

- The user's session: access and refresh tokens for their music server.
- The user's machine: Nocturne must not become a way to run code or read files.
- The user's listening activity and library metadata.

**Adversaries and scenarios**

| # | Scenario | Main defenses |
| --- | --- | --- |
| 1 | Malicious or compromised content reaches the renderer (an artist name with HTML, a hostile server response, a poisoned image) and tries to run script | React escaping, no `dangerouslySetInnerHTML`, strict CSP, sandbox, context isolation, no Node in the renderer |
| 2 | Script in the renderer (or a frame, or a page loaded by mistake) tries to reach the main process | IPC sender URL validation, input validation, tiny bridge surface |
| 3 | The app is navigated or opens windows to attacker-controlled pages | Navigation and redirect lock, `window.open` deny, `will-attach-webview` blocked |
| 4 | Another local user or malware reads tokens from disk | `safeStorage` (OS keychain), Android Keystore, `0600` file mode, `allowBackup=false` |
| 5 | Someone tampers with the installed app files | ASAR integrity fuse, `onlyLoadAppFromAsar`, code signing when configured |
| 6 | Network attacker on café Wi-Fi | HTTPS required except for local networks, no mixed content on Android, signed short-lived media URLs |
| 7 | A leaked URL (logs, screenshots, browser history, shared links) grants access to the library | No tokens in URLs except 5-minute signed stream URLs bound to one track |
| 8 | Stolen refresh token | Rotation with reuse detection on the server (required, see below) |
| 9 | An unauthenticated or hostile website abuses the server through the user's browser | Server-side CORS allow-list, bearer tokens (not cookies) for the API |
| 10 | Debugging or Node flags abused to run arbitrary code with the app's identity | Electron fuses: `runAsNode`, `NODE_OPTIONS` and `--inspect` disabled |
| 11 | XSS in the hosted web app tries to steal the long-lived session | Refresh token only in an `HttpOnly` cookie (unreadable by script), access token only in memory, strict CSP, no `dangerouslySetInnerHTML` (see "Hosted web app") |
| 12 | A hostile website makes the user's browser call the server with the cookie (CSRF) | `SameSite=Strict`, mandatory `X-Nocturne-Session` header, server-side `Origin` check, cookie honored only by refresh/logout |
| 13 | A normal user, or a stolen non-admin token, tries to use the Admin API | Role checked on the server for every `/v1/admin/*` route, read from the database (not the token), 403 otherwise |
| 14 | Malicious upload (disguised file, path traversal, oversized body, hostile XML lyrics) | Size cap while streaming, extension allow-list plus magic-byte check, sanitised names, never overwrite, `defusedxml` for TTML |
| 15 | The old unauthenticated NOVA `/api` is reached from the internet | Removed from public exposure: unmounted from the public app and blocked at the proxy (see "Legacy API") |

**Out of scope:** a fully compromised operating system or an attacker with the user's logged-in desktop session
(they can use the app as the user), and the security of the server itself beyond the requirements listed below.

## Measures in the desktop app

### Renderer isolation (`src/main/index.ts`)

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `nodeIntegrationInWorker: false`.
- `webSecurity: true`, `allowRunningInsecureContent: false`, `experimentalFeatures: false`.
- DevTools are available only in development (`devTools: isDev`).
- The preload is a single self-contained CommonJS file so it can run sandboxed.
- Single instance lock; a second launch focuses the existing window.

### Content-Security-Policy (`src/main/security.ts`)

Applied to every HTML response of the `app://` protocol:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
font-src 'self' data:; img-src 'self' https: http: data: blob:;
media-src 'self' https: http: blob:; connect-src 'self' https: http:;
worker-src 'self' blob:; object-src 'none'; base-uri 'none';
form-action 'none'; frame-ancestors 'none'
```

Scripts only come from the bundle (no inline, no `eval`). Network origins stay open to `http(s)` only because the
user chooses their server URL at runtime; plain `http` is further restricted to local networks by the client (see below).
The development server gets a relaxed variant that applies to that origin only.

### Custom protocol instead of `file://`

The production UI is served from `app://nocturne` with a path resolver that rejects `..`, NUL bytes and foreign
hosts. This avoids `file://` privileges, gives the renderer a real origin (needed for CORS and secure-context APIs) and
keeps the Electron fuse `grantFileProtocolExtraPrivileges` off.

### Navigation and window lock

- `will-navigate` and `will-redirect` are cancelled unless the target is the app origin (or the dev server in development).
- `setWindowOpenHandler` always denies; only plain `http(s)` URLs without credentials and under 2048 characters are handed to the OS browser.
- `<webview>` attachment is blocked.

### Permissions

The permission request and check handlers deny everything except `fullscreen`, `clipboard-sanitized-write` and
`media-key-system`. Camera, microphone, geolocation, notifications, USB, HID, serial and other device permissions are denied;
the device permission handler always returns false.

### IPC

- Every handler first checks the sender frame URL with `isTrustedRendererUrl`; calls from any other frame are rejected.
- Arguments are validated in main, never trusted: secure-store keys must match `^[a-z0-9][a-z0-9._-]{0,63}$`,
  values must be strings of at most 64 KiB, `setFullscreen` accepts only `true`, `openExternal` re-validates the URL.
- The preload exposes a frozen object with named methods. `ipcRenderer` itself, and arbitrary channel names, are never exposed.

### Token storage

- **Desktop:** tokens are encrypted with Electron `safeStorage` (Windows DPAPI, macOS Keychain, Linux libsecret or kwallet) and stored in
  `secure-store.json` in the user data folder, written atomically with mode `0600`. Entries are read through own-property checks
  (no prototype tricks), and an entry that no longer decrypts is discarded. If the OS offers no encryption backend, the file falls back to
  base64 with `0600` permissions and **Settings → Security** tells the user so.
- **Android:** `@aparajita/capacitor-secure-storage`, backed by the Android Keystore. Auto-backup is disabled so tokens are never uploaded to cloud backups.
- **Hosted web:** refresh token in an `HttpOnly` cookie, access token in memory only; nothing in web storage.
- **Web (development fallback, not hosted):** `sessionStorage`, cleared when the tab closes.
- Passwords are never stored. Only the tokens issued by the server are kept.

### Electron fuses and ASAR (`electron-builder.yml`)

| Fuse | Value | Why |
| --- | --- | --- |
| `runAsNode` | off | The binary cannot be used as a generic Node.js runtime |
| `enableNodeOptionsEnvironmentVariable` | off | `NODE_OPTIONS` cannot inject code |
| `enableNodeCliInspectArguments` | off | `--inspect` cannot attach a debugger |
| `enableEmbeddedAsarIntegrityValidation` | on | The ASAR is hashed at build time and verified at load |
| `onlyLoadAppFromAsar` | on | An unpacked `app/` folder next to the binary is ignored |
| `enableCookieEncryption` | on | Cookies are encrypted at rest |
| `loadBrowserProcessSpecificV8Snapshot` | off | No alternative snapshot is loaded into the browser process |
| `grantFileProtocolExtraPrivileges` | off | `file://` pages get no extra privileges |

The package contains only `out/**`, `package.json` and the window icon: no sources, tests or source maps.
Windows binaries are signed when `WIN_CSC_LINK` is configured.

## Measures on Android

- `usesCleartextTraffic="false"` and a network security config with `cleartextTrafficPermitted="false"` for all hosts. LAN development hosts must be listed explicitly (`NOCTURNE_LAN_HOSTS`, development builds only).
- WebView mixed content blocked (`allowMixedContent: false`), remote WebView debugging off in release builds.
- `allowBackup="false"`.
- Minimal permissions: `INTERNET`, `WAKE_LOCK`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, `POST_NOTIFICATIONS`.
- The app is served from `https://localhost` inside the WebView (`androidScheme: "https"`), a secure context that is not reachable from other apps.
- Release APKs are signed with a keystore supplied through the environment; no secret is in the repository.

## Network behavior

- **HTTPS enforced except for local networks.** `normalizeServerUrl` adds `https://` when the scheme is missing, rejects any scheme other than `http` or `https`,
  rejects credentials in the address, and accepts plain `http` only for `localhost`, `127.x`, `10.x`, `192.168.x`, `172.16-31.x`, `[::1]` and `*.local`.
- **No tokens in URLs.** API calls use the `Authorization: Bearer` header. The audio element cannot send headers, so the server issues a
  **pre-signed stream URL** valid for about five minutes and bound to a single track. A leaked stream URL therefore exposes one track for a few minutes, never the account.
- Native apps send requests with `credentials: "omit"` (no ambient cookies) and `cache: "no-store"`. The hosted web app uses `credentials: "same-origin"` only for the three auth calls described above.
- Refresh tokens rotate on every use; the client replaces its stored session atomically and signs the user out when the server rejects the refresh.
- Access tokens are refreshed 30 seconds before expiry; concurrent refreshes are coalesced.
- Third parties: only LRCLIB, and only with title, artist, album and duration. No analytics, telemetry or crash reporting.
- Artwork and audio are requested with CORS (`crossOrigin = "anonymous"`) so a cross-origin resource can never taint a canvas or audio graph with data the page should not read.

## Hosted web app

The browser build (`npm run build:hosted`) is served by the server at the same origin as `/v1`.

### Cookie session threat model

- **What an attacker gets from XSS.** The refresh token lives in `nocturne_rt`, `HttpOnly; Secure; SameSite=Strict; Path=/v1/auth`,
  so injected script cannot read or exfiltrate it. The access token (15 minutes) exists only in JavaScript memory and is never written to
  `localStorage`, `sessionStorage` or IndexedDB. An XSS can act as the user while the tab is open, but it cannot take the session away,
  and closing the tab ends it. Reuse detection revokes a family if a rotated token is ever replayed.
- **CSRF.** Only `POST /v1/auth/refresh` and `/auth/logout` consult the cookie, and only when the request carries
  `X-Nocturne-Session: cookie`. Defenses stack: `SameSite=Strict` (the cookie is not sent on cross-site requests), the custom header
  (a cross-site page cannot send it without a CORS preflight, and the server never allows that header), an `Origin` check (a present
  `Origin` must equal the server's public origin, `null` is refused) and `Sec-Fetch-Site`. Every other endpoint needs the bearer token, which a
  cross-site page does not have. Worst case of a successful forged refresh would be a fresh access token that the attacker still cannot read (same-origin policy).
- **Cookie scope.** No `Domain` attribute (host-only), `Path=/v1/auth`, `Secure` always on HTTPS, `Max-Age` equal to the refresh lifetime.
  Cookie values are never logged. Native apps never send the header and keep body tokens.
- **Nothing secret in storage.** In hosted mode the client writes no tokens to web storage.

### Content-Security-Policy

```
default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:;
connect-src 'self' https://lrclib.net; style-src 'self' 'unsafe-inline';
font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
```

Scripts come only from the build (no inline script, no `eval`). The only third-party origin is LRCLIB for lyrics lookups. Also sent: `Strict-Transport-Security`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` (camera, microphone, geolocation, payment, USB off).
Hashed assets are `immutable`; `index.html` is `no-cache`. The SPA fallback never serves HTML for `/v1/*`, `/assets/*` misses or paths with a file extension.

## Admin authorization and uploads

- Every `/v1/admin/*` route sits behind one router-level dependency: valid bearer token **and** `role == admin`, otherwise 401/403. The role is read
  from the database on each request (cached for a few seconds), so demoting or disabling an account takes effect almost immediately; it is not embedded in the token.
  A test enumerates all admin routes to prove none is unprotected. The UI hides Admin for non-admins, but the server is the authority.
- The last enabled admin cannot be demoted, disabled or deleted, and nobody can delete themself (409), enforced inside a transaction.
- Admin passwords are Argon2id hashes; creating or changing a password revokes that account's sessions. Admin mutations are written to an audit log without secrets.
- **Uploads:** size cap enforced while streaming, extension allow-list (mp3, flac, m4a, aac, ogg, opus, wav), **magic bytes must match the extension**, names reduced to a sanitised
  basename, never overwritten, written to a temp file then moved inside the music root; the proxy limit matches the cap.
- **Downloads and imports:** only https URLs on the Spotify and YouTube hosts, no credentials or IP literals, subprocesses with argument lists, timeouts and a concurrency limit.
- **Deleting and restoring:** delete resolves the file from the database and refuses anything outside the music root; restore needs an explicit `confirm`, takes a pre-restore backup, and never rolls back accounts or sessions.
- **TTML lyrics:** documents are parsed with `defusedxml`; any `DOCTYPE` or `ENTITY` declaration, external entity or entity expansion is rejected (XXE and billion-laughs protection), the size is capped at 1 MiB, and the text is stored as-is and rendered by clients as text, never as HTML.

## Legacy NOVA API

NOVA's original `/api/*` had no authentication and leaked file paths. With Nocturne as the only front end it is no longer public: it is not mounted on the public app, it is blocked (404) at the proxy as
well as in the app, and `/docs`, `/redoc` and `/openapi.json` are off. NOVA's internals are called in-process by the admin service layer, so nothing needs the old routes. An optional loopback-only listener
(`NOVA_LEGACY_API=internal`) exists for operators and must never be proxied. Anything that used the old API from outside must move to `/v1/admin`.

## What the server must provide

Nocturne is only as safe as the server it signs in to. A compliant server must:

1. **Serve everything over HTTPS** with HSTS, and keep plain-HTTP listeners redirecting.
2. **Authenticate** every endpoint except `GET /v1/info`, `POST /v1/auth/login`, `POST /v1/auth/refresh`, `POST /v1/auth/logout`, the signed media URL and (if you accept the trade-off) artwork. Store passwords with Argon2id or bcrypt.
3. **Limit login attempts** (per IP and per username, with lockout and `Retry-After`) and respond identically for unknown users and wrong passwords.
4. **Issue short-lived access tokens** (about 15 minutes) and **rotating refresh tokens** stored hashed, with token-family reuse detection: presenting an already-used refresh token must revoke the whole family.
5. **Sign stream URLs** with HMAC-SHA256 over track id and expiry using a secret from the environment, 5-minute expiry, constant-time signature comparison, and serve the media with correct `Content-Type` and full HTTP `Range` support (206, 416).
6. **Send CORS headers** only for the exact origins `app://nocturne`, `https://localhost`, `capacitor://localhost` (and `http://localhost:5173` in development), expose `Content-Range`, `Accept-Ranges`, `Content-Length` and `Retry-After`, and include them on audio and artwork responses and on error responses. Never use `*` with credentials.
7. **Never expose filesystem paths** or stack traces in responses.
8. **Protect every mutating or administrative endpoint** (delete, upload, download jobs, imports, backups and restore, user management) behind authentication and an admin role. Validate every path, filename and URL the server receives to prevent traversal and SSRF.
9. **Not buffer audio** in the reverse proxy and pass `Range` headers through.
10. If it hosts the web app: serve it from the **same origin** with the CSP above, support cookie sessions exactly as in [HOSTED_AND_ADMIN.md](HOSTED_AND_ADMIN.md) (HttpOnly, Secure, SameSite=Strict, rotation, Origin check), and keep the legacy API off the public internet.

[SERVER_PROMPT.md](../SERVER_PROMPT.md) packages these requirements as an implementation brief for an AI coding agent working on an existing server.

## Known limitations

- Artwork URLs are not signed (an `<img>` cannot send a bearer token); they use unguessable ids and only expose cover images. A server may sign them if stricter privacy is needed.
- A user with access to the unlocked desktop session can use the app as that user. Encryption at rest protects against other accounts and offline disk access, not against code running as the same user.
- Unsigned Windows builds trigger SmartScreen, and sideloaded Android APKs are not covered by Play Protect verification. Sign your releases.
- On Linux without a keyring service, tokens are stored with file permissions only (see Token storage).
