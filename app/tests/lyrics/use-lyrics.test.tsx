import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { Lyrics } from '@/lyrics/service'
import { track } from '../helpers/fixtures'

const h = vi.hoisted(() => ({ resolve: vi.fn(), server: false }))

vi.mock('@/lyrics/service', () => ({ resolveLyrics: h.resolve }))
vi.mock('@/services', () => ({
  api: { lyrics: vi.fn() },
  lrclib: { find: vi.fn() },
  useSession: (sel: (s: unknown) => unknown) => sel({ server: { capabilities: { lyrics: h.server } } })
}))

import { invalidateLyrics, useLyrics } from '@/hooks/useLyrics'

const plain = (t: string): Lyrics => ({ kind: 'plain', parsed: { lines: [{ time: 0, text: t }], synced: false }, source: 'server' })

beforeEach(() => {
  h.resolve.mockReset()
  h.server = false
})

describe('useLyrics cache and invalidateLyrics', () => {
  it('is idle without a track or when disabled', () => {
    expect(renderHook(() => useLyrics(null)).result.current).toEqual({ status: 'idle' })
    const t = track('x')
    expect(renderHook(() => useLyrics(t, false)).result.current).toEqual({ status: 'idle' })
    expect(h.resolve).not.toHaveBeenCalled()
  })

  it('caches per track and reloads after invalidateLyrics', async () => {
    const t = track('cache-1')
    h.resolve.mockResolvedValueOnce(plain('old')).mockResolvedValueOnce(plain('new'))
    const first = renderHook(() => useLyrics(t))
    await waitFor(() => expect(first.result.current.status).toBe('ready'))
    first.unmount()

    // Served from the cache: no second request.
    const second = renderHook(() => useLyrics(t))
    await waitFor(() => expect(second.result.current.status).toBe('ready'))
    expect(h.resolve).toHaveBeenCalledTimes(1)

    // A mounted view for that track reloads on its own.
    act(() => invalidateLyrics('cache-1'))
    await waitFor(() => expect(h.resolve).toHaveBeenCalledTimes(2))
    await waitFor(() => {
      const s = second.result.current
      expect(s.status === 'ready' && s.lyrics.kind === 'plain' && s.lyrics.parsed.lines[0]!.text).toBe('new')
    })
  })

  it('ignores invalidations of other tracks', async () => {
    const t = track('cache-2')
    h.resolve.mockResolvedValue(plain('x'))
    const r = renderHook(() => useLyrics(t))
    await waitFor(() => expect(r.result.current.status).toBe('ready'))
    act(() => invalidateLyrics('some-other-track'))
    expect(h.resolve).toHaveBeenCalledTimes(1)
  })

  it('does not cache a response that was in flight when the lyrics were invalidated', async () => {
    const t = track('cache-3')
    let release!: (l: Lyrics) => void
    h.resolve.mockImplementationOnce(() => new Promise<Lyrics>((res) => (release = res)))
    const r = renderHook(() => useLyrics(t))
    await waitFor(() => expect(h.resolve).toHaveBeenCalledTimes(1))
    h.resolve.mockResolvedValueOnce(plain('fresh'))
    act(() => invalidateLyrics('cache-3'))
    await waitFor(() => expect(h.resolve).toHaveBeenCalledTimes(2))
    await act(async () => release(plain('stale')))
    await waitFor(() => {
      const s = r.result.current
      expect(s.status === 'ready' && s.lyrics.kind === 'plain' && s.lyrics.parsed.lines[0]!.text).toBe('fresh')
    })
    r.unmount()
    const again = renderHook(() => useLyrics(t))
    await waitFor(() => expect(again.result.current.status).toBe('ready'))
    const s = again.result.current
    expect(s.status === 'ready' && s.lyrics.kind === 'plain' && s.lyrics.parsed.lines[0]!.text).toBe('fresh')
  })

  it('reports errors', async () => {
    h.resolve.mockRejectedValue(new Error('boom'))
    const t = track('cache-4')
    const r = renderHook(() => useLyrics(t))
    await waitFor(() => expect(r.result.current.status).toBe('error'))
  })

  it('wires the server fetcher only when the server has the lyrics capability', async () => {
    h.server = true
    h.resolve.mockResolvedValue({ kind: 'none' })
    const t5 = track('cache-5')
    renderHook(() => useLyrics(t5))
    await waitFor(() => expect(h.resolve).toHaveBeenCalled())
    expect(h.resolve.mock.calls[0]![1].server).toBeTypeOf('function')
    h.resolve.mockClear()
    h.server = false
    const t6 = track('cache-6')
    renderHook(() => useLyrics(t6))
    await waitFor(() => expect(h.resolve).toHaveBeenCalled())
    expect(h.resolve.mock.calls[0]![1].server).toBeUndefined()
  })
})
