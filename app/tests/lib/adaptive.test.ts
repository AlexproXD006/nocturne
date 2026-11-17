import { describe, expect, it } from 'vitest'
import {
  AA_CONTRAST,
  ADAPTIVE_PRESET_IDS,
  ADAPTIVE_PRESETS,
  applyAdaptivePatch,
  AUTO_DIM_MAX,
  AUTO_DIM_MIN,
  autoDim,
  backdropImageSize,
  backdropLuminance,
  DEFAULT_ADAPTIVE,
  glassColors,
  isLowEndAndroid,
  maxBackgroundLuminance,
  MUTED_TEXT_LUMINANCE,
  PRESET_FIELDS,
  pulseActive,
  resolveBackdrop,
  resolveDim,
  resolvePerformance,
  sanitizeAdaptive,
  SAVER_BLUR_CAP,
  showAppBackdrop,
  showFullscreenBackdrop,
  styleLuminance,
  textContrast,
  type DeviceEnv
} from '@/lib/adaptive'

const desktop: DeviceEnv = { reducedMotion: false, android: false, cores: 8, memory: 8 }

describe('sanitizeAdaptive / defaults', () => {
  it('returns the defaults for garbage', () => {
    for (const v of [undefined, null, 3, 'x', [], true]) expect(sanitizeAdaptive(v)).toEqual(DEFAULT_ADAPTIVE)
  })

  it('defaults reproduce the original Adaptive look', () => {
    expect(DEFAULT_ADAPTIVE).toMatchObject({
      preset: 'classic',
      style: 'cover',
      visibility: 55, // opacity-55
      blur: 64, // blur-3xl
      saturation: 150, // saturate-150
      dimMode: 'manual',
      dim: 45, // bg-black/45
      motion: 'static',
      glow: 50, // glow multiplier 1 (0.42 / 0.22 alphas)
      grain: false,
      vignette: false,
      fade: 1.1, // ambient-in 1.1s
      accentSource: 'dominant',
      scope: 'everywhere',
      glass: 62,
      performance: 'auto'
    })
  })

  it('keeps valid values', () => {
    const v = { ...DEFAULT_ADAPTIVE, preset: 'custom', style: 'aurora', motion: 'pulse', speed: 'fast', dimMode: 'auto', scope: 'fullscreen', performance: 'saver', accentSource: 'muted', grain: true }
    expect(sanitizeAdaptive(v)).toEqual(v)
  })

  it('clamps and rounds numbers', () => {
    const r = sanitizeAdaptive({ visibility: 140, blur: -5, saturation: 250, dim: 99, glow: 33.6, glass: -1, fade: 9 })
    expect(r).toMatchObject({ visibility: 100, blur: 0, saturation: 200, dim: 90, glow: 34, glass: 0, fade: 3 })
    expect(sanitizeAdaptive({ fade: 0.46 }).fade).toBe(0.5)
  })

  it('rejects unknown enum values, non-finite numbers and non-boolean flags', () => {
    const r = sanitizeAdaptive({ style: 'video', motion: 'wobble', speed: 'ludicrous', preset: 'party', blur: NaN, grain: 'yes', scope: 'nowhere', performance: 'max', accentSource: 'neon', dimMode: 1 })
    expect(r).toEqual(DEFAULT_ADAPTIVE)
  })

  it('drops unknown keys', () => {
    expect(Object.keys(sanitizeAdaptive({ evil: 1 })).sort()).toEqual(Object.keys(DEFAULT_ADAPTIVE).sort())
  })
})

describe('presets', () => {
  it('has Classic + the five named presets, all valid', () => {
    expect(ADAPTIVE_PRESET_IDS).toEqual(['classic', 'subtle', 'immersive', 'vinyl', 'concert', 'reading'])
    for (const id of ADAPTIVE_PRESET_IDS) {
      const applied = applyAdaptivePatch(DEFAULT_ADAPTIVE, { preset: id })
      expect(sanitizeAdaptive(applied)).toEqual(applied)
      expect(Object.keys(ADAPTIVE_PRESETS[id].values).sort()).toEqual([...PRESET_FIELDS].sort())
    }
  })

  it('Classic is exactly the defaults', () => {
    expect(applyAdaptivePatch({ ...DEFAULT_ADAPTIVE, blur: 3, preset: 'custom' }, { preset: 'classic' })).toEqual(DEFAULT_ADAPTIVE)
  })

  it('selecting a preset sets its look fields and leaves the rest alone', () => {
    const prev = { ...DEFAULT_ADAPTIVE, scope: 'fullscreen' as const, performance: 'quality' as const, accentSource: 'vibrant' as const }
    const r = applyAdaptivePatch(prev, { preset: 'vinyl' })
    expect(r).toMatchObject({ preset: 'vinyl', motion: 'spin', scope: 'fullscreen', performance: 'quality', accentSource: 'vibrant' })
    expect(applyAdaptivePatch(prev, { preset: 'concert' })).toMatchObject({ motion: 'pulse', style: 'aurora' })
    expect(applyAdaptivePatch(prev, { preset: 'reading' })).toMatchObject({ dimMode: 'auto', motion: 'static' })
  })

  it('editing a look field marks the preset custom', () => {
    const vinyl = applyAdaptivePatch(DEFAULT_ADAPTIVE, { preset: 'vinyl' })
    expect(applyAdaptivePatch(vinyl, { blur: 10 })).toMatchObject({ preset: 'custom', blur: 10, motion: 'spin' })
  })

  it('editing a non-look field or setting the same value keeps the preset', () => {
    const vinyl = applyAdaptivePatch(DEFAULT_ADAPTIVE, { preset: 'vinyl' })
    expect(applyAdaptivePatch(vinyl, { scope: 'fullscreen' }).preset).toBe('vinyl')
    expect(applyAdaptivePatch(vinyl, { motion: 'spin' }).preset).toBe('vinyl')
  })

  it('fields in the same patch as a preset override it', () => {
    expect(applyAdaptivePatch(DEFAULT_ADAPTIVE, { preset: 'vinyl', speed: 'fast' })).toMatchObject({ preset: 'vinyl', speed: 'fast' })
  })
})

describe('performance auto mode', () => {
  it('explicit modes win', () => {
    expect(resolvePerformance('quality', { ...desktop, reducedMotion: true })).toBe('quality')
    expect(resolvePerformance('saver', desktop)).toBe('saver')
  })

  it('auto is quality on a capable device', () => {
    expect(resolvePerformance('auto', desktop)).toBe('quality')
    expect(resolvePerformance('auto', { reducedMotion: false, android: true, cores: 8, memory: 8 })).toBe('quality')
  })

  it('auto is saver under reduced motion', () => {
    expect(resolvePerformance('auto', { ...desktop, reducedMotion: true })).toBe('saver')
  })

  it('auto is saver on low-end Android (≤ 4 cores or ≤ 4 GB)', () => {
    expect(resolvePerformance('auto', { reducedMotion: false, android: true, cores: 4, memory: 8 })).toBe('saver')
    expect(resolvePerformance('auto', { reducedMotion: false, android: true, cores: 8, memory: 4 })).toBe('saver')
    expect(resolvePerformance('auto', { reducedMotion: false, android: true, cores: 8, memory: 2 })).toBe('saver')
  })

  it('the low-memory/cores rule only applies to Android, and ignores unknown values', () => {
    expect(isLowEndAndroid({ reducedMotion: false, android: false, cores: 2, memory: 1 })).toBe(false)
    expect(isLowEndAndroid({ reducedMotion: false, android: true })).toBe(false)
    expect(isLowEndAndroid({ reducedMotion: false, android: true, cores: 0 })).toBe(false)
  })
})

describe('resolveBackdrop', () => {
  it('default settings resolve to the original look', () => {
    const r = resolveBackdrop(DEFAULT_ADAPTIVE, desktop)
    expect(r).toMatchObject({ tier: 'quality', style: 'cover', opacity: 0.55, blur: 64, saturation: 1.5, motion: 'static', glow: 1, fade: 1.1, imageSize: 300, grain: false })
  })

  it('pulse (and any motion) is disabled under reduced motion, whatever the setting', () => {
    for (const motion of ['drift', 'spin', 'pulse'] as const) {
      for (const performance of ['auto', 'quality'] as const) {
        const r = resolveBackdrop({ ...DEFAULT_ADAPTIVE, motion, performance }, { ...desktop, reducedMotion: true })
        expect(r.motion).toBe('static')
        expect(r.fade).toBe(0)
        expect(pulseActive(r, { playing: true, freezeOnPause: false, visible: true })).toBe(false)
      }
    }
    expect(resolveBackdrop({ ...DEFAULT_ADAPTIVE, style: 'aurora' }, { ...desktop, reducedMotion: true }).auroraAnimated).toBe(false)
  })

  it('motion applies when allowed, with speed-based durations', () => {
    expect(resolveBackdrop({ ...DEFAULT_ADAPTIVE, motion: 'spin', speed: 'slow' }, desktop)).toMatchObject({ motion: 'spin', motionDuration: 90 })
    expect(resolveBackdrop({ ...DEFAULT_ADAPTIVE, motion: 'drift', speed: 'fast' }, desktop)).toMatchObject({ motion: 'drift', motionDuration: 20 })
    expect(resolveBackdrop({ ...DEFAULT_ADAPTIVE, motion: 'pulse' }, desktop)).toMatchObject({ motion: 'pulse', motionDuration: 0 })
  })

  it('saver: no motion, blur capped, small image, no grain', () => {
    const r = resolveBackdrop({ ...DEFAULT_ADAPTIVE, performance: 'saver', motion: 'spin', blur: 80, grain: true, style: 'aurora' }, desktop)
    expect(r).toMatchObject({ tier: 'saver', motion: 'static', blur: SAVER_BLUR_CAP, grain: false, imageSize: 160, auroraAnimated: false })
    expect(resolveBackdrop({ ...DEFAULT_ADAPTIVE, performance: 'saver', blur: 10 }, desktop).blur).toBe(10)
  })

  it('picks a smaller artwork for heavier blur', () => {
    expect(backdropImageSize(80, 'quality')).toBe(300)
    expect(backdropImageSize(24, 'quality')).toBe(480)
    expect(backdropImageSize(0, 'quality')).toBe(640)
    expect(backdropImageSize(0, 'saver')).toBe(160)
  })
})

describe('pulseActive', () => {
  const pulse = { motion: 'pulse' as const }
  it('runs only for pulse, while visible, and while playing unless freezing is off', () => {
    expect(pulseActive(pulse, { playing: true, freezeOnPause: true, visible: true })).toBe(true)
    expect(pulseActive(pulse, { playing: false, freezeOnPause: true, visible: true })).toBe(false)
    expect(pulseActive(pulse, { playing: false, freezeOnPause: false, visible: true })).toBe(true)
    expect(pulseActive(pulse, { playing: true, freezeOnPause: true, visible: false })).toBe(false)
    expect(pulseActive({ motion: 'drift' }, { playing: true, freezeOnPause: true, visible: true })).toBe(false)
  })
})

describe('scope & glass', () => {
  it('app-wide backdrop only for the Adaptive theme with scope "everywhere"', () => {
    expect(showAppBackdrop('adaptive', { scope: 'everywhere' })).toBe(true)
    expect(showAppBackdrop('adaptive', { scope: 'fullscreen' })).toBe(false)
    expect(showAppBackdrop('dark', { scope: 'everywhere' })).toBe(false)
  })

  it('the fullscreen player uses it in both scopes', () => {
    expect(showFullscreenBackdrop('adaptive')).toBe(true)
    expect(showFullscreenBackdrop('nord')).toBe(false)
  })

  it('default glass reproduces the original panel colours', () => {
    expect(glassColors(62)).toEqual({
      main: 'rgb(8 8 12 / 0.38)',
      chrome: 'rgb(0 0 0 / 0.319)',
      fadeTop: 'rgb(0 0 0 / 0.35)',
      fadeBottom: 'rgb(0 0 0 / 0.749)'
    })
  })

  it('glass 0 is opaque, 100 fully clear; alphas never exceed 1', () => {
    expect(glassColors(0).main).toBe('rgb(8 8 12 / 1)')
    expect(glassColors(0).fadeBottom).toBe('rgb(0 0 0 / 1)')
    expect(glassColors(100).main).toBe('rgb(8 8 12 / 0)')
    expect(glassColors(500).chrome).toBe('rgb(0 0 0 / 0)')
  })
})

describe('readability auto-dim', () => {
  it('max background luminance for AA against the muted text colour', () => {
    expect(MUTED_TEXT_LUMINANCE).toBeCloseTo(0.454, 2)
    const max = maxBackgroundLuminance()
    expect((MUTED_TEXT_LUMINANCE + 0.05) / (max + 0.05)).toBeCloseTo(AA_CONTRAST, 6)
  })

  it('a white backdrop needs ~72% black to reach AA', () => {
    const a = autoDim(1)
    expect(a).toBeGreaterThan(0.7)
    expect(a).toBeLessThan(0.74)
    expect(textContrast(1, a)).toBeGreaterThanOrEqual(AA_CONTRAST - 1e-9)
  })

  it('dark covers get only the minimum dim', () => {
    expect(autoDim(0)).toBe(AUTO_DIM_MIN)
    expect(autoDim(0.02)).toBe(AUTO_DIM_MIN)
  })

  it('is monotonic and always reaches AA within the clamp', () => {
    let prev = 0
    for (let l = 0; l <= 1.0001; l += 0.05) {
      const a = autoDim(l)
      expect(a).toBeGreaterThanOrEqual(prev)
      expect(a).toBeLessThanOrEqual(AUTO_DIM_MAX)
      expect(textContrast(l, a)).toBeGreaterThanOrEqual(AA_CONTRAST - 1e-9)
      prev = a
    }
  })

  it('backdrop luminance accounts for layer opacity and glow', () => {
    const base = { luminance: 0.8, opacity: 1, glow: 0, accentLuminance: 0.3 }
    expect(backdropLuminance(base)).toBeCloseTo(0.8, 5)
    expect(backdropLuminance({ ...base, opacity: 0.5 })).toBeLessThan(0.8 * 0.5)
    expect(backdropLuminance({ ...base, opacity: 0.5, glow: 2 })).toBeGreaterThan(backdropLuminance({ ...base, opacity: 0.5 }))
    expect(backdropLuminance({ luminance: 1, opacity: 1, glow: 2, accentLuminance: 1 })).toBe(1)
  })

  it('resolveDim: manual uses the slider, auto follows the cover', () => {
    const bg = { luminance: 0.9, opacity: 1, glow: 1, accentLuminance: 0.3 }
    expect(resolveDim({ dimMode: 'manual', dim: 45 }, bg)).toBe(0.45)
    const bright = resolveDim({ dimMode: 'auto', dim: 0 }, bg)
    const dark = resolveDim({ dimMode: 'auto', dim: 0 }, { ...bg, luminance: 0.01, glow: 0 })
    expect(bright).toBeGreaterThan(dark)
    expect(dark).toBe(AUTO_DIM_MIN)
  })

  it('styleLuminance: cover uses the sampled luminance, others the brightest colour', () => {
    const colors = [{ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }]
    expect(styleLuminance('cover', { luminance: 0.3, colors })).toBe(0.3)
    expect(styleLuminance('aurora', { luminance: 0.3, colors })).toBeCloseTo(1, 5)
    expect(styleLuminance('solid', { luminance: 0.3, colors: [] })).toBe(0.3)
  })
})
