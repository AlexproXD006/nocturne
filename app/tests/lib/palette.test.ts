import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  analyzePixels,
  cachedPalette,
  contrastRatio,
  dominantColor,
  extractPalette,
  paletteAccent,
  relativeLuminance,
  saturate,
  toAccent,
  toMutedAccent
} from '@/lib/color'

const repeat = (px: number[], n: number): number[] => Array.from({ length: n }, () => [...px, 255]).flat()

describe('relativeLuminance / contrastRatio', () => {
  it('matches WCAG reference values', () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBe(0)
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 6)
    expect(contrastRatio(1, 0)).toBeCloseTo(21, 6)
    expect(contrastRatio(0, 1)).toBeCloseTo(21, 6)
  })
})

describe('saturate', () => {
  it('1 is identity, 0 is grey', () => {
    const c = { r: 200, g: 40, b: 40 }
    expect(saturate(c, 1)).toBe(c)
    const g = saturate(c, 0)
    expect(g.r).toBe(g.g)
    expect(g.g).toBe(g.b)
  })
})

describe('analyzePixels', () => {
  it('dominant equals dominantColor (no change to the historic accent)', () => {
    const data = [...repeat([200, 40, 40], 30), ...repeat([40, 40, 200], 10)]
    expect(analyzePixels(data).dominant).toEqual(dominantColor(data, 1))
  })

  it('finds vibrant and muted colours separately', () => {
    const data = [...repeat([230, 30, 60], 10), ...repeat([110, 120, 100], 30)]
    const p = analyzePixels(data)
    expect(p.vibrant).toEqual({ r: 230, g: 30, b: 60 })
    expect(p.muted).toEqual({ r: 110, g: 120, b: 100 })
  })

  it('greyscale: no colours but a luminance', () => {
    const p = analyzePixels(repeat([255, 255, 255], 20))
    expect(p).toMatchObject({ dominant: null, vibrant: null, muted: null })
    expect(p.luminance).toBeGreaterThan(0.95)
    expect(analyzePixels(repeat([0, 0, 0], 20)).luminance).toBeLessThan(0.02)
  })

  it('luminance is the 75th percentile (bright-leaning)', () => {
    const half = [...repeat([0, 0, 0], 50), ...repeat([255, 255, 255], 50)]
    expect(analyzePixels(half).luminance).toBeGreaterThan(0.95)
    const quarter = [...repeat([0, 0, 0], 80), ...repeat([255, 255, 255], 20)]
    expect(analyzePixels(quarter).luminance).toBeLessThan(0.02)
  })

  it('ignores transparent pixels and empty data', () => {
    expect(analyzePixels([255, 255, 255, 0]).luminance).toBe(0)
    expect(analyzePixels([])).toEqual({ dominant: null, vibrant: null, muted: null, luminance: 0 })
  })
})

describe('paletteAccent', () => {
  const p = { dominant: { r: 200, g: 40, b: 40 }, vibrant: { r: 40, g: 200, b: 40 }, muted: { r: 90, g: 90, b: 120 }, luminance: 0.2 }
  it('maps each source, falling back to dominant', () => {
    expect(paletteAccent(p)).toEqual(toAccent(p.dominant))
    expect(paletteAccent(p, 'vibrant')).toEqual(toAccent(p.vibrant))
    expect(paletteAccent(p, 'muted')).toEqual(toMutedAccent(p.muted))
    expect(paletteAccent({ ...p, vibrant: null, muted: null }, 'vibrant')).toEqual(toAccent(p.dominant))
    expect(paletteAccent({ ...p, vibrant: null, muted: null }, 'muted')).toEqual(toAccent(p.dominant))
    expect(paletteAccent({ ...p, dominant: null, vibrant: null, muted: null })).toBeNull()
    expect(paletteAccent(null)).toBeNull()
  })
})

describe('extractPalette', () => {
  class FakeImage {
    crossOrigin = ''
    decoding = ''
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_v: string) {
      queueMicrotask(() => this.onload?.())
    }
  }
  afterEach(() => vi.unstubAllGlobals())

  it('samples once and caches the palette', async () => {
    vi.stubGlobal('Image', FakeImage)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({
      drawImage: () => undefined,
      getImageData: () => ({ data: new Uint8ClampedArray(repeat([200, 40, 40], 10)) })
    })) as never)
    expect(cachedPalette('https://img.test/p.jpg')).toBeUndefined()
    const p = await extractPalette('https://img.test/p.jpg')
    expect(p?.dominant).toEqual({ r: 200, g: 40, b: 40 })
    expect(cachedPalette('https://img.test/p.jpg')).toBe(p)
    expect(await extractPalette('https://img.test/p.jpg')).toBe(p)
  })
})
