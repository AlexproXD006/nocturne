// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/* eslint-disable @typescript-eslint/no-explicit-any */
// Renderer modules are loaded dynamically by absolute path so this Node-typed test does not drag
// the DOM-typed renderer sources into tsconfig.node.json (same pattern as mock-server.test.ts).
const SERVER_FILE = resolve(__dirname, '../../mock-server/server.mjs')
const RENDERER = resolve(__dirname, '../../src/renderer/src')
const available = existsSync(SERVER_FILE)

interface StoredSession {
  serverUrl: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  user: { id: string; username: string; displayName: string; role?: string }
}
interface ClientOptions {
  getSession: () => StoredSession | null
  setSession: (s: StoredSession | null) => void
  fetch: typeof fetch
  timeoutMs?: number
}
type ApiClient = Record<string, (...args: any[]) => Promise<any>>
const { ApiClient, ServerApi } = (await import(/* @vite-ignore */ `${RENDERER}/api/client.ts`)) as {
  ApiClient: new (o: ClientOptions) => ApiClient
  ServerApi: { login(url: string, user: string, pass: string, f?: typeof fetch): Promise<StoredSession> }
}

interface MockHandle {
  catalog: any
  jobs: { timer: unknown; list(n?: number): any[] }
  url: string | null
  listen(port?: number, host?: string): Promise<{ url: string; port: number }>
  close(): Promise<void>
  advanceJobs(n?: number): void
}
type CreateMockServer = (options?: Record<string, unknown>) => MockHandle

async function load(): Promise<CreateMockServer> {
  const mod = (await import(/* @vite-ignore */ pathToFileURL(SERVER_FILE).href)) as { createMockServer: CreateMockServer }
  return mod.createMockServer
}

interface Rig {
  mock: MockHandle
  url: string
  clock: { t: number }
  login(user: string, pass: string): Promise<{ session: { current: StoredSession | null }; api: ApiClient }>
  /** Raw JSON request with a bearer token. */
  raw(token: string | null, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>
}

async function start(options: Record<string, unknown> = {}): Promise<Rig> {
  const createMockServer = await load()
  const clock = { t: Date.now() }
  const mock = createMockServer({ quiet: true, loginLimit: { max: 0, windowMs: 60_000 }, now: () => clock.t, jobTickMs: 0, ...options })
  const { url } = await mock.listen(0)
  return {
    mock,
    url,
    clock,
    async login(user, pass) {
      const session: { current: StoredSession | null } = { current: await ServerApi.login(url, user, pass, fetch) }
      const api = new ApiClient({
        getSession: () => session.current,
        setSession: (s) => {
          session.current = s
        },
        fetch: (...a: Parameters<typeof fetch>) => fetch(...a),
        timeoutMs: 10_000
      })
      return { session, api }
    },
    raw(token, method, path, body, headers = {}) {
      return fetch(`${url}${path}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      })
    }
  }
}

/** Runs ticks until the job reaches a final state (manual-tick servers only). */
function finish(rig: Rig, id: string, max = 60): any {
  const job = rig.mock.jobs.list(500).find((j) => j.id === id)
  for (let i = 0; i < max && job && !['done', 'failed', 'cancelled'].includes(job.status); i++) rig.mock.advanceJobs(1)
  return { ...job }
}

// ---- Audio fixtures ----------------------------------------------------------------
const mp3 = (n = 4000) => Buffer.concat([Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00', 'latin1'), Buffer.alloc(n, 7)])
const mp3Sync = () => Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(2000, 3)])
const flac = () => Buffer.concat([Buffer.from('fLaC', 'latin1'), Buffer.alloc(500, 1)])
const ogg = () => Buffer.concat([Buffer.from('OggS', 'latin1'), Buffer.alloc(500, 1)])
const m4a = () => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypM4A ', 'latin1'), Buffer.alloc(300, 1)])
function wav(seconds = 1, rate = 8000): Buffer {
  const data = Buffer.alloc(seconds * rate, 128)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'latin1')
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVEfmt ', 8, 'latin1')
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate, 28)
  h.writeUInt16LE(1, 32)
  h.writeUInt16LE(8, 34)
  h.write('data', 36, 'latin1')
  h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

async function upload(rig: Rig, token: string | null, data: Buffer, filename: string, field = 'file'): Promise<Response> {
  const form = new FormData()
  form.append(field, new Blob([data]), filename)
  return fetch(`${rig.url}/v1/admin/uploads`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: form })
}

const j = (r: Response): Promise<any> => r.json()

const GOOD_TTML = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" itunes:timing="Word"><body><div><p begin="1.000" end="3.000"><span begin="1.000" end="2.000">Hello</span> <span begin="2.000" end="3.000">world</span></p></div></body></tt>`
const GOOD_LRC = '[00:01.00]Hello\n[00:03.50]World\n[00:06.00]'

describe.skipIf(!available)('admin API (real ApiClient over HTTP)', () => {
  let rig: Rig
  let admin: Awaited<ReturnType<Rig['login']>>
  let guest: Awaited<ReturnType<Rig['login']>>

  beforeAll(async () => {
    rig = await start()
    admin = await rig.login('demo', 'demo')
    guest = await rig.login('guest', 'guestguest')
  })
  afterAll(async () => {
    await rig.mock.close()
  })

  describe('roles', () => {
    it('advertises admin capabilities', async () => {
      const info = await j(await fetch(`${rig.url}/v1/info`))
      expect(info.capabilities).toMatchObject({ lyrics: true, likes: true, scrobble: true, admin: true, sources: ['spotify', 'youtube'], uploadMaxBytes: 200 * 1024 * 1024 })
    })

    it('returns the role from login, refresh and /v1/me', async () => {
      expect(admin.session.current!.user.role).toBe('admin')
      expect(guest.session.current!.user.role).toBe('user')
      expect((await admin.api.me!()).role).toBe('admin')
      expect((await guest.api.me!()).role).toBe('user')
      const refreshed = await guest.api.refresh!()
      expect(refreshed.user.role).toBe('user')
    })

    it('rejects anonymous callers with 401 and non-admins with 403 on every admin route', async () => {
      const routes: Array<[string, string, unknown?]> = [
        ['GET', '/v1/admin/stats'],
        ['GET', '/v1/admin/sources/search?source=spotify&q=x'],
        ['POST', '/v1/admin/downloads', { source: 'spotify', id: 'spotify:track:0:x' }],
        ['POST', '/v1/admin/imports', { url: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M' }],
        ['GET', '/v1/admin/jobs'],
        ['GET', '/v1/admin/jobs/job-0001'],
        ['DELETE', '/v1/admin/jobs/job-0001'],
        ['POST', '/v1/admin/library/rescan'],
        ['GET', '/v1/admin/tracks'],
        ['DELETE', '/v1/admin/tracks/tr-x'],
        ['PUT', '/v1/admin/tracks/tr-x/lyrics', { format: 'lrc', content: GOOD_LRC }],
        ['DELETE', '/v1/admin/tracks/tr-x/lyrics'],
        ['POST', '/v1/admin/uploads'],
        ['GET', '/v1/admin/users'],
        ['POST', '/v1/admin/users', { username: 'abc', password: '0123456789', role: 'user' }],
        ['PATCH', '/v1/admin/users/u-demo', { displayName: 'x' }],
        ['DELETE', '/v1/admin/users/u-demo'],
        ['GET', '/v1/admin/backups'],
        ['POST', '/v1/admin/backups'],
        ['POST', '/v1/admin/backups/bk-0001/restore', { confirm: true }]
      ]
      for (const [method, path, body] of routes) {
        const anon = await rig.raw(null, method, path, body)
        expect(anon.status, `${method} ${path} anonymous`).toBe(401)
        const res = await rig.raw(guest.session.current!.accessToken, method, path, body)
        expect(res.status, `${method} ${path} as user`).toBe(403)
        expect(await j(res)).toHaveProperty('message')
      }
      await expect(guest.api.adminStats!()).rejects.toMatchObject({ code: 'forbidden', status: 403 })
    })

    it('answers unknown admin paths with 404 and wrong methods with 405', async () => {
      const t = admin.session.current!.accessToken
      expect((await rig.raw(t, 'GET', '/v1/admin/nope')).status).toBe(404)
      const res = await rig.raw(t, 'PUT', '/v1/admin/stats', {})
      expect(res.status).toBe(405)
      expect(res.headers.get('allow')).toContain('GET')
    })
  })

  describe('stats and tracks', () => {
    it('computes stats from the catalog', async () => {
      const s = await admin.api.adminStats!()
      expect(s).toMatchObject({ tracks: 110, albums: 14, artists: 8, playlists: 6, users: 2, activeJobs: 0 })
      expect(s.storageBytes).toBeGreaterThan(100_000_000)
      expect(s.freeBytes).toBeGreaterThan(0)
      expect(s.plays).toBeGreaterThan(0)
    })

    it('pages tracks with AdminTrack fields and filters by q', async () => {
      const page = await admin.api.adminTracks!({ limit: 5 })
      expect(page).toMatchObject({ offset: 0, limit: 5, total: 110 })
      expect(page.items).toHaveLength(5)
      const t = page.items[0]
      expect(t).toMatchObject({ format: 'wav' })
      expect(typeof t.addedAt).toBe('string')
      expect(Number.isNaN(Date.parse(t.addedAt))).toBe(false)
      expect(t.playCount).toBeGreaterThanOrEqual(0)
      expect(t.sizeBytes).toBeGreaterThan(1000)
      expect(t.artists.length).toBeGreaterThan(0)
      expect(t).toHaveProperty('lyrics')
      const dates = page.items.map((x: any) => x.addedAt)
      expect(dates).toEqual([...dates].sort().reverse())

      const next = await admin.api.adminTracks!({ offset: 5, limit: 5 })
      expect(next.items[0].id).not.toBe(page.items[0].id)

      const q = await admin.api.adminTracks!({ q: 'GLASS meridian' })
      expect(q.total).toBeGreaterThanOrEqual(10)
      for (const x of q.items) expect(JSON.stringify(x).toLowerCase()).toContain('glass')
      expect((await admin.api.adminTracks!({ q: 'zzzzqqqq' })).total).toBe(0)
    })

    it('validates paging parameters', async () => {
      const t = admin.session.current!.accessToken
      expect((await rig.raw(t, 'GET', '/v1/admin/tracks?limit=0')).status).toBe(400)
      expect((await rig.raw(t, 'GET', '/v1/admin/tracks?offset=-1')).status).toBe(400)
      expect((await rig.raw(t, 'GET', '/v1/admin/tracks?lyrics=maybe')).status).toBe(400)
    })
  })

  describe('source search', () => {
    it('returns 8-15 deterministic results per source with mixed kinds', async () => {
      for (const source of ['spotify', 'youtube'] as const) {
        const a = await admin.api.adminSearchSource!(source, 'night drive')
        const b = await admin.api.adminSearchSource!(source, 'night drive')
        expect(a).toEqual(b)
        expect(a.results.length).toBeGreaterThanOrEqual(8)
        expect(a.results.length).toBeLessThanOrEqual(15)
        expect(new Set(a.results.map((r: any) => r.kind))).toEqual(new Set(['track', 'album', 'playlist']))
        for (const r of a.results) {
          expect(r).toMatchObject({ source, id: expect.any(String), title: expect.any(String), artist: expect.any(String) })
          expect(typeof r.inLibrary).toBe('boolean')
          expect(r.url).toMatch(/^https:\/\/(open\.spotify\.com|www\.youtube\.com)\//)
          expect(r.artworkUrl.startsWith(rig.url)).toBe(true)
          if (r.kind === 'track') expect(r.duration).toBeGreaterThan(0)
        }
        expect(new Set(a.results.map((r: any) => r.id)).size).toBe(a.results.length)
      }
      const other = await admin.api.adminSearchSource!('spotify', 'something else')
      expect(other.results.map((r: any) => r.id)).not.toEqual((await admin.api.adminSearchSource!('spotify', 'night drive')).results.map((r: any) => r.id))
    })

    it('marks results that match the catalog as inLibrary', async () => {
      const { results } = await admin.api.adminSearchSource!('spotify', 'glass meridian')
      const album = results.find((r: any) => r.kind === 'album')
      expect(album).toMatchObject({ title: 'Glass Meridian', inLibrary: true })
      expect(results.some((r: any) => r.kind === 'track' && r.inLibrary)).toBe(true)
      expect(results.some((r: any) => !r.inLibrary)).toBe(true)
    })

    it('serves artwork for results from the mock itself', async () => {
      const { results } = await admin.api.adminSearchSource!('youtube', 'rain')
      const res = await fetch(results[0].artworkUrl)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('image/svg+xml')
    })

    it('validates the source and query', async () => {
      const t = admin.session.current!.accessToken
      expect((await rig.raw(t, 'GET', '/v1/admin/sources/search?source=tidal&q=x')).status).toBe(400)
      expect((await rig.raw(t, 'GET', '/v1/admin/sources/search?q=x')).status).toBe(400)
      expect((await rig.raw(t, 'GET', `/v1/admin/sources/search?source=spotify&q=${'a'.repeat(201)}`)).status).toBe(400)
      expect(await admin.api.adminSearchSource!('spotify', '   ')).toEqual({ results: [] })
    })
  })

  describe('downloads, imports and jobs', () => {
    it('downloads a track result: queued -> running -> done, adding a playable track', async () => {
      const before = await admin.api.adminStats!()
      const { results } = await admin.api.adminSearchSource!('spotify', 'moonlit parade')
      const hit = results.find((r: any) => r.kind === 'track' && !r.inLibrary)
      const job = await admin.api.adminStartDownload!({ source: 'spotify', id: hit.id })
      expect(job).toMatchObject({ kind: 'download', source: 'spotify', status: 'queued', trackIds: [] })
      expect(job.id).toMatch(/^job-/)
      expect(Number.isNaN(Date.parse(job.createdAt))).toBe(false)

      rig.mock.advanceJobs(1)
      expect(await admin.api.adminJob!(job.id)).toMatchObject({ status: 'running' })
      const seen = new Set<string>()
      let last = await admin.api.adminJob!(job.id)
      for (let i = 0; i < 20 && last.status === 'running'; i++) {
        rig.mock.advanceJobs(1)
        last = await admin.api.adminJob!(job.id)
        if (last.message) seen.add(last.message)
      }
      expect(last.status).toBe('done')
      expect(last.progress).toBe(1)
      expect(last.finishedAt).toBeDefined()
      expect(last.trackIds).toHaveLength(1)
      expect([...seen].some((m) => /Downloading 1\/1/.test(m))).toBe(true)

      const after = await admin.api.adminStats!()
      expect(after.tracks).toBe(before.tracks + 1)
      const id = last.trackIds[0]
      const found = await admin.api.adminTracks!({ q: hit.title })
      const track = found.items.find((t: any) => t.id === id)
      expect(track).toMatchObject({ title: hit.title, format: 'wav' })
      expect(track.artists[0].name).toBe(hit.artist)

      // audio + lyrics endpoints behave like for the seeded tracks
      const stream = await admin.api.stream!(id)
      const media = await fetch(stream.url, { headers: { Range: 'bytes=0-11' } })
      expect(media.status).toBe(206)
      expect(Buffer.from(await media.arrayBuffer()).subarray(0, 4).toString('latin1')).toBe('RIFF')
      const lyr = await admin.api.lyrics!(id)
      expect(lyr).toHaveProperty('ttml', null)
      // and the artist/album exist in the normal API
      const album = await admin.api.album!(track.album.id)
      expect(album.tracks.map((t: any) => t.id)).toContain(id)
      expect((await admin.api.artist!(track.artists[0].id)).name).toBe(hit.artist)
      expect((await admin.api.search!(hit.title)).tracks.map((t: any) => t.id)).toContain(id)
      // now it is in the library
      const again = await admin.api.adminSearchSource!('spotify', 'moonlit parade')
      expect(again.results.find((r: any) => r.id === hit.id).inLibrary).toBe(true)
    })

    it('downloads an album result as a new album with several tracks', async () => {
      const { results } = await admin.api.adminSearchSource!('youtube', 'ember coast')
      const hit = results.find((r: any) => r.kind === 'album' && !r.inLibrary)
      const before = await admin.api.adminStats!()
      const job = await admin.api.adminStartDownload!({ source: 'youtube', id: hit.id })
      const done = finish(rig, job.id)
      expect(done.status).toBe('done')
      expect(done.trackIds.length).toBeGreaterThanOrEqual(4)
      const after = await admin.api.adminStats!()
      expect(after.tracks).toBe(before.tracks + done.trackIds.length)
      expect(after.albums).toBe(before.albums + 1)
      const { items } = await admin.api.adminTracks!({ q: hit.title })
      const albumId = items.find((t: any) => done.trackIds.includes(t.id)).album.id
      expect((await admin.api.album!(albumId)).tracks).toHaveLength(done.trackIds.length)
    })

    it('downloads by pasted link and rejects bad input', async () => {
      const url = 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'
      const job = await admin.api.adminStartDownload!({ source: 'spotify', url })
      expect(job).toMatchObject({ source: 'url', kind: 'download' })
      expect(finish(rig, job.id).status).toBe('done')
      const t = admin.session.current!.accessToken
      const post = (body: unknown) => rig.raw(t, 'POST', '/v1/admin/downloads', body)
      expect((await post({ source: 'spotify', id: 'spotify:track:0:x', url })).status).toBe(400)
      expect((await post({ source: 'spotify' })).status).toBe(400)
      expect((await post({ source: 'tidal', id: 'spotify:track:0:x' })).status).toBe(400)
      expect((await post({ source: 'spotify', id: 'garbage' })).status).toBe(400)
      expect((await post({ source: 'youtube', id: 'spotify:track:0:x' })).status).toBe(400)
      expect((await post({ source: 'spotify', url: 'https://evil.example/track/abc' })).status).toBe(400)
      expect((await post({ source: 'youtube', url })).status).toBe(400)
      expect((await post({ source: 'spotify', url: 'not a url' })).status).toBe(400)
    })

    it('completes immediately with "Already in your library" for existing content and skips duplicates', async () => {
      const { results } = await admin.api.adminSearchSource!('spotify', 'glass meridian')
      const album = results.find((r: any) => r.kind === 'album' && r.inLibrary)
      const before = await admin.api.adminStats!()
      const job = await admin.api.adminStartDownload!({ source: 'spotify', id: album.id })
      const done = finish(rig, job.id)
      expect(done).toMatchObject({ status: 'done', message: 'Already in your library', trackIds: [] })
      expect((await admin.api.adminStats!()).tracks).toBe(before.tracks)
    })

    it('fails a download whose link contains "fail" and keeps the error', async () => {
      const job = await admin.api.adminStartDownload!({ source: 'spotify', url: 'https://open.spotify.com/track/failfailfailfail0001' })
      const done = finish(rig, job.id)
      expect(done.status).toBe('failed')
      expect(done.error).toMatch(/simulated/)
      expect(done.finishedAt).toBeDefined()
    })

    it('imports a playlist link as tracks plus a playlist', async () => {
      const before = await admin.api.libraryPlaylists!(0, 50)
      const job = await admin.api.adminImportPlaylist!('https://www.youtube.com/playlist?list=PLabcdefghijklmnopqrstu')
      expect(job).toMatchObject({ kind: 'import', source: 'youtube', status: 'queued' })
      const done = finish(rig, job.id)
      expect(done.status).toBe('done')
      expect(done.trackIds.length).toBeGreaterThanOrEqual(6)
      const after = await admin.api.libraryPlaylists!(0, 50)
      expect(after.total).toBe(before.total + 1)
      const created = after.items.find((p: any) => !before.items.some((b: any) => b.id === p.id))
      const detail = await admin.api.playlist!(created.id)
      expect(detail.tracks.map((t: any) => t.id)).toEqual(expect.arrayContaining(done.trackIds))
      const t = admin.session.current!.accessToken
      expect((await rig.raw(t, 'POST', '/v1/admin/imports', { url: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC' })).status).toBe(400)
      expect((await rig.raw(t, 'POST', '/v1/admin/imports', {})).status).toBe(400)
    })

    it('cancels queued/running jobs and answers 409 for finished ones', async () => {
      const job = await admin.api.adminImportPlaylist!('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M')
      rig.mock.advanceJobs(3)
      await admin.api.adminCancelJob!(job.id)
      const cancelled = await admin.api.adminJob!(job.id)
      expect(cancelled).toMatchObject({ status: 'cancelled', message: 'Cancelled' })
      expect(cancelled.finishedAt).toBeDefined()
      rig.mock.advanceJobs(30)
      expect((await admin.api.adminJob!(job.id)).status).toBe('cancelled')
      await expect(admin.api.adminCancelJob!(job.id)).rejects.toMatchObject({ status: 409 })
      const resc = await admin.api.adminRescan!()
      finish(rig, resc.id)
      await expect(admin.api.adminCancelJob!(resc.id)).rejects.toMatchObject({ status: 409 })
      await expect(admin.api.adminCancelJob!('job-9999')).rejects.toMatchObject({ status: 404 })
      await expect(admin.api.adminJob!('job-9999')).rejects.toMatchObject({ status: 404 })
    })

    it('rescan reports progress and counts active jobs in stats', async () => {
      const job = await admin.api.adminRescan!()
      expect(job).toMatchObject({ kind: 'rescan', status: 'queued' })
      expect((await admin.api.adminStats!()).activeJobs).toBeGreaterThanOrEqual(1)
      rig.mock.advanceJobs(2)
      const mid = await admin.api.adminJob!(job.id)
      expect(mid.status).toBe('running')
      expect(mid.progress).toBeGreaterThan(0)
      expect(mid.progress).toBeLessThan(1)
      expect(finish(rig, job.id)).toMatchObject({ status: 'done', progress: 1 })
    })

    it('lists jobs newest first and caps the list at 100', async () => {
      for (let i = 0; i < 105; i++) await admin.api.adminRescan!()
      const { jobs } = await admin.api.adminJobs!()
      expect(jobs).toHaveLength(100)
      const nums = jobs.map((j: any) => Number(j.id.slice(4)))
      expect(nums).toEqual([...nums].sort((a, b) => b - a))
      rig.mock.advanceJobs(10)
    })
  })

  describe('library edits', () => {
    it('deletes a track everywhere: albums, playlists, likes, search and media', async () => {
      const cat = rig.mock.catalog
      const pl = cat.playlists[0]
      const likedId = (await admin.api.libraryTracks!(0, 50)).items[0].id
      const id = pl.trackIds.find((x: string) => x === likedId) ?? pl.trackIds[0]
      await admin.api.setLiked!(id, true)
      const albumId = (await admin.api.adminTracks!({ q: cat.trackById.get(id).title })).items.find((t: any) => t.id === id).album.id
      const stream = await admin.api.stream!(id)
      await admin.api.adminDeleteTrack!(id)

      expect((await admin.api.album!(albumId)).tracks.map((t: any) => t.id)).not.toContain(id)
      expect((await admin.api.playlist!(pl.id)).tracks.map((t: any) => t.id)).not.toContain(id)
      expect((await admin.api.libraryTracks!(0, 200)).items.map((t: any) => t.id)).not.toContain(id)
      expect((await admin.api.home!()).sections.length).toBeGreaterThan(0)
      expect((await admin.api.adminTracks!({ limit: 200 })).items.map((t: any) => t.id)).not.toContain(id)
      await expect(admin.api.lyrics!(id)).rejects.toMatchObject({ status: 404 })
      expect((await fetch(stream.url)).status).toBe(404)
      await expect(admin.api.adminDeleteTrack!(id)).rejects.toMatchObject({ status: 404 })
    })

    it('removes albums and artists that become empty', async () => {
      const { items } = await admin.api.adminTracks!({ q: 'fieldnotes from nowhere', limit: 50 })
      const mine = items.filter((t: any) => t.album.title === 'Fieldnotes from Nowhere')
      expect(mine.length).toBe(4)
      const artistId = mine[0].artists[0].id
      const before = await admin.api.adminStats!()
      for (const t of mine) await admin.api.adminDeleteTrack!(t.id)
      await expect(admin.api.album!(mine[0].album.id)).rejects.toMatchObject({ status: 404 })
      const after = await admin.api.adminStats!()
      expect(after.albums).toBe(before.albums - 1)
      expect(after.tracks).toBe(before.tracks - 4)
      // her other albums are gone too only when empty: artist has no other tracks here
      const artistStillThere = await admin.api.artist!(artistId).then(() => true, () => false)
      expect(artistStillThere).toBe(after.artists === before.artists)
    })
  })

  describe('uploads', () => {
    it('stores an mp3, names it from the filename and streams it with Range', async () => {
      const data = mp3()
      const res = await upload(rig, admin.session.current!.accessToken, data, 'Nova Static - Paper Moons.mp3')
      expect(res.status).toBe(201)
      const track = await j(res)
      expect(track).toMatchObject({ title: 'Paper Moons', format: 'mp3', sizeBytes: data.length, playCount: 0, lyrics: null })
      expect(track.artists[0].name).toBe('Nova Static')
      expect(track.duration).toBeGreaterThanOrEqual(1)
      expect(Number.isNaN(Date.parse(track.addedAt))).toBe(false)

      const stream = await admin.api.stream!(track.id)
      expect(stream.mimeType).toBe('audio/mpeg')
      const full = await fetch(stream.url)
      expect(full.headers.get('content-type')).toBe('audio/mpeg')
      expect(full.headers.get('accept-ranges')).toBe('bytes')
      expect(Buffer.from(await full.arrayBuffer()).equals(data)).toBe(true)
      const part = await fetch(stream.url, { headers: { Range: 'bytes=10-19' } })
      expect(part.status).toBe(206)
      expect(part.headers.get('content-range')).toBe(`bytes 10-19/${data.length}`)
      expect(Buffer.from(await part.arrayBuffer()).equals(data.subarray(10, 20))).toBe(true)
      expect((await fetch(stream.url, { headers: { Range: 'bytes=999999-' } })).status).toBe(416)

      const listed = await admin.api.adminTracks!({ q: 'paper moons' })
      expect(listed.items.some((t: any) => t.id === track.id)).toBe(true)
      expect((await admin.api.lyrics!(track.id))).toEqual({ synced: null, plain: null, ttml: null, offsetMs: 0 })
    })

    it('falls back to "Unknown Artist" and accepts every supported container', async () => {
      const t = admin.session.current!.accessToken
      const cases: Array<[Buffer, string, string, string]> = [
        [mp3Sync(), 'Plain Title.mp3', 'mp3', 'audio/mpeg'],
        [flac(), 'Some Song.flac', 'flac', 'audio/flac'],
        [ogg(), 'A - B.ogg', 'ogg', 'audio/ogg'],
        [ogg(), 'A - Opus Song.opus', 'opus', 'audio/ogg'],
        [m4a(), 'X - Y.m4a', 'm4a', 'audio/mp4'],
        [mp3Sync(), 'X - Raw.aac', 'aac', 'audio/aac'],
        [wav(2), 'Tone - Beep.wav', 'wav', 'audio/wav']
      ]
      for (const [data, name, format, mime] of cases) {
        const res = await upload(rig, t, data, name)
        expect(res.status, name).toBe(201)
        const track = await j(res)
        expect(track.format).toBe(format)
        const info = await admin.api.stream!(track.id)
        expect(info.mimeType).toBe(mime)
        if (name === 'Plain Title.mp3') expect(track).toMatchObject({ title: 'Plain Title' }), expect(track.artists[0].name).toBe('Unknown Artist')
        if (format === 'wav') expect(track.duration).toBe(2)
      }
    })

    it('rejects bad uploads: 415 type/magic, 400 empty or missing, 413 too large', async () => {
      const t = admin.session.current!.accessToken
      expect((await upload(rig, t, Buffer.from('hello world'), 'notes.txt')).status).toBe(415)
      expect((await upload(rig, t, Buffer.from('this is not an mp3 file at all'), 'Fake - Song.mp3')).status).toBe(415)
      expect((await upload(rig, t, flac(), 'Wrong - Ext.mp3')).status).toBe(415)
      expect((await upload(rig, t, mp3(), 'noextension')).status).toBe(415)
      expect((await upload(rig, t, Buffer.alloc(0), 'Empty - File.mp3')).status).toBe(400)
      expect((await upload(rig, t, mp3(), 'a.mp3', 'other')).status).toBe(400)
      const plain = await fetch(`${rig.url}/v1/admin/uploads`, { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: '{}' })
      expect(plain.status).toBe(400)
      expect((await upload(rig, null, mp3(), 'a - b.mp3')).status).toBe(401)
      expect((await upload(rig, guest.session.current!.accessToken, mp3(), 'a - b.mp3')).status).toBe(403)
    })
  })

  describe('lyrics library', () => {
    let plainTrack: string

    beforeAll(async () => {
      const all = (await admin.api.adminTracks!({ lyrics: 'missing', limit: 200 })).items
      plainTrack = all.find((t: any) => t.format === 'wav').id
    })

    it('ships ~10 seeded tracks with word-timed TTML (duet + background vocals)', async () => {
      const present = await admin.api.adminTracks!({ lyrics: 'present', limit: 200 })
      expect(present.total).toBeGreaterThanOrEqual(9)
      expect(present.total).toBeLessThanOrEqual(11)
      for (const t of present.items) expect(t.lyrics).toBe('ttml')
      const lyr = await admin.api.lyrics!(present.items[0].id)
      expect(typeof lyr.ttml).toBe('string')
      expect(lyr.ttml).toContain('itunes:timing="Word"')
      expect(lyr.ttml).toMatch(/<span begin="[\d:.]+" end="[\d:.]+">/)
      expect(lyr.ttml).toContain('ttm:role="x-bg"')
      expect(lyr.ttml).toContain('ttm:agent="v1"')
      expect(lyr.ttml).toContain('ttm:agent="v2"')
      expect(lyr.ttml).toContain('xml:id="v2"')
      expect(lyr.ttml).not.toMatch(/<!DOCTYPE|<!ENTITY/)
      // aligned with the generated audio: first line starts after the two-bar intro and stays inside the track
      const first = /<p begin="([\d:.]+)"/.exec(lyr.ttml)!
      expect(Number(first[1])).toBeGreaterThan(2)
      const missing = await admin.api.adminTracks!({ lyrics: 'missing', limit: 200 })
      expect(missing.total + present.total).toBe((await admin.api.adminStats!()).tracks)
    })

    it('returns ttml:null for tracks without a stored document', async () => {
      expect(await admin.api.lyrics!(plainTrack)).toHaveProperty('ttml', null)
    })

    it('stores TTML, exposes it, lists it as present and deletes it again', async () => {
      await admin.api.adminSetLyrics!(plainTrack, { format: 'ttml', content: GOOD_TTML })
      const lyr = await admin.api.lyrics!(plainTrack)
      expect(lyr.ttml).toBe(GOOD_TTML)
      const row = (await admin.api.adminTracks!({ lyrics: 'present', limit: 200 })).items.find((t: any) => t.id === plainTrack)
      expect(row.lyrics).toBe('ttml')
      await admin.api.adminSetLyrics!(plainTrack, { format: 'ttml', content: GOOD_TTML.replace('Hello', 'Hi') })
      expect((await admin.api.lyrics!(plainTrack)).ttml).toContain('Hi')
      await admin.api.adminDeleteLyrics!(plainTrack)
      expect((await admin.api.lyrics!(plainTrack)).ttml).toBeNull()
      expect((await admin.api.adminTracks!({ lyrics: 'missing', limit: 200 })).items.some((t: any) => t.id === plainTrack)).toBe(true)
      await admin.api.adminDeleteLyrics!(plainTrack) // idempotent
    })

    it('stores plain text (top priority), enforces 200 KB for LRC / plain and clears it again', async () => {
      await admin.api.adminSetLyrics!(plainTrack, { format: 'plain', content: 'line one\nline two' })
      expect(await admin.api.lyrics!(plainTrack)).toMatchObject({ synced: null, plain: 'line one\nline two', source: 'admin' })
      const row = (await admin.api.adminTracks!({ lyrics: 'present', limit: 200 })).items.find((t: any) => t.id === plainTrack)
      expect(row.lyrics).toBe('plain')
      const t = admin.session.current!.accessToken
      const big = await rig.raw(t, 'PUT', `/v1/admin/tracks/${plainTrack}/lyrics`, { format: 'plain', content: 'x'.repeat(200 * 1024 + 1) })
      expect(big.status).toBe(413)
      const stampless = await rig.raw(t, 'PUT', `/v1/admin/tracks/${plainTrack}/lyrics`, { format: 'lrc', content: 'no stamps' })
      expect(stampless.status).toBe(400)
      await admin.api.adminDeleteLyrics!(plainTrack)
    })

    it('saves the per-track lyrics offset for any user, clamped to +-30 s', async () => {
      expect(await guest.api.setLyricsOffset!(plainTrack, 1500)).toEqual({ offsetMs: 1500 })
      expect((await admin.api.lyrics!(plainTrack)).offsetMs).toBe(1500)
      expect(await guest.api.setLyricsOffset!(plainTrack, -99999)).toEqual({ offsetMs: -30000 })
      expect(await guest.api.setLyricsOffset!(plainTrack, 0)).toEqual({ offsetMs: 0 })
      await expect(guest.api.setLyricsOffset!('tr-does-not-exist', 5)).rejects.toMatchObject({ status: 404 })
    })

    it('stores LRC in "synced" and reports the lrc format', async () => {
      await admin.api.adminSetLyrics!(plainTrack, { format: 'lrc', content: GOOD_LRC })
      const lyr = await admin.api.lyrics!(plainTrack)
      expect(lyr.synced).toBe(GOOD_LRC)
      expect(lyr.ttml).toBeNull()
      expect(lyr.plain).toBe('Hello\nWorld')
      const row = (await admin.api.adminTracks!({ lyrics: 'present', limit: 200 })).items.find((t: any) => t.id === plainTrack)
      expect(row.lyrics).toBe('lrc')
      await admin.api.adminDeleteLyrics!(plainTrack)
    })

    it('validates format, content, XML structure and size', async () => {
      const t = admin.session.current!.accessToken
      const put = (body: unknown, id = plainTrack) => rig.raw(t, 'PUT', `/v1/admin/tracks/${id}/lyrics`, body)
      const bad: Array<[string, unknown]> = [
        ['unknown format', { format: 'srt', content: GOOD_LRC }],
        ['missing format', { content: GOOD_LRC }],
        ['missing content', { format: 'lrc' }],
        ['non-string content', { format: 'lrc', content: 5 }],
        ['empty content', { format: 'ttml', content: '   ' }],
        ['LRC without timestamp', { format: 'lrc', content: 'just words' }],
        ['not XML', { format: 'ttml', content: 'hello' }],
        ['wrong root', { format: 'ttml', content: '<html><p begin="1">x</p></html>' }],
        ['no p with begin', { format: 'ttml', content: '<tt><body><p>x</p></body></tt>' }],
        ['unclosed element', { format: 'ttml', content: '<tt><body><p begin="1">x</p></tt>' }],
        ['mismatched tags', { format: 'ttml', content: '<tt><body><p begin="1">x</body></p></tt>' }],
        ['two roots', { format: 'ttml', content: '<tt><p begin="1">x</p></tt><tt/>' }],
        ['DOCTYPE', { format: 'ttml', content: '<!DOCTYPE tt [<!ENTITY a "b">]><tt><p begin="1">&a;</p></tt>' }],
        ['ENTITY only', { format: 'ttml', content: '<tt><!ENTITY x "y"><p begin="1">x</p></tt>' }],
        ['custom entity', { format: 'ttml', content: '<tt><p begin="1">&lol;</p></tt>' }],
        ['unquoted attribute', { format: 'ttml', content: '<tt><p begin=1>x</p></tt>' }],
        ['too large', { format: 'ttml', content: `<tt><body><p begin="1">${'a'.repeat(1024 * 1024)}</p></body></tt>` }]
      ]
      for (const [name, body] of bad) {
        const res = await put(body)
        expect(res.status, name).toBe(400)
        expect(await j(res), name).toHaveProperty('message')
      }
      expect((await put({ format: 'lrc', content: GOOD_LRC }, 'tr-does-not-exist')).status).toBe(404)
      expect((await rig.raw(t, 'DELETE', '/v1/admin/tracks/tr-does-not-exist/lyrics')).status).toBe(404)
      // nothing was stored by the failed attempts
      expect((await admin.api.lyrics!(plainTrack)).ttml).toBeNull()
    })

    it('accepts prefixed TTML with entities, a BOM and 190 KB LRC documents', async () => {
      const prefixed = '﻿<?xml version="1.0"?>\n<!-- c --><tt:tt xmlns:tt="http://www.w3.org/ns/ttml"><tt:body><tt:p begin="0:01.500">A &amp; B &#233;</tt:p></tt:body></tt:tt>'
      await admin.api.adminSetLyrics!(plainTrack, { format: 'ttml', content: prefixed })
      expect((await admin.api.lyrics!(plainTrack)).plain).toBe('A & B é')
      const big = `[00:01.00]${'b'.repeat(190 * 1024)}`
      await admin.api.adminSetLyrics!(plainTrack, { format: 'lrc', content: big })
      await admin.api.adminDeleteLyrics!(plainTrack)
    })
  })

  describe('users', () => {
    it('lists users as AdminUser', async () => {
      const { users } = await admin.api.adminUsers!()
      expect(users.map((u: any) => u.username).sort()).toEqual(['demo', 'guest'])
      const demo = users.find((u: any) => u.username === 'demo')
      expect(demo).toMatchObject({ id: 'u-demo', role: 'admin', displayName: 'Demo', disabled: false })
      expect(Number.isNaN(Date.parse(demo.createdAt))).toBe(false)
      expect(demo.lastLoginAt === null || typeof demo.lastLoginAt === 'string').toBe(true)
      expect(demo.avatar.length).toBeGreaterThan(0)
      expect(demo).not.toHaveProperty('password')
    })

    it('creates users with validation', async () => {
      const u = await admin.api.adminCreateUser!({ username: 'new.user_1', displayName: 'New One', password: 'correct horse', role: 'user' })
      expect(u).toMatchObject({ username: 'new.user_1', displayName: 'New One', role: 'user', disabled: false })
      expect(u.id).toMatch(/^u-/)
      const s = await ServerApi.login(rig.url, 'new.user_1', 'correct horse', fetch)
      expect(s.user.role).toBe('user')
      expect((await admin.api.adminUsers!()).users.find((x: any) => x.id === u.id).lastLoginAt).toEqual(expect.any(String))

      await expect(admin.api.adminCreateUser!({ username: 'new.user_1', password: 'correct horse', role: 'user' })).rejects.toMatchObject({ status: 409 })
      await expect(admin.api.adminCreateUser!({ username: 'NEW.USER_1', password: 'correct horse', role: 'user' })).rejects.toMatchObject({ status: 400 })
      for (const username of ['ab', 'a'.repeat(33), 'has space', 'UPPER', 'sl/ash', '']) {
        await expect(admin.api.adminCreateUser!({ username, password: 'correct horse', role: 'user' }), username).rejects.toMatchObject({ status: 400 })
      }
      await expect(admin.api.adminCreateUser!({ username: 'shortpw', password: '123456789', role: 'user' })).rejects.toMatchObject({ status: 400 })
      await expect(admin.api.adminCreateUser!({ username: 'badrole', password: 'correct horse', role: 'root' })).rejects.toMatchObject({ status: 400 })
      await expect(admin.api.adminCreateUser!({ username: 'badname', displayName: '', password: 'correct horse', role: 'user' })).rejects.toMatchObject({ status: 400 })
      await admin.api.adminDeleteUser!(u.id)
    })

    it('updates display name and role, and rejects unknown fields', async () => {
      const u = await admin.api.adminCreateUser!({ username: 'editme', password: 'correct horse', role: 'user' })
      const upd = await admin.api.adminUpdateUser!(u.id, { displayName: 'Edited', role: 'admin' })
      expect(upd).toMatchObject({ displayName: 'Edited', role: 'admin' })
      const { api } = await rig.login('editme', 'correct horse')
      await expect(api.adminStats!()).resolves.toBeDefined()
      await admin.api.adminUpdateUser!(u.id, { role: 'user' })
      await expect(api.adminStats!()).rejects.toMatchObject({ status: 403 }) // role is checked live
      await expect(admin.api.adminUpdateUser!(u.id, { bogus: 1 })).rejects.toMatchObject({ status: 400 })
      await expect(admin.api.adminUpdateUser!(u.id, { password: 'short' })).rejects.toMatchObject({ status: 400 })
      await expect(admin.api.adminUpdateUser!(u.id, { role: 'x' })).rejects.toMatchObject({ status: 400 })
      await expect(admin.api.adminUpdateUser!(u.id, { disabled: 'yes' })).rejects.toMatchObject({ status: 400 })
      await expect(admin.api.adminUpdateUser!('u-nobody', { displayName: 'x' })).rejects.toMatchObject({ status: 404 })
      await admin.api.adminDeleteUser!(u.id)
    })

    it('revokes the sessions of a user whose password changes', async () => {
      const u = await admin.api.adminCreateUser!({ username: 'pwchange', password: 'old password 1', role: 'user' })
      const a = await ServerApi.login(rig.url, 'pwchange', 'old password 1', fetch)
      expect((await rig.raw(a.accessToken, 'GET', '/v1/me')).status).toBe(200)
      await admin.api.adminUpdateUser!(u.id, { password: 'new password 22' })
      expect((await rig.raw(a.accessToken, 'GET', '/v1/me')).status).toBe(401)
      expect((await rig.raw(null, 'POST', '/v1/auth/refresh', { refreshToken: a.refreshToken })).status).toBe(401)
      await expect(ServerApi.login(rig.url, 'pwchange', 'old password 1', fetch)).rejects.toMatchObject({ status: 401 })
      await expect(ServerApi.login(rig.url, 'pwchange', 'new password 22', fetch)).resolves.toBeDefined()
      await admin.api.adminDeleteUser!(u.id)
    })

    it('disabled users cannot log in or refresh, and can be re-enabled', async () => {
      const u = await admin.api.adminCreateUser!({ username: 'sleeper', password: 'correct horse', role: 'user' })
      const s = await ServerApi.login(rig.url, 'sleeper', 'correct horse', fetch)
      const upd = await admin.api.adminUpdateUser!(u.id, { disabled: true })
      expect(upd.disabled).toBe(true)
      expect((await rig.raw(s.accessToken, 'GET', '/v1/me')).status).toBe(401)
      expect((await rig.raw(null, 'POST', '/v1/auth/refresh', { refreshToken: s.refreshToken })).status).toBe(401)
      const login = await rig.raw(null, 'POST', '/v1/auth/login', { username: 'sleeper', password: 'correct horse' })
      expect(login.status).toBe(403)
      expect((await rig.raw(null, 'POST', '/v1/auth/login', { username: 'sleeper', password: 'wrong' })).status).toBe(401)
      await admin.api.adminUpdateUser!(u.id, { disabled: false })
      await expect(ServerApi.login(rig.url, 'sleeper', 'correct horse', fetch)).resolves.toBeDefined()
      await admin.api.adminDeleteUser!(u.id)
      await expect(ServerApi.login(rig.url, 'sleeper', 'correct horse', fetch)).rejects.toMatchObject({ status: 401 })
      await expect(admin.api.adminDeleteUser!(u.id)).rejects.toMatchObject({ status: 404 })
    })

    it('protects the last enabled admin and self-deletion', async () => {
      const demo = 'u-demo'
      await expect(admin.api.adminDeleteUser!(demo)).rejects.toMatchObject({ status: 409 })
      await expect(admin.api.adminUpdateUser!(demo, { role: 'user' })).rejects.toMatchObject({ status: 409 })
      await expect(admin.api.adminUpdateUser!(demo, { disabled: true })).rejects.toMatchObject({ status: 409 })
      // regular users may be demoted/disabled/deleted freely
      await expect(admin.api.adminUpdateUser!('u-guest', { disabled: true })).resolves.toMatchObject({ disabled: true })
      await admin.api.adminUpdateUser!('u-guest', { disabled: false })

      // with a second admin the first may step down, but nobody deletes themself
      const second = await admin.api.adminCreateUser!({ username: 'second.admin', password: 'correct horse', role: 'admin' })
      const other = await rig.login('second.admin', 'correct horse')
      await expect(other.api.adminDeleteUser!(second.id)).rejects.toMatchObject({ status: 409 })
      await expect(admin.api.adminDeleteUser!(demo)).rejects.toMatchObject({ status: 409 })
      await expect(admin.api.adminUpdateUser!(second.id, { disabled: true })).resolves.toMatchObject({ disabled: true })
      // now demo is the last enabled admin again
      await expect(admin.api.adminUpdateUser!(demo, { role: 'user' })).rejects.toMatchObject({ status: 409 })
      await admin.api.adminUpdateUser!(second.id, { disabled: false })
      const again = await rig.login('second.admin', 'correct horse') // disabling revoked the old session
      await expect(again.api.adminUpdateUser!(demo, { role: 'user' })).resolves.toMatchObject({ role: 'user' })
      await again.api.adminUpdateUser!(demo, { role: 'admin' })
      await admin.api.adminDeleteUser!(second.id)
    })
  })

  describe('backups', () => {
    it('lists two seeded backups, newest first', async () => {
      const { backups } = await admin.api.adminBackups!()
      expect(backups.length).toBeGreaterThanOrEqual(2)
      const seeded = backups.slice(-2)
      expect(seeded[0].createdAt > seeded[1].createdAt).toBe(true)
      for (const b of backups) expect(b).toMatchObject({ id: expect.stringMatching(/^bk-/), sizeBytes: expect.any(Number), createdAt: expect.any(String) })
    })

    it('creates a backup job and restores the snapshot (library + user state)', async () => {
      const before = (await admin.api.adminBackups!()).backups.length
      const job = await admin.api.adminCreateBackup!()
      expect(job).toMatchObject({ kind: 'backup', status: 'queued' })
      expect(finish(rig, job.id).status).toBe('done')
      const { backups } = await admin.api.adminBackups!()
      expect(backups).toHaveLength(before + 1)
      const backup = backups[0]
      expect(backup.label).toContain('database')

      // state at backup time
      const stats0 = await admin.api.adminStats!()
      const liked0 = (await admin.api.libraryTracks!(0, 200)).items.map((t: any) => t.id)
      const victim = (await admin.api.adminTracks!({ limit: 1, offset: 20 })).items[0]
      const likeTarget = liked0[0]

      // mutate: delete a track, unlike, add a download, upload, change lyrics
      await admin.api.adminDeleteTrack!(victim.id)
      await admin.api.setLiked!(likeTarget, false)
      const dl = await admin.api.adminStartDownload!({ source: 'youtube', url: 'https://youtu.be/abcdefghijk' })
      expect(finish(rig, dl.id).status).toBe('done')
      const up = await j(await upload(rig, admin.session.current!.accessToken, mp3(), 'Backup - Temp.mp3'))
      expect((await admin.api.adminStats!()).tracks).toBe(stats0.tracks - 1 + 1 + 1)

      const t = admin.session.current!.accessToken
      expect((await rig.raw(t, 'POST', `/v1/admin/backups/${backup.id}/restore`, {})).status).toBe(400)
      expect((await rig.raw(t, 'POST', `/v1/admin/backups/${backup.id}/restore`, { confirm: 'yes' })).status).toBe(400)
      expect((await rig.raw(t, 'POST', '/v1/admin/backups/bk-nope/restore', { confirm: true })).status).toBe(404)

      const restore = await rig.raw(t, 'POST', `/v1/admin/backups/${backup.id}/restore`, { confirm: true })
      expect(restore.status).toBe(202)
      const rjob = await j(restore)
      expect(rjob).toMatchObject({ kind: 'restore', status: 'queued' })
      // a second restore while one is running is refused
      expect((await rig.raw(t, 'POST', `/v1/admin/backups/${backup.id}/restore`, { confirm: true })).status).toBe(409)
      // nothing changes before the job reaches its restore step
      expect((await admin.api.adminStats!()).tracks).toBe(stats0.tracks + 1)
      expect(finish(rig, rjob.id).status).toBe('done')

      const stats1 = await admin.api.adminStats!()
      expect(stats1.tracks).toBe(stats0.tracks)
      expect(stats1.albums).toBe(stats0.albums)
      expect(stats1.artists).toBe(stats0.artists)
      expect((await admin.api.adminTracks!({ limit: 200 })).items.map((x: any) => x.id)).toContain(victim.id)
      expect((await admin.api.adminTracks!({ limit: 200 })).items.map((x: any) => x.id)).not.toContain(up.id)
      expect((await admin.api.libraryTracks!(0, 200)).items.map((x: any) => x.id)).toEqual(liked0)
      await expect(admin.api.stream!(up.id)).rejects.toMatchObject({ status: 404 })
      const stream = await admin.api.stream!(victim.id)
      expect((await fetch(stream.url)).status).toBe(200)
    })

    it('restores a deleted upload with its bytes and a cancelled restore changes nothing', async () => {
      const data = mp3(1234)
      const up = await j(await upload(rig, admin.session.current!.accessToken, data, 'Keep - Me.mp3'))
      const bjob = await admin.api.adminCreateBackup!()
      finish(rig, bjob.id)
      const backup = (await admin.api.adminBackups!()).backups[0]
      await admin.api.adminDeleteTrack!(up.id)

      const rjob = await admin.api.adminRestoreBackup!(backup.id)
      expect(rjob.kind).toBe('restore')
      rig.mock.advanceJobs(1)
      await admin.api.adminCancelJob!(rjob.id)
      rig.mock.advanceJobs(10)
      await expect(admin.api.stream!(up.id)).rejects.toMatchObject({ status: 404 })

      const again = await admin.api.adminRestoreBackup!(backup.id)
      expect(finish(rig, again.id).status).toBe('done')
      const media = await fetch((await admin.api.stream!(up.id)).url)
      expect(Buffer.from(await media.arrayBuffer()).equals(data)).toBe(true)
    })

    it('restoring a seeded backup returns the demo state', async () => {
      const seeded = (await admin.api.adminBackups!()).backups.at(-1)
      const job = await admin.api.adminRestoreBackup!(seeded.id)
      expect(finish(rig, job.id).status).toBe('done')
      const stats = await admin.api.adminStats!()
      expect(stats).toMatchObject({ tracks: 110, albums: 14, artists: 8, playlists: 6 })
      expect((await admin.api.adminTracks!({ lyrics: 'present', limit: 200 })).total).toBeGreaterThanOrEqual(9)
    })
  })

  describe('job engine timers', () => {
    it('progresses on real timers and stops them on close', async () => {
      const fast = await start({ jobTickMs: 10 })
      const { api } = await fast.login('demo', 'demo')
      const job = await api.adminRescan!()
      expect(job.status).toBe('queued')
      const deadline = Date.now() + 5000
      const states = new Set<string>()
      let cur = job
      while (Date.now() < deadline && cur.status !== 'done') {
        await new Promise((r) => setTimeout(r, 15))
        cur = await api.adminJob!(job.id)
        states.add(cur.status)
      }
      expect(cur.status).toBe('done')
      expect(states.has('running')).toBe(true)
      expect(fast.mock.jobs.timer).toBeNull() // idle engine releases its timer

      const slow = await start({ jobTickMs: 60_000 })
      const s = await slow.login('demo', 'demo')
      await s.api.adminRescan!()
      expect(slow.mock.jobs.timer).not.toBeNull()
      await slow.mock.close()
      expect(slow.mock.jobs.timer).toBeNull()
      await fast.mock.close()
    })
  })
})

describe.skipIf(!available)('MOCK_USERS roles and options', () => {
  it('parses user:pass[:role] and keeps colons in passwords', async () => {
    const mod = (await import(/* @vite-ignore */ pathToFileURL(resolve(__dirname, '../../mock-server/auth.mjs')).href)) as { parseUsers(s: string): any[] }
    expect(mod.parseUsers('a:b:admin,c:d:user,e:f,g:p:w,h:x:y:ADMIN')).toEqual([
      { username: 'a', password: 'b', role: 'admin' },
      { username: 'c', password: 'd', role: 'user' },
      { username: 'e', password: 'f', role: 'user' },
      { username: 'g', password: 'p:w', role: 'user' },
      { username: 'h', password: 'x:y', role: 'admin' }
    ])
    expect(() => mod.parseUsers('')).toThrow()
    expect(() => mod.parseUsers('nopass')).toThrow()
  })

  it('applies MOCK_UPLOAD_MAX through options and rejects larger uploads with 413', async () => {
    const rig = await start({ uploadMaxBytes: 2048, users: [{ username: 'root', password: 'rootroot', role: 'admin' }] })
    try {
      const s = await ServerApi.login(rig.url, 'root', 'rootroot', fetch)
      const info = await j(await fetch(`${rig.url}/v1/info`))
      expect(info.capabilities.uploadMaxBytes).toBe(2048)
      expect((await upload(rig, s.accessToken, mp3(1000), 'A - Small.mp3')).status).toBe(201)
      const big = await upload(rig, s.accessToken, mp3(5000), 'A - Big.mp3')
      expect(big.status).toBe(413)
      expect(await j(big)).toHaveProperty('message')
      // a declared Content-Length far beyond the limit is refused up front
      const huge = await upload(rig, s.accessToken, Buffer.concat([Buffer.from('ID3'), Buffer.alloc(3 * 1024 * 1024)]), 'A - Huge.mp3')
      expect(huge.status).toBe(413)
    } finally {
      await rig.mock.close()
    }
  })

  it('caps the total upload storage', async () => {
    const rig = await start({ uploadStoreMaxBytes: 6000, users: [{ username: 'root', password: 'rootroot', role: 'admin' }] })
    try {
      const s = await ServerApi.login(rig.url, 'root', 'rootroot', fetch)
      expect((await upload(rig, s.accessToken, mp3(4000), 'A - One.mp3')).status).toBe(201)
      expect((await upload(rig, s.accessToken, mp3(4000), 'A - Two.mp3')).status).toBe(413)
    } finally {
      await rig.mock.close()
    }
  })

  it('has no admin when no user is an admin', async () => {
    const rig = await start({ users: [{ username: 'plain', password: 'plainplain' }] })
    try {
      const s = await ServerApi.login(rig.url, 'plain', 'plainplain', fetch)
      expect(s.user.role).toBe('user')
      expect((await rig.raw(s.accessToken, 'GET', '/v1/admin/stats')).status).toBe(403)
    } finally {
      await rig.mock.close()
    }
  })
})

describe.skipIf(!available)('cookie session mode', () => {
  let rig: Rig
  beforeAll(async () => {
    rig = await start()
  })
  afterAll(async () => {
    await rig.mock.close()
  })

  const H = { 'X-Nocturne-Session': 'cookie', 'Content-Type': 'application/json' }
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${rig.url}${path}`, { method: 'POST', headers: { ...H, ...headers }, body: JSON.stringify(body) })
  const cookieOf = (res: Response): string => {
    const sc = res.headers.getSetCookie().find((c) => c.startsWith('nocturne_rt='))
    expect(sc).toBeDefined()
    return sc!.split(';')[0]!
  }
  const tokenOf = (cookie: string): string => cookie.slice('nocturne_rt='.length)

  it('login sets an HttpOnly SameSite=Strict cookie and blanks refreshToken in the body', async () => {
    const res = await post('/v1/auth/login', { username: 'demo', password: 'demo' })
    expect(res.status).toBe(200)
    const body = await j(res)
    expect(body.refreshToken).toBe('')
    expect(body.accessToken).toMatch(/^[0-9a-f]{64}$/)
    expect(body.user.role).toBe('admin')
    const sc = res.headers.getSetCookie()
    expect(sc).toHaveLength(1)
    const attrs = sc[0]!.split(';').map((x) => x.trim())
    expect(attrs[0]).toMatch(/^nocturne_rt=[0-9a-f]{64}$/)
    expect(attrs).toContain('HttpOnly')
    expect(attrs).toContain('SameSite=Strict')
    expect(attrs).toContain('Path=/v1/auth')
    expect(attrs).toContain(`Max-Age=${30 * 86400}`)
    // plain http on 127.0.0.1: Secure is omitted so local testing works
    expect(attrs).not.toContain('Secure')
    // no CORS credentials
    expect(res.headers.get('access-control-allow-credentials')).toBeNull()
  })

  it('sets Secure whenever the origin is https or not localhost', async () => {
    const https = await start({ publicUrl: 'https://music.example.com' })
    try {
      const res = await fetch(`${https.url}/v1/auth/login`, {
        method: 'POST',
        headers: { ...H, Origin: 'https://music.example.com' },
        body: JSON.stringify({ username: 'demo', password: 'demo' })
      })
      expect(res.status).toBe(200)
      expect(res.headers.getSetCookie()[0]!.split(';').map((x) => x.trim())).toContain('Secure')
    } finally {
      await https.mock.close()
    }
    const remote = await start({ publicUrl: 'http://192.168.1.20:4533' })
    try {
      const res = await fetch(`${remote.url}/v1/auth/login`, { method: 'POST', headers: H, body: JSON.stringify({ username: 'demo', password: 'demo' }) })
      expect(res.headers.getSetCookie()[0]!.split(';').map((x) => x.trim())).toContain('Secure')
    } finally {
      await remote.mock.close()
    }
  })

  it('refreshes through the cookie, rotating it, and the new access token works', async () => {
    const login = await post('/v1/auth/login', { username: 'guest', password: 'guestguest' })
    const c1 = cookieOf(login)
    const r = await post('/v1/auth/refresh', {}, { Cookie: c1 })
    expect(r.status).toBe(200)
    const body = await j(r)
    expect(body.refreshToken).toBe('')
    expect(body.user.role).toBe('user')
    const c2 = cookieOf(r)
    expect(c2).not.toBe(c1)
    expect((await rig.raw(body.accessToken, 'GET', '/v1/me')).status).toBe(200)
    // an empty body is fine too
    const r2 = await fetch(`${rig.url}/v1/auth/refresh`, { method: 'POST', headers: { 'X-Nocturne-Session': 'cookie', Cookie: c2 } })
    expect(r2.status).toBe(200)
  })

  it('detects refresh-token reuse, revokes the family and clears the cookie', async () => {
    const login = await post('/v1/auth/login', { username: 'demo', password: 'demo' })
    const c1 = cookieOf(login)
    const first = await post('/v1/auth/refresh', {}, { Cookie: c1 })
    const access = (await j(first)).accessToken
    const c2 = cookieOf(first)
    const replay = await post('/v1/auth/refresh', {}, { Cookie: c1 })
    expect(replay.status).toBe(401)
    const cleared = replay.headers.getSetCookie()[0]!
    expect(cleared).toMatch(/^nocturne_rt=;/)
    expect(cleared).toContain('Max-Age=0')
    expect(cleared).toContain('Path=/v1/auth')
    expect((await post('/v1/auth/refresh', {}, { Cookie: c2 })).status).toBe(401)
    expect((await rig.raw(access, 'GET', '/v1/me')).status).toBe(401)
  })

  it('shares token families with body mode (a body token rotated via cookie mode is reuse)', async () => {
    const body = await j(await fetch(`${rig.url}/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'demo', password: 'demo' }) }))
    expect(body.refreshToken).toMatch(/^[0-9a-f]{64}$/)
    const viaCookie = await post('/v1/auth/refresh', {}, { Cookie: `nocturne_rt=${body.refreshToken}` })
    expect(viaCookie.status).toBe(200)
    // cookie mode only reads the cookie, never a token in the body
    expect((await post('/v1/auth/refresh', { refreshToken: body.refreshToken })).status).toBe(401)
    const plainReuse = await fetch(`${rig.url}/v1/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: body.refreshToken }) })
    expect(plainReuse.status).toBe(401)
  })

  it('answers 401 and clears the cookie for a missing, unknown or garbage cookie', async () => {
    for (const headers of [{}, { Cookie: 'nocturne_rt=deadbeef' }, { Cookie: 'other=1' }] as Array<Record<string, string>>) {
      const res = await post('/v1/auth/refresh', {}, headers)
      expect(res.status).toBe(401)
      expect(res.headers.getSetCookie()[0]).toMatch(/^nocturne_rt=;.*Max-Age=0/)
    }
  })

  it('logout revokes the cookie family, clears the cookie and answers 204', async () => {
    const login = await post('/v1/auth/login', { username: 'demo', password: 'demo' })
    const cookie = cookieOf(login)
    const access = (await j(login)).accessToken
    const out = await post('/v1/auth/logout', {}, { Cookie: cookie })
    expect(out.status).toBe(204)
    expect(out.headers.getSetCookie()[0]).toMatch(/^nocturne_rt=;.*Max-Age=0/)
    expect((await post('/v1/auth/refresh', {}, { Cookie: cookie })).status).toBe(401)
    expect((await rig.raw(access, 'GET', '/v1/me')).status).toBe(401)
    expect((await post('/v1/auth/logout', {})).status).toBe(204) // idempotent without cookie
  })

  it('refuses cookie-mode requests from a foreign Origin (CSRF) but accepts our own', async () => {
    const login = await post('/v1/auth/login', { username: 'demo', password: 'demo' })
    const cookie = cookieOf(login)
    for (const path of ['/v1/auth/refresh', '/v1/auth/logout']) {
      const res = await post(path, {}, { Cookie: cookie, Origin: 'https://evil.example' })
      expect(res.status, path).toBe(403)
      expect(res.headers.getSetCookie()).toEqual([])
    }
    expect((await post('/v1/auth/login', { username: 'demo', password: 'demo' }, { Origin: 'https://evil.example' })).status).toBe(403)
    // an allowed CORS origin is still not the server's own origin
    expect((await post('/v1/auth/refresh', {}, { Cookie: cookie, Origin: 'http://localhost:5173' })).status).toBe(403)
    // the cookie survived the rejected attempts
    expect((await post('/v1/auth/refresh', {}, { Cookie: cookie, Origin: rig.url })).status).toBe(200)
  })

  it('without the header it is plain body mode: no cookie, token in the body, cookie ignored', async () => {
    const res = await fetch(`${rig.url}/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'demo', password: 'demo' }) })
    expect(res.headers.getSetCookie()).toEqual([])
    const body = await j(res)
    expect(body.refreshToken).not.toBe('')
    // a cookie alone does not authenticate a body-mode refresh
    const cookieLogin = await post('/v1/auth/login', { username: 'demo', password: 'demo' })
    const cookie = cookieOf(cookieLogin)
    const noHeader = await fetch(`${rig.url}/v1/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' })
    expect(noHeader.status).toBe(400)
    expect(tokenOf(cookie)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('allows the session header in CORS preflights and never allows credentials', async () => {
    const res = await fetch(`${rig.url}/v1/auth/refresh`, {
      method: 'OPTIONS',
      headers: { Origin: 'app://nocturne', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-nocturne-session' }
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-headers')).toMatch(/X-Nocturne-Session/i)
    expect(res.headers.get('access-control-allow-methods')).toContain('PATCH')
    expect(res.headers.get('access-control-allow-credentials')).toBeNull()
  })

  it('works with the Origin of the Host header and with MOCK_PUBLIC_URL', async () => {
    const pub = await start({ publicUrl: 'https://music.example.com' })
    try {
      const ok = await fetch(`${pub.url}/v1/auth/login`, { method: 'POST', headers: { ...H, Origin: 'https://music.example.com' }, body: JSON.stringify({ username: 'demo', password: 'demo' }) })
      expect(ok.status).toBe(200)
      const bad = await fetch(`${pub.url}/v1/auth/login`, { method: 'POST', headers: { ...H, Origin: pub.url }, body: JSON.stringify({ username: 'demo', password: 'demo' }) })
      expect(bad.status).toBe(403)
    } finally {
      await pub.mock.close()
    }
  })
})

describe.skipIf(!available)('static hosting', () => {
  let rig: Rig
  let root: string
  let outside: string

  beforeAll(async () => {
    outside = mkdtempSync(join(tmpdir(), 'nocturne-static-outside-'))
    writeFileSync(join(outside, 'secret.txt'), 'TOP-SECRET')
    root = join(outside, 'dist-hosted')
    mkdirSync(join(root, 'assets'), { recursive: true })
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>Nocturne</title><div id="root"></div>')
    writeFileSync(join(root, 'docs', 'index.html'), '<!doctype html><title>Docs</title>')
    writeFileSync(join(root, 'assets', 'app-abc123.js'), 'console.log("app")')
    writeFileSync(join(root, 'assets', 'app-abc123.css'), 'body{margin:0}')
    writeFileSync(join(root, 'assets', 'font.woff2'), Buffer.from([1, 2, 3]))
    writeFileSync(join(root, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    writeFileSync(join(root, 'manifest.webmanifest'), '{}')
    try {
      symlinkSync(join(outside, 'secret.txt'), join(root, 'leak.txt'))
    } catch {
      /* symlinks unavailable */
    }
    rig = await start({ staticDir: root })
  })
  afterAll(async () => {
    await rig.mock.close()
    rmSync(outside, { recursive: true, force: true })
  })

  const rawGet = (path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, any>; body: string }> =>
    new Promise((resolveReq, reject) => {
      const u = new URL(rig.url)
      const req = httpRequest({ host: u.hostname, port: u.port, path, method: 'GET', headers }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolveReq({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
      })
      req.on('error', reject)
      req.end()
    })

  it('serves index.html at / with the security headers', async () => {
    const res = await fetch(`${rig.url}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await res.text()).toContain('<div id="root">')
    expect(res.headers.get('content-security-policy')).toBe(
      "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' https://lrclib.net; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    )
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('cache-control')).toBe('no-cache')
  })

  it('falls back to index.html for client-side routes but not for API paths', async () => {
    for (const p of ['/library/albums/al-x', '/admin', '/some/deep/route/']) {
      const res = await fetch(`${rig.url}${p}`)
      expect(res.status, p).toBe(200)
      expect(await res.text(), p).toContain('<title>Nocturne</title>')
    }
    for (const p of ['/v1/nope', '/art/nope/x.svg', '/v1']) {
      const res = await fetch(`${rig.url}${p}`)
      expect(res.status, p).toBe(404)
      expect(res.headers.get('content-type'), p).toContain('application/json')
    }
    const media = await fetch(`${rig.url}/media/nope`)
    expect(media.status).toBe(403) // unsigned media URL: handled by the API, never by the static handler
    expect(media.headers.get('content-type')).toContain('application/json')
    // the real API keeps working next to the static files
    const info = await j(await fetch(`${rig.url}/v1/info`))
    expect(info.apiVersion).toBe(1)
  })

  it('serves assets with the right MIME type and long-lived caching, and 404s missing files', async () => {
    const js = await fetch(`${rig.url}/assets/app-abc123.js`)
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(js.headers.get('content-security-policy')).toBeNull()
    expect(await js.text()).toBe('console.log("app")')
    expect((await fetch(`${rig.url}/assets/app-abc123.css`)).headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect((await fetch(`${rig.url}/assets/font.woff2`)).headers.get('content-type')).toBe('font/woff2')
    expect((await fetch(`${rig.url}/favicon.svg`)).headers.get('content-type')).toBe('image/svg+xml')
    expect((await fetch(`${rig.url}/manifest.webmanifest`)).headers.get('content-type')).toContain('application/manifest+json')
    expect((await fetch(`${rig.url}/assets/missing.js`)).status).toBe(404)
    expect((await fetch(`${rig.url}/missing.png`)).status).toBe(404)
    // a browser navigation to an unknown dotted path still gets the app
    expect((await fetch(`${rig.url}/weird.page`, { headers: { Accept: 'text/html' } })).status).toBe(200)
  })

  it('serves directory indexes, supports HEAD and conditional requests', async () => {
    expect(await (await fetch(`${rig.url}/docs/`)).text()).toContain('<title>Docs</title>')
    expect(await (await fetch(`${rig.url}/docs`)).text()).toContain('<title>Docs</title>')
    const head = await fetch(`${rig.url}/assets/app-abc123.js`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(String('console.log("app")'.length))
    const etag = head.headers.get('etag')!
    const cond = await fetch(`${rig.url}/assets/app-abc123.js`, { headers: { 'If-None-Match': etag } })
    expect(cond.status).toBe(304)
  })

  it('blocks path traversal, encoded traversal and symlink escapes', async () => {
    for (const p of ['/..%2f..%2fsecret.txt', '/%2e%2e%2fsecret.txt', '/assets/..%2f..%2fsecret.txt', '/..%5csecret.txt', '/%00']) {
      const res = await rawGet(p)
      expect(res.status, p).toBe(403)
      expect(res.body, p).not.toContain('TOP-SECRET')
    }
    for (const p of ['/../secret.txt', '/../../secret.txt', '/assets/../../secret.txt', '/%2e%2e/secret.txt']) {
      const res = await rawGet(p)
      expect(res.body, p).not.toContain('TOP-SECRET')
    }
    if (existsSync(join(root, 'leak.txt'))) {
      const res = await rawGet('/leak.txt')
      expect(res.status).toBe(403)
      expect(res.body).not.toContain('TOP-SECRET')
    }
    expect((await rawGet('/%E0%A4%A')).status).toBe(400)
  })

  it('only allows GET and HEAD on static paths', async () => {
    const res = await fetch(`${rig.url}/`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toContain('GET')
  })

  it('refuses a missing directory and serves nothing without staticDir', async () => {
    const createMockServer = await load()
    expect(() => createMockServer({ quiet: true, staticDir: join(outside, 'does-not-exist') })).toThrow(/staticDir/)
    const plain = await start()
    try {
      expect((await fetch(`${plain.url}/`)).status).toBe(404)
    } finally {
      await plain.mock.close()
    }
  })

  it('serves the SPA while the cookie session works end to end on the same origin', async () => {
    const login = await fetch(`${rig.url}/v1/auth/login`, {
      method: 'POST',
      headers: { 'X-Nocturne-Session': 'cookie', 'Content-Type': 'application/json', Origin: rig.url },
      body: JSON.stringify({ username: 'demo', password: 'demo' })
    })
    expect(login.status).toBe(200)
    const sess = await j(login)
    const me = await fetch(`${rig.url}/v1/me`, { headers: { Authorization: `Bearer ${sess.accessToken}` } })
    expect((await j(me)).role).toBe('admin')
  })
})
