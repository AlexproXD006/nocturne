import { describe, expect, it } from 'vitest'
import {
  BUILTIN_PRESETS,
  bandCoefficients,
  bandType,
  biquadDb,
  clampGain,
  clampPreamp,
  clippingMarginDb,
  DEFAULT_EQ,
  EQ_BANDS,
  isClippingRisk,
  peakDb,
  presetToState,
  responseDb,
  sameEq,
  sanitizeEq,
  sanitizeGains,
  snap,
  suggestPreamp
} from '@/lib/eq'
import { en } from '@/i18n/en'
import { es } from '@/i18n/es'

const SR = 48000
const only = (band: number, db: number): number[] => Object.assign(new Array<number>(10).fill(0), { [band]: db })

describe('bands and clamping', () => {
  it('has the ten ISO bands with shelves at both ends', () => {
    expect([...EQ_BANDS]).toEqual([31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000])
    expect(bandType(0)).toBe('lowshelf')
    expect(bandType(9)).toBe('highshelf')
    expect([1, 4, 8].map(bandType)).toEqual(['peaking', 'peaking', 'peaking'])
  })
  it('snaps to 0.5 dB and clamps to the ranges', () => {
    expect(snap(1.26)).toBe(1.5)
    expect(Object.is(snap(-0.2), 0)).toBe(true)
    expect(clampGain(20)).toBe(12)
    expect(clampGain(-20)).toBe(-12)
    expect(clampGain(NaN)).toBe(0)
    expect(clampPreamp(10)).toBe(6)
    expect(clampPreamp(-20)).toBe(-12)
  })
  it('sanitizes untrusted state', () => {
    expect(sanitizeGains([50, 'x', -50])).toEqual([12, 0, -12, 0, 0, 0, 0, 0, 0, 0])
    expect(sanitizeGains(null)).toHaveLength(10)
    expect(sanitizeEq({ enabled: 'yes', preamp: 99, gains: [1], presetId: '' })).toEqual({ enabled: true, preamp: 6, gains: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0], presetId: null })
    expect(sameEq(DEFAULT_EQ, sanitizeEq(DEFAULT_EQ))).toBe(true)
  })
})

describe('biquad response', () => {
  it('peaking bands have exactly their gain at the centre', () => {
    for (let b = 1; b < 9; b++) for (const db of [-12, -4.5, 3, 12]) {
      expect(biquadDb(bandCoefficients(b, db, SR), EQ_BANDS[b]!, SR)).toBeCloseTo(db, 1)
    }
  })
  it('shelves give half the gain at the corner and approach the full gain beyond it', () => {
    expect(biquadDb(bandCoefficients(0, 9, SR), 31, SR)).toBeCloseTo(4.5, 1)
    expect(biquadDb(bandCoefficients(0, 9, SR), 20, SR)).toBeCloseTo(7.53, 1) // same value as EqDspTest on Android
    expect(biquadDb(bandCoefficients(9, -8, SR), 16000, SR)).toBeCloseTo(-4, 1)
    expect(biquadDb(bandCoefficients(9, -8, SR), 20000, SR)).toBeCloseTo(-7.6, 1)
  })
  it('zero gain is the identity and flat curves have a 0 dB response', () => {
    for (let b = 0; b < 10; b++) expect(biquadDb(bandCoefficients(b, 0, 44100), 1234, 44100)).toBeCloseTo(0, 9)
    expect(responseDb(new Array<number>(10).fill(0), 1000)).toBe(0)
    expect(peakDb(new Array<number>(10).fill(0))).toBe(0)
  })
  it('adds the bands together', () => {
    const g = new Array<number>(10).fill(0)
    g[3] = 4
    g[6] = -5
    expect(responseDb(g, 250)).toBeCloseTo(4, 0)
    expect(responseDb(g, 2000)).toBeCloseTo(-5, 0)
  })
})

describe('headroom', () => {
  it('suggests no preamp for cuts and a flat curve', () => {
    expect(suggestPreamp(new Array<number>(10).fill(0))).toBe(0)
    expect(suggestPreamp(only(5, -6))).toBe(0)
  })
  it('suggests a negative preamp that covers the boost', () => {
    const g = only(5, 6)
    const pre = suggestPreamp(g)
    expect(pre).toBeLessThanOrEqual(-6)
    expect(pre).toBeGreaterThanOrEqual(-6.5)
    expect(Number.isInteger(pre * 2)).toBe(true)
    expect(isClippingRisk(g, pre)).toBe(false)
    expect(isClippingRisk(g, 0)).toBe(true)
    expect(clippingMarginDb(g, 0)).toBeGreaterThan(5.5)
  })
  it('never goes below the slider minimum', () => {
    expect(suggestPreamp(new Array<number>(10).fill(12))).toBe(-12)
  })
})

describe('built-in presets', () => {
  it('ships the 18 requested modes with valid curves', () => {
    expect(BUILTIN_PRESETS.map((p) => p.id)).toEqual([
      'flat', 'bass-boost', 'bass-reducer', 'treble-boost', 'vocal', 'pop', 'rock', 'hip-hop', 'latin',
      'electronic', 'jazz', 'classical', 'acoustic', 'loudness', 'late-night', 'small-speakers', 'headphones', 'car'
    ])
    for (const p of BUILTIN_PRESETS) {
      expect(p.gains).toHaveLength(10)
      for (const g of p.gains) {
        expect(g).toBeGreaterThanOrEqual(-12)
        expect(g).toBeLessThanOrEqual(12)
        expect(Number.isInteger(g * 2)).toBe(true)
      }
    }
  })
  it('has sensible shapes', () => {
    const by = (id: string): readonly number[] => BUILTIN_PRESETS.find((p) => p.id === id)!.gains
    expect(by('flat').every((g) => g === 0)).toBe(true)
    expect(by('bass-boost')[0]).toBeGreaterThan(3)
    expect(by('bass-reducer')[0]).toBeLessThan(-3)
    expect(by('treble-boost')[9]).toBeGreaterThan(3)
    expect(by('vocal')[6]).toBeGreaterThan(by('vocal')[0]!)
    expect(by('late-night')[0]).toBeLessThan(0)
    expect(by('small-speakers')[0]).toBeLessThan(0)
  })
  it('applies automatic headroom when a preset becomes state', () => {
    const rock = BUILTIN_PRESETS.find((p) => p.id === 'rock')!
    const s = presetToState(rock)
    expect(s.presetId).toBe('rock')
    expect(s.preamp).toBeLessThan(0)
    expect(isClippingRisk(s.gains, s.preamp)).toBe(false)
    expect(presetToState(BUILTIN_PRESETS[0]!).preamp).toBe(0)
  })
  it('has English and Spanish names for every preset', () => {
    for (const p of BUILTIN_PRESETS) {
      expect(en[p.labelKey]).toBeTruthy()
      expect(es[p.labelKey]).toBeTruthy()
    }
    expect(es['eq.preset.flat']).toBe('Plano')
    expect(es['eq.preset.latin']).toMatch(/Regueton|Reguetón/)
    expect(es['eq.preset.car']).toBe('Coche')
    expect(en['eq.preset.lateNight']).toBe('Late night')
  })
})
