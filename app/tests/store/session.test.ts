import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSessionStore, isAdmin } from '@/store/session'
import type { StoredSession } from '@/api/client'
import { ApiError } from '@/api/errors'
import type { SecureStorage } from '@/platform'
import { storedSession, wireSession } from '../helpers/fixtures'
import { emptyResponse, fakeFetch, jsonResponse, textResponse, type FakeFetch, type Call } from '../helpers/http'

const SERVER = 'https://music.example.com'
const NOW = 5_000_000
const INFO = { name: 'Nocturne', version: '1.0.0', apiVersion: 1 as const, capabilities: { lyrics: true } }

class FakeSecure implements SecureStorage {
  data = new Map<string, string>()
  log: string[] = []
  failGet = false
  failSet = false
  failDelete = false
  async get(key: string): Promise<string | null> {
    this.log.push(`get ${key}`)
    if (this.failGet) throw new Error('keychain locked')
    return this.data.get(key) ?? null
  }
  async set(key: string, value: string): Promise<void> {
    this.log.push(`set ${key}`)
    if (this.failSet) throw new Error('disk full')
    this.data.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.log.push(`delete ${key}`)
    if (this.failDelete) throw new Error('nope')
    this.data.delete(key)
  }
}

function stored(over: Partial<StoredSession> = {}): StoredSession {
  return storedSession({ serverUrl: SERVER, expiresAt: NOW + 3_600_000, ...over })
}

function route(overrides: Record<string, (c: Call) => Response> = {}): FakeFetch {
  return fakeFetch((c) => {
    const path = new URL(c.url).pathname
    const h = overrides[`${c.method} ${path}`]
    if (h) return h(c)
    if (path === '/v1/info') return jsonResponse(INFO)
    if (path === '/v1/me') return jsonResponse({ id: 'u1', username: 'demo', displayName: 'Demo' })
    if (path === '/v1/auth/login') return jsonResponse(wireSession({ accessToken: 'login-access', refreshToken: 'login-refresh', expiresIn: 600 }))
    if (path === '/v1/auth/logout') return emptyResponse()
    if (path === '/v1/auth/refresh') return jsonResponse(wireSession({ accessToken: 'refreshed', refreshToken: 'refresh-2' }))
    throw new Error(`unrouted ${c.method} ${path}`)
  })
}

function setup(fetch: FakeFetch = route(), over: { defaultServer?: string; secure?: FakeSecure } = {}) {
  const secure = over.secure ?? new FakeSecure()
  const { useSession, api } = createSessionStore({ secure, fetch, now: () => NOW, defaultServer: over.defaultServer })
  return { secure, fetch, useSession, api, s: () => useSession.getState() }
}

async function settlePersist(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.useRealTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('initial state', () => {
  it('starts in "restoring" with nothing loaded', () => {
    const { s } = setup()
    expect(s()).toMatchObject({ status: 'restoring', session: null, server: null, lastServerUrl: '' })
  })

  it('uses the default server as the initial address', () => {
    expect(setup(route(), { defaultServer: 'https://default.example.com' }).s().lastServerUrl).toBe('https://default.example.com')
  })

  it('prefers the last used server from local storage', () => {
    localStorage.setItem('nocturne.server', JSON.stringify('https://last.example.com'))
    expect(setup(route(), { defaultServer: 'https://default.example.com' }).s().lastServerUrl).toBe('https://last.example.com')
  })

  it('ignores a corrupted last-server value', () => {
    localStorage.setItem('nocturne.server', JSON.stringify(42))
    expect(setup(route(), { defaultServer: 'https://d.example.com' }).s().lastServerUrl).toBe('https://d.example.com')
    localStorage.setItem('nocturne.server', '{{{')
    expect(setup().s().lastServerUrl).toBe('')
  })

  it('uses Date.now and global fetch by default', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(INFO))
    const { useSession } = createSessionStore({ secure: new FakeSecure() })
    await expect(useSession.getState().login('music.example.com', 'u', 'p')).rejects.toBeInstanceOf(Error)
    expect(spy).toHaveBeenCalled()
  })
})

describe('restore', () => {
  it('signs out when nothing is stored', async () => {
    const { s, fetch } = setup()
    await s().restore()
    expect(s()).toMatchObject({ status: 'signedOut', session: null })
    expect(fetch.calls).toHaveLength(0)
  })

  it.each([
    ['not json', 'garbage{'],
    ['json null', 'null'],
    ['a string', JSON.stringify('x')],
    ['missing access token', JSON.stringify({ ...stored(), accessToken: undefined })],
    ['missing refresh token', JSON.stringify({ ...stored(), refreshToken: undefined })],
    ['missing server', JSON.stringify({ ...stored(), serverUrl: undefined })],
    ['non-numeric expiry', JSON.stringify({ ...stored(), expiresAt: 'soon' })],
    ['no user', JSON.stringify({ ...stored(), user: undefined })],
    ['user without id', JSON.stringify({ ...stored(), user: { username: 'x' } })]
  ])('ignores an invalid stored session (%s)', async (_n, raw) => {
    const { s, secure, fetch } = setup()
    secure.data.set('session', raw)
    await s().restore()
    expect(s().status).toBe('signedOut')
    expect(s().session).toBeNull()
    expect(fetch.calls).toHaveLength(0)
  })

  it('signs out when secure storage fails', async () => {
    const { s, secure } = setup()
    secure.failGet = true
    await s().restore()
    expect(s().status).toBe('signedOut')
  })

  it('restores a valid session immediately and validates it in the background', async () => {
    const { s, secure, fetch } = setup()
    const session = stored()
    secure.data.set('session', JSON.stringify(session))
    const p = s().restore()
    await settlePersist()
    expect(s()).toMatchObject({ status: 'signedIn', session })
    await p
    expect(s().server).toEqual(INFO)
    const paths = fetch.calls.map((c) => new URL(c.url).pathname).sort()
    expect(paths).toEqual(['/v1/info', '/v1/me'])
    expect(fetch.calls.find((c) => c.url.endsWith('/v1/me'))!.headers.Authorization).toBe('Bearer access-1')
  })

  it('signs out (and clears secure storage) when validation answers 401 and refresh is rejected', async () => {
    const fetch = route({
      'GET /v1/me': () => jsonResponse({}, { status: 401 }),
      'POST /v1/auth/refresh': () => jsonResponse({}, { status: 401 })
    })
    const { s, secure } = setup(fetch)
    secure.data.set('session', JSON.stringify(stored()))
    await s().restore()
    await settlePersist()
    expect(s()).toMatchObject({ status: 'signedOut', session: null })
    expect(secure.data.has('session')).toBe(false)
    expect(secure.log).toContain('delete session')
  })

  it('keeps the session when the 401 is recovered by a token refresh', async () => {
    let meCalls = 0
    const fetch = route({
      'GET /v1/me': () => (meCalls++ === 0 ? jsonResponse({}, { status: 401 }) : jsonResponse({ id: 'u1' })),
      'POST /v1/auth/refresh': () => jsonResponse(wireSession({ accessToken: 'fresh', refreshToken: 'r2', expiresIn: 3600 }))
    })
    const { s, secure } = setup(fetch)
    secure.data.set('session', JSON.stringify(stored()))
    await s().restore()
    await settlePersist()
    expect(s().status).toBe('signedIn')
    expect(s().session!.accessToken).toBe('fresh')
    expect(JSON.parse(secure.data.get('session')!).accessToken).toBe('fresh')
  })

  it('keeps the session when offline', async () => {
    vi.useFakeTimers()
    const fetch = fakeFetch(() => {
      throw new TypeError('Failed to fetch')
    })
    const { s, secure } = setup(fetch)
    secure.data.set('session', JSON.stringify(stored()))
    const p = s().restore()
    await vi.advanceTimersByTimeAsync(2000)
    await p
    expect(s().status).toBe('signedIn')
    expect(s().server).toBeNull()
    expect(secure.log).not.toContain('delete session')
  })

  it('keeps the session when the server has a transient 5xx', async () => {
    vi.useFakeTimers()
    const fetch = route({ 'GET /v1/info': () => jsonResponse({}, { status: 503 }) })
    const { s, secure } = setup(fetch)
    secure.data.set('session', JSON.stringify(stored()))
    const p = s().restore()
    await vi.advanceTimersByTimeAsync(2000)
    await p
    expect(s().status).toBe('signedIn')
  })
})

describe('login', () => {
  it('normalizes the address, signs in and persists everything', async () => {
    const { s, secure, fetch } = setup()
    await s().login('  music.example.com/  ', '  demo  ', 'secret')
    expect(fetch.calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${SERVER}/v1/info`, `POST ${SERVER}/v1/auth/login`])
    expect(fetch.calls[1]!.body).toEqual({ username: 'demo', password: 'secret' })
    expect(s()).toMatchObject({ status: 'signedIn', lastServerUrl: SERVER, server: INFO })
    expect(s().session).toMatchObject({ accessToken: 'login-access', serverUrl: SERVER, expiresAt: NOW + 600_000 })
    await settlePersist()
    expect(JSON.parse(secure.data.get('session')!)).toMatchObject({ accessToken: 'login-access', refreshToken: 'login-refresh', serverUrl: SERVER })
    expect(JSON.parse(localStorage.getItem('nocturne.server')!)).toBe(SERVER)
  })

  it('does not trim the password', async () => {
    const { s, fetch } = setup()
    await s().login(SERVER, 'demo', ' pw with spaces ')
    expect(fetch.calls[1]!.body).toMatchObject({ password: ' pw with spaces ' })
  })

  it.each([
    ['', 'pw'],
    ['   ', 'pw'],
    ['demo', '']
  ])('rejects missing credentials (%j / %j) without any network traffic', async (user, pw) => {
    const { s, fetch } = setup()
    await expect(s().login(SERVER, user, pw)).rejects.toThrow('Enter your username and password.')
    expect(fetch.calls).toHaveLength(0)
  })

  it('rejects invalid addresses before any network traffic', async () => {
    const { s, fetch } = setup()
    await expect(s().login('', 'u', 'p')).rejects.toThrow('Enter your server address.')
    await expect(s().login('http://example.com', 'u', 'p')).rejects.toThrow(/only allowed on your local network/)
    await expect(s().login('ftp://x', 'u', 'p')).rejects.toThrow('Use an https:// address.')
    expect(fetch.calls).toHaveLength(0)
  })

  it('allows plain http on a LAN address', async () => {
    const { s, fetch } = setup()
    await s().login('http://192.168.1.10:4000', 'u', 'p')
    expect(fetch.calls[0]!.url).toBe('http://192.168.1.10:4000/v1/info')
  })

  it('explains an unreachable server', async () => {
    const fetch = fakeFetch(() => {
      throw new TypeError('Failed to fetch')
    })
    const { s } = setup(fetch)
    const err = (await s().login(SERVER, 'u', 'p').catch((e: unknown) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.code).toBe('network')
    expect(err.message).toBe("Couldn't reach that server. Check the address and that it's online.")
    expect(s().status).toBe('restoring')
  })

  it('explains a timeout the same way', async () => {
    vi.useFakeTimers()
    const fetch = fakeFetch((c) => new Promise((_, rej) => c.signal!.addEventListener('abort', () => rej(new DOMException('a', 'AbortError')))))
    const { s } = setup(fetch)
    const p = s().login(SERVER, 'u', 'p').catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(9000)
    const err = (await p) as ApiError
    expect(err.code).toBe('timeout')
    expect(err.message).toMatch(/Couldn't reach that server/)
  })

  it.each([
    ['404', () => jsonResponse({}, { status: 404 }), 'not_found'],
    ['HTML instead of JSON', () => textResponse('<html>router login</html>'), 'bad_response']
  ])('flags a non-compatible server (%s)', async (_n, handler, code) => {
    const { s } = setup(route({ 'GET /v1/info': handler }))
    const err = (await s().login(SERVER, 'u', 'p').catch((e: unknown) => e)) as ApiError
    expect(err.code).toBe(code)
    expect(err.message).toBe("That address doesn't look like a Nocturne-compatible server.")
  })

  it('passes other info errors through (e.g. 500)', async () => {
    const { s } = setup(route({ 'GET /v1/info': () => jsonResponse({ message: 'maintenance' }, { status: 500 }) }))
    const err = (await s().login(SERVER, 'u', 'p').catch((e: unknown) => e)) as ApiError
    expect(err.code).toBe('server')
    expect(err.message).toBe('maintenance')
  })

  it.each([2, 0, undefined])('rejects apiVersion %s', async (apiVersion) => {
    const { s, fetch } = setup(route({ 'GET /v1/info': () => jsonResponse({ ...INFO, apiVersion }) }))
    await expect(s().login(SERVER, 'u', 'p')).rejects.toThrow(`Unsupported server API version (${String(apiVersion)}).`)
    expect(fetch.calls.some((c) => c.url.endsWith('/auth/login'))).toBe(false)
  })

  it('reports wrong credentials clearly and stores nothing', async () => {
    const { s, secure } = setup(route({ 'POST /v1/auth/login': () => jsonResponse({ message: 'invalid_grant' }, { status: 401 }) }))
    const err = (await s().login(SERVER, 'demo', 'nope').catch((e: unknown) => e)) as ApiError
    expect(err.message).toBe('Wrong username or password.')
    expect(s().session).toBeNull()
    expect(s().status).not.toBe('signedIn')
    await settlePersist()
    expect(secure.data.size).toBe(0)
    expect(localStorage.getItem('nocturne.server')).toBeNull()
  })

  it('surfaces rate limiting from the login endpoint', async () => {
    const { s } = setup(route({ 'POST /v1/auth/login': () => jsonResponse({}, { status: 429, headers: { 'Retry-After': '30' } }) }))
    const err = (await s().login(SERVER, 'u', 'p').catch((e: unknown) => e)) as ApiError
    expect(err).toMatchObject({ code: 'rate_limited', retryAfter: 30 })
  })

  it('a later login replaces the previous session', async () => {
    const { s } = setup()
    await s().login(SERVER, 'a', 'p')
    await s().login('https://other.example.com', 'b', 'p')
    expect(s().session!.serverUrl).toBe('https://other.example.com')
    expect(s().lastServerUrl).toBe('https://other.example.com')
  })
})

describe('setSession', () => {
  it('stores a session and persists it', async () => {
    const { s, secure } = setup()
    const session = stored()
    s().setSession(session)
    expect(s()).toMatchObject({ status: 'signedIn', session })
    await settlePersist()
    expect(JSON.parse(secure.data.get('session')!)).toEqual(session)
  })

  it('setSession(null) signs out and deletes from secure storage', async () => {
    const { s, secure } = setup()
    s().setSession(stored())
    s().setSession(null)
    expect(s()).toMatchObject({ status: 'signedOut', session: null })
    await settlePersist()
    expect(secure.data.has('session')).toBe(false)
    expect(secure.log).toEqual(['set session', 'delete session'])
  })

  it('persists in call order even when storage is slow', async () => {
    const secure = new FakeSecure()
    const realSet = secure.set.bind(secure)
    secure.set = async (k, v) => {
      await new Promise((r) => setTimeout(r, 20))
      return realSet(k, v)
    }
    const { s } = setup(route(), { secure })
    s().setSession(stored())
    s().setSession(null)
    await new Promise((r) => setTimeout(r, 60))
    expect(secure.data.has('session')).toBe(false)
  })

  it('keeps working when persisting fails', async () => {
    const { s, secure } = setup()
    secure.failSet = true
    secure.failDelete = true
    s().setSession(stored())
    s().setSession(null)
    await settlePersist()
    expect(s().status).toBe('signedOut')
    // later operations still run
    secure.failSet = false
    s().setSession(stored({ accessToken: 'again' }))
    await settlePersist()
    expect(JSON.parse(secure.data.get('session')!).accessToken).toBe('again')
  })
})

describe('logout', () => {
  it('calls the API, clears the session and server info', async () => {
    const { s, secure, fetch } = setup()
    await s().login(SERVER, 'u', 'p')
    fetch.calls.length = 0
    await s().logout()
    expect(fetch.calls).toHaveLength(1)
    expect(fetch.calls[0]).toMatchObject({ method: 'POST', url: `${SERVER}/v1/auth/logout` })
    expect(fetch.calls[0]!.body).toEqual({ refreshToken: 'login-refresh' })
    expect(s()).toMatchObject({ status: 'signedOut', session: null, server: null })
    await settlePersist()
    expect(secure.data.has('session')).toBe(false)
  })

  it('still signs out locally when the API call fails', async () => {
    const { s, secure } = setup(route({ 'POST /v1/auth/logout': () => jsonResponse({}, { status: 500 }) }))
    await s().login(SERVER, 'u', 'p')
    await expect(s().logout()).resolves.toBeUndefined()
    expect(s()).toMatchObject({ status: 'signedOut', session: null, server: null })
    await settlePersist()
    expect(secure.data.has('session')).toBe(false)
  })

  it('still signs out locally when offline', async () => {
    const { s } = setup(route({ 'POST /v1/auth/logout': () => { throw new TypeError('offline') } }))
    await s().login(SERVER, 'u', 'p')
    await s().logout()
    expect(s().status).toBe('signedOut')
  })

  it('is harmless when already signed out', async () => {
    const { s, fetch } = setup()
    await s().logout()
    expect(s().status).toBe('signedOut')
    expect(fetch.calls).toHaveLength(0)
  })
})

describe('api client wiring', () => {
  it('uses the stored session for authenticated calls', async () => {
    const { s, api, fetch } = setup()
    s().setSession(stored())
    await api.me()
    expect(fetch.calls[0]!.headers.Authorization).toBe('Bearer access-1')
  })

  it('persists refreshed tokens and updates the store', async () => {
    const { s, api, secure } = setup()
    s().setSession(stored({ expiresAt: NOW - 1 }))
    await api.me()
    expect(s().session!.accessToken).toBe('refreshed')
    await settlePersist()
    expect(JSON.parse(secure.data.get('session')!)).toMatchObject({ accessToken: 'refreshed', refreshToken: 'refresh-2' })
  })

  it('signs the store out when the refresh token is dead', async () => {
    const { s, api, secure } = setup(route({ 'POST /v1/auth/refresh': () => jsonResponse({}, { status: 401 }) }))
    s().setSession(stored({ expiresAt: NOW - 1 }))
    await expect(api.me()).rejects.toMatchObject({ code: 'unauthorized' })
    expect(s().status).toBe('signedOut')
    await settlePersist()
    expect(secure.data.has('session')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Hosted web / cookie session
// ---------------------------------------------------------------------------

describe('hosted (cookie) mode', () => {
  const ORIGIN = 'https://hosted.example.com'
  const HOSTED_INFO = { ...INFO, capabilities: { lyrics: true, admin: true } }

  function hostedRoute(overrides: Record<string, (c: Call) => Response> = {}): FakeFetch {
    return fakeFetch((c) => {
      const path = new URL(c.url).pathname
      const h = overrides[`${c.method} ${path}`]
      if (h) return h(c)
      if (path === '/v1/info') return jsonResponse(HOSTED_INFO)
      if (path === '/v1/auth/refresh') return jsonResponse(wireSession({ accessToken: 'cookie-access', refreshToken: '', user: { id: 'u1', username: 'root', displayName: 'Root', role: 'admin' } }))
      if (path === '/v1/auth/login') return jsonResponse(wireSession({ accessToken: 'login-access', refreshToken: '', user: { id: 'u1', username: 'root', displayName: 'Root', role: 'admin' } }))
      if (path === '/v1/auth/logout') return emptyResponse()
      throw new Error(`unrouted ${c.method} ${path}`)
    })
  }

  function hosted(fetch: FakeFetch = hostedRoute()) {
    const secure = new FakeSecure()
    const { useSession, api } = createSessionStore({ secure, fetch, now: () => NOW, cookieSession: true, hostedOrigin: ORIGIN })
    return { secure, fetch, useSession, api, s: () => useSession.getState() }
  }

  it('defaults lastServerUrl to the hosted origin, ignoring local storage', () => {
    localStorage.setItem('nocturne.server', JSON.stringify('https://other.example.com'))
    const { s } = hosted()
    expect(s()).toMatchObject({ status: 'restoring', lastServerUrl: ORIGIN, restoreError: null })
  })

  it('restore: a valid cookie signs in, loads server info and never touches secure storage', async () => {
    const { s, secure, fetch } = hosted()
    await s().restore()
    expect(s()).toMatchObject({ status: 'signedIn', restoreError: null, lastServerUrl: ORIGIN })
    expect(s().session).toMatchObject({ accessToken: 'cookie-access', refreshToken: '', serverUrl: ORIGIN, expiresAt: NOW + 3_600_000 })
    expect(s().server).toEqual(HOSTED_INFO)
    expect(isAdmin(s())).toBe(true)
    const refresh = fetch.calls.find((c) => c.url.endsWith('/v1/auth/refresh'))!
    expect(refresh.body).toEqual({})
    expect(refresh.headers['X-Nocturne-Session']).toBe('cookie')
    expect(refresh.init.credentials).toBe('same-origin')
    await settlePersist()
    expect(secure.log).toEqual([])
  })

  it('restore: stays signed in (server unknown, not admin) when /v1/info fails after a good refresh', async () => {
    const { s } = hosted(hostedRoute({ 'GET /v1/info': () => jsonResponse({}, { status: 500 }) }))
    await s().restore()
    expect(s().status).toBe('signedIn')
    expect(s().server).toBeNull()
    expect(isAdmin(s())).toBe(false)
  })

  it('restore: 401 means signed out with no error', async () => {
    const { s } = hosted(hostedRoute({ 'POST /v1/auth/refresh': () => jsonResponse({}, { status: 401 }) }))
    await s().restore()
    expect(s()).toMatchObject({ status: 'signedOut', session: null, restoreError: null, lastServerUrl: ORIGIN })
  })

  it('restore: a network error means signed out, with restoreError set and the server kept', async () => {
    const fetch = fakeFetch(() => {
      throw new TypeError('Failed to fetch')
    })
    const { s } = hosted(fetch)
    await s().restore()
    expect(s()).toMatchObject({ status: 'signedOut', session: null, lastServerUrl: ORIGIN })
    expect(s().restoreError).toMatch(/can't reach the server/i)
  })

  it('restore: a 5xx also reports restoreError; a later successful restore clears it', async () => {
    let fail = true
    const { s } = hosted(hostedRoute({ 'POST /v1/auth/refresh': () => (fail ? jsonResponse({}, { status: 503 }) : jsonResponse(wireSession({ refreshToken: '' }))) }))
    await s().restore()
    expect(s().status).toBe('signedOut')
    expect(s().restoreError).toBeTruthy()
    fail = false
    await s().restore()
    expect(s()).toMatchObject({ status: 'signedIn', restoreError: null })
  })

  it('restore without any origin signs out quietly', async () => {
    const fetch = hostedRoute()
    const { useSession } = createSessionStore({ secure: new FakeSecure(), fetch, now: () => NOW, cookieSession: true })
    await useSession.getState().restore()
    expect(useSession.getState()).toMatchObject({ status: 'signedOut', restoreError: null })
    expect(fetch.calls).toHaveLength(0)
  })

  it('login ignores the address argument and uses the hosted origin', async () => {
    const { s, fetch, secure } = hosted()
    await s().login('https://evil.example.com', ' root ', 'pw')
    expect(fetch.calls.every((c) => c.url.startsWith(ORIGIN))).toBe(true)
    const login = fetch.calls.find((c) => c.url.endsWith('/v1/auth/login'))!
    expect(login.body).toEqual({ username: 'root', password: 'pw' })
    expect(login.headers['X-Nocturne-Session']).toBe('cookie')
    expect(login.init.credentials).toBe('same-origin')
    expect(s()).toMatchObject({ status: 'signedIn', lastServerUrl: ORIGIN })
    expect(s().session).toMatchObject({ serverUrl: ORIGIN, refreshToken: '' })
    expect(isAdmin(s())).toBe(true)
    await settlePersist()
    expect(secure.log).toEqual([])
    expect(localStorage.getItem('nocturne.server')).toBeNull()
  })

  it('login works with an empty address argument', async () => {
    const { s } = hosted()
    await s().login('', 'root', 'pw')
    expect(s().status).toBe('signedIn')
  })

  it('login failures keep the user signed out and persist nothing', async () => {
    const { s, secure } = hosted(hostedRoute({ 'POST /v1/auth/login': () => jsonResponse({}, { status: 401 }) }))
    await expect(s().login('', 'root', 'bad')).rejects.toMatchObject({ message: 'Wrong username or password.' })
    expect(s().session).toBeNull()
    expect(secure.log).toEqual([])
  })

  it('setSession and logout never write to secure storage; logout posts {}', async () => {
    const { s, secure, fetch } = hosted()
    await s().login('', 'root', 'pw')
    await s().logout()
    await settlePersist()
    expect(s()).toMatchObject({ status: 'signedOut', session: null, server: null })
    const out = fetch.calls.find((c) => c.url.endsWith('/v1/auth/logout'))!
    expect(out.body).toEqual({})
    expect(out.headers['X-Nocturne-Session']).toBe('cookie')
    expect(secure.log).toEqual([])
  })

  it('login clears a previous restoreError', async () => {
    const down = { on: true }
    const base = hostedRoute()
    const fetch = fakeFetch((c) => {
      if (down.on && c.url.endsWith('/v1/auth/refresh')) throw new TypeError('offline')
      return base(c.url, c.init)
    })
    const { s } = hosted(fetch)
    await s().restore()
    expect(s().restoreError).toBeTruthy()
    down.on = false
    await s().login('', 'root', 'pw')
    expect(s().restoreError).toBeNull()
  })

  it('refreshes the access token over the cookie when it expires (api client is in cookie mode)', async () => {
    let clock = NOW
    const fetch = hostedRoute({ 'GET /v1/me': () => jsonResponse({ id: 'u1', username: 'root', displayName: 'Root' }) })
    const { useSession, api } = createSessionStore({ secure: new FakeSecure(), fetch, now: () => clock, cookieSession: true, hostedOrigin: ORIGIN })
    await useSession.getState().login('', 'root', 'pw')
    clock = NOW + 3_600_000
    await api.me()
    const refresh = fetch.calls.filter((c) => c.url.endsWith('/v1/auth/refresh'))
    expect(refresh).toHaveLength(1)
    expect(refresh[0]!.body).toEqual({})
    expect(useSession.getState().session!.refreshToken).toBe('')
  })
})

describe('isAdmin', () => {
  const user = (role?: 'admin' | 'user') => ({ id: 'u1', username: 'x', displayName: 'X', ...(role ? { role } : {}) })
  const sess = (role?: 'admin' | 'user') => stored({ user: user(role) })

  it('requires both an admin user and the admin capability', () => {
    expect(isAdmin({ session: sess('admin'), server: { ...INFO, capabilities: { admin: true } } })).toBe(true)
    expect(isAdmin({ session: sess('admin'), server: { ...INFO, capabilities: { admin: false } } })).toBe(false)
    expect(isAdmin({ session: sess('admin'), server: { ...INFO, capabilities: {} } })).toBe(false)
    expect(isAdmin({ session: sess('admin'), server: INFO })).toBe(false)
    expect(isAdmin({ session: sess('admin'), server: { name: 'n', version: '1', apiVersion: 1 } })).toBe(false)
    expect(isAdmin({ session: sess('admin'), server: null })).toBe(false)
  })

  it('is false for regular users, missing roles and no session', () => {
    const server = { ...INFO, capabilities: { admin: true } }
    expect(isAdmin({ session: sess('user'), server })).toBe(false)
    expect(isAdmin({ session: sess(), server })).toBe(false)
    expect(isAdmin({ session: null, server })).toBe(false)
  })

  it('works on the live store after a normal (non-hosted) login', async () => {
    const fetch = route({
      'GET /v1/info': () => jsonResponse({ ...INFO, capabilities: { admin: true } }),
      'POST /v1/auth/login': () => jsonResponse(wireSession({ user: user('admin') }))
    })
    const { s } = setup(fetch)
    await s().login('music.example.com', 'a', 'b')
    expect(isAdmin(s())).toBe(true)
  })

  it('non-hosted restore also populates the server so isAdmin works', async () => {
    const fetch = route({ 'GET /v1/info': () => jsonResponse({ ...INFO, capabilities: { admin: true } }) })
    const { s, secure } = setup(fetch)
    secure.data.set('session', JSON.stringify(sess('admin')))
    await s().restore()
    expect(isAdmin(s())).toBe(true)
  })
})
