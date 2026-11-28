import { describe, expect, it } from 'vitest'
import { DEFAULT_CACHE, GB, planEviction, sanitizeCache, type CacheEntry } from '@/lib/offline/policy'

const entries = (n: number, bytes = 10, pinned: (i: number) => boolean = () => false): CacheEntry[] =>
  Array.from({ length: n }, (_, i) => ({ id: `t${i}`, bytes, lastPlayed: 1000 + i, pinned: pinned(i) }))

describe('cache policy', () => {
  it('defaults to the last 30 tracks', () => {
    expect(DEFAULT_CACHE).toEqual({ mode: 'tracks', tracks: 30, gb: 1 })
  })

  it('keeps the N most recently played and evicts the oldest first', () => {
    expect(planEviction(entries(33), DEFAULT_CACHE)).toEqual(['t2', 't1', 't0'])
    expect(planEviction(entries(30), DEFAULT_CACHE)).toEqual([])
  })

  it('honours 50 / 100 / 200', () => {
    for (const n of [50, 100, 200]) {
      expect(planEviction(entries(n + 2), { mode: 'tracks', tracks: n, gb: 1 })).toHaveLength(2)
    }
  })

  it('never evicts pinned (downloaded) tracks and does not count them in the rotation', () => {
    const e = entries(34, 10, (i) => i < 4) // the 4 oldest are downloads
    expect(planEviction(e, DEFAULT_CACHE)).toEqual([]) // 30 auto tracks left: all fit
    expect(planEviction(entries(35, 10, (i) => i < 4), DEFAULT_CACHE)).toEqual(['t4'])
  })

  it('never evicts a protected id (the one being written / played)', () => {
    expect(planEviction(entries(31), DEFAULT_CACHE, new Set(['t0']))).toEqual(['t1'])
  })

  it('size mode keeps as many recent tracks as fit', () => {
    const mb = 1024 * 1024
    const e = entries(5, 300 * mb)
    expect(planEviction(e, { mode: 'bytes', tracks: 30, gb: 1 })).toEqual(['t1', 't0'])
  })

  it('size mode keeps the newest track even when it is bigger than the budget, and ignores pinned bytes', () => {
    expect(planEviction([{ id: 'old', bytes: 5, lastPlayed: 1, pinned: false }, { id: 'huge', bytes: 2 * GB, lastPlayed: 2, pinned: false }], { mode: 'bytes', tracks: 30, gb: 1 })).toEqual(['old'])
    const pinnedHuge: CacheEntry[] = [
      { id: 'dl', bytes: 4 * GB, lastPlayed: 1, pinned: true },
      { id: 'a', bytes: 0.4 * GB, lastPlayed: 2, pinned: false },
      { id: 'b', bytes: 0.4 * GB, lastPlayed: 3, pinned: false }
    ]
    expect(planEviction(pinnedHuge, { mode: 'bytes', tracks: 30, gb: 1 })).toEqual([])
  })

  it('sanitizes unknown values back to the defaults', () => {
    expect(sanitizeCache({ mode: 'bytes', tracks: 7, gb: 3 })).toEqual({ mode: 'bytes', tracks: 30, gb: 1 })
    expect(sanitizeCache({ mode: 'tracks', tracks: 100, gb: 5 })).toEqual({ mode: 'tracks', tracks: 100, gb: 5 })
    expect(sanitizeCache(null)).toEqual(DEFAULT_CACHE)
  })
})
