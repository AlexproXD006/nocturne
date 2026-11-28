import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/errors'
import type { OfflineManifest, StreamInfo, Track } from '@/api/types'
import { createOfflineStore, DEFAULT_OFFLINE_SETTINGS, type OfflineDeps } from '@/store/offline'
import { memoryKv } from '@/platform/offline/kv'
import { createIdbBackend } from '@/platform/offline/idbBackend'
import { memoryMetaStore } from '@/platform/offline/meta'
import { QuotaError, type NativeOffline, type NativeOfflineEvent, type NativeOfflineState } from '@/platform/offline/types'
import { track } from '../helpers/fixtures'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
async function settle(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) await tick()
}

function fakeFetch(sizes: Record<string, number> = {}): typeof fetch {
  return (async (url: string | URL | Request) => {
    const id = String(url).split('/').pop()!
    const size = sizes[id] ?? 100
    const body = new Uint8Array(size)
    return new Response(body, { status: 200, headers: { 'content-length': String(size), 'content-type': 'audio/mpeg' } })
  }) as unknown as typeof fetch
}

function manifest(t: Track): OfflineManifest {
  return { trackId: t.id, track: t, stream: { url: `https://s/stream/${t.id}`, expiresAt: '2099-01-01T00:00:00Z', mimeType: 'audio/mpeg' }, sizeBytes: 100, art: null, lyrics: { synced: null, plain: 'la la' } }
}

function setup(over: Partial<OfflineDeps> = {}, store: { [k: string]: string } = {}) {
  localStorage.clear()
  for (const [k, v] of Object.entries(store)) localStorage.setItem(k, v)
  let n = 0
  const backend = createIdbBackend({
    audio: memoryKv(),
    fetch: fakeFetch(),
    now: () => ++n,
    createObjectURL: (b) => `blob:${(b as Blob).size}`,
    revokeObjectURL: () => undefined,
    storage: null
  })
  const meta = memoryMetaStore()
  const known = new Map<string, Track>()
  const api = {
    stream: vi.fn(async (id: string): Promise<StreamInfo> => ({ url: `https://s/stream/${id}`, expiresAt: '2099-01-01T00:00:00Z', mimeType: 'audio/mpeg' })),
    offlineManifest: vi.fn(async (id: string) => manifest(known.get(id) ?? track(id))),
    playlist: vi.fn(),
    album: vi.fn(),
    mix: vi.fn()
  }
  const online = { v: true }
  const notify = vi.fn()
  const store$ = createOfflineStore({
    backend,
    native: null,
    meta,
    api: api as never,
    online: () => online.v,
    unmetered: () => true,
    notify,
    ...over
  })
  return { store: store$, backend, meta, api, online, notify, known }
}

beforeEach(() => localStorage.clear())

describe('offline store (renderer queue)', () => {
  it('downloads a playlist, pins its tracks and remembers the collection', async () => {
    const { store, backend, meta } = setup()
    await store.getState().init()
    const tracks = [track('a'), track('b'), track('c')]
    await store.getState().downloadCollection('playlist', 'p1', 'Mi lista', tracks)
    await settle(12)
    const s = store.getState()
    expect(Object.keys(s.available).sort()).toEqual(['a', 'b', 'c'])
    expect(Object.values(s.available).every((k) => k === 'pinned')).toBe(true)
    expect(s.collections['playlist:p1']).toMatchObject({ name: 'Mi lista', trackIds: ['a', 'b', 'c'] })
    expect((await backend.list()).every((a) => a.pinned)).toBe(true)
    expect((await meta.getTrack('a'))?.id).toBe('a')
    expect(await meta.getLyrics('a')).toEqual({ synced: null, plain: 'la la' })
    expect(s.usage.pinnedBytes).toBe(300)
    expect(Object.keys(s.transfers)).toEqual([])
  })

  it('a refreshed app finds its downloads and the collection list again', async () => {
    const a = setup()
    await a.store.getState().init()
    await a.store.getState().downloadCollection('album', 'al1', 'Disco', [track('x')])
    await settle(10)
    const saved = Object.fromEntries(Object.entries(localStorage))
    const b = createOfflineStore({ backend: a.backend, native: null, meta: a.meta, api: a.api as never, online: () => true, unmetered: () => true, notify: vi.fn() })
    expect(b.getState().collections['album:al1']).toBeTruthy()
    expect(Object.keys(saved).length).toBeGreaterThan(0)
    await b.getState().init()
    expect(b.getState().available['x']).toBe('pinned')
    expect(b.getState().tracks['x']?.id).toBe('x')
  })

  it('removing a collection deletes its tracks except those another collection or a single download keeps', async () => {
    const { store } = setup()
    await store.getState().init()
    await store.getState().downloadCollection('playlist', 'p1', 'P1', [track('a'), track('b')])
    await store.getState().downloadCollection('playlist', 'p2', 'P2', [track('b'), track('c')])
    await store.getState().downloadTracks([track('a')])
    await settle(14)
    await store.getState().removeCollection('playlist:p1')
    expect(Object.keys(store.getState().available).sort()).toEqual(['a', 'b', 'c']) // a: single, b: in p2
    await store.getState().removeCollection('playlist:p2')
    expect(Object.keys(store.getState().available).sort()).toEqual(['a'])
  })

  it('syncs a downloaded playlist: new tracks are downloaded, removed ones deleted', async () => {
    const { store, api } = setup()
    await store.getState().init()
    await store.getState().downloadCollection('playlist', 'p1', 'P1', [track('a'), track('b')])
    await settle(10)
    api.playlist.mockResolvedValue({ id: 'p1', name: 'P1 (renombrada)', artwork: [], tracks: [track('b'), track('c')] })
    await store.getState().syncCollections()
    await settle(10)
    const s = store.getState()
    expect(Object.keys(s.available).sort()).toEqual(['b', 'c'])
    expect(s.collections['playlist:p1']).toMatchObject({ name: 'P1 (renombrada)', trackIds: ['b', 'c'] })
  })

  it('does not sync (nor lose anything) while offline or when the network drops mid-sync', async () => {
    const { store, api, online } = setup()
    await store.getState().init()
    await store.getState().downloadCollection('playlist', 'p1', 'P1', [track('a')])
    await settle(8)
    online.v = false
    await store.getState().syncCollections()
    expect(api.playlist).not.toHaveBeenCalled()
    online.v = true
    api.playlist.mockRejectedValue(new ApiError('network', 'down'))
    await store.getState().syncCollections()
    expect(Object.keys(store.getState().available)).toEqual(['a'])
  })

  it('pause / resume / cancel act on the queue', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const slow = (async () => {
      await gate
      return new Response(new Uint8Array(10), { status: 200, headers: { 'content-length': '10' } })
    }) as unknown as typeof fetch
    const backend = createIdbBackend({ audio: memoryKv(), fetch: slow, storage: null, createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined })
    const { store, notify } = setup({ backend })
    void notify
    await store.getState().init()
    await store.getState().downloadTracks([track('a'), track('b'), track('c')])
    await settle(2)
    expect(Object.keys(store.getState().transfers).sort()).toEqual(['a', 'b', 'c'])
    expect(store.getState().transfers['a']?.state).toBe('active')
    expect(store.getState().transfers['c']?.state).toBe('queued')
    store.getState().pause('a')
    expect(store.getState().transfers['a']?.state).toBe('paused')
    store.getState().cancel('b')
    expect(store.getState().transfers['b']).toBeUndefined()
    store.getState().resume('a')
    release()
    await settle(12)
    expect(Object.keys(store.getState().available).sort()).toEqual(['a', 'c'])
  })

  it('refuses downloads over the storage limit', async () => {
    const mb = 1024 * 1024
    const { store, api, notify } = setup({}, { 'nocturne.offline.settings.v1': JSON.stringify({ ...DEFAULT_OFFLINE_SETTINGS, limitGb: 2 }) })
    api.offlineManifest.mockImplementation(async (id: string) => ({ ...manifest(track(id)), sizeBytes: 3000 * mb }))
    await store.getState().init()
    await store.getState().downloadTracks([track('a'), track('b')])
    await settle(20)
    expect(store.getState().limitReached).toBe(true)
    expect(Object.keys(store.getState().available)).toEqual([])
    void notify
  })

  it('a browser quota error degrades quietly (no crash, limit flag set)', async () => {
    const backend = createIdbBackend({ audio: memoryKv(), fetch: fakeFetch(), storage: null })
    vi.spyOn(backend, 'store').mockRejectedValue(new QuotaError())
    const { store } = setup({ backend })
    await store.getState().init()
    await store.getState().downloadTracks([track('a')])
    await settle(10)
    expect(store.getState().limitReached).toBe(true)
    expect(store.getState().transfers['a']?.state).toBe('failed')
  })

  it('plays a stored track from the local copy, unless forced (retry after an error)', async () => {
    const { store } = setup()
    await store.getState().init()
    await store.getState().downloadTracks([track('a')])
    await settle(8)
    const resolve = vi.fn(async (): Promise<StreamInfo> => ({ url: 'https://s/stream/a', expiresAt: '2099-01-01T00:00:00Z' }))
    const local = await store.getState().playbackFor('a', resolve, false)
    expect(local.url).toMatch(/^blob:/)
    expect(resolve).not.toHaveBeenCalled()
    const forced = await store.getState().playbackFor('a', resolve, true)
    expect(forced.url).toBe('https://s/stream/a')
    expect((await store.getState().playbackFor('zzz', resolve, false)).url).toBe('https://s/stream/a')
  })

  it('caches what plays automatically and keeps the 30 most recent, never touching downloads', async () => {
    vi.useFakeTimers()
    try {
      const { store, backend } = setup()
      await store.getState().init()
      store.getState().update({ cache: { mode: 'tracks', tracks: 30, gb: 1 } })
      await store.getState().downloadTracks([track('dl')])
      await vi.advanceTimersByTimeAsync(50)
      for (let i = 0; i < 33; i++) {
        store.getState().onPlay(track(`p${i}`))
        await vi.advanceTimersByTimeAsync(4100)
      }
      await vi.advanceTimersByTimeAsync(500)
      const ids = (await backend.list()).map((a) => a.id)
      expect(ids).toContain('dl')
      const auto = ids.filter((i) => i !== 'dl')
      expect(auto).toHaveLength(30)
      expect(auto).not.toContain('p0')
      expect(auto).toContain('p32')
      expect(store.getState().available['dl']).toBe('pinned')
      expect(store.getState().available['p32']).toBe('auto')
    } finally {
      vi.useRealTimers()
    }
  })

  it('"Vaciar caché" removes automatic tracks only', async () => {
    vi.useFakeTimers()
    try {
      const { store } = setup()
      await store.getState().init()
      await store.getState().downloadTracks([track('dl')])
      await vi.advanceTimersByTimeAsync(50)
      store.getState().onPlay(track('auto1'))
      await vi.advanceTimersByTimeAsync(4500)
      expect(store.getState().available['auto1']).toBe('auto')
      await store.getState().clearCache()
      expect(Object.keys(store.getState().available)).toEqual(['dl'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('removeAll wipes downloads and metadata', async () => {
    const { store, meta } = setup()
    await store.getState().init()
    await store.getState().downloadCollection('album', 'x', 'X', [track('a')])
    await settle(8)
    await store.getState().removeAll()
    expect(store.getState().available).toEqual({})
    expect(store.getState().collections).toEqual({})
    expect(await meta.allTracks()).toEqual([])
  })
})

describe('offline store (Android native downloads)', () => {
  function nativeSetup() {
    const listeners = new Set<(e: NativeOfflineEvent) => void>()
    const st: NativeOfflineState = { downloads: [], autoBytes: 0, pinnedBytes: 0, autoTracks: 0, limitBytes: 0, paused: false }
    const native: NativeOffline = {
      configure: vi.fn(async () => undefined),
      download: vi.fn(async (t: Track[]) => {
        st.downloads = t.map((x) => ({ id: x.id, state: 'downloading' as const, percent: 10, bytes: 1, total: 10 }))
        return { accepted: t.length, rejected: 0 }
      }),
      pause: vi.fn(async () => undefined),
      resume: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      removeAll: vi.fn(async () => undefined),
      clearCache: vi.fn(async () => undefined),
      state: vi.fn(async () => ({ ...st, downloads: [...st.downloads] })),
      availability: vi.fn(async (ids: string[]) => ({ available: ids.filter((i: string) => i === 'played'), pinned: [] })),
      network: vi.fn(async () => ({ online: true, unmetered: true })),
      on: (l) => {
        listeners.add(l)
        return () => listeners.delete(l)
      }
    }
    const s = setup({ native, backend: null })
    return { ...s, native, st, emit: (e: NativeOfflineEvent) => listeners.forEach((l) => l(e)) }
  }

  it('hands downloads to the native manager and mirrors its progress events', async () => {
    const { store, native, st, emit } = nativeSetup()
    await store.getState().init()
    expect(native.configure).toHaveBeenCalledWith(expect.objectContaining({ autoTracks: 30, wifiOnly: true }))
    await store.getState().downloadCollection('playlist', 'p', 'P', [track('a'), track('b')])
    expect(native.download).toHaveBeenCalled()
    expect(store.getState().transfers['a']).toMatchObject({ state: 'active', percent: 10 })
    st.downloads = [{ id: 'a', state: 'done', percent: 100, bytes: 10, total: 10 }, { id: 'b', state: 'paused', percent: 50, bytes: 5, total: 10 }]
    emit({ type: 'downloads', state: { ...st, pinnedBytes: 10 } })
    expect(store.getState().available['a']).toBe('pinned')
    expect(store.getState().transfers['b']?.state).toBe('paused')
    store.getState().pause('b')
    store.getState().resume('b')
    store.getState().cancel('b')
    expect(native.pause).toHaveBeenCalledWith('b')
    expect(native.resume).toHaveBeenCalledWith('b')
    expect(native.cancel).toHaveBeenCalledWith(['b'])
  })

  it('learns that a track it plays is now cached', async () => {
    const { store } = nativeSetup()
    await store.getState().init()
    store.getState().onPlay(track('played'))
    await settle(4)
    expect(store.getState().available['played']).toBe('auto')
  })

  it('pushes the new cache budget to Android when settings change', async () => {
    const { store, native } = nativeSetup()
    await store.getState().init()
    store.getState().update({ cache: { mode: 'bytes', tracks: 30, gb: 2 }, downloadsWifiOnly: false })
    expect(native.configure).toHaveBeenLastCalledWith(expect.objectContaining({ autoBytes: 2 * 1024 ** 3, wifiOnly: false }))
  })
})
