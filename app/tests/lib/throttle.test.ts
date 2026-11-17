import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { throttle } from '@/lib/throttle'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('throttle', () => {
  it('runs the first call at once and collapses the rest into one trailing call with the latest value', () => {
    const fn = vi.fn()
    const t = throttle(fn, 100)
    t(0.1)
    t(0.2)
    t(0.3)
    expect(fn.mock.calls).toEqual([[0.1]])
    vi.advanceTimersByTime(100)
    expect(fn.mock.calls).toEqual([[0.1], [0.3]])
    vi.advanceTimersByTime(500)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('sends at most one call per window while dragging', () => {
    const fn = vi.fn()
    const t = throttle(fn, 100)
    for (let i = 0; i < 50; i++) {
      t(i)
      vi.advanceTimersByTime(10) // a drag event every 10 ms for 500 ms
    }
    vi.advanceTimersByTime(200)
    expect(fn.mock.calls.length).toBeLessThanOrEqual(7)
    expect(fn.mock.calls.at(-1)).toEqual([49]) // the final value always lands
  })

  it('flush runs a pending call now; cancel drops it', () => {
    const fn = vi.fn()
    const t = throttle(fn, 100)
    t(1)
    t(2)
    t.flush()
    expect(fn.mock.calls).toEqual([[1], [2]])
    t(3) // window was reset by flush: runs at once
    t(4)
    t.cancel()
    vi.advanceTimersByTime(200)
    expect(fn.mock.calls).toEqual([[1], [2], [3]])
  })
})
