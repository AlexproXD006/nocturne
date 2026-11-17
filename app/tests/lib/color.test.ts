import { afterEach, describe, expect, it, vi } from 'vitest'
import { dominantColor, extractAccent, FALLBACK_ACCENT, rgbString, toAccent, type Rgb } from '@/lib/color'

function pixels(...colors: Array<[number, number, number, number?]>): number[] {
  return colors.flatMap(([r, g, b, a = 255]) => [r, g, b, a])
}
function repeat(color: [number, number, number, number?], n: number): number[] {
  return pixels(...Array.from({ length: n }, () => color))
}

function hsl({ r, g, b }: Rgb): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === rn ? ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6 : max === gn ? ((bn - rn) / d + 2) / 6 : ((rn - gn) / d + 4) / 6
  return [h, s, l]
}

describe('dominantColor', () => {
  it('returns null for empty data', () => {
    expect(dominantColor([])).toBeNull()
    expect(dominantColor(new Uint8ClampedArray(0))).toBeNull()
  })

  it('returns null for greyscale images', () => {
    expect(dominantColor(repeat([128, 128, 128], 50), 1)).toBeNull()
    expect(dominantColor(repeat([200, 200, 200], 50), 1)).toBeNull()
  })

  it('ignores near-black, near-white and low-saturation pixels', () => {
    expect(dominantColor(repeat([10, 0, 0], 20), 1)).toBeNull() // too dark
    expect(dominantColor(repeat([255, 250, 250], 20), 1)).toBeNull() // too light
    expect(dominantColor(repeat([130, 120, 120], 20), 1)).toBeNull() // desaturated
  })

  it('ignores mostly transparent pixels', () => {
    expect(dominantColor(repeat([220, 30, 30, 100], 30), 1)).toBeNull()
    expect(dominantColor(repeat([220, 30, 30, 128], 30), 1)).not.toBeNull()
  })

  it('finds a solid colour', () => {
    expect(dominantColor(repeat([200, 40, 40], 40), 1)).toEqual({ r: 200, g: 40, b: 40 })
  })

  it('picks the dominant hue by weighted area', () => {
    const data = [...repeat([200, 40, 40], 10), ...repeat([40, 40, 200], 40)]
    expect(dominantColor(data, 1)).toEqual({ r: 40, g: 40, b: 200 })
  })

  it('weights vivid pixels more than dull ones', () => {
    // 10 vivid reds versus 12 duller greens: saturation weighting makes red win.
    const data = [...repeat([230, 20, 20], 10), ...repeat([100, 140, 100], 12)]
    const c = dominantColor(data, 1)!
    expect(c.r).toBeGreaterThan(c.g)
  })

  it('ignores grey pixels mixed into a coloured image', () => {
    const data = [...repeat([128, 128, 128], 100), ...repeat([20, 160, 60], 5)]
    expect(dominantColor(data, 1)).toEqual({ r: 20, g: 160, b: 60 })
  })

  it('averages within a hue bucket', () => {
    const c = dominantColor(pixels([200, 40, 40], [210, 44, 40]), 1)!
    expect(c.r).toBeGreaterThanOrEqual(200)
    expect(c.r).toBeLessThanOrEqual(210)
  })

  it('samples every `step`th pixel', () => {
    // pixel 0 is red, pixel 1 blue, pixel 2 red, pixel 3 blue ...: step 2 sees only reds
    const data = pixels([200, 40, 40], [40, 40, 200], [200, 40, 40], [40, 40, 200], [200, 40, 40])
    expect(dominantColor(data, 2)).toEqual({ r: 200, g: 40, b: 40 })
    expect(dominantColor(data, 1)).toEqual({ r: 200, g: 40, b: 40 }) // red outnumbers blue 3:2
  })

  it('covers every hue sector (red, yellow, green, cyan, blue, magenta)', () => {
    const cases: Rgb[] = [
      { r: 220, g: 30, b: 30 },
      { r: 220, g: 220, b: 30 },
      { r: 30, g: 220, b: 30 },
      { r: 30, g: 220, b: 220 },
      { r: 30, g: 30, b: 220 },
      { r: 220, g: 30, b: 220 },
      { r: 220, g: 30, b: 100 }, // g < b branch of red hue
      { r: 100, g: 30, b: 220 }
    ]
    for (const c of cases) expect(dominantColor(repeat([c.r, c.g, c.b], 5), 1)).toEqual(c)
  })

  it('handles trailing incomplete pixels', () => {
    expect(dominantColor([200, 40, 40, 255, 1, 2], 1)).toEqual({ r: 200, g: 40, b: 40 })
  })

  it('accepts a Uint8ClampedArray', () => {
    expect(dominantColor(new Uint8ClampedArray(repeat([40, 200, 40], 4)), 1)).toEqual({ r: 40, g: 200, b: 40 })
  })
})

describe('toAccent', () => {
  it('normalizes lightness to ~0.64 on a dark UI', () => {
    for (const c of [{ r: 20, g: 30, b: 120 }, { r: 250, g: 240, b: 100 }, { r: 120, g: 20, b: 30 }]) {
      const [, , l] = hsl(toAccent(c))
      expect(l).toBeGreaterThan(0.6)
      expect(l).toBeLessThan(0.68)
    }
  })

  it('clamps saturation into [0.45, 0.85]', () => {
    const dull = hsl(toAccent({ r: 130, g: 120, b: 125 }))
    expect(dull[1]).toBeGreaterThanOrEqual(0.44)
    const vivid = hsl(toAccent({ r: 255, g: 0, b: 0 }))
    expect(vivid[1]).toBeLessThanOrEqual(0.86)
  })

  it('keeps the hue', () => {
    const [h] = hsl(toAccent({ r: 20, g: 40, b: 200 }))
    expect(h).toBeGreaterThan(0.6)
    expect(h).toBeLessThan(0.7)
  })

  it('turns pure grey into a saturated accent of the minimum saturation (s clamped up, hue 0)', () => {
    const c = toAccent({ r: 100, g: 100, b: 100 })
    expect(c.r).toBeGreaterThan(c.b)
  })

  it('output components are integers in range', () => {
    const c = toAccent({ r: 255, g: 255, b: 255 })
    for (const v of [c.r, c.g, c.b]) {
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(255)
    }
  })
})

describe('rgbString', () => {
  it('formats space-separated rgb', () => {
    expect(rgbString({ r: 1, g: 2, b: 3 })).toBe('rgb(1 2 3)')
  })
  it('formats alpha, including 0', () => {
    expect(rgbString({ r: 1, g: 2, b: 3 }, 0.5)).toBe('rgb(1 2 3 / 0.5)')
    expect(rgbString({ r: 1, g: 2, b: 3 }, 0)).toBe('rgb(1 2 3 / 0)')
  })
  it('exposes a fallback accent', () => {
    expect(rgbString(FALLBACK_ACCENT)).toBe('rgb(255 122 92)')
  })
})

describe('extractAccent', () => {
  class FakeImage {
    static instances: FakeImage[] = []
    static behaviour: 'load' | 'error' = 'load'
    crossOrigin = ''
    decoding = ''
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    private _src = ''
    constructor() {
      FakeImage.instances.push(this)
    }
    set src(v: string) {
      this._src = v
      queueMicrotask(() => (FakeImage.behaviour === 'load' ? this.onload?.() : this.onerror?.()))
    }
    get src(): string {
      return this._src
    }
  }

  function stubCanvas(data: number[] | null, opts: { throws?: boolean } = {}): void {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => {
      if (data === null) return null
      return {
        drawImage: () => {
          if (opts.throws) throw new Error('tainted')
        },
        getImageData: () => ({ data: new Uint8ClampedArray(data) })
      }
    }) as never)
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    FakeImage.instances = []
    FakeImage.behaviour = 'load'
  })

  it('extracts an accent from the loaded image and requests it with CORS', async () => {
    vi.stubGlobal('Image', FakeImage)
    stubCanvas(repeat([200, 40, 40], 10))
    const accent = await extractAccent('https://img.test/red.jpg')
    expect(accent).toEqual(toAccent({ r: 200, g: 40, b: 40 }))
    expect(FakeImage.instances[0]!.crossOrigin).toBe('anonymous')
    expect(FakeImage.instances[0]!.src).toBe('https://img.test/red.jpg')
  })

  it('caches by URL (the image is only loaded once)', async () => {
    vi.stubGlobal('Image', FakeImage)
    stubCanvas(repeat([40, 200, 40], 10))
    const a = await extractAccent('https://img.test/green.jpg')
    const b = await extractAccent('https://img.test/green.jpg')
    expect(b).toEqual(a)
    expect(FakeImage.instances).toHaveLength(1)
  })

  it('resolves null for a greyscale image (and caches it)', async () => {
    vi.stubGlobal('Image', FakeImage)
    stubCanvas(repeat([128, 128, 128], 10))
    expect(await extractAccent('https://img.test/grey.jpg')).toBeNull()
    expect(await extractAccent('https://img.test/grey.jpg')).toBeNull()
    expect(FakeImage.instances).toHaveLength(1)
  })

  it('resolves null when the image fails to load', async () => {
    vi.stubGlobal('Image', FakeImage)
    FakeImage.behaviour = 'error'
    expect(await extractAccent('https://img.test/broken.jpg')).toBeNull()
    expect(await extractAccent('https://img.test/broken.jpg')).toBeNull()
    expect(FakeImage.instances).toHaveLength(1)
  })

  it('resolves null when no 2D context is available', async () => {
    vi.stubGlobal('Image', FakeImage)
    stubCanvas(null)
    expect(await extractAccent('https://img.test/noctx.jpg')).toBeNull()
  })

  it('resolves null when the canvas is tainted (drawImage / getImageData throws)', async () => {
    vi.stubGlobal('Image', FakeImage)
    stubCanvas([], { throws: true })
    expect(await extractAccent('https://img.test/tainted.jpg')).toBeNull()
  })
})
