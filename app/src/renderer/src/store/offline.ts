import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { ApiClient } from '../api/client'
import type { StreamInfo, Track } from '../api/types'
import { t } from '../i18n'
import { readJson, writeJson } from '../lib/storage'
import { DEFAULT_CACHE, GB, budgetBytes, sanitizeCache, type CacheSettings } from '../lib/offline/policy'
import { DownloadQueue, type Job } from '../lib/offline/queue'
import { collectionKey, diffCollection, idsKeptBy, type CollectionKind, type DownloadedCollection } from '../lib/offline/sync'
import type { MetaStore, NativeOffline, NativeOfflineState, OfflineBackend } from '../platform/offline/types'
import { QuotaError } from '../platform/offline/types'
import { isNetworkFailure } from '../lib/offline/connectivity'

export type DownloadQuality = 'original' | 'compressed'

export interface OfflineSettings {
  /** Automatic cache of the last played tracks (30 by default; or a size budget). */
  cache: CacheSettings
  /** "Solo con Wi-Fi" for prefetching / caching what plays. */
  prefetchWifiOnly: boolean
  /** Downloads only over Wi-Fi (default on). */
  downloadsWifiOnly: boolean
  quality: DownloadQuality
  /** Downloads storage limit in GB; 0 = no limit. */
  limitGb: number
}

export const DEFAULT_OFFLINE_SETTINGS: OfflineSettings = {
  cache: DEFAULT_CACHE,
  prefetchWifiOnly: true,
  downloadsWifiOnly: true,
  quality: 'original',
  limitGb: 0
}

export const LIMIT_GB_CHOICES = [0, 2, 5, 10, 20] as const

export function sanitizeOfflineSettings(raw: unknown): OfflineSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof OfflineSettings, unknown>>
  const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)
  return {
    cache: sanitizeCache(r.cache),
    prefetchWifiOnly: bool(r.prefetchWifiOnly, DEFAULT_OFFLINE_SETTINGS.prefetchWifiOnly),
    downloadsWifiOnly: bool(r.downloadsWifiOnly, DEFAULT_OFFLINE_SETTINGS.downloadsWifiOnly),
    quality: r.quality === 'compressed' ? 'compressed' : 'original',
    limitGb: (LIMIT_GB_CHOICES as readonly number[]).includes(r.limitGb as number) ? (r.limitGb as number) : 0
  }
}

export type TransferState = 'queued' | 'active' | 'paused' | 'failed'

export interface Transfer {
  state: TransferState
  bytes: number
  total: number
  /** 0..100, -1 while unknown. */
  percent: number
}

export interface OfflineUsage {
  autoBytes: number
  pinnedBytes: number
  autoTracks: number
  /** Browser storage quota (web/iOS), when known. */
  quota: number
}

interface Persisted {
  collections: Record<string, DownloadedCollection>
  singles: string[]
}

export interface OfflineState {
  ready: boolean
  settings: OfflineSettings
  /** Tracks that play with no network: 'pinned' = downloaded, 'auto' = in the automatic cache. */
  available: Record<string, 'pinned' | 'auto'>
  transfers: Record<string, Transfer>
  collections: Record<string, DownloadedCollection>
  singles: string[]
  /** Metadata of downloaded tracks (kept locally, so the Downloads screen works with no network). */
  tracks: Record<string, Track>
  usage: OfflineUsage
  paused: boolean
  /** True after a download was refused because the storage limit is reached. */
  limitReached: boolean

  init(): Promise<void>
  update(patch: Partial<OfflineSettings>): void
  downloadTracks(tracks: Track[]): Promise<void>
  downloadCollection(kind: CollectionKind, id: string, name: string, tracks: Track[]): Promise<void>
  removeCollection(key: string): Promise<void>
  removeTrack(id: string): Promise<void>
  /** Deletes stored tracks (downloads) by id. */
  removeTrackIds(ids: string[]): Promise<void>
  removeAll(): Promise<void>
  clearCache(): Promise<void>
  pause(id?: string): void
  resume(id?: string): void
  cancel(id: string): void
  syncCollections(): Promise<void>
  refreshAvailability(): Promise<void>
  /** A track started playing: becomes the most recent cached track; caches it (and its extras) when needed. */
  onPlay(track: Track): void
  /** URL to play: the stored copy when there is one, else the streaming URL (through the tee on desktop). */
  playbackFor(trackId: string, resolve: () => Promise<StreamInfo>, force: boolean): Promise<StreamInfo>
  isAvailable(id: string): boolean
  /** Cached cover / lyrics for offline display. */
  lyricsFor(id: string): ReturnType<MetaStore['getLyrics']>
  artFor(id: string): Promise<string | null>
}

export interface OfflineDeps {
  backend: OfflineBackend | null
  native: NativeOffline | null
  meta: MetaStore | null
  api: Pick<ApiClient, 'stream' | 'offlineManifest' | 'playlist' | 'album' | 'mix'>
  online(): boolean
  /** Wi-Fi / unmetered; null when unknown (treated as allowed). */
  unmetered(): boolean | null
  notify(message: string, tone?: 'info' | 'error'): void
  fetchBlob?(url: string, signal?: AbortSignal): Promise<Blob>
  now?: () => number
  createObjectURL?: (b: Blob) => string
  concurrency?: number
  storageKey?: { settings: string; collections: string; queue: string }
}

const KEYS = { settings: 'nocturne.offline.settings.v1', collections: 'nocturne.offline.collections.v1', queue: 'nocturne.offline.queue.v1' }
/** Playback URLs of stored tracks are cheap; keep the player store from caching one for long. */
const LOCAL_URL_TTL_MS = 10 * 60_000
const AUTO_CACHE_DELAY_MS = 4000

const isPersisted = (v: unknown): v is Persisted => Boolean(v) && typeof v === 'object' && typeof (v as Persisted).collections === 'object' && Array.isArray((v as Persisted).singles)
const isQueue = (v: unknown): v is { id: string; paused: boolean }[] => Array.isArray(v) && v.every((e) => e && typeof e.id === 'string')

function transferOf(j: Job): Transfer {
  const state = j.state === 'active' ? 'active' : j.state === 'paused' ? 'paused' : j.state === 'failed' ? 'failed' : 'queued'
  return { state, bytes: j.bytes, total: j.total, percent: j.total > 0 ? Math.min(100, Math.round((j.bytes / j.total) * 100)) : -1 }
}

export function createOfflineStore(deps: OfflineDeps): UseBoundStore<StoreApi<OfflineState>> {
  const keys = deps.storageKey ?? KEYS
  const now = deps.now ?? Date.now
  const { backend, native, meta } = deps
  const saved = readJson<Persisted>(keys.collections, { collections: {}, singles: [] }, isPersisted)
  const fetchBlob =
    deps.fetchBlob ??
    (async (url: string, signal?: AbortSignal): Promise<Blob> => {
      const res = await fetch(url, { signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.blob()
    })
  const makeUrl = deps.createObjectURL ?? ((b: Blob) => URL.createObjectURL(b))
  const artUrls = new Map<string, string>()
  /** Tracks being queued by the renderer (the queue only carries ids). */
  const jobTracks = new Map<string, Track>()
  let gated = false // the queue is paused only because the network is metered
  let autoCaching: string | null = null
  let autoTimer: ReturnType<typeof setTimeout> | null = null

  const store: UseBoundStore<StoreApi<OfflineState>> = create<OfflineState>((set, get) => {
    const persistCollections = (): void => writeJson(keys.collections, { collections: get().collections, singles: get().singles })
    const markAvailable = (id: string, kind: 'pinned' | 'auto'): void => set((s) => ({ available: { ...s.available, [id]: kind } }))
    const unmark = (ids: readonly string[]): void =>
      set((s) => {
        const a = { ...s.available }
        for (const id of ids) delete a[id]
        return { available: a }
      })
    const setTransfers = (jobs: Job[]): void => {
      const transfers: Record<string, Transfer> = {}
      for (const j of jobs) if (j.state !== 'done') transfers[j.id] = transferOf(j)
      set({ transfers })
    }
    const limitBytes = (): number => get().settings.limitGb * GB
    const pinnedIds = (): Set<string> => new Set([...get().singles, ...Object.values(get().collections).flatMap((c) => c.trackIds)])

    async function putExtras(track: Track, manifestLyrics?: unknown, artUrl?: string | null): Promise<void> {
      if (!meta) return
      try {
        await meta.putTrack(track)
        if (manifestLyrics) await meta.putLyrics(track.id, manifestLyrics as never)
        if (artUrl) await meta.putArt(track.id, await fetchBlob(artUrl))
      } catch {
        /* extras are best effort */
      }
    }

    const extrasDone = new Set<string>()
    /** Cover + lyrics + metadata of a track that plays offline later (one manifest request). */
    async function cacheExtras(track: Track): Promise<void> {
      if (!meta || extrasDone.has(track.id) || !deps.online()) return
      extrasDone.add(track.id)
      try {
        if ((await meta.getLyrics(track.id)) || (await meta.getArt(track.id))) return
        const m = await deps.api.offlineManifest(track.id)
        await putExtras(m.track ?? track, m.lyrics, m.art?.url ?? null)
        set((s) => ({ tracks: { ...s.tracks, [track.id]: m.track ?? track } }))
      } catch {
        extrasDone.delete(track.id)
      }
    }

    /** Stores one track for a download (renderer queue). */
    async function runJob(id: string, ctl: { signal: AbortSignal; progress(b: number, t: number): void }): Promise<void> {
      if (!backend) throw new Error('no storage')
      let track = jobTracks.get(id) ?? (await meta?.getTrack(id))
      let stream: StreamInfo
      let lyrics: unknown
      let art: string | null = null
      let size: number | null = null
      try {
        const m = await deps.api.offlineManifest(id, ctl.signal)
        track = m.track ?? track
        stream = m.stream
        lyrics = m.lyrics
        art = m.art?.url ?? null
        size = m.sizeBytes
      } catch (err) {
        if (isNetworkFailure(err) || ctl.signal.aborted) throw err
        stream = await deps.api.stream(id, ctl.signal) // an older server without the manifest
      }
      const limit = limitBytes()
      if (limit > 0 && size && get().usage.pinnedBytes + size > limit) {
        set({ limitReached: true })
        throw new Error(t('offline.limitReached'))
      }
      try {
        await backend.store(id, stream.url, { pinned: true, mime: stream.mimeType, onProgress: ctl.progress, signal: ctl.signal })
      } catch (err) {
        if (err instanceof QuotaError) {
          set({ limitReached: true })
          throw new Error(t('offline.quota'))
        }
        throw err
      }
      if (ctl.signal.aborted) {
        // Cancelled / paused while the last bytes arrived: do not keep a copy nobody asked for any more.
        await backend.remove([id]).catch(() => undefined)
        throw new DOMException('aborted', 'AbortError')
      }
      if (track) await putExtras(track, lyrics, art)
      markAvailable(id, 'pinned')
      if (track) set((s) => ({ tracks: { ...s.tracks, [id]: track } }))
      await refreshUsage()
    }

    const queue = new DownloadQueue({
      concurrency: deps.concurrency ?? 2,
      retries: 1,
      run: runJob,
      persist: (pending) => writeJson(keys.queue, pending)
    })
    queue.subscribe(() => {
      setTransfers(queue.list())
      set({ paused: queue.paused })
      for (const j of queue.list()) {
        if (j.state === 'done') queue.cancel(j.id)
      }
    })

    async function refreshUsage(): Promise<void> {
      if (native) {
        const st = await native.state()
        applyNative(st)
        return
      }
      if (!backend) return
      const list = await backend.list()
      let autoBytes = 0
      let pinnedBytes = 0
      let autoTracks = 0
      const available: OfflineState['available'] = {}
      for (const a of list) {
        available[a.id] = a.pinned ? 'pinned' : 'auto'
        if (a.pinned) pinnedBytes += a.bytes
        else {
          autoBytes += a.bytes
          autoTracks++
        }
      }
      const est = (await backend.estimate?.().catch(() => null)) ?? null
      set({ available, usage: { autoBytes, pinnedBytes, autoTracks, quota: est?.quota ?? 0 } })
    }

    function applyNative(st: NativeOfflineState): void {
      const transfers: Record<string, Transfer> = {}
      const available: OfflineState['available'] = {}
      for (const d of st.downloads) {
        if (d.state === 'done') available[d.id] = 'pinned'
        else if (d.state !== 'removing') {
          transfers[d.id] = {
            state: d.state === 'downloading' ? 'active' : d.state === 'paused' ? 'paused' : d.state === 'failed' ? 'failed' : 'queued',
            bytes: d.bytes,
            total: d.total,
            percent: d.percent
          }
        }
      }
      // Auto-cached ids are asked for lazily (see refreshAvailability); keep what we already know.
      const prev = get().available
      for (const [id, kind] of Object.entries(prev)) if (kind === 'auto' && !(id in available)) available[id] = 'auto'
      set({
        transfers,
        available,
        paused: st.paused,
        usage: { autoBytes: st.autoBytes, pinnedBytes: st.pinnedBytes, autoTracks: st.autoTracks, quota: 0 }
      })
    }

    function pushNativeConfig(): void {
      const s = get().settings
      void native?.configure({
        autoTracks: s.cache.tracks,
        autoBytes: budgetBytes(s.cache),
        wifiOnly: s.downloadsWifiOnly,
        prefetchWifiOnly: s.prefetchWifiOnly,
        limitBytes: limitBytes()
      })
    }

    function networkGate(): void {
      if (native || !backend) return
      const s = get().settings
      const blocked = s.downloadsWifiOnly && deps.unmetered() === false
      if (blocked && !queue.paused) {
        gated = true
        queue.pause()
      } else if (!blocked && gated) {
        gated = false
        queue.resume()
      }
    }

    async function enqueue(tracks: Track[]): Promise<void> {
      const fresh = tracks.filter((tr) => get().available[tr.id] !== 'pinned' && !get().transfers[tr.id])
      for (const tr of fresh) {
        jobTracks.set(tr.id, tr)
        set((s) => ({ tracks: { ...s.tracks, [tr.id]: tr } }))
        void meta?.putTrack(tr).catch(() => undefined)
      }
      // Tracks that are only in the automatic cache become pinned right away.
      for (const tr of tracks) {
        if (get().available[tr.id] === 'auto') {
          await backend?.setPinned(tr.id, true)
          markAvailable(tr.id, 'pinned')
        }
      }
      if (fresh.length === 0) return
      if (native) {
        const r = await native.download(fresh)
        if (r.rejected > 0) {
          set({ limitReached: true })
          deps.notify(t('offline.limitReached'), 'error')
        }
        applyNative(await native.state())
        for (const tr of fresh) void cacheExtras(tr)
        return
      }
      if (!backend) {
        deps.notify(t('offline.unsupported'), 'error')
        return
      }
      queue.add(fresh.map((x) => x.id))
      networkGate()
    }

    return {
      ready: false,
      settings: sanitizeOfflineSettings(readJson<unknown>(keys.settings, {})),
      available: {},
      transfers: {},
      collections: saved.collections,
      singles: saved.singles,
      tracks: {},
      usage: { autoBytes: 0, pinnedBytes: 0, autoTracks: 0, quota: 0 },
      paused: false,
      limitReached: false,

      async init() {
        if (get().ready) return
        set({ ready: true })
        try {
          if (native) {
            pushNativeConfig()
            native.on((e) => {
              if (e.type === 'downloads') applyNative(e.state)
            })
          } else if (backend) {
            await backend.init()
            await backend.applyPolicy(get().settings.cache)
            backend.onCached?.((id) => {
              void refreshUsage()
            })
          }
          await refreshUsage()
          // Metadata for the Downloads screen (works offline).
          if (meta) {
            const all = await meta.allTracks().catch(() => [] as Track[])
            const keep = pinnedIds()
            const tracks: Record<string, Track> = {}
            for (const tr of all) {
              if (keep.has(tr.id) || get().available[tr.id]) tracks[tr.id] = tr
              else void meta.deleteTrack(tr.id).catch(() => undefined) // evicted from the automatic cache
            }
            set({ tracks })
          }
          // Resume what a previous run left in the queue.
          if (!native && backend) {
            const pending = readJson<{ id: string; paused: boolean }[]>(keys.queue, [], isQueue)
            const ids = pending.filter((p) => get().available[p.id] !== 'pinned')
            for (const p of ids) {
              const tr = await meta?.getTrack(p.id)
              if (tr) jobTracks.set(p.id, tr)
            }
            queue.add(ids.filter((p) => !p.paused).map((p) => p.id))
            queue.add(ids.filter((p) => p.paused).map((p) => p.id), { paused: true })
            networkGate()
          }
        } catch {
          /* storage unavailable: the offline features simply stay empty */
        }
      },

      update(patch) {
        const settings = sanitizeOfflineSettings({ ...get().settings, ...patch })
        set({ settings, limitReached: false })
        writeJson(keys.settings, settings)
        if (native) pushNativeConfig()
        else if (backend) void backend.applyPolicy(settings.cache).then((gone) => { if (gone.length) { unmark(gone); void refreshUsage() } }).catch(() => undefined)
        networkGate()
      },

      async downloadTracks(tracks) {
        const unique = [...new Map(tracks.map((x) => [x.id, x])).values()]
        set((s) => ({ singles: [...new Set([...s.singles, ...unique.map((x) => x.id)])] }))
        persistCollections()
        await enqueue(unique)
      },

      async downloadCollection(kind, id, name, tracks) {
        const key = collectionKey(kind, id)
        const col: DownloadedCollection = { key, kind, id, name, trackIds: tracks.map((x) => x.id), syncedAt: now() }
        set((s) => ({ collections: { ...s.collections, [key]: col } }))
        persistCollections()
        await enqueue(tracks)
      },

      async removeCollection(key) {
        const col = get().collections[key]
        if (!col) return
        const collections = { ...get().collections }
        delete collections[key]
        set({ collections })
        persistCollections()
        const keep = idsKeptBy(collections, get().singles)
        await get().removeTrackIds(col.trackIds.filter((id) => !keep.has(id)))
      },

      async removeTrack(id) {
        set((s) => ({ singles: s.singles.filter((x) => x !== id) }))
        persistCollections()
        if (idsKeptBy(get().collections, []).has(id)) return // a downloaded playlist still wants it
        await get().removeTrackIds([id])
      },

      async removeAll() {
        queue.cancelAll()
        set({ collections: {}, singles: [] })
        persistCollections()
        if (native) {
          await native.removeAll()
          applyNative(await native.state())
        } else if (backend) {
          const pinned = Object.entries(get().available).filter(([, k]) => k === 'pinned').map(([id]) => id)
          await backend.remove(pinned)
          unmark(pinned)
          await refreshUsage()
        }
        set({ tracks: {}, limitReached: false })
        await meta?.clearAll().catch(() => undefined)
      },

      async clearCache() {
        if (native) {
          await native.clearCache()
          const st = await native.state()
          applyNative(st)
          // Forget what the cache held.
          set((s) => ({ available: Object.fromEntries(Object.entries(s.available).filter(([, k]) => k === 'pinned')) }))
        } else if (backend) {
          const gone = await backend.clearAuto()
          unmark(gone)
          await refreshUsage()
        }
        const keep = pinnedIds()
        for (const tr of Object.values(get().tracks)) if (!keep.has(tr.id)) void meta?.deleteTrack(tr.id)
      },

      pause(id) {
        if (native) {
          if (id) void native.pause(id)
          else for (const tid of Object.keys(get().transfers)) void native.pause(tid)
          return
        }
        gated = false
        queue.pause(id)
      },

      resume(id) {
        if (native) {
          if (id) void native.resume(id)
          else for (const tid of Object.keys(get().transfers)) void native.resume(tid)
          return
        }
        gated = false
        queue.resume(id)
        networkGate()
      },

      cancel(id) {
        if (native) {
          void native.cancel([id])
          return
        }
        queue.cancel(id)
      },

      async syncCollections() {
        if (!deps.online()) return
        const cols = Object.values(get().collections)
        for (const col of cols) {
          try {
            const remote =
              col.kind === 'playlist' ? await deps.api.playlist(col.id) : col.kind === 'album' ? await deps.api.album(col.id) : await deps.api.mix(col.id)
            const tracks = remote.tracks as Track[]
            const name = 'name' in remote ? remote.name : (remote as { title: string }).title
            const keep = idsKeptBy(get().collections, get().singles, col.key)
            const diff = diffCollection(col.trackIds, tracks.map((x) => x.id), keep)
            const next: DownloadedCollection = { ...col, name, trackIds: tracks.map((x) => x.id), syncedAt: now() }
            set((s) => ({ collections: { ...s.collections, [col.key]: next } }))
            persistCollections()
            if (diff.add.length) await enqueue(tracks.filter((x) => diff.add.includes(x.id)))
            if (diff.remove.length) await get().removeTrackIds(diff.remove)
          } catch (err) {
            if (isNetworkFailure(err)) return // went offline mid-sync: try again later
            // The playlist was deleted on the server: keep the downloaded copy; the user can remove it.
          }
        }
      },

      async refreshAvailability() {
        await refreshUsage()
      },

      onPlay(track) {
        const id = track.id
        const kind = get().available[id]
        if (kind) {
          if (!native) void backend?.touch(id)
          return
        }
        if (native) {
          // The Media3 cache writes it while streaming; learn about it once it is complete.
          void native.availability([id]).then((r) => {
            if (r.available.includes(id)) markAvailable(id, r.pinned.includes(id) ? 'pinned' : 'auto')
          })
          void cacheExtras(track)
          return
        }
        if (backend?.teeUrl) {
          void cacheExtras(track) // the tee caches the audio; the cover and lyrics come separately
          return
        }
        if (!backend || !deps.online()) return
        // Web / iOS: cache what plays with one extra request (the browser cache usually answers it).
        if (get().settings.prefetchWifiOnly && deps.unmetered() === false) return
        if (autoCaching === id) return
        if (autoTimer) clearTimeout(autoTimer)
        autoTimer = setTimeout(() => {
          autoTimer = null
          autoCaching = id
          const ctl = new AbortController()
          deps.api
            .stream(id, ctl.signal)
            .then((info) => backend.store(id, info.url, { pinned: false, mime: info.mimeType, onProgress: () => undefined, signal: ctl.signal }))
            .then(async () => {
              markAvailable(id, 'auto')
              set((s) => ({ tracks: { ...s.tracks, [id]: track } }))
              await putExtras(track)
              const gone = await backend.applyPolicy(get().settings.cache, new Set([id]))
              if (gone.length) {
                unmark(gone)
                for (const g of gone) void meta?.deleteTrack(g)
              }
              await refreshUsage()
            })
            .catch(() => undefined) // quota / network: playback is unaffected
            .finally(() => {
              if (autoCaching === id) autoCaching = null
            })
        }, AUTO_CACHE_DELAY_MS)
      },

      async playbackFor(trackId, resolve, force) {
        if (!force && !native && backend && get().available[trackId]) {
          try {
            const url = await backend.playbackUrl(trackId)
            if (url) return { url, expiresAt: new Date(now() + LOCAL_URL_TTL_MS).toISOString() }
          } catch {
            /* fall through to the network */
          }
        }
        const info = await resolve()
        if (!force && !native && backend?.teeUrl && !get().available[trackId]) {
          return { ...info, url: backend.teeUrl(trackId, info.url) }
        }
        return info
      },

      isAvailable: (id) => id in get().available,
      lyricsFor: (id) => (meta ? meta.getLyrics(id) : Promise.resolve(undefined)),
      async artFor(id) {
        const hit = artUrls.get(id)
        if (hit) return hit
        const blob = await meta?.getArt(id).catch(() => undefined)
        if (!blob) return null
        const u = makeUrl(blob)
        artUrls.set(id, u)
        return u
      },

      removeTrackIds: async (ids: string[]) => {
        if (ids.length === 0) return
        for (const id of ids) {
          queue.cancel(id)
          jobTracks.delete(id)
        }
        if (native) {
          await native.cancel(ids)
          set((s) => {
            const available = { ...s.available }
            for (const id of ids) delete available[id]
            return { available }
          })
        } else if (backend) {
          // Pinned copies go away; the track may still be useful as an automatic-cache entry, but an
          // explicit removal means the user does not want it kept.
          await backend.remove(ids)
          unmark(ids)
        }
        set((s) => {
          const tracks = { ...s.tracks }
          for (const id of ids) delete tracks[id]
          return { tracks }
        })
        for (const id of ids) void meta?.deleteTrack(id).catch(() => undefined)
        await refreshUsage()
      }
    }
  })

  return store
}
