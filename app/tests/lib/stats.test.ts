import { describe, expect, it } from 'vitest'
import { barRatios, buildRecapData, canGoForward, describeDelta, formatBigMinutes, formatMinutes, shortDate } from '@/lib/stats'
import type { StatsSummary } from '@/api/types'

const track = (id: string, title: string) => ({
  id,
  title,
  artists: [{ id: 'a1', name: 'Ada' }, { id: 'a2', name: 'Bo' }],
  album: { id: 'al', title: 'Alb' },
  duration: 200,
  artwork: [{ url: 'https://x/300', width: 300 }, { url: 'https://x/640', width: 640 }]
})

const summary = (over: Partial<StatsSummary> = {}): StatsSummary => ({
  range: 'week',
  offset: 0,
  start: '2026-11-16',
  end: '2026-11-23',
  label: 'Nov 16 – 22, 2026',
  totals: { minutes: 1234.4, plays: 300, distinctTracks: 80, distinctArtists: 20 },
  previous: { minutes: 1000, plays: 250, distinctTracks: 70, distinctArtists: 18 },
  delta: { minutes: 234.4, minutesPct: 23.4, plays: 50 },
  topTracks: [{ track: track('t1', 'Song'), plays: 12, minutes: 40 }],
  topArtists: Array.from({ length: 7 }, (_, i) => ({
    artist: { id: `a${i}`, name: `Artist ${i}`, artwork: [], image: i % 2 ? null : `https://cdn/${i}.jpg` },
    plays: 10 - i,
    minutes: 100 - i
  })),
  topAlbums: [],
  ...over
})

describe('formatMinutes', () => {
  it('formats minutes and hours', () => {
    expect(formatMinutes(0)).toBe('0 min')
    expect(formatMinutes(0.4)).toBe('<1 min')
    expect(formatMinutes(47.2)).toBe('47 min')
    expect(formatMinutes(120)).toBe('2 h')
    expect(formatMinutes(135)).toBe('2 h 15 min')
    expect(formatMinutes(Number.NaN)).toBe('0 min')
  })
  it('formats the big number', () => {
    expect(formatBigMinutes(1234.4)).toBe('1,234')
    expect(formatBigMinutes(-5)).toBe('0')
  })
})

describe('describeDelta', () => {
  it('describes increases, decreases and ties', () => {
    expect(describeDelta({ minutes: 10, minutesPct: 25, plays: 1 }, 'week')).toEqual({ direction: 'up', text: '+25% vs last week' })
    expect(describeDelta({ minutes: -90, minutesPct: -12.4, plays: -1 }, 'month')).toEqual({ direction: 'down', text: '-12% vs last month' })
    expect(describeDelta({ minutes: 90, minutesPct: null, plays: 1 }, 'year')).toEqual({ direction: 'up', text: '+1 h 30 min vs last year' })
    expect(describeDelta({ minutes: 0, minutesPct: 0, plays: 0 }, 'week')?.direction).toBe('flat')
  })
  it('has nothing for all-time or missing deltas', () => {
    expect(describeDelta(null, 'week')).toBeNull()
    expect(describeDelta({ minutes: 1, minutesPct: 1, plays: 1 }, 'all')).toBeNull()
  })
})

describe('navigation + chart helpers', () => {
  it('only allows going forward when in the past', () => {
    expect(canGoForward('week', 0)).toBe(false)
    expect(canGoForward('week', 2)).toBe(true)
    expect(canGoForward('all', 3)).toBe(false)
  })
  it('scales bars to the tallest with a minimum visible height', () => {
    const bars = barRatios([
      { start: '2026-11-02', minutes: 0, plays: 0 },
      { start: '2026-11-09', minutes: 1, plays: 1 },
      { start: '2026-11-16', minutes: 500, plays: 9 }
    ])
    expect(bars.map((b) => b.ratio)).toEqual([0, 0.03, 1])
    expect(barRatios([{ start: 'x', minutes: 0, plays: 0 }])[0]!.ratio).toBe(0)
    expect(barRatios([])).toEqual([])
  })
  it('formats ISO dates without timezone drift', () => {
    expect(shortDate('2026-11-16')).toBe('Nov 16')
    expect(shortDate('2026-01-01')).toBe('Jan 1')
    expect(shortDate('junk')).toBe('junk')
  })
})

describe('buildRecapData', () => {
  it('derives headline, top 5 artists with photos and the top track', () => {
    const d = buildRecapData(summary())
    expect(d.heading).toBe('Weekly recap')
    expect(d.periodLabel).toBe('Nov 16 – 22, 2026')
    expect(d.totalMinutes).toBe(1234.4)
    expect(d.delta?.text).toBe('+23% vs last week')
    expect(d.artists).toHaveLength(5)
    expect(d.artists[0]).toEqual({ name: 'Artist 0', image: 'https://cdn/0.jpg', minutes: 100 })
    expect(d.artists[1]!.image).toBeNull()
    expect(d.topTrack).toEqual({ title: 'Song', artist: 'Ada, Bo', coverUrl: 'https://x/640', plays: 12 })
  })
  it('handles empty periods and other ranges', () => {
    const d = buildRecapData(summary({ range: 'year', topTracks: [], topArtists: [], delta: null }))
    expect(d.heading).toBe('Yearly recap')
    expect(d.topTrack).toBeNull()
    expect(d.artists).toEqual([])
    expect(d.delta).toBeNull()
  })
})
