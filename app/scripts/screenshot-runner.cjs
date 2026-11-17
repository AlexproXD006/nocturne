// Electron main script for the screenshot harness (driven by scripts/screenshots.mjs).
//
// Usage (normally via `npm run shots`):
//   electron --no-sandbox --ozone-platform=headless --disable-gpu scripts/screenshot-runner.cjs <config.json>
//
// The config lists jobs ({ name, url, width, height, dsf, mobile, insets, platform, settings,
// localStorage, clearSession, login, setup }). For each job the runner sets the viewport with the
// DevTools protocol (Emulation.setDeviceMetricsOverride, so sizes are exact even on a headless
// ozone window), loads the page, signs in through the real login form when needed, runs the job's
// `setup` source in the page (helpers on window.__h), waits for the network and images to settle,
// runs a horizontal-overflow detector and saves a PNG. Results go to <outDir>/report.json.
'use strict'

const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.commandLine.appendSwitch('mute-audio')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')

const configPath = process.argv[process.argv.length - 1]
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))

// ---- Code injected into every page before its own scripts ----------------------------------

const HELPERS = String.raw`
(() => {
  try { performance.setResourceTimingBufferSize(100000) } catch {}
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const visible = (el) => {
    if (!el || !el.isConnected) return false
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return false
    const cs = getComputedStyle(el)
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.01
  }
  const CLICKABLE = 'button, a, [role=tab], [role=link], [role=button], [role=menuitem], [role=radio], [role=option], summary, label'
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
  function find(target, scope = document) {
    if (typeof target !== 'string') return target
    if (target.startsWith('@')) {
      const label = target.slice(1)
      const exact = [...scope.querySelectorAll('[aria-label]')].filter((e) => e.getAttribute('aria-label') === label && visible(e))
      if (exact.length) return exact[0]
      return [...scope.querySelectorAll('[aria-label]')].find((e) => e.getAttribute('aria-label').startsWith(label) && visible(e)) || null
    }
    if (target.startsWith('css:')) return [...scope.querySelectorAll(target.slice(4))].find(visible) || null
    const all = [...scope.querySelectorAll(CLICKABLE)].filter(visible)
    return all.find((e) => norm(e.textContent) === target) || all.find((e) => norm(e.textContent).startsWith(target)) || null
  }
  async function waitFor(target, timeout = 10000) {
    const t0 = performance.now()
    while (performance.now() - t0 < timeout) {
      const el = typeof target === 'function' ? target() : find(target)
      if (el) return el
      await sleep(100)
    }
    throw new Error('waitFor timed out: ' + String(target))
  }
  async function click(target, timeout) {
    const el = await waitFor(target, timeout)
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    el.click()
    await sleep(250)
    return el
  }
  async function type(target, text) {
    const el = await waitFor(target)
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(100)
  }
  async function idle(maxMs = 8000) {
    let last = -1, stable = 0
    const t0 = performance.now()
    while (performance.now() - t0 < maxMs) {
      const n = performance.getEntriesByType('resource').length
      const imgs = [...document.images].every((i) => i.complete)
      if (n === last && imgs) { if (++stable >= 4) break } else stable = 0
      last = n
      await sleep(150)
    }
  }
  /** Main nav: bottom tabs on phones, sidebar on md+. */
  async function nav(label) {
    const btn = await waitFor(() => [...document.querySelectorAll('[aria-label="Main navigation"] button')].find((b) => visible(b) && norm(b.textContent).includes(label)))
    btn.click()
    await sleep(300)
  }
  async function account(item) {
    await click('@Account')
    await click(() => [...document.querySelectorAll('[role=menuitem]')].find((e) => visible(e) && norm(e.textContent) === item))
  }
  /** Plays the realistic long-title playlist (Library > Playlists > first card > Play). */
  async function playLongPlaylist() {
    await nav('Library')
    await click(() => [...document.querySelectorAll('[role=tab]')].find((e) => visible(e) && norm(e.textContent).startsWith('Playlists')))
    await click(() => [...document.querySelectorAll('[role=link]')].find((e) => visible(e) && norm(e.textContent).startsWith('Perreo')))
    await click('@Play')
    await waitFor(() => document.querySelector('[aria-label="Open now playing"], div[role=button].relative'))
    await sleep(400)
  }
  async function openNowPlaying() {
    const desk = find('@Fullscreen (F)')
    if (desk && !desk.disabled) desk.click()
    else (await waitFor(() => [...document.querySelectorAll('div[role=button]')].find(visible))).click()
    await waitFor(() => document.querySelector('[role=dialog][aria-label="Now playing"]'))
    await sleep(500)
  }
  async function nowPlayingTab(name) {
    const dlg = document.querySelector('[role=dialog][aria-label="Now playing"]')
    const btn = [...dlg.querySelectorAll('nav[aria-label="Now playing views"] button')].find((b) => visible(b) && norm(b.textContent).toLowerCase() === name.toLowerCase())
    if (btn) { btn.click(); await sleep(400); return true }
    return false
  }
  window.__h = { sleep, visible, find, waitFor, click, type, idle, nav, account, playLongPlaylist, openNowPlaying, nowPlayingTab, norm }
})()
`

// Fake Capacitor Android bridge: makes the renderer take its real Android code path
// (platform.kind === 'android': secure storage plugin, Media3 plugin, update feed 'android-beta').
const ANDROID = String.raw`
(() => {
  const key = (k) => 'fakecap.' + k
  const p = (names) => names.map((name) => ({ name, rtype: 'promise' }))
  const cb = (names) => names.map((name) => ({ name, rtype: 'callback' }))
  let n = 0
  window.androidBridge = { postMessage() {} }
  window.Capacitor = {
    PluginHeaders: [
      { name: 'SecureStorage', methods: p(['setSynchronizeKeychain', 'internalGetItem', 'internalSetItem', 'internalRemoveItem', 'internalClearItemsWithPrefix', 'internalGetPrefixedKeys']) },
      { name: 'NocturneMedia', methods: [...p(['update', 'clear', 'removeListener', 'removeAllListeners']), ...cb(['addListener'])] },
      { name: 'StatusBar', methods: p(['setStyle', 'setOverlaysWebView', 'setBackgroundColor', 'show', 'hide', 'getInfo']) },
      { name: 'App', methods: [...p(['minimizeApp', 'exitApp', 'getInfo', 'getState', 'removeListener', 'removeAllListeners']), ...cb(['addListener'])] }
    ],
    nativePromise(plugin, method, options = {}) {
      if (plugin === 'SecureStorage') {
        if (method === 'internalGetItem') return Promise.resolve({ data: sessionStorage.getItem(key(options.prefixedKey)) })
        if (method === 'internalSetItem') { sessionStorage.setItem(key(options.prefixedKey), options.data); return Promise.resolve({}) }
        if (method === 'internalRemoveItem') { sessionStorage.removeItem(key(options.prefixedKey)); return Promise.resolve({ success: true }) }
        if (method === 'internalGetPrefixedKeys') return Promise.resolve({ keys: [] })
      }
      return Promise.resolve({})
    },
    nativeCallback() { return String(++n) },
    // Read synchronously by the renderer's platform detection before @capacitor/core loads.
    isNativePlatform: () => true,
    getPlatform: () => 'android'
  }
})()
`

// Fake Electron preload bridge (platform.kind === 'desktop': custom title bar, update feed 'desktop').
const DESKTOP = String.raw`
(() => {
  const k = (key) => 'nocturne.secure.' + key
  window.nocturne = {
    secure: {
      get: async (key) => sessionStorage.getItem(k(key)),
      set: async (key, v) => sessionStorage.setItem(k(key), v),
      delete: async (key) => sessionStorage.removeItem(k(key))
    },
    window: {
      minimize: async () => {}, toggleMaximize: async () => {}, close: async () => {}, setFullscreen: async () => {},
      onState: (fn) => { fn({ maximized: true, fullscreen: false, focused: true }); return () => {} }
    },
    app: { info: async () => ({ version: '0.0.0', platform: 'linux', secureStorage: true }), openExternal: async () => {} }
  }
})()
`

// Overflow detector: reports root offenders (elements whose right edge passes the viewport
// while their parent's does not), ignoring content inside horizontal scrollers (carousels).
const OVERFLOW = String.raw`
(() => {
  // The emulated device width. On mobile emulation Chrome widens the layout viewport (innerWidth)
  // to fit overflowing content, so innerWidth alone would hide exactly the bugs we look for.
  const W = __WIDTH__
  const de = document.documentElement
  const label = (e) => {
    let s = e.tagName.toLowerCase()
    if (e.id) s += '#' + e.id
    const al = e.getAttribute('aria-label')
    if (al) s += '[aria-label="' + al.slice(0, 40) + '"]'
    else if (e.classList.length) s += '.' + [...e.classList].slice(0, 4).join('.')
    return s
  }
  const pathOf = (e) => { const parts = []; for (let x = e; x && x.nodeType === 1 && x !== document.body && parts.length < 6; x = x.parentElement) parts.unshift(label(x)); return parts.join(' > ') }
  const inScroller = (e) => {
    for (let x = e.parentElement; x && x !== document.body; x = x.parentElement) {
      const ox = getComputedStyle(x).overflowX
      if ((ox === 'auto' || ox === 'scroll') && x.scrollWidth > x.clientWidth + 1) return true
    }
    return false
  }
  // Content cut off by an overflow-clipping box that itself ends inside the viewport (truncate,
  // line-clamp, rounded cards) is not visible overflow. A clip at the viewport edge (a fixed,
  // full-screen overlay) still hides overflowing content, so that case IS reported.
  const clippedInside = (e) => {
    for (let x = e.parentElement; x && x !== document.body; x = x.parentElement) {
      const ox = getComputedStyle(x).overflowX
      if (ox === 'hidden' || ox === 'clip') return x.getBoundingClientRect().right <= W - 2
    }
    return false
  }
  const offenders = []
  let total = 0
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    if (r.right <= W + 1) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.position === 'fixed' && r.left >= W) continue
    if (inScroller(el) || clippedInside(el)) continue
    // Decorative full-bleed layers (blurred, scaled cover art, visualizer canvas) bleed on purpose.
    if ((el.tagName === 'IMG' || el.tagName === 'CANVAS') && cs.position === 'absolute' && (cs.pointerEvents === 'none' || /blur/.test(cs.filter))) continue
    if (cs.pointerEvents === 'none' && el.closest('[aria-hidden="true"]')) continue
    total++
    const pr = el.parentElement ? el.parentElement.getBoundingClientRect() : null
    if (pr && pr.right > W + 1) continue
    offenders.push({ path: pathOf(el), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) })
  }
  return { width: W, innerWidth: window.innerWidth, scrollWidth: de.scrollWidth, pageOverflow: de.scrollWidth > W || window.innerWidth > W, total, offenders: offenders.slice(0, 25) }
})()
`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const debug = (...a) => {
  if (process.env.SHOTS_DEBUG) process.stdout.write(`[debug] ${a.join(' ')}\n`)
}

async function main() {
  await app.whenReady()
  debug('ready')
  // show: true is required with --ozone-platform=headless, otherwise no frames are produced.
  const win = new BrowserWindow({ show: true, width: 1280, height: 900, webPreferences: { backgroundThrottling: false } })
  const wc = win.webContents
  // Attach the debugger only once a document exists: commands sent before the first
  // navigation can stall on a headless ozone window.
  await wc.loadURL('about:blank')
  const dbg = wc.debugger
  dbg.attach('1.3')
  debug('attached')
  await dbg.sendCommand('Page.enable')
  const consoleLines = []
  wc.on('console-message', (e) => {
    const msg = e.message ?? ''
    if ((e.level === 'error' || e.level === 3) && consoleLines.length < 200) consoleLines.push(msg.slice(0, 300))
  })

  const injected = new Map() // platform -> identifiers
  let currentPlatform = null
  async function usePlatform(platform) {
    if (platform === currentPlatform) return
    for (const ids of injected.values()) for (const id of ids) await dbg.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: id })
    injected.clear()
    const ids = []
    ids.push((await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: HELPERS })).identifier)
    if (platform === 'android') ids.push((await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: ANDROID })).identifier)
    if (platform === 'desktop') ids.push((await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: DESKTOP })).identifier)
    injected.set(platform, ids)
    currentPlatform = platform
  }

  async function load(url) {
    // A URL that differs only by #hash is a same-document navigation: loadURL() would never
    // settle, so go through a blank page to force a real load.
    const strip = (u) => u.split('#')[0]
    const cur = wc.getURL()
    if (cur && strip(cur) === strip(url) && (cur.includes('#') || url.includes('#'))) await wc.loadURL('about:blank')
    await wc.loadURL(url)
    await wc.executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true')
  }

  const report = []
  for (const job of config.jobs) {
    const started = Date.now()
    const entry = { name: job.name, file: job.file, width: job.width, height: job.height, platform: job.platform, theme: job.settings?.theme ?? null }
    try {
      debug('job', job.name, job.width)
      await usePlatform(job.platform || 'web')
      await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: job.width,
        height: job.height,
        deviceScaleFactor: job.dsf ?? 2,
        mobile: Boolean(job.mobile)
      })
      // Android WebView uses overlay scrollbars; hide the classic ones on phone/tablet emulation.
      await dbg.sendCommand('Emulation.setScrollbarsHidden', { hidden: Boolean(job.mobile) }).catch(() => {})
      await dbg.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: Boolean(job.mobile), maxTouchPoints: job.mobile ? 5 : 1 }).catch(() => {})
      if (job.insets) {
        await dbg
          .sendCommand('Emulation.setSafeAreaInsetsOverride', { insets: { top: job.insets.top ?? 0, bottom: job.insets.bottom ?? 0, left: 0, right: 0 } })
          .then(() => (entry.safeArea = job.insets))
          .catch(() => (entry.safeArea = 'unsupported'))
      } else {
        await dbg.sendCommand('Emulation.setSafeAreaInsetsOverride', { insets: {} }).catch(() => {})
      }

      // Same-origin storage is prepared from a blank page of the app origin.
      let sameOrigin = false
      try {
        sameOrigin = new URL(wc.getURL()).origin === new URL(job.url).origin
      } catch {
        sameOrigin = false
      }
      debug('emulation set; same origin:', sameOrigin)
      if (!sameOrigin) await load(job.url)
      await wc.executeJavaScript(`(() => {
        const ls = ${JSON.stringify(job.localStorage ?? {})};
        localStorage.clear();
        for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, JSON.stringify(v));
        ${job.clearSession ? 'sessionStorage.clear();' : ''}
      })()`)
      await load(job.url)
      debug('loaded', wc.getURL())

      // Sign in through the real form when the app shows it (and the job wants a session).
      const state = !job.app ? 'static' : await wc.executeJavaScript(`(async () => {
        const h = window.__h
        await h.waitFor(() => document.querySelector('#username, nav[aria-label="Main navigation"]'), 15000)
        return document.querySelector('#username') ? 'login' : 'app'
      })()`)
      debug('state', state)
      if (state === 'login' && job.login) {
        await wc.executeJavaScript(`(async () => {
          const h = window.__h
          const server = document.querySelector('#server')
          if (server) await h.type('css:#server', ${JSON.stringify(job.login.server)})
          await h.type('css:#username', ${JSON.stringify(job.login.username)})
          await h.type('css:#password', ${JSON.stringify(job.login.password)})
          document.querySelector('button[type=submit]').click()
          await h.waitFor(() => document.querySelector('nav[aria-label="Main navigation"]'), 15000)
          await h.idle()
        })()`)
      }

      if (job.setup) {
        entry.setupResult = await Promise.race([
          wc.executeJavaScript(`(async () => { const h = window.__h; return await (${job.setup})(h) })()`),
          sleep(45_000).then(() => {
            throw new Error('setup timed out after 45 s')
          })
        ])
      }
      await wc.executeJavaScript('window.__h.idle(8000)')
      await sleep(job.settle ?? 700)
      // Keep the fullscreen player's auto-hiding top bar awake (it fades after 3.5 s idle).
      await wc.executeJavaScript(`(() => { const d = document.querySelector('[role=dialog][aria-label="Now playing"]'); if (d) d.dispatchEvent(new PointerEvent('pointermove', { bubbles: true })) })()`)
      // Headless frames can lag behind animation clocks: jump finite entrance animations
      // (fade-up, modal-in, ...) to their end state so shots are never caught mid-fade.
      await wc.executeJavaScript(`(() => { for (const a of document.getAnimations()) { try { const t = a.effect && a.effect.getComputedTiming(); if (t && Number.isFinite(t.endTime)) a.finish() } catch {} } })()`)
      await sleep(150)
      debug('setup done')
      entry.overflow = await wc.executeJavaScript(OVERFLOW.replace('__WIDTH__', String(job.width)))
      const shot = await dbg.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      fs.mkdirSync(path.dirname(job.file), { recursive: true })
      fs.writeFileSync(job.file, Buffer.from(shot.data, 'base64'))
      entry.ok = true
    } catch (err) {
      entry.ok = false
      entry.error = String(err && err.message ? err.message : err)
      try {
        const shot = await dbg.sendCommand('Page.captureScreenshot', { format: 'png' })
        fs.mkdirSync(path.dirname(job.file), { recursive: true })
        fs.writeFileSync(job.file.replace(/\.png$/, '.error.png'), Buffer.from(shot.data, 'base64'))
      } catch {
        /* ignore */
      }
    }
    entry.ms = Date.now() - started
    report.push(entry)
    const o = entry.overflow
    const flag = !entry.ok ? `ERROR ${entry.error}` : o && (o.pageOverflow || o.offenders.length) ? `OVERFLOW scrollWidth=${o.scrollWidth} innerWidth=${o.innerWidth} viewport=${o.width} roots=${o.offenders.length}` : 'ok'
    process.stdout.write(`[shots] ${path.basename(job.file)} ${flag}\n`)
    if (o && o.offenders.length) for (const off of o.offenders.slice(0, 6)) process.stdout.write(`         -> ${off.path} right=${off.right} w=${off.width} "${off.text}"\n`)
  }

  // Optional contact sheets: one image per group with all widths side by side.
  for (const sheet of config.sheets ?? []) {
    try {
      const imgs = sheet.files.filter((f) => fs.existsSync(f))
      if (!imgs.length) continue
      const html = `<!doctype html><html><body style="margin:0;background:#202024;font:12px sans-serif;color:#ddd">
        <div style="display:flex;gap:12px;align-items:flex-start;padding:12px">${imgs
          .map((f) => `<figure style="margin:0"><figcaption style="padding-bottom:4px">${path.basename(f)}</figcaption><img src="${require('node:url').pathToFileURL(f).href}" style="height:${sheet.height}px;display:block"></figure>`)
          .join('')}</div></body></html>`
      fs.mkdirSync(path.dirname(sheet.file), { recursive: true })
      const tmp = path.join(path.dirname(sheet.file), `.sheet-${process.pid}.html`)
      fs.writeFileSync(tmp, html)
      await dbg.sendCommand('Emulation.setSafeAreaInsetsOverride', { insets: {} }).catch(() => {})
      await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width: sheet.width, height: sheet.height + 40, deviceScaleFactor: 1, mobile: false })
      await wc.loadFile(tmp)
      await sleep(300)
      const shot = await dbg.sendCommand('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(sheet.file, Buffer.from(shot.data, 'base64'))
      fs.unlinkSync(tmp)
    } catch (err) {
      process.stdout.write(`[shots] sheet ${sheet.file} failed: ${err}\n`)
    }
  }

  fs.writeFileSync(config.reportPath, JSON.stringify({ round: config.round, jobs: report, consoleErrors: consoleLines }, null, 2))
  app.exit(0)
}

main().catch((err) => {
  process.stderr.write(`[shots] fatal: ${err && err.stack ? err.stack : err}\n`)
  app.exit(1)
})
