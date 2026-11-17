import { describe, expect, it } from 'vitest'
import { LruCache } from '@/lib/lru'

describe('LruCache', () => {
  it('rejects non-positive sizes', () => {
    expect(() => new LruCache(0)).toThrow('LRU size must be positive')
    expect(() => new LruCache(-1)).toThrow()
    expect(() => new LruCache(NaN)).toThrow()
  })

  it('stores and reads values', () => {
    const c = new LruCache<string, number>(3)
    c.set('a', 1).set('b', 2)
    expect(c.get('a')).toBe(1)
    expect(c.get('missing')).toBeUndefined()
    expect(c.has('b')).toBe(true)
    expect(c.has('z')).toBe(false)
    expect(c.size).toBe(2)
  })

  it('evicts the least recently used entry beyond capacity', () => {
    const c = new LruCache<string, number>(2)
    c.set('a', 1).set('b', 2).set('c', 3)
    expect(c.has('a')).toBe(false)
    expect(c.keys()).toEqual(['b', 'c'])
    expect(c.size).toBe(2)
  })

  it('get refreshes recency', () => {
    const c = new LruCache<string, number>(2)
    c.set('a', 1).set('b', 2)
    c.get('a')
    c.set('c', 3)
    expect(c.has('a')).toBe(true)
    expect(c.has('b')).toBe(false)
  })

  it('set on an existing key updates the value and refreshes recency without growing', () => {
    const c = new LruCache<string, number>(2)
    c.set('a', 1).set('b', 2).set('a', 10).set('c', 3)
    expect(c.get('a')).toBe(10)
    expect(c.has('b')).toBe(false)
    expect(c.size).toBe(2)
  })

  it('peek and has do not refresh recency', () => {
    const c = new LruCache<string, number>(2)
    c.set('a', 1).set('b', 2)
    expect(c.peek('a')).toBe(1)
    expect(c.has('a')).toBe(true)
    c.set('c', 3)
    expect(c.has('a')).toBe(false)
    expect(c.peek('nope')).toBeUndefined()
  })

  it('stores falsy and undefined-ish values correctly', () => {
    const c = new LruCache<string, number | null>(3)
    c.set('zero', 0).set('null', null)
    expect(c.get('zero')).toBe(0)
    expect(c.get('null')).toBeNull()
    expect(c.has('null')).toBe(true)
  })

  it('delete and clear', () => {
    const c = new LruCache<string, number>(3)
    c.set('a', 1).set('b', 2)
    expect(c.delete('a')).toBe(true)
    expect(c.delete('a')).toBe(false)
    expect(c.size).toBe(1)
    c.clear()
    expect(c.size).toBe(0)
    expect(c.keys()).toEqual([])
  })

  it('keys returns a snapshot ordered oldest to newest', () => {
    const c = new LruCache<string, number>(3)
    c.set('a', 1).set('b', 2).set('c', 3)
    c.get('a')
    const keys = c.keys()
    expect(keys).toEqual(['b', 'c', 'a'])
    c.clear()
    expect(keys).toEqual(['b', 'c', 'a'])
  })

  it('capacity of 1 keeps only the latest', () => {
    const c = new LruCache<string, number>(1)
    c.set('a', 1).set('b', 2)
    expect(c.keys()).toEqual(['b'])
  })
})
