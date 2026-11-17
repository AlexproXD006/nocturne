import { beforeEach, describe, expect, it } from 'vitest'
import { useNav, type Route } from '@/store/nav'

const s = (): ReturnType<typeof useNav.getState> => useNav.getState()
const album = (id: string): Route => ({ name: 'album', id })

beforeEach(() => {
  s().reset()
})

describe('initial state', () => {
  it('starts on home with no history', () => {
    expect(s().route).toEqual({ name: 'home' })
    expect(s().stack).toEqual([{ name: 'home' }])
    expect(s().index).toBe(0)
    expect(s().canBack).toBe(false)
    expect(s().canForward).toBe(false)
  })
})

describe('go', () => {
  it('pushes a route and enables back', () => {
    s().go(album('1'))
    expect(s().route).toEqual(album('1'))
    expect(s().index).toBe(1)
    expect(s().canBack).toBe(true)
    expect(s().canForward).toBe(false)
  })

  it('ignores navigation to the identical route', () => {
    s().go(album('1'))
    s().go(album('1'))
    expect(s().stack).toHaveLength(2)
    s().go({ name: 'home' })
    s().go({ name: 'home' })
    expect(s().stack).toHaveLength(3)
  })

  it('treats routes with different params as different', () => {
    s().go({ name: 'search', q: 'a' })
    s().go({ name: 'search', q: 'b' })
    s().go({ name: 'search' })
    expect(s().stack).toHaveLength(4)
  })

  it('compares routes regardless of object identity', () => {
    s().go({ name: 'library', tab: 'albums' })
    s().go({ name: 'library', tab: 'albums' })
    expect(s().stack).toHaveLength(2)
  })

  it('drops the forward history when navigating after going back', () => {
    s().go(album('1'))
    s().go(album('2'))
    s().back()
    s().go(album('3'))
    expect(s().stack).toEqual([{ name: 'home' }, album('1'), album('3')])
    expect(s().canForward).toBe(false)
    expect(s().index).toBe(2)
  })

  it('keeps at most 50 entries, dropping the oldest', () => {
    for (let i = 0; i < 70; i++) s().go(album(String(i)))
    expect(s().stack).toHaveLength(50)
    expect(s().index).toBe(49)
    expect(s().route).toEqual(album('69'))
    expect(s().stack[0]).toEqual(album('20'))
    expect(s().canBack).toBe(true)
  })

  it('cap applies when going after back as well', () => {
    for (let i = 0; i < 60; i++) s().go(album(String(i)))
    for (let i = 0; i < 10; i++) s().back()
    s().go(album('new'))
    expect(s().stack).toHaveLength(41)
    expect(s().route).toEqual(album('new'))
  })
})

describe('back / forward', () => {
  it('moves through history', () => {
    s().go(album('1'))
    s().go(album('2'))
    s().back()
    expect(s().route).toEqual(album('1'))
    expect(s().canForward).toBe(true)
    s().back()
    expect(s().route).toEqual({ name: 'home' })
    expect(s().canBack).toBe(false)
    s().forward()
    s().forward()
    expect(s().route).toEqual(album('2'))
    expect(s().canForward).toBe(false)
  })

  it('does nothing at the ends', () => {
    s().back()
    expect(s().index).toBe(0)
    s().forward()
    expect(s().index).toBe(0)
    s().go(album('1'))
    s().forward()
    expect(s().index).toBe(1)
    expect(s().route).toEqual(album('1'))
  })
})

describe('replace', () => {
  it('swaps the current entry without growing history', () => {
    s().go(album('1'))
    s().replace(album('1b'))
    expect(s().route).toEqual(album('1b'))
    expect(s().stack).toEqual([{ name: 'home' }, album('1b')])
    expect(s().index).toBe(1)
  })

  it('keeps forward history intact', () => {
    s().go(album('1'))
    s().go(album('2'))
    s().back()
    s().replace(album('x'))
    expect(s().stack).toEqual([{ name: 'home' }, album('x'), album('2')])
    expect(s().canForward).toBe(true)
  })

  it('does not mutate the previous stack array', () => {
    const before = s().stack
    s().replace({ name: 'settings' })
    expect(before).toEqual([{ name: 'home' }])
    expect(s().stack).not.toBe(before)
  })

  it('works on the first entry', () => {
    s().replace({ name: 'liked' })
    expect(s().route).toEqual({ name: 'liked' })
    expect(s().canBack).toBe(false)
  })
})

describe('reset', () => {
  it('returns to a single home entry', () => {
    s().go(album('1'))
    s().go(album('2'))
    s().reset()
    expect(s().stack).toEqual([{ name: 'home' }])
    expect(s().route).toEqual({ name: 'home' })
    expect(s().canBack).toBe(false)
  })
})
