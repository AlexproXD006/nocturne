# Deploying the hosted web app

Nocturne ships as three targets from one renderer: desktop (Electron), Android (Capacitor) and a **hosted web app**
served by your own server. This guide covers the hosted build and the server side around it. For the design see
[HOSTED_AND_ADMIN.md](HOSTED_AND_ADMIN.md); for the API contract see [API.md](API.md); for the threat model see
[SECURITY.md](SECURITY.md).

```
Browser / Desktop / Android
        │  https://music.example.com
        ▼
 OpenResty / Nginx Proxy Manager      single origin, TLS, HSTS, Range, upload limits
        │  /api, /docs, /openapi.json  → 404 at the edge
        ▼
 NOVA app (FastAPI, loopback only)
   ├─ /            hosted Nocturne build (static, SPA fallback)
   ├─ /v1          Nocturne API (+ cookie sessions for the web app)
   ├─ /v1/admin    Admin API (role admin only)
   └─ internal NOVA modules: DB, music files, Spotify/YouTube downloader, analysis
```

NOVA no longer has a public UI or a public `/api`. It is the internal engine; Nocturne is the only front end.
[SERVER_PROMPT.md](../SERVER_PROMPT.md) is the brief that makes an AI coding agent set all of this up on the server.
The rest of this page is what you need to operate it afterwards.

## 1. Build the web app

Requirements: Node.js 22 or newer.

```bash
npm ci
npm run build:hosted        # writes dist-hosted/
```

`dist-hosted/` contains `index.html`, `assets/` (content-hashed files) and the icon. The build always talks to
`location.origin`: there is no server field on its login screen, so the same files work on any domain.

Test it locally before copying it anywhere:

```bash
npm run mock                                    # terminal 1
MOCK_STATIC_DIR=dist-hosted npm run mock        # or: serve the hosted build from the mock itself
```

Then open `http://127.0.0.1:4533/` and sign in with `demo` / `demo` (an admin in the mock, so the Admin section is visible).

## 2. Copy it to the server

Use a release directory per build so you can roll back by switching a symlink:

```bash
# on your PC
rsync -a --delete dist-hosted/ user@server:/tmp/nocturne-web/

# on the server (as the user that owns the web directory)
ts=$(date +%Y%m%d-%H%M%S)
sudo mkdir -p /opt/nocturne/web-releases
sudo mv /tmp/nocturne-web /opt/nocturne/web-releases/$ts
sudo ln -sfn /opt/nocturne/web-releases/$ts /opt/nocturne/web.new
sudo mv -T /opt/nocturne/web.new /opt/nocturne/web          # atomic switch
```

The server setting `NOCTURNE_WEB_DIR=/opt/nocturne/web` points at the symlink. The server resolves it on every
request, so **no restart is needed** after switching.

### Updating later

Repeat the three steps above with the new `dist-hosted/`. Users get the new version on their next page load:
`index.html` is `no-cache` and the hashed files under `/assets/` are immutable, so there is never a stale mix.

### Rolling back

```bash
ls /opt/nocturne/web-releases                       # pick the previous release
sudo ln -sfn /opt/nocturne/web-releases/<previous> /opt/nocturne/web.new
sudo mv -T /opt/nocturne/web.new /opt/nocturne/web
```

Keep the last three releases and delete older ones by hand.

If you prefer, the agent can build on the server instead (Node 22 and the sources must be there):
`npm ci && npm run build:hosted`, then install the output as a release as above.

## 3. Server configuration

The app is configured by environment variables, normally in a `0600` env file referenced by systemd
`EnvironmentFile=` or docker compose `env_file:`.

| Variable | Purpose |
| --- | --- |
| `NOCTURNE_PUBLIC_URL` | `https://music.example.com`. Base of artwork and stream URLs, source of truth for the cookie `Secure` flag and the CSRF origin check |
| `NOCTURNE_JWT_SECRET`, `NOCTURNE_MEDIA_SECRET` | Two different random secrets, 32 bytes or more |
| `NOCTURNE_WEB_DIR` | Hosted build directory or symlink (default `/opt/nocturne/web`) |
| `NOCTURNE_CORS_ORIGINS` | Native app origins; default `app://nocturne,https://localhost,capacitor://localhost,http://localhost:5173` (drop the last one in production) |
| `NOCTURNE_TRUSTED_PROXIES` | Proxy IPs allowed to set `X-Forwarded-For`; run uvicorn with `--proxy-headers --forwarded-allow-ips=<ip>` |
| `NOCTURNE_UPLOAD_MAX_MB` | Upload cap (default 200). Advertised as `capabilities.uploadMaxBytes`; the proxy limit must be at least this |
| `NOCTURNE_DB_PATH`, `NOCTURNE_DATA_DIR` | SQLite file for accounts, sessions and jobs; art cache directory |
| `NOCTURNE_MAX_JOBS` | Concurrent download jobs (default 2) |
| `NOCTURNE_HSTS` | `1` (default) or `0` when the proxy already sends HSTS |
| `NOVA_LEGACY_API` | `off` (default). `internal` mounts the old `/api` on a loopback-only port for operators |

## 4. Create the first admin

There is no default account. Either set `NOCTURNE_ADMIN_USER` / `NOCTURNE_ADMIN_PASS` for the first start
(used only while no account exists), or create one with the CLI (run from the server root):

```bash
# host
python -m nocturne_api.cli create-admin admin '<password>'
# docker compose (this repository's docker-compose.yml)
docker compose exec nocturne python -m nocturne_api.cli create-admin admin '<password>'
```

Other useful commands: `reset-password USER`, `set-role USER admin|user`, `disable-user USER`, `list-users`,
`revoke-sessions USER`, `import-lyrics --dry-run`, `audit --tail 50`. Once you have an admin, create the rest of the
users from the Admin section of the web app.

## 5. Reverse proxy

Single origin, one upstream. In Nginx Proxy Manager: **Proxy Host** for `music.example.com` forwarding to the
app (scheme `http`, loopback or Docker network address), then:

- **SSL tab:** Force SSL on, HTTP/2 on, HSTS on (no subdomains, no preload).
- **Details tab:** Cache Assets **off**. Block Common Exploits may stay on.
- **Advanced tab → Custom Nginx Configuration:** paste the snippet below, replacing `UPSTREAM_HOST:UPSTREAM_PORT`
  with the same address the host forwards to.

```nginx
# Legacy NOVA API and framework docs are never public
location ^~ /api/        { return 404; }
location = /api          { return 404; }
location = /docs         { return 404; }
location ^~ /docs/       { return 404; }
location = /redoc        { return 404; }
location = /openapi.json { return 404; }

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

# Uploads from the Admin section: big bodies, streamed
location ^~ /v1/admin/uploads {
    client_max_body_size 256m;      # >= NOCTURNE_UPLOAD_MAX_MB
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

Plain OpenResty / nginx without NPM: put the same blocks in the `server { listen 443 ssl http2; … }` block, plus a
`location / { proxy_pass http://UPSTREAM_HOST:UPSTREAM_PORT; … }` with the same `proxy_set_header` lines, and a
port-80 server that does `return 301 https://$host$request_uri;`.

Optional: nginx can serve the static files itself (`root /opt/nocturne/web; try_files $uri /index.html;` for `/`, with
`/assets/` cached `public, max-age=31536000, immutable`). It is faster but then the proxy, not the app, must send the
headers below. The default is to let the app do it.

### Headers the client must see

| Header | Where | Value |
| --- | --- | --- |
| `Content-Security-Policy` | HTML responses | `default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' https://lrclib.net; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'` |
| `Strict-Transport-Security` | all (exactly one) | `max-age=31536000` |
| `X-Content-Type-Options` | all | `nosniff` |
| `Referrer-Policy` | all | `no-referrer` |
| `Permissions-Policy` | all | camera, microphone, geolocation, payment, usb disabled |
| `Cache-Control` | `/assets/*` | `public, max-age=31536000, immutable` |
| `Cache-Control` | `index.html`, SPA routes | `no-cache` |
| `Cache-Control` | `/v1/*` JSON | `no-store` |
| `Accept-Ranges`, `Content-Range` | `/v1/media/*` | passed through untouched |

Never add `Access-Control-Allow-Origin` in the proxy; the app owns CORS.

## 6. Verify

```bash
curl -s  https://music.example.com/v1/info                      # apiVersion 1, capabilities.admin true
curl -sI https://music.example.com/ | grep -i -E 'content-security|cache-control|strict-transport'
curl -s -o /dev/null -w '%{http_code}\n' https://music.example.com/api/library   # 404
curl -s -o /dev/null -w '%{http_code}\n' https://music.example.com/openapi.json  # 404
curl -sI http://music.example.com/ | head -1                    # 301 to https
```

## 7. How the apps connect

| App | Address to enter | Session |
| --- | --- | --- |
| Browser (hosted web) | open `https://music.example.com/` | HttpOnly refresh cookie, access token in memory; no server field |
| Desktop (Windows / Linux) | server `https://music.example.com` | tokens in the OS keychain |
| Android | server `https://music.example.com` | tokens in the Android Keystore |

All three use the same `/v1` API and the same accounts. Admins see the Admin section in all three (it needs
`role: admin` and `capabilities.admin`). The native apps call the server cross-origin, so CORS must still allow
`app://nocturne`, `https://localhost` and `capacitor://localhost` on `/v1` **and** `/v1/media`, `/v1/art`.

## 8. Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| Blank page or "not installed yet" (503) at `/` | `NOCTURNE_WEB_DIR` is missing or has no `index.html`. Copy a build and check the symlink |
| Page loads but login says the session expired immediately | Cookie not stored: the site must be served over HTTPS (the cookie is `Secure`) and `NOCTURNE_PUBLIC_URL` must match the address in the browser exactly |
| Login or refresh answers 403 "Cross-site request refused" | The browser's `Origin` differs from `NOCTURNE_PUBLIC_URL` (wrong scheme, `www.`, port, or a second domain pointing to the same server) |
| Everything works but you are logged out at every reload | The proxy strips `Set-Cookie`, or the path is rewritten: `/v1/auth` must reach the app unchanged |
| Desktop or Android app: network error, or audio plays but visualizers are static | CORS missing on `/v1/media` or `/v1/art` for the native origins; check `NOCTURNE_CORS_ORIGINS` and that the proxy adds no CORS headers |
| Audio does not seek / stops after a while | The proxy buffers or drops `Range`; use the `/v1/media/` location above |
| Upload fails with 413 | `client_max_body_size` in the proxy (or `NOCTURNE_UPLOAD_MAX_MB`) is smaller than the file |
| Upload fails with 415 | The file is not a supported audio type, or its content does not match its extension |
| Browser console: CSP violation | Something loads from a host the CSP does not allow; only `self` and `https://lrclib.net` (for fetch) are permitted. Do not weaken the policy, report the blocked URL |
| Two `Strict-Transport-Security` headers | Both NPM and the app send it; set `NOCTURNE_HSTS=0` |
| Admin section missing | The user is not `admin` (check `GET /v1/me`), or `/v1/info` has no `capabilities.admin` |
| An old script or bookmark using `/api/...` fails with 404 | By design: the legacy API is no longer public. Use `/v1/admin` with an admin account, or `NOVA_LEGACY_API=internal` on loopback |
| Admin Add music shows "unavailable" for a source | That source is not configured (Spotify credentials, or `yt-dlp`/`ffmpeg` missing); `capabilities.sources` lists what works |
