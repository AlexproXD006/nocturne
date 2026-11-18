import { describe, expect, it } from 'vitest'
import { RECAP_H, RECAP_W, drawRecapCard, ellipsize, parseAccent } from '@/lib/recapCard'
import type { RecapData } from '@/lib/stats'

describe('parseAccent', () => {
  it('parses "R G B", comma and hex forms and falls back otherwise', () => {
    expect(parseAccent('120 40 200')).toEqual([120, 40, 200])
    expect(parseAccent(' 1, 2, 3 ')).toEqual([1, 2, 3])
    expect(parseAccent('#ff8000')).toEqual([255, 128, 0])
    expect(parseAccent('')).toEqual([29, 185, 84])
    expect(parseAccent('300 0 0')).toEqual([29, 185, 84])
    expect(parseAccent(null)).toEqual([29, 185, 84])
  })
})

/** A recording 2D context: monospace-ish measurement, logs every fillText. */
function fakeCanvas(): { canvas: HTMLCanvasElement; texts: string[]; arcs: number } {
  const texts: string[] = []
  let arcs = 0
  const ctx = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'measureText') return (s: string) => ({ width: s.length * 10 })
        if (prop === 'fillText') return (s: string) => void texts.push(s)
        if (prop === 'arc') return () => void arcs++
        if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => ({ addColorStop: () => undefined })
        return () => undefined
      },
      set: () => true
    }
  )
  const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement
  return { canvas, texts, arcs: 0, get arcCount() { return arcs } } as never
}

const data: RecapData = {
  heading: 'Weekly recap',
  periodLabel: 'Nov 16 – 22, 2026',
  totalMinutes: 1234,
  plays: 300,
  delta: { direction: 'up', text: '+23% vs last week' },
  artists: [
    { name: 'Artist 0', image: null, minutes: 100 },
    { name: 'A very very very very very long artist name that cannot fit on one line at all', image: null, minutes: 90 }
  ],
  topTrack: { title: 'Song', artist: 'Ada', coverUrl: null, plays: 12 }
}

describe('ellipsize', () => {
  it('keeps short text and truncates long text to the width', () => {
    const { canvas } = fakeCanvas()
    const ctx = canvas.getContext('2d')!
    expect(ellipsize(ctx, 'abc', 100)).toBe('abc')
    const out = ellipsize(ctx, 'abcdefghijklmnopqrstuvwxyz', 100)
    expect(out.endsWith('…')).toBe(true)
    expect(out.length * 10).toBeLessThanOrEqual(100)
  })
})

describe('drawRecapCard', () => {
  it('sizes the canvas 1080×1920 and draws the data without images', () => {
    const f = fakeCanvas()
    drawRecapCard(f.canvas, data, { artists: [], cover: null }, [29, 185, 84])
    expect(f.canvas.width).toBe(RECAP_W)
    expect(f.canvas.height).toBe(RECAP_H)
    expect([RECAP_W, RECAP_H]).toEqual([1080, 1920])
    expect(f.texts).toContain('1,234')
    expect(f.texts).toContain('minutes listened')
    expect(f.texts).toContain('Nov 16 – 22, 2026')
    expect(f.texts).toContain('♪ Nocturne')
    expect(f.texts).toContain('TOP ARTISTS')
    expect(f.texts).toContain('TOP TRACK')
    expect(f.texts).toContain('Song')
    expect(f.texts).toContain('A') // initial placeholder for a missing photo
    expect(f.texts.some((t) => t.endsWith('…'))).toBe(true)
  })

  it('omits the top-track section when there is none', () => {
    const f = fakeCanvas()
    drawRecapCard(f.canvas, { ...data, topTrack: null }, { artists: [], cover: null }, [1, 2, 3])
    expect(f.texts).not.toContain('TOP TRACK')
  })
})
