// @vitest-environment node
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/* eslint-disable @typescript-eslint/no-explicit-any */
// The renderer modules are loaded dynamically (by absolute path) so that this Node-typed test
// does not drag the DOM-typed renderer sources into tsconfig.node.json. Shapes are described locally.
const SERVER_FILE = resolve(__dirname, '../../mock-server/server.mjs')
const RENDERER = resolve(__dirname, '../../src/renderer/src')
const available = existsSync(SERVER_FILE)

interface StoredSession {
  serverUrl: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  user: { id: string; username: string; displayName: string; avatar?: unknown[] }
}
interface ApiError extends Error {
  code: string
  status: number
  retryAfter?: number
}
interface ApiClient {
  me(): Promise<any>
  serverInfo(): Promise<any>
  home(): Promise<{ sections: Array<{ id: string; kind: string; items: any[] }> }>
  search(q: string, opts?: { types?: string[]; limit?: number }): Promise<any>
  libraryTracks(offset?: number, limit?: number): Promise<{ items: any[]; offset: number; limit: number; total: number }>
  libraryAlbums(offset?: number, limit?: number): Promise<{ items: any[]; total: number }>
  libraryArtists(offset?: number, limit?: number): Promise<{ items: any[]; total: number }>
  libraryPlaylists(offset?: number, limit?: number): Promise<{ items: any[]; total: number }>
  album(id: string): Promise<any>
  artist(id: string): Promise<any>
  playlist(id: string): Promise<any>
  stream(id: string): Promise<{ url: string; expiresAt: string; mimeType?: string }>
  lyrics(id: string): Promise<{ synced: string | null; plain: string | null }>
  setLiked(id: string, liked: boolean): Promise<void>
  reportPlayed(id: string, seconds: number): Promise<void>
  logout(): Promise<void>
  refresh(): Promise<StoredSession>
}
interface ClientOptions {
  getSession: () => StoredSession | null
  setSession: (s: StoredSession | null) => void
  fetch: typeof fetch
  now?: () => number
  timeoutMs?: number
}
const { ApiClient, ServerApi } = (await import(/* @vite-ignore */ `${RENDERER}/api/client.ts`)) as {
  ApiClient: new (o: ClientOptions) => ApiClient
  ServerApi: {
    info(url: string, f?: typeof fetch): Promise<any>
    login(url: string, user: string, pass: string, f?: typeof fetch, now?: number): Promise<StoredSession>
  }
}
const { ApiError } = (await import(/* @vite-ignore */ `${RENDERER}/api/errors.ts`)) as { ApiError: new (...a: any[]) => ApiError }
const { parseLrc } = (await import(/* @vite-ignore */ `${RENDERER}/lyrics/lrc.ts`)) as {
  parseLrc(s: string): { synced: boolean; lines: Array<{ time: number; text: string }> }
}

interface MockCatalog {
  tracks: Array<{ id: string; title: string; duration?: number }>
  albums: Array<{ id: string; title: string }>
  artists: Array<{ id: string; name: string }>
  playlists: Array<{ id: string; name: string }>
  defaults: { likedTrackIds: string[] }
}
interface MockHandle {
  server: unknown
  catalog: MockCatalog
  url: string | null
  listen(port?: number, host?: string): Promise<{ url: string; port: number }>
  close(): Promise<void>
}
type CreateMockServer = (options?: Record<string, unknown>) => MockHandle

async function load(): Promise<CreateMockServer> {
  const mod = (await import(/* @vite-ignore */ pathToFileURL(SERVER_FILE).href)) as { createMockServer: CreateMockServer }
  return mod.createMockServer
}

interface Rig {
  mock: MockHandle
  url: string
  log: string[]
  clock: { t: number }
  /** Builds a client whose session lives in `holder`. */
  client(holder: { current: StoredSession | null }, now?: () => number): ApiClient
}

async function start(options: Record<string, unknown> = {}): Promise<Rig> {
  const createMockServer = await load()
  const log: string[] = []
  const clock = { t: Date.now() }
  const mock = createMockServer({ quiet: false, log: (l: string) => log.push(l), loginLimit: { max: 0, windowMs: 60_000 }, now: () => clock.t, ...options })
  const { url } = await mock.listen(0)
  return {
    mock,
    url,
    log,
    clock,
    client: (holder, now) =>
      new ApiClient({
        getSession: () => holder.current,
        setSession: (s) => {
          holder.current = s
        },
        fetch: (...a: Parameters<typeof fetch>) => fetch(...a),
        now,
        timeoutMs: 10_000
      })
  }
}

const refreshCalls = (rig: Rig): number => rig.log.filter((l) => l.startsWith('POST /v1/auth/refresh')).length

describe.skipIf(!available)('mock server integration (real ApiClient over HTTP)', () => {
  let rig: Rig
  let session: { current: StoredSession | null }
  let api: ApiClient
  let cat: MockCatalog

  beforeAll(async () => {
    rig = await start()
    cat = rig.mock.catalog
    session = { current: await ServerApi.login(rig.url, 'demo', 'demo', fetch) }
    api = rig.client(session)
  })

  afterAll(async () => {
    await rig.mock.close()
  })

  describe('server info and login', () => {
    it('describes itself as a v1 server', async () => {
      const info = await ServerApi.info(rig.url, fetch)
      expect(info).toMatchObject({ apiVersion: 1, capabilities: { lyrics: true, likes: true, scrobble: true } })
      expect(typeof info.name).toBe('string')
      expect(typeof info.version).toBe('string')
    })

    it('serverInfo works through the client too', async () => {
      await expect(api.serverInfo()).resolves.toMatchObject({ apiVersion: 1 })
    })

    it('logs in with the demo account', () => {
      const s = session.current!
      expect(s.serverUrl).toBe(rig.url)
      expect(s.accessToken).toMatch(/^[0-9a-f]{64}$/)
      expect(s.refreshToken).toMatch(/^[0-9a-f]{64}$/)
      expect(s.expiresAt).toBeGreaterThan(Date.now())
      expect(s.user).toMatchObject({ username: 'demo', displayName: 'Demo' })
      expect(s.user.avatar!.length).toBeGreaterThan(0)
    })

    it('matches usernames case-insensitively', async () => {
      await expect(ServerApi.login(rig.url, 'DEMO', 'demo', fetch)).resolves.toMatchObject({ user: { username: 'demo' } })
    })

    it('rejects a wrong password with the friendly message', async () => {
      const err = await ServerApi.login(rig.url, 'demo', 'wrong', fetch).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ApiError)
      expect(err).toMatchObject({ code: 'unauthorized', status: 401, message: 'Wrong username or password.' })
    })

    it('rejects an unknown user the same way', async () => {
      await expect(ServerApi.login(rig.url, 'nobody', 'demo', fetch)).rejects.toMatchObject({ message: 'Wrong username or password.' })
    })

    it('returns the signed-in user', async () => {
      await expect(api.me()).resolves.toMatchObject({ username: 'demo' })
    })
  })

  describe('authentication enforcement', () => {
    it('rejects calls without a token', async () => {
      const res = await fetch(`${rig.url}/v1/me`)
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toMatch(/Bearer/)
    })

    it('rejects a bogus token', async () => {
      const bogus = rig.client({ current: { ...session.current!, accessToken: 'f'.repeat(64) } })
      // the bogus token triggers a refresh with the (valid) refresh token which then succeeds,
      // so check the raw status instead
      const res = await fetch(`${rig.url}/v1/me`, { headers: { Authorization: 'Bearer ' + 'f'.repeat(64) } })
      expect(res.status).toBe(401)
      expect(bogus).toBeDefined()
    })
  })

  describe('browsing', () => {
    it('serves the home sections with every section kind', async () => {
      const home = await api.home()
      expect(home.sections.map((s) => s.kind).sort()).toEqual(['albums', 'albums', 'artists', 'playlists', 'tracks'])
      for (const section of home.sections) {
        expect(section.id).toBeTruthy()
        expect(section.items.length).toBeGreaterThan(0)
      }
    })

    it('searches across types and respects type filters and limits', async () => {
      const target = cat.tracks[3]!
      const word = target.title.split(' ')[0]!
      const res = await api.search(word, { limit: 5 })
      expect(res.tracks.length).toBeGreaterThan(0)
      expect(res.tracks.length).toBeLessThanOrEqual(5)
      expect(res.tracks.some((t: any) => t.id === target.id) || res.tracks.length === 5).toBe(true)

      const onlyAlbums = await api.search(cat.albums[0]!.title.split(' ')[0]!, { types: ['album'] })
      expect(onlyAlbums.tracks).toEqual([])
      expect(onlyAlbums.artists).toEqual([])
      expect(onlyAlbums.albums.length).toBeGreaterThan(0)

      const artist = cat.artists[0]!
      const byArtist = await api.search(artist.name, { types: ['artist'] })
      expect(byArtist.artists.map((a: any) => a.id)).toContain(artist.id)
    })

    it('returns empty results for nonsense queries', async () => {
      const res = await api.search('zzzzqqqxxxx')
      expect(res).toEqual({ tracks: [], albums: [], artists: [], playlists: [] })
    })

    it('rejects invalid search parameters as bad_request', async () => {
      await expect(api.search('x', { types: ['nope' as never] })).rejects.toMatchObject({ code: 'bad_request', status: 400 })
      await expect(api.search('x', { limit: 500 })).rejects.toMatchObject({ code: 'bad_request' })
    })

    it('pages through the library', async () => {
      const first = await api.libraryTracks(0, 5)
      expect(first).toMatchObject({ offset: 0, limit: 5 })
      expect(first.total).toBeGreaterThanOrEqual(first.items.length)
      expect(first.items.length).toBeLessThanOrEqual(5)
      const second = await api.libraryTracks(5, 5)
      expect(second.offset).toBe(5)
      const firstIds = new Set(first.items.map((t) => t.id))
      for (const t of second.items) expect(firstIds.has(t.id)).toBe(false)
      const all = await api.libraryTracks(0, 200)
      expect(all.items).toHaveLength(all.total)
      const past = await api.libraryTracks(all.total + 10, 5)
      expect(past.items).toEqual([])
      expect(past.total).toBe(all.total)
    })

    it('serves the other library lists', async () => {
      for (const p of [await api.libraryAlbums(), await api.libraryArtists(), await api.libraryPlaylists()]) {
        expect(p.items.length).toBeGreaterThan(0)
        expect(p.total).toBeGreaterThanOrEqual(p.items.length)
      }
    })

    it('rejects out-of-range paging', async () => {
      await expect(api.libraryTracks(0, 0)).rejects.toMatchObject({ code: 'bad_request' })
      await expect(api.libraryTracks(0, 201)).rejects.toMatchObject({ code: 'bad_request' })
      await expect(api.libraryTracks(-1, 10)).rejects.toMatchObject({ code: 'bad_request' })
    })

    it('loads album, artist and playlist details', async () => {
      const album = await api.album(cat.albums[0]!.id)
      expect(album.id).toBe(cat.albums[0]!.id)
      expect(album.tracks.length).toBeGreaterThan(0)
      expect(album.tracks[0]).toMatchObject({ album: { id: album.id } })

      const artist = await api.artist(cat.artists[0]!.id)
      expect(artist.topTracks.length).toBeGreaterThan(0)
      expect(artist.albums.length).toBeGreaterThan(0)

      const playlist = await api.playlist(cat.playlists[0]!.id)
      expect(playlist.tracks.length).toBeGreaterThan(0)
      expect(playlist.name).toBe(cat.playlists[0]!.name)
    })

    it('maps unknown ids to not_found', async () => {
      await expect(api.album('al-does-not-exist')).rejects.toMatchObject({ code: 'not_found', status: 404 })
      await expect(api.artist('nope')).rejects.toMatchObject({ code: 'not_found' })
      await expect(api.playlist('nope')).rejects.toMatchObject({ code: 'not_found' })
      await expect(api.stream('nope')).rejects.toMatchObject({ code: 'not_found' })
    })

    it('url-encodes ids safely', async () => {
      await expect(api.album('a/b?c#d')).rejects.toMatchObject({ code: 'not_found' })
    })

    it('artwork URLs are fetchable SVGs', async () => {
      const album = await api.album(cat.albums[0]!.id)
      const res = await fetch(album.artwork[0]!.url)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toMatch(/image\/svg\+xml/)
    })
  })

  describe('likes', () => {
    it('likes and unlikes a track, reflecting in the library and track flags', async () => {
      const liked = new Set(cat.defaults.likedTrackIds)
      const target = cat.tracks.find((t) => !liked.has(t.id))!
      await expect(api.setLiked(target.id, true)).resolves.toBeUndefined()
      const lib = await api.libraryTracks(0, 200)
      expect(lib.items.map((t) => t.id)).toContain(target.id)
      expect(lib.items.find((t) => t.id === target.id)!.liked).toBe(true)

      await api.setLiked(target.id, true) // idempotent
      expect((await api.libraryTracks(0, 200)).items.filter((t) => t.id === target.id)).toHaveLength(1)

      await expect(api.setLiked(target.id, false)).resolves.toBeUndefined()
      expect((await api.libraryTracks(0, 200)).items.map((t) => t.id)).not.toContain(target.id)
      await api.setLiked(target.id, false) // idempotent
    })

    it('404s for unknown tracks', async () => {
      await expect(api.setLiked('nope', true)).rejects.toMatchObject({ code: 'not_found' })
    })
  })

  describe('streaming', () => {
    it('returns a signed, expiring URL that serves audio with Range support', async () => {
      const id = cat.tracks[0]!.id
      const info = await api.stream(id)
      expect(info.url).toContain(`/media/${encodeURIComponent(id)}`)
      expect(Date.parse(info.expiresAt)).toBeGreaterThan(Date.now())
      expect(info.mimeType).toBe('audio/wav')

      const full = await fetch(info.url)
      expect(full.status).toBe(200)
      expect(full.headers.get('accept-ranges')).toBe('bytes')
      const body = Buffer.from(await full.arrayBuffer())
      expect(body.subarray(0, 4).toString()).toBe('RIFF')

      const part = await fetch(info.url, { headers: { Range: 'bytes=0-99' } })
      expect(part.status).toBe(206)
      expect(part.headers.get('content-range')).toBe(`bytes 0-99/${body.length}`)
      expect(part.headers.get('content-length')).toBe('100')
      const partBody = Buffer.from(await part.arrayBuffer())
      expect(partBody.equals(body.subarray(0, 100))).toBe(true)

      const open = await fetch(info.url, { headers: { Range: 'bytes=1000-' } })
      expect(open.status).toBe(206)
      expect(Buffer.from(await open.arrayBuffer()).length).toBe(body.length - 1000)

      const suffix = await fetch(info.url, { headers: { Range: 'bytes=-50' } })
      expect(suffix.status).toBe(206)
      expect(Buffer.from(await suffix.arrayBuffer()).equals(body.subarray(body.length - 50))).toBe(true)
    })

    it('answers an unsatisfiable range with 416', async () => {
      const info = await api.stream(cat.tracks[0]!.id)
      const res = await fetch(info.url, { headers: { Range: 'bytes=999999999-' } })
      expect(res.status).toBe(416)
      expect(res.headers.get('content-range')).toMatch(/^bytes \*\/\d+$/)
    })

    it('does not need an Authorization header (pre-signed)', async () => {
      const info = await api.stream(cat.tracks[1]!.id)
      const res = await fetch(info.url, { headers: { Range: 'bytes=0-9' } })
      expect(res.status).toBe(206)
    })

    it('rejects a forged signature with 403', async () => {
      const info = await api.stream(cat.tracks[0]!.id)
      const u = new URL(info.url)
      const sig = u.searchParams.get('sig')!
      u.searchParams.set('sig', (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1))
      expect((await fetch(u)).status).toBe(403)
      u.searchParams.set('sig', 'zz')
      expect((await fetch(u)).status).toBe(403)
      u.searchParams.delete('sig')
      expect((await fetch(u)).status).toBe(403)
    })

    it('rejects a tampered expiry and a signature for another track', async () => {
      const a = new URL((await api.stream(cat.tracks[0]!.id)).url)
      const tampered = new URL(a)
      tampered.searchParams.set('exp', String(Number(a.searchParams.get('exp')) + 1000))
      expect((await fetch(tampered)).status).toBe(403)

      const b = new URL((await api.stream(cat.tracks[1]!.id)).url)
      const swapped = new URL(a)
      swapped.pathname = b.pathname
      expect((await fetch(swapped)).status).toBe(403)
    })
  })

  describe('lyrics and play reports', () => {
    it('returns lyrics that the app can parse (when the track has synced lyrics)', async () => {
      let synced = 0
      for (const t of cat.tracks.slice(0, 25)) {
        const l = await api.lyrics(t.id)
        expect(l).toHaveProperty('synced')
        expect(l).toHaveProperty('plain')
        if (l.synced) {
          const parsed = parseLrc(l.synced)
          expect(parsed.synced).toBe(true)
          expect(parsed.lines.length).toBeGreaterThan(0)
          const times = parsed.lines.map((x) => x.time)
          expect(times).toEqual([...times].sort((x, y) => x - y))
          synced++
        }
      }
      expect(synced).toBeGreaterThan(0)
    })

    it('records plays and surfaces them on the home screen', async () => {
      const id = cat.tracks[40]!.id
      await expect(api.reportPlayed(id, 61.4)).resolves.toBeUndefined()
      const home = await api.home()
      const recent = home.sections.find((s) => s.id === 'recent')!
      expect(recent.items[0]).toMatchObject({ id })
    })

    it('validates play reports', async () => {
      await expect(api.reportPlayed(cat.tracks[0]!.id, -5)).rejects.toMatchObject({ code: 'bad_request' })
      await expect(api.reportPlayed('nope', 10)).rejects.toMatchObject({ code: 'not_found' })
    })
  })

  describe('token refresh', () => {
    it('refreshes preemptively when the client believes the token expired, rotating both tokens', async () => {
      const holder = { current: await ServerApi.login(rig.url, 'demo', 'demo', fetch) }
      const before = holder.current
      const future = Date.now() + 2 * 3600_000
      const client = rig.client(holder, () => future)
      const refreshesBefore = refreshCalls(rig)
      await expect(client.me()).resolves.toMatchObject({ username: 'demo' })
      expect(refreshCalls(rig)).toBe(refreshesBefore + 1)
      expect(holder.current!.accessToken).not.toBe(before!.accessToken)
      expect(holder.current!.refreshToken).not.toBe(before!.refreshToken)
      expect(holder.current!.expiresAt).toBeGreaterThan(future)
    })

    it('shares ONE refresh between concurrent requests (otherwise token reuse detection would kill the session)', async () => {
      const holder = { current: await ServerApi.login(rig.url, 'demo', 'demo', fetch) }
      const future = Date.now() + 2 * 3600_000
      const client = rig.client(holder, () => future)
      const before = refreshCalls(rig)
      const results = await Promise.all([client.me(), client.home(), client.libraryTracks(0, 5), client.libraryAlbums(), client.search('a')])
      expect(results).toHaveLength(5)
      expect(refreshCalls(rig)).toBe(before + 1)
      // and the session is still alive afterwards
      expect(holder.current).not.toBeNull()
      await expect(client.me()).resolves.toBeDefined()
    })

    it('recovers from a 401 caused by a server-side expired access token', async () => {
      const local = await start({ accessTtl: 120 }) // longer than the client's 30s refresh skew
      try {
        const holder = { current: await ServerApi.login(local.url, 'demo', 'demo', fetch) }
        const client = local.client(holder) // client clock stays real: it thinks the token is still valid
        await expect(client.me()).resolves.toBeDefined()
        local.clock.t += 200_000 // server clock jumps past the access TTL
        const old = holder.current!.accessToken
        await expect(client.me()).resolves.toMatchObject({ username: 'demo' })
        expect(holder.current!.accessToken).not.toBe(old)
        expect(refreshCalls(local)).toBe(1)
        expect(local.log.filter((l) => l.startsWith('GET /v1/me')).map((l) => l.split(' ')[2])).toEqual(['200', '401', '200'])
      } finally {
        await local.mock.close()
      }
    })

    it('signs out when the refresh token itself expired', async () => {
      const local = await start({ accessTtl: 120, refreshTtl: 300 })
      try {
        const holder = { current: await ServerApi.login(local.url, 'demo', 'demo', fetch) }
        const client = local.client(holder)
        local.clock.t += 600_000
        await expect(client.me()).rejects.toMatchObject({ code: 'unauthorized' })
        expect(holder.current).toBeNull()
      } finally {
        await local.mock.close()
      }
    })

    it('detects refresh token reuse and revokes the whole session', async () => {
      const holder = { current: await ServerApi.login(rig.url, 'demo', 'demo', fetch) }
      const stolen = holder.current!.refreshToken
      const client = rig.client(holder)
      await client.refresh() // legitimate rotation
      const rotated = holder.current!.refreshToken
      expect(rotated).not.toBe(stolen)

      const replay = await fetch(`${rig.url}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: stolen })
      })
      expect(replay.status).toBe(401)

      // The legitimate client's family is now revoked as well.
      await expect(client.refresh()).rejects.toMatchObject({ code: 'unauthorized' })
      expect(holder.current).toBeNull()
    })

    it('a malformed refresh request is a 400, which the client treats as a dead session', async () => {
      const res = await fetch(`${rig.url}/v1/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      expect(res.status).toBe(400)
    })
  })

  describe('logout', () => {
    it('revokes the session server-side and clears it locally', async () => {
      const holder = { current: await ServerApi.login(rig.url, 'demo', 'demo', fetch) }
      const client = rig.client(holder)
      const { accessToken, refreshToken } = holder.current!
      await client.me()
      await client.logout()
      expect(holder.current).toBeNull()

      expect((await fetch(`${rig.url}/v1/me`, { headers: { Authorization: `Bearer ${accessToken}` } })).status).toBe(401)
      const refresh = await fetch(`${rig.url}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken })
      })
      expect(refresh.status).toBe(401)
    })

    it('does not affect other sessions of the same user', async () => {
      const a = { current: await ServerApi.login(rig.url, 'demo', 'demo', fetch) }
      const b = { current: await ServerApi.login(rig.url, 'demo', 'demo', fetch) }
      await rig.client(a).logout()
      await expect(rig.client(b).me()).resolves.toMatchObject({ username: 'demo' })
    })

    it('logging out twice is harmless', async () => {
      const holder = { current: await ServerApi.login(rig.url, 'demo', 'demo', fetch) }
      const client = rig.client(holder)
      await client.logout()
      await expect(client.logout()).resolves.toBeUndefined()
    })
  })

  describe('error handling over real HTTP', () => {
    it('maps 404 for unknown routes and 405 for wrong methods to bad statuses', async () => {
      expect((await fetch(`${rig.url}/v1/nope`)).status).toBe(404)
      expect((await fetch(`${rig.url}/v1/info`, { method: 'DELETE' })).status).toBe(405)
    })

    it('reports an unreachable server as a network error', async () => {
      const dead = await start()
      const url = dead.url
      await dead.mock.close()
      await expect(ServerApi.info(url, fetch)).rejects.toMatchObject({ code: 'network' })
    })
  })
})

describe.skipIf(!available)('login rate limiting', () => {
  it('returns rate_limited with Retry-After once the limit is hit', async () => {
    const local = await start({ loginLimit: { max: 2, windowMs: 60_000 } })
    try {
      await ServerApi.login(local.url, 'demo', 'bad', fetch).catch(() => undefined)
      await ServerApi.login(local.url, 'demo', 'bad', fetch).catch(() => undefined)
      const err = (await ServerApi.login(local.url, 'demo', 'demo', fetch).catch((e: unknown) => e)) as ApiError
      expect(err.code).toBe('rate_limited')
      expect(err.retryAfter).toBeGreaterThan(0)
      local.clock.t += 61_000
      await expect(ServerApi.login(local.url, 'demo', 'demo', fetch)).resolves.toBeDefined()
    } finally {
      await local.mock.close()
    }
  })
})

describe.skipIf(!available)('custom users', () => {
  it('supports configured users', async () => {
    const local = await start({ users: [{ username: 'alice', password: 'p:w' }] })
    try {
      const s = await ServerApi.login(local.url, 'alice', 'p:w', fetch)
      expect(s.user).toMatchObject({ username: 'alice', displayName: 'Alice' })
      await expect(ServerApi.login(local.url, 'demo', 'demo', fetch)).rejects.toMatchObject({ message: 'Wrong username or password.' })
    } finally {
      await local.mock.close()
    }
  })
})
