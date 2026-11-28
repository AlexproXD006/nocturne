import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/errors'
import type { OfflineManifest, StreamInfo, Track } from '@/api/types'
import { createIdbBackend } from '@/platform/offline/idbBackend'
import { memoryKv } from '@/platform/offline/kv'
import { memoryMetaStore } from '@/platform/offline/meta'
import type { NativeOffline, NativeOfflineState, OfflineBackend } from '@/platform/offline/types'
import { createOfflineStore, DEFAULT_OFFLINE_SETTINGS, sanitizeOfflineSettings, type OfflineDeps } from '@/store/offline'
import { track } from '../helpers/fixtures'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const settle = async (n = 10): Promise<void> => {
  for (let i = 0; i < n; i++) await tick()
}
const resp = (n = 20): Response => new Response(new Uint8Array(n), { status: 200, headers: { 'content-length': String(n), 'content-type': 'audio/mpeg' } })
const stream = (id: string): StreamInfo => ({ url: `https://s/${id}`, expiresAt: '2099-01-01T00:00:00Z', mimeType: 'audio/mpeg' })

function mk(over: Partial<OfflineDeps> = {}, unmetered: { v: boolean | null } = { v: true }) {
  localStorage.clear()
  const meta = memoryMetaStore()
  const backend = createIdbBackend({ audio: memoryKv(), fetch: (async () => resp()) as never, storage: null, createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined })
  const api = {
    stream: vi.fn(async (id: string) => stream(id)),
    offlineManifest: vi.fn(async (id: string): Promise<OfflineManifest> => ({ trackId: id, track: track(id), stream: stream(id), sizeBytes: 20, art: { url: `https://s/art/${id}`, size: 512 }, lyrics: { synced: null, plain: 'x' } })),
    playlist: vi.fn(),
    album: vi.fn(),
    mix: vi.fn()
  }
  const notify = vi.fn()
  const online = { v: true }
  const store = createOfflineStore({
    backend,
    native: null,
    meta,
    api: api as never,
    online: () => online.v,
    unmetered: () => unmetered.v,
    notify,
    fetchBlob: async () => new Blob(['img']),
    createObjectURL: () => 'blob:art',
    ...over
  })
  return { store, backend, meta, api, notify, online, unmetered }
}

beforeEach(() => localStorage.clear())

describe('settings', () => {
  it('sanitizes and persists', () => {
    expect(sanitizeOfflineSettings({ quality: 'compressed', limitGb: 7, downloadsWifiOnly: false })).toMatchObject({ quality: 'compressed', limitGb: 0, downloadsWifiOnly: false })
    expect(sanitizeOfflineSettings(undefined)).toEqual(DEFAULT_OFFLINE_SETTINGS)
    const { store } = mk()
    store.getState().update({ limitGb: 5, prefetchWifiOnly: false })
    expect(JSON.parse(localStorage.getItem('nocturne.offline.settings.v1')!)).toMatchObject({ limitGb: 5, prefetchWifiOnly: false })
  })

  it('lowering the cache size evicts the oldest auto tracks right away', async () => {
    const { store, backend } = mk()
    await store.getState().init()
    for (let i = 0; i < 40; i++) await backend.store(`p${i}`, 'u', { pinned: false, onProgress: () => undefined, signal: new AbortController().signal })
    await store.getState().refreshAvailability()
    expect(Object.keys(store.getState().available)).toHaveLength(40)
    store.getState().update({ cache: { mode: 'tracks', tracks: 30, gb: 1 } })
    await settle()
    expect(Object.keys(store.getState().available)).toHaveLength(30)
  })
})

describe('downloads', () => {
  it('uses the stream endpoint on an older server without the manifest, and fails a job on a network error', async () => {
    const { store, api } = mk()
    api.offlineManifest.mockRejectedValueOnce(new ApiError('not_found', 'x', 404))
    await store.getState().init()
    await store.getState().downloadTracks([track('a')])
    await settle()
    expect(api.stream).toHaveBeenCalled()
    expect(store.getState().available['a']).toBe('pinned')
  })

  it('stores cover and lyrics for offline display and serves them back', async () => {
    const { store, meta } = mk()
    await store.getState().init()
    await store.getState().downloadTracks([track('a')])
    await settle()
    expect(await meta.getArt('a')).toBeInstanceOf(Blob)
    expect(await store.getState().artFor('a')).toBe('blob:art')
    expect(await store.getState().artFor('a')).toBe('blob:art') // cached
    expect(await store.getState().artFor('nope')).toBeNull()
    expect(await store.getState().lyricsFor('a')).toEqual({ synced: null, plain: 'x' })
  })

  it('removeTrack keeps a track a downloaded collection still wants; removeTrack on a single deletes it', async () => {
    const { store } = mk()
    await store.getState().init()
    await store.getState().downloadCollection('playlist', 'p', 'P', [track('a')])
    await store.getState().downloadTracks([track('a'), track('b')])
    await settle()
    await store.getState().removeTrack('a')
    expect(store.getState().available['a']).toBe('pinned')
    await store.getState().removeTrack('b')
    expect(store.getState().available['b']).toBeUndefined()
    expect(store.getState().singles).toEqual([])
    await store.getState().removeCollection('playlist:unknown') // no-op
  })

  it('pins an auto-cached track instead of downloading it again', async () => {
    const { store, backend } = mk()
    await store.getState().init()
    await backend.store('a', 'u', { pinned: false, onProgress: () => undefined, signal: new AbortController().signal })
    await store.getState().refreshAvailability()
    expect(store.getState().available['a']).toBe('auto')
    await store.getState().downloadTracks([track('a')])
    expect(store.getState().available['a']).toBe('pinned')
  })

  it('waits for Wi-Fi: downloads pause on a metered network and resume when it is unmetered', async () => {
    const un = { v: false as boolean | null }
    const { store } = mk({}, un)
    await store.getState().init()
    await store.getState().downloadTracks([track('a')])
    expect(store.getState().transfers['a']?.state).toBe('queued') // held back: waiting for Wi-Fi
    expect(store.getState().paused).toBe(true)
    un.v = true
    store.getState().update({})
    await settle()
    expect(store.getState().available['a']).toBe('pinned')
    // Wi-Fi only off: a metered network does not block
    un.v = false
    store.getState().update({ downloadsWifiOnly: false })
    await store.getState().downloadTracks([track('b')])
    await settle()
    expect(store.getState().available['b']).toBe('pinned')
  })

  it('pause-all / resume-all', async () => {
    const hang = createIdbBackend({ audio: memoryKv(), fetch: (() => new Promise(() => undefined)) as never, storage: null })
    const { store } = mk({ backend: hang })
    await store.getState().init()
    await store.getState().downloadTracks([track('a'), track('b')])
    await settle(3)
    store.getState().pause()
    expect(store.getState().paused).toBe(true)
    store.getState().resume()
    expect(store.getState().paused).toBe(false)
  })

  it('resumes a persisted queue on the next start', async () => {
    const { store, meta, backend } = mk()
    await meta.putTrack(track('q1'))
    await meta.putTrack(track('q2'))
    localStorage.setItem('nocturne.offline.queue.v1', JSON.stringify([{ id: 'q1', paused: false }, { id: 'q2', paused: true }]))
    await store.getState().init()
    await settle()
    expect(store.getState().available['q1']).toBe('pinned')
    expect(store.getState().transfers['q2']?.state).toBe('paused')
    expect((await backend.list()).map((a) => a.id)).toEqual(['q1'])
  })

  it('tells the user when there is no storage at all', async () => {
    const { store, notify } = mk({ backend: null })
    await store.getState().init()
    await store.getState().downloadTracks([track('a')])
    expect(notify).toHaveBeenCalled()
  })

  it('forgets metadata of tracks that left the automatic cache when the app starts', async () => {
    const { store, meta } = mk()
    await meta.putTrack(track('ghost'))
    await store.getState().init()
    expect(await meta.getTrack('ghost')).toBeUndefined()
  })
})

describe('sync of other kinds', () => {
  it('syncs albums and mixes, and keeps the copy when the playlist was deleted on the server', async () => {
    const { store, api } = mk()
    await store.getState().init()
    await store.getState().downloadCollection('album', 'al', 'Disco', [track('a')])
    await store.getState().downloadCollection('mix', 'daily-1', 'Mix', [track('m')])
    await store.getState().downloadCollection('playlist', 'gone', 'Gone', [track('g')])
    await settle(14)
    api.album.mockResolvedValue({ id: 'al', title: 'Disco 2', artists: [], artwork: [], tracks: [track('a'), track('a2')] })
    api.mix.mockResolvedValue({ id: 'daily-1', name: 'Mix', artwork: [], tracks: [track('m')] })
    api.playlist.mockRejectedValue(new ApiError('not_found', 'x', 404))
    await store.getState().syncCollections()
    await settle(10)
    expect(store.getState().collections['album:al']).toMatchObject({ name: 'Disco 2', trackIds: ['a', 'a2'] })
    expect(store.getState().available['a2']).toBe('pinned')
    expect(store.getState().available['g']).toBe('pinned')
  })
})

describe('playback urls', () => {
  it('desktop: unstored tracks stream through the tee, stored ones play locally', async () => {
    const backend: OfflineBackend = {
      kind: 'desktop',
      init: async () => undefined,
      list: async () => [{ id: 'z', bytes: 5, pinned: false, lastPlayed: 1 }],
      playbackUrl: async (id) => `nocturne-offline://audio/${id}`,
      store: async () => 0,
      setPinned: async () => undefined,
      touch: async () => undefined,
      remove: async () => undefined,
      clearAuto: async () => [],
      applyPolicy: async () => [],
      onCached: () => () => undefined,
      teeUrl: (id, u) => `nocturne-stream://audio?id=${id}&u=${encodeURIComponent(u)}`
    }
    const { store } = mk({ backend })
    await store.getState().init()
    const resolve = async (): Promise<StreamInfo> => stream('y')
    expect((await store.getState().playbackFor('y', resolve, false)).url).toMatch(/^nocturne-stream:\/\//)
    expect((await store.getState().playbackFor('y', resolve, true)).url).toBe('https://s/y')
    expect((await store.getState().playbackFor('z', resolve, false)).url).toBe('nocturne-offline://audio/z')
    store.getState().onPlay(track('z')) // touches
    store.getState().onPlay(track('y')) // tee path: extras only
    await settle()
  })
})

describe('native extras', () => {
  function nativeStore(over: Partial<NativeOffline> = {}) {
    const st: NativeOfflineState = { downloads: [{ id: 'd1', state: 'done', percent: 100, bytes: 5, total: 5 }], autoBytes: 3, pinnedBytes: 5, autoTracks: 1, limitBytes: 0, paused: false }
    const native: NativeOffline = {
      configure: vi.fn(async () => undefined),
      download: vi.fn(async () => ({ accepted: 0, rejected: 1 })),
      pause: vi.fn(async () => undefined),
      resume: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      removeAll: vi.fn(async () => undefined),
      clearCache: vi.fn(async () => undefined),
      state: vi.fn(async () => st),
      availability: vi.fn(async () => ({ available: [], pinned: [] })),
      network: vi.fn(async () => ({ online: true, unmetered: true })),
      on: () => () => undefined,
      ...over
    }
    return { ...mk({ native, backend: null }), native, st }
  }

  it('reports a refused download (storage limit) and clears everything on removeAll / clearCache', async () => {
    const { store, native, notify } = nativeStore()
    await store.getState().init()
    expect(store.getState().available['d1']).toBe('pinned')
    await store.getState().downloadTracks([track('n1')])
    expect(store.getState().limitReached).toBe(true)
    expect(notify).toHaveBeenCalled()
    store.getState().pause()
    store.getState().resume()
    await store.getState().clearCache()
    expect(native.clearCache).toHaveBeenCalled()
    expect(store.getState().available['d1']).toBe('pinned')
    await store.getState().removeAll()
    expect(native.removeAll).toHaveBeenCalled()
  })

  it('removing a collection cancels its tracks natively', async () => {
    const { store, native } = nativeStore({ download: vi.fn(async (t) => ({ accepted: t.length, rejected: 0 })) })
    await store.getState().init()
    await store.getState().downloadCollection('playlist', 'p', 'P', [track('a'), track('b')])
    await store.getState().removeCollection('playlist:p')
    expect(native.cancel).toHaveBeenCalledWith(['a', 'b'])
  })
})
