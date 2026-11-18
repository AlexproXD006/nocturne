import { describe, expect, it } from 'vitest'
import { artistNames, formatTime, formatTotal, greeting, plural } from '@/lib/format'

describe('formatTime', () => {
  it.each([
    [0, '0:00'],
    [5, '0:05'],
    [59, '0:59'],
    [60, '1:00'],
    [83, '1:23'],
    [83.9, '1:23'],
    [600, '10:00'],
    [3599, '59:59'],
    [3600, '1:00:00'],
    [3723, '1:02:03'],
    [36000, '10:00:00']
  ])('%d -> %s', (input, out) => {
    expect(formatTime(input)).toBe(out)
  })

  it.each([-1, NaN, Infinity, -Infinity])('treats %p as 0:00', (v) => {
    expect(formatTime(v)).toBe('0:00')
  })
})

describe('formatTotal', () => {
  it.each([
    [0, '0 min'],
    [-5, '0 min'],
    [NaN, '0 min'],
    [Infinity, '0 min'],
    [1, '1 min'],
    [29, '1 min'],
    [60, '1 min'],
    [47 * 60, '47 min'],
    [59 * 60 + 40, '1 hr'],
    [3600, '1 hr'],
    [3600 + 12 * 60, '1 hr 12 min'],
    [2 * 3600, '2 hr']
  ])('%d -> %s', (input, out) => {
    expect(formatTotal(input)).toBe(out)
  })
})

describe('artistNames', () => {
  it('joins names with commas', () => {
    expect(artistNames([{ id: '1', name: 'A' }, { id: '2', name: 'B' }])).toBe('A, B')
    expect(artistNames([{ id: '1', name: 'Solo' }])).toBe('Solo')
  })
  it('handles empty and undefined', () => {
    expect(artistNames([])).toBe('')
    expect(artistNames(undefined)).toBe('')
  })
})

describe('plural', () => {
  it('uses singular only for exactly one', () => {
    expect(plural(1)).toBe('1 song')
    expect(plural(0)).toBe('0 songs')
    expect(plural(2)).toBe('2 songs')
  })
  it('supports another message and locale grouping', () => {
    expect(plural(2, 'common.play')).toBe('2 plays')
    expect(plural(1, 'common.play')).toBe('1 play')
    expect(plural(1234, 'common.play')).toBe('1,234 plays')
  })
})

describe('greeting', () => {
  it.each([
    [0, 'Good evening'],
    [4, 'Good evening'],
    [5, 'Good morning'],
    [11, 'Good morning'],
    [12, 'Good afternoon'],
    [17, 'Good afternoon'],
    [18, 'Good evening'],
    [23, 'Good evening']
  ])('hour %d -> %s', (h, out) => {
    expect(greeting(h)).toBe(out)
  })
})
