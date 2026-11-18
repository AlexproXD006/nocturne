import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services', () => ({ api: {}, platform: { kind: 'web' }, usePlayer: {}, useConnect: {} }))

import { Artwork } from '@/components/common'
import { MAX_ACTIVE, _stats } from '@/lib/artLoader'
import { thumbUrl } from '@/lib/url'

type Cb = (e: Array<{ target: Element; isIntersecting: boolean }>) => void
let cbs: Cb[] = []
let observed: Array<{ el: Element; cb: Cb }> = []

class FakeIO {
  cb: Cb
  constructor(cb: Cb) {
    this.cb = cb
    cbs.push(cb)
  }
  observe(el: Element): void {
    observed.push({ el, cb: this.cb })
  }
  unobserve(el: Element): void {
    observed = observed.filter((o) => o.el !== el)
  }
  disconnect(): void {}
}

const setIntersecting = (el: Element, v: boolean): void => {
  const o = observed.find((x) => x.el === el)!
  act(() => o.cb([{ target: el, isIntersecting: v }]))
}
const art = (n: number) => [{ url: `https://x.test/v1/media/art/t${n}?s=300&v=1&sig=a&exp=9`, width: 300 }]

describe('thumbUrl', () => {
  const u = 'https://x.test/v1/media/art/t1?s=300&v=1&sig=a&exp=9'
  it('snaps to the smallest covering bucket and keeps the rest of the URL', () => {
    expect(thumbUrl(u, 80)).toBe('https://x.test/v1/media/art/t1?s=96&v=1&sig=a&exp=9')
    expect(thumbUrl(u, 100)).toContain('s=128')
    expect(thumbUrl(u, 200)).toContain('s=256')
  })
  it('never upscales and ignores foreign urls', () => {
    expect(thumbUrl(u, 300)).toBe(u)
    expect(thumbUrl(u, 640)).toBe(u)
    expect(thumbUrl('https://i.scdn.co/image/abc?s=300', 80)).toBe('https://i.scdn.co/image/abc?s=300')
    expect(thumbUrl('https://x.test/v1/media/art/t1?sig=a', 80)).toBe('https://x.test/v1/media/art/t1?sig=a')
  })
})

describe('Artwork viewport loading', () => {
  beforeEach(() => {
    observed = []
    cbs = []
    vi.stubGlobal('IntersectionObserver', FakeIO)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('does not request off-screen covers, loads near ones with high priority, small size', () => {
    render(
      <>
        <Artwork images={art(1)} size={40} alt="a1" />
        <Artwork images={art(2)} size={40} alt="a2" />
      </>
    )
    expect(document.querySelectorAll('img[src]').length).toBe(0)
    const imgs = [...document.querySelectorAll('img')]
    setIntersecting(imgs[1]!, true)
    const loaded = document.querySelectorAll('img[src]')
    expect(loaded.length).toBe(1)
    expect(loaded[0]!.getAttribute('src')).toContain('s=64')
    expect(loaded[0]!.getAttribute('fetchpriority')).toBe('high')
    expect(loaded[0]!.getAttribute('decoding')).toBe('async')
    expect(screen.getByAltText('a2')).toBe(loaded[0])
  })

  it('limits concurrency, abandons covers scrolled away and releases slots on load', () => {
    const n = MAX_ACTIVE + 4
    render(
      <>
        {Array.from({ length: n }, (_, i) => (
          <Artwork key={i} images={art(i)} size={40} />
        ))}
      </>
    )
    const imgs = [...document.querySelectorAll('img')]
    imgs.forEach((el) => setIntersecting(el, true))
    expect(document.querySelectorAll('img[src]').length).toBe(MAX_ACTIVE)
    expect(_stats().pending).toBe(4)
    // scrolling away from an in-flight cover drops its src and lets a queued one start
    const first = document.querySelector('img[src]')!
    setIntersecting(first, false)
    expect(first.getAttribute('src')).toBeNull()
    expect(document.querySelectorAll('img[src]').length).toBe(MAX_ACTIVE)
    // a finished load frees a slot
    act(() => void document.querySelector('img[src]')!.dispatchEvent(new Event('load')))
    expect(document.querySelectorAll('img[src]').length).toBe(MAX_ACTIVE + 1) // the loaded one keeps its src
    expect(_stats().active).toBe(MAX_ACTIVE)
    expect(_stats().pending).toBe(2)
  })

  it('loads what is on screen first, then the nearest margin covers (jump to the bottom of a long list)', () => {
    const n = 30
    render(
      <>
        {Array.from({ length: n }, (_, i) => (
          <Artwork key={i} images={art(100 + i)} size={40} alt={`c${i}`} />
        ))}
      </>
    )
    const imgs = [...document.querySelectorAll('img')]
    // rows 20..27 are on screen (top 0..700 of a 768 px viewport); 0..19 are above it
    imgs.forEach((el, i) => {
      const top = (i - 20) * 100
      el.getBoundingClientRect = () => ({ top, bottom: top + 56, left: 0, right: 56, width: 56, height: 56, x: 0, y: top, toJSON() {} }) as DOMRect
    })
    act(() => {
      const byCb = new Map<Cb, Array<{ target: Element; isIntersecting: boolean }>>()
      for (const o of observed) byCb.set(o.cb, [...(byCb.get(o.cb) ?? []), { target: o.el, isIntersecting: true }])
      for (const [cb, entries] of byCb) cb(entries) // one batch, in DOM order
    })
    const granted = imgs.map((el, i) => (el.getAttribute('src') ? i : -1)).filter((i) => i >= 0)
    expect(granted).toEqual([20, 21, 22, 23, 24, 25])
    // free one slot: the next visible row goes before any margin row
    act(() => void imgs[20]!.dispatchEvent(new Event('load')))
    expect(imgs[26]!.getAttribute('src')).not.toBeNull()
    expect(imgs[19]!.getAttribute('src')).toBeNull()
  })

  it('eager covers load immediately at full size', () => {
    render(<Artwork images={art(5)} size={40} eager alt="e" />)
    expect(screen.getByAltText('e').getAttribute('src')).toContain('s=300')
  })
})
