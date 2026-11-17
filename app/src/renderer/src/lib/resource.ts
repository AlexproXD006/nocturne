import { LruCache } from './lru'

interface Entry<T> {
  value?: T
  error?: unknown
  at: number
  inflight?: Promise<T>
}

export interface ResourceCacheOptions {
  max?: number
  /** Ms a value is considered fresh. Stale values are still returned and revalidated. */
  ttl?: number
  now?: () => number
}

/** Stale-while-revalidate cache with request de-duplication. */
export class ResourceCache {
  private readonly cache: LruCache<string, Entry<unknown>>
  private readonly ttl: number
  private readonly now: () => number
  private readonly listeners = new Map<string, Set<() => void>>()

  constructor(opts: ResourceCacheOptions = {}) {
    this.cache = new LruCache(opts.max ?? 150)
    this.ttl = opts.ttl ?? 60_000
    this.now = opts.now ?? Date.now
  }

  peek<T>(key: string): T | undefined {
    return this.cache.get(key)?.value as T | undefined
  }

  isFresh(key: string): boolean {
    const e = this.cache.get(key)
    return Boolean(e && e.value !== undefined && this.now() - e.at < this.ttl)
  }

  async load<T>(key: string, fetcher: () => Promise<T>, force = false): Promise<T> {
    const existing = this.cache.get(key) as Entry<T> | undefined
    if (existing?.inflight) return existing.inflight
    if (!force && existing && existing.value !== undefined && this.now() - existing.at < this.ttl) return existing.value
    const entry: Entry<T> = existing ?? { at: 0 }
    const p = fetcher().then(
      (value) => {
        entry.value = value
        entry.error = undefined
        entry.at = this.now()
        entry.inflight = undefined
        this.emit(key)
        return value
      },
      (err: unknown) => {
        entry.inflight = undefined
        throw err
      }
    )
    entry.inflight = p
    this.cache.set(key, entry as Entry<unknown>)
    return p
  }

  set<T>(key: string, value: T): void {
    this.cache.set(key, { value, at: this.now() })
    this.emit(key)
  }

  /** Applies an in-place update to a cached value (e.g. toggling a like). */
  mutate<T>(key: string, fn: (value: T) => T): void {
    const e = this.cache.get(key) as Entry<T> | undefined
    if (!e || e.value === undefined) return
    e.value = fn(e.value)
    this.emit(key)
  }

  /** Marks every cached entry whose key starts with `prefix` as stale (subscribed or not). */
  invalidate(prefix = ''): void {
    const keys = new Set([...this.cache.keys(), ...this.listeners.keys()])
    for (const key of keys) {
      if (!key.startsWith(prefix)) continue
      const e = this.cache.peek(key)
      if (e) e.at = Number.NEGATIVE_INFINITY
      this.emit(key)
    }
  }

  clear(): void {
    this.cache.clear()
    for (const key of this.listeners.keys()) this.emit(key)
  }

  subscribe(key: string, fn: () => void): () => void {
    let set = this.listeners.get(key)
    if (!set) this.listeners.set(key, (set = new Set()))
    set.add(fn)
    return () => {
      set!.delete(fn)
      if (set!.size === 0) this.listeners.delete(key)
    }
  }

  private emit(key: string): void {
    this.listeners.get(key)?.forEach((fn) => fn())
  }
}

export const resources = new ResourceCache()
