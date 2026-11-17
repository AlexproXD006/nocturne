# Nocturne mock server

A zero-dependency development backend that implements the complete
[Nocturne Server API v1](../docs/API.md) with a deterministic, fictional demo
catalog (8 artists, 14 albums, 110 tracks, 6 playlists). Audio is generated
procedurally, so nothing is downloaded and no real recordings are involved.

Requires Node 22+. It uses only Node built-ins.

## Run

```sh
npm run mock            # same as: node mock-server/server.mjs
PORT=4599 npm run mock  # another port
```

Then point the app at `http://127.0.0.1:4533` (plain http is accepted by the
app for localhost and LAN addresses).

**Demo credentials:** `demo` / `demo` (admin) and `guest` / `guestguest` (regular user).

### Hosted web build (static hosting)

To try the hosted web build against the mock without any other tool, build it and let the mock serve it:

```sh
npm run build:hosted
MOCK_STATIC_DIR=dist-hosted node mock-server/server.mjs   # open http://127.0.0.1:4533/
```

The page, `/v1`, `/media` and `/art` then share one origin, so the cookie session mode works. Files are served
from the directory with correct MIME types, `index.html` as fallback for client-side routes (not for `/v1`,
`/media`, `/art`, and not for missing `*.js`/`*.png`-style assets), traversal and symlink escapes blocked (`403`),
and HTML responses carry the CSP, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer` described in
[docs/API.md](../docs/API.md#hosted-web-deployment). The `Secure` flag of the refresh cookie is omitted only for
plain http on `localhost` / `127.0.0.1`, so local testing works; anywhere else it is always set (use
`MOCK_PUBLIC_URL=https://...` behind a TLS proxy).

Each request is logged on one line (`GET /v1/home 200 3ms`). Query strings are
never logged because stream URLs carry signatures.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4533` | TCP port (`0` picks a free one). |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` to test from a phone on your LAN. |
| `MOCK_USERS` | `demo:demo:admin,guest:guestguest:user` | Comma separated `username:password[:role]` entries; role is `admin` or `user` (default `user`). A password may contain `:`; only a final `:admin` / `:user` is read as the role. |
| `MOCK_UPLOAD_MAX` | `209715200` | Maximum size of one admin upload in bytes (advertised as `capabilities.uploadMaxBytes`; larger files get `413`). |
| `MOCK_UPLOAD_STORE_MAX` | `536870912` | Maximum total bytes of uploaded audio held in memory (`413` beyond it). |
| `MOCK_JOB_TICK_MS` | `700` | Interval at which background admin jobs advance one step (`0` = manual, tests only). |
| `MOCK_SPOTIFY_CONFIGURED` | `1` | `0` simulates a server without Spotify app credentials (`GET /v1/spotify/status` → `configured: false`). |
| `MOCK_SPOTIFY_TOKEN_DAYS` | `180` | Lifetime of a fake Spotify connection in days. Set to e.g. `5` to see the "expires soon / reconnect" UI. |
| `MOCK_STATIC_DIR` | (unset) | Serve this directory at `/` (see above). |
| `MOCK_ACCESS_TTL` | `900` | Access token lifetime in seconds. Set to `10` to exercise 401 + refresh quickly. |
| `MOCK_REFRESH_TTL` | `2592000` | Refresh token lifetime in seconds (30 days). |
| `MOCK_STREAM_TTL` | `300` | Lifetime of pre-signed `/media` URLs in seconds. Set to `5` to exercise the "re-request on media error" path. |
| `MOCK_LOGIN_LIMIT` | `10` | Login attempts allowed per IP per minute before `429` (`0` disables). |
| `MOCK_CORS_ORIGINS` | (empty) | Extra allowed origins, comma separated. Use `*` to allow any origin. |
| `MOCK_PUBLIC_URL` | (derived from `Host`) | Origin used in artwork and stream URLs, e.g. when behind a reverse proxy. |
| `MOCK_TRUST_PROXY` | `0` | `1` honours `X-Forwarded-For` / `X-Forwarded-Proto`. |
| `MOCK_QUIET` | `0` | `1` disables request logging. |
| `MOCK_REALISTIC` | `0` | `1` adds a "realistic" overlay (`realistic.mjs`): real-world-shaped long titles (`Bad Bunny - Un Verano Sin Ti (360° Visualizer) \| Un Verano Sin Ti`), `ft.` credits, 7-artist tracks, an unbreakable word and a 20-track playlist, surfaced first on Home / Library / search. For UI and screenshot work (`npm run shots`). |
| `MOCK_UPDATE_VERSION` | (unset) | When set, `GET /v1/updates/{platform}` answers `{version, url, notes}` with this version (otherwise `404`), so the update banner and the Settings > Updates section can be exercised. |

Default allowed CORS origins: `app://nocturne`, `https://localhost`,
`http://localhost`, `capacitor://localhost`, `http://localhost:5173`,
`http://127.0.0.1:5173`.

## What it implements

Everything in `docs/API.md`: `/v1/info`, login / refresh (rotating, with reuse
detection) / logout, `/v1/me`, `/v1/home`, `/v1/search`, the five
`/v1/library/*` lists, album / artist / playlist details, liking tracks,
pre-signed stream URLs, `/media/:id` with full HTTP Range support, synced
lyrics, play reports and generated SVG artwork under `/art`.

Plus the admin side (docs/HOSTED_AND_ADMIN.md): roles, the cookie session mode
(`X-Nocturne-Session: cookie`), the whole `/v1/admin/*` API (stats, invented Spotify/YouTube search, downloads and
playlist imports as timed jobs, rescan, track management, multipart uploads, TTML/LRC lyrics library, user
management, backups and restore) and optional static hosting. Everything "downloaded" is generated locally and the
mock never contacts the network. A download or import link containing `fail` produces a failed job, handy for UI work.

Spotify import (`capabilities.spotifyImport`, `spotify.mjs`): `/v1/spotify/status`, `authorize` (returns a link to
`/v1/spotify/mock-login?state=…`, a page that marks the user as connected and says "go back to Nocturne"), `DELETE
/v1/spotify/connection`, a fixed list of fake Spotify playlists (any other 16–40 character id or `open.spotify.com/playlist/…`
link is accepted and invented; ids starting with `missing` give `404`), and `/v1/spotify/imports` that advance one step per
job tick (queued → reading → matching → downloading → done), create a real user playlist and fill it with catalog
tracks; about 12 % of songs are never found. `409` until connected, or for a second active import of the same playlist.

State (liked tracks, play history, tokens, the admin-edited library, uploads, backups) lives in memory and resets on restart.
About 14 % of tracks are instrumental (no lyrics) and about 8 % only have plain
lyrics, so the app's fallbacks can be exercised.

## Using it from tests

```js
import { createMockServer } from './mock-server/server.mjs'

const mock = createMockServer({ quiet: true, loginLimit: { max: 0, windowMs: 60_000 } })
const { url } = await mock.listen(0) // ephemeral port
// ... fetch(`${url}/v1/info`) ...
await mock.close()
```

Options (all optional; they take precedence over the environment variables):
`host`, `port`, `users` (`[{username, password, role?}]`), `accessTtl`, `refreshTtl`,
`streamTtl` (seconds), `loginLimit` (`{max, windowMs}`, `max: 0` disables),
`corsOrigins` (replaces the default list), `quiet`, `log(line)`, `publicUrl`,
`trustProxy`, `audioCacheSize`, `uploadMaxBytes`, `uploadStoreMaxBytes`, `jobTickMs`, `realistic`, `updateVersion`,
`spotifyConfigured`, `spotifyTokenDays`
(`jobTickMs: 0` disables the timers; drive jobs with `mock.advanceJobs(n)` and Spotify imports with `mock.advanceSpotify(n)`), `staticDir`, and `now()` (an injectable clock in epoch ms, so
tests can expire tokens and stream URLs without sleeping).

The returned object has `server` (the `http.Server`), `listen(port?, host?)`,
`close()` (also stops the job timers), `catalog` (this server's own library: a copy of the demo data that admin
operations modify), `users`, `jobs`, `advanceJobs(n)` and a `url` getter that is set once listening.

## Files

- `server.mjs` router, CORS, cookie sessions, Range handling, CLI entry point
- `admin.mjs` the `/v1/admin/*` handlers, jobs, backups
- `jobs.mjs` timer-driven job engine
- `spotify.mjs` fake Spotify connection, playlists and timed imports
- `library.mjs` the mutable per-server library (add / remove tracks, snapshots)
- `sources.mjs` invented Spotify/YouTube results and link parsing
- `multipart.mjs`, `audiofile.mjs` streaming upload parser, audio validation
- `ttml.mjs` TTML generation and lyrics validation
- `static.mjs` static hosting for the hosted build
- `http.mjs`, `userjson.mjs` shared response helpers
- `auth.mjs` users and roles, token rotation / reuse detection, login rate limiter
- `catalog.mjs` demo data and the JSON serializers (shapes from `types.ts`)
- `audio.mjs` WAV synthesis and the LRU cache
- `lyrics.mjs` invented lyrics aligned to the audio phrases
- `art.mjs` SVG cover art
- `util.mjs` hashing, seeded PRNG, text helpers
