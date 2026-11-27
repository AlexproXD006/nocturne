import type { PlatformKind } from '../platform'
import type { ServerInfo } from '../api/types'

/**
 * "Share to Instagram Story": the card is rendered as a STICKER PNG (the card itself with transparent
 * margins) over a two-colour gradient background derived from the cover palette. Pure helpers only;
 * the native hand-off lives in platform/instagramStory.ts.
 */

/** Instagram scales stickers itself; larger images only bloat the intent / pasteboard. */
export const STICKER_MAX_W = 1080
/** Transparent margin around the card, as a fraction of the sticker width. */
export const STICKER_MARGIN = 0.06
/** Soft cap for the PNG (Android binder / pasteboard friendliness). */
export const STICKER_MAX_BYTES = 1_000_000
/** Card widths tried (px) until the PNG fits STICKER_MAX_BYTES. */
export const STICKER_WIDTHS = [900, 760, 640, 520, 420]

export interface StoryColors {
  /** `#rrggbb` */
  top: string
  /** `#rrggbb` */
  bottom: string
}

export interface StoryPayload extends StoryColors {
  /** Base64 PNG, no data-URL prefix. */
  imageBase64: string
  appId: string
}

export type StoryResult = 'opened' | 'not-installed' | 'cancelled'

const HEX = /^#[0-9a-f]{6}$/i

/** The public Facebook App ID, only when it is a plausible numeric id. */
export function instagramAppId(info: Pick<ServerInfo, 'integrations'> | null | undefined): string | null {
  const id = info?.integrations?.instagramStories?.appId
  return typeof id === 'string' && /^\d{5,25}$/.test(id.trim()) ? id.trim() : null
}

/** The button exists only in the Android / iOS apps and only when the server provides an App ID. */
export function canShareToInstagramStory(kind: PlatformKind, info: Pick<ServerInfo, 'integrations'> | null | undefined): boolean {
  return (kind === 'android' || kind === 'ios') && instagramAppId(info) !== null
}

const clamp255 = (n: number): number => Math.max(0, Math.min(255, Math.round(n)))

export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => clamp255(v).toString(16).padStart(2, '0')).join('')
}

export function hslToHex(h: number, s: number, l: number): string {
  const hh = (((h % 360) + 360) % 360) / 360
  const ss = Math.max(0, Math.min(1, s))
  const ll = Math.max(0, Math.min(1, l))
  const f = (n: number): number => {
    const k = (n + hh * 12) % 12
    return ll - ss * Math.min(ll, 1 - ll) * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return rgbToHex(f(0) * 255, f(8) * 255, f(4) * 255)
}

/** Accepts `#rrggbb`, `hsl(h, s%, l%)` or "r g b"; null when unparseable. */
export function cssColorToHex(css: string): string | null {
  const v = css.trim()
  if (HEX.test(v)) return v.toLowerCase()
  const hsl = /^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%/i.exec(v)
  if (hsl) return hslToHex(Number(hsl[1]), Number(hsl[2]) / 100, Number(hsl[3]) / 100)
  const rgb = /^(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})$/.exec(v)
  if (rgb) return rgbToHex(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]))
  return null
}

export const FALLBACK_STORY_COLORS: StoryColors = { top: '#1c2433', bottom: '#080b12' }

/** Top / bottom background from a card palette (`paletteFor`: from = lighter, to = darker). */
export function storyColorsFromPalette(pal: { from: string; to: string }): StoryColors {
  return {
    top: cssColorToHex(pal.from) ?? FALLBACK_STORY_COLORS.top,
    bottom: cssColorToHex(pal.to) ?? FALLBACK_STORY_COLORS.bottom
  }
}

/** Top / bottom background from an accent colour: a dim tint fading into near-black. */
export function storyColorsFromAccent(accent: [number, number, number]): StoryColors {
  const mix = (k: number): string => rgbToHex(accent[0] * k + 8 * (1 - k), accent[1] * k + 10 * (1 - k), accent[2] * k + 16 * (1 - k))
  return { top: mix(0.34), bottom: mix(0.07) }
}

export interface StickerLayout {
  /** Whole PNG. */
  width: number
  height: number
  /** Where the card is drawn. */
  x: number
  y: number
  cardW: number
  cardH: number
  radius: number
}

/** Card of `cardW` px wide centred on a transparent canvas; never wider than STICKER_MAX_W. */
export function stickerLayout(srcW: number, srcH: number, cardW: number): StickerLayout {
  const margin = Math.round(cardW * STICKER_MARGIN)
  const cw = Math.max(1, Math.min(Math.round(cardW), STICKER_MAX_W - 2 * margin))
  const m = Math.round(cw * STICKER_MARGIN)
  const ch = Math.max(1, Math.round((cw * srcH) / Math.max(1, srcW)))
  return { width: cw + 2 * m, height: ch + 2 * m, x: m, y: m, cardW: cw, cardH: ch, radius: Math.round(cw * 0.045) }
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'))
}

/** Renders `source` as a rounded sticker PNG ≤ STICKER_MAX_W wide, shrinking until it is ≤ STICKER_MAX_BYTES. */
export async function renderSticker(source: HTMLCanvasElement): Promise<Blob> {
  let last: Blob | null = null
  for (const w of STICKER_WIDTHS) {
    const lay = stickerLayout(source.width, source.height, w)
    const c = document.createElement('canvas')
    c.width = lay.width
    c.height = lay.height
    const ctx = c.getContext('2d')
    if (!ctx) throw new Error('No 2D context')
    ctx.beginPath()
    ctx.roundRect(lay.x, lay.y, lay.cardW, lay.cardH, lay.radius)
    ctx.clip()
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(source, lay.x, lay.y, lay.cardW, lay.cardH)
    const blob = await toBlob(c)
    if (!blob) continue
    last = blob
    if (blob.size <= STICKER_MAX_BYTES) return blob
  }
  if (!last) throw new Error('Could not render the sticker')
  return last
}

export function buildStoryPayload(imageBase64: string, appId: string, colors: StoryColors): StoryPayload {
  const ok = (c: string, fb: string): string => (HEX.test(c) ? c.toLowerCase() : fb)
  return {
    imageBase64,
    appId,
    top: ok(colors.top, FALLBACK_STORY_COLORS.top),
    bottom: ok(colors.bottom, FALLBACK_STORY_COLORS.bottom)
  }
}
