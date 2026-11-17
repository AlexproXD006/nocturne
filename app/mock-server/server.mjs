#!/usr/bin/env node
// Nocturne mock server: implements the Nocturne Server API v1 (docs/API.md)
// with a procedurally generated demo catalog. Zero dependencies (Node 22).

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { createAdmin } from './admin.mjs'
import { renderArt } from './art.mjs'
import { AuthService, HttpError, parseUsers } from './auth.mjs'
import { AudioCache } from './audio.mjs'
import { albumDetailJson, albumJson, artistDetailJson, artistJson, getCatalog, playlistDetailJson, playlistJson, trackJson } from './catalog.mjs'
import { SECURITY_HEADERS, intParam, page, parseRange, readJson, sendJson, sendNoContent } from './http.mjs'
import { JobEngine } from './jobs.mjs'
import { createLibrary } from './library.mjs'
import { lyricsFor } from './lyrics.mjs'
import { withRealisticCatalog } from './realistic.mjs'
import { itemFromResultId } from './sources.mjs'
import { createSpotify } from './spotify.mjs'
import { createConnect } from './connect.mjs'
import { isApiPath, resolveStaticDir, serveStatic } from './static.mjs'
import { plainFromLrc, plainFromTtml } from './ttml.mjs'
import { userJson } from './userjson.mjs'
import { fold } from './util.mjs'

export { parseRange }

export const MOCK_VERSION = '1.1.0'
export const DEFAULT_USERS = 'demo:demo:admin,guest:guestguest:user'
export const SESSION_HEADER = 'x-nocturne-session'
export const COOKIE_NAME = 'nocturne_rt'
const DEFAULT_ORIGINS = [
  'app://nocturne',
  'https://localhost',
  'http://localhost',
  'capacitor://localhost',
  'http://localhost:5173',
  'http://127.0.0.1:5173'
]
const SEARCH_TYPES = ['track', 'album', 'artist', 'playlist']

// ---- Options ---------------------------------------------------------------

function envInt(env, name, def, min, max) {
  const raw = env[name]
  if (raw === undefined || raw === '') return def
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer between ${min} and ${max} (got "${raw}")`)
  return n
}

/**
 * Resolves options. Explicit `options` win over environment variables, which win over defaults.
 * @param {object} options
 * @param {NodeJS.ProcessEnv} env
 */
export function resolveOptions(options = {}, env = process.env) {
  const users = options.users ?? parseUsers(env.MOCK_USERS || DEFAULT_USERS)
  const cors = options.corsOrigins ?? [
    ...DEFAULT_ORIGINS,
    ...(env.MOCK_CORS_ORIGINS ? env.MOCK_CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) : [])
  ]
  return {
    host: options.host ?? env.HOST ?? '127.0.0.1',
    port: options.port ?? envInt(env, 'PORT', 4533, 0, 65535),
    users,
    accessTtl: options.accessTtl ?? envInt(env, 'MOCK_ACCESS_TTL', 900, 1, 86_400 * 30),
    refreshTtl: options.refreshTtl ?? envInt(env, 'MOCK_REFRESH_TTL', 86_400 * 30, 1, 86_400 * 365),
    streamTtl: options.streamTtl ?? envInt(env, 'MOCK_STREAM_TTL', 300, 1, 86_400),
    loginLimit: options.loginLimit ?? { max: envInt(env, 'MOCK_LOGIN_LIMIT', 10, 0, 100_000), windowMs: 60_000 },
    corsOrigins: cors,
    quiet: options.quiet ?? env.MOCK_QUIET === '1',
    log: options.log ?? ((line) => console.log(line)),
    now: options.now ?? Date.now,
    publicUrl: options.publicUrl ?? env.MOCK_PUBLIC_URL ?? null,
    trustProxy: options.trustProxy ?? env.MOCK_TRUST_PROXY === '1',
    audioCacheSize: options.audioCacheSize ?? 12,
    uploadMaxBytes: options.uploadMaxBytes ?? envInt(env, 'MOCK_UPLOAD_MAX', 200 * 1024 * 1024, 1, 2 ** 31 - 1),
    uploadStoreMaxBytes: options.uploadStoreMaxBytes ?? envInt(env, 'MOCK_UPLOAD_STORE_MAX', 512 * 1024 * 1024, 1, 2 ** 40),
    jobTickMs: options.jobTickMs ?? envInt(env, 'MOCK_JOB_TICK_MS', 700, 0, 60_000),
    staticDir: options.staticDir ?? (env.MOCK_STATIC_DIR || null),
    realistic: options.realistic ?? env.MOCK_REALISTIC === '1',
    updateVersion: options.updateVersion ?? (env.MOCK_UPDATE_VERSION || null),
    /** False simulates a server without Spotify app credentials (status.configured: false). */
    spotifyConfigured: options.spotifyConfigured ?? env.MOCK_SPOTIFY_CONFIGURED !== '0',
    /** Lifetime of a fake Spotify connection (the real one lasts ~180 days). */
    spotifyTokenDays: options.spotifyTokenDays ?? envInt(env, 'MOCK_SPOTIFY_TOKEN_DAYS', 180, 1, 3650)
  }
}

// ---- Small helpers -----------------------------------------------------------

function matchesText(entity, q) {
  return entity.search.includes(q)
}

function score(name, q) {
  const f = fold(name)
  if (f.startsWith(q)) return 0
  if (f.includes(` ${q}`)) return 1
  if (f.includes(q)) return 2
  return 3
}

// ---- Server ------------------------------------------------------------------

/**
 * Creates (but does not start) a mock server.
 * @param {object} [options] see resolveOptions: host, port, users, accessTtl, refreshTtl, streamTtl,
 *   loginLimit {max,windowMs}, corsOrigins, quiet, log, now, publicUrl, trustProxy, audioCacheSize
 * @returns {{server: import('node:http').Server, listen: (port?: number, host?: string) => Promise<{url: string, port: number, host: string}>, close: () => Promise<void>, catalog: object, users: object[], url: string|null}}
 */
export function createMockServer(options = {}) {
  const opt = resolveOptions(options)
  const catalog = createLibrary(opt.realistic ? withRealisticCatalog(getCatalog()) : getCatalog())
  const auth = new AuthService(opt)
  const staticRoot = opt.staticDir ? resolveStaticDir(opt.staticDir) : null
  const jobs = new JobEngine({ now: opt.now, tickMs: opt.jobTickMs })
  const audio = new AudioCache(opt.audioCacheSize)
  const streamSecret = randomBytes(32)
  const allowAnyOrigin = opt.corsOrigins.includes('*')
  const allowedOrigins = new Set(opt.corsOrigins)
  const userState = new Map() // userId -> { liked: string[], played: string[] }
  let boundOrigin = null
  const authBase = { opt, auth, jobs }

  const sign = (id, exp) => createHmac('sha256', streamSecret).update(`${id}.${exp}`).digest('hex')

  function stateFor(userId) {
    let s = userState.get(userId)
    if (!s) {
      s = { liked: [...catalog.defaults.likedTrackIds], played: [] }
      userState.set(userId, s)
    }
    return s
  }

  function originOf(req) {
    if (opt.publicUrl) return opt.publicUrl.replace(/\/+$/, '')
    const host = req.headers.host
    if (host && /^[A-Za-z0-9.\-[\]:]{1,255}$/.test(host)) {
      const proto = opt.trustProxy && req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'
      return `${proto}://${host}`
    }
    return boundOrigin ?? 'http://127.0.0.1'
  }

  function clientIp(req) {
    if (opt.trustProxy) {
      const fwd = req.headers['x-forwarded-for']
      if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim()
    }
    return req.socket.remoteAddress ?? 'unknown'
  }

  function applyCors(req, res) {
    res.setHeader('Vary', 'Origin')
    const origin = req.headers.origin
    if (!origin) return true
    if (allowAnyOrigin || allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Retry-After')
      // No Access-Control-Allow-Credentials: cookie sessions are same-origin only.
      return true
    }
    return false
  }

  const ctxFor = (req, user) => ({
    catalog,
    origin: originOf(req),
    liked: new Set(stateFor(user.id).liked)
  })

  // ---- Cookie sessions (same-origin web build) -------------------------------------

  const isCookieMode = (req) => String(req.headers[SESSION_HEADER] ?? '').trim().toLowerCase() === 'cookie'

  /** Cookie mode is honored only for same-origin requests (the Origin header, when present, must be our own). */
  function assertSameOrigin(req) {
    const origin = req.headers.origin
    if (origin !== undefined && origin !== originOf(req)) throw new HttpError(403, 'Cookie sessions are only available to the same origin.')
  }

  /** Secure is omitted only for plain http on localhost / 127.0.0.1 so local testing works. */
  function cookieAttrs(req) {
    let secure = true
    try {
      const u = new URL(originOf(req))
      if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) secure = false
    } catch {
      /* keep Secure */
    }
    return `HttpOnly;${secure ? ' Secure;' : ''} SameSite=Strict; Path=/v1/auth`
  }

  const setCookie = (req, token) => `${COOKIE_NAME}=${token}; ${cookieAttrs(req)}; Max-Age=${opt.refreshTtl}`
  const clearCookie = (req) => `${COOKIE_NAME}=; ${cookieAttrs(req)}; Max-Age=0`

  function readCookie(req) {
    const header = req.headers.cookie
    if (typeof header !== 'string' || header.length > 4096) return null
    for (const part of header.split(';')) {
      const i = part.indexOf('=')
      if (i > 0 && part.slice(0, i).trim() === COOKIE_NAME) {
        const v = part.slice(i + 1).trim()
        return v && v.length <= 512 ? v : null
      }
    }
    return null
  }

  // ---- User playlists ----
  // Seeded/imported playlists are shared and read-only. Playlists created through POST /v1/playlists
  // live in the same `catalog.playlists` list (so artwork and admin track deletes keep working) with an
  // `ownerId`; only their owner can see and edit them.
  let playlistCounter = 0
  const visiblePlaylist = (p, user) => Boolean(p) && (!p.ownerId || p.ownerId === user.id)
  const visiblePlaylists = (user) => catalog.playlists.filter((p) => visiblePlaylist(p, user))
  function userPlaylistJson(ctx, p, user) {
    const base = playlistJson(ctx, p)
    if (!p.ownerId) return { ...base, editable: false }
    const owner = auth.userById(p.ownerId)
    return { ...base, description: p.description || undefined, owner: { id: p.ownerId, name: owner?.displayName ?? 'You' }, editable: p.ownerId === user.id }
  }
  function userPlaylistDetailJson(ctx, p, user) {
    const detail = playlistDetailJson(ctx, p)
    const entries = entryIdsOf(p)
    return { ...detail, ...userPlaylistJson(ctx, p, user), tracks: detail.tracks.map((t, i) => ({ ...t, entryId: entries[i] })) }
  }

  // ---- Playlist entries ----
  // A playlist may hold the same song more than once; each occurrence gets an `entryId`, kept in
  // `p.entryIds` parallel to `p.trackIds`. Other modules (admin track delete, Spotify import) only
  // touch `p.trackIds`, so the ids are re-paired lazily: surviving occurrences keep their entry id
  // (matched per song, in order) and new ones get a fresh id.
  let entryCounter = 0
  const newEntryId = () => `e${(++entryCounter).toString(36)}${randomBytes(2).toString('hex')}`
  function entryIdsOf(p) {
    const prevTracks = p.entryTrackIds ?? []
    const prevEntries = p.entryIds ?? []
    const same = prevTracks.length === p.trackIds.length && prevTracks.every((id, i) => id === p.trackIds[i])
    if (!same || prevEntries.length !== p.trackIds.length) {
      const pool = new Map()
      prevTracks.forEach((id, i) => {
        if (!prevEntries[i]) return
        if (!pool.has(id)) pool.set(id, [])
        pool.get(id).push(prevEntries[i])
      })
      p.entryIds = p.trackIds.map((id) => pool.get(id)?.shift() ?? newEntryId())
      p.entryTrackIds = [...p.trackIds]
    }
    return p.entryIds
  }
  /** Replaces the playlist's contents with `entries` ([{trackId, entryId}], in order). */
  function setEntries(p, entries) {
    p.trackIds = entries.map((e) => e.trackId)
    p.entryIds = entries.map((e) => e.entryId)
    p.entryTrackIds = [...p.trackIds]
  }
  function entriesOf(p) {
    const ids = entryIdsOf(p)
    return p.trackIds.map((trackId, i) => ({ trackId, entryId: ids[i] }))
  }
  /** The playlist the current user may edit, or 404 (not visible) / 403 (shared, not theirs). */
  function ownPlaylist(id, user) {
    const p = catalog.playlistById.get(id)
    if (!visiblePlaylist(p, user)) throw new HttpError(404, 'Playlist not found.')
    if (p.ownerId !== user.id) throw new HttpError(403, "You can't change this playlist.")
    return p
  }
  function playlistText(body, field, max, { required }) {
    const v = body[field]
    if (v === undefined && !required) return undefined
    if (typeof v !== 'string') throw new HttpError(400, `"${field}" must be a string.`)
    const t = v.trim()
    if (required && !t) throw new HttpError(400, `"${field}" is required.`)
    if (t.length > max) throw new HttpError(400, `"${field}" can be at most ${max} characters.`)
    return t
  }
  function trackIdList(body, { required }) {
    const v = body.trackIds
    if (v === undefined && !required) return []
    if (!Array.isArray(v) || v.length > 2000 || v.some((id) => typeof id !== 'string')) throw new HttpError(400, '"trackIds" must be an array of track ids.')
    for (const id of v) if (!catalog.trackById.has(id)) throw new HttpError(400, `Unknown track "${id}".`)
    return v
  }

  /** Creates a playlist owned by `user` (also used by the Spotify import). */
  function addUserPlaylist(user, name, description, trackIds) {
    let id
    do id = `upl-${(++playlistCounter).toString(36)}-${randomBytes(3).toString('hex')}`
    while (catalog.playlistById.has(id))
    const p = { id, name, description, trackIds, ownerId: user.id, createdSeq: playlistCounter, search: fold(`${name} ${description}`) }
    catalog.playlists.push(p)
    catalog.playlistById.set(id, p)
    return p
  }

  const spotify = createSpotify({ opt, catalog, originOf: (req) => originOf(req), addUserPlaylist })
  const connectSvc = createConnect({ opt, auth })

  // ---- Handlers. Each returns undefined after sending a response itself. ----

  const handlers = {
    info({ res }) {
      sendJson(res, 200, {
        name: 'Nocturne Mock',
        version: MOCK_VERSION,
        apiVersion: 1,
        capabilities: { lyrics: true, likes: true, scrobble: true, admin: true, sources: ['spotify', 'youtube'], uploadMaxBytes: opt.uploadMaxBytes, playlists: true, spotifyImport: true, connect: true }
      })
    },

    /** GET /v1/updates/{platform}: only when MOCK_UPDATE_VERSION / updateVersion is set (404 otherwise). */
    updates({ res, params }) {
      const platformId = params[0]
      if (!opt.updateVersion || !/^[a-z0-9-]{1,32}$/.test(platformId)) throw new HttpError(404, 'No update feed for this platform.')
      const file = platformId.startsWith('android') ? (platformId === 'android-beta' ? '/nocturne-beta.apk' : '/nocturne.apk') : '/nocturne-windows-x64.zip'
      sendJson(res, 200, { version: opt.updateVersion, url: file, notes: 'Mock update feed.' })
    },

    async login({ req, res }) {
      const cookie = isCookieMode(req)
      if (cookie) assertSameOrigin(req)
      const rate = auth.checkLoginRate(clientIp(req))
      if (!rate.ok) throw new HttpError(429, 'Too many login attempts. Try again later.', { 'Retry-After': String(rate.retryAfter) })
      const body = await readJson(req, { required: true })
      const { username, password } = body
      if (typeof username !== 'string' || typeof password !== 'string' || !username || !password || username.length > 256 || password.length > 1024) {
        throw new HttpError(400, 'username and password are required strings.')
      }
      const user = auth.verifyCredentials(username, password)
      if (!user) throw new HttpError(401, 'Invalid username or password.')
      if (auth.isDisabled(user.id)) throw new HttpError(403, 'This account has been disabled.')
      auth.markLogin(user.id)
      sendSession(req, res, auth.issue(user.id), cookie)
    },

    async refresh({ req, res }) {
      if (isCookieMode(req)) {
        assertSameOrigin(req)
        await readJson(req, { required: false })
        const token = readCookie(req)
        try {
          if (!token) throw new HttpError(401, 'No session cookie. Please sign in.')
          sendSession(req, res, auth.refresh(token), true)
        } catch (err) {
          if (err instanceof HttpError && err.status === 401) err.headers = { ...err.headers, 'Set-Cookie': clearCookie(req) }
          throw err
        }
        return
      }
      const body = await readJson(req, { required: true })
      if (typeof body.refreshToken !== 'string' || !body.refreshToken || body.refreshToken.length > 512) throw new HttpError(400, 'refreshToken is required.')
      sendSession(req, res, auth.refresh(body.refreshToken), false)
    },

    async logout({ req, res }) {
      const cookie = isCookieMode(req)
      if (cookie) assertSameOrigin(req)
      const body = await readJson(req, { required: false })
      const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')
      auth.logout({
        accessToken: m ? m[1] : undefined,
        refreshToken: cookie ? (readCookie(req) ?? undefined) : typeof body.refreshToken === 'string' ? body.refreshToken : undefined
      })
      sendNoContent(res, cookie ? { 'Set-Cookie': clearCookie(req) } : {})
    },

    me({ req, res, user }) {
      sendJson(res, 200, userJson(user, originOf(req)))
    },

    home({ req, res, user }) {
      const ctx = ctxFor(req, user)
      const played = stateFor(user.id).played
      const recentIds = [...new Set([...played, ...catalog.defaults.recentTrackIds])].slice(0, 12)
      const newest = [...catalog.albums].sort((a, b) => b.year - a.year).slice(0, 8)
      sendJson(res, 200, {
        sections: [
          { id: 'recent', title: 'Recently played', kind: 'tracks', items: recentIds.map((id) => trackJson(ctx, catalog.trackById.get(id))) },
          { id: 'albums', title: 'Your albums', kind: 'albums', items: catalog.defaults.libraryAlbumIds.map((id) => albumJson(ctx, catalog.albumById.get(id))) },
          { id: 'artists', title: 'Artists you love', kind: 'artists', items: catalog.defaults.libraryArtistIds.map((id) => artistJson(ctx, catalog.artistById.get(id))) },
          { id: 'made-for-you', title: 'Made for you', kind: 'playlists', items: catalog.playlists.filter((p) => !p.ownerId).map((p) => userPlaylistJson(ctx, p, user)) },
          { id: 'new-releases', title: 'New releases', kind: 'albums', items: newest.map((a) => albumJson(ctx, a)) }
        ]
      })
    },

    search({ req, res, user, query }) {
      const ctx = ctxFor(req, user)
      const raw = query.get('q') ?? ''
      if (raw.length > 200) throw new HttpError(400, '"q" is too long (max 200 characters).')
      const q = fold(raw).trim()
      const typesParam = query.get('types')
      const types = typesParam ? typesParam.split(',').map((s) => s.trim()).filter(Boolean) : SEARCH_TYPES
      for (const t of types) if (!SEARCH_TYPES.includes(t)) throw new HttpError(400, `Unknown search type "${t}". Use: ${SEARCH_TYPES.join(', ')}.`)
      const limit = intParam(query, 'limit', 20, 1, 50)
      const run = (type, list, nameOf, serialize) => {
        if (!q || !types.includes(type)) return []
        return list
          .map((e, i) => ({ e, i, s: matchesText(e, q) ? score(nameOf(e), q) : -1 }))
          .filter((x) => x.s >= 0)
          .sort((a, b) => a.s - b.s || a.i - b.i)
          .slice(0, limit)
          .map((x) => serialize(x.e))
      }
      sendJson(res, 200, {
        tracks: run('track', catalog.tracks, (t) => t.title, (t) => trackJson(ctx, t)),
        albums: run('album', catalog.albums, (a) => a.title, (a) => albumJson(ctx, a)),
        artists: run('artist', catalog.artists, (a) => a.name, (a) => artistJson(ctx, a)),
        playlists: run('playlist', visiblePlaylists(user), (p) => p.name, (p) => userPlaylistJson(ctx, p, user))
      })
    },

    libraryTracks({ req, res, user, query }) {
      const ctx = ctxFor(req, user)
      sendJson(res, 200, page(stateFor(user.id).liked, query, (id) => trackJson(ctx, catalog.trackById.get(id))))
    },
    /** GET /v1/library/songs: every track on the server (the Library "Songs" tab), in catalog order. */
    librarySongs({ req, res, user, query }) {
      const ctx = ctxFor(req, user)
      sendJson(res, 200, page(catalog.tracks.map((t) => t.id), query, (id) => trackJson(ctx, catalog.trackById.get(id))))
    },
    libraryAlbums({ req, res, user, query }) {
      const ctx = ctxFor(req, user)
      sendJson(res, 200, page(catalog.defaults.libraryAlbumIds, query, (id) => albumJson(ctx, catalog.albumById.get(id))))
    },
    libraryArtists({ req, res, user, query }) {
      const ctx = ctxFor(req, user)
      sendJson(res, 200, page(catalog.defaults.libraryArtistIds, query, (id) => artistJson(ctx, catalog.artistById.get(id))))
    },
    libraryPlaylists({ req, res, user, query }) {
      const ctx = ctxFor(req, user)
      // The user's own playlists (newest first), then the shared ones.
      const own = catalog.playlists.filter((p) => p.ownerId === user.id).sort((a, b) => b.createdSeq - a.createdSeq).map((p) => p.id)
      const shared = catalog.defaults.libraryPlaylistIds.filter((id) => catalog.playlistById.has(id))
      sendJson(res, 200, page([...own, ...shared], query, (id) => userPlaylistJson(ctx, catalog.playlistById.get(id), user)))
    },

    album({ req, res, user, params }) {
      const a = catalog.albumById.get(params[0])
      if (!a) throw new HttpError(404, 'Album not found.')
      sendJson(res, 200, albumDetailJson(ctxFor(req, user), a))
    },
    artist({ req, res, user, params }) {
      const a = catalog.artistById.get(params[0])
      if (!a) throw new HttpError(404, 'Artist not found.')
      sendJson(res, 200, artistDetailJson(ctxFor(req, user), a))
    },
    playlist({ req, res, user, params }) {
      const p = catalog.playlistById.get(params[0])
      if (!visiblePlaylist(p, user)) throw new HttpError(404, 'Playlist not found.')
      sendJson(res, 200, userPlaylistDetailJson(ctxFor(req, user), p, user))
    },

    /** POST /v1/playlists {name, description?, trackIds?} → 201 PlaylistDetail */
    async createPlaylist({ req, res, user }) {
      const body = await readJson(req, { required: true })
      const name = playlistText(body, 'name', 100, { required: true })
      const description = playlistText(body, 'description', 300, { required: false }) ?? ''
      const trackIds = [...new Set(trackIdList(body, { required: false }))]
      const p = addUserPlaylist(user, name, description, trackIds)
      sendJson(res, 201, userPlaylistDetailJson(ctxFor(req, user), p, user))
    },
    /** PATCH /v1/playlists/:id {name?, description?} → Playlist */
    async updatePlaylist({ req, res, user, params }) {
      const p = ownPlaylist(params[0], user)
      const body = await readJson(req, { required: true })
      const name = playlistText(body, 'name', 100, { required: false })
      const description = playlistText(body, 'description', 300, { required: false })
      if (name === '') throw new HttpError(400, '"name" cannot be empty.')
      if (name !== undefined) p.name = name
      if (description !== undefined) p.description = description
      p.search = fold(`${p.name} ${p.description}`)
      sendJson(res, 200, userPlaylistJson(ctxFor(req, user), p, user))
    },
    /** DELETE /v1/playlists/:id → 204 */
    deletePlaylist({ res, user, params }) {
      const p = ownPlaylist(params[0], user)
      catalog.playlists.splice(catalog.playlists.indexOf(p), 1)
      catalog.playlistById.delete(p.id)
      sendNoContent(res)
    },
    /**
     * POST /v1/playlists/:id/tracks {trackIds, allowDuplicates?} → {added, skipped, playlist}.
     * Without `allowDuplicates`, songs already present (or repeated in the request) are skipped;
     * with it, every id is appended as a new entry.
     */
    async addPlaylistTracks({ req, res, user, params }) {
      const p = ownPlaylist(params[0], user)
      const body = await readJson(req, { required: true })
      const ids = trackIdList(body, { required: true })
      if (ids.length === 0) throw new HttpError(400, '"trackIds" must not be empty.')
      if (body.allowDuplicates !== undefined && typeof body.allowDuplicates !== 'boolean') throw new HttpError(400, '"allowDuplicates" must be a boolean.')
      const allow = body.allowDuplicates === true
      const entries = entriesOf(p)
      const skipped = []
      let added = 0
      for (const id of ids) {
        if (!allow && entries.some((e) => e.trackId === id)) skipped.push(id)
        else {
          entries.push({ trackId: id, entryId: newEntryId() })
          added++
        }
      }
      setEntries(p, entries)
      sendJson(res, 200, { added, skipped, playlist: userPlaylistJson(ctxFor(req, user), p, user) })
    },
    /** DELETE /v1/playlists/:id/tracks/:trackId → 204; removes every occurrence of the song. */
    removePlaylistTrack({ res, user, params }) {
      const p = ownPlaylist(params[0], user)
      if (!p.trackIds.includes(params[1])) throw new HttpError(404, 'That song is not in this playlist.')
      setEntries(p, entriesOf(p).filter((e) => e.trackId !== params[1]))
      sendNoContent(res)
    },
    /** DELETE /v1/playlists/:id/entries/:entryId → 204; removes that one occurrence. */
    removePlaylistEntry({ res, user, params }) {
      const p = ownPlaylist(params[0], user)
      const entries = entriesOf(p)
      const i = entries.findIndex((e) => e.entryId === params[1])
      if (i < 0) throw new HttpError(404, 'That entry is not in this playlist.')
      entries.splice(i, 1)
      setEntries(p, entries)
      sendNoContent(res)
    },
    /**
     * PUT /v1/playlists/:id/tracks → PlaylistDetail. Body is either {entryIds} (a permutation of the
     * current entry ids) or the legacy {trackIds} (a permutation of the current songs, duplicates
     * included; occurrences of the same song keep their relative order).
     */
    async reorderPlaylist({ req, res, user, params }) {
      const p = ownPlaylist(params[0], user)
      const body = await readJson(req, { required: true })
      const entries = entriesOf(p)
      if (body.entryIds !== undefined) {
        const v = body.entryIds
        if (!Array.isArray(v) || v.length > 5000 || v.some((id) => typeof id !== 'string')) throw new HttpError(400, '"entryIds" must be an array of entry ids.')
        const byId = new Map(entries.map((e) => [e.entryId, e]))
        if (v.length !== entries.length || new Set(v).size !== v.length || v.some((id) => !byId.has(id))) {
          throw new HttpError(400, '"entryIds" must contain exactly the entries already in the playlist.')
        }
        setEntries(p, v.map((id) => byId.get(id)))
      } else {
        const ids = trackIdList(body, { required: true })
        const a = [...ids].sort()
        const b = [...p.trackIds].sort()
        if (a.length !== b.length || a.some((x, i) => x !== b[i])) throw new HttpError(400, '"trackIds" must contain exactly the songs already in the playlist.')
        const pool = new Map()
        for (const e of entries) {
          if (!pool.has(e.trackId)) pool.set(e.trackId, [])
          pool.get(e.trackId).push(e)
        }
        setEntries(p, ids.map((id) => pool.get(id).shift()))
      }
      sendJson(res, 200, userPlaylistDetailJson(ctxFor(req, user), p, user))
    },

    /** GET /v1/library/tracks/{id}: one track (used by Connect receivers to resolve ids). */
    track({ req, res, user, params }) {
      const t = catalog.trackById.get(params[0])
      if (!t) throw new HttpError(404, 'Track not found.')
      sendJson(res, 200, trackJson(ctxFor(req, user), t))
    },
    like({ res, user, params }) {
      if (!catalog.trackById.has(params[0])) throw new HttpError(404, 'Track not found.')
      const s = stateFor(user.id)
      if (!s.liked.includes(params[0])) s.liked.unshift(params[0])
      sendNoContent(res)
    },
    unlike({ res, user, params }) {
      if (!catalog.trackById.has(params[0])) throw new HttpError(404, 'Track not found.')
      const s = stateFor(user.id)
      s.liked = s.liked.filter((id) => id !== params[0])
      sendNoContent(res)
    },

    stream({ req, res, params }) {
      const track = catalog.trackById.get(params[0])
      if (!track) throw new HttpError(404, 'Track not found.')
      const expSeconds = Math.floor(opt.now() / 1000) + opt.streamTtl
      const url = `${originOf(req)}/media/${encodeURIComponent(track.id)}?exp=${expSeconds}&sig=${sign(track.id, expSeconds)}`
      const stored = catalog.uploads.has(track.id)
      sendJson(res, 200, {
        url,
        expiresAt: new Date(expSeconds * 1000).toISOString(),
        mimeType: track.mime,
        ...(stored ? {} : { bitrate: 352 })
      })
    },

    lyrics({ res, params }) {
      const track = catalog.trackById.get(params[0])
      if (!track) throw new HttpError(404, 'Track not found.')
      const stored = track.lyricsStored
      if (stored?.format === 'ttml') {
        sendJson(res, 200, { synced: null, plain: plainFromTtml(stored.content), ttml: stored.content })
      } else if (stored?.format === 'lrc') {
        sendJson(res, 200, { synced: stored.content, plain: plainFromLrc(stored.content), ttml: null })
      } else {
        sendJson(res, 200, { ...lyricsFor(track), ttml: null })
      }
    },

    async played({ req, res, user, params }) {
      const track = catalog.trackById.get(params[0])
      if (!track) throw new HttpError(404, 'Track not found.')
      const body = await readJson(req, { required: true })
      const { playedSeconds, at } = body
      if (typeof playedSeconds !== 'number' || !Number.isFinite(playedSeconds) || playedSeconds < 0 || playedSeconds > 86_400) {
        throw new HttpError(400, '"playedSeconds" must be a number between 0 and 86400.')
      }
      if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) throw new HttpError(400, '"at" must be an ISO 8601 timestamp.')
      if (playedSeconds >= 1) {
        const s = stateFor(user.id)
        s.played = [track.id, ...s.played.filter((id) => id !== track.id)].slice(0, 50)
        track.plays++
      }
      sendNoContent(res)
    },

    media({ req, res, params, query }) {
      const id = params[0]
      const expRaw = query.get('exp') ?? ''
      const sig = query.get('sig') ?? ''
      const valid =
        /^\d{1,12}$/.test(expRaw) &&
        /^[0-9a-f]{64}$/.test(sig) &&
        timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(sign(id, expRaw), 'hex')) &&
        Number(expRaw) * 1000 > opt.now()
      if (!valid) throw new HttpError(403, 'Invalid or expired stream URL.')
      const track = catalog.trackById.get(id)
      if (!track) throw new HttpError(404, 'Track not found.')
      const wav = catalog.uploads.get(track.id)?.data ?? audio.get(track)
      const size = wav.length
      const base = {
        ...SECURITY_HEADERS,
        'Content-Type': track.mime,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=300',
        'Cross-Origin-Resource-Policy': 'cross-origin'
      }
      const range = parseRange(req.headers.range, size)
      if (range.kind === 'invalid') {
        const payload = Buffer.from(JSON.stringify({ message: 'Requested range not satisfiable.' }))
        res.writeHead(416, { ...base, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Range': `bytes */${size}`, 'Content-Length': payload.length })
        res.end(payload)
        return
      }
      if (range.kind === 'range') {
        res.writeHead(206, { ...base, 'Content-Range': `bytes ${range.start}-${range.end}/${size}`, 'Content-Length': range.end - range.start + 1 })
        res.end(req.method === 'HEAD' ? undefined : wav.subarray(range.start, range.end + 1))
        return
      }
      res.writeHead(200, { ...base, 'Content-Length': size })
      res.end(req.method === 'HEAD' ? undefined : wav)
    },

    art({ req, res, params, query }) {
      const [kind, id] = params
      let label
      if (kind === 'album') {
        const a = catalog.albumById.get(id)
        if (a) label = { title: a.title, subtitle: catalog.artistById.get(a.artistId).name }
      } else if (kind === 'artist') {
        const a = catalog.artistById.get(id)
        if (a) label = { title: a.name }
      } else if (kind === 'playlist') {
        const p = catalog.playlistById.get(id)
        if (p) label = { title: p.name }
      } else if (kind === 'source') {
        try {
          const item = itemFromResultId(id)
          label = { title: item.title, subtitle: item.artist }
        } catch {
          label = null
        }
      } else if (kind === 'spotify') {
        label = spotify.artLabel(id)
      } else if (kind === 'user') {
        const u = auth.userById(id)
        if (u) label = { title: u.displayName }
      }
      if (!label) throw new HttpError(404, 'Artwork not found.')
      const s = Number(query.get('s'))
      const size = Number.isInteger(s) && s >= 32 && s <= 2048 ? s : 640
      const svg = Buffer.from(renderArt(kind, id, label, size))
      const etag = `"${createHash('sha256').update(svg).digest('hex').slice(0, 32)}"`
      const headers = {
        ...SECURITY_HEADERS,
        ETag: etag,
        'Cache-Control': 'public, max-age=86400, immutable',
        'Cross-Origin-Resource-Policy': 'cross-origin'
      }
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers)
        res.end()
        return
      }
      res.writeHead(200, { ...headers, 'Content-Type': 'image/svg+xml; charset=utf-8', 'Content-Length': svg.length })
      res.end(req.method === 'HEAD' ? undefined : svg)
    }
  }

  /** Sends a Session. In cookie mode the refresh token travels only in the HttpOnly cookie. */
  function sendSession(req, res, session, cookie) {
    const body = { ...session, user: userJson(session.user, originOf(req)) }
    if (!cookie) return sendJson(res, 200, body)
    sendJson(res, 200, { ...body, refreshToken: '' }, { 'Set-Cookie': setCookie(req, session.refreshToken) })
  }

  const admin = createAdmin({ opt, auth, lib: catalog, jobs, userState, ctxFor, originOf })

  // [methods, regex, handler, needsAuth] (needsAuth 'admin' additionally requires the admin role)
  const routes = [
    [['GET'], /^\/v1\/info$/, handlers.info, false],
    [['GET'], /^\/v1\/updates\/([^/]+)$/, handlers.updates, false],
    [['POST'], /^\/v1\/auth\/login$/, handlers.login, false],
    [['POST'], /^\/v1\/auth\/refresh$/, handlers.refresh, false],
    [['POST'], /^\/v1\/auth\/logout$/, handlers.logout, false],
    [['GET'], /^\/v1\/me$/, handlers.me, true],
    [['GET'], /^\/v1\/home$/, handlers.home, true],
    [['GET'], /^\/v1\/search$/, handlers.search, true],
    [['GET'], /^\/v1\/library\/tracks$/, handlers.libraryTracks, true],
    [['GET'], /^\/v1\/library\/songs$/, handlers.librarySongs, true],
    [['GET'], /^\/v1\/library\/albums$/, handlers.libraryAlbums, true],
    [['GET'], /^\/v1\/library\/artists$/, handlers.libraryArtists, true],
    [['GET'], /^\/v1\/library\/playlists$/, handlers.libraryPlaylists, true],
    [['GET'], /^\/v1\/library\/tracks\/([^/]+)$/, handlers.track, true],
    [['PUT'], /^\/v1\/library\/tracks\/([^/]+)$/, handlers.like, true],
    [['DELETE'], /^\/v1\/library\/tracks\/([^/]+)$/, handlers.unlike, true],
    [['GET'], /^\/v1\/albums\/([^/]+)$/, handlers.album, true],
    [['GET'], /^\/v1\/artists\/([^/]+)$/, handlers.artist, true],
    [['POST'], /^\/v1\/playlists$/, handlers.createPlaylist, true],
    [['GET'], /^\/v1\/playlists\/([^/]+)$/, handlers.playlist, true],
    [['PATCH'], /^\/v1\/playlists\/([^/]+)$/, handlers.updatePlaylist, true],
    [['DELETE'], /^\/v1\/playlists\/([^/]+)$/, handlers.deletePlaylist, true],
    [['POST', 'PUT'], /^\/v1\/playlists\/([^/]+)\/tracks$/, (c) => (c.req.method === 'PUT' ? handlers.reorderPlaylist(c) : handlers.addPlaylistTracks(c)), true],
    [['DELETE'], /^\/v1\/playlists\/([^/]+)\/tracks\/([^/]+)$/, handlers.removePlaylistTrack, true],
    [['DELETE'], /^\/v1\/playlists\/([^/]+)\/entries\/([^/]+)$/, handlers.removePlaylistEntry, true],
    [['GET'], /^\/v1\/tracks\/([^/]+)\/stream$/, handlers.stream, true],
    [['GET'], /^\/v1\/tracks\/([^/]+)\/lyrics$/, handlers.lyrics, true],
    [['POST'], /^\/v1\/tracks\/([^/]+)\/played$/, handlers.played, true],
    [['GET'], /^\/media\/([^/]+)$/, handlers.media, false],
    [['GET'], /^\/art\/(album|artist|playlist|user|source|spotify)\/([^/]+)\.svg$/, handlers.art, false],
    ...spotify.routes,
    ...connectSvc.routes,
    ...admin.routes.map(([methods, re, handler]) => [methods, re, handler, 'admin'])
  ]

  async function handle(req, res) {
    const corsOk = applyCors(req, res)
    const url = new URL(req.url ?? '/', 'http://mock.invalid')
    const method = req.method === 'HEAD' ? 'GET' : req.method

    if (req.method === 'OPTIONS') {
      if (!corsOk) return sendJson(res, 403, { message: 'Origin not allowed.' })
      return sendNoContent(res, {
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Range, If-None-Match, Accept, X-Nocturne-Session',
        'Access-Control-Max-Age': '600'
      })
    }

    if (staticRoot && !isApiPath(url.pathname)) {
      await serveStatic(staticRoot, req, res, url.pathname)
      return
    }

    let matched = null
    const allowed = new Set()
    for (const [methods, re, handler, needsAuth] of routes) {
      const m = re.exec(url.pathname)
      if (!m) continue
      for (const x of methods) allowed.add(x)
      if (methods.includes(method) && !matched) matched = { handler, needsAuth, groups: m.slice(1) }
    }
    if (!matched) {
      if (allowed.size > 0) throw new HttpError(405, 'Method not allowed.', { Allow: [...allowed, 'OPTIONS'].join(', ') })
      throw new HttpError(404, 'Not found.')
    }

    let params
    try {
      params = matched.groups.map(decodeURIComponent)
    } catch {
      throw new HttpError(400, 'Malformed URL encoding.')
    }

    let user = null
    if (matched.needsAuth) {
      const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')
      if (!m) throw new HttpError(401, 'Missing bearer token.', { 'WWW-Authenticate': 'Bearer' })
      user = auth.authenticate(m[1]).user
      if (matched.needsAuth === 'admin' && user.role !== 'admin') throw new HttpError(403, 'Administrator access is required.')
    }
    await matched.handler({ req, res, params, query: url.searchParams, user })
  }

  const server = createServer((req, res) => {
    const started = process.hrtime.bigint()
    if (!opt.quiet) {
      res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6
        opt.log(`${req.method} ${(req.url ?? '').split('?')[0]} ${res.statusCode} ${ms.toFixed(0)}ms`)
      })
    }
    handle(req, res).catch((err) => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { message: err.message }, err.headers)
      } else {
        if (!opt.quiet) opt.log(`ERROR ${req.method} ${(req.url ?? '').split('?')[0]}: ${err && err.stack ? err.stack : err}`)
        sendJson(res, 500, { message: 'Internal server error.' })
      }
    })
  })
  server.requestTimeout = 30_000

  let listeningUrl = null

  return {
    server,
    catalog,
    users: auth.allUsers(),
    get url() {
      return listeningUrl
    },
    listen(port = opt.port, host = opt.host) {
      return new Promise((resolve, reject) => {
        const onError = (err) => reject(err)
        server.once('error', onError)
        server.listen(port, host, () => {
          server.off('error', onError)
          const addr = server.address()
          const shown = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
          listeningUrl = `http://${shown.includes(':') ? `[${shown}]` : shown}:${addr.port}`
          boundOrigin = listeningUrl
          resolve({ url: listeningUrl, port: addr.port, host })
        })
      })
    },
    jobs,
    /** Runs `n` job ticks synchronously (useful with jobTickMs: 0). */
    advanceJobs(n = 1) {
      for (let i = 0; i < n; i++) jobs.tick()
    },
    /** Runs `n` Spotify import steps synchronously (useful with jobTickMs: 0). */
    advanceSpotify(n = 1) {
      for (let i = 0; i < n; i++) spotify.tick()
    },
    spotify,
    connect: connectSvc,
    close() {
      jobs.stop()
      spotify.stop()
      connectSvc.stop()
      return new Promise((resolve) => {
        if (!server.listening) return resolve()
        server.close(() => resolve())
        server.closeAllConnections()
      })
    }
  }
}

// ---- CLI -------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const mock = createMockServer()
    const { url } = await mock.listen()
    const usingDefaults = !process.env.MOCK_USERS
    console.log(`Nocturne mock server (API v1) listening on ${url}`)
    console.log(
      usingDefaults
        ? 'Demo credentials: demo / demo (admin), guest / guestguest (user)'
        : `Users: ${mock.users.map((u) => `${u.username} (${u.role})`).join(', ')} (passwords from MOCK_USERS)`
    )
    if (!mock.users.some((u) => u.role === 'admin')) console.log('Warning: no admin user defined; use MOCK_USERS="name:password:admin" to reach the Admin API.')
    if (process.env.MOCK_STATIC_DIR) console.log(`Serving static files from ${process.env.MOCK_STATIC_DIR} at ${url}/`)
    const stop = () => {
      mock.close().then(() => process.exit(0))
      setTimeout(() => process.exit(0), 2000).unref()
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  } catch (err) {
    console.error(`Failed to start mock server: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }
}
