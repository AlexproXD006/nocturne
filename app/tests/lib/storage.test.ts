import { afterEach, describe, expect, it, vi } from 'vitest'
import { readJson, removeKey, writeJson } from '@/lib/storage'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('readJson', () => {
  it('returns the fallback when the key is missing', () => {
    expect(readJson('missing', { a: 1 })).toEqual({ a: 1 })
  })

  it('parses stored JSON', () => {
    localStorage.setItem('k', JSON.stringify({ x: [1, 2] }))
    expect(readJson('k', null)).toEqual({ x: [1, 2] })
  })

  it('returns the fallback for invalid JSON', () => {
    localStorage.setItem('k', '{oops')
    expect(readJson('k', 'fb')).toBe('fb')
  })

  it('applies the validator and falls back when it rejects', () => {
    localStorage.setItem('k', JSON.stringify(5))
    const isString = (v: unknown): v is string => typeof v === 'string'
    expect(readJson('k', 'fb', isString)).toBe('fb')
    localStorage.setItem('k', JSON.stringify('yes'))
    expect(readJson('k', 'fb', isString)).toBe('yes')
  })

  it('does not throw when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    expect(readJson('k', 'fb')).toBe('fb')
  })

  it('distinguishes a stored null from a missing key only through the fallback', () => {
    localStorage.setItem('k', 'null')
    expect(readJson<unknown>('k', 'fb')).toBeNull()
  })
})

describe('writeJson', () => {
  it('writes JSON', () => {
    writeJson('k', { a: 1 })
    expect(localStorage.getItem('k')).toBe('{"a":1}')
  })

  it('swallows quota / access errors', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    expect(() => writeJson('k', 1)).not.toThrow()
  })

  it('swallows serialization errors (circular structures)', () => {
    const a: Record<string, unknown> = {}
    a.self = a
    expect(() => writeJson('k', a)).not.toThrow()
    expect(localStorage.getItem('k')).toBeNull()
  })
})

describe('removeKey', () => {
  it('removes a key', () => {
    localStorage.setItem('k', '1')
    removeKey('k')
    expect(localStorage.getItem('k')).toBeNull()
  })

  it('swallows errors', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('nope')
    })
    expect(() => removeKey('k')).not.toThrow()
  })
})
