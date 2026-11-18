# Nocturne

A clean, ad-free music player for your own music server. One React renderer, three targets:
an **Electron** desktop app (Windows and Linux), an **Android** app (Capacitor) and a **hosted web app**
served by your own server at the same address as its API.

No ads, no tracking, no analytics. The only third party it talks to is
[LRCLIB](https://lrclib.net) (for synced lyrics), and only with the title, artist, album
and duration of the song that is playing.

## Features

- **Sign in** to your own server (username and password, short-lived tokens, automatic refresh).
- **Home** with sections built by your server, plus a **library** of liked songs, albums, artists and playlists.
- **Search** across songs, albums, artists and playlists.
- **Queue** with drag-to-reorder, shuffle and repeat.
- **Gapless playback** with an optional **crossfade** (0 to 12 seconds).
- **Line-synced lyrics** from LRCLIB, with a fallback to lyrics served by your own server.
- **Fullscreen mode** with three audio-reactive visualizers (Aurora, Spectrum, Minimal) that follow the artwork colors.
- **Media keys and OS integration**: Windows SMTC, Linux MPRIS and an Android media notification with lock-screen controls.
- **Hosted web app**: the same UI in the browser, served from your server's own origin (`npm run build:hosted`), with the refresh token kept in an HttpOnly cookie. See [docs/DEPLOY.md](docs/DEPLOY.md).
- **Admin section** (users with the `admin` role): add music from Spotify or YouTube, upload files, import playlists, manage the library, users and backups, and watch background jobs. See [docs/HOSTED_AND_ADMIN.md](docs/HOSTED_AND_ADMIN.md).
- **TTML lyrics library**: admins can attach word-timed TTML (or LRC) lyrics to any track; they take priority over every other source.
- **Keyboard shortcuts** (see below).
- Secure by default: sandboxed renderer, strict CSP, encrypted token storage. See [docs/SECURITY.md](docs/SECURITY.md).

### Keyboard shortcuts

| Keys | Action | Keys | Action |
| --- | --- | --- | --- |
| `Space` | Play / pause | `S` | Shuffle |
| `←` / `→` | Seek 5 seconds | `R` | Cycle repeat |
| `Shift` + `←` / `→` | Previous / next track | `L` | Toggle lyrics |
| `↑` / `↓` | Volume | `Q` | Toggle queue |
| `M` | Mute | `F` | Fullscreen player |
| `Ctrl+K` or `/` | Search | `Esc` | Exit fullscreen |

## Quick start (development)

Requirements: Node.js 22 or newer.

```bash
npm install

# Terminal 1: a local demo server with a generated catalog (no real music needed)
npm run mock

# Terminal 2: the desktop app with hot reload
npm run dev
```

Sign in with:

| Field | Value |
| --- | --- |
| Server | `http://127.0.0.1:4533` |
| Username | `demo` |
| Password | `demo` |

`demo` / `demo` is an **admin** in the mock, so the Admin section is visible. Other users defined with
`MOCK_USERS` get the plain `user` role unless [mock-server/README.md](mock-server/README.md) says otherwise
(use one to check that non-admins never see Admin).

To try the **hosted web build** locally, build it and let the mock serve it on the same origin:

```bash
npm run build:hosted
MOCK_STATIC_DIR=dist-hosted npm run mock     # then open http://127.0.0.1:4533/
```

Plain `http://` is accepted only for `localhost` and private LAN addresses. Everything else must be `https://`.

Optionally pre-fill the server field of the sign-in screen at build time, see [.env.example](.env.example).

## Building

All installers are written to `release/`. First run `npm install`.

### Windows

Run on Windows (CI uses `windows-latest`):

```bash
npm run dist:win
```

Produces an NSIS installer (per-user, choose the install folder) and a portable `.exe`, for x64 and arm64.
Set `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` to sign the binaries with your code-signing certificate;
without them the build is unsigned and Windows SmartScreen will warn on first run.

### Linux

Run on Linux (needs `rpm` installed to build the `.rpm`):

```bash
npm run dist:linux
```

Produces an AppImage, a `.deb` (x64, arm64) and an `.rpm` (x64).

If the AppImage refuses to start with a sandbox error on a hardened distribution, either enable
unprivileged user namespaces or install the `.deb`/`.rpm`, which ship with a correctly set up Chromium sandbox.
Do not run the app with `--no-sandbox` unless you understand the trade-off.

### Android

Requirements: JDK 21 and the Android SDK (platform 36, build-tools). Set `ANDROID_HOME`.

The `android/` project is committed. Regenerate or refresh it at any time (this is idempotent):

```bash
npm run android:sync      # builds the web bundle, runs `cap sync`, applies scripts/patch-android.mjs
npm run android:open      # optional: open in Android Studio
```

Build an APK:

```bash
# debug-signed APK, installable right away
cd android && ./gradlew assembleDebug

# release APK (signed only when the keystore variables below are set)
npm run android:apk
```

Outputs are under `android/app/build/outputs/apk/`.

Create a release keystore once and keep it (and its passwords) somewhere safe. If you lose it you can no longer update an installed app:

```bash
keytool -genkeypair -v -keystore ~/keys/nocturne.jks -alias nocturne \
  -keyalg RSA -keysize 4096 -validity 10000
```

Then build with:

```bash
export NOCTURNE_KEYSTORE=$HOME/keys/nocturne.jks      # absolute path
export NOCTURNE_KEYSTORE_PASSWORD=...
export NOCTURNE_KEY_ALIAS=nocturne
export NOCTURNE_KEY_PASSWORD=...
npm run android:apk
```

What `scripts/patch-android.mjs` enforces on the generated project: cleartext traffic disabled
(with a network security config), `allowBackup=false`, only the permissions the player needs
(internet, wake lock, foreground media service, notifications), a runtime request for the notification
permission on Android 13+, dark theme and launcher icons generated from `icon.svg`, no code shrinking
for the WebView app, and an environment-driven signing config.

Talking to a server over plain http on your LAN (development only):

```bash
NOCTURNE_LAN_HOSTS=192.168.1.50 npm run android:sync
```

### Continuous integration

The workflows live at the monorepo root: `.github/workflows/ci.yml` runs typecheck and tests (app and server)
on every push and pull request, and `.github/workflows/apps.yml` packages Windows and Linux installers and an
Android APK. Pushing a tag such as `v1.0.0` attaches the installers and the signed APK to a GitHub Release.

| Secret | Purpose |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Release keystore, `base64 -w0 nocturne.jks` |
| `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | Keystore credentials |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | Optional Authenticode certificate |

Without the Android secrets the workflow still builds a debug-signed APK as a CI artifact (never published in a release).

## Connecting your own server

Nocturne talks to a small, documented HTTP API under `/v1`:

- **The ready-made server lives in this monorepo**: [`../server`](../server), deployable with Docker
  (see the [root README](../README.md)).
- The contract: [docs/API.md](docs/API.md).
- The reference implementation used for development: `npm run mock` (see `mock-server/`).
- Already running an existing music server such as NOVA Music Server? [SERVER_PROMPT.md](SERVER_PROMPT.md)
  contains a ready-to-paste prompt for an AI coding agent that adds the `/v1` API, real authentication and
  signed streaming to it, and locks down unauthenticated legacy routes.

Replacing the NOVA web UI with Nocturne (hosted web app at `/`, `/v1/admin`, legacy `/api` closed) is described in
[docs/DEPLOY.md](docs/DEPLOY.md) and automated by the same prompt. The design is in
[docs/HOSTED_AND_ADMIN.md](docs/HOSTED_AND_ADMIN.md).

Server requirements in short: HTTPS, CORS for the app origins (`app://nocturne`, `https://localhost`,
`capacitor://localhost`), HTTP Range support on audio, short-lived pre-signed stream URLs.

## Project structure

```
nocturne/
├── src/
│   ├── main/              Electron main process: window, app:// protocol, CSP, IPC, safeStorage
│   ├── preload/           Sandboxed preload exposing the minimal window.nocturne bridge
│   ├── shared/            IPC channel names and types shared by main, preload and renderer
│   └── renderer/          React app shared by desktop and Android
│       └── src/
│           ├── api/       Typed /v1 client, errors, wire types
│           ├── player/    Dual-deck audio engine, queue logic, audio analysis
│           ├── lyrics/    LRCLIB client, LRC parser, resolution pipeline
│           ├── platform/  Desktop / Android / web abstraction (secure storage, media controls)
│           ├── store/     Zustand stores (session, player, settings, UI, navigation, likes)
│           ├── pages/ components/ hooks/ lib/
├── mock-server/           Zero-dependency demo server implementing the /v1 API
├── tests/                 Vitest unit and integration tests
├── android/               Capacitor Android project (generated, then patched by scripts/patch-android.mjs)
├── build/                 App icons (icon.png, icon.ico), generated from the SVG logo
├── scripts/               make-icons, patch-android (+ tests), builder config validation
├── docs/                  ARCHITECTURE.md, SECURITY.md, API.md, DEPLOY.md, HOSTED_AND_ADMIN.md
├── electron-builder.yml   Desktop packaging and Electron fuses
├── capacitor.config.ts    Android shell configuration
└── .github/workflows/     CI: verify, desktop, android, release
```

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Desktop app with hot reload |
| `npm run mock` | Local demo server on `http://127.0.0.1:4533` (`demo` / `demo`) |
| `npm run build` | Production build of main, preload and renderer into `out/` |
| `npm run build:web` | Static web bundle into `dist-web/` (used by Capacitor) |
| `npm run build:hosted` | Hosted web build into `dist-hosted/` (same-origin, cookie sessions); deploy with [docs/DEPLOY.md](docs/DEPLOY.md) |
| `npm run kit` | Builds the hosted web app and packages `release/nocturne-server-kit.tar.gz`: the Claude Code kit for the server (`/migrar-nocturne`) |
| `npm run typecheck` | TypeScript checks for node and web projects |
| `npm test` | Unit and integration tests |
| `npm run test:coverage` | Tests with coverage thresholds |
| `npm run test:scripts` | Tests for the Android patch script |
| `npm run verify` | Typecheck, coverage, both builds |
| `npm run dist:win` / `dist:linux` | Build installers into `release/` |
| `npm run icons` | Regenerate `build/icon.png`, `build/icon.ico` from the SVG logo |
| `npm run validate:builder` | Validate `electron-builder.yml` against the installed schema |
| `npm run android:add` | Create the Android project (first time only) |
| `npm run android:sync` | Web build, `cap sync`, patch the Android project |
| `npm run android:open` | Open the project in Android Studio |
| `npm run android:apk` | Sync and assemble the release APK |

## Security

Context isolation, sandbox, no Node in the renderer, strict CSP on a private `app://` origin, locked
navigation and permissions, validated IPC, tokens encrypted with the OS keychain (Electron `safeStorage`)
or the Android Keystore, hardened Electron fuses with ASAR integrity, HTTPS enforced except for local
networks, and short-lived signed stream URLs so no long-lived token ever appears in a URL. The hosted web app keeps its refresh
token in an HttpOnly, SameSite=Strict cookie that script cannot read, behind a strict CSP; the Admin API is role-checked on the server.
Details, threat model and server-side requirements: [docs/SECURITY.md](docs/SECURITY.md).

## Tech stack

| Area | Technology |
| --- | --- |
| Desktop shell | Electron 45, electron-builder 26, electron-vite 6 |
| Android shell | Capacitor 8 (`@capacitor/android`, `app`, `status-bar`), `@aparajita/capacitor-secure-storage` |
| UI | React 19, Tailwind CSS 4, lucide-react, Inter (variable) |
| State | Zustand 5 |
| Build | Vite 8, TypeScript 5.9 |
| Tests | Vitest 5, Testing Library, jsdom, V8 coverage |
| Runtime | Node.js 22+ for tooling |

## License

[MIT](LICENSE) © 2026 Alex
