import { describe, expect, it } from 'vitest'
import { chunk, filterIndices, mapLimit, matchesQuery, normalizeText, selectionClick, toggleAll } from '@/lib/bulk'
import { track } from '../helpers/fixtures'

describe('search filter', () => {
  it('ignores case and accents', () => {
    expect(normalizeText('  ÁrBol Ñandú ')).toBe('arbol nandu')
    const t = track('1', { title: 'Canción de Cuna', artists: [{ id: 'a', name: 'Beyoncé' }], album: { id: 'x', title: 'Ópera' } })
    expect(matchesQuery(t, 'cancion')).toBe(true)
    expect(matchesQuery(t, 'BEYONCE')).toBe(true)
    expect(matchesQuery(t, 'opera cuna')).toBe(true)
    expect(matchesQuery(t, 'jazz')).toBe(false)
  })
  it('returns original indices; empty query keeps all', () => {
    const list = [track('a', { title: 'Alpha' }), track('b', { title: 'Beta' }), track('c', { title: 'alphabet' })]
    expect(filterIndices(list, 'alph')).toEqual([0, 2])
    expect(filterIndices(list, '  ')).toEqual([0, 1, 2])
  })
})

describe('chunking', () => {
  it('splits into fixed-size parts', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunk(Array.from({ length: 1200 }, (_, i) => i)).map((c) => c.length)).toEqual([500, 500, 200])
    expect(chunk([])).toEqual([])
  })
  it('mapLimit never exceeds the limit and runs everything', async () => {
    let live = 0
    let peak = 0
    const done: number[] = []
    await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      live++
      peak = Math.max(peak, live)
      await new Promise((r) => setTimeout(r, 2))
      live--
      done.push(n)
    })
    expect(peak).toBeLessThanOrEqual(3)
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7])
  })
})

describe('selection', () => {
  const keys = ['a', 'b', 'c', 'd', 'e']
  const empty = { selected: new Set<string>(), anchor: null }
  it('toggles single rows', () => {
    const s1 = selectionClick(empty, 'b', keys, false)
    expect([...s1.selected]).toEqual(['b'])
    expect(selectionClick(s1, 'b', keys, false).selected.size).toBe(0)
  })
  it('shift extends a range from the anchor, in either direction', () => {
    const s1 = selectionClick(empty, 'b', keys, false)
    expect([...selectionClick(s1, 'd', keys, true).selected].sort()).toEqual(['b', 'c', 'd'])
    const s2 = selectionClick(empty, 'd', keys, false)
    expect([...selectionClick(s2, 'b', keys, true).selected].sort()).toEqual(['b', 'c', 'd'])
  })
  it('select all respects the visible keys and toggles off', () => {
    const all = toggleAll(empty, ['b', 'c'])
    expect([...all.selected]).toEqual(['b', 'c'])
    expect(toggleAll(all, ['b', 'c']).selected.size).toBe(0)
  })
})
