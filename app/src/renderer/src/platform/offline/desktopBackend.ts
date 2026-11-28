import type { NocturneBridge } from '../../../../shared/ipc'
import type { OfflineBackend } from './types'

type Bridge = NonNullable<NocturneBridge['offline']>

/**
 * Desktop (Electron): the main process owns the files (<userData>/offline) and serves them over
 * `nocturne-offline://`; a playing stream goes through `nocturne-stream://`, which caches it on the fly.
 */
export function createDesktopBackend(b: Bridge): OfflineBackend {
  const cachedListeners = new Set<(id: string) => void>()
  const progress = new Map<string, (bytes: number, total: number) => void>()
  b.onProgress((p) => {
    progress.get(p.id)?.(p.bytes, p.total)
    if (p.done && !progress.has(p.id)) for (const l of [...cachedListeners]) l(p.id)
  })
  const known = new Set<string>()
  return {
    kind: 'desktop',
    async init() {
      for (const a of await b.list()) known.add(a.id)
    },
    async list() {
      const l = await b.list()
      known.clear()
      for (const a of l) known.add(a.id)
      return l
    },
    async playbackUrl(id) {
      if (!known.has(id)) {
        const l = await b.list()
        for (const a of l) known.add(a.id)
        if (!known.has(id)) return null
      }
      return `nocturne-offline://audio/${encodeURIComponent(id)}`
    },
    async store(id, url, opts) {
      progress.set(id, opts.onProgress)
      const onAbort = (): void => void b.abort(id)
      opts.signal.addEventListener('abort', onAbort, { once: true })
      try {
        const bytes = await b.store(id, url, { pinned: opts.pinned, mime: opts.mime })
        known.add(id)
        return bytes
      } finally {
        progress.delete(id)
        opts.signal.removeEventListener('abort', onAbort)
      }
    },
    setPinned: (id, pinned) => b.setPinned(id, pinned),
    touch: (id) => b.touch(id),
    async remove(ids) {
      for (const id of ids) known.delete(id)
      await b.remove(ids)
    },
    async clearAuto() {
      const ids = await b.clearAuto()
      for (const id of ids) known.delete(id)
      return ids
    },
    applyPolicy: (settings) => b.configure(settings),
    onCached(listener) {
      cachedListeners.add(listener)
      return () => cachedListeners.delete(listener)
    },
    teeUrl: (id, signedUrl) => `nocturne-stream://audio?id=${encodeURIComponent(id)}&u=${encodeURIComponent(signedUrl)}`
  }
}
