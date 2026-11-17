import { describe, expect, it } from 'vitest'
import { bandLevel, BeatDetector, computeBands, smoothBands, syntheticBands, type Bands } from '@/player/analysis'

const SR = 44100

/** FFT-like data with `n` bins, all `value` except a range of bins set to `hot`. */
function spectrum(n: number, fill: number, hot?: { fromHz: number; toHz: number; value: number }): Uint8Array {
  const data = new Uint8Array(n).fill(fill)
  if (hot) {
    const binHz = SR / 2 / n
    for (let i = 0; i < n; i++) {
      const f = i * binHz
      if (f >= hot.fromHz && f <= hot.toHz) data[i] = hot.value
    }
  }
  return data
}

describe('bandLevel', () => {
  it('is 0 for silence and 1 for full scale', () => {
    expect(bandLevel(new Uint8Array(1024), SR, 20, 160)).toBe(0)
    expect(bandLevel(new Uint8Array(1024).fill(255), SR, 20, 160)).toBe(1)
  })

  it('averages only the bins inside the band', () => {
    const data = new Uint8Array(1024)
    const binHz = SR / 2 / 1024 // ~21.5 Hz
    const start = Math.floor(1000 / binHz)
    const end = Math.ceil(2000 / binHz)
    for (let i = start; i <= end; i++) data[i] = 255
    expect(bandLevel(data, SR, 1000, 2000)).toBe(1)
    expect(bandLevel(data, SR, 5000, 6000)).toBe(0)
  })

  it('computes a proportional mean', () => {
    const data = new Uint8Array([0, 100, 200, 100, 0, 0, 0, 0])
    // binHz = 44100/2/8 = 2756.25 ; range 2756..8268 -> bins 1..3 (floor(1), ceil(3))
    expect(bandLevel(data, SR, 2756.25, 8268.75)).toBeCloseTo((100 + 200 + 100) / 3 / 255)
  })

  it('clamps the band to the available bins', () => {
    const data = new Uint8Array(16).fill(51)
    expect(bandLevel(data, SR, 0, 1e9)).toBeCloseTo(51 / 255)
    expect(bandLevel(data, SR, 1e9, 2e9)).toBeCloseTo(51 / 255) // collapses onto the last bin
  })

  it('returns 0 for empty data', () => {
    expect(bandLevel(new Uint8Array(0), SR, 20, 160)).toBe(0)
  })

  it('always includes at least one bin', () => {
    const data = new Uint8Array([10, 20, 30, 40])
    expect(Number.isFinite(bandLevel(data, SR, 100, 100))).toBe(true)
  })

  it('accepts plain arrays and Float32Array', () => {
    expect(bandLevel([255, 255, 255, 255], SR, 0, SR / 2)).toBe(1)
    expect(bandLevel(new Float32Array([127.5, 127.5]), SR, 0, SR / 2)).toBeCloseTo(0.5)
  })
})

describe('computeBands', () => {
  it('returns zeros for silence', () => {
    expect(computeBands(new Uint8Array(1024), SR)).toEqual({ bass: 0, mid: 0, treble: 0, energy: 0 })
  })

  it('isolates bass energy', () => {
    const b = computeBands(spectrum(1024, 0, { fromHz: 20, toHz: 160, value: 255 }), SR)
    expect(b.bass).toBeGreaterThan(0.6)
    expect(b.mid).toBeLessThan(0.05)
    expect(b.treble).toBe(0)
    expect(b.energy).toBeCloseTo(b.bass * 0.5 + b.mid * 0.35, 5)
  })

  it('isolates treble energy', () => {
    const b = computeBands(spectrum(1024, 0, { fromHz: 3000, toHz: 11000, value: 255 }), SR)
    expect(b.treble).toBeGreaterThan(0.7)
    expect(b.bass).toBe(0)
    expect(b.mid).toBe(0)
  })

  it('weights energy as 50/35/15', () => {
    const b = computeBands(new Uint8Array(1024).fill(255), SR)
    expect(b).toEqual({ bass: 1, mid: 1, treble: 1, energy: 1 })
    const half = computeBands(new Uint8Array(1024).fill(128), SR)
    expect(half.energy).toBeCloseTo(half.bass * 0.5 + half.mid * 0.35 + half.treble * 0.15)
  })

  it('stays within 0..1', () => {
    const b = computeBands(new Uint8Array(2048).fill(255), 48000)
    for (const v of Object.values(b)) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1.0000001)
    }
  })
})

describe('smoothBands', () => {
  const zero: Bands = { bass: 0, mid: 0, treble: 0, energy: 0 }
  const one: Bands = { bass: 1, mid: 1, treble: 1, energy: 1 }

  it('returns prev for dt=0', () => {
    expect(smoothBands(zero, one, 0)).toEqual(zero)
    expect(smoothBands(one, zero, 0)).toEqual(one)
  })

  it('rises faster (attack) than it falls (release)', () => {
    const up = smoothBands(zero, one, 0.05).bass
    const down = 1 - smoothBands(one, zero, 0.05).bass
    expect(up).toBeGreaterThan(down)
    expect(up).toBeCloseTo(1 - Math.exp(-18 * 0.05))
    expect(down).toBeCloseTo(1 - Math.exp(-4 * 0.05))
  })

  it('honours custom attack and release rates', () => {
    expect(smoothBands(zero, one, 0.1, 5, 1).bass).toBeCloseTo(1 - Math.exp(-0.5))
    expect(smoothBands(one, zero, 0.1, 5, 1).bass).toBeCloseTo(Math.exp(-0.1))
  })

  it('converges to the target and never overshoots', () => {
    let b = zero
    for (let i = 0; i < 200; i++) {
      b = smoothBands(b, one, 1 / 60)
      expect(b.bass).toBeLessThanOrEqual(1)
    }
    expect(b.bass).toBeCloseTo(1, 3)
  })

  it('smooths every channel independently', () => {
    const r = smoothBands({ bass: 0, mid: 1, treble: 0.5, energy: 0 }, { bass: 1, mid: 0, treble: 0.5, energy: 0 }, 0.1)
    expect(r.bass).toBeGreaterThan(0)
    expect(r.mid).toBeLessThan(1)
    expect(r.treble).toBeCloseTo(0.5)
    expect(r.energy).toBe(0)
  })

  it('does not mutate its inputs', () => {
    const prev = { ...zero }
    smoothBands(prev, one, 0.1)
    expect(prev).toEqual(zero)
  })
})

describe('BeatDetector', () => {
  const DT = 1 / 60

  /** Runs `seconds` of a constant level and returns the number of beats. */
  function run(det: BeatDetector, level: number, seconds: number): number {
    let beats = 0
    for (let t = 0; t < seconds; t += DT) if (det.update(level, DT)) beats++
    return beats
  }

  it('does not fire on silence or very low levels', () => {
    const det = new BeatDetector()
    expect(run(det, 0, 1)).toBe(0)
    expect(run(det, 0.1, 1)).toBe(0)
  })

  it('fires on a spike above the running average', () => {
    const det = new BeatDetector()
    run(det, 0.2, 2)
    expect(det.update(0.8, DT)).toBe(true)
  })

  it('does not fire on a steady level once the average has caught up', () => {
    const det = new BeatDetector()
    run(det, 0.5, 5) // initial onsets while the average catches up
    expect(run(det, 0.5, 3)).toBe(0)
  })

  it('does not fire for a spike below the absolute threshold (0.12) even from silence', () => {
    const det = new BeatDetector()
    expect(det.update(0.11, DT)).toBe(false)
    expect(det.update(0.12, DT)).toBe(false)
    expect(det.update(0.13, DT)).toBe(true)
  })

  it('needs to exceed the average by the sensitivity factor', () => {
    const det = new BeatDetector(2)
    run(det, 0.3, 3) // avg ~0.3
    expect(det.update(0.5, DT)).toBe(false) // 0.5 < 0.3*2
    const det2 = new BeatDetector(1.1)
    run(det2, 0.3, 3)
    expect(det2.update(0.5, DT)).toBe(true)
  })

  it('has a refractory period after a beat', () => {
    const det = new BeatDetector(1.35, 0.22)
    run(det, 0.2, 2)
    expect(det.update(0.9, DT)).toBe(true)
    // immediately after, further spikes are suppressed for ~0.22s
    let suppressed = 0
    for (let t = 0; t < 0.2; t += DT) {
      if (!det.update(0.9, DT)) suppressed++
    }
    expect(suppressed).toBeGreaterThanOrEqual(11)
  })

  it('can fire again after the refractory period when the level spikes again', () => {
    const det = new BeatDetector(1.35, 0.2)
    run(det, 0.2, 2)
    expect(det.update(0.9, DT)).toBe(true)
    run(det, 0.15, 1) // drop back down; refractory elapses and average falls
    expect(det.update(0.9, DT)).toBe(true)
  })

  it('detects a regular 2 Hz pulse train at roughly the right rate', () => {
    const det = new BeatDetector()
    let beats = 0
    const seconds = 10
    for (let i = 0; i < seconds * 60; i++) {
      const t = i / 60
      const level = (t * 2) % 1 < 0.1 ? 0.9 : 0.15
      if (det.update(level, DT)) beats++
    }
    expect(beats).toBeGreaterThanOrEqual(15)
    expect(beats).toBeLessThanOrEqual(21)
  })

  it('is independent per instance', () => {
    const a = new BeatDetector()
    const b = new BeatDetector()
    run(a, 0.9, 3)
    expect(b.update(0.9, DT)).toBe(true)
  })

  it('handles large dt without producing NaN', () => {
    const det = new BeatDetector()
    expect(det.update(0.5, 10)).toBe(true)
    expect(det.update(0.5, 10)).toBe(false)
  })
})

describe('syntheticBands', () => {
  it('returns a quiet constant when not playing', () => {
    const a = syntheticBands(0, false)
    expect(a).toEqual({ bass: 0.05, mid: 0.05, treble: 0.03, energy: 0.05 })
    expect(syntheticBands(123.4, false)).toEqual(a)
  })

  it('moves over time when playing', () => {
    const a = syntheticBands(0.1, true)
    const b = syntheticBands(0.5, true)
    expect(a).not.toEqual(b)
  })

  it('is deterministic', () => {
    expect(syntheticBands(3.7, true)).toEqual(syntheticBands(3.7, true))
  })

  it('stays within 0..1 over a long period', () => {
    for (let t = 0; t < 120; t += 0.013) {
      const b = syntheticBands(t, true)
      for (const v of Object.values(b)) {
        expect(v).toBeGreaterThan(0)
        expect(v).toBeLessThan(1)
      }
    }
  })

  it('has a beat: bass peaks near the beat period (1/1.05 s)', () => {
    const period = 1 / 1.05
    const peak = syntheticBands(period / 4, true).bass
    const trough = syntheticBands((period * 3) / 4, true).bass
    expect(peak).toBeGreaterThan(trough + 0.2)
  })

  it('energy is the 50/35/15 blend', () => {
    const b = syntheticBands(2.2, true)
    expect(b.energy).toBeCloseTo(b.bass * 0.5 + b.mid * 0.35 + b.treble * 0.15)
  })

  it('louder than idle while playing', () => {
    const idle = syntheticBands(0, false).energy
    expect(syntheticBands(0, true).energy).toBeGreaterThan(idle)
  })
})
