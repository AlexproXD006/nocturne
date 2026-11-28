import { planEviction, type CacheSettings } from '../../lib/offline/policy'
import { idbKv, type Kv } from './kv'
import { QuotaError, type OfflineBackend, type StoredAudio, type StoreOptions } from './types'

interface AudioRecord extends StoredAudio {
  blob: Blob
  mime: string
}

export interface IdbBackendDeps {
  audio?: Kv<AudioRecord>
  fetch?: typeof fetch
  now?: () => number
  createObjectURL?: (b: Blob) => string
  revokeObjectURL?: (u: string) => void
  storage?: { estimate?: () => Promise<{ usage?: number; quota?: number }> } | null
}

function isQuota(e: unknown): boolean {
  return e instanceof DOMException && (e.name === 'QuotaExceededError' || e.code === 22)
}

/**
 * Web and iOS: audio blobs in IndexedDB (same N-recent policy as everywhere). `store` reads the response
 * as a stream so progress is real. Quota errors surface as {@link QuotaError} so callers degrade quietly.
 *
 * iOS note: WKWebView may evict origin storage under disk pressure and gives small quotas to non-Safari
 * web views; Android and desktop keep their audio outside the browser storage for that reason.
 */
export function createIdbBackend(deps: IdbBackendDeps = {}): OfflineBackend {
  const audio = deps.audio ?? idbKv<AudioRecord>('audio')
  const doFetch = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const now = deps.now ?? Date.now
  const mk = deps.createObjectURL ?? ((b: Blob) => URL.createObjectURL(b))
  const rm = deps.revokeObjectURL ?? ((u: string) => URL.revokeObjectURL(u))
  const urls = new Map<string, string>()
  const inflight = new Set<string>()

  const forget = (id: string): void => {
    const u = urls.get(id)
    if (u) rm(u)
    urls.delete(id)
  }
  const strip = (r: AudioRecord): StoredAudio => ({ id: r.id, bytes: r.bytes, pinned: r.pinned, lastPlayed: r.lastPlayed })

  const backend: OfflineBackend = {
    kind: 'idb',
    async init() {
      /* the database opens lazily */
    },
    async list() {
      return (await audio.all()).map(strip)
    },
    async playbackUrl(id) {
      const hit = urls.get(id)
      if (hit) return hit
      const rec = await audio.get(id)
      if (!rec) return null
      const u = mk(rec.blob)
      urls.set(id, u)
      return u
    },
    async store(id, url, opts: StoreOptions) {
      const existing = await audio.get(id)
      if (existing) {
        if (opts.pinned && !existing.pinned) await audio.put(id, { ...existing, pinned: true })
        return existing.bytes
      }
      inflight.add(id)
      try {
        const res = await doFetch(url, { signal: opts.signal })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const total = Number(res.headers.get('content-length')) || 0
        const mime = opts.mime ?? res.headers.get('content-type') ?? 'audio/mpeg'
        const chunks: Uint8Array[] = []
        let bytes = 0
        if (res.body) {
          const reader = res.body.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            chunks.push(value)
            bytes += value.byteLength
            opts.onProgress(bytes, total)
          }
        } else {
          const buf = new Uint8Array(await res.arrayBuffer())
          chunks.push(buf)
          bytes = buf.byteLength
          opts.onProgress(bytes, bytes)
        }
        if (total > 0 && bytes !== total) throw new Error('incomplete')
        if (bytes === 0) throw new Error('empty')
        try {
          await audio.put(id, { id, bytes, pinned: opts.pinned, lastPlayed: now(), blob: new Blob(chunks as BlobPart[], { type: mime }), mime })
        } catch (e) {
          throw isQuota(e) ? new QuotaError() : e
        }
        return bytes
      } finally {
        inflight.delete(id)
      }
    },
    async setPinned(id, pinned) {
      const rec = await audio.get(id)
      if (rec) await audio.put(id, { ...rec, pinned })
    },
    async touch(id) {
      const rec = await audio.get(id)
      if (rec) await audio.put(id, { ...rec, lastPlayed: now() })
    },
    async remove(ids) {
      for (const id of ids) {
        forget(id)
        await audio.delete(id)
      }
    },
    async clearAuto() {
      const ids = (await audio.all()).filter((r) => !r.pinned).map((r) => r.id)
      await backend.remove(ids)
      return ids
    },
    async applyPolicy(settings: CacheSettings, protect = new Set<string>()) {
      const all = (await audio.all()).map(strip)
      const victims = planEviction(all, settings, new Set([...protect, ...inflight]))
      await backend.remove(victims)
      return victims
    },
    async estimate() {
      const st = deps.storage === undefined ? (typeof navigator !== 'undefined' ? navigator.storage : null) : deps.storage
      if (!st?.estimate) return null
      try {
        const e = await st.estimate()
        return { usage: e.usage ?? 0, quota: e.quota ?? 0 }
      } catch {
        return null
      }
    }
  }
  return backend
}
