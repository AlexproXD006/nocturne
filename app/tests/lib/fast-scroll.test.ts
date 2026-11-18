import { describe, expect, it } from 'vitest'
import { bubbleLabel, fractionToIndex, fractionToScrollTop, isLongList, letterFor, scrollTopToFraction, sortText } from '@/lib/fastScroll'

describe('fast scroll helpers', () => {
  it('maps handle position to index, last position = last item', () => {
    expect(fractionToIndex(0, 1795)).toBe(0)
    expect(fractionToIndex(1, 1795)).toBe(1794)
    expect(fractionToIndex(0.5, 1795)).toBe(897)
    expect(fractionToIndex(2, 10)).toBe(9)
    expect(fractionToIndex(0.5, 0)).toBe(0)
  })
  it('maps fraction <-> scrollTop', () => {
    expect(fractionToScrollTop(0.5, 3000, 1000)).toBe(1000)
    expect(scrollTopToFraction(1000, 3000, 1000)).toBe(0.5)
    expect(scrollTopToFraction(10, 500, 500)).toBe(0)
  })
  it('picks letters, # for digits and symbols', () => {
    expect(letterFor('Álvaro')).toBe('A')
    expect(letterFor('  zeta')).toBe('Z')
    expect(letterFor('99 Problems')).toBe('#')
    expect(letterFor('¿Qué?')).toBe('#')
    expect(letterFor(undefined)).toBe('#')
  })
  it('reads the sort field', () => {
    const t = { title: 'T', artists: [{ name: 'Ar' }], album: { title: 'Al' } }
    expect([sortText(t, 'title'), sortText(t, 'artist'), sortText(t, 'album')]).toEqual(['T', 'Ar', 'Al'])
  })
  it('bubble shows letter when sorted, else position', () => {
    expect(bubbleLabel(4, 10, () => 'B')).toBe('B')
    expect(bubbleLabel(844, 1795, undefined, (n) => new Intl.NumberFormat('es', { useGrouping: 'always' }).format(n))).toBe('845 / 1.795')
  })
  it('is long over 60 items or 3 screens', () => {
    expect(isLongList(61, 0, 800)).toBe(true)
    expect(isLongList(60, 2000, 800)).toBe(false)
    expect(isLongList(10, 2500, 800)).toBe(true)
  })
})
