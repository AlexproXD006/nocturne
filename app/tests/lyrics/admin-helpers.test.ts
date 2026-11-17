import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminTrack } from '@/api/types'
import { track } from '../helpers/fixtures'

const h = vi.hoisted(() => ({
  api: { adminSetLyrics: vi.fn(), adminDeleteLyrics: vi.fn() },
  invalidate: vi.fn(),
  invalidateLyrics: vi.fn()
}))

vi.mock('@/services', () => ({ api: h.api, lrclib: { find: vi.fn() }, useSession: Object.assign(() => false, { getState: () => ({}) }) }))
vi.mock('@/lib/resource', () => ({ resources: { invalidate: h.invalidate } }))
vi.mock('@/hooks/useLyrics', () => ({ invalidateLyrics: h.invalidateLyrics }))

import { createPool, findCandidates, selectBest } from '@/pages/admin/lyrics/bulk'
import { isLyricsFileName, loadLyricsFile, readLyricsFile, removeLyrics, saveLyrics, uploadLyricsFile } from '@/pages/admin/lyrics/files'

const song = (id: string, title: string, artist: string): AdminTrack => ({ ...track(id, { title, artists: [{ id: id, name: artist }], duration: 200 }) })

beforeEach(() => {
  Object.values(h.api).forEach((f) => f.mockReset().mockResolvedValue(undefined))
  h.invalidate.mockReset()
  h.invalidateLyrics.mockReset()
})

describe('createPool', () => {
  it('never runs more than the concurrency limit and drains when done', async () => {
    const pool = createPool(3)
    let running = 0
    let peak = 0
    let done = 0
    for (let i = 0; i < 10; i++) {
      pool.push(async () => {
        running++
        peak = Math.max(peak, running)
        await new Promise((r) => setTimeout(r, 5))
        running--
        done++
      })
    }
    expect(pool.pending).toBe(10)
    await pool.drain()
    expect(done).toBe(10)
    expect(peak).toBe(3)
    expect(pool.pending).toBe(0)
    await expect(pool.drain()).resolves.toBeUndefined()
  })

  it('keeps going after a task throws', async () => {
    const pool = createPool(1)
    const ran: number[] = []
    pool.push(async () => {
      throw new Error('x')
    })
    pool.push(async () => {
      ran.push(2)
    })
    await pool.drain()
    expect(ran).toEqual([2])
  })

  it('clear drops queued tasks but lets running ones finish', async () => {
    const pool = createPool(1)
    const ran: number[] = []
    pool.push(async () => {
      await new Promise((r) => setTimeout(r, 5))
      ran.push(1)
    })
    pool.push(async () => {
      ran.push(2)
    })
    pool.clear()
    await pool.drain()
    expect(ran).toEqual([1])
  })

  it('clear on an idle pool resolves waiters', async () => {
    const pool = createPool(1)
    pool.clear()
    await expect(pool.drain()).resolves.toBeUndefined()
  })
})

describe('findCandidates', () => {
  const signal = new AbortController().signal

  it('returns nothing without a title and does not search', async () => {
    const search = vi.fn()
    expect(await findCandidates({ artist: 'x' }, search, signal)).toEqual([])
    expect(search).not.toHaveBeenCalled()
  })

  it('searches "artist title" and stops when it finds something', async () => {
    const a = song('a', 'T', 'A')
    const search = vi.fn().mockResolvedValue([a, a])
    expect(await findCandidates({ title: ' T ', artist: ' A ' }, search, signal)).toEqual([a])
    expect(search).toHaveBeenCalledTimes(1)
    expect(search).toHaveBeenCalledWith('A T', signal)
  })

  it('falls back to the title alone when the combined search is empty', async () => {
    const a = song('a', 'T', 'Other')
    const search = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([a])
    expect(await findCandidates({ title: 'T', artist: 'A' }, search, signal)).toEqual([a])
    expect(search.mock.calls.map((c) => c[0])).toEqual(['A T', 'T'])
  })

  it('searches the title once when there is no artist', async () => {
    const search = vi.fn().mockResolvedValue([])
    expect(await findCandidates({ title: 'T' }, search, signal)).toEqual([])
    expect(search).toHaveBeenCalledTimes(1)
    expect(search).toHaveBeenCalledWith('T', signal)
  })

  it('propagates search errors', async () => {
    await expect(findCandidates({ title: 'T' }, vi.fn().mockRejectedValue(new Error('down')), signal)).rejects.toThrow('down')
  })
})

describe('selectBest', () => {
  const desc = { format: 'ttml' as const, valid: true, title: 'Paper Lanterns', artist: 'Mira Vale' }
  it('pre-checks only automatic matches', () => {
    const r = selectBest(desc, [song('a', 'Paper Lanterns', 'Mira Vale')], 0.75)
    expect(r).toMatchObject({ selected: { id: 'a' }, checked: true })
    const review = selectBest(desc, [song('b', 'Paper Lanterns', 'Nobody')], 0.75)
    expect(review).toMatchObject({ selected: { id: 'b' }, checked: false })
    expect(selectBest(desc, [song('c', 'Other', 'Else')], 0.75)).toEqual({ selected: null, score: 0, checked: false })
  })
})

describe('files', () => {
  it('recognises lyrics file names', () => {
    for (const n of ['a.ttml', 'a.TTML', 'a.xml', 'a.dfxp', 'a.lrc']) expect(isLyricsFileName(n)).toBe(true)
    for (const n of ['a.mp3', 'a.txt', 'ttml', 'a.ttml.bak']) expect(isLyricsFileName(n)).toBe(false)
  })

  it('reads text, rejecting empty and oversized files before reading', async () => {
    expect(await readLyricsFile(new Blob(['héllo']))).toBe('héllo')
    await expect(readLyricsFile(new Blob([]))).rejects.toThrow(/empty/)
    const big = { size: 2 * 1024 * 1024, text: vi.fn() } as unknown as Blob
    await expect(readLyricsFile(big)).rejects.toThrow(/1 MiB/)
    expect((big as unknown as { text: ReturnType<typeof vi.fn> }).text).not.toHaveBeenCalled()
  })

  it('falls back to FileReader when Blob.text is missing', async () => {
    const blob = new Blob(['abc'])
    Object.defineProperty(blob, 'text', { value: undefined })
    expect(await readLyricsFile(blob)).toBe('abc')
  })

  it('loadLyricsFile never rejects', async () => {
    const ok = await loadLyricsFile(new File(['[00:01.00] hi'], 'a.lrc'))
    expect(ok.desc).toMatchObject({ valid: true, format: 'lrc' })
    expect(ok.content).toBe('[00:01.00] hi')
    expect((await loadLyricsFile(new File(['x'], 'a.mp3'))).desc).toMatchObject({ valid: false, error: expect.stringContaining('Not a lyrics file') })
    expect((await loadLyricsFile(new File([], 'a.ttml'))).desc).toMatchObject({ valid: false, format: 'ttml', error: expect.stringContaining('empty') })
    expect((await loadLyricsFile(new File([], 'a.lrc'))).desc.format).toBe('lrc')
  })

  it('saveLyrics stores, clears the lyrics cache and refreshes resources', async () => {
    await saveLyrics('t1', 'lrc', 'c')
    expect(h.api.adminSetLyrics).toHaveBeenCalledWith('t1', { format: 'lrc', content: 'c' })
    expect(h.invalidateLyrics).toHaveBeenCalledWith('t1')
    expect(h.invalidate).toHaveBeenCalledWith('')
    h.invalidate.mockClear()
    await saveLyrics('t2', 'ttml', 'c', { skipResources: true })
    expect(h.invalidate).not.toHaveBeenCalled()
  })

  it('saveLyrics does not touch caches when the server refuses', async () => {
    h.api.adminSetLyrics.mockRejectedValue(new Error('400'))
    await expect(saveLyrics('t1', 'lrc', 'c')).rejects.toThrow('400')
    expect(h.invalidateLyrics).not.toHaveBeenCalled()
  })

  it('removeLyrics deletes and refreshes', async () => {
    await removeLyrics('t9')
    expect(h.api.adminDeleteLyrics).toHaveBeenCalledWith('t9')
    expect(h.invalidateLyrics).toHaveBeenCalledWith('t9')
    expect(h.invalidate).toHaveBeenCalledWith('')
  })

  it('uploadLyricsFile validates before sending anything', async () => {
    await expect(uploadLyricsFile('t1', new File(['nothing'], 'a.lrc'))).rejects.toThrow(/timestamps/)
    await expect(uploadLyricsFile('t1', new File(['<tt>'], 'a.ttml'))).rejects.toThrow(/XML/)
    expect(h.api.adminSetLyrics).not.toHaveBeenCalled()
    expect(await uploadLyricsFile('t1', new File(['[00:01.00] hi'], 'a.lrc'))).toBe('lrc')
    expect(h.api.adminSetLyrics).toHaveBeenCalledWith('t1', { format: 'lrc', content: '[00:01.00] hi' })
  })
})
