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

const colorCache = new Map<string, Rgb | null>()

/** Loads an image (CORS) and extracts its accent. Falls back gracefully. */
export function extractAccent(url: string): Promise<Rgb | null> {
  if (colorCache.has(url)) return Promise.resolve(colorCache.get(url) ?? null)
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.onload = () => {
      try {
        const size = 48
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) return resolve(null)
        ctx.drawImage(img, 0, 0, size, size)
        const found = dominantColor(ctx.getImageData(0, 0, size, size).data, 1)
        const accent = found ? toAccent(found) : null
        colorCache.set(url, accent)
        resolve(accent)
      } catch {
        colorCache.set(url, null)
        resolve(null)
      }
    }
    img.onerror = () => {
      colorCache.set(url, null)
      resolve(null)
    }
    img.src = url
  })
}
