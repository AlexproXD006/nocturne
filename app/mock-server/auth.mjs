// Users, token issuing/rotation and login rate limiting (all in memory).

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { capitalize, slugify } from './util.mjs'

const sha256 = (s) => createHash('sha256').update(s).digest()
const sha256hex = (s) => createHash('sha256').update(s).digest('hex')

export const ROLES = ['admin', 'user']

/**
 * Parses "user:pass[:role],other:secret:admin". The password may contain ':'; the last
 * segment is only taken as the role when it is exactly "admin" or "user" (case-insensitive).
 * Without a role the user is a regular "user".
 */
export function parseUsers(spec) {
  const users = []
  for (const part of String(spec).split(',')) {
    const entry = part.trim()
    if (!entry) continue
    const i = entry.indexOf(':')
    if (i <= 0 || i === entry.length - 1) throw new Error(`Invalid MOCK_USERS entry "${entry.split(':')[0]}": expected username:password[:role]`)
    const username = entry.slice(0, i)
    let password = entry.slice(i + 1)
    let role = 'user'
    const j = password.lastIndexOf(':')
    if (j > 0 && ROLES.includes(password.slice(j + 1).toLowerCase())) {
      role = password.slice(j + 1).toLowerCase()
      password = password.slice(0, j)
    }
    users.push({ username, password, role })
  }
  if (users.length === 0) throw new Error('MOCK_USERS must define at least one username:password[:role] entry')
  return users
}

export class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message)
    this.status = status
    this.headers = headers
  }
}

export const USERNAME_RE = /^[a-z0-9_.-]{3,32}$/
export const MIN_PASSWORD = 10

export class AuthService {
  /**
   * @param {{users:{username:string,password:string,role?:'admin'|'user'}[], accessTtl:number, refreshTtl:number, now:()=>number, loginLimit:{max:number, windowMs:number}}} opts
   */
  constructor(opts) {
    this.now = opts.now
    this.accessTtl = opts.accessTtl
    this.refreshTtl = opts.refreshTtl
    this.loginLimit = opts.loginLimit
    this.salt = randomBytes(16)
    this.dummy = this.#hash('dummy-password')
    this.users = new Map() // lowercase username -> entry
    for (const u of opts.users) {
      const key = u.username.toLowerCase()
      if (this.users.has(key)) throw new Error(`Duplicate user "${u.username}"`)
      const role = u.role ?? 'user'
      if (!ROLES.includes(role)) throw new Error(`Invalid role "${role}" for user "${u.username}"`)
      this.users.set(key, this.#entry(u.username, u.password, role, u.displayName))
    }
    this.access = new Map() // sha256hex(token) -> { userId, family, exp }
    this.refreshTokens = new Map() // sha256hex(token) -> { userId, family, exp, used }
    this.families = new Map() // family -> { userId, revoked }
    this.attempts = new Map() // ip -> number[]
    this.issued = 0
  }

  #hash(password) {
    return createHash('sha256').update(this.salt).update(password).digest()
  }

  #uniqueId(username) {
    const base = `u-${slugify(username) || sha256hex(username).slice(0, 8)}`
    const taken = new Set([...this.users.values()].map((e) => e.user.id))
    let id = base
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
    return id
  }

  #entry(username, password, role, displayName) {
    return {
      user: { id: this.#uniqueId(username), username, displayName: displayName || capitalize(username), role },
      hash: this.#hash(password),
      disabled: false,
      createdAt: new Date(this.now()).toISOString(),
      lastLoginAt: null
    }
  }

  userById(id) {
    for (const { user } of this.users.values()) if (user.id === id) return user
    return null
  }

  entryById(id) {
    for (const e of this.users.values()) if (e.user.id === id) return e
    return null
  }

  allUsers() {
    return [...this.users.values()].map((u) => u.user)
  }

  allEntries() {
    return [...this.users.values()]
  }

  /** Returns the user for valid credentials (even if disabled; check isDisabled), otherwise null. Constant-time on the hash comparison. */
  verifyCredentials(username, password) {
    const entry = this.users.get(String(username).toLowerCase())
    const expected = entry ? entry.hash : this.dummy
    const ok = timingSafeEqual(this.#hash(password), expected)
    return entry && ok ? entry.user : null
  }

  isDisabled(userId) {
    return this.entryById(userId)?.disabled === true
  }

  markLogin(userId) {
    const e = this.entryById(userId)
    if (e) e.lastLoginAt = new Date(this.now()).toISOString()
  }

  /** Counts a login attempt; returns {ok:true} or {ok:false, retryAfter}. */
  checkLoginRate(ip) {
    const { max, windowMs } = this.loginLimit
    if (!(max > 0)) return { ok: true }
    const now = this.now()
    const list = (this.attempts.get(ip) ?? []).filter((t) => now - t < windowMs)
    if (list.length >= max) {
      this.attempts.set(ip, list)
      return { ok: false, retryAfter: Math.max(1, Math.ceil((list[0] + windowMs - now) / 1000)) }
    }
    list.push(now)
    this.attempts.set(ip, list)
    if (this.attempts.size > 1000) {
      for (const [k, v] of this.attempts) if (!v.some((t) => now - t < windowMs)) this.attempts.delete(k)
    }
    return { ok: true }
  }

  #prune() {
    const now = this.now()
    for (const [k, v] of this.access) if (v.exp <= now) this.access.delete(k)
    for (const [k, v] of this.refreshTokens) if (v.exp <= now) this.refreshTokens.delete(k)
    for (const [fam] of this.families) {
      let live = false
      for (const v of this.refreshTokens.values()) if (v.family === fam) { live = true; break }
      if (!live) this.families.delete(fam)
    }
  }

  /** Issues a new access/refresh pair in the given (or a new) token family. */
  issue(userId, family = randomBytes(12).toString('hex')) {
    if (++this.issued % 200 === 0) this.#prune()
    const now = this.now()
    const accessToken = randomBytes(32).toString('hex')
    const refreshToken = randomBytes(32).toString('hex')
    this.access.set(sha256hex(accessToken), { userId, family, exp: now + this.accessTtl * 1000 })
    this.refreshTokens.set(sha256hex(refreshToken), { userId, family, exp: now + this.refreshTtl * 1000, used: false })
    if (!this.families.has(family)) this.families.set(family, { userId, revoked: false })
    return { accessToken, refreshToken, expiresIn: this.accessTtl, user: this.userById(userId) }
  }

  #revokeFamily(family) {
    const f = this.families.get(family)
    if (f) f.revoked = true
    for (const [k, v] of this.access) if (v.family === family) this.access.delete(k)
  }

  /** Revokes every session (token family) of a user. */
  revokeUser(userId) {
    for (const [fam, f] of this.families) if (f.userId === userId) this.#revokeFamily(fam)
    for (const [k, v] of this.access) if (v.userId === userId) this.access.delete(k)
    for (const [k, v] of this.refreshTokens) if (v.userId === userId) this.refreshTokens.delete(k)
  }

  /** Rotates a refresh token. Reuse of a consumed token revokes the whole family. */
  refresh(token) {
    const rec = this.refreshTokens.get(sha256hex(token))
    if (!rec) throw new HttpError(401, 'Invalid refresh token.')
    const fam = this.families.get(rec.family)
    if (!fam || fam.revoked) throw new HttpError(401, 'Session has been revoked. Please sign in again.')
    if (rec.exp <= this.now()) throw new HttpError(401, 'Refresh token expired. Please sign in again.')
    if (rec.used) {
      this.#revokeFamily(rec.family)
      throw new HttpError(401, 'Refresh token reuse detected; the session was revoked. Please sign in again.')
    }
    const entry = this.entryById(rec.userId)
    if (!entry || entry.disabled) {
      this.#revokeFamily(rec.family)
      throw new HttpError(401, 'This account is not available. Please sign in again.')
    }
    rec.used = true
    return this.issue(rec.userId, rec.family)
  }

  /** Returns { user, family } for a valid access token or throws a 401. */
  authenticate(token) {
    const rec = this.access.get(sha256hex(token))
    if (!rec) throw new HttpError(401, 'Invalid access token.', { 'WWW-Authenticate': 'Bearer error="invalid_token"' })
    if (rec.exp <= this.now()) {
      this.access.delete(sha256hex(token))
      throw new HttpError(401, 'Access token expired.', { 'WWW-Authenticate': 'Bearer error="invalid_token", error_description="expired"' })
    }
    const fam = this.families.get(rec.family)
    const entry = this.entryById(rec.userId)
    if (!fam || fam.revoked || !entry || entry.disabled) {
      throw new HttpError(401, 'Invalid access token.', { 'WWW-Authenticate': 'Bearer error="invalid_token"' })
    }
    return { user: entry.user, family: rec.family }
  }

  /** Revokes the token family of the given access and/or refresh token. Unknown tokens are ignored. */
  logout({ accessToken, refreshToken }) {
    if (accessToken) {
      const rec = this.access.get(sha256hex(accessToken))
      if (rec) this.#revokeFamily(rec.family)
    }
    if (refreshToken) {
      const rec = this.refreshTokens.get(sha256hex(refreshToken))
      if (rec) this.#revokeFamily(rec.family)
    }
  }

  // ---- Admin user management ---------------------------------------------------

  #enabledAdmins() {
    return [...this.users.values()].filter((e) => e.user.role === 'admin' && !e.disabled)
  }

  createUser({ username, displayName, password, role }) {
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) throw new HttpError(400, 'username must be 3-32 characters of a-z, 0-9, "_", "." or "-".')
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw new HttpError(400, `password must be at least ${MIN_PASSWORD} characters.`)
    if (password.length > 1024) throw new HttpError(400, 'password is too long.')
    if (!ROLES.includes(role)) throw new HttpError(400, 'role must be "admin" or "user".')
    const name = this.#displayName(displayName)
    if (this.users.has(username)) throw new HttpError(409, 'That username is already taken.')
    const entry = this.#entry(username, password, role, name)
    this.users.set(username, entry)
    return entry
  }

  #displayName(value) {
    if (value === undefined) return undefined
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 64) throw new HttpError(400, 'displayName must be a non-empty string of at most 64 characters.')
    return value.trim()
  }

  updateUser(id, patch) {
    const entry = this.entryById(id)
    if (!entry) throw new HttpError(404, 'User not found.')
    const allowed = ['displayName', 'password', 'role', 'disabled']
    for (const k of Object.keys(patch)) if (!allowed.includes(k)) throw new HttpError(400, `Unknown field "${k}".`)
    const displayName = this.#displayName(patch.displayName)
    if (patch.password !== undefined && (typeof patch.password !== 'string' || patch.password.length < MIN_PASSWORD || patch.password.length > 1024)) {
      throw new HttpError(400, `password must be at least ${MIN_PASSWORD} characters.`)
    }
    if (patch.role !== undefined && !ROLES.includes(patch.role)) throw new HttpError(400, 'role must be "admin" or "user".')
    if (patch.disabled !== undefined && typeof patch.disabled !== 'boolean') throw new HttpError(400, 'disabled must be a boolean.')
    const role = patch.role ?? entry.user.role
    const disabled = patch.disabled ?? entry.disabled
    const wasEnabledAdmin = entry.user.role === 'admin' && !entry.disabled
    const willBeEnabledAdmin = role === 'admin' && !disabled
    if (wasEnabledAdmin && !willBeEnabledAdmin && this.#enabledAdmins().length <= 1) {
      throw new HttpError(409, 'There must be at least one enabled admin.')
    }
    if (displayName !== undefined) entry.user.displayName = displayName
    entry.user.role = role
    entry.disabled = disabled
    if (patch.password !== undefined) {
      entry.hash = this.#hash(patch.password)
      this.revokeUser(id)
    } else if (disabled) {
      this.revokeUser(id)
    }
    return entry
  }

  deleteUser(id, actingId) {
    const entry = this.entryById(id)
    if (!entry) throw new HttpError(404, 'User not found.')
    if (id === actingId) throw new HttpError(409, 'You cannot delete your own account.')
    if (entry.user.role === 'admin' && !entry.disabled && this.#enabledAdmins().length <= 1) throw new HttpError(409, 'There must be at least one enabled admin.')
    this.revokeUser(id)
    this.users.delete(entry.user.username.toLowerCase())
  }
}
