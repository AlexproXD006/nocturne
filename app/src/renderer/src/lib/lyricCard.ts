/**
 * Canvas rendering for the "share lyrics as image" feature. Draws a premium,
 * Spotify-style lyric card at 1080px into a canvas that doubles as the live
 * preview (scaled down with CSS) and the export source.
 *
 * All drawing is self-contained and synchronous given a pre-loaded cover image
 * (or null). The cover is loaded separately with CORS; if the server does not
 * send CORS headers the image load simply fails and we draw gradient-only, so
 * the canvas is never tainted and export keeps working.
 */

export type CardRatio = 'square' | 'story'

export interface LyricCardContent {
  title: string
  artist: string
  /** Selected lyric lines, already in reading order, non-empty. */
  lines: string[]
}

export const RATIOS: Record<CardRatio, { w: number; h: number }> = {
  square: { w: 1080, h: 1080 },
  story: { w: 1080, h: 1920 }
}

/** Inter is the app font; fall back to the system stack if it hasn't loaded. */
const FONT_STACK = `'Inter', 'Inter Variable', system-ui, -apple-system, 'Segoe UI', sans-serif`

const PAD = 96
const COVER = 128

/** FNV-1a — stable across runs, so a track always maps to the same gradient. */
function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export interface Palette {
  from: string
  to: string
  hue: number
}

/** Two deterministic dark colors derived from the track for the background. */
export function paletteFor(seed: string): Palette {
  const hue = hashString(seed) % 360
  const hue2 = (hue + 36) % 360
  return {
    from: `hsl(${hue}, 46%, 19%)`,
    to: `hsl(${hue2}, 58%, 7%)`,
    hue
  }
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

/** Greedy word-wrap of one lyric line into rows that each fit `maxWidth`. */
function wrapLine(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return ['']
  const rows: string[] = []
  let current = words[0] ?? ''
  for (let i = 1; i < words.length; i++) {
    const word = words[i] ?? ''
    const candidate = `${current} ${word}`
    if (ctx.measureText(candidate).width <= maxWidth) current = candidate
    else {
      rows.push(current)
      current = word
    }
  }
  rows.push(current)
  return rows
}

interface Fit {
  fontSize: number
  lineHeight: number
  rows: string[]
  blockHeight: number
}

function wrapAll(ctx: CanvasRenderingContext2D, lines: string[], maxWidth: number): string[] {
  const rows: string[] = []
  for (const line of lines) for (const row of wrapLine(ctx, line, maxWidth)) rows.push(row)
  return rows
}

/**
 * Shrinks the lyric font until the wrapped block fits the padded safe area.
 * Measures real wrapped-row counts at each size (so up to 10 lines, each
 * possibly wrapping, are accounted for) and picks the largest that fits.
 */
function fitLyrics(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  maxWidth: number,
  maxHeight: number,
  maxFont: number,
  minFont: number
): Fit {
  for (let size = maxFont; size >= minFont; size -= 2) {
    ctx.font = `800 ${size}px ${FONT_STACK}`
    const lineHeight = Math.round(size * 1.22)
    const rows = wrapAll(ctx, lines, maxWidth)
    const blockHeight = rows.length * lineHeight
    if (blockHeight <= maxHeight) return { fontSize: size, lineHeight, rows, blockHeight }
  }
  ctx.font = `800 ${minFont}px ${FONT_STACK}`
  const lineHeight = Math.round(minFont * 1.22)
  const rows = wrapAll(ctx, lines, maxWidth)
  return { fontSize: minFont, lineHeight, rows, blockHeight: rows.length * lineHeight }
}

/** Draws the full card. Call after `document.fonts.ready` so Inter is used. */
export function drawLyricCard(
  canvas: HTMLCanvasElement,
  ratio: CardRatio,
  content: LyricCardContent,
  cover: HTMLImageElement | null
): void {
  const { w, h } = RATIOS[ratio]
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const pal = paletteFor(`${content.title}|${content.artist}`)

  // Background gradient.
  const bg = ctx.createLinearGradient(0, 0, w, h)
  bg.addColorStop(0, pal.from)
  bg.addColorStop(1, pal.to)
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, w, h)

  // Soft colored glow in the top corner for depth.
  const glow = ctx.createRadialGradient(w * 0.18, h * 0.06, 0, w * 0.18, h * 0.06, w * 0.95)
  glow.addColorStop(0, `hsla(${pal.hue}, 70%, 58%, 0.22)`)
  glow.addColorStop(1, 'hsla(0, 0%, 0%, 0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, w, h)

  // Subtle vignette.
  const vignette = ctx.createRadialGradient(w / 2, h / 2, h * 0.18, w / 2, h / 2, h * 0.78)
  vignette.addColorStop(0, 'rgba(0,0,0,0)')
  vignette.addColorStop(1, 'rgba(0,0,0,0.55)')
  ctx.fillStyle = vignette
  ctx.fillRect(0, 0, w, h)

  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'

  // --- Header: cover thumb + title + artist -------------------------------
  let headerBottom = PAD
  let textX = PAD
  let hasCover = false
  if (cover) {
    try {
      ctx.save()
      roundRectPath(ctx, PAD, PAD, COVER, COVER, 28)
      ctx.clip()
      ctx.drawImage(cover, PAD, PAD, COVER, COVER)
      ctx.restore()
      ctx.save()
      roundRectPath(ctx, PAD, PAD, COVER, COVER, 28)
      ctx.lineWidth = 2
      ctx.strokeStyle = 'rgba(255,255,255,0.14)'
      ctx.stroke()
      ctx.restore()
      textX = PAD + COVER + 30
      hasCover = true
    } catch {
      textX = PAD
      hasCover = false
    }
  }

  const titleMaxW = w - textX - PAD
  const titleSize = 42
  const titleLH = 50
  ctx.font = `700 ${titleSize}px ${FONT_STACK}`
  const titleRows = wrapLine(ctx, content.title, titleMaxW).slice(0, 2)
  const artistSize = 30
  const artistLH = 42
  const headerTextH = titleRows.length * titleLH + (content.artist ? artistLH : 0)

  // Vertically center the text block against the cover when present.
  let ty = hasCover ? PAD + Math.max(0, (COVER - headerTextH) / 2) : PAD
  ctx.fillStyle = 'rgba(255,255,255,0.97)'
  ctx.font = `700 ${titleSize}px ${FONT_STACK}`
  for (const row of titleRows) {
    ctx.fillText(row, textX, ty)
    ty += titleLH
  }
  if (content.artist) {
    ctx.font = `500 ${artistSize}px ${FONT_STACK}`
    ctx.fillStyle = 'rgba(255,255,255,0.62)'
    const artistRow = wrapLine(ctx, content.artist, titleMaxW)[0] ?? content.artist
    ctx.fillText(artistRow, textX, ty)
  }
  headerBottom = hasCover ? PAD + Math.max(COVER, headerTextH) : PAD + headerTextH

  // --- Footer wordmark ----------------------------------------------------
  const footerSize = 32
  const footerTop = h - PAD - footerSize
  ctx.font = `600 ${footerSize}px ${FONT_STACK}`
  ctx.fillStyle = 'rgba(255,255,255,0.58)'
  ctx.fillText('♪ Nocturne', PAD, footerTop)

  // --- Lyrics (auto-fit, vertically centered in the middle band) ----------
  const areaTop = headerBottom + 76
  const areaBottom = footerTop - 52
  const areaH = Math.max(80, areaBottom - areaTop)
  const maxFont = ratio === 'story' ? 110 : 90
  const fit = fitLyrics(ctx, content.lines, w - 2 * PAD, areaH, maxFont, 30)

  let blockY = areaTop + Math.max(0, (areaH - fit.blockHeight) / 2)

  // Small accent rule above the lyrics, when there's room.
  const barY = blockY - 42
  if (barY > headerBottom + 10) {
    ctx.fillStyle = `hsla(${pal.hue}, 78%, 64%, 0.95)`
    roundRectPath(ctx, PAD, barY, 72, 8, 4)
    ctx.fill()
  }

  ctx.font = `800 ${fit.fontSize}px ${FONT_STACK}`
  ctx.fillStyle = 'rgba(255,255,255,0.98)'
  for (const row of fit.rows) {
    ctx.fillText(row, PAD, blockY)
    blockY += fit.lineHeight
  }
}

/**
 * Loads the album art with CORS. Resolves null (never rejects) when the image
 * fails or the server has not enabled CORS, so callers fall back to no cover.
 */
export function loadCardImage(url: string | undefined): Promise<HTMLImageElement | null> {
  if (!url) return Promise.resolve(null)
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.referrerPolicy = 'no-referrer'
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = url
  })
}

/** Promisified toBlob that resolves null on taint/SecurityError instead of throwing. */
export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), 'image/png')
    } catch {
      resolve(null)
    }
  })
}

/** Ensures the Inter weights used by the card are loaded before drawing. */
export async function ensureCardFonts(): Promise<void> {
  try {
    await (document.fonts.ready as Promise<unknown>)
    await Promise.all([
      document.fonts.load(`700 42px 'Inter'`),
      document.fonts.load(`800 90px 'Inter'`),
      document.fonts.load(`500 30px 'Inter'`)
    ])
  } catch {
    // Font loading is best-effort; the system fallback is fine.
  }
}
