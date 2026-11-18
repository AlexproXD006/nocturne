/**
 * Adaptive theme ("Adaptive background") configuration: types, defaults,
 * presets, sanitizing, and the pure decisions the backdrop makes at runtime
 * (performance tier, readability dim, image size, scope). Kept free of React
 * and DOM so it is unit-testable and cheap to call on every render.
 */
import { contrastRatio, relativeLuminance, type AccentSource, type Rgb } from './color'
import { type MessageKey } from '../i18n'

export type AdaptiveStyle = 'cover' | 'aurora' | 'solid'
export type AdaptiveMotion = 'static' | 'drift' | 'spin' | 'pulse'
export type AdaptiveSpeed = 'slow' | 'medium' | 'fast'
export type AdaptiveDimMode = 'auto' | 'manual'
export type AdaptiveScope = 'everywhere' | 'fullscreen'
export type AdaptivePerformance = 'auto' | 'quality' | 'saver'
export type AdaptivePresetId = 'classic' | 'subtle' | 'immersive' | 'vinyl' | 'concert' | 'reading'
export type { AccentSource }

export interface AdaptiveSettings {
  /** Last preset applied, or 'custom' once a look field was edited by hand. */
  preset: AdaptivePresetId | 'custom'
  style: AdaptiveStyle
  /** Cover/gradient opacity, 0..100. */
  visibility: number
  /** Gaussian blur of the cover in px, 0..80. */
  blur: number
  /** Saturation in %, 0..200 (100 = unchanged). */
  saturation: number
  dimMode: AdaptiveDimMode
  /** Manual readability dim, 0..90 (% black overlay). Ignored when dimMode is 'auto'. */
  dim: number
  motion: AdaptiveMotion
  speed: AdaptiveSpeed
  /** Freeze motion and dim slightly while playback is paused. */
  pauseFreeze: boolean
  /** Accent glow strength, 0..100 (50 = the original look). */
  glow: number
  grain: boolean
  vignette: boolean
  /** Crossfade between covers on track change, seconds 0..3. */
  fade: number
  accentSource: AccentSource
  scope: AdaptiveScope
  /** How see-through the app panels are, 0 (opaque) .. 100 (fully clear). */
  glass: number
  performance: AdaptivePerformance
}

/** Matches the look the Adaptive theme had before it was configurable. */
export const DEFAULT_ADAPTIVE: AdaptiveSettings = {
  preset: 'classic',
  style: 'cover',
  visibility: 55,
  blur: 64,
  saturation: 150,
  dimMode: 'manual',
  dim: 45,
  motion: 'static',
  speed: 'medium',
  pauseFreeze: true,
  glow: 50,
  grain: false,
  vignette: false,
  fade: 1.1,
  accentSource: 'dominant',
  scope: 'everywhere',
  glass: 62,
  performance: 'auto'
}

/** Fields a preset sets ("the look"). Scope, performance, accent source etc. are left alone. */
export const PRESET_FIELDS = [
  'style',
  'visibility',
  'blur',
  'saturation',
  'dimMode',
  'dim',
  'motion',
  'speed',
  'glow',
  'grain',
  'vignette',
  'glass'
] as const satisfies readonly (keyof AdaptiveSettings)[]
export type PresetField = (typeof PRESET_FIELDS)[number]
export type AdaptivePreset = Pick<AdaptiveSettings, PresetField>

const pickLook = (s: AdaptiveSettings): AdaptivePreset =>
  Object.fromEntries(PRESET_FIELDS.map((k) => [k, s[k]])) as AdaptivePreset

export const ADAPTIVE_PRESETS: Record<AdaptivePresetId, { labelKey: MessageKey; hintKey: MessageKey; values: AdaptivePreset }> = {
  classic: { labelKey: 'preset.classic', hintKey: 'preset.classic.hint', values: pickLook(DEFAULT_ADAPTIVE) },
  subtle: {
    labelKey: 'preset.subtle',
    hintKey: 'preset.subtle.hint',
    values: { style: 'cover', visibility: 32, blur: 72, saturation: 120, dimMode: 'manual', dim: 55, motion: 'static', speed: 'slow', glow: 30, grain: false, vignette: false, glass: 45 }
  },
  immersive: {
    labelKey: 'preset.immersive',
    hintKey: 'preset.immersive.hint',
    values: { style: 'cover', visibility: 78, blur: 44, saturation: 165, dimMode: 'auto', dim: 35, motion: 'drift', speed: 'medium', glow: 70, grain: true, vignette: true, glass: 75 }
  },
  vinyl: {
    labelKey: 'preset.vinyl',
    hintKey: 'preset.vinyl.hint',
    values: { style: 'cover', visibility: 62, blur: 36, saturation: 140, dimMode: 'auto', dim: 45, motion: 'spin', speed: 'slow', glow: 45, grain: true, vignette: true, glass: 65 }
  },
  concert: {
    labelKey: 'preset.concert',
    hintKey: 'preset.concert.hint',
    values: { style: 'aurora', visibility: 80, blur: 64, saturation: 175, dimMode: 'auto', dim: 40, motion: 'pulse', speed: 'fast', glow: 90, grain: false, vignette: true, glass: 70 }
  },
  reading: {
    labelKey: 'preset.reading',
    hintKey: 'preset.reading.hint',
    values: { style: 'cover', visibility: 28, blur: 80, saturation: 100, dimMode: 'auto', dim: 70, motion: 'static', speed: 'slow', glow: 20, grain: false, vignette: false, glass: 20 }
  }
}

export const ADAPTIVE_PRESET_IDS = Object.keys(ADAPTIVE_PRESETS) as AdaptivePresetId[]

const oneOf = <T extends string>(v: unknown, options: readonly T[], d: T): T =>
  typeof v === 'string' && (options as readonly string[]).includes(v) ? (v as T) : d
const num = (v: unknown, min: number, max: number, d: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d
const int = (v: unknown, min: number, max: number, d: number): number => Math.round(num(v, min, max, d))
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)

export function sanitizeAdaptive(raw: unknown): AdaptiveSettings {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Partial<Record<keyof AdaptiveSettings, unknown>>
  const d = DEFAULT_ADAPTIVE
  return {
    preset: oneOf(r.preset, [...ADAPTIVE_PRESET_IDS, 'custom'] as const, d.preset),
    style: oneOf(r.style, ['cover', 'aurora', 'solid'] as const, d.style),
    visibility: int(r.visibility, 0, 100, d.visibility),
    blur: int(r.blur, 0, 80, d.blur),
    saturation: int(r.saturation, 0, 200, d.saturation),
    dimMode: oneOf(r.dimMode, ['auto', 'manual'] as const, d.dimMode),
    dim: int(r.dim, 0, 90, d.dim),
    motion: oneOf(r.motion, ['static', 'drift', 'spin', 'pulse'] as const, d.motion),
    speed: oneOf(r.speed, ['slow', 'medium', 'fast'] as const, d.speed),
    pauseFreeze: bool(r.pauseFreeze, d.pauseFreeze),
    glow: int(r.glow, 0, 100, d.glow),
    grain: bool(r.grain, d.grain),
    vignette: bool(r.vignette, d.vignette),
    fade: Math.round(num(r.fade, 0, 3, d.fade) * 10) / 10,
    accentSource: oneOf(r.accentSource, ['dominant', 'vibrant', 'muted'] as const, d.accentSource),
    scope: oneOf(r.scope, ['everywhere', 'fullscreen'] as const, d.scope),
    glass: int(r.glass, 0, 100, d.glass),
    performance: oneOf(r.performance, ['auto', 'quality', 'saver'] as const, d.performance)
  }
}

/**
 * Applies a user edit. Choosing a preset (`{ preset: 'vinyl' }`) copies its look
 * fields (and any other fields in the same patch win over it); editing any look
 * field by hand marks the preset as 'custom'. The result is sanitized.
 */
export function applyAdaptivePatch(prev: AdaptiveSettings, patch: Partial<AdaptiveSettings>): AdaptiveSettings {
  const { preset, ...rest } = patch
  if (preset && preset !== 'custom' && preset in ADAPTIVE_PRESETS) {
    return sanitizeAdaptive({ ...prev, ...ADAPTIVE_PRESETS[preset].values, ...rest, preset })
  }
  const touchesLook = PRESET_FIELDS.some((k) => k in rest && rest[k] !== prev[k])
  return sanitizeAdaptive({ ...prev, ...rest, preset: touchesLook ? 'custom' : (preset ?? prev.preset) })
}

// ---------------------------------------------------------------------------
// Performance tier

export interface DeviceEnv {
  /** Reduced motion in effect (Settings → Motion, or the OS when it is "System"). */
  reducedMotion: boolean
  android: boolean
  /** navigator.hardwareConcurrency, when known. */
  cores?: number
  /** navigator.deviceMemory in GB, when known (Chromium only; capped at 8 by the browser). */
  memory?: number
}

/** An Android device is "low end" when it reports ≤ 4 cores or ≤ 4 GB of memory. */
export function isLowEndAndroid(env: DeviceEnv): boolean {
  if (!env.android) return false
  return (env.cores !== undefined && env.cores > 0 && env.cores <= 4) || (env.memory !== undefined && env.memory > 0 && env.memory <= 4)
}

/**
 * 'auto' resolves to 'saver' when reduced motion is in effect or on a low-end
 * Android device (see isLowEndAndroid); otherwise to 'quality'.
 */
export function resolvePerformance(mode: AdaptivePerformance, env: DeviceEnv): 'quality' | 'saver' {
  if (mode !== 'auto') return mode
  return env.reducedMotion || isLowEndAndroid(env) ? 'saver' : 'quality'
}

// ---------------------------------------------------------------------------
// Resolved rendering parameters

export const SAVER_BLUR_CAP = 24

/** Seconds per cycle for each motion and speed. */
const DURATIONS: Record<Exclude<AdaptiveMotion, 'static' | 'pulse'> | 'aurora', Record<AdaptiveSpeed, number>> = {
  drift: { slow: 60, medium: 36, fast: 20 },
  spin: { slow: 90, medium: 50, fast: 24 },
  aurora: { slow: 40, medium: 24, fast: 14 }
}

export interface ResolvedBackdrop {
  tier: 'quality' | 'saver'
  style: AdaptiveStyle
  /** 0..1 */
  opacity: number
  /** Blur actually applied, px (capped in saver mode). */
  blur: number
  /** Saturation factor (1 = unchanged). */
  saturation: number
  /** Motion actually applied: always 'static' under reduced motion or in saver mode. */
  motion: AdaptiveMotion
  /** Seconds per cycle for drift/spin. */
  motionDuration: number
  /** Whether the aurora gradient drifts by itself. */
  auroraAnimated: boolean
  auroraDuration: number
  /** Glow multiplier, 0..2 (1 = original). */
  glow: number
  grain: boolean
  vignette: boolean
  /** Crossfade between covers in seconds (0 under reduced motion). */
  fade: number
  /** Artwork width to request for the background layer. */
  imageSize: number
}

/** Smallest artwork that still looks sharp enough behind a given blur. */
export function backdropImageSize(blur: number, tier: 'quality' | 'saver'): number {
  if (tier === 'saver') return 160
  if (blur >= 40) return 300
  if (blur >= 16) return 480
  return 640
}

export function resolveBackdrop(s: AdaptiveSettings, env: DeviceEnv): ResolvedBackdrop {
  const tier = resolvePerformance(s.performance, env)
  const still = env.reducedMotion || tier === 'saver'
  const motion: AdaptiveMotion = still ? 'static' : s.motion
  const blur = tier === 'saver' ? Math.min(SAVER_BLUR_CAP, s.blur) : s.blur
  return {
    tier,
    style: s.style,
    opacity: s.visibility / 100,
    blur,
    saturation: s.saturation / 100,
    motion,
    motionDuration: motion === 'drift' || motion === 'spin' ? DURATIONS[motion][s.speed] : 0,
    auroraAnimated: s.style === 'aurora' && !still,
    auroraDuration: DURATIONS.aurora[s.speed],
    glow: s.glow / 50,
    grain: s.grain && tier !== 'saver',
    vignette: s.vignette,
    fade: env.reducedMotion ? 0 : s.fade,
    imageSize: backdropImageSize(blur, tier)
  }
}

/** True when the beat-reactive pulse loop should run at all. */
export function pulseActive(r: Pick<ResolvedBackdrop, 'motion'>, opts: { playing: boolean; freezeOnPause: boolean; visible: boolean }): boolean {
  return r.motion === 'pulse' && opts.visible && (opts.playing || !opts.freezeOnPause)
}

// ---------------------------------------------------------------------------
// Scope & glass

/** Whether the app-wide backdrop (behind every page) is shown. */
export function showAppBackdrop(theme: string, s: Pick<AdaptiveSettings, 'scope'>): boolean {
  return theme === 'adaptive' && s.scope === 'everywhere'
}

/** Whether the fullscreen player uses the adaptive backdrop (in both scopes). */
export function showFullscreenBackdrop(theme: string): boolean {
  return theme === 'adaptive'
}

/** Panel background colours for a glass level (glass 62 = the original 0.38 / 0.32 alphas). */
export function glassColors(glass: number): { main: string; chrome: string; fadeTop: string; fadeBottom: string } {
  const a = 1 - Math.min(100, Math.max(0, glass)) / 100
  const f = (v: number): string => String(Math.round(Math.min(1, v) * 1000) / 1000)
  return {
    main: `rgb(8 8 12 / ${f(a)})`,
    chrome: `rgb(0 0 0 / ${f(a * 0.84)})`,
    fadeTop: `rgb(0 0 0 / ${f(a * 0.92)})`,
    fadeBottom: `rgb(0 0 0 / ${f(a * 1.97)})`
  }
}

// ---------------------------------------------------------------------------
// Readability (auto dim)

/** Secondary text colour of the Adaptive theme (--color-fg-muted, #b3b3bf). */
export const MUTED_TEXT_LUMINANCE = relativeLuminance({ r: 0xb3, g: 0xb3, b: 0xbf })
/** WCAG AA for normal-size text. */
export const AA_CONTRAST = 4.5
export const AUTO_DIM_MIN = 0.2
export const AUTO_DIM_MAX = 0.9
/** Peak alpha of the main accent glow at glow multiplier 1. */
export const GLOW_ALPHA = 0.42

/**
 * Approximation used for the maths below: a black overlay of alpha `a` (and a
 * layer opacity on black) multiplies the gamma-encoded value by (1 - a), so
 * relative luminance scales by roughly (1 - a)^2.2.
 */
const toGamma = (y: number): number => Math.pow(Math.max(0, y), 1 / 2.2)
const toLinear = (v: number): number => Math.pow(Math.max(0, v), 2.2)

/** Brightest luminance a backdrop may have for `textLuminance` to reach `ratio`. */
export function maxBackgroundLuminance(textLuminance = MUTED_TEXT_LUMINANCE, ratio = AA_CONTRAST): number {
  return Math.max(0, (textLuminance + 0.05) / ratio - 0.05)
}

/** Luminance of the backdrop as composed over black, before the dim overlay. */
export function backdropLuminance(opts: { luminance: number; opacity: number; glow: number; accentLuminance: number }): number {
  const v = toGamma(opts.luminance) * opts.opacity + toGamma(opts.accentLuminance) * Math.min(1, GLOW_ALPHA * opts.glow)
  return toLinear(Math.min(1, v))
}

/**
 * Black-overlay alpha (0..1) that keeps the Adaptive theme's secondary text at
 * ≥ WCAG AA (4.5:1) over the backdrop. Clamped to [AUTO_DIM_MIN, AUTO_DIM_MAX]
 * so the look stays consistent on dark covers and never goes fully black.
 */
export function autoDim(backgroundLuminance: number, textLuminance = MUTED_TEXT_LUMINANCE): number {
  const target = toGamma(maxBackgroundLuminance(textLuminance))
  const bg = toGamma(backgroundLuminance)
  const needed = bg <= target ? 0 : 1 - target / bg
  return Math.min(AUTO_DIM_MAX, Math.max(AUTO_DIM_MIN, needed))
}

/** Luminance after a black overlay of alpha `dim` (same approximation as autoDim). */
export function dimmedLuminance(backgroundLuminance: number, dim: number): number {
  return toLinear(toGamma(backgroundLuminance) * (1 - dim))
}

/** Contrast of the secondary text over a backdrop once dimmed. */
export function textContrast(backgroundLuminance: number, dim: number, textLuminance = MUTED_TEXT_LUMINANCE): number {
  return contrastRatio(textLuminance, dimmedLuminance(backgroundLuminance, dim))
}

/** Representative luminance of what a style shows, from the cover palette. */
export function styleLuminance(style: AdaptiveStyle, palette: { luminance: number; colors: Rgb[] }): number {
  if (style === 'cover' || palette.colors.length === 0) return palette.luminance
  // Aurora / solid: the brightest palette colour is the worst case.
  return Math.max(...palette.colors.map(relativeLuminance))
}

/** Final dim overlay alpha (0..1) for the settings and current cover. */
export function resolveDim(
  s: Pick<AdaptiveSettings, 'dimMode' | 'dim'>,
  bg: { luminance: number; opacity: number; glow: number; accentLuminance: number }
): number {
  if (s.dimMode === 'manual') return s.dim / 100
  return autoDim(backdropLuminance(bg))
}

/** Extra darkening while paused (when "freeze on pause" is on). */
export const PAUSE_DIM = 0.12
