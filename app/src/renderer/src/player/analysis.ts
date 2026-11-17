export interface Bands {
  bass: number
  mid: number
  treble: number
  energy: number
}

/** Average magnitude (0..1) of FFT bins between two frequencies. */
export function bandLevel(data: ArrayLike<number>, sampleRate: number, fromHz: number, toHz: number): number {
  if (data.length === 0) return 0
  const binHz = sampleRate / 2 / data.length
  const last = data.length - 1
  const start = Math.min(last, Math.max(0, Math.floor(fromHz / binHz)))
  const end = Math.min(last, Math.max(start, Math.ceil(toHz / binHz)))
  let sum = 0
  for (let i = start; i <= end; i++) sum += data[i]!
  return sum / (end - start + 1) / 255
}

export function computeBands(data: ArrayLike<number>, sampleRate: number): Bands {
  const bass = bandLevel(data, sampleRate, 20, 160)
  const mid = bandLevel(data, sampleRate, 160, 2000)
  const treble = bandLevel(data, sampleRate, 2000, 12000)
  return { bass, mid, treble, energy: bass * 0.5 + mid * 0.35 + treble * 0.15 }
}

/** Exponential smoothing with separate attack/release so visuals pop and decay softly. */
export function smoothBands(prev: Bands, next: Bands, dt: number, attack = 18, release = 4): Bands {
  const k = (p: number, n: number): number => {
    const rate = n > p ? attack : release
    return p + (n - p) * (1 - Math.exp(-rate * dt))
  }
  return { bass: k(prev.bass, next.bass), mid: k(prev.mid, next.mid), treble: k(prev.treble, next.treble), energy: k(prev.energy, next.energy) }
}

/**
 * Simple onset detector on bass energy: fires when the instantaneous level exceeds the
 * running average by a margin, with a refractory period.
 */
export class BeatDetector {
  private avg = 0
  private cooldown = 0

  constructor(
    private readonly sensitivity = 1.35,
    private readonly refractory = 0.22
  ) {}

  update(level: number, dt: number): boolean {
    this.cooldown = Math.max(0, this.cooldown - dt)
    const beat = this.cooldown === 0 && level > 0.12 && level > this.avg * this.sensitivity
    this.avg += (level - this.avg) * Math.min(1, dt * 2.5)
    if (beat) this.cooldown = this.refractory
    return beat
  }
}

/** Plausible fake bands for when no analyser is available (no CORS on the stream). */
export function syntheticBands(t: number, playing: boolean): Bands {
  if (!playing) return { bass: 0.05, mid: 0.05, treble: 0.03, energy: 0.05 }
  const beat = Math.pow(Math.max(0, Math.sin(t * Math.PI * 2 * 1.05)), 8)
  const bass = 0.35 + 0.35 * beat + 0.08 * Math.sin(t * 0.7)
  const mid = 0.32 + 0.12 * Math.sin(t * 1.3 + 1) + 0.06 * Math.sin(t * 3.1)
  const treble = 0.22 + 0.1 * Math.sin(t * 2.2 + 2)
  return { bass, mid, treble, energy: bass * 0.5 + mid * 0.35 + treble * 0.15 }
}
