import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useUi } from '@/store/ui'
import { OFFSET_SAVE_DEBOUNCE_MS, useLyricsOffset } from '@/hooks/useLyricsOffset'

const h = vi.hoisted(() => ({ setLyricsOffset: vi.fn() }))
vi.mock('@/services', () => ({ api: { setLyricsOffset: h.setLyricsOffset } }))

beforeEach(() => {
  vi.useFakeTimers()
  h.setLyricsOffset.mockReset()
  h.setLyricsOffset.mockResolvedValue({ offsetMs: 0 })
  useUi.setState({ toasts: [] })
})
afterEach(() => vi.useRealTimers())

describe('useLyricsOffset', () => {
  it('starts from the server value and updates optimistically', () => {
    const { result } = renderHook(() => useLyricsOffset('t1', 1000))
    expect(result.current.offsetMs).toBe(1000)
    act(() => result.current.nudge(500))
    expect(result.current.offsetMs).toBe(1500)
    expect(h.setLyricsOffset).not.toHaveBeenCalled()
  })

  it('debounces: several clicks save once with the final value', () => {
    const { result } = renderHook(() => useLyricsOffset('t1', 0))
    act(() => result.current.nudge(500))
    act(() => result.current.nudge(500))
    act(() => result.current.nudge(-500))
    act(() => void vi.advanceTimersByTime(OFFSET_SAVE_DEBOUNCE_MS + 1))
    expect(h.setLyricsOffset).toHaveBeenCalledTimes(1)
    expect(h.setLyricsOffset).toHaveBeenCalledWith('t1', 500)
  })

  it('reset saves 0; values clamp to +-30 s', () => {
    const { result } = renderHook(() => useLyricsOffset('t1', 29800))
    act(() => result.current.nudge(500))
    expect(result.current.offsetMs).toBe(30000)
    act(() => result.current.reset())
    expect(result.current.offsetMs).toBe(0)
    act(() => void vi.advanceTimersByTime(OFFSET_SAVE_DEBOUNCE_MS + 1))
    expect(h.setLyricsOffset).toHaveBeenLastCalledWith('t1', 0)
  })

  it('flushes a pending save when unmounting or switching tracks', () => {
    const { result, rerender, unmount } = renderHook(({ id }) => useLyricsOffset(id, 0), { initialProps: { id: 't1' } })
    act(() => result.current.nudge(500))
    rerender({ id: 't2' })
    expect(h.setLyricsOffset).toHaveBeenCalledWith('t1', 500)
    expect(result.current.offsetMs).toBe(0)
    act(() => result.current.nudge(-500))
    unmount()
    expect(h.setLyricsOffset).toHaveBeenLastCalledWith('t2', -500)
  })

  it('keeps the local value and toasts when saving fails', async () => {
    vi.useRealTimers()
    h.setLyricsOffset.mockRejectedValue(new Error('x'))
    const { result } = renderHook(() => useLyricsOffset('t1', 0))
    act(() => result.current.nudge(500))
    await act(async () => {
      await new Promise((r) => setTimeout(r, OFFSET_SAVE_DEBOUNCE_MS + 50))
    })
    expect(result.current.offsetMs).toBe(500)
    expect(useUi.getState().toasts.map((t) => t.message).join()).toMatch(/offset/i)
  })
})
