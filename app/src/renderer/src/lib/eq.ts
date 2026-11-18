/**
 * 10-band equalizer model shared by the Web Audio graph, the Android bridge and the UI.
 *
 * Bands: 31, 62, 125, 250, 500, 1k, 2k, 4k, 8k, 16k Hz. The first band is a low shelf, the last a high
 * shelf, the rest are peaking filters with Q = 1. Gains are -12..+12 dB in 0.5 dB steps and the preamp
 * -12..+6 dB. The biquad math below (RBJ cookbook, same as Web Audio's BiquadFilterNode and the Android
 * `EqAudioProcessor`) is only used to draw the response curve and to compute headroom.
 */
import type { MessageKey } from '../i18n'

export const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const
export const EQ_BAND_COUNT = EQ_BANDS.length
export const EQ_GAIN_MIN = -12
export const EQ_GAIN_MAX = 12
export const EQ_PREAMP_MIN = -12
export const EQ_PREAMP_MAX = 6
export const EQ_STEP = 0.5
export const EQ_Q = 1

export type EqFilterType = 'lowshelf' | 'peaking' | 'highshelf'

export function bandType(i: number): EqFilterType {
  return i === 0 ? 'lowshelf' : i === EQ_BAND_COUNT - 1 ? 'highshelf' : 'peaking'
}

/** Active equalizer state (what is applied to audio and synced with the server). */
export interface EqState {
  enabled: boolean
  /** dB, -12..+6. */
  preamp: number
  /** dB per band, always `EQ_BAND_COUNT` long. */
  gains: number[]
  /** Built-in id ('rock'), `custom:<uuid>`, or null for a hand-edited curve. */
  presetId: string | null
}

export interface CustomPreset {
  id: string
  name: string
  preamp: number
  gains: number[]
}

export const FLAT_GAINS: readonly number[] = Object.freeze(new Array<number>(EQ_BAND_COUNT).fill(0))

export const DEFAULT_EQ: EqState = Object.freeze({ enabled: true, preamp: 0, gains: [...FLAT_GAINS], presetId: 'flat' }) as EqState

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** Rounds to the 0.5 dB grid (and turns -0 into 0). */
export function snap(v: number): number {
  return Math.round(v / EQ_STEP) * EQ_STEP + 0
}

export function clampGain(v: number): number {
  return Number.isFinite(v) ? snap(clamp(v, EQ_GAIN_MIN, EQ_GAIN_MAX)) : 0
}

export function clampPreamp(v: number): number {
  return Number.isFinite(v) ? snap(clamp(v, EQ_PREAMP_MIN, EQ_PREAMP_MAX)) : 0
}

export function sanitizeGains(raw: unknown): number[] {
  const a = Array.isArray(raw) ? raw : []
  return Array.from({ length: EQ_BAND_COUNT }, (_, i) => (typeof a[i] === 'number' ? clampGain(a[i] as number) : 0))
}

export function sanitizeEq(raw: unknown): EqState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : true,
    preamp: typeof r.preamp === 'number' ? clampPreamp(r.preamp) : 0,
    gains: sanitizeGains(r.gains),
    presetId: typeof r.presetId === 'string' && r.presetId ? r.presetId : null
  }
}

export function sameGains(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

export function sameEq(a: EqState, b: EqState): boolean {
  return a.enabled === b.enabled && a.preamp === b.preamp && a.presetId === b.presetId && sameGains(a.gains, b.gains)
}

export function isFlat(gains: readonly number[]): boolean {
  return gains.every((g) => g === 0)
}

// ---- biquad response ---------------------------------------------------------------------------------

export interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

/** Normalised RBJ coefficients (a0 = 1) for band `i`; shelves use slope S = 1 like Web Audio. */
export function bandCoefficients(i: number, gainDb: number, sampleRate: number): Biquad {
  const type = bandType(i)
  const f0 = Math.min(EQ_BANDS[i]!, sampleRate * 0.45)
  const A = Math.pow(10, gainDb / 40)
  const w0 = (2 * Math.PI * f0) / sampleRate
  const cos = Math.cos(w0)
  const sin = Math.sin(w0)
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number
  if (type === 'peaking') {
    const alpha = sin / (2 * EQ_Q)
    b0 = 1 + alpha * A
    b1 = -2 * cos
    b2 = 1 - alpha * A
    a0 = 1 + alpha / A
    a1 = -2 * cos
    a2 = 1 - alpha / A
  } else {
    const alpha = (sin / 2) * Math.SQRT2 // S = 1
    const k = 2 * Math.sqrt(A) * alpha
    if (type === 'lowshelf') {
      b0 = A * (A + 1 - (A - 1) * cos + k)
      b1 = 2 * A * (A - 1 - (A + 1) * cos)
      b2 = A * (A + 1 - (A - 1) * cos - k)
      a0 = A + 1 + (A - 1) * cos + k
      a1 = -2 * (A - 1 + (A + 1) * cos)
      a2 = A + 1 + (A - 1) * cos - k
    } else {
      b0 = A * (A + 1 + (A - 1) * cos + k)
      b1 = -2 * A * (A - 1 + (A + 1) * cos)
      b2 = A * (A + 1 + (A - 1) * cos - k)
      a0 = A + 1 - (A - 1) * cos + k
      a1 = 2 * (A - 1 - (A + 1) * cos)
      a2 = A + 1 - (A - 1) * cos - k
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

/** |H(e^jw)| of a biquad, in dB. */
export function biquadDb(c: Biquad, freq: number, sampleRate: number): number {
  const w = (2 * Math.PI * freq) / sampleRate
  const cw = Math.cos(w)
  const sw = Math.sin(w)
  const c2 = Math.cos(2 * w)
  const s2 = Math.sin(2 * w)
  const nr = c.b0 + c.b1 * cw + c.b2 * c2
  const ni = -(c.b1 * sw + c.b2 * s2)
  const dr = 1 + c.a1 * cw + c.a2 * c2
  const di = -(c.a1 * sw + c.a2 * s2)
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di))
}

const REF_RATE = 48000

/** Combined magnitude response (dB, preamp excluded) of the whole filter cascade at `freq`. */
export function responseDb(gains: readonly number[], freq: number, sampleRate = REF_RATE): number {
  let db = 0
  for (let i = 0; i < EQ_BAND_COUNT; i++) {
    const g = gains[i] ?? 0
    if (g !== 0) db += biquadDb(bandCoefficients(i, g, sampleRate), freq, sampleRate)
  }
  return db
}

/** Log-spaced frequency grid (20 Hz .. 20 kHz) used for drawing and peak search. */
export function frequencyGrid(points = 128): number[] {
  const lo = Math.log10(20)
  const hi = Math.log10(20000)
  return Array.from({ length: points }, (_, i) => Math.pow(10, lo + ((hi - lo) * i) / (points - 1)))
}

const PEAK_GRID = frequencyGrid(160)

/** Highest point of the combined response in dB (>= 0 only when something is boosted). */
export function peakDb(gains: readonly number[]): number {
  if (isFlat(gains)) return 0
  let peak = -Infinity
  for (const f of PEAK_GRID) peak = Math.max(peak, responseDb(gains, f))
  // The band centres themselves matter most (a 31 Hz shelf peaks below the grid start).
  for (const f of EQ_BANDS) peak = Math.max(peak, responseDb(gains, f))
  return peak
}

/** Negative preamp (0.5 dB steps, never below the slider minimum) that keeps the boosted curve at or under 0 dBFS. */
export function suggestPreamp(gains: readonly number[]): number {
  const peak = peakDb(gains)
  if (peak <= 0.05) return 0
  return clampPreamp(-Math.ceil((peak - 0.05) * 2) / 2)
}

/** How far the curve + preamp can exceed full scale on a 0 dBFS signal (<= 0 means safe). */
export function clippingMarginDb(gains: readonly number[], preamp: number): number {
  return peakDb(gains) + preamp
}

export function isClippingRisk(gains: readonly number[], preamp: number): boolean {
  return clippingMarginDb(gains, preamp) > 0.25
}

// ---- built-in presets --------------------------------------------------------------------------------

export interface BuiltinPreset {
  id: string
  labelKey: MessageKey
  gains: readonly number[]
}

//                               31   62  125  250  500   1k   2k   4k   8k  16k
export const BUILTIN_PRESETS: readonly BuiltinPreset[] = [
  { id: 'flat', labelKey: 'eq.preset.flat', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: 'bass-boost', labelKey: 'eq.preset.bassBoost', gains: [6, 5.5, 4, 2.5, 1, 0, 0, 0, 0, 0] },
  { id: 'bass-reducer', labelKey: 'eq.preset.bassReducer', gains: [-6, -5, -3.5, -2, -0.5, 0, 0, 0, 0, 0] },
  { id: 'treble-boost', labelKey: 'eq.preset.trebleBoost', gains: [0, 0, 0, 0, 0, 0.5, 2, 3.5, 5, 6] },
  { id: 'vocal', labelKey: 'eq.preset.vocal', gains: [-3, -3, -2, -1, 1, 3, 4, 3, 1, -1] },
  { id: 'pop', labelKey: 'eq.preset.pop', gains: [-1, 1, 3, 4, 2.5, 0, -1, -1, -0.5, -0.5] },
  { id: 'rock', labelKey: 'eq.preset.rock', gains: [4.5, 3.5, 2.5, 1, -1, -1.5, 0.5, 2.5, 3.5, 4] },
  { id: 'hip-hop', labelKey: 'eq.preset.hipHop', gains: [5, 4.5, 2.5, 3, -1, -1, 1, -0.5, 1.5, 3] },
  { id: 'latin', labelKey: 'eq.preset.latin', gains: [6, 5.5, 3.5, 1.5, 0, -0.5, 0.5, 1.5, 2.5, 2] },
  { id: 'electronic', labelKey: 'eq.preset.electronic', gains: [4.5, 4, 1.5, 0, -2, -1.5, 0, 1.5, 3.5, 4.5] },
  { id: 'jazz', labelKey: 'eq.preset.jazz', gains: [3, 2.5, 1.5, 2, -1.5, -1.5, 0, 1.5, 2.5, 3] },
  { id: 'classical', labelKey: 'eq.preset.classical', gains: [3, 2.5, 1.5, 1, 0, 0, -0.5, 1, 2.5, 3.5] },
  { id: 'acoustic', labelKey: 'eq.preset.acoustic', gains: [4, 3.5, 2.5, 1, 1.5, 1.5, 2.5, 3, 3, 2] },
  { id: 'loudness', labelKey: 'eq.preset.loudness', gains: [6, 4.5, 1.5, 0, -0.5, 0, -0.5, 1, 3.5, 5] },
  { id: 'late-night', labelKey: 'eq.preset.lateNight', gains: [-4, -3, -1.5, 0, 1.5, 2.5, 2, 1, -1, -3] },
  { id: 'small-speakers', labelKey: 'eq.preset.smallSpeakers', gains: [-6, -5, -2, 3, 4, 2, 1, 1, 1.5, 1] },
  { id: 'headphones', labelKey: 'eq.preset.headphones', gains: [3, 3.5, 2, 0.5, -0.5, -1, 0.5, 1.5, 2.5, 1] },
  { id: 'car', labelKey: 'eq.preset.car', gains: [5, 4.5, 3, 1, 0, 0, 1, 2, 3, 3.5] }
]

export function builtinPreset(id: string | null): BuiltinPreset | undefined {
  return id ? BUILTIN_PRESETS.find((p) => p.id === id) : undefined
}

/** A built-in preset as a full state, preamp set to its automatic headroom. */
export function presetToState(p: BuiltinPreset, enabled = true): EqState {
  const gains = [...p.gains]
  return { enabled, preamp: suggestPreamp(gains), gains, presetId: p.id }
}

export function isCustomId(id: string | null): id is string {
  return typeof id === 'string' && id.startsWith('custom:')
}
