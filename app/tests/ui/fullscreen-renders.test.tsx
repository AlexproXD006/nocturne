import { act, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const counts = vi.hoisted(() => ({ backdrop: 0, cover: 0 }))
vi.mock('@/services', async () => {
  const { create } = await import('zustand')
  return {
    api: {},
    platform: { kind: 'web' },
    getEngine: () => null,
    usePlayer: create(() => ({ status: 'playing', queue: { items: [{ track: { artwork: [{ url: 'https://img.test/c.jpg', width: 300 }] } }], index: 0 } })),
    useConnect: create(() => ({ remote: null }))
  }
})
vi.mock('@/player/queue', () => ({ currentItem: (q: { items: unknown[]; index: number }) => q.items[q.index] ?? null }))

import { AdaptiveBackdrop } from '@/components/AdaptiveBackdrop'
import { Artwork } from '@/components/common'
import { useSettings } from '@/store/settings'
import { useFrame } from '@/hooks/useClock'
import { Profiler, useState, type ReactNode } from 'react'

const images = [{ url: 'https://img.test/c.jpg', width: 640 }]
function Ticker(): null {
  // Simulates a component that ticks every frame (progress bar / lyrics) beside the cover and backdrop.
  const [, setN] = useState(0)
  useFrame(() => setN((n) => n + 1))
  return null
}
function Host(): ReactNode {
  return (
    <>
      <Ticker />
      <Profiler id="backdrop" onRender={() => counts.backdrop++}>
        <AdaptiveBackdrop variant="embedded" />
      </Profiler>
      <Profiler id="cover" onRender={() => counts.cover++}>
        <Artwork images={images} size={100} />
      </Profiler>
    </>
  )
}

describe('per-frame clock', () => {
  it('does not re-render the backdrop or cover on clock ticks', async () => {
    useSettings.getState().update({ theme: 'adaptive' })
    vi.useFakeTimers()
    let raf: ((t: number) => void)[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => (raf.push(cb), raf.length))
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    render(<Host />)
    const b0 = counts.backdrop, c0 = counts.cover
    for (let i = 0; i < 20; i++) {
      const cbs = raf
      raf = []
      await act(async () => cbs.forEach((cb) => cb(performance.now() + i * 16)))
    }
    expect(counts.backdrop - b0).toBe(0)
    expect(counts.cover - c0).toBe(0)
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
})
