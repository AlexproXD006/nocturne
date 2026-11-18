// @vitest-environment node
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/* eslint-disable @typescript-eslint/no-explicit-any */
const MOCK = resolve(__dirname, '../../mock-server')
const { getCatalog } = (await import(/* @vite-ignore */ `${MOCK}/catalog.mjs`)) as any
const { createLibrary } = (await import(/* @vite-ignore */ `${MOCK}/library.mjs`)) as any
const { statsSummary, statsHistory, periodStart, fakePlays } = (await import(/* @vite-ignore */ `${MOCK}/stats.mjs`)) as any

const NOW = Date.UTC(2026, 10, 18, 12) // Wed 2026-11-18
const catalog = createLibrary(getCatalog())
const ctx = { catalog, origin: 'http://mock', liked: new Set<string>() }

describe('mock stats', () => {
  it('weeks start on Monday', () => {
    expect(periodStart('week', new Date(Date.UTC(2026, 10, 18)), 0).toISOString().slice(0, 10)).toBe('2026-11-16')
    expect(periodStart('week', new Date(Date.UTC(2026, 10, 18)), 1).toISOString().slice(0, 10)).toBe('2026-11-09')
  })

  it('is deterministic and summarises a week', () => {
    expect(fakePlays(catalog, 'u1', NOW)).toEqual(fakePlays(catalog, 'u1', NOW))
    const s = statsSummary(ctx, 'u1', NOW, 'week', 0, 5)
    expect(s.start).toBe('2026-11-16')
    expect(s.end).toBe('2026-11-23')
    expect(s.topTracks.length).toBeLessThanOrEqual(5)
    expect(s.totals.plays).toBeGreaterThan(0)
    expect(s.previous).not.toBeNull()
    expect(s.delta.plays).toBe(s.totals.plays - s.previous.plays)
    expect(s.topArtists[0].artist.image).toMatch(/^http/)
    const plays = s.topTracks.map((t: any) => t.plays)
    expect([...plays].sort((a, b) => b - a)).toEqual(plays)
  })

  it('all-time has no previous period; history is oldest-first and sums to the summary', () => {
    const all = statsSummary(ctx, 'u1', NOW, 'all', 3, 10)
    expect(all.previous).toBeNull()
    expect(all.delta).toBeNull()
    expect(all.offset).toBe(0)
    const h = statsHistory(catalog, 'u1', NOW, 'week', 4)
    expect(h.items).toHaveLength(4)
    expect(h.items.map((i: any) => i.start)).toEqual(['2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16'])
    expect(h.items[3].minutes).toBe(statsSummary(ctx, 'u1', NOW, 'week', 0, 1).totals.minutes)
  })
})
