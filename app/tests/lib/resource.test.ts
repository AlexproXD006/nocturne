import { describe, expect, it, vi } from 'vitest'
import { ResourceCache, resources } from '@/lib/resource'

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function make(ttl = 1000, max?: number): { cache: ResourceCache; clock: { t: number } } {
  const clock = { t: 10_000 }
  return { cache: new ResourceCache({ ttl, max, now: () => clock.t }), clock }
}

describe('load', () => {
  it('fetches, caches and returns the value', async () => {
    const { cache } = make()
    const fetcher = vi.fn().mockResolvedValue('v1')
    await expect(cache.load('k', fetcher)).resolves.toBe('v1')
    expect(cache.peek('k')).toBe('v1')
    expect(cache.isFresh('k')).toBe(true)
  })

  it('de-duplicates concurrent loads for the same key', async () => {
    const { cache } = make()
    const d = deferred<string>()
    const fetcher = vi.fn(() => d.promise)
    const a = cache.load('k', fetcher)
    const b = cache.load('k', fetcher)
    d.resolve('x')
    expect(await Promise.all([a, b])).toEqual(['x', 'x'])
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('de-duplicates even when force is set while a request is in flight', async () => {
    const { cache } = make()
    const d = deferred<string>()
    const fetcher = vi.fn(() => d.promise)
    const a = cache.load('k', fetcher)
    const b = cache.load('k', fetcher, true)
    d.resolve('x')
    await Promise.all([a, b])
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('serves fresh values without refetching', async () => {
    const { cache, clock } = make(1000)
    const fetcher = vi.fn().mockResolvedValueOnce('a').mockResolvedValueOnce('b')
    await cache.load('k', fetcher)
    clock.t += 999
    await expect(cache.load('k', fetcher)).resolves.toBe('a')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('refetches once the ttl elapsed (boundary is exclusive)', async () => {
    const { cache, clock } = make(1000)
    const fetcher = vi.fn().mockResolvedValueOnce('a').mockResolvedValueOnce('b')
    await cache.load('k', fetcher)
    clock.t += 1000
    expect(cache.isFresh('k')).toBe(false)
    await expect(cache.load('k', fetcher)).resolves.toBe('b')
    expect(cache.peek('k')).toBe('b')
    expect(cache.isFresh('k')).toBe(true)
  })

  it('keeps serving the stale value via peek while revalidating', async () => {
    const { cache, clock } = make(1000)
    await cache.load('k', async () => 'old')
    clock.t += 5000
    const d = deferred<string>()
    const p = cache.load('k', () => d.promise)
    expect(cache.peek('k')).toBe('old')
    d.resolve('new')
    await p
    expect(cache.peek('k')).toBe('new')
  })

  it('force bypasses freshness', async () => {
    const { cache } = make()
    const fetcher = vi.fn().mockResolvedValueOnce('a').mockResolvedValueOnce('b')
    await cache.load('k', fetcher)
    await expect(cache.load('k', fetcher, true)).resolves.toBe('b')
  })

  it('does not cache errors and allows an immediate retry', async () => {
    const { cache } = make()
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('ok')
    await expect(cache.load('k', fetcher)).rejects.toThrow('boom')
    expect(cache.peek('k')).toBeUndefined()
    expect(cache.isFresh('k')).toBe(false)
    await expect(cache.load('k', fetcher)).resolves.toBe('ok')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('a failed revalidation keeps the previous value readable', async () => {
    const { cache, clock } = make(1000)
    await cache.load('k', async () => 'good')
    clock.t += 5000
    await expect(cache.load('k', async () => { throw new Error('offline') })).rejects.toThrow('offline')
    expect(cache.peek('k')).toBe('good')
    expect(cache.isFresh('k')).toBe(false)
  })

  it('shares rejection between de-duplicated callers', async () => {
    const { cache } = make()
    const d = deferred<string>()
    const fetcher = vi.fn(() => d.promise)
    const a = cache.load('k', fetcher)
    const b = cache.load('k', fetcher)
    d.reject(new Error('shared'))
    await expect(a).rejects.toThrow('shared')
    await expect(b).rejects.toThrow('shared')
  })

  it('does not treat undefined results as cached values', async () => {
    const { cache } = make()
    const fetcher = vi.fn().mockResolvedValue(undefined)
    await cache.load('k', fetcher)
    await cache.load('k', fetcher)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('caches falsy values (0, empty string, null)', async () => {
    const { cache } = make()
    for (const v of [0, '', null, false]) {
      const fetcher = vi.fn().mockResolvedValue(v)
      await cache.load(`k-${String(v)}`, fetcher)
      await cache.load(`k-${String(v)}`, fetcher)
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  })

  it('keeps keys independent', async () => {
    const { cache } = make()
    await cache.load('a', async () => 1)
    await cache.load('b', async () => 2)
    expect(cache.peek('a')).toBe(1)
    expect(cache.peek('b')).toBe(2)
  })

  it('evicts least-recently-used entries beyond max', async () => {
    const { cache } = make(1000, 2)
    await cache.load('a', async () => 1)
    await cache.load('b', async () => 2)
    await cache.load('c', async () => 3)
    expect(cache.peek('a')).toBeUndefined()
    expect(cache.peek('b')).toBe(2)
    expect(cache.peek('c')).toBe(3)
  })

  it('defaults to a 60s ttl', async () => {
    const clock = { t: 0 }
    const cache = new ResourceCache({ now: () => clock.t })
    await cache.load('k', async () => 1)
    clock.t = 59_999
    expect(cache.isFresh('k')).toBe(true)
    clock.t = 60_000
    expect(cache.isFresh('k')).toBe(false)
  })

  it('uses Date.now by default', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const cache = new ResourceCache({ ttl: 100 })
      await cache.load('k', async () => 1)
      vi.setSystemTime(99)
      expect(cache.isFresh('k')).toBe(true)
      vi.setSystemTime(100)
      expect(cache.isFresh('k')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('peek / isFresh', () => {
  it('return undefined / false for unknown keys', () => {
    const { cache } = make()
    expect(cache.peek('nope')).toBeUndefined()
    expect(cache.isFresh('nope')).toBe(false)
  })
})

describe('set', () => {
  it('stores a value that is immediately fresh and notifies subscribers', () => {
    const { cache } = make()
    const fn = vi.fn()
    cache.subscribe('k', fn)
    cache.set('k', { n: 1 })
    expect(cache.peek('k')).toEqual({ n: 1 })
    expect(cache.isFresh('k')).toBe(true)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('makes subsequent loads skip the fetcher', async () => {
    const { cache } = make()
    cache.set('k', 'preset')
    const fetcher = vi.fn()
    await expect(cache.load('k', fetcher)).resolves.toBe('preset')
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('mutate', () => {
  it('applies the update and notifies', async () => {
    const { cache } = make()
    await cache.load('k', async () => ({ liked: false }))
    const fn = vi.fn()
    cache.subscribe('k', fn)
    cache.mutate<{ liked: boolean }>('k', (v) => ({ ...v, liked: true }))
    expect(cache.peek('k')).toEqual({ liked: true })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does not change freshness', async () => {
    const { cache, clock } = make(1000)
    await cache.load('k', async () => 1)
    clock.t += 500
    cache.mutate<number>('k', (v) => v + 1)
    clock.t += 500
    expect(cache.isFresh('k')).toBe(false)
  })

  it('is a no-op for unknown keys and entries without a value', async () => {
    const { cache } = make()
    const fn = vi.fn()
    cache.subscribe('k', fn)
    cache.mutate('k', () => 1)
    expect(fn).not.toHaveBeenCalled()
    // entry exists (in flight) but has no value yet
    const d = deferred<number>()
    const p = cache.load('k', () => d.promise)
    const updater = vi.fn((v: number) => v + 1)
    cache.mutate('k', updater)
    expect(updater).not.toHaveBeenCalled()
    d.resolve(1)
    await p
  })
})

describe('subscribe / emit', () => {
  it('notifies on a successful load but not on failure', async () => {
    const { cache } = make()
    const fn = vi.fn()
    cache.subscribe('k', fn)
    await cache.load('k', async () => 1)
    expect(fn).toHaveBeenCalledTimes(1)
    await expect(cache.load('k', async () => { throw new Error('x') }, true)).rejects.toThrow()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('only notifies subscribers of the matching key', () => {
    const { cache } = make()
    const a = vi.fn()
    const b = vi.fn()
    cache.subscribe('a', a)
    cache.subscribe('b', b)
    cache.set('a', 1)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
  })

  it('supports multiple subscribers and unsubscribing', () => {
    const { cache } = make()
    const a = vi.fn()
    const b = vi.fn()
    const offA = cache.subscribe('k', a)
    cache.subscribe('k', b)
    cache.set('k', 1)
    offA()
    cache.set('k', 2)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(2)
    offA() // idempotent
  })

  it('cleans up listener sets when the last subscriber leaves', () => {
    const { cache } = make()
    const off = cache.subscribe('k', vi.fn())
    off()
    expect(() => cache.set('k', 1)).not.toThrow()
  })
})

describe('invalidate', () => {
  it('marks entries stale so the next load refetches, even without subscribers', async () => {
    const { cache } = make()
    const fetcher = vi.fn().mockResolvedValueOnce('a').mockResolvedValueOnce('b')
    await cache.load('album:1', fetcher)
    expect(cache.isFresh('album:1')).toBe(true)
    cache.invalidate('album:')
    expect(cache.isFresh('album:1')).toBe(false)
    expect(cache.peek('album:1')).toBe('a') // stale value still readable
    await expect(cache.load('album:1', fetcher)).resolves.toBe('b')
  })

  it('works when the injected clock is near zero (stale means stale)', async () => {
    const clock = { t: 0 }
    const cache = new ResourceCache({ ttl: 1000, now: () => clock.t })
    await cache.load('k', async () => 1)
    cache.invalidate()
    expect(cache.isFresh('k')).toBe(false)
  })

  it('only affects keys with the prefix', async () => {
    const { cache } = make()
    await cache.load('album:1', async () => 1)
    await cache.load('album:2', async () => 2)
    await cache.load('artist:1', async () => 3)
    cache.invalidate('album:')
    expect(cache.isFresh('album:1')).toBe(false)
    expect(cache.isFresh('album:2')).toBe(false)
    expect(cache.isFresh('artist:1')).toBe(true)
  })

  it('invalidates everything without a prefix', async () => {
    const { cache } = make()
    await cache.load('a', async () => 1)
    await cache.load('b', async () => 2)
    cache.invalidate()
    expect(cache.isFresh('a')).toBe(false)
    expect(cache.isFresh('b')).toBe(false)
  })

  it('notifies subscribers of invalidated keys only', async () => {
    const { cache } = make()
    await cache.load('a:1', async () => 1)
    await cache.load('b:1', async () => 2)
    const a = vi.fn()
    const b = vi.fn()
    cache.subscribe('a:1', a)
    cache.subscribe('b:1', b)
    cache.invalidate('a:')
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
  })

  it('notifies subscribers of keys that have no cached entry yet', () => {
    const { cache } = make()
    const fn = vi.fn()
    cache.subscribe('k', fn)
    cache.invalidate('k')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does not disturb recency order', async () => {
    const { cache } = make(1000, 2)
    await cache.load('a', async () => 1)
    await cache.load('b', async () => 2)
    cache.invalidate('a') // must not make `a` the most recent
    await cache.load('c', async () => 3)
    expect(cache.peek('a')).toBeUndefined()
    expect(cache.peek('b')).toBe(2)
  })
})

describe('clear', () => {
  it('drops all entries and notifies subscribers', async () => {
    const { cache } = make()
    await cache.load('a', async () => 1)
    const fn = vi.fn()
    cache.subscribe('a', fn)
    cache.clear()
    expect(cache.peek('a')).toBeUndefined()
    expect(cache.isFresh('a')).toBe(false)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('shared instance', () => {
  it('exports a ready-to-use cache', async () => {
    resources.clear()
    await expect(resources.load('shared-test', async () => 5)).resolves.toBe(5)
    resources.clear()
  })
})
