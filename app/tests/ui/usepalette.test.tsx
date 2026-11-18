import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ex = vi.hoisted(() => ({ map: new Map<string, unknown>() }))
vi.mock('@/lib/color', async (orig) => ({
  ...(await orig<typeof import('@/lib/color')>()),
  cachedPalette: (u: string) => ex.map.get(u),
  extractPalette: (u: string) => Promise.resolve(ex.map.get(u) ?? null)
}))

import { usePalette, PALETTE_DEBOUNCE_MS } from '@/hooks/useAccent'

const pal = (r: number) => ({ dominant: { r, g: 0, b: 0 }, vibrant: null, muted: null, luminance: 0.3 })

describe('usePalette', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('keeps the previous palette while loading and after an error, debounces rapid changes', async () => {
    ex.map.set('a', pal(10))
    const { result, rerender } = renderHook(({ u }) => usePalette(u), { initialProps: { u: 'a' } })
    expect(result.current).toEqual(pal(10))
    rerender({ u: 'broken' })
    expect(result.current).toEqual(pal(10)) // loading: previous kept
    await act(async () => void vi.advanceTimersByTime(PALETTE_DEBOUNCE_MS + 10))
    expect(result.current).toEqual(pal(10)) // errored: last good kept
    ex.map.set('c', pal(99))
    rerender({ u: 'c' })
    await act(async () => void vi.advanceTimersByTime(PALETTE_DEBOUNCE_MS + 10))
    expect(result.current).toEqual(pal(99))
  })
})
