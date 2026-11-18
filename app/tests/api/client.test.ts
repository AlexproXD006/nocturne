import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, ServerApi, toStoredSession, type StoredSession } from '@/api/client'
import { ApiError } from '@/api/errors'
import { storedSession, wireSession } from '../helpers/fixtures'
import {
  emptyResponse,
  flush,
  fakeFetch,
  hangUntilAbort,
  jsonResponse,
  scriptedFetch,
  textResponse,
  type FakeFetch
} from '../helpers/http'

const BASE = 'https://music.example.com'
const NOW = 1_000_000

interface Harness {
  client: ApiClient
  fetch: FakeFetch
  session: { current: StoredSession | null }
  setSession: ReturnType<typeof vi.fn>
  clock: { t: number }
}

function harness(fetch: FakeFetch, over: Partial<StoredSession> | null = {}, timeoutMs?: number): Harness {
  const session = { current: over === null ? null : storedSession({ expiresAt: NOW + 3_600_000, ...over }) }
  const clock = { t: NOW }
  const setSession = vi.fn((s: StoredSession | null) => {
    session.current = s
  })
  const client = new ApiClient({ getSession: () => session.current, setSession, fetch, now: () => clock.t, timeoutMs })
  return { client, fetch, session, setSession, clock }
}

async function rejection(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p
  } catch (e) {
    return e as ApiError
  }
  throw new Error('expected promise to reject')
}

afterEach(() => {
  vi.useRealTimers()
})

describe('request basics', () => {
  it('sends the bearer token, JSON accept header and safe fetch options', async () => {
    const f = fakeFetch(() => jsonResponse({ id: 'u1' }))
    const { client } = harness(f)
    await client.me()
    const c = f.calls[0]!
    expect(c.url).toBe(`${BASE}/v1/me`)
    expect(c.method).toBe('GET')
    expect(c.headers).toEqual({ Accept: 'application/json', Authorization: 'Bearer access-1' })
    expect(c.init.credentials).toBe('omit')
    expect(c.init.cache).toBe('no-store')
    expect(c.rawBody).toBeUndefined()
  })

  it('serializes JSON bodies with a Content-Type header', async () => {
    const f = fakeFetch(() => jsonResponse({ ok: true }))
    const { client } = harness(f)
    await client.request('POST', '/v1/x', { body: { a: 1 } })
    expect(f.calls[0]!.headers['Content-Type']).toBe('application/json')
    expect(f.calls[0]!.body).toEqual({ a: 1 })
  })

  it('serializes falsy bodies too (0, false, empty string, null)', async () => {
    const f = fakeFetch(() => jsonResponse({}))
    const { client } = harness(f)
    for (const body of [0, false, '', null]) await client.request('POST', '/v1/x', { body })
    expect(f.calls.map((c) => c.rawBody)).toEqual(['0', 'false', '""', 'null'])
  })

  it('builds query strings, skipping undefined values and encoding the rest', async () => {
    const f = fakeFetch(() => jsonResponse({}))
    const { client } = harness(f)
    await client.request('GET', '/v1/search', { query: { q: 'a b&c=d', limit: 5, flag: false, none: undefined, zero: 0 } })
    const url = new URL(f.calls[0]!.url)
    expect(url.pathname).toBe('/v1/search')
    expect(url.searchParams.get('q')).toBe('a b&c=d')
    expect(url.searchParams.get('limit')).toBe('5')
    expect(url.searchParams.get('flag')).toBe('false')
    expect(url.searchParams.get('zero')).toBe('0')
    expect(url.searchParams.has('none')).toBe(false)
  })

  it('keeps a sub-path in the server URL', async () => {
    const f = fakeFetch(() => jsonResponse({}))
    const { client } = harness(f, { serverUrl: 'https://example.com/music' })
    await client.me()
    expect(f.calls[0]!.url).toBe('https://example.com/music/v1/me')
  })

  it('returns undefined for 204', async () => {
    const f = fakeFetch(() => emptyResponse(204))
    const { client } = harness(f)
    await expect(client.setLiked('t1', true)).resolves.toBeUndefined()
  })

  it('maps a non-JSON content type to bad_response', async () => {
    const { client } = harness(fakeFetch(() => textResponse('<html>captive portal</html>')))
    const err = await rejection(client.me())
    expect(err).toBeInstanceOf(ApiError)
    expect(err.code).toBe('bad_response')
    expect(err.status).toBe(200)
  })

  it('maps a missing content type to bad_response', async () => {
    const { client } = harness(fakeFetch(() => new Response('{}', { status: 200 })))
    // new Response(string) defaults to text/plain
    expect((await rejection(client.me())).code).toBe('bad_response')
  })

  it('maps an unparsable JSON body to bad_response', async () => {
    const { client } = harness(fakeFetch(() => new Response('{broken', { status: 200, headers: { 'Content-Type': 'application/json' } })))
    expect((await rejection(client.me())).code).toBe('bad_response')
  })

  it('accepts application/problem+json style content types', async () => {
    const f = fakeFetch(() => new Response('{"id":"u"}', { headers: { 'Content-Type': 'application/vnd.api+json; charset=utf-8' } }))
    const { client } = harness(f)
    await expect(client.me()).resolves.toEqual({ id: 'u' })
  })

  it('throws unauthorized without calling fetch when signed out', async () => {
    const f = fakeFetch(() => jsonResponse({}))
    const { client } = harness(f, null)
    const err = await rejection(client.me())
    expect(err.code).toBe('unauthorized')
    expect(f.calls).toHaveLength(0)
  })

  it('serverInfo works without a token but still needs a server to talk to', async () => {
    const f = fakeFetch(() => jsonResponse({ name: 'n', version: '1', apiVersion: 1 }))
    const { client } = harness(f)
    await client.serverInfo()
    expect(f.calls[0]!.url).toBe(`${BASE}/v1/info`)
    expect(f.calls[0]!.headers.Authorization).toBeUndefined()

    const signedOut = harness(f, null)
    expect((await rejection(signedOut.client.serverInfo())).code).toBe('unauthorized')
  })

  it('falls back to the global fetch when none is injected', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ id: 'u1' }))
    const client = new ApiClient({ getSession: () => storedSession({ expiresAt: Date.now() + 3_600_000 }), setSession: vi.fn() })
    await expect(client.me()).resolves.toEqual({ id: 'u1' })
    expect(spy).toHaveBeenCalledOnce()
  })
})

describe('error mapping', () => {
  it.each([
    [403, 'forbidden'],
    [404, 'not_found'],
    [400, 'bad_request'],
    [422, 'bad_request']
  ])('maps %i to %s without retrying', async (status, code) => {
    const f = fakeFetch(() => jsonResponse({ message: 'server says no' }, { status }))
    const { client } = harness(f)
    const err = await rejection(client.me())
    expect(err.code).toBe(code)
    expect(err.status).toBe(status)
    expect(err.message).toBe('server says no')
    expect(f.calls).toHaveLength(1)
  })

  it('reads the message from `error` when `message` is absent', async () => {
    const { client } = harness(fakeFetch(() => jsonResponse({ error: 'bad thing' }, { status: 400 })))
    expect((await rejection(client.me())).message).toBe('bad thing')
  })

  it('ignores non-string error messages and non-JSON error bodies', async () => {
    const a = harness(fakeFetch(() => jsonResponse({ message: { nested: true } }, { status: 404 })))
    expect((await rejection(a.client.me())).message).toBe("We couldn't find that.")
    const b = harness(fakeFetch(() => textResponse('oops', { status: 404 })))
    expect((await rejection(b.client.me())).message).toBe("We couldn't find that.")
  })

  it('exposes Retry-After (seconds) on 429 and does not retry', async () => {
    const f = fakeFetch(() => jsonResponse({}, { status: 429, headers: { 'Retry-After': '17' } }))
    const { client } = harness(f)
    const err = await rejection(client.me())
    expect(err.code).toBe('rate_limited')
    expect(err.retryAfter).toBe(17)
    expect(f.calls).toHaveLength(1)
  })

  it.each([['abc'], ['-5'], ['']])('ignores an invalid Retry-After %j', async (value) => {
    const { client } = harness(fakeFetch(() => jsonResponse({}, { status: 429, headers: { 'Retry-After': value } })))
    expect((await rejection(client.me())).retryAfter).toBeUndefined()
  })

  it('allows Retry-After: 0', async () => {
    const { client } = harness(fakeFetch(() => jsonResponse({}, { status: 429, headers: { 'Retry-After': '0' } })))
    expect((await rejection(client.me())).retryAfter).toBe(0)
  })

  it('maps network failures to a friendly network error', async () => {
    vi.useFakeTimers()
    const f = fakeFetch(() => {
      throw new TypeError('Failed to fetch')
    })
    const { client } = harness(f)
    const p = rejection(client.me())
    await vi.advanceTimersByTimeAsync(1000)
    const err = await p
    expect(err.code).toBe('network')
    expect(err.message).toMatch(/can't reach the server/i)
  })
})

describe('timeouts and aborts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('times out hanging requests with code=timeout and aborts the fetch', async () => {
    const f = fakeFetch((c) => hangUntilAbort(c.signal))
    const { client } = harness(f, {}, 5000)
    const p = rejection(client.me())
    await vi.advanceTimersByTimeAsync(4999)
    expect(f.calls[0]!.signal!.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    const err = await p
    expect(err.code).toBe('timeout')
    expect(f.calls[0]!.signal!.aborted).toBe(true)
    // timeouts are not retried
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.calls).toHaveLength(1)
  })

  it('uses a 15 second default timeout', async () => {
    const f = fakeFetch((c) => hangUntilAbort(c.signal))
    const { client } = harness(f)
    const p = rejection(client.me())
    await vi.advanceTimersByTimeAsync(14_999)
    expect(f.calls[0]!.signal!.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect((await p).code).toBe('timeout')
  })

  it('clears the timeout timer after a response', async () => {
    const { client } = harness(fakeFetch(() => jsonResponse({})))
    await client.me()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('surfaces caller aborts as code=aborted and does not retry', async () => {
    const f = fakeFetch((c) => hangUntilAbort(c.signal))
    const { client } = harness(f)
    const ctrl = new AbortController()
    const p = rejection(client.me(ctrl.signal))
    await vi.advanceTimersByTimeAsync(10)
    ctrl.abort()
    const err = await p
    expect(err.code).toBe('aborted')
    await vi.advanceTimersByTimeAsync(2000)
    expect(f.calls).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const f = fakeFetch((c) => hangUntilAbort(c.signal))
    const { client } = harness(f)
    const ctrl = new AbortController()
    ctrl.abort()
    expect((await rejection(client.me(ctrl.signal))).code).toBe('aborted')
  })

  it('removes its abort listener from the caller signal after finishing', async () => {
    const ctrl = new AbortController()
    const remove = vi.spyOn(ctrl.signal, 'removeEventListener')
    const { client } = harness(fakeFetch(() => jsonResponse({})))
    await client.me(ctrl.signal)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})

describe('retries', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('retries a GET once after a network error, with a short delay', async () => {
    const f = scriptedFetch([new TypeError('Failed to fetch'), jsonResponse({ id: 'u1' })])
    const { client } = harness(f)
    const p = client.me()
    await vi.advanceTimersByTimeAsync(399)
    expect(f.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2)
    await expect(p).resolves.toEqual({ id: 'u1' })
    expect(f.calls).toHaveLength(2)
  })

  it('gives up after the second network failure', async () => {
    const f = scriptedFetch([new TypeError('x'), new TypeError('y')])
    const { client } = harness(f)
    const p = rejection(client.me())
    await vi.advanceTimersByTimeAsync(1000)
    expect((await p).code).toBe('network')
    expect(f.calls).toHaveLength(2)
  })

  it('retries a GET once on a 5xx', async () => {
    const f = scriptedFetch([jsonResponse({}, { status: 503 }), jsonResponse({ id: 'ok' })])
    const { client } = harness(f)
    const p = client.me()
    await vi.advanceTimersByTimeAsync(500)
    await expect(p).resolves.toEqual({ id: 'ok' })
  })

  it('surfaces a repeated 5xx as a server error', async () => {
    const f = scriptedFetch([jsonResponse({}, { status: 500 }), jsonResponse({}, { status: 502 })])
    const { client } = harness(f)
    const p = rejection(client.me())
    await vi.advanceTimersByTimeAsync(500)
    const err = await p
    expect(err.code).toBe('server')
    expect(err.status).toBe(502)
  })

  it.each(['POST', 'PUT', 'DELETE'])('never retries %s on network errors', async (method) => {
    const f = fakeFetch(() => {
      throw new TypeError('Failed to fetch')
    })
    const { client } = harness(f)
    const p = rejection(client.request(method, '/v1/x'))
    await vi.advanceTimersByTimeAsync(2000)
    expect((await p).code).toBe('network')
    expect(f.calls).toHaveLength(1)
  })

  it('never retries a POST on 5xx', async () => {
    const f = fakeFetch(() => jsonResponse({}, { status: 500 }))
    const { client } = harness(f)
    const p = rejection(client.request('POST', '/v1/x', { body: {} }))
    await vi.advanceTimersByTimeAsync(2000)
    expect((await p).code).toBe('server')
    expect(f.calls).toHaveLength(1)
  })

  it('does not retry when the caller signal is aborted after a failure', async () => {
    const ctrl = new AbortController()
    const f = fakeFetch(() => {
      ctrl.abort()
      throw new TypeError('x')
    })
    const { client } = harness(f)
    expect((await rejection(client.me(ctrl.signal))).code).toBe('aborted')
    expect(f.calls).toHaveLength(1)
  })

  it('a retried unauthenticated GET sends no token', async () => {
    const f = scriptedFetch([new TypeError('x'), jsonResponse({ name: 'n' })])
    const { client } = harness(f)
    const p = client.serverInfo()
    await vi.advanceTimersByTimeAsync(500)
    await p
    expect(f.calls.map((c) => c.headers.Authorization)).toEqual([undefined, undefined])
  })
})

describe('token refresh', () => {
  const refreshed = (over = {}): Response =>
    jsonResponse(wireSession({ accessToken: 'access-2', refreshToken: 'refresh-2', expiresIn: 1800, ...over }))

  it('refreshes before the request when the token is expired', async () => {
    const f = scriptedFetch([refreshed(), jsonResponse({ id: 'u1' })])
    const h = harness(f, { expiresAt: NOW - 1 })
    await h.client.me()
    expect(f.calls[0]!.url).toBe(`${BASE}/v1/auth/refresh`)
    expect(f.calls[0]!.method).toBe('POST')
    expect(f.calls[0]!.body).toEqual({ refreshToken: 'refresh-1' })
    expect(f.calls[0]!.headers.Authorization).toBeUndefined()
    expect(f.calls[1]!.headers.Authorization).toBe('Bearer access-2')
    expect(h.setSession).toHaveBeenCalledTimes(1)
    expect(h.session.current).toMatchObject({
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      serverUrl: BASE,
      expiresAt: NOW + 1_800_000
    })
  })

  it('refreshes preemptively inside the 30 second skew window, but not outside it', async () => {
    const inside = scriptedFetch([refreshed(), jsonResponse({})])
    await harness(inside, { expiresAt: NOW + 30_000 }).client.me()
    expect(inside.calls[0]!.url).toContain('/auth/refresh')

    const outside = scriptedFetch([jsonResponse({})])
    await harness(outside, { expiresAt: NOW + 30_001 }).client.me()
    expect(outside.calls).toHaveLength(1)
    expect(outside.calls[0]!.url).toContain('/v1/me')
  })

  it('does not refresh for unauthenticated requests', async () => {
    const f = scriptedFetch([jsonResponse({ name: 'n' })])
    await harness(f, { expiresAt: NOW - 10_000 }).client.serverInfo()
    expect(f.calls).toHaveLength(1)
  })

  it('on 401 refreshes once and retries with the new token', async () => {
    const f = scriptedFetch([jsonResponse({}, { status: 401 }), refreshed(), jsonResponse({ id: 'u1' })])
    const h = harness(f)
    await expect(h.client.me()).resolves.toEqual({ id: 'u1' })
    expect(f.calls.map((c) => c.url.replace(BASE, ''))).toEqual(['/v1/me', '/v1/auth/refresh', '/v1/me'])
    expect(f.calls[0]!.headers.Authorization).toBe('Bearer access-1')
    expect(f.calls[2]!.headers.Authorization).toBe('Bearer access-2')
  })

  it('retries a POST after 401 refresh with the same body', async () => {
    const f = scriptedFetch([jsonResponse({}, { status: 401 }), refreshed(), emptyResponse()])
    await harness(f).client.request('POST', '/v1/thing', { body: { n: 1 } })
    expect(f.calls[2]!.body).toEqual({ n: 1 })
    expect(f.calls[2]!.method).toBe('POST')
  })

  it('does not loop when the retry is also unauthorized', async () => {
    const f = scriptedFetch([jsonResponse({}, { status: 401 }), refreshed(), jsonResponse({}, { status: 401 })])
    const h = harness(f)
    expect((await rejection(h.client.me())).code).toBe('unauthorized')
    expect(f.calls).toHaveLength(3)
  })

  it('shares ONE refresh between concurrent requests with an expired token', async () => {
    let refreshCalls = 0
    const f = fakeFetch(async (c) => {
      if (c.url.endsWith('/v1/auth/refresh')) {
        refreshCalls++
        await Promise.resolve()
        return refreshed()
      }
      return jsonResponse({ ok: c.headers.Authorization })
    })
    const h = harness(f, { expiresAt: NOW - 1 })
    const results = await Promise.all([h.client.me(), h.client.home(), h.client.libraryTracks()])
    expect(refreshCalls).toBe(1)
    expect(results).toEqual([{ ok: 'Bearer access-2' }, { ok: 'Bearer access-2' }, { ok: 'Bearer access-2' }])
    expect(h.setSession).toHaveBeenCalledTimes(1)
  })

  it('shares ONE refresh between concurrent requests that all hit 401', async () => {
    let refreshCalls = 0
    const f = fakeFetch(async (c) => {
      if (c.url.endsWith('/v1/auth/refresh')) {
        refreshCalls++
        await new Promise((r) => setTimeout(r, 10))
        return refreshed()
      }
      return c.headers.Authorization === 'Bearer access-2' ? jsonResponse({ ok: true }) : jsonResponse({}, { status: 401 })
    })
    vi.useFakeTimers()
    const h = harness(f)
    const all = Promise.all([h.client.me(), h.client.home(), h.client.libraryAlbums()])
    await vi.advanceTimersByTimeAsync(50)
    await expect(all).resolves.toHaveLength(3)
    expect(refreshCalls).toBe(1)
  })

  it('allows a new refresh once the previous one completed', async () => {
    const f = scriptedFetch([refreshed(), refreshed({ accessToken: 'access-3' })])
    const h = harness(f)
    await h.client.refresh()
    await h.client.refresh()
    expect(f.calls).toHaveLength(2)
    expect(f.calls[1]!.body).toEqual({ refreshToken: 'refresh-2' })
  })

  it.each([401, 400, 403])('signs out when the refresh endpoint answers %i', async (status) => {
    const f = scriptedFetch([jsonResponse({}, { status: 401 }), jsonResponse({}, { status })])
    const h = harness(f)
    const err = await rejection(h.client.me())
    expect(err.code).toBe('unauthorized')
    expect(err.message).toMatch(/sign in again/i)
    expect(h.setSession).toHaveBeenCalledExactlyOnceWith(null)
    expect(h.session.current).toBeNull()
  })

  it('signs out when the preemptive refresh is rejected', async () => {
    const f = scriptedFetch([jsonResponse({}, { status: 401 })])
    const h = harness(f, { expiresAt: NOW - 1 })
    expect((await rejection(h.client.me())).code).toBe('unauthorized')
    expect(h.session.current).toBeNull()
    expect(f.calls).toHaveLength(1)
  })

  it('does NOT sign out when the refresh fails transiently (network / 5xx)', async () => {
    const f = scriptedFetch([new TypeError('offline')])
    const h = harness(f, { expiresAt: NOW - 1 })
    expect((await rejection(h.client.me())).code).toBe('network')
    expect(h.setSession).not.toHaveBeenCalled()
    expect(h.session.current).not.toBeNull()

    const g = scriptedFetch([jsonResponse({}, { status: 503 })])
    const h2 = harness(g, { expiresAt: NOW - 1 })
    expect((await rejection(h2.client.me())).code).toBe('server')
    expect(h2.setSession).not.toHaveBeenCalled()
  })

  it('fails with bad_response (and keeps the session) when refresh returns garbage', async () => {
    const f = scriptedFetch([jsonResponse({ nope: true })])
    const h = harness(f, { expiresAt: NOW - 1 })
    expect((await rejection(h.client.refresh())).code).toBe('bad_response')
    expect(h.setSession).not.toHaveBeenCalled()
  })

  it('refresh() throws unauthorized when signed out', async () => {
    const h = harness(fakeFetch(() => jsonResponse({})), null)
    expect((await rejection(h.client.refresh())).code).toBe('unauthorized')
    expect(h.fetch.calls).toHaveLength(0)
  })
})

describe('endpoints', () => {
  async function call<T>(fn: (c: ApiClient) => Promise<T>, response: Response = jsonResponse({})): Promise<{ method: string; path: string; query: Record<string, string>; body: unknown }> {
    const f = fakeFetch(() => response.clone())
    await fn(harness(f).client)
    const c = f.calls[0]!
    const url = new URL(c.url)
    return { method: c.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: c.body }
  }

  it('me / home / serverInfo', async () => {
    expect(await call((c) => c.me())).toMatchObject({ method: 'GET', path: '/v1/me' })
    expect(await call((c) => c.home())).toMatchObject({ method: 'GET', path: '/v1/home' })
    expect(await call((c) => c.serverInfo())).toMatchObject({ method: 'GET', path: '/v1/info' })
  })

  it('search sends q, joined types and limit', async () => {
    expect(await call((c) => c.search('hello world', { types: ['track', 'album'], limit: 20 }))).toMatchObject({
      method: 'GET',
      path: '/v1/search',
      query: { q: 'hello world', types: 'track,album', limit: '20' }
    })
    const bare = await call((c) => c.search('x'))
    expect(bare.query).toEqual({ q: 'x' })
  })

  it.each([
    ['libraryTracks', '/v1/library/tracks'],
    ['libraryAlbums', '/v1/library/albums'],
    ['libraryArtists', '/v1/library/artists'],
    ['libraryPlaylists', '/v1/library/playlists']
  ] as const)('%s pages with offset/limit (defaults 0/50)', async (method, path) => {
    expect(await call((c) => (c[method] as (o?: number, l?: number) => Promise<unknown>)())).toMatchObject({ method: 'GET', path, query: { offset: '0', limit: '50' } })
    expect(await call((c) => (c[method] as (o?: number, l?: number) => Promise<unknown>)(100, 25))).toMatchObject({ query: { offset: '100', limit: '25' } })
  })

  it.each([
    ['album', '/v1/albums/'],
    ['artist', '/v1/artists/'],
    ['playlist', '/v1/playlists/']
  ] as const)('%s encodes the id into the path', async (method, prefix) => {
    const invoke = (c: ApiClient, id: string): Promise<unknown> => (c[method] as (id: string) => Promise<unknown>)(id)
    expect((await call((c) => invoke(c, 'abc'))).path).toBe(`${prefix}abc`)
    const f = fakeFetch(() => jsonResponse({}))
    await invoke(harness(f).client, 'a/b c?#%')
    expect(f.calls[0]!.url).toBe(`${BASE}${prefix}a%2Fb%20c%3F%23%25`)
    expect(new URL(f.calls[0]!.url).search).toBe('')
  })

  it('stream / lyrics encode the track id', async () => {
    const f = fakeFetch(() => jsonResponse({}))
    const { client } = harness(f)
    await client.stream('x/y')
    await client.lyrics('x y')
    expect(f.calls[0]!.url).toBe(`${BASE}/v1/tracks/x%2Fy/stream`)
    expect(f.calls[1]!.url).toBe(`${BASE}/v1/tracks/x%20y/lyrics`)
    expect(f.calls.every((c) => c.method === 'GET')).toBe(true)
  })

  it('setLyricsOffset PUTs {offsetMs} to the encoded track path; adminSetLyrics accepts plain', async () => {
    const f = fakeFetch(() => jsonResponse({ offsetMs: 500 }))
    const { client } = harness(f)
    expect(await client.setLyricsOffset('a/b', 500)).toEqual({ offsetMs: 500 })
    expect(f.calls[0]!.url).toBe(`${BASE}/v1/tracks/a%2Fb/lyrics/offset`)
    expect(f.calls[0]!.method).toBe('PUT')
    expect(f.calls[0]!.body).toEqual({ offsetMs: 500 })
    const g = fakeFetch(() => emptyResponse())
    await harness(g).client.adminSetLyrics('t1', { format: 'plain', content: 'la la' })
    expect(g.calls[0]!.url).toBe(`${BASE}/v1/admin/tracks/t1/lyrics`)
    expect(g.calls[0]!.body).toEqual({ format: 'plain', content: 'la la' })
  })

  it('setLiked uses PUT to like and DELETE to unlike, with an encoded id', async () => {
    const f = fakeFetch(() => emptyResponse())
    const { client } = harness(f)
    await client.setLiked('a/b', true)
    await client.setLiked('a/b', false)
    expect(f.calls.map((c) => `${c.method} ${c.url.replace(BASE, '')}`)).toEqual([
      'PUT /v1/library/tracks/a%2Fb',
      'DELETE /v1/library/tracks/a%2Fb'
    ])
    expect(f.calls[0]!.rawBody).toBeUndefined()
  })

  it('reportPlayed posts rounded seconds and an ISO timestamp from the injected clock', async () => {
    const f = fakeFetch(() => emptyResponse())
    const h = harness(f)
    h.clock.t = Date.UTC(2026, 0, 2, 3, 4, 5)
    h.session.current!.expiresAt = h.clock.t + 3_600_000
    await h.client.reportPlayed('t/1', 41.6)
    expect(f.calls[0]!.method).toBe('POST')
    expect(f.calls[0]!.url).toBe(`${BASE}/v1/tracks/t%2F1/played`)
    expect(f.calls[0]!.body).toEqual({ playedSeconds: 42, at: '2026-01-02T03:04:05.000Z' })
  })

  it('reportPlayed sends the client playId and the listen start time when given', async () => {
    const f = fakeFetch(() => emptyResponse())
    const h = harness(f)
    h.session.current!.expiresAt = h.clock.t + 3_600_000
    await h.client.reportPlayed('t1', 30.2, { playId: 'abc-12345', at: '2026-01-01T00:00:00.000Z' })
    expect(f.calls[0]!.body).toEqual({ playedSeconds: 30, at: '2026-01-01T00:00:00.000Z', playId: 'abc-12345' })
  })

  it('statsSummary and statsHistory call the stats endpoints with their query', async () => {
    const f = fakeFetch(() => jsonResponse({}))
    const h = harness(f)
    await h.client.statsSummary('month', 2, 5)
    await h.client.statsHistory('week', 12)
    await h.client.statsSummary('all')
    expect(f.calls[0]!.method).toBe('GET')
    expect(f.calls[0]!.url).toBe(`${BASE}/v1/stats/summary?range=month&offset=2&limit=5`)
    expect(f.calls[1]!.url).toBe(`${BASE}/v1/stats/history?period=week&count=12`)
    expect(f.calls[2]!.url).toBe(`${BASE}/v1/stats/summary?range=all&offset=0&limit=10`)
  })

  it('passes a request signal through to fetch', async () => {
    const f = fakeFetch(() => jsonResponse({}))
    const { client } = harness(f)
    await client.album('a', new AbortController().signal)
    expect(f.calls[0]!.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('logout', () => {
  it('posts the refresh token then clears the session', async () => {
    const f = fakeFetch(() => emptyResponse())
    const h = harness(f)
    await h.client.logout()
    expect(f.calls[0]!.method).toBe('POST')
    expect(f.calls[0]!.url).toBe(`${BASE}/v1/auth/logout`)
    expect(f.calls[0]!.body).toEqual({ refreshToken: 'refresh-1' })
    expect(h.setSession).toHaveBeenCalledExactlyOnceWith(null)
  })

  it('clears the session even when the request fails, and propagates the error', async () => {
    const h = harness(fakeFetch(() => jsonResponse({}, { status: 500 })))
    expect((await rejection(h.client.logout())).code).toBe('server')
    expect(h.session.current).toBeNull()
  })

  it('is a no-op when already signed out', async () => {
    const f = fakeFetch(() => emptyResponse())
    const h = harness(f, null)
    await expect(h.client.logout()).resolves.toBeUndefined()
    expect(f.calls).toHaveLength(0)
    expect(h.setSession).not.toHaveBeenCalled()
  })
})

describe('toStoredSession', () => {
  it('adds server url and absolute expiry', () => {
    const s = toStoredSession(BASE, wireSession({ expiresIn: 60 }), 5000)
    expect(s).toMatchObject({ serverUrl: BASE, expiresAt: 65_000, accessToken: 'access-1', refreshToken: 'refresh-1' })
    expect(s.user.id).toBe('u1')
  })

  it.each([0, -5, NaN, Infinity])('defaults expiresIn=%p to one hour', (expiresIn) => {
    const s = toStoredSession(BASE, wireSession({ expiresIn }), 0)
    expect(s.expiresAt).toBe(3_600_000)
  })

  it('defaults a missing / non-numeric expiresIn', () => {
    const raw = { ...wireSession(), expiresIn: undefined } as never
    expect(toStoredSession(BASE, raw, 0).expiresAt).toBe(3_600_000)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['no access token', { ...wireSession(), accessToken: undefined }],
    ['numeric access token', { ...wireSession(), accessToken: 5 }],
    ['no refresh token', { ...wireSession(), refreshToken: undefined }],
    ['no user', { ...wireSession(), user: undefined }]
  ])('rejects %s with bad_response', (_n, value) => {
    try {
      toStoredSession(BASE, value as never, 0)
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError)
      expect((e as ApiError).code).toBe('bad_response')
    }
  })
})

describe('ServerApi.info', () => {
  const info = { name: 'Nocturne', version: '1.0.0', apiVersion: 1 }

  it('GETs /v1/info unauthenticated', async () => {
    const f = fakeFetch(() => jsonResponse(info))
    await expect(ServerApi.info(BASE, f)).resolves.toEqual(info)
    expect(f.calls[0]!.url).toBe(`${BASE}/v1/info`)
    expect(f.calls[0]!.method).toBe('GET')
    expect(f.calls[0]!.headers).toEqual({ Accept: 'application/json' })
    expect(f.calls[0]!.init.credentials).toBe('omit')
  })

  it('maps failures like the client does', async () => {
    expect((await rejection(ServerApi.info(BASE, fakeFetch(() => jsonResponse({}, { status: 404 }))))).code).toBe('not_found')
    expect((await rejection(ServerApi.info(BASE, fakeFetch(() => textResponse('<html>'))))).code).toBe('bad_response')
    expect((await rejection(ServerApi.info(BASE, fakeFetch(() => { throw new TypeError('x') })))).code).toBe('network')
  })

  it('does not retry', async () => {
    const f = fakeFetch(() => {
      throw new TypeError('x')
    })
    await rejection(ServerApi.info(BASE, f))
    expect(f.calls).toHaveLength(1)
  })

  it('times out after 8 seconds', async () => {
    vi.useFakeTimers()
    const f = fakeFetch((c) => hangUntilAbort(c.signal))
    const p = rejection(ServerApi.info(BASE, f))
    await vi.advanceTimersByTimeAsync(7999)
    expect(f.calls[0]!.signal!.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect((await p).code).toBe('timeout')
  })

  it('supports cancellation', async () => {
    const ctrl = new AbortController()
    const f = fakeFetch((c) => hangUntilAbort(c.signal))
    const p = rejection(ServerApi.info(BASE, f, ctrl.signal))
    ctrl.abort()
    expect((await p).code).toBe('aborted')
  })
})

describe('ServerApi.login', () => {
  it('posts credentials and returns a stored session', async () => {
    const f = fakeFetch(() => jsonResponse(wireSession({ expiresIn: 120 })))
    const s = await ServerApi.login(BASE, 'demo', 'pw', f, 1000)
    expect(f.calls[0]!.method).toBe('POST')
    expect(f.calls[0]!.url).toBe(`${BASE}/v1/auth/login`)
    expect(f.calls[0]!.body).toEqual({ username: 'demo', password: 'pw' })
    expect(f.calls[0]!.headers['Content-Type']).toBe('application/json')
    expect(f.calls[0]!.headers.Authorization).toBeUndefined()
    expect(s).toMatchObject({ serverUrl: BASE, expiresAt: 121_000, accessToken: 'access-1' })
  })

  it('uses Date.now by default', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(50_000)
    const s = await ServerApi.login(BASE, 'u', 'p', fakeFetch(() => jsonResponse(wireSession({ expiresIn: 10 }))))
    expect(s.expiresAt).toBe(60_000)
  })

  it('replaces a 401 with a clear wrong-password message', async () => {
    const f = fakeFetch(() => jsonResponse({ message: 'invalid_grant' }, { status: 401 }))
    const err = await rejection(ServerApi.login(BASE, 'demo', 'bad', f))
    expect(err.code).toBe('unauthorized')
    expect(err.status).toBe(401)
    expect(err.message).toBe('Wrong username or password.')
  })

  it('passes other errors through untouched', async () => {
    const e429 = await rejection(ServerApi.login(BASE, 'a', 'b', fakeFetch(() => jsonResponse({ message: 'chill' }, { status: 429, headers: { 'Retry-After': '9' } }))))
    expect(e429).toMatchObject({ code: 'rate_limited', retryAfter: 9, message: 'chill' })
    const e500 = await rejection(ServerApi.login(BASE, 'a', 'b', fakeFetch(() => jsonResponse({}, { status: 500 }))))
    expect(e500.code).toBe('server')
    const net = await rejection(ServerApi.login(BASE, 'a', 'b', fakeFetch(() => { throw new TypeError('x') })))
    expect(net.code).toBe('network')
  })

  it('rejects structurally invalid responses', async () => {
    const err = await rejection(ServerApi.login(BASE, 'a', 'b', fakeFetch(() => jsonResponse({ hello: 'world' }))))
    expect(err.code).toBe('bad_response')
  })
})

// ---------------------------------------------------------------------------
// Cookie session (hosted web)
// ---------------------------------------------------------------------------

function cookieHarness(fetch: FakeFetch, over: Partial<StoredSession> | null = {}): Harness {
  const session = { current: over === null ? null : storedSession({ refreshToken: '', expiresAt: NOW + 3_600_000, ...over }) }
  const clock = { t: NOW }
  const setSession = vi.fn((s: StoredSession | null) => {
    session.current = s
  })
  const client = new ApiClient({ getSession: () => session.current, setSession, fetch, now: () => clock.t, cookieSession: true })
  return { client, fetch, session, setSession, clock }
}

describe('cookie session mode', () => {
  it('sends the session header and same-origin credentials on every request', async () => {
    const f = fakeFetch(() => jsonResponse({ id: 'u1' }))
    await cookieHarness(f).client.me()
    const c = f.calls[0]!
    expect(c.headers).toEqual({ Accept: 'application/json', Authorization: 'Bearer access-1', 'X-Nocturne-Session': 'cookie' })
    expect(c.init.credentials).toBe('same-origin')
  })

  it('also marks unauthenticated requests', async () => {
    const f = fakeFetch(() => jsonResponse({ name: 'N' }))
    await cookieHarness(f).client.serverInfo()
    expect(f.calls[0]!.headers['X-Nocturne-Session']).toBe('cookie')
    expect(f.calls[0]!.headers.Authorization).toBeUndefined()
  })

  it('non-cookie clients never send the header and keep credentials omitted', async () => {
    const f = fakeFetch(() => jsonResponse({ id: 'u1' }))
    await harness(f).client.me()
    expect(f.calls[0]!.headers['X-Nocturne-Session']).toBeUndefined()
    expect(f.calls[0]!.init.credentials).toBe('omit')
  })

  it('refreshes by posting {} (no token) and accepts the empty refresh token', async () => {
    const f = scriptedFetch([
      jsonResponse({}, { status: 401 }),
      jsonResponse(wireSession({ accessToken: 'access-2', refreshToken: '' })),
      jsonResponse({ id: 'u1' })
    ])
    const h = cookieHarness(f)
    await h.client.me()
    const refresh = f.calls[1]!
    expect(refresh.url).toBe(`${BASE}/v1/auth/refresh`)
    expect(refresh.body).toEqual({})
    expect(refresh.headers['X-Nocturne-Session']).toBe('cookie')
    expect(refresh.init.credentials).toBe('same-origin')
    expect(h.session.current).toMatchObject({ accessToken: 'access-2', refreshToken: '', serverUrl: BASE })
    expect(f.calls[2]!.headers.Authorization).toBe('Bearer access-2')
  })

  it('a rejected cookie refresh signs out', async () => {
    const f = scriptedFetch([jsonResponse({}, { status: 401 }), jsonResponse({}, { status: 401 })])
    const h = cookieHarness(f)
    expect((await rejection(h.client.me())).code).toBe('unauthorized')
    expect(h.setSession).toHaveBeenCalledWith(null)
  })

  it('logout posts {} with the session header', async () => {
    const f = fakeFetch(() => emptyResponse())
    const h = cookieHarness(f)
    await h.client.logout()
    expect(f.calls[0]!.url).toBe(`${BASE}/v1/auth/logout`)
    expect(f.calls[0]!.body).toEqual({})
    expect(f.calls[0]!.headers['X-Nocturne-Session']).toBe('cookie')
    expect(h.setSession).toHaveBeenCalledExactlyOnceWith(null)
  })

  it('non-cookie refresh rejects an empty refresh token from the server', async () => {
    const f = scriptedFetch([jsonResponse({}, { status: 401 }), jsonResponse(wireSession({ refreshToken: '' }))])
    const h = harness(f)
    expect((await rejection(h.client.me())).code).toBe('bad_response')
    expect(h.session.current!.refreshToken).toBe('refresh-1')
  })
})

describe('toStoredSession refresh token rules', () => {
  it('accepts "" only in cookie mode', () => {
    expect(toStoredSession(BASE, wireSession({ refreshToken: '' }), 0, { cookieSession: true }).refreshToken).toBe('')
    expect(() => toStoredSession(BASE, wireSession({ refreshToken: '' }), 0)).toThrow(ApiError)
    expect(() => toStoredSession(BASE, wireSession({ refreshToken: '' }), 0, { cookieSession: false })).toThrow(ApiError)
  })

  it('still rejects a missing refresh token in cookie mode', () => {
    expect(() => toStoredSession(BASE, { ...wireSession(), refreshToken: undefined } as never, 0, { cookieSession: true })).toThrow(ApiError)
    expect(() => toStoredSession(BASE, null as never, 0, { cookieSession: true })).toThrow(ApiError)
  })
})

describe('ServerApi cookie mode', () => {
  it('login with cookieSession sends the header, same-origin credentials and accepts ""', async () => {
    const f = fakeFetch(() => jsonResponse(wireSession({ refreshToken: '' })))
    const s = await ServerApi.login(BASE, 'demo', 'pw', f, 1000, { cookieSession: true })
    const c = f.calls[0]!
    expect(c.headers['X-Nocturne-Session']).toBe('cookie')
    expect(c.init.credentials).toBe('same-origin')
    expect(c.body).toEqual({ username: 'demo', password: 'pw' })
    expect(s).toMatchObject({ refreshToken: '', expiresAt: 1000 + 3_600_000, serverUrl: BASE })
  })

  it('login without the option is unchanged (no header, omit, empty refresh token rejected)', async () => {
    const f = fakeFetch(() => jsonResponse(wireSession()))
    await ServerApi.login(BASE, 'demo', 'pw', f, 1000)
    expect(f.calls[0]!.headers).toEqual({ 'Content-Type': 'application/json', Accept: 'application/json' })
    expect(f.calls[0]!.init.credentials).toBe('omit')
    const err = await rejection(ServerApi.login(BASE, 'a', 'b', fakeFetch(() => jsonResponse(wireSession({ refreshToken: '' })))))
    expect(err.code).toBe('bad_response')
  })

  it('cookie login still maps 401 to the wrong-password message', async () => {
    const err = await rejection(ServerApi.login(BASE, 'a', 'b', fakeFetch(() => jsonResponse({}, { status: 401 })), 0, { cookieSession: true }))
    expect(err.message).toBe('Wrong username or password.')
  })

  it('refreshCookie posts {} with the cookie headers and returns a stored session', async () => {
    const f = fakeFetch(() => jsonResponse(wireSession({ accessToken: 'a-cookie', refreshToken: '', expiresIn: 60 })))
    const s = await ServerApi.refreshCookie(BASE, f, 2000)
    const c = f.calls[0]!
    expect(c.url).toBe(`${BASE}/v1/auth/refresh`)
    expect(c.method).toBe('POST')
    expect(c.rawBody).toBe('{}')
    expect(c.headers['X-Nocturne-Session']).toBe('cookie')
    expect(c.init.credentials).toBe('same-origin')
    expect(s).toMatchObject({ accessToken: 'a-cookie', refreshToken: '', serverUrl: BASE, expiresAt: 62_000 })
  })

  it('refreshCookie maps 401 to unauthorized, network to network, and uses Date.now by default', async () => {
    expect((await rejection(ServerApi.refreshCookie(BASE, fakeFetch(() => jsonResponse({}, { status: 401 }))))).code).toBe('unauthorized')
    expect((await rejection(ServerApi.refreshCookie(BASE, fakeFetch(() => { throw new TypeError('x') })))).code).toBe('network')
    const before = Date.now()
    const s = await ServerApi.refreshCookie(BASE, fakeFetch(() => jsonResponse(wireSession({ refreshToken: '', expiresIn: 10 }))))
    expect(s.expiresAt).toBeGreaterThanOrEqual(before + 10_000)
  })

  it('refreshCookie supports cancellation', async () => {
    const ctrl = new AbortController()
    const p = rejection(ServerApi.refreshCookie(BASE, fakeFetch((c) => hangUntilAbort(c.signal)), 0, ctrl.signal))
    ctrl.abort()
    expect((await p).code).toBe('aborted')
  })
})

// ---------------------------------------------------------------------------
// Admin endpoints
// ---------------------------------------------------------------------------

describe('admin endpoints', () => {
  async function call<T>(fn: (c: ApiClient) => Promise<T>, response: Response = jsonResponse({})): Promise<{ method: string; path: string; rawPath: string; query: Record<string, string>; body: unknown; headers: Record<string, string> }> {
    const f = fakeFetch(() => response.clone())
    await fn(harness(f).client)
    const c = f.calls[0]!
    const url = new URL(c.url)
    return { method: c.method, path: url.pathname, rawPath: url.pathname, query: Object.fromEntries(url.searchParams), body: c.body, headers: c.headers }
  }

  it('adminStats', async () => {
    expect(await call((c) => c.adminStats())).toMatchObject({ method: 'GET', path: '/v1/admin/stats', query: {} })
  })

  it('adminSearchSource sends source and q', async () => {
    const r = await call((c) => c.adminSearchSource('youtube', 'daft punk & co'))
    expect(r).toMatchObject({ method: 'GET', path: '/v1/admin/sources/search', query: { source: 'youtube', q: 'daft punk & co' } })
  })

  it('adminStartDownload posts the input as-is', async () => {
    expect(await call((c) => c.adminStartDownload({ source: 'spotify', id: 'abc' }), jsonResponse({ id: 'j' }, { status: 201 }))).toMatchObject({
      method: 'POST', path: '/v1/admin/downloads', body: { source: 'spotify', id: 'abc' }
    })
    expect((await call((c) => c.adminStartDownload({ source: 'youtube', url: 'https://youtu.be/x' }))).body).toEqual({ source: 'youtube', url: 'https://youtu.be/x' })
  })

  it('adminImportPlaylist posts {url}', async () => {
    expect(await call((c) => c.adminImportPlaylist('https://open.spotify.com/playlist/1'))).toMatchObject({
      method: 'POST', path: '/v1/admin/imports', body: { url: 'https://open.spotify.com/playlist/1' }
    })
  })

  it('adminJobs / adminJob (encoded id)', async () => {
    expect(await call((c) => c.adminJobs())).toMatchObject({ method: 'GET', path: '/v1/admin/jobs' })
    expect(await call((c) => c.adminJob('a/b c'))).toMatchObject({ method: 'GET', path: '/v1/admin/jobs/a%2Fb%20c' })
  })

  it('adminCancelJob deletes the encoded job and tolerates 204', async () => {
    expect(await call((c) => c.adminCancelJob('j/1'), emptyResponse())).toMatchObject({ method: 'DELETE', path: '/v1/admin/jobs/j%2F1' })
  })

  it('adminRescan posts with no body', async () => {
    const r = await call((c) => c.adminRescan())
    expect(r).toMatchObject({ method: 'POST', path: '/v1/admin/library/rescan', body: undefined })
    expect(r.headers['Content-Type']).toBeUndefined()
  })

  it('adminTracks defaults to offset 0, limit 50 and omits an empty q', async () => {
    expect(await call((c) => c.adminTracks())).toMatchObject({ method: 'GET', path: '/v1/admin/tracks', query: { offset: '0', limit: '50' } })
    expect((await call((c) => c.adminTracks({ q: '' }))).query).toEqual({ offset: '0', limit: '50' })
  })

  it('adminTracks passes q, offset and limit (including offset 0 explicitly)', async () => {
    expect((await call((c) => c.adminTracks({ q: 'a&b', offset: 100, limit: 25 }))).query).toEqual({ q: 'a&b', offset: '100', limit: '25' })
    expect((await call((c) => c.adminTracks({ offset: 0, limit: 10 }))).query).toEqual({ offset: '0', limit: '10' })
  })

  it('adminTracks forwards the abort signal', async () => {
    const f = fakeFetch(() => jsonResponse({ items: [] }))
    const ctrl = new AbortController()
    await harness(f).client.adminTracks({ signal: ctrl.signal })
    expect(f.calls[0]!.signal).toBeDefined()
  })

  it('adminDeleteTrack deletes the encoded track', async () => {
    expect(await call((c) => c.adminDeleteTrack('t/1 ?'), emptyResponse())).toMatchObject({ method: 'DELETE', path: '/v1/admin/tracks/t%2F1%20%3F' })
  })

  it('adminUsers / adminCreateUser / adminUpdateUser / adminDeleteUser', async () => {
    expect(await call((c) => c.adminUsers())).toMatchObject({ method: 'GET', path: '/v1/admin/users' })
    const input = { username: 'bob', displayName: 'Bob', password: 'correct-horse', role: 'user' as const }
    expect(await call((c) => c.adminCreateUser(input), jsonResponse({}, { status: 201 }))).toMatchObject({ method: 'POST', path: '/v1/admin/users', body: input })
    expect(await call((c) => c.adminUpdateUser('u/2', { role: 'admin', disabled: false }))).toMatchObject({
      method: 'PATCH', path: '/v1/admin/users/u%2F2', body: { role: 'admin', disabled: false }
    })
    expect(await call((c) => c.adminDeleteUser('u 3'), emptyResponse())).toMatchObject({ method: 'DELETE', path: '/v1/admin/users/u%203' })
  })

  it('adminBackups / adminCreateBackup / adminRestoreBackup', async () => {
    expect(await call((c) => c.adminBackups())).toMatchObject({ method: 'GET', path: '/v1/admin/backups' })
    expect(await call((c) => c.adminCreateBackup())).toMatchObject({ method: 'POST', path: '/v1/admin/backups', body: undefined })
    expect(await call((c) => c.adminRestoreBackup('b/1'), jsonResponse({}, { status: 202 }))).toMatchObject({
      method: 'POST', path: '/v1/admin/backups/b%2F1/restore', body: { confirm: true }
    })
  })

  it('admin 403 maps to forbidden with the server message and is not retried', async () => {
    const f = fakeFetch(() => jsonResponse({ message: 'Admins only.' }, { status: 403 }))
    const err = await rejection(harness(f).client.adminStats())
    expect(err.code).toBe('forbidden')
    expect(err.message).toBe('Admins only.')
    expect(f.calls).toHaveLength(1)
  })

  it('admin 409 surfaces the server message', async () => {
    const f = fakeFetch(() => jsonResponse({ message: 'Last admin.' }, { status: 409 }))
    const err = await rejection(harness(f).client.adminDeleteUser('u1'))
    expect(err.status).toBe(409)
    expect(err.message).toBe('Last admin.')
  })
})

// ---------------------------------------------------------------------------
// adminUpload (XMLHttpRequest)
// ---------------------------------------------------------------------------

class FakeXHR {
  static instances: FakeXHR[] = []
  /** Scripted behaviour per send(), consumed in order. */
  static script: Array<(xhr: FakeXHR) => void> = []
  method = ''
  url = ''
  headers: Record<string, string> = {}
  withCredentials = true
  responseType = ''
  status = 0
  responseText = ''
  body: unknown = null
  aborted = false
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  constructor() {
    FakeXHR.instances.push(this)
  }
  open(method: string, url: string): void {
    this.method = method
    this.url = url
  }
  setRequestHeader(k: string, v: string): void {
    this.headers[k] = v
  }
  send(body: unknown): void {
    this.body = body
    const step = FakeXHR.script.shift()
    if (!step) throw new Error('unscripted XHR send')
    step(this)
  }
  abort(): void {
    this.aborted = true
    this.onabort?.()
  }
  respond(status: number, body: unknown, raw?: string): void {
    this.status = status
    this.responseText = raw ?? (body === null ? '' : JSON.stringify(body))
    this.onload?.()
  }
}

describe('adminUpload', () => {
  const TRACK = { id: 't9', title: 'Uploaded', artists: [], album: { id: 'a', title: 'A' }, duration: 100, artwork: [] }
  const blob = (): Blob => new Blob(['audio-bytes'], { type: 'audio/mpeg' })
  const realXhr = globalThis.XMLHttpRequest

  beforeEach(() => {
    FakeXHR.instances = []
    FakeXHR.script = []
    ;(globalThis as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXHR
  })
  afterEach(() => {
    ;(globalThis as { XMLHttpRequest: unknown }).XMLHttpRequest = realXhr
  })

  it('posts multipart form data with the bearer token and reports progress up to 1', async () => {
    const progress: number[] = []
    FakeXHR.script.push((x) => {
      x.upload.onprogress?.({ lengthComputable: true, loaded: 25, total: 100 })
      x.upload.onprogress?.({ lengthComputable: false, loaded: 50, total: 0 })
      x.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 })
      x.respond(201, TRACK)
    })
    const h = harness(fakeFetch(() => jsonResponse({})))
    await expect(h.client.adminUpload(blob(), 'song.mp3', { onProgress: (f) => progress.push(f) })).resolves.toEqual(TRACK)
    const x = FakeXHR.instances[0]!
    expect(x.method).toBe('POST')
    expect(x.url).toBe(`${BASE}/v1/admin/uploads`)
    expect(x.headers).toEqual({ Authorization: 'Bearer access-1', Accept: 'application/json' })
    expect(x.withCredentials).toBe(false)
    expect(x.responseType).toBe('text')
    const form = x.body as FormData
    expect(form).toBeInstanceOf(FormData)
    const file = form.get('file') as File
    expect(file.name).toBe('song.mp3')
    expect(file.size).toBe(11)
    expect(progress).toEqual([0.25, 1, 1])
    expect(h.fetch.calls).toHaveLength(0)
  })

  it('works without an onProgress callback', async () => {
    FakeXHR.script.push((x) => {
      x.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 })
      x.respond(200, TRACK)
    })
    await expect(harness(fakeFetch(() => jsonResponse({}))).client.adminUpload(blob(), 'a.mp3')).resolves.toEqual(TRACK)
  })

  it('maps 413 to a payload-too-large error carrying the server message', async () => {
    FakeXHR.script.push((x) => x.respond(413, { message: 'File exceeds 200 MB.' }))
    const err = await rejection(harness(fakeFetch(() => jsonResponse({}))).client.adminUpload(blob(), 'big.flac'))
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(413)
    expect(err.message).toBe('File exceeds 200 MB.')
  })

  it('maps 415 and non-JSON error bodies', async () => {
    FakeXHR.script.push((x) => x.respond(415, null, '<html>nope</html>'))
    const err = await rejection(harness(fakeFetch(() => jsonResponse({}))).client.adminUpload(blob(), 'x.txt'))
    expect(err.status).toBe(415)
    expect(err.message.length).toBeGreaterThan(0)
  })

  it('treats a 2xx with an empty body as a bad response', async () => {
    FakeXHR.script.push((x) => x.respond(201, null))
    expect((await rejection(harness(fakeFetch(() => jsonResponse({}))).client.adminUpload(blob(), 'x.mp3'))).code).toBe('bad_response')
  })

  it('treats status 0 (no response) as a bad response', async () => {
    FakeXHR.script.push((x) => x.respond(0, null))
    expect((await rejection(harness(fakeFetch(() => jsonResponse({}))).client.adminUpload(blob(), 'x.mp3'))).code).toBe('bad_response')
  })

  it('maps network errors', async () => {
    FakeXHR.script.push((x) => x.onerror?.())
    const err = await rejection(harness(fakeFetch(() => jsonResponse({}))).client.adminUpload(blob(), 'x.mp3'))
    expect(err.code).toBe('network')
  })

  it('aborts through the signal and reports code=aborted', async () => {
    const ctrl = new AbortController()
    FakeXHR.script.push(() => {
      /* hang until aborted */
    })
    const p = rejection(harness(fakeFetch(() => jsonResponse({}))).client.adminUpload(blob(), 'x.mp3', { signal: ctrl.signal }))
    await flush()
    ctrl.abort()
    const err = await p
    expect(err.code).toBe('aborted')
    expect(FakeXHR.instances[0]!.aborted).toBe(true)
  })

  it('rejects immediately when the signal is already aborted, without sending', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const err = await rejection(harness(fakeFetch(() => jsonResponse({}))).client.adminUpload(blob(), 'x.mp3', { signal: ctrl.signal }))
    expect(err.code).toBe('aborted')
    expect(FakeXHR.instances[0]!.body).toBeNull()
  })

  it('refreshes first when the session is expired, then uploads with the new token', async () => {
    const f = scriptedFetch([jsonResponse(wireSession({ accessToken: 'access-2', refreshToken: 'refresh-2' }))])
    FakeXHR.script.push((x) => x.respond(201, TRACK))
    const h = harness(f, { expiresAt: NOW + 1000 })
    await h.client.adminUpload(blob(), 'x.mp3')
    expect(f.calls[0]!.url).toBe(`${BASE}/v1/auth/refresh`)
    expect(FakeXHR.instances[0]!.headers.Authorization).toBe('Bearer access-2')
  })

  it('on 401 refreshes once and retries with the new token', async () => {
    const f = scriptedFetch([jsonResponse(wireSession({ accessToken: 'access-2', refreshToken: 'refresh-2' }))])
    FakeXHR.script.push((x) => x.respond(401, { message: 'expired' }), (x) => x.respond(201, TRACK))
    const h = harness(f)
    await expect(h.client.adminUpload(blob(), 'x.mp3')).resolves.toEqual(TRACK)
    expect(FakeXHR.instances.map((x) => x.headers.Authorization)).toEqual(['Bearer access-1', 'Bearer access-2'])
    expect(f.calls).toHaveLength(1)
  })

  it('does not loop when the retry is unauthorized too', async () => {
    const f = scriptedFetch([jsonResponse(wireSession({ accessToken: 'access-2', refreshToken: 'refresh-2' }))])
    FakeXHR.script.push((x) => x.respond(401, {}), (x) => x.respond(401, {}))
    const err = await rejection(harness(f).client.adminUpload(blob(), 'x.mp3'))
    expect(err.code).toBe('unauthorized')
    expect(FakeXHR.instances).toHaveLength(2)
  })

  it('signs out when the refresh after a 401 is rejected', async () => {
    const f = scriptedFetch([jsonResponse({}, { status: 401 })])
    FakeXHR.script.push((x) => x.respond(401, {}))
    const h = harness(f)
    expect((await rejection(h.client.adminUpload(blob(), 'x.mp3'))).code).toBe('unauthorized')
    expect(h.setSession).toHaveBeenCalledWith(null)
  })

  it('does not retry non-auth errors', async () => {
    FakeXHR.script.push((x) => x.respond(500, { message: 'boom' }))
    const err = await rejection(harness(fakeFetch(() => jsonResponse({}))).client.adminUpload(blob(), 'x.mp3'))
    expect(err.code).toBe('server')
    expect(FakeXHR.instances).toHaveLength(1)
  })

  it('throws unauthorized when signed out', async () => {
    const err = await rejection(harness(fakeFetch(() => jsonResponse({})), null).client.adminUpload(blob(), 'x.mp3'))
    expect(err.code).toBe('unauthorized')
  })

  it('cookie mode adds the session header and with-credentials', async () => {
    FakeXHR.script.push((x) => x.respond(201, TRACK))
    await cookieHarness(fakeFetch(() => jsonResponse({}))).client.adminUpload(blob(), 'x.mp3')
    const x = FakeXHR.instances[0]!
    expect(x.headers['X-Nocturne-Session']).toBe('cookie')
    expect(x.withCredentials).toBe(true)
  })
})
