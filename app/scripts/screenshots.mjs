#!/usr/bin/env node
// Visual review harness: renders Nocturne's UI with the Electron that ships in node_modules
// (headless Chromium) against the mock server and saves PNGs plus an overflow report.
//
//   npm run shots -- [options]
//
// Options
//   --round <name>       output sub-folder (default r1)
//   --out <dir>          output root (default $SHOTS_OUT or <tmp>/nocturne-shots)
//   --only <regex>       only scenarios whose name matches
//   --widths 360,384     widths to render (default 360,384,412,768,1280)
//   --suite app|descargar|all   (default app)
//   --descargar <dir>    folder with descargar.html + changelog.json (default ../descargar-review)
//   --no-build           reuse the last web build in node_modules/.cache/nocturne-shots/web
//   --sheets             also render per-scenario contact sheets (all widths side by side)
//   --tag <name>         write report-<name>.json instead of report.json (partial re-runs)
//   --list               print the scenario names and exit
//
// Output: <out>/<round>/<scenario>-<width>.png, optional <out>/<round>/sheets/<scenario>.png, and
// <out>/<round>/report.json (per shot: horizontal-overflow detector result).
//
// The app is the Capacitor web bundle (vite.web.config.ts, default mode) served by the mock
// server (realistic catalog + update feed), signed in through the real login form as demo/demo.
// Phones/tablet (< 1024px) run the Android code path (a fake Capacitor bridge, safe-area insets
// emulated like an edge-to-edge status bar); 1280px runs the desktop (Electron) code path.

import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createMockServer } from '../mock-server/server.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

// ---- CLI -------------------------------------------------------------------------------------
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}
const round = opt('round', 'r1')
const outRoot = resolve(opt('out', process.env.SHOTS_OUT || join(tmpdir(), 'nocturne-shots')))
const only = opt('only', null) ? new RegExp(opt('only')) : null
const widths = opt('widths', '360,384,412,768,1280').split(',').map(Number).filter(Boolean)
const suite = opt('suite', 'app')
const descargarDir = resolve(opt('descargar', join(root, '..', '..', 'descargar-review')))
const buildDir = join(root, 'node_modules', '.cache', 'nocturne-shots', 'web')
const outDir = join(outRoot, round)

const HEIGHTS = { 360: 800, 384: 832, 412: 915, 768: 1024, 1280: 800 }
const heightFor = (w) => HEIGHTS[w] ?? Math.round(w * 2.1)
const platformFor = (w) => (w >= 1024 ? 'desktop' : 'android')
// Edge-to-edge Android (StatusBar.setOverlaysWebView(true)) + gesture navigation bar.
const insetsFor = (w) => (w < 1024 ? { top: 32, bottom: 20 } : null)
const UPDATE_VERSION = '1.1.0'

// ---- Scenarios ---------------------------------------------------------------------------------
// `setup` runs in the page (window.__h helpers, see screenshot-runner.cjs). Keep them self-contained.
const S = []
const add = (name, setup, extra = {}) => S.push({ name, setup, ...extra })

add('home', async (h) => {
  await h.waitFor('css:main section, main h2')
})
add('search-duki', async (h) => {
  await h.nav('Search')
  await h.type('css:input[aria-label="Search"]', 'duki')
  await h.waitFor(() => [...document.querySelectorAll('main h2')].find((e) => /Songs|Artists/.test(e.textContent)))
})
for (const tab of ['Playlists', 'Albums', 'Artists', 'Songs']) {
  add(`library-${tab.toLowerCase()}`, async (h) => {
    await h.nav('Library')
    const t = await h.waitFor(() => [...document.querySelectorAll('[role=tab]')].find((e) => h.visible(e) && h.norm(e.textContent).startsWith(TAB)))
    t.click()
    await h.sleep(500)
  }, { vars: { TAB: tab } })
}
add('liked', async (h) => {
  await h.nav('Library')
  const liked = await h.waitFor(() => [...document.querySelectorAll('main [role=link], main button')].find((e) => h.visible(e) && h.norm(e.textContent).startsWith('Liked Songs')))
  liked.click()
  await h.waitFor('css:[role=table][aria-label="Tracks"]')
})
add('album', async (h) => {
  await h.nav('Library')
  await h.click(() => [...document.querySelectorAll('[role=tab]')].find((e) => h.visible(e) && h.norm(e.textContent).startsWith('Albums')))
  await h.click(() => [...document.querySelectorAll('[role=link]')].find((e) => h.visible(e) && h.norm(e.textContent).startsWith('Nadie Te Va')))
  await h.waitFor('css:[role=table][aria-label="Tracks"]')
})
add('artist', async (h) => {
  await h.nav('Library')
  await h.click(() => [...document.querySelectorAll('[role=tab]')].find((e) => h.visible(e) && h.norm(e.textContent).startsWith('Artists')))
  await h.click(() => [...document.querySelectorAll('[role=link]')].find((e) => h.visible(e) && h.norm(e.textContent).startsWith('Duki')))
  await h.waitFor('css:[role=table][aria-label="Tracks"]')
})
add('playlist', async (h) => {
  await h.nav('Library')
  await h.click(() => [...document.querySelectorAll('[role=tab]')].find((e) => h.visible(e) && h.norm(e.textContent).startsWith('Playlists')))
  await h.click(() => [...document.querySelectorAll('[role=link]')].find((e) => h.visible(e) && h.norm(e.textContent).startsWith('Perreo')))
  await h.waitFor('css:[role=table][aria-label="Tracks"]')
})
add('miniplayer-nav', async (h) => {
  await h.playLongPlaylist()
  await h.nav('Home')
})
add('np-song', async (h) => {
  await h.playLongPlaylist()
  await h.openNowPlaying()
  await h.nowPlayingTab('song')
})
add('np-lyrics', async (h) => {
  await h.playLongPlaylist()
  await h.openNowPlaying()
  if (!(await h.nowPlayingTab('lyrics'))) await h.click('@Lyrics')
  await h.sleep(800)
})
add('np-queue', async (h) => {
  await h.playLongPlaylist()
  await h.openNowPlaying()
  if (!(await h.nowPlayingTab('queue'))) await h.click('@Queue')
  await h.sleep(500)
})
add('side-queue', async (h) => {
  await h.playLongPlaylist()
  const b = h.find('@Queue (Q)')
  if (b) b.click()
  await h.sleep(500)
}, { minWidth: 768 })
add('side-lyrics', async (h) => {
  await h.playLongPlaylist()
  const b = h.find('@Lyrics (L)')
  if (b) b.click()
  await h.sleep(900)
}, { minWidth: 768 })
add('lyric-select', async (h) => {
  await h.playLongPlaylist()
  await h.openNowPlaying()
  if (!(await h.nowPlayingTab('lyrics'))) await h.click('@Lyrics')
  await h.click('@Select lyrics to share as an image')
  const lines = [...document.querySelectorAll('[role=dialog] [role=button]')].filter((e) => h.visible(e)).slice(2, 4)
  for (const l of lines) {
    l.click()
    await h.sleep(150)
  }
  await h.sleep(400)
})
add('lyric-card', async (h) => {
  await h.playLongPlaylist()
  await h.openNowPlaying()
  if (!(await h.nowPlayingTab('lyrics'))) await h.click('@Lyrics')
  await h.click('@Select lyrics to share as an image')
  const lines = [...document.querySelectorAll('[role=dialog] [role=button]')].filter((e) => h.visible(e)).slice(2, 4)
  for (const l of lines) {
    l.click()
    await h.sleep(150)
  }
  await h.click('@Create image from')
  await h.sleep(1200)
})
for (const theme of ['dark', 'oled', 'adaptive']) {
  add(`settings-${theme}`, async (h) => {
    await h.playLongPlaylist()
    await h.account('Settings')
    await h.waitFor('css:[role=radiogroup][aria-label="Theme"]')
  }, { settings: { theme, accent: 'green' } })
  add(`settings-${theme}-updates`, async (h) => {
    await h.account('Settings')
    const sec = await h.waitFor(() => [...document.querySelectorAll('main h2, main h3')].find((e) => h.norm(e.textContent) === 'Updates'))
    sec.scrollIntoView({ block: 'start' })
    await h.sleep(400)
  }, { settings: { theme, accent: 'green' } })
}
add('home-oled', async (h) => {
  await h.playLongPlaylist()
  await h.nav('Home')
}, { settings: { theme: 'oled' } })
add('home-adaptive', async (h) => {
  await h.playLongPlaylist()
  await h.nav('Home')
}, { settings: { theme: 'adaptive' } })
add('np-queue-adaptive', async (h) => {
  await h.playLongPlaylist()
  await h.openNowPlaying()
  if (!(await h.nowPlayingTab('queue'))) await h.click('@Queue')
  await h.sleep(500)
}, { settings: { theme: 'adaptive' } })
add('np-queue-oled', async (h) => {
  await h.playLongPlaylist()
  await h.openNowPlaying()
  if (!(await h.nowPlayingTab('queue'))) await h.click('@Queue')
  await h.sleep(500)
}, { settings: { theme: 'oled' } })
add('admin-overview', async (h) => {
  await h.account('Admin')
  await h.waitFor(() => [...document.querySelectorAll('[role=tab]')].find((e) => h.norm(e.textContent).startsWith('Overview')))
  await h.sleep(800)
})
add('confirm-dialog', async (h) => {
  await h.account('Admin')
  await h.click(() => [...document.querySelectorAll('[role=tab]')].find((e) => h.visible(e) && h.norm(e.textContent).startsWith('Library')))
  await h.type('css:input[aria-label="Search the library"]', 'party en el barrio')
  await h.sleep(900)
  await h.click('@Delete ', 10000)
  await h.sleep(500)
})
add('toast', async (h) => {
  await h.account('Admin')
  await h.click(() => [...document.querySelectorAll('[role=tab]')].find((e) => h.visible(e) && h.norm(e.textContent).startsWith('Library')))
  // Each width deletes one more track (the mock keeps state), so search broadly.
  await h.type('css:input[aria-label="Search the library"]', 'duki')
  await h.sleep(900)
  await h.click('@Delete ', 10000)
  await h.click('Delete track')
  await h.sleep(600)
})
add('update-banner', async (h) => {
  await h.waitFor(() => [...document.querySelectorAll('button')].find((b) => h.norm(b.textContent) === 'Update now'), 10000)
}, { showUpdate: true })
add('login', async (h) => {
  await h.waitFor('css:#username')
}, { signedOut: true })

// Public download page (static copy), both channels, with the version history expanded.
const D = []
for (const channel of ['stable', 'beta']) {
  D.push({
    name: `descargar-${channel}`,
    hash: channel === 'beta' ? '#beta' : '',
    setup: async (h) => {
      await h.waitFor(() => document.querySelector('#history details'), 8000).catch(() => null)
      await h.sleep(300)
    }
  })
  D.push({
    name: `descargar-${channel}-history`,
    hash: channel === 'beta' ? '#beta' : '',
    fullPage: true,
    setup: async (h) => {
      await h.waitFor(() => document.querySelector('#history details'), 8000)
      for (const d of document.querySelectorAll('#history details')) d.open = true
      document.querySelector('#history').scrollIntoView({ block: 'start' })
      await h.sleep(300)
    }
  })
}

if (flag('list')) {
  console.log([...S, ...D].map((s) => s.name).join('\n'))
  process.exit(0)
}

// ---- Build + servers --------------------------------------------------------------------------
function build() {
  if (flag('no-build') && existsSync(join(buildDir, 'index.html'))) return
  console.log(`[shots] building web bundle -> ${buildDir}`)
  const vite = join(root, 'node_modules', 'vite', 'bin', 'vite.js')
  const r = spawnSync(process.execPath, [vite, 'build', '--config', 'vite.web.config.ts', '--outDir', buildDir, '--emptyOutDir', '--logLevel', 'warn'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, npm_package_version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version }
  })
  if (r.status !== 0) throw new Error('web build failed')
}

const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }
function staticServer(dir) {
  const server = createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    const file = resolve(dir, '.' + (p === '/' ? '/descargar.html' : p))
    if (!file.startsWith(dir) || !existsSync(file)) {
      res.writeHead(404).end('not found')
      return
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
    res.end(readFileSync(file))
  })
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${server.address().port}` })))
}

async function main() {
  mkdirSync(outDir, { recursive: true })
  const jobs = []
  const sheets = []
  const closers = []

  if (suite === 'app' || suite === 'all') {
    build()
    const mock = createMockServer({ quiet: true, realistic: true, updateVersion: UPDATE_VERSION, staticDir: buildDir, loginLimit: { max: 0, windowMs: 60_000 }, jobTickMs: 0 })
    const { url } = await mock.listen(0, '127.0.0.1')
    closers.push(() => mock.close())
    console.log(`[shots] mock + app at ${url}`)
    const appUrl = `${url}/index.html`
    const scenarios = S.filter((s) => !only || only.test(s.name))
    // Login last: it signs the shared window out.
    scenarios.sort((a, b) => Number(Boolean(a.signedOut)) - Number(Boolean(b.signedOut)))
    for (const s of scenarios) {
      const files = []
      for (const w of widths) {
        if (s.minWidth && w < s.minWidth) continue
        const file = join(outDir, `${s.name}-${w}.png`)
        files.push(file)
        let setup = s.setup.toString()
        for (const [k, v] of Object.entries(s.vars ?? {})) setup = setup.replaceAll(k, JSON.stringify(v))
        const ls = {}
        if (s.settings) ls['nocturne.settings.v1'] = s.settings
        if (!s.showUpdate) ls['nocturne.update.dismissed'] = UPDATE_VERSION
        jobs.push({
          app: true,
          name: s.name,
          file,
          url: appUrl,
          width: w,
          height: heightFor(w),
          dsf: 2,
          mobile: w < 1024,
          insets: insetsFor(w),
          platform: platformFor(w),
          settings: s.settings,
          localStorage: ls,
          clearSession: Boolean(s.signedOut),
          login: s.signedOut ? null : { server: url, username: 'demo', password: 'demo' },
          setup
        })
      }
      sheets.push({ file: join(outDir, 'sheets', `${s.name}.png`), files, height: 560, width: 1900 })
    }
  }

  if (suite === 'descargar' || suite === 'all') {
    if (!existsSync(join(descargarDir, 'descargar.html'))) throw new Error(`no descargar.html in ${descargarDir}`)
    const st = await staticServer(descargarDir)
    closers.push(() => new Promise((r) => st.server.close(r)))
    console.log(`[shots] descargar at ${st.url}/descargar.html`)
    for (const d of D.filter((s) => !only || only.test(s.name))) {
      const files = []
      for (const w of widths) {
        const file = join(outDir, `${d.name}-${w}.png`)
        files.push(file)
        jobs.push({
          app: false,
          name: d.name,
          file,
          url: `${st.url}/descargar.html${d.hash}`,
          width: w,
          height: d.fullPage ? Math.max(heightFor(w), 2200) : heightFor(w),
          dsf: 2,
          mobile: w < 1024,
          insets: null,
          platform: 'web',
          localStorage: {},
          setup: d.setup.toString()
        })
      }
      sheets.push({ file: join(outDir, 'sheets', `${d.name}.png`), files, height: 700, width: 1900 })
    }
  }

  const reportPath = join(outDir, opt('tag', null) ? `report-${opt('tag')}.json` : 'report.json')
  rmSync(reportPath, { force: true })
  mkdirSync(join(outDir, 'sheets'), { recursive: true })
  const electron = require('electron') // path to the binary
  // One Electron process per scenario (all its widths): the box this runs on can be short of
  // memory, and a crashed renderer then only costs that scenario instead of the whole run.
  const runElectron = (cfg, tag) => {
    const configPath = join(outDir, `.config-${tag}.json`)
    const partPath = join(outDir, `.report-${tag}.json`)
    rmSync(partPath, { force: true })
    writeFileSync(configPath, JSON.stringify({ round, ...cfg, reportPath: partPath }))
    const args = ['--no-sandbox', '--ozone-platform=headless', '--disable-gpu', '--disable-dev-shm-usage', join(root, 'scripts', 'screenshot-runner.cjs'), configPath]
    return new Promise((r) => {
      const child = spawn(electron, args, { cwd: root, stdio: ['ignore', 'inherit', 'pipe'] })
      // Watchdog: a hung page must not stall the whole run (90 s per shot is very generous).
      const watchdog = setTimeout(() => child.kill('SIGKILL'), 30_000 + 90_000 * Math.max(1, cfg.jobs.length + (cfg.sheets?.length ?? 0)))
      child.stderr.on('data', (d) => {
        const s = String(d)
        if (/\[shots\]/.test(s)) process.stderr.write(s)
      })
      child.on('exit', () => {
        clearTimeout(watchdog)
        // Electron sometimes dies by signal while tearing down the headless window after
        // app.exit(0); a part counts when it wrote its report.
        let part = null
        try {
          part = JSON.parse(readFileSync(partPath, 'utf8'))
          rmSync(partPath, { force: true })
          rmSync(configPath, { force: true })
        } catch {
          /* missing: crashed */
        }
        r(part)
      })
    })
  }
  console.log(`[shots] ${jobs.length} shots -> ${outDir}`)
  const groups = new Map()
  for (const j of jobs) groups.set(j.name, [...(groups.get(j.name) ?? []), j])
  const all = []
  let consoleErrors = []
  let n = 0
  for (const [name, list] of groups) {
    const part = await runElectron({ jobs: list, sheets: [] }, String(n++))
    if (part) {
      all.push(...part.jobs)
      consoleErrors = consoleErrors.concat(part.consoleErrors.map((e) => `${name}: ${e}`))
    } else {
      console.log(`[shots] ${name}: electron crashed`)
      for (const j of list) all.push({ name: j.name, file: j.file, width: j.width, ok: false, error: 'electron crashed' })
    }
  }
  if (flag('sheets') && sheets.length) await runElectron({ jobs: [], sheets }, 'sheets')
  for (const c of closers) await c()
  writeFileSync(reportPath, JSON.stringify({ round, jobs: all, consoleErrors: consoleErrors.slice(0, 300) }, null, 2))
  const bad = all.filter((j) => !j.ok)
  const over = all.filter((j) => j.overflow && (j.overflow.pageOverflow || j.overflow.offenders.length))
  console.log(`[shots] done: ${all.length} shots, ${bad.length} errors, ${over.length} with horizontal overflow. Report: ${reportPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
