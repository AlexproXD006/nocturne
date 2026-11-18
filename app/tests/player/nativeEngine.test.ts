import { describe, expect, it, vi } from 'vitest'
import { NativeEngine } from '@/player/nativeEngine'
import type { NativePlayer } from '@/platform/nativePlayerTypes'

function make() {
  const t = { ms: 1000 }
  const native = { seek: vi.fn(), play: vi.fn(), pause: vi.fn(), stop: vi.fn(), setVolume: vi.fn() } as unknown as NativePlayer
  const e = new NativeEngine(native, () => t.ms)
  return { e, t }
}

describe('NativeEngine interpolated clock', () => {
  it('advances between service reports only while playing', () => {
    const { e, t } = make()
    e.mirror(10, 200)
    e.setPlaying(true)
    t.ms += 400
    expect(e.currentTime).toBeCloseTo(10.4, 3)
    e.setPlaying(false)
    t.ms += 5000
    expect(e.currentTime).toBeCloseTo(10.4, 3)
    e.setPlaying(true)
    t.ms += 100
    expect(e.currentTime).toBeCloseTo(10.5, 3)
  })

  it('never runs backwards on a small drift (holds until the service catches up)', () => {
    const { e, t } = make()
    e.mirror(10, 200)
    e.setPlaying(true)
    t.ms += 1000 // local 11.0
    e.mirror(10.8, 200) // service says 10.8: we are 0.2 s ahead
    expect(e.currentTime).toBeGreaterThanOrEqual(11.0 - 1e-9)
    let last = e.currentTime
    for (let i = 0; i < 40; i++) {
      t.ms += 16
      expect(e.currentTime).toBeGreaterThanOrEqual(last)
      last = e.currentTime
    }
  })

  it('re-syncs forward and hard-syncs on big jumps (seek / track change)', () => {
    const { e, t } = make()
    e.mirror(10, 200)
    e.setPlaying(true)
    t.ms += 1000
    e.mirror(11.3, 200) // small forward drift
    expect(e.currentTime).toBeCloseTo(11.3, 3)
    e.mirror(90, 200) // seek
    expect(e.currentTime).toBeCloseTo(90, 3)
    e.mirror(0, 180) // new track
    expect(e.currentTime).toBeCloseTo(0, 3)
  })

  it('local seek is exact and forwarded; clamps to the duration', () => {
    const { e, t } = make()
    e.mirror(0, 30)
    e.setPlaying(true)
    e.seek(25)
    expect(e.currentTime).toBeCloseTo(25, 3)
    t.ms += 60_000
    expect(e.currentTime).toBe(30)
  })

  it('stop resets the clock', () => {
    const { e, t } = make()
    e.mirror(5, 100)
    e.setPlaying(true)
    e.stop()
    t.ms += 1000
    expect(e.currentTime).toBe(0)
  })
})
