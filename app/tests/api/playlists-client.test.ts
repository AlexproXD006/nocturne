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

const detail = { id: 'p 1', name: 'Mine', artwork: [], editable: true, tracks: [] }

describe('playlist editing endpoints', () => {
  it('createPlaylist POSTs the body and returns the 201 detail', async () => {
    const f = fakeFetch(() => jsonResponse(detail, { status: 201 }))
    const res = await client(f).createPlaylist({ name: 'Mine', description: 'd', trackIds: ['t1'] })
    expect(res).toEqual(detail)
    expect(f.calls[0]).toMatchObject({ method: 'POST', url: `${BASE}/v1/playlists`, body: { name: 'Mine', description: 'd', trackIds: ['t1'] } })
    expect(f.calls[0]!.headers.Authorization).toBe('Bearer access-1')
  })

  it('updatePlaylist PATCHes the encoded id', async () => {
    const f = fakeFetch(() => jsonResponse({ ...detail, tracks: undefined, name: 'New' }))
    const res = await client(f).updatePlaylist('p 1', { name: 'New' })
    expect(res.name).toBe('New')
    expect(f.calls[0]).toMatchObject({ method: 'PATCH', url: `${BASE}/v1/playlists/p%201`, body: { name: 'New' } })
  })

  it('deletePlaylist sends DELETE and resolves to undefined on 204', async () => {
    const f = fakeFetch(() => emptyResponse(204))
    await expect(client(f).deletePlaylist('p1')).resolves.toBeUndefined()
    expect(f.calls[0]).toMatchObject({ method: 'DELETE', url: `${BASE}/v1/playlists/p1` })
  })

  it('addToPlaylist POSTs trackIds and returns added / skipped', async () => {
    const out = { added: 1, skipped: ['t2'], playlist: { id: 'p1', name: 'Mine', artwork: [] } }
    const f = fakeFetch(() => jsonResponse(out))
    await expect(client(f).addToPlaylist('p1', ['t1', 't2'])).resolves.toEqual(out)
    expect(f.calls[0]).toMatchObject({ method: 'POST', url: `${BASE}/v1/playlists/p1/tracks`, body: { trackIds: ['t1', 't2'] } })
  })

  it('addToPlaylist sends allowDuplicates only when set', async () => {
    const f = fakeFetch(() => jsonResponse({ added: ['t1'], skipped: [], playlist: { id: 'p1', name: 'Mine', artwork: [] } }))
    await expect(client(f).addToPlaylist('p1', ['t1'], { allowDuplicates: true })).resolves.toMatchObject({ added: 1, skipped: [] })
    await client(f).addToPlaylist('p1', ['t1'], { allowDuplicates: false })
    expect(f.calls[0]!.body).toEqual({ trackIds: ['t1'], allowDuplicates: true })
    expect(f.calls[1]!.body).toEqual({ trackIds: ['t1'] })
  })

  it('removePlaylistEntry DELETEs one encoded entry', async () => {
    const f = fakeFetch(() => emptyResponse(204))
    await expect(client(f).removePlaylistEntry('p 1', 'e/1')).resolves.toBeUndefined()
    expect(f.calls[0]).toMatchObject({ method: 'DELETE', url: `${BASE}/v1/playlists/p%201/entries/e%2F1` })
  })

  it('reorderPlaylist sends entryIds when every track has one', async () => {
    const f = fakeFetch(() => jsonResponse(detail))
    await client(f).reorderPlaylist('p1', [
      { id: 'a', entryId: 'e2' },
      { id: 'a', entryId: 'e1' },
      { id: 'b', entryId: 'e3' }
    ])
    expect(f.calls[0]).toMatchObject({ method: 'PUT', url: `${BASE}/v1/playlists/p1/tracks` })
    expect(f.calls[0]!.body).toEqual({ entryIds: ['e2', 'e1', 'e3'] })
  })

  it('reorderPlaylist falls back to trackIds when any track lacks an entryId', async () => {
    const f = fakeFetch(() => jsonResponse(detail))
    await client(f).reorderPlaylist('p1', [{ id: 'a', entryId: 'e1' }, { id: 'b' }, { id: 'a' }])
    expect(f.calls[0]!.body).toEqual({ trackIds: ['a', 'b', 'a'] })
  })

  it('removeFromPlaylist DELETEs the encoded track path', async () => {
    const f = fakeFetch(() => emptyResponse(204))
    await expect(client(f).removeFromPlaylist('p1', 'a/b')).resolves.toBeUndefined()
    expect(f.calls[0]).toMatchObject({ method: 'DELETE', url: `${BASE}/v1/playlists/p1/tracks/a%2Fb` })
  })

  it('reorderPlaylist PUTs the full order', async () => {
    const f = fakeFetch(() => jsonResponse(detail))
    await client(f).reorderPlaylist('p1', ['b', 'a'])
    expect(f.calls[0]).toMatchObject({ method: 'PUT', url: `${BASE}/v1/playlists/p1/tracks`, body: { trackIds: ['b', 'a'] } })
  })

  it('maps 403 to forbidden and does not retry mutations', async () => {
    const f = fakeFetch(() => jsonResponse({ message: "You can't change this playlist." }, { status: 403 }))
    const err = await client(f).addToPlaylist('p1', ['t1']).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ code: 'forbidden', message: "You can't change this playlist." })
    expect(f.calls).toHaveLength(1)
  })

  it('never retries a mutation on 5xx', async () => {
    const f = fakeFetch(() => jsonResponse({}, { status: 503 }))
    await expect(client(f).reorderPlaylist('p1', ['a'])).rejects.toMatchObject({ code: 'server' })
    expect(f.calls).toHaveLength(1)
  })
})

describe('mixes endpoints', () => {
  it('mixes / mix / refreshMixes hit /v1/mixes', async () => {
    const f = fakeFetch(() => jsonResponse({ items: [] }))
    await client(f).mixes()
    await client(f).mix('daily 1')
    await client(f).refreshMixes()
    expect(f.calls[0]).toMatchObject({ method: 'GET', url: `${BASE}/v1/mixes` })
    expect(f.calls[1]).toMatchObject({ method: 'GET', url: `${BASE}/v1/mixes/daily%201` })
    expect(f.calls[2]).toMatchObject({ method: 'POST', url: `${BASE}/v1/mixes/refresh` })
  })
})
