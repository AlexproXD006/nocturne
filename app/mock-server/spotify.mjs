// Spotify import (capabilities.spotifyImport) for the mock server.
//
// - A fake OAuth flow: POST /v1/spotify/authorize returns a URL to GET /v1/spotify/mock-login?state=…,
//   a small HTML page that marks the user as connected ("go back to Nocturne").
// - A fixed set of fake Spotify playlists per user, plus any playlist id/link pasted by the user.
// - Imports advance one step per tick (every `jobTickMs`; `tickMs: 0` disables the timer so tests
//   drive it with tick()): queued → reading → matching → downloading → done. Songs "in the library"
//   map to catalog tracks; "downloaded" songs map to other catalog tracks; some songs are never found.

import { randomBytes } from 'node:crypto'
import { HttpError } from './auth.mjs'
import { SECURITY_HEADERS, readJson, sendJson, sendNoContent } from './http.mjs'
import { hash32, rngFor } from './util.mjs'

const FINISHED = new Set(['done', 'failed', 'cancelled'])
const STATE_TTL_MS = 10 * 60_000
const MATCH_CHUNK = 8
const DOWNLOAD_CHUNK = 3
const MAX_IMPORTS = 50
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const ID_RE = /^[A-Za-z0-9]{16,40}$/

/** Deterministic 22-character base62 id (the shape of a Spotify id). */
function fakeId(seed) {
  const rng = rngFor(`spotify:${seed}`)
  let s = ''
  for (let i = 0; i < 22; i++) s += B62[Math.floor(rng() * 62)]
  return s
}

const FAKE_PLAYLISTS = [
  ['Favs 2.0', 48, null],
  ['Late Night Drive', 32, null],
  ['Gym Rotation', 25, null],
  ['Discover Weekly', 30, 'Spotify'],
  ['Chill Sundays', 18, null],
  ['Road Trip 2026', 40, null],
  ['Coding Focus', 22, null],
  ['Throwbacks', 36, null],
  ['Empty Ideas', 0, null]
].map(([name, trackCount, owner]) => ({ id: fakeId(name), name, trackCount, owner }))

const WORDS = ['Neon', 'Velvet', 'Paper', 'Silver', 'Echo', 'Midnight', 'Golden', 'Static', 'Ocean', 'Glass', 'Ember', 'Lunar', 'Wild', 'Quiet']
const NOUNS = ['Hearts', 'Avenue', 'Signals', 'Rain', 'Season', 'Garden', 'Machine', 'Skyline', 'Letters', 'Fever', 'Mirrors', 'Tides']

/** Accepts a playlist id, an open.spotify.com/playlist/<id> link or a spotify:playlist:<id> URI. */
export function parsePlaylistRef(raw) {
  if (typeof raw !== 'string') return null
  const v = raw.trim()
  if (!v || v.length > 2048) return null
  if (ID_RE.test(v)) return v
  const uri = /^spotify:(?:user:[^:]+:)?playlist:([A-Za-z0-9]{16,40})$/i.exec(v)
  if (uri) return uri[1]
  try {
    const url = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`)
    if (url.hostname !== 'open.spotify.com' && url.hostname !== 'play.spotify.com') return null
    const parts = url.pathname.split('/').filter(Boolean)
    const i = parts.indexOf('playlist')
    const id = i >= 0 ? parts[i + 1] : undefined
    return id && ID_RE.test(id) ? id : null
  } catch {
    return null
  }
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function sendHtml(res, status, title, message) {
  const body = Buffer.from(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e0e12;color:#f3f3f6;font:16px/1.5 system-ui,sans-serif;padding:16px;box-sizing:border-box}main{max-width:420px;text-align:center}h1{font-size:22px;margin:0 0 8px}p{color:#a1a1ad;margin:0}</style>
</head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`)
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    'Referrer-Policy': 'no-referrer',
    'Content-Length': body.length
  })
  res.end(body)
}

/**
 * @param {{opt: object, catalog: object, originOf: (req: any) => string, addUserPlaylist: (user: object, name: string, description: string, trackIds: string[]) => object}} deps
 */
export function createSpotify({ opt, catalog, originOf, addUserPlaylist }) {
  const now = opt.now
  const configured = opt.spotifyConfigured !== false
  const tokenDays = opt.spotifyTokenDays ?? 180
  const accounts = new Map() // userId -> { account, expiresAt }
  const states = new Map() // state -> { userId, exp }
  const imports = new Map() // userId -> internal import[] (newest first)
  const extraPlaylists = new Map() // pasted ids -> fake playlist
  let counter = 0
  let timer = null

  const playlistById = (id) => FAKE_PLAYLISTS.find((p) => p.id === id) ?? extraPlaylists.get(id) ?? null

  /** Any id resolves: unknown ids become a generated playlist (or 404 for ids starting with "missing"). */
  function resolvePlaylist(id) {
    const known = playlistById(id)
    if (known) return known
    if (/^missing/i.test(id)) throw new HttpError(404, "That Spotify playlist doesn't exist or isn't public.")
    const rng = rngFor(id)
    const p = { id, name: `${WORDS[Math.floor(rng() * WORDS.length)]} ${NOUNS[Math.floor(rng() * NOUNS.length)]}`, trackCount: 12 + Math.floor(rng() * 30), owner: 'Someone' }
    extraPlaylists.set(id, p)
    return p
  }

  /** Song list of a fake playlist: ~60% already in the library, the rest missing (some never found). */
  function songsOf(p) {
    const tracks = catalog.tracks
    const songs = []
    const base = hash32(p.id) % Math.max(1, tracks.length)
    for (let i = 0; i < p.trackCount; i++) {
      const rng = rngFor(`${p.id}:${i}`)
      const roll = rng()
      const t = tracks.length ? tracks[(base + i * 7) % tracks.length] : null
      const title = `${WORDS[Math.floor(rng() * WORDS.length)]} ${NOUNS[Math.floor(rng() * NOUNS.length)]}`
      const artists = `${WORDS[Math.floor(rng() * WORDS.length)]} ${NOUNS[Math.floor(rng() * NOUNS.length)]}`
      if (t && roll < 0.6) songs.push({ kind: 'library', trackId: t.id })
      else if (t && roll < 0.88) songs.push({ kind: 'downloadable', trackId: tracks[(base + i * 7 + 53) % tracks.length].id, title, artists })
      else songs.push({ kind: 'missing', title, artists })
    }
    return songs
  }

  const image = (origin, id) => `${origin}/art/spotify/${encodeURIComponent(id)}.svg`

  function playlistJson(origin, p) {
    return { id: p.id, name: p.name, trackCount: p.trackCount, image: image(origin, p.id), ...(p.owner ? { owner: p.owner } : {}), public: true }
  }

  function importJson(origin, imp) {
    const total = imp.songs.length
    return {
      id: imp.id,
      status: imp.status,
      spotifyPlaylist: { id: imp.playlist.id, name: imp.playlist.name, image: image(origin, imp.playlist.id) },
      ...(imp.playlistId ? { playlistId: imp.playlistId } : {}),
      total: imp.status === 'queued' ? 0 : total,
      matched: imp.matched,
      downloaded: imp.downloaded,
      failed: imp.failures.length,
      pending: imp.status === 'queued' ? 0 : Math.max(0, total - imp.matched - imp.downloaded - imp.failures.length),
      failures: imp.failures,
      createdAt: imp.createdAt,
      ...(imp.finishedAt ? { finishedAt: imp.finishedAt } : {})
    }
  }

  const listFor = (userId) => {
    let l = imports.get(userId)
    if (!l) imports.set(userId, (l = []))
    return l
  }

  function connection(user) {
    const c = accounts.get(user.id)
    if (c && Date.parse(c.expiresAt) <= now()) {
      accounts.delete(user.id)
      return null
    }
    return c ?? null
  }

  function requireConnected(user) {
    if (!configured) throw new HttpError(409, "Spotify isn't set up on this server.")
    const c = connection(user)
    if (!c) throw new HttpError(409, 'Connect your Spotify account first.')
    return c
  }

  const finish = (imp, status) => {
    imp.status = status
    imp.finishedAt = new Date(now()).toISOString()
  }

  /** Advances one import by one step. */
  function step(imp) {
    if (FINISHED.has(imp.status)) return
    const pl = imp.playlistId ? catalog.playlistById.get(imp.playlistId) : null
    const add = (trackId) => {
      if (pl && !pl.trackIds.includes(trackId)) pl.trackIds.push(trackId)
    }
    if (imp.status === 'queued') {
      imp.status = 'reading'
      return
    }
    if (imp.status === 'reading') {
      const created = addUserPlaylist(imp.user, imp.playlist.name.slice(0, 100), 'Imported from Spotify', [])
      imp.playlistId = created.id
      imp.status = 'matching'
      return
    }
    if (imp.status === 'matching') {
      const end = Math.min(imp.songs.length, imp.cursor + MATCH_CHUNK)
      for (; imp.cursor < end; imp.cursor++) {
        const s = imp.songs[imp.cursor]
        if (s.kind === 'library' && catalog.trackById.has(s.trackId)) {
          imp.matched++
          add(s.trackId)
        } else if (imp.download && s.kind !== 'library') imp.queue.push(s)
        else imp.failures.push({ title: s.title ?? 'Unknown song', artists: s.artists ?? 'Unknown artist', reason: s.kind === 'library' ? 'Removed from the library' : 'Not in your library' })
      }
      if (imp.cursor >= imp.songs.length) {
        if (imp.queue.length > 0) imp.status = 'downloading'
        else finish(imp, 'done')
      }
      return
    }
    if (imp.status === 'downloading') {
      for (let i = 0; i < DOWNLOAD_CHUNK && imp.queue.length > 0; i++) {
        const s = imp.queue.shift()
        if (s.kind === 'downloadable' && catalog.trackById.has(s.trackId)) {
          imp.downloaded++
          add(s.trackId)
        } else imp.failures.push({ title: s.title, artists: s.artists, reason: 'No match found on any download source' })
      }
      if (imp.queue.length === 0) finish(imp, 'done')
    }
  }

  function tick() {
    for (const list of imports.values()) for (const imp of list) step(imp)
    if (timer && !hasActive()) stop()
  }

  function hasActive() {
    for (const list of imports.values()) if (list.some((i) => !FINISHED.has(i.status))) return true
    return false
  }

  function ensureTimer() {
    if (timer || !opt.jobTickMs) return
    timer = setInterval(tick, opt.jobTickMs)
    timer.unref?.()
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
  }

  function ownImport(user, id) {
    const imp = listFor(user.id).find((i) => i.id === id)
    if (!imp) throw new HttpError(404, 'Import not found.')
    return imp
  }

  const handlers = {
    status({ res, user }) {
      const c = configured ? connection(user) : null
      sendJson(res, 200, { configured, connected: Boolean(c), ...(c ? { account: c.account, expiresAt: c.expiresAt } : {}) })
    },
    authorize({ req, res, user }) {
      if (!configured) throw new HttpError(409, "Spotify isn't set up on this server.")
      for (const [k, v] of states) if (v.exp <= now()) states.delete(k)
      const state = randomBytes(16).toString('hex')
      states.set(state, { userId: user.id, displayName: user.displayName || user.username, username: user.username, exp: now() + STATE_TTL_MS })
      sendJson(res, 200, { url: `${originOf(req)}/v1/spotify/mock-login?state=${state}` })
    },
    mockLogin({ res, query }) {
      const state = query.get('state') ?? ''
      const entry = states.get(state)
      if (!entry || entry.exp <= now()) {
        states.delete(state)
        return sendHtml(res, 400, 'Link expired', 'This Spotify sign-in link is no longer valid. Go back to Nocturne and try again.')
      }
      states.delete(state)
      accounts.set(entry.userId, {
        account: { id: `${entry.username}-spotify`, displayName: entry.displayName },
        expiresAt: new Date(now() + tokenDays * 86_400_000).toISOString()
      })
      sendHtml(res, 200, 'Spotify connected', 'Your Spotify account is connected. You can close this page and go back to Nocturne.')
    },
    disconnect({ res, user }) {
      accounts.delete(user.id)
      sendNoContent(res)
    },
    playlists({ req, res, user }) {
      requireConnected(user)
      const origin = originOf(req)
      sendJson(res, 200, FAKE_PLAYLISTS.map((p) => playlistJson(origin, p)))
    },
    async startImport({ req, res, user }) {
      requireConnected(user)
      const body = await readJson(req, { required: true })
      const id = parsePlaylistRef(body.playlist)
      if (!id) throw new HttpError(400, '"playlist" must be a Spotify playlist id or open.spotify.com link.')
      if (body.download !== undefined && typeof body.download !== 'boolean') throw new HttpError(400, '"download" must be a boolean.')
      const playlist = resolvePlaylist(id)
      const list = listFor(user.id)
      if (list.some((i) => i.playlist.id === id && !FINISHED.has(i.status))) throw new HttpError(409, 'That playlist is already being imported.')
      const imp = {
        id: `spi-${String(++counter).padStart(4, '0')}`,
        user,
        playlist,
        songs: songsOf(playlist),
        download: body.download !== false,
        status: 'queued',
        cursor: 0,
        queue: [],
        matched: 0,
        downloaded: 0,
        failures: [],
        createdAt: new Date(now()).toISOString(),
        finishedAt: undefined
      }
      list.unshift(imp)
      if (list.length > MAX_IMPORTS) {
        const idx = list.findLastIndex((i) => FINISHED.has(i.status))
        if (idx >= 0) list.splice(idx, 1)
      }
      ensureTimer()
      sendJson(res, 202, importJson(originOf(req), imp))
    },
    listImports({ req, res, user }) {
      const origin = originOf(req)
      sendJson(res, 200, listFor(user.id).map((i) => importJson(origin, i)))
    },
    getImport({ req, res, user, params }) {
      sendJson(res, 200, importJson(originOf(req), ownImport(user, params[0])))
    },
    cancelImport({ res, user, params }) {
      const imp = ownImport(user, params[0])
      if (FINISHED.has(imp.status)) throw new HttpError(409, 'The import has already finished.')
      finish(imp, 'cancelled')
      sendNoContent(res)
    }
  }

  // [methods, regex, handler, needsAuth]
  const routes = [
    [['GET'], /^\/v1\/spotify\/status$/, handlers.status, true],
    [['POST'], /^\/v1\/spotify\/authorize$/, handlers.authorize, true],
    [['GET'], /^\/v1\/spotify\/mock-login$/, handlers.mockLogin, false],
    [['DELETE'], /^\/v1\/spotify\/connection$/, handlers.disconnect, true],
    [['GET'], /^\/v1\/spotify\/playlists$/, handlers.playlists, true],
    [['GET'], /^\/v1\/spotify\/imports$/, handlers.listImports, true],
    [['POST'], /^\/v1\/spotify\/imports$/, handlers.startImport, true],
    [['GET'], /^\/v1\/spotify\/imports\/([^/]+)$/, handlers.getImport, true],
    [['DELETE'], /^\/v1\/spotify\/imports\/([^/]+)$/, handlers.cancelImport, true]
  ]

  return {
    routes,
    tick,
    stop,
    configured,
    /** Label for /art/spotify/<id>.svg, or null. */
    artLabel(id) {
      const p = playlistById(id)
      return p ? { title: p.name, subtitle: 'Spotify' } : null
    },
    /** Test helper: connects a user without the browser round trip. */
    connect(user) {
      accounts.set(user.id, { account: { id: `${user.username}-spotify`, displayName: user.displayName || user.username }, expiresAt: new Date(now() + tokenDays * 86_400_000).toISOString() })
    }
  }
}
