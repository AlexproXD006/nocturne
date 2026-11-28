/**
 * Automatic cache policy shared by every platform that stores audio itself (desktop main process,
 * web/iOS IndexedDB): keep the N most recently played auto-cached tracks, or as many of them as fit in
 * a byte budget. Pinned tracks (downloads) are never evicted and do not count toward either budget; a
 * protected id (the one being written or played right now) is never evicted either.
 *
 * Android implements the same rules natively (CachePolicy.java); keep both in sync.
 */

export const DEFAULT_CACHE_TRACKS = 30
export const CACHE_TRACK_CHOICES = [30, 50, 100, 200] as const
export const CACHE_GB_CHOICES = [1, 2, 5] as const
export const GB = 1024 * 1024 * 1024

export interface CacheSettings {
  mode: 'tracks' | 'bytes'
  /** Used in 'tracks' mode. */
  tracks: number
  /** Used in 'bytes' mode (gigabytes: 1, 2 or 5). */
  gb: number
}

export const DEFAULT_CACHE: CacheSettings = { mode: 'tracks', tracks: DEFAULT_CACHE_TRACKS, gb: 1 }

export interface CacheEntry {
  id: string
  bytes: number
  /** Epoch ms of the last time the track was played. */
  lastPlayed: number
  pinned: boolean
}

export function sanitizeCache(raw: unknown): CacheSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof CacheSettings, unknown>>
  const tracks = (CACHE_TRACK_CHOICES as readonly number[]).includes(r.tracks as number) ? (r.tracks as number) : DEFAULT_CACHE.tracks
  const gb = (CACHE_GB_CHOICES as readonly number[]).includes(r.gb as number) ? (r.gb as number) : DEFAULT_CACHE.gb
  return { mode: r.mode === 'bytes' ? 'bytes' : 'tracks', tracks, gb }
}

/** Bytes budget of a 'bytes' mode setting (0 in 'tracks' mode). */
export function budgetBytes(s: CacheSettings): number {
  return s.mode === 'bytes' ? s.gb * GB : 0
}

/** Ids to evict: the oldest ones (listed most recent of them first). */
export function planEviction(entries: readonly CacheEntry[], settings: CacheSettings, protect: ReadonlySet<string> = new Set()): string[] {
  const auto = entries
    .filter((e) => !e.pinned)
    .sort((a, b) => (a.lastPlayed !== b.lastPlayed ? b.lastPlayed - a.lastPlayed : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const maxBytes = budgetBytes(settings)
  let kept = 0
  let used = 0
  for (const e of auto) {
    if (protect.has(e.id)) {
      kept++
      used += e.bytes
    }
  }
  const out: string[] = []
  for (const e of auto) {
    if (protect.has(e.id)) continue
    // In size mode the most recent track is always kept, even when it alone is over budget.
    const keep = maxBytes > 0 ? kept === 0 || used + e.bytes <= maxBytes : kept < settings.tracks
    if (keep) {
      kept++
      used += e.bytes
    } else {
      out.push(e.id)
    }
  }
  return out
}
