import { describe, expect, it, vi } from 'vitest'
import { OFFSET_MAX_MS, clampOffset, formatOffset, lyricsTime, seekTimeFor } from '@/lyrics/offset'
import { findActiveLine, parseLrc } from '@/lyrics/lrc'
import { resolveLyrics } from '@/lyrics/service'
import { track } from '../helpers/fixtures'

describe('lyrics offset logic', () => {
  it('clamps to +-30 s and rounds', () => {
    expect(clampOffset(99999)).toBe(OFFSET_MAX_MS)
    expect(clampOffset(-99999)).toBe(-OFFSET_MAX_MS)
    expect(clampOffset(499.6)).toBe(500)
    expect(clampOffset(Number.NaN)).toBe(0)
  })

  it('formats like +1.0s / −0.5s / 0.0s', () => {
    expect(formatOffset(1000)).toBe('+1.0s')
    expect(formatOffset(-500)).toBe('−0.5s')
    expect(formatOffset(0)).toBe('0.0s')
    expect(formatOffset(1250)).toBe('+1.3s')
  })

  it('positive offset delays the highlight, negative advances it', () => {
    const lines = parseLrc('[00:01.00] a\n[00:05.00] b').lines
    // At 5.2 s of playback line b is active; with +1 s the lyrics are 1 s later, so line a still is.
    expect(findActiveLine(lines, lyricsTime(5200, 0))).toBe(1)
    expect(findActiveLine(lines, lyricsTime(5200, 1000))).toBe(0)
    expect(findActiveLine(lines, lyricsTime(4500, -1000))).toBe(1)
  })

  it('seeks to the shifted line time', () => {
    expect(seekTimeFor(5000, 1000)).toBe(6)
    expect(seekTimeFor(500, -2000)).toBe(0)
  })
})

describe('resolveLyrics offset and admin priority', () => {
  const lrclibSynced = { kind: 'synced' as const, text: '[00:01.00] lrclib', plain: null, source: 'lrclib' as const }
  const mk = (server: object) => ({ lrclib: { find: vi.fn(async () => lrclibSynced) }, server: vi.fn(async () => server as never) })

  it('carries the server offsetMs on the winning source', async () => {
    const r = await resolveLyrics(track('t1'), mk({ synced: null, plain: null, offsetMs: 1500 }))
    expect(r).toMatchObject({ kind: 'synced', source: 'lrclib', offsetMs: 1500 })
  })

  it('omits offsetMs when it is 0 or missing', async () => {
    const r = await resolveLyrics(track('t1'), mk({ synced: null, plain: null, offsetMs: 0 }))
    expect(r).not.toHaveProperty('offsetMs')
  })

  it('admin-stored LRC beats LRCLIB', async () => {
    const r = await resolveLyrics(track('t1'), mk({ synced: '[00:02.00] admin', plain: null, source: 'admin', offsetMs: -500 }))
    expect(r).toMatchObject({ kind: 'synced', source: 'server', offsetMs: -500 })
    expect(r.kind === 'synced' && r.parsed.lines[0]!.text).toBe('admin')
  })

  it('admin-stored plain text beats LRCLIB', async () => {
    const r = await resolveLyrics(track('t1'), mk({ synced: null, plain: 'one\ntwo', source: 'admin' }))
    expect(r).toMatchObject({ kind: 'plain', source: 'server' })
  })

  it('a non-admin server LRC still loses to LRCLIB', async () => {
    const r = await resolveLyrics(track('t1'), mk({ synced: '[00:02.00] file', plain: null }))
    expect(r).toMatchObject({ source: 'lrclib' })
  })
})
