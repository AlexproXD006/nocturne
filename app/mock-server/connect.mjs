// Nocturne Connect (capabilities.connect) for the mock server: per-user sessions, reported
// playback state, commands pushed to a session's SSE stream. Mirrors routes_connect.py,
// including the command payload validation (playContext / addToQueue / playNext bounds).

import { randomBytes } from 'node:crypto'
import { HttpError } from './auth.mjs'
import { SECURITY_HEADERS, readJson, sendJson, sendNoContent } from './http.mjs'

export const COMMAND_KINDS = new Set([
  'play', 'pause', 'toggle', 'next', 'previous', 'seek', 'setShuffle', 'setRepeat', 'setVolume', 'stop', 'transferTo',
  'playContext', 'addToQueue', 'playNext'
])
export const MAX_TRACK_IDS = 5000
const MAX_TRACK_ID_LEN = 128
const MAX_PAYLOAD_BYTES = 256 * 1024
const CONTEXT_TYPES = new Set(['album', 'playlist', 'artist', 'search', 'library', 'home', 'tracks'])
const SESSION_TTL_MS = 60_000

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v)

function trackIds(payload) {
  const ids = payload.trackIds
  if (!Array.isArray(ids) || ids.length === 0) throw new HttpError(400, '"trackIds" must be a non-empty array of track ids.')
  if (ids.length > MAX_TRACK_IDS) throw new HttpError(400, `"trackIds" can hold at most ${MAX_TRACK_IDS} ids.`)
  if (ids.some((t) => typeof t !== 'string' || !t || t.length > MAX_TRACK_ID_LEN)) throw new HttpError(400, '"trackIds" must contain non-empty strings.')
  return ids
}

/** Validates a command payload (throws 400), mirroring the real server. */
export function validatePayload(kind, payload) {
  if (JSON.stringify(payload).length > MAX_PAYLOAD_BYTES) throw new HttpError(400, 'Command payload is too large.')
  switch (kind) {
    case 'seek':
      if (!isNumber(payload.position) || payload.position < 0) throw new HttpError(400, '"position" must be a number of seconds >= 0.')
      break
    case 'setVolume': {
      const { volume, muted } = payload
      if (volume === undefined && muted === undefined) throw new HttpError(400, '"volume" or "muted" is required.')
      if (volume !== undefined && (!isNumber(volume) || volume < 0 || volume > 1)) throw new HttpError(400, '"volume" must be a number between 0 and 1.')
      if (muted !== undefined && typeof muted !== 'boolean') throw new HttpError(400, '"muted" must be a boolean.')
      break
    }
    case 'setShuffle':
      if (typeof payload.on !== 'boolean') throw new HttpError(400, '"on" must be a boolean.')
      break
    case 'setRepeat':
      if (!['off', 'all', 'one'].includes(payload.mode)) throw new HttpError(400, '"mode" must be off, all or one.')
      break
    case 'playContext': {
      const ids = trackIds(payload)
      const start = payload.startIndex ?? 0
      if (!Number.isInteger(start) || start < 0 || start >= ids.length) throw new HttpError(400, '"startIndex" must be an index into "trackIds".')
      if (payload.shuffle !== undefined && typeof payload.shuffle !== 'boolean') throw new HttpError(400, '"shuffle" must be a boolean.')
      const ctx = payload.context
      if (ctx !== undefined) {
        if (!ctx || typeof ctx !== 'object' || !CONTEXT_TYPES.has(ctx.type)) throw new HttpError(400, '"context.type" is not a known context type.')
        for (const [key, limit] of [['id', 256], ['name', 300]]) {
          const v = ctx[key]
          if (v !== undefined && (typeof v !== 'string' || v.length > limit)) throw new HttpError(400, `"context.${key}" must be a string of at most ${limit} characters.`)
        }
      }
      break
    }
    case 'addToQueue':
    case 'playNext':
      trackIds(payload)
      break
  }
  return payload
}

export function createConnect({ opt, auth }) {
  /** id -> { id, userId, name, platform, controllable, state, lastSeen, createdAt } */
  const sessions = new Map()
  /** id -> Set<res> (live SSE listeners) */
  const listeners = new Map()

  const online = (id) => (listeners.get(id)?.size ?? 0) > 0
  const wire = (s) => ({
    id: s.id, name: s.name, platform: s.platform, controllable: s.controllable, state: s.state,
    online: online(s.id), lastSeenAt: new Date(s.lastSeen).toISOString()
  })
  function push(id, event) {
    const set = listeners.get(id)
    if (!set || set.size === 0) return false
    const line = `data: ${JSON.stringify(event)}\n\n`
    for (const res of set) res.write(line)
    return true
  }
  function own(id, user) {
    const s = sessions.get(id)
    if (!s || s.userId !== user.id) throw new HttpError(404, 'Session not found.')
    return s
  }
  function prune(userId) {
    const cutoff = opt.now() - SESSION_TTL_MS
    for (const s of sessions.values()) if (s.userId === userId && !online(s.id) && s.lastSeen < cutoff) sessions.delete(s.id)
  }

  const handlers = {
    async register({ req, res, user }) {
      const body = await readJson(req, { required: true })
      const name = (typeof body.name === 'string' ? body.name : '').trim().slice(0, 80) || 'Nocturne'
      const platform = (typeof body.platform === 'string' ? body.platform : 'web').trim().slice(0, 32) || 'web'
      const now = opt.now()
      const s = { id: `cs_${randomBytes(12).toString('hex')}`, userId: user.id, name, platform, controllable: body.controllable !== false, state: {}, lastSeen: now, createdAt: now }
      sessions.set(s.id, s)
      sendJson(res, 201, wire(s))
    },
    list({ res, user }) {
      prune(user.id)
      const mine = [...sessions.values()].filter((s) => s.userId === user.id).sort((a, b) => a.createdAt - b.createdAt)
      sendJson(res, 200, { sessions: mine.map(wire) })
    },
    remove({ res, user, params }) {
      own(params[0], user)
      sessions.delete(params[0])
      push(params[0], { type: 'closed' })
      sendNoContent(res)
    },
    async rename({ req, res, user, params }) {
      const s = own(params[0], user)
      const body = await readJson(req, { required: true })
      const name = (typeof body.name === 'string' ? body.name : '').trim().slice(0, 80)
      if (!name) throw new HttpError(400, '"name" is required.')
      s.name = name
      sendNoContent(res)
    },
    async state({ req, res, user, params }) {
      const s = own(params[0], user)
      const body = await readJson(req, { required: true })
      if (!body.state || typeof body.state !== 'object' || Array.isArray(body.state)) throw new HttpError(400, '"state" must be an object.')
      s.state = body.state
      s.lastSeen = opt.now()
      const event = { type: 'state', sessionId: s.id, state: s.state }
      push(s.id, event)
      for (const other of sessions.values()) if (other.userId === user.id && other.id !== s.id) push(other.id, event)
      sendNoContent(res)
    },
    heartbeat({ res, user, params }) {
      own(params[0], user).lastSeen = opt.now()
      sendNoContent(res)
    },
    async command({ req, res, user, params }) {
      const body = await readJson(req, { required: true, max: 512 * 1024 })
      if (!COMMAND_KINDS.has(body.kind)) throw new HttpError(400, 'Unknown command.')
      const s = own(params[0], user)
      if (!s.controllable) throw new HttpError(409, 'This device cannot be controlled.')
      const raw = body.payload ?? {}
      if (typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, '"payload" must be an object.')
      const payload = validatePayload(body.kind, raw)
      if (!push(s.id, { type: 'command', kind: body.kind, payload })) throw new HttpError(409, 'That device is offline.')
      sendJson(res, 202, { delivered: true })
    },
    /** SSE: EventSource cannot send headers, so the access token may come as ?access_token=. */
    events({ req, res, params, query }) {
      const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')
      const token = query.get('access_token') || m?.[1]
      if (!token) throw new HttpError(401, 'Missing bearer token.')
      const { user } = auth.authenticate(token)
      const s = own(params[0], user)
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
      res.write(': connected\n\n')
      if (!listeners.has(s.id)) listeners.set(s.id, new Set())
      listeners.get(s.id).add(res)
      const ping = setInterval(() => res.write(': ping\n\n'), 20_000)
      ping.unref?.()
      req.on('close', () => {
        clearInterval(ping)
        listeners.get(s.id)?.delete(res)
        if (listeners.get(s.id)?.size === 0) listeners.delete(s.id)
      })
    }
  }

  const routes = [
    [['GET'], /^\/v1\/connect\/sessions$/, handlers.list, true],
    [['POST'], /^\/v1\/connect\/sessions$/, handlers.register, true],
    [['DELETE'], /^\/v1\/connect\/sessions\/([^/]+)$/, handlers.remove, true],
    [['PATCH'], /^\/v1\/connect\/sessions\/([^/]+)$/, handlers.rename, true],
    [['PUT'], /^\/v1\/connect\/sessions\/([^/]+)\/state$/, handlers.state, true],
    [['POST'], /^\/v1\/connect\/sessions\/([^/]+)\/heartbeat$/, handlers.heartbeat, true],
    [['POST'], /^\/v1\/connect\/sessions\/([^/]+)\/commands$/, handlers.command, true],
    [['GET'], /^\/v1\/connect\/sessions\/([^/]+)\/events$/, handlers.events, false]
  ]

  return {
    routes,
    sessions,
    stop() {
      for (const set of listeners.values()) for (const res of set) res.end()
      listeners.clear()
    }
  }
}
