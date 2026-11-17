import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/errors'
import type { SpotifyImport } from '@/api/types'
import { ResourceCache } from '@/lib/resource'
import {
  connectionExpiry,
  createSpotifyStore,
  describeFinished,
  importProgress,
  isActiveImport,
  parseSpotifyPlaylist,
  type SpotifyApi
} from '@/store/spotify'

const ID = '37i9dQZF1DXcBWIGoYBM5M'

const imp = (over: Partial<SpotifyImport> = {}): SpotifyImport => ({
  id: 'i1',
  status: 'matching',
  spotifyPlaylist: { id: ID, name: 'Favs 2.0' },
  total: 10,
  matched: 2,
  downloaded: 0,
  failed: 0,
  pending: 8,
  failures: [],
  createdAt: '2026-01-01T00:00:00Z',
  ...over
})

function fakeApi(): { [K in keyof SpotifyApi]: ReturnType<typeof vi.fn> } {
  return {
    spotifyStatus: vi.fn(),
    spotifyAuthorize: vi.fn(),
    spotifyDisconnect: vi.fn(),
    spotifyPlaylists: vi.fn(),
    spotifyStartImport: vi.fn(),
    spotifyImports: vi.fn(),
    spotifyImport: vi.fn(),
    spotifyCancelImport: vi.fn()
  }
}

describe('helpers', () => {
  it('parses links, URIs and bare ids', () => {
    expect(parseSpotifyPlaylist(ID)).toBe(ID)
    expect(parseSpotifyPlaylist(`https://open.spotify.com/playlist/${ID}?si=abc`)).toBe(ID)
    expect(parseSpotifyPlaylist(`https://open.spotify.com/intl-es/playlist/${ID}`)).toBe(ID)
    expect(parseSpotifyPlaylist(`open.spotify.com/playlist/${ID}`)).toBe(ID)
    expect(parseSpotifyPlaylist(`  spotify:playlist:${ID} `)).toBe(ID)
    expect(parseSpotifyPlaylist(`spotify:user:bob:playlist:${ID}`)).toBe(ID)
    expect(parseSpotifyPlaylist('')).toBeNull()
    expect(parseSpotifyPlaylist(`https://open.spotify.com/album/${ID}`)).toBeNull()
    expect(parseSpotifyPlaylist(`https://evil.example/playlist/${ID}`)).toBeNull()
    expect(parseSpotifyPlaylist(`javascript:alert(1)`)).toBeNull()
    expect(parseSpotifyPlaylist('hello world')).toBeNull()
  })

  it('computes progress as (matched + downloaded) / total', () => {
    expect(importProgress(imp({ total: 10, matched: 3, downloaded: 2 }))).toEqual({ ready: 5, total: 10, fraction: 0.5 })
    expect(importProgress(imp({ total: 0, matched: 0, downloaded: 0 })).fraction).toBeUndefined()
    expect(importProgress(imp({ total: 4, matched: 9, downloaded: 0 })).ready).toBe(4)
  })

  it('describes finished imports', () => {
    expect(describeFinished(imp({ status: 'done', total: 242, matched: 200, downloaded: 30, failed: 12 }))).toBe("Imported 'Favs 2.0': 230 songs, 12 not found")
    expect(describeFinished(imp({ status: 'done', total: 1, matched: 1, failed: 0 }))).toBe("Imported 'Favs 2.0': 1 song")
    expect(describeFinished(imp({ status: 'failed' }))).toBe("Couldn't import 'Favs 2.0'")
    expect(describeFinished(imp({ status: 'failed', error: 'Spotify is down' }))).toBe("Couldn't import 'Favs 2.0': Spotify is down")
    expect(describeFinished(imp({ status: 'cancelled' }))).toBe("Import of 'Favs 2.0' cancelled")
  })

  it('reports connection expiry', () => {
    const now = Date.parse('2026-06-01T00:00:00Z')
    expect(connectionExpiry(null, now)).toBeNull()
    expect(connectionExpiry({ expiresAt: 'nope' }, now)).toBeNull()
    expect(connectionExpiry({ expiresAt: '2026-12-01T00:00:00Z' }, now)).toMatchObject({ expired: false, soon: false })
    expect(connectionExpiry({ expiresAt: '2026-06-05T00:00:00Z' }, now)).toMatchObject({ expired: false, soon: true, daysLeft: 4 })
    expect(connectionExpiry({ expiresAt: '2026-05-01T00:00:00Z' }, now)).toMatchObject({ expired: true, soon: false })
  })

  it('knows which statuses are active', () => {
    expect(['queued', 'reading', 'matching', 'downloading'].every((s) => isActiveImport({ status: s as SpotifyImport['status'] }))).toBe(true)
    expect(['done', 'failed', 'cancelled'].some((s) => isActiveImport({ status: s as SpotifyImport['status'] }))).toBe(false)
  })
})

describe('createSpotifyStore', () => {
  let api: ReturnType<typeof fakeApi>
  let cache: ResourceCache
  let visible: boolean
  let clock: number

  beforeEach(() => {
    vi.useFakeTimers()
    api = fakeApi()
    cache = new ResourceCache()
    visible = true
    clock = 1_000_000
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const make = (onFinished = vi.fn()) => ({
    onFinished,
    store: createSpotifyStore({ api: api as unknown as SpotifyApi, cache, intervalMs: 3000, invalidateEveryMs: 10_000, now: () => clock, isVisible: () => visible, onFinished })
  })

  it('loads the status and clears playlists when not connected', async () => {
    const { store } = make()
    api.spotifyStatus.mockResolvedValue({ configured: true, connected: false })
    store.setState({ playlists: [{ id: 'x', name: 'x', trackCount: 1 }] })
    await store.getState().loadStatus()
    expect(store.getState()).toMatchObject({ status: { connected: false }, statusLoading: false, playlists: null })
  })

  it('records status errors', async () => {
    const { store } = make()
    api.spotifyStatus.mockRejectedValue(new ApiError('network', 'offline'))
    await expect(store.getState().loadStatus()).resolves.toBeNull()
    expect(store.getState().statusError).toBe('offline')
  })

  it('treats a 409 while listing playlists as "not connected"', async () => {
    const { store } = make()
    store.setState({ status: { configured: true, connected: true } })
    api.spotifyPlaylists.mockRejectedValue(ApiError.fromStatus(409, 'Connect first'))
    await store.getState().loadPlaylists()
    expect(store.getState().status).toEqual({ configured: true, connected: false })
    expect(store.getState().playlistsError).toBeNull()
  })

  it('caches playlists unless forced', async () => {
    const { store } = make()
    api.spotifyPlaylists.mockResolvedValue([{ id: 'p', name: 'P', trackCount: 2 }])
    await store.getState().loadPlaylists()
    await store.getState().loadPlaylists()
    expect(api.spotifyPlaylists).toHaveBeenCalledTimes(1)
    await store.getState().loadPlaylists(true)
    expect(api.spotifyPlaylists).toHaveBeenCalledTimes(2)
  })

  it('disconnect keeps `configured` and forgets the account', async () => {
    const { store } = make()
    api.spotifyDisconnect.mockResolvedValue(undefined)
    store.setState({ status: { configured: true, connected: true, account: { id: 'a', displayName: 'A' } }, playlists: [] })
    await store.getState().disconnect()
    expect(store.getState().status).toEqual({ configured: true, connected: false })
    expect(store.getState().playlists).toBeNull()
  })

  it('polls active imports every interval while watched, and stops when they finish', async () => {
    const { store, onFinished } = make()
    api.spotifyImports.mockResolvedValue([imp()])
    const unwatch = store.getState().watch()
    await store.getState().refreshImports()
    expect(store.getState().polling).toBe(true)

    api.spotifyImport.mockResolvedValueOnce(imp({ matched: 5, pending: 5, playlistId: 'pl1' }))
    await vi.advanceTimersByTimeAsync(3000)
    expect(api.spotifyImport).toHaveBeenCalledTimes(1)
    expect(store.getState().imports[0]).toMatchObject({ matched: 5 })

    api.spotifyImport.mockResolvedValueOnce(imp({ status: 'done', matched: 9, failed: 1, pending: 0, playlistId: 'pl1' }))
    await vi.advanceTimersByTimeAsync(3000)
    expect(onFinished).toHaveBeenCalledWith(expect.objectContaining({ status: 'done' }))
    expect(store.getState().polling).toBe(false)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(api.spotifyImport).toHaveBeenCalledTimes(2)
    unwatch()
  })

  it('does not poll without a watcher or without active imports', async () => {
    const { store } = make()
    api.spotifyImports.mockResolvedValue([imp()])
    await store.getState().refreshImports()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(api.spotifyImport).not.toHaveBeenCalled()

    store.setState({ imports: [imp({ status: 'done' })] })
    const unwatch = store.getState().watch()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(api.spotifyImport).not.toHaveBeenCalled()
    expect(store.getState().polling).toBe(false)
    unwatch()
  })

  it('stops when the last watcher leaves and pauses while hidden', async () => {
    const { store } = make()
    api.spotifyImport.mockResolvedValue(imp())
    store.setState({ imports: [imp()] })
    const a = store.getState().watch()
    const b = store.getState().watch()
    a()
    await vi.advanceTimersByTimeAsync(3000)
    expect(api.spotifyImport).toHaveBeenCalledTimes(1)
    b()
    b() // idempotent
    await vi.advanceTimersByTimeAsync(9000)
    expect(api.spotifyImport).toHaveBeenCalledTimes(1)
    expect(store.getState().polling).toBe(false)

    const c = store.getState().watch()
    visible = false
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(9000)
    expect(api.spotifyImport).toHaveBeenCalledTimes(1)
    visible = true
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(api.spotifyImport).toHaveBeenCalledTimes(2)
    c()
  })

  it('does not toast imports that were already finished when first loaded', async () => {
    const { store, onFinished } = make()
    api.spotifyImports.mockResolvedValue([imp({ status: 'done' })])
    await store.getState().refreshImports()
    expect(onFinished).not.toHaveBeenCalled()
    expect(store.getState().importsLoaded).toBe(true)
  })

  it('invalidates playlist caches when the playlist appears, (throttled) on progress and on finish', async () => {
    const { store } = make()
    const spy = vi.spyOn(cache, 'invalidate')
    store.setState({ imports: [imp()] })
    const unwatch = store.getState().watch()
    const keys = (): string[] => spy.mock.calls.map((c) => String(c[0]))

    api.spotifyImport.mockResolvedValueOnce(imp({ matched: 3, playlistId: 'pl1' }))
    await vi.advanceTimersByTimeAsync(3000)
    expect(keys()).toEqual(expect.arrayContaining(['library:playlists', 'playlist:pl1']))
    spy.mockClear()

    clock += 3000
    api.spotifyImport.mockResolvedValueOnce(imp({ matched: 4, playlistId: 'pl1' }))
    await vi.advanceTimersByTimeAsync(3000)
    expect(keys()).toEqual([]) // throttled

    clock += 10_000
    api.spotifyImport.mockResolvedValueOnce(imp({ matched: 6, playlistId: 'pl1' }))
    await vi.advanceTimersByTimeAsync(3000)
    expect(keys()).toContain('playlist:pl1')
    spy.mockClear()

    clock += 1000
    api.spotifyImport.mockResolvedValueOnce(imp({ status: 'done', matched: 10, pending: 0, playlistId: 'pl1' }))
    await vi.advanceTimersByTimeAsync(3000)
    expect(keys()).toEqual(expect.arrayContaining(['library:playlists', 'playlist:pl1']))
    unwatch()
  })

  it('startImport prepends the import and starts polling', async () => {
    const { store } = make()
    const unwatch = store.getState().watch()
    store.setState({ imports: [imp({ id: 'old', status: 'done' })] })
    api.spotifyStartImport.mockResolvedValue(imp({ id: 'new', status: 'queued' }))
    api.spotifyImport.mockResolvedValue(imp({ id: 'new', status: 'reading' }))
    await store.getState().startImport(ID, false)
    expect(api.spotifyStartImport).toHaveBeenCalledWith({ playlist: ID, download: false })
    expect(store.getState().imports.map((i) => i.id)).toEqual(['new', 'old'])
    expect(store.getState().polling).toBe(true)
    await vi.advanceTimersByTimeAsync(3000)
    expect(store.getState().imports[0]!.status).toBe('reading')
    unwatch()
  })

  it('startImport re-checks the status on 409', async () => {
    const { store } = make()
    api.spotifyStartImport.mockRejectedValue(ApiError.fromStatus(409, 'Connect first'))
    api.spotifyStatus.mockResolvedValue({ configured: true, connected: false })
    await expect(store.getState().startImport(ID, true)).rejects.toMatchObject({ status: 409 })
    expect(api.spotifyStatus).toHaveBeenCalled()
  })

  it('cancelImport marks the import cancelled without a finish toast', async () => {
    const { store, onFinished } = make()
    store.setState({ imports: [imp({ playlistId: 'pl1' })] })
    api.spotifyCancelImport.mockResolvedValue(undefined)
    api.spotifyImport.mockResolvedValue(imp({ status: 'cancelled', playlistId: 'pl1', finishedAt: 'x' }))
    await store.getState().cancelImport('i1')
    expect(api.spotifyCancelImport).toHaveBeenCalledWith('i1')
    expect(store.getState().imports[0]).toMatchObject({ status: 'cancelled', finishedAt: 'x' })
    expect(onFinished).not.toHaveBeenCalled()
  })

  it('drops imports that disappeared (404) and keeps polling through transient errors', async () => {
    const { store } = make()
    store.setState({ imports: [imp({ id: 'gone' }), imp({ id: 'flaky' })] })
    api.spotifyImport.mockImplementation(async (id: string) => {
      throw id === 'gone' ? ApiError.fromStatus(404) : new ApiError('network', 'x')
    })
    const unwatch = store.getState().watch()
    await vi.advanceTimersByTimeAsync(3000)
    expect(store.getState().imports.map((i) => i.id)).toEqual(['flaky'])
    expect(store.getState().polling).toBe(true)
    unwatch()
  })

  it('reset stops polling and ignores late responses', async () => {
    const { store } = make()
    let resolve!: (v: unknown) => void
    api.spotifyImports.mockReturnValue(new Promise((r) => (resolve = r)))
    const pending = store.getState().refreshImports()
    store.getState().reset()
    resolve([imp()])
    await pending
    expect(store.getState().imports).toEqual([])
    expect(store.getState().importsLoaded).toBe(false)
  })
})
