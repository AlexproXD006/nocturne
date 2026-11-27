import { describe, expect, it } from 'vitest'
import {
  buildStoryPayload,
  canShareToInstagramStory,
  cssColorToHex,
  FALLBACK_STORY_COLORS,
  hslToHex,
  instagramAppId,
  STICKER_MAX_W,
  stickerLayout,
  storyColorsFromAccent,
  storyColorsFromPalette
} from '../../src/renderer/src/lib/instagramStory'
import { paletteFor } from '../../src/renderer/src/lib/lyricCard'

const info = { integrations: { instagramStories: { appId: '1234567890123456' } } }

describe('button visibility rules', () => {
  it('shows only on android/ios with an app id', () => {
    expect(canShareToInstagramStory('android', info)).toBe(true)
    expect(canShareToInstagramStory('ios', info)).toBe(true)
    expect(canShareToInstagramStory('desktop', info)).toBe(false)
    expect(canShareToInstagramStory('web', info)).toBe(false)
  })
  it('hides without a (valid) app id', () => {
    expect(canShareToInstagramStory('android', null)).toBe(false)
    expect(canShareToInstagramStory('android', {})).toBe(false)
    expect(canShareToInstagramStory('ios', { integrations: { instagramStories: { appId: '' } } })).toBe(false)
    expect(canShareToInstagramStory('ios', { integrations: { instagramStories: { appId: 'abc' } } })).toBe(false)
    expect(instagramAppId({ integrations: { instagramStories: { appId: ' 123456789 ' } } })).toBe('123456789')
  })
})

describe('colour derivation', () => {
  it('converts hsl / rgb / hex to #rrggbb', () => {
    expect(hslToHex(0, 1, 0.5)).toBe('#ff0000')
    expect(hslToHex(120, 1, 0.25)).toBe('#008000')
    expect(hslToHex(0, 0, 1)).toBe('#ffffff')
    expect(cssColorToHex('hsl(240, 100%, 50%)')).toBe('#0000ff')
    expect(cssColorToHex('255 122 92')).toBe('#ff7a5c')
    expect(cssColorToHex('#ABCDEF')).toBe('#abcdef')
    expect(cssColorToHex('nope')).toBeNull()
  })
  it('derives two valid hex colours from the card palette (top lighter than bottom)', () => {
    const c = storyColorsFromPalette(paletteFor('Song|Artist'))
    expect(c.top).toMatch(/^#[0-9a-f]{6}$/)
    expect(c.bottom).toMatch(/^#[0-9a-f]{6}$/)
    const lum = (h: string): number => parseInt(h.slice(1, 3), 16) + parseInt(h.slice(3, 5), 16) + parseInt(h.slice(5, 7), 16)
    expect(lum(c.top)).toBeGreaterThan(lum(c.bottom))
    expect(storyColorsFromPalette({ from: 'x', to: 'y' })).toEqual(FALLBACK_STORY_COLORS)
  })
  it('derives a dim accent gradient', () => {
    const c = storyColorsFromAccent([255, 122, 92])
    expect(c.top).toMatch(/^#[0-9a-f]{6}$/)
    expect(c.bottom).toMatch(/^#[0-9a-f]{6}$/)
    expect(c.top).not.toBe(c.bottom)
  })
})

describe('sticker layout', () => {
  it('keeps the story card under 1080 px wide with transparent margins', () => {
    const l = stickerLayout(1080, 1920, 900)
    expect(l.width).toBeLessThanOrEqual(STICKER_MAX_W)
    expect(l.x).toBeGreaterThan(0)
    expect(l.width).toBe(l.cardW + 2 * l.x)
    expect(l.height).toBe(l.cardH + 2 * l.y)
    expect(l.cardH / l.cardW).toBeCloseTo(1920 / 1080, 2)
  })
  it('clamps oversized requests', () => {
    expect(stickerLayout(1080, 1080, 5000).width).toBeLessThanOrEqual(STICKER_MAX_W)
  })
})

describe('payload', () => {
  it('passes valid colours through and repairs bad ones', () => {
    expect(buildStoryPayload('AAA', '123456', { top: '#AABBCC', bottom: '#001122' })).toEqual({
      imageBase64: 'AAA', appId: '123456', top: '#aabbcc', bottom: '#001122'
    })
    const p = buildStoryPayload('AAA', '1', { top: 'red', bottom: '' })
    expect(p.top).toBe(FALLBACK_STORY_COLORS.top)
    expect(p.bottom).toBe(FALLBACK_STORY_COLORS.bottom)
  })
})
