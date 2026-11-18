/**
 * Canvas rendering for the "share recap" image: 1080×1920 story card with the period's total
 * minutes, top artists (with photos), top track (with cover) and Nocturne branding. Mirrors
 * lyricCard.ts: drawing is synchronous given pre-loaded images, which may be null (initial/placeholder
 * is drawn instead), so a CORS-failing image never taints the canvas.
 */
import type { RecapData } from './stats'
import { formatBigMinutes } from './stats'

export const RECAP_W = 1080
export const RECAP_H = 1920

const FONT = `'Inter', 'Inter Variable', system-ui, -apple-system, 'Segoe UI', sans-serif`
const PAD = 84

export interface RecapImages {
  artists: Array<HTMLImageElement | null>
  cover: HTMLImageElement | null
}

/** Parses "R G B" (the --accent-rgb format) or "#rrggbb"; falls back to the default accent. */
export function parseAccent(value: string | null | undefined): [number, number, number] {
  const fallback: [number, number, number] = [29, 185, 84]
  if (!value) return fallback
  const v = value.trim()
  const hex = /^#?([0-9a-f]{6})$/i.exec(v)
  if (hex) {
    const n = parseInt(hex[1]!, 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const parts = v.split(/[\s,]+/).map(Number)
  if (parts.length >= 3 && parts.slice(0, 3).every((x) => Number.isFinite(x) && x >= 0 && x <= 255)) {
    return [parts[0]!, parts[1]!, parts[2]!]
  }
  return fallback
}

export function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (ctx.measureText(text.slice(0, mid).trimEnd() + '…').width <= maxWidth) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo).trimEnd() + '…'
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

function drawPhoto(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | null,
  x: number,
  y: number,
  size: number,
  round: boolean,
  label: string,
  rgb: [number, number, number]
): void {
  ctx.save()
  if (round) {
    ctx.beginPath()
    ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2)
  } else roundRect(ctx, x, y, size, size, 28)
  ctx.clip()
  let drawn = false
  if (img) {
    try {
      ctx.drawImage(img, x, y, size, size)
      drawn = true
    } catch {
      drawn = false
    }
  }
  if (!drawn) {
    ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.28)`
    ctx.fillRect(x, y, size, size)
    ctx.fillStyle = 'rgba(255,255,255,0.8)'
    ctx.font = `800 ${Math.round(size * 0.42)}px ${FONT}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText((label.trim()[0] ?? '♪').toUpperCase(), x + size / 2, y + size / 2 + 2)
  }
  ctx.restore()
  ctx.save()
  if (round) {
    ctx.beginPath()
    ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2)
  } else roundRect(ctx, x, y, size, size, 28)
  ctx.lineWidth = 2
  ctx.strokeStyle = 'rgba(255,255,255,0.16)'
  ctx.stroke()
  ctx.restore()
}

export function drawRecapCard(
  canvas: HTMLCanvasElement,
  data: RecapData,
  images: RecapImages,
  accent: [number, number, number]
): void {
  canvas.width = RECAP_W
  canvas.height = RECAP_H
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const [r, g, b] = accent
  const w = RECAP_W
  const h = RECAP_H

  // Background: dark gradient tinted with the accent, plus a glow and vignette.
  const bg = ctx.createLinearGradient(0, 0, w * 0.6, h)
  bg.addColorStop(0, `rgb(${Math.round(r * 0.22 + 10)},${Math.round(g * 0.22 + 10)},${Math.round(b * 0.22 + 12)})`)
  bg.addColorStop(1, '#07070a')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, w, h)
  const glow = ctx.createRadialGradient(w * 0.85, h * 0.08, 0, w * 0.85, h * 0.08, w * 1.0)
  glow.addColorStop(0, `rgba(${r},${g},${b},0.30)`)
  glow.addColorStop(1, `rgba(${r},${g},${b},0)`)
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, w, h)

  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'

  // Header: wordmark + heading.
  ctx.fillStyle = `rgb(${r},${g},${b})`
  ctx.font = `700 40px ${FONT}`
  ctx.fillText('♪ Nocturne', PAD, 132)
  ctx.fillStyle = 'rgba(255,255,255,0.62)'
  ctx.font = `600 34px ${FONT}`
  ctx.textAlign = 'right'
  ctx.fillText(data.heading, w - PAD, 132)
  ctx.textAlign = 'left'

  // Period + big number.
  ctx.fillStyle = 'rgba(255,255,255,0.97)'
  ctx.font = `800 64px ${FONT}`
  ctx.fillText(ellipsize(ctx, data.periodLabel, w - 2 * PAD), PAD, 262)

  const big = formatBigMinutes(data.totalMinutes)
  let size = 250
  ctx.font = `900 ${size}px ${FONT}`
  while (size > 120 && ctx.measureText(big).width > w - 2 * PAD) {
    size -= 10
    ctx.font = `900 ${size}px ${FONT}`
  }
  ctx.fillStyle = `rgb(${r},${g},${b})`
  ctx.fillText(big, PAD - 6, 262 + 40 + size * 0.86)
  const bigBottom = 262 + 40 + size * 0.86
  ctx.fillStyle = 'rgba(255,255,255,0.9)'
  ctx.font = `700 46px ${FONT}`
  ctx.fillText('minutes listened', PAD, bigBottom + 62)

  let y = bigBottom + 62
  const sub = [`${data.plays.toLocaleString('en-US')} ${data.plays === 1 ? 'play' : 'plays'}`, data.delta?.text].filter(Boolean).join('  ·  ')
  ctx.fillStyle = 'rgba(255,255,255,0.58)'
  ctx.font = `500 34px ${FONT}`
  ctx.fillText(sub, PAD, y + 52)
  y += 52 + 70

  // Top artists.
  ctx.fillStyle = 'rgba(255,255,255,0.55)'
  ctx.font = `700 30px ${FONT}`
  ctx.fillText('TOP ARTISTS', PAD, y)
  y += 34
  const rowH = 132
  const photo = 108
  const count = Math.max(1, data.artists.length)
  data.artists.forEach((a, i) => {
    const top = y + i * rowH
    ctx.textAlign = 'left'
    ctx.fillStyle = `rgba(${r},${g},${b},0.95)`
    ctx.font = `800 40px ${FONT}`
    ctx.textBaseline = 'middle'
    ctx.fillText(String(i + 1), PAD, top + photo / 2)
    drawPhoto(ctx, images.artists[i] ?? null, PAD + 56, top, photo, true, a.name, accent)
    const tx = PAD + 56 + photo + 28
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = 'rgba(255,255,255,0.97)'
    ctx.font = `${i === 0 ? 800 : 700} ${i === 0 ? 46 : 40}px ${FONT}`
    ctx.fillText(ellipsize(ctx, a.name, w - PAD - tx), tx, top + photo / 2 + (i === 0 ? 2 : 0))
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    ctx.font = `500 30px ${FONT}`
    ctx.fillText(`${formatBigMinutes(a.minutes)} min`, tx, top + photo / 2 + 42)
  })
  y += count * rowH + 24

  // Top track.
  if (data.topTrack) {
    ctx.textBaseline = 'alphabetic'
    ctx.textAlign = 'left'
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    ctx.font = `700 30px ${FONT}`
    ctx.fillText('TOP TRACK', PAD, y)
    y += 28
    const cover = 220
    drawPhoto(ctx, images.cover, PAD, y, cover, false, data.topTrack.title, accent)
    const tx = PAD + cover + 36
    const maxW = w - PAD - tx
    ctx.fillStyle = 'rgba(255,255,255,0.98)'
    ctx.font = `800 52px ${FONT}`
    ctx.fillText(ellipsize(ctx, data.topTrack.title, maxW), tx, y + 88)
    ctx.fillStyle = 'rgba(255,255,255,0.65)'
    ctx.font = `500 36px ${FONT}`
    ctx.fillText(ellipsize(ctx, data.topTrack.artist, maxW), tx, y + 144)
    ctx.fillStyle = `rgb(${r},${g},${b})`
    ctx.font = `700 32px ${FONT}`
    ctx.fillText(`${data.topTrack.plays.toLocaleString('en-US')} ${data.topTrack.plays === 1 ? 'play' : 'plays'}`, tx, y + 200)
  }

  // Footer.
  ctx.textAlign = 'center'
  ctx.fillStyle = 'rgba(255,255,255,0.4)'
  ctx.font = `500 28px ${FONT}`
  ctx.fillText('Made with Nocturne', w / 2, h - 70)
  ctx.textAlign = 'left'
}

export type { RecapData }
