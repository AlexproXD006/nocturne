import { describe, expect, it, vi } from 'vitest'
import { ApiClient, type StoredSession } from '@/api/client'
import { ApiError } from '@/api/errors'
import { storedSession } from '../helpers/fixtures'
import { emptyResponse, fakeFetch, jsonResponse, type FakeFetch } from '../helpers/http'

const BASE = 'https://music.example.com'
const NOW = 1_000_000

function client(f: FakeFetch): ApiClient {
  const session: { current: StoredSession | null } = { current: storedSession({ expiresAt: NOW + 3_600_000 }) }
  return new ApiClient({ getSession: () => session.current, setSession: vi.fn(), fetch: f, now: () => NOW })
}

const imp = {
  id: 'i 1',
  status: 'queued',
  spotifyPlaylist: { id: 'sp1', name: 'Favs 2.0' },
  total: 0,
  matched: 0,
  downloaded: 0,
  failed: 0,
  pending: 0,
  failures: [],
  createdAt: '2026-01-01T00:00:00Z'
}

describe('Spotify import endpoints', () => {
  it('spotifyStatus GETs /v1/spotify/status with auth', async () => {
    const status = { configured: true, connected: true, account: { id: 'a', displayName: 'Alex' }, expiresAt: '2027-01-01T00:00:00Z' }
    const f = fakeFetch(() => jsonResponse(status))
    await expect(client(f).spotifyStatus()).resolves.toEqual(status)
    expect(f.calls[0]).toMatchObject({ method: 'GET', url: `${BASE}/v1/spotify/status` })
    expect(f.calls[0]!.headers.Authorization).toBe('Bearer access-1')
  })

  it('spotifyAuthorize POSTs and returns the login url', async () => {
    const f = fakeFetch(() => jsonResponse({ url: 'https://accounts.spotify.com/authorize?x=1' }))
    await expect(client(f).spotifyAuthorize()).resolves.toEqual({ url: 'https://accounts.spotify.com/authorize?x=1' })
    expect(f.calls[0]).toMatchObject({ method: 'POST', url: `${BASE}/v1/spotify/authorize` })
  })

  it.each([[{ url: 'javascript:alert(1)' }], [{ url: 42 }], [{}], [{ url: 'not a url' }]])('spotifyAuthorize rejects an unusable url %j', async (body) => {
    const f = fakeFetch(() => jsonResponse(body))
    await expect(client(f).spotifyAuthorize()).rejects.toMatchObject({ code: 'bad_response' })
  })

  it('spotifyDisconnect DELETEs the connection (204)', async () => {
    const f = fakeFetch(() => emptyResponse(204))
    await expect(client(f).spotifyDisconnect()).resolves.toBeUndefined()
    expect(f.calls[0]).toMatchObject({ method: 'DELETE', url: `${BASE}/v1/spotify/connection` })
  })

  it('spotifyPlaylists GETs the list', async () => {
    const list = [{ id: 'p1', name: 'A', trackCount: 3 }]
    const f = fakeFetch(() => jsonResponse(list))
    await expect(client(f).spotifyPlaylists()).resolves.toEqual(list)
    expect(f.calls[0]).toMatchObject({ method: 'GET', url: `${BASE}/v1/spotify/playlists` })
  })

  it('spotifyStartImport POSTs playlist + download and returns the 202 import', async () => {
    const f = fakeFetch(() => jsonResponse(imp, { status: 202 }))
    await expect(client(f).spotifyStartImport({ playlist: 'sp1', download: false })).resolves.toEqual(imp)
    expect(f.calls[0]).toMatchObject({ method: 'POST', url: `${BASE}/v1/spotify/imports`, body: { playlist: 'sp1', download: false } })
  })

  it('spotifyImports / spotifyImport / spotifyCancelImport use the encoded id', async () => {
    const f = fakeFetch((call) => (call.method === 'DELETE' ? emptyResponse(204) : jsonResponse(call.url.endsWith('/imports') ? [imp] : imp)))
    const c = client(f)
    await expect(c.spotifyImports()).resolves.toEqual([imp])
    await expect(c.spotifyImport('i 1')).resolves.toEqual(imp)
    await expect(c.spotifyCancelImport('i 1')).resolves.toBeUndefined()
    expect(f.calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      `GET ${BASE}/v1/spotify/imports`,
      `GET ${BASE}/v1/spotify/imports/i%201`,
      `DELETE ${BASE}/v1/spotify/imports/i%201`
    ])
  })

  it('maps 409 (not connected) to an ApiError with status 409 and the server message', async () => {
    const f = fakeFetch(() => jsonResponse({ message: 'Connect your Spotify account first.' }, { status: 409 }))
    const err = await client(f).spotifyPlaylists().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 409, code: 'bad_request', message: 'Connect your Spotify account first.' })
  })
})
