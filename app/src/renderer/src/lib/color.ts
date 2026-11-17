export interface Rgb {
  r: number
  g: number
  b: number
}

export const FALLBACK_ACCENT: Rgb = { r: 255, g: 122, b: 92 }

function rgbToHsl({ r, g, b }: Rgb): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0)
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  return [h / 6, s, l]
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  if (s === 0) {
    const v = Math.round(l * 255)
    return { r: v, g: v, b: v }
  }
  const hue = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return {
    r: Math.round(hue(p, q, h + 1 / 3) * 255),
    g: Math.round(hue(p, q, h) * 255),
    b: Math.round(hue(p, q, h - 1 / 3) * 255)
  }
}

/**
 * Picks a vivid representative color from RGBA pixel data by bucketing hues and
 * weighting by saturation. Returns null for (near) greyscale images.
 */
export function dominantColor(data: Uint8ClampedArray | number[], step = 4): Rgb | null {
  const buckets = new Map<number, { w: number; r: number; g: number; b: number }>()
  for (let i = 0; i + 3 < data.length; i += 4 * step) {
    const a = data[i + 3]!
    if (a < 128) continue
    const px = { r: data[i]!, g: data[i + 1]!, b: data[i + 2]! }
    const [h, s, l] = rgbToHsl(px)
    if (s < 0.2 || l < 0.12 || l > 0.92) continue
    const key = Math.floor(h * 24)
    const w = s * (1 - Math.abs(l - 0.5))
    const b = buckets.get(key) ?? { w: 0, r: 0, g: 0, b: 0 }
    b.w += w
    b.r += px.r * w
    b.g += px.g * w
    b.b += px.b * w
    buckets.set(key, b)
  }
  let best: { w: number; r: number; g: number; b: number } | null = null
  for (const b of buckets.values()) if (!best || b.w > best.w) best = b
  if (!best || best.w <= 0) return null
  return { r: Math.round(best.r / best.w), g: Math.round(best.g / best.w), b: Math.round(best.b / best.w) }
}

/** Makes a color readable as an accent on a near-black background. */
export function toAccent(c: Rgb): Rgb {
  const [h, s] = rgbToHsl(c)
  return hslToRgb(h, Math.min(0.85, Math.max(0.45, s)), 0.64)
}

export function rgbString(c: Rgb, alpha?: number): string {
  return alpha === undefined ? `rgb(${c.r} ${c.g} ${c.b})` : `rgb(${c.r} ${c.g} ${c.b} / ${alpha})`
}

/** WCAG 2.x relative luminance (0 = black, 1 = white) of an sRGB colour. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const lin = (v: number): number => {
    const c = v / 255
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG contrast ratio between two relative luminances (1..21). */
export function contrastRatio(l1: number, l2: number): number {
  const hi = Math.max(l1, l2)
  const lo = Math.min(l1, l2)
  return (hi + 0.05) / (lo + 0.05)
}

/** Scales a colour's HSL saturation by `factor` (1 = unchanged), clamped to [0, 1]. */
export function saturate(c: Rgb, factor: number): Rgb {
  if (factor === 1) return c
  const [h, s, l] = rgbToHsl(c)
  return hslToRgb(h, Math.min(1, Math.max(0, s * factor)), l)
}

/** A softer accent for the "muted" accent source: still readable on a dark UI, but calmer. */
export function toMutedAccent(c: Rgb): Rgb {
  const [h, s] = rgbToHsl(c)
  return hslToRgb(h, Math.min(0.45, Math.max(0.22, s)), 0.7)
}

/**
 * Colours and brightness of an artwork, from one small sampling pass.
 * `dominant` is exactly what dominantColor() picks (the historic accent source);
 * `vibrant` favours the most saturated mid-tones; `muted` the most common calm
 * tones. Any of them is null when the image has no such pixels (e.g. greyscale).
 * `luminance` is the 75th-percentile WCAG relative luminance of the opaque
 * pixels: a deliberately bright-leaning estimate, so text placed over the
 * lighter parts of a (blurred) cover still gets enough contrast.
 */
export interface ImagePalette {
  dominant: Rgb | null
  vibrant: Rgb | null
  muted: Rgb | null
  luminance: number
}

type Acc = { w: number; r: number; g: number; b: number }

function heaviest(buckets: Map<number, Acc>): Rgb | null {
  let best: Acc | null = null
  for (const b of buckets.values()) if (!best || b.w > best.w) best = b
  if (!best || best.w <= 0) return null
  return { r: Math.round(best.r / best.w), g: Math.round(best.g / best.w), b: Math.round(best.b / best.w) }
}

function add(buckets: Map<number, Acc>, key: number, px: Rgb, w: number): void {
  const b = buckets.get(key) ?? { w: 0, r: 0, g: 0, b: 0 }
  b.w += w
  b.r += px.r * w
  b.g += px.g * w
  b.b += px.b * w
  buckets.set(key, b)
}

export function analyzePixels(data: Uint8ClampedArray | number[], step = 1): ImagePalette {
  const vibrant = new Map<number, Acc>()
  const muted = new Map<number, Acc>()
  const hist = new Array<number>(64).fill(0)
  let count = 0
  for (let i = 0; i + 3 < data.length; i += 4 * step) {
    if (data[i + 3]! < 128) continue
    const px = { r: data[i]!, g: data[i + 1]!, b: data[i + 2]! }
    const lum = relativeLuminance(px)
    hist[Math.min(63, Math.floor(lum * 64))]!++
    count++
    const [h, s, l] = rgbToHsl(px)
    const key = Math.floor(h * 24)
    if (s >= 0.4 && l >= 0.25 && l <= 0.8) add(vibrant, key, px, s * s)
    else if (s >= 0.08 && s < 0.4 && l >= 0.15 && l <= 0.85) add(muted, key, px, 1)
  }
  let luminance = 0
  if (count > 0) {
    const target = count * 0.75
    let acc = 0
    for (let k = 0; k < 64; k++) {
      acc += hist[k]!
      if (acc >= target) {
        luminance = (k + 0.5) / 64
        break
      }
    }
  }
  return { dominant: dominantColor(data, step), vibrant: heaviest(vibrant), muted: heaviest(muted), luminance }
}

export type AccentSource = 'dominant' | 'vibrant' | 'muted'

/**
 * The UI accent for a palette and source. Falls back to the dominant colour
 * when the requested one is missing; null when the image has no colour at all.
 */
export function paletteAccent(p: ImagePalette | null, source: AccentSource = 'dominant'): Rgb | null {
  if (!p) return null
  if (source === 'vibrant' && p.vibrant) return toAccent(p.vibrant)
  if (source === 'muted' && p.muted) return toMutedAccent(p.muted)
  return p.dominant ? toAccent(p.dominant) : null
}

const paletteCache = new Map<string, ImagePalette | null>()

/** Synchronous cache lookup (undefined = not sampled yet). */
export function cachedPalette(url: string): ImagePalette | null | undefined {
  return paletteCache.get(url)
}

/**
 * Loads an image (CORS) and samples it once at 48x48 for its palette and
 * luminance. Cached per URL; resolves null when the image can't be read.
 */
export function extractPalette(url: string): Promise<ImagePalette | null> {
  if (paletteCache.has(url)) return Promise.resolve(paletteCache.get(url) ?? null)
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    const done = (p: ImagePalette | null): void => {
      paletteCache.set(url, p)
      resolve(p)
    }
    img.onload = () => {
      try {
        const size = 48
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) return done(null)
        ctx.drawImage(img, 0, 0, size, size)
        done(analyzePixels(ctx.getImageData(0, 0, size, size).data, 1))
      } catch {
        done(null)
      }
    }
    img.onerror = () => done(null)
    img.src = url
  })
}

/** Loads an image (CORS) and extracts its accent. Falls back gracefully. */
export function extractAccent(url: string): Promise<Rgb | null> {
  return extractPalette(url).then((p) => paletteAccent(p, 'dominant'))
}
