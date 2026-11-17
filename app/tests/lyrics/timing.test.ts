import { describe, expect, it } from 'vitest'
import type { LyricLine, LyricWord } from '@/lyrics/lrc'
import { GAP_MIN_MS, computeGaps, findActiveWord, findGap, wordProgress } from '@/lyrics/timing'

const W = (time: number, end: number, text = 'x'): LyricWord => ({ time, end, text })

describe('findActiveWord', () => {
  const words = [W(1000, 1500), W(1500, 2000), W(3000, 3500)]
  it.each([
    [0, -1],
    [999, -1],
    [1000, 0],
    [1499, 0],
    [1500, 1],
    [2500, 1],
    [3000, 2],
    [99_999, 2]
  ])('t=%i -> %i', (t, idx) => expect(findActiveWord(words, t)).toBe(idx))

  it('handles an empty list', () => expect(findActiveWord([], 5)).toBe(-1))
})

describe('wordProgress', () => {
  it('is 0 before, linear during and 1 after the word', () => {
    const w = W(1000, 2000)
    expect(wordProgress(w, 500)).toBe(0)
    expect(wordProgress(w, 1000)).toBe(0)
    expect(wordProgress(w, 1250)).toBe(0.25)
    expect(wordProgress(w, 2000)).toBe(1)
    expect(wordProgress(w, 9000)).toBe(1)
  })
  it('treats zero-length words as complete once started', () => {
    expect(wordProgress(W(1000, 1000), 1000)).toBe(0)
    expect(wordProgress(W(1000, 1000), 1001)).toBe(1)
  })
})

describe('computeGaps / findGap', () => {
  const lines: LyricLine[] = [
    { time: 8000, end: 10_000, text: 'a' },
    { time: 12_000, end: 14_000, text: 'b' },
    { time: 30_000, end: 32_000, text: 'c' }
  ]

  it('finds the intro gap and gaps of at least 6 s between a line end and the next start', () => {
    expect(computeGaps(lines)).toEqual([
      { before: 0, start: 0, end: 8000 },
      { before: 2, start: 14_000, end: 30_000 }
    ])
  })

  it('skips an intro shorter than the minimum and gaps just below it', () => {
    expect(computeGaps([{ time: 5000, end: 6000, text: 'a' }, { time: 6000 + GAP_MIN_MS - 1, end: 20_000, text: 'b' }])).toEqual([])
    expect(computeGaps([{ time: 0, end: 1000, text: 'a' }, { time: 1000 + GAP_MIN_MS, end: 20_000, text: 'b' }])).toEqual([
      { before: 1, start: 1000, end: 1000 + GAP_MIN_MS }
    ])
  })

  it('never reports gaps for lyrics without line ends (plain LRC)', () => {
    expect(computeGaps([{ time: 0, text: 'a' }, { time: 60_000, text: 'b' }])).toEqual([])
    expect(computeGaps([])).toEqual([])
  })

  it('accounts for overlapping lines using the furthest end seen', () => {
    const overlap: LyricLine[] = [
      { time: 1000, end: 30_000, text: 'long' },
      { time: 2000, end: 3000, text: 'short' },
      { time: 33_000, end: 34_000, text: 'later' }
    ]
    expect(computeGaps(overlap)).toEqual([])
  })

  it('does not open a gap after a line that lacks an end', () => {
    const mixed: LyricLine[] = [{ time: 1000, end: 2000, text: 'a' }, { time: 3000, text: 'b' }, { time: 40_000, end: 41_000, text: 'c' }]
    expect(computeGaps(mixed)).toEqual([])
  })

  it('findGap locates the containing gap (end exclusive)', () => {
    const gaps = computeGaps(lines)
    expect(findGap(gaps, 0)).toBe(0)
    expect(findGap(gaps, 7999)).toBe(0)
    expect(findGap(gaps, 8000)).toBe(-1)
    expect(findGap(gaps, 20_000)).toBe(1)
    expect(findGap(gaps, 30_000)).toBe(-1)
    expect(findGap([], 5)).toBe(-1)
  })
})
