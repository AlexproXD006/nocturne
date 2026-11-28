import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services', async () => ({ api: {}, platform: { kind: 'web' }, usePlayer: {}, useConnect: {}, ...(await import('../helpers/services-mock')).offlineMocks() }))

import { Artwork, ARTWORK_RETRY_MS } from '@/components/common'
import { cachedPalette, clearPaletteCache, extractPalette } from '@/lib/color'
import { keepTrack } from '@/store/player'
import { createQueue } from '@/player/queue'
import type { Track } from '@/api/types'

const art = (u: string) => [{ url: u, width: 640 }]

describe('Artwork', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('keeps the same src across re-renders and does not re-render when props are equal', () => {
    const images = art('https://img.test/a.jpg')
    const { rerender } = render(<Artwork images={images} size={100} alt="c" />)
    const src = screen.getByAltText('c').getAttribute('src')
    for (let i = 0; i < 30; i++) rerender(<Artwork images={images} size={100} alt="c" />)
    expect(screen.getByAltText('c').getAttribute('src')).toBe(src)
  })

  it('shows a placeholder on error, retries once, then gives up; a new cover resets', () => {
    const { rerender, container } = render(<Artwork images={art('https://img.test/a.jpg')} size={100} alt="c" />)
    act(() => void screen.getByAltText('c').dispatchEvent(new Event('error')))
    expect(container.querySelector('img')).toBeNull()
    act(() => void vi.advanceTimersByTime(ARTWORK_RETRY_MS + 10))
    expect(container.querySelector('img')).not.toBeNull()
    act(() => void container.querySelector('img')!.dispatchEvent(new Event('error')))
    act(() => void vi.advanceTimersByTime(10_000))
    expect(container.querySelector('img')).toBeNull()
    rerender(<Artwork images={art('https://img.test/b.jpg')} size={100} alt="c" />)
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://img.test/b.jpg')
  })
})

describe('snapshot adoption keeps track objects', () => {
  it('reuses artwork identity for the same track id', () => {
    const t = { id: 't1', title: 'x', artists: [], album: null, duration: 1, artwork: art('https://img.test/a.jpg') } as unknown as Track
    const q = createQueue([t], 0)
    const fresh = { ...t, artwork: art('https://img.test/a.jpg') } as Track
    expect(keepTrack(q, fresh).artwork).toBe(t.artwork)
    const basic = { ...t, artwork: [{ url: 'https://img.test/small.jpg' }, ] } as Track
    expect(keepTrack(createQueue([{ ...t, artwork: [...t.artwork, { url: 'z', width: 1 }] } as Track], 0), basic).artwork.length).toBe(2)
  })
})

describe('palette cache', () => {
  it('does not cache load errors for good and shares in-flight requests', async () => {
    clearPaletteCache()
    const imgs: Array<{ onerror?: () => void; onload?: () => void }> = []
    vi.stubGlobal('Image', class { onerror?: () => void; set src(_v: string) { imgs.push(this) } })
    const p1 = extractPalette('u1')
    const p2 = extractPalette('u1')
    expect(imgs.length).toBe(1)
    imgs[0]!.onerror!()
    expect(await p1).toBeNull()
    expect(await p2).toBeNull()
    expect(cachedPalette('u1')).toBeUndefined()
    vi.unstubAllGlobals()
  })
})
