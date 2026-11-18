import { formatNumber } from '../i18n/format'
/** Per-track lyrics timing offset. Positive = lyrics appear later, negative = earlier. */
export const OFFSET_STEP_MS = 500
export const OFFSET_MAX_MS = 30000

export function clampOffset(ms: number): number {
  if (!Number.isFinite(ms)) return 0
  return Math.max(-OFFSET_MAX_MS, Math.min(OFFSET_MAX_MS, Math.round(ms)))
}

/** "+1.0s", "−0.5s" (true minus sign) or "0.0s". */
export function formatOffset(ms: number): string {
  const v = clampOffset(ms)
  const n = formatNumber(Math.abs(v) / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  if (v === 0) return `${n}s`
  return `${v > 0 ? '+' : '−'}${n}s`
}

/** Player position (ms) to look up in the lyrics' own timeline: a lyric stamped T shows at T + offset. */
export function lyricsTime(positionMs: number, offsetMs: number): number {
  return positionMs - offsetMs
}

/** Position (seconds) to seek to for a line stamped `lineTimeMs`. */
export function seekTimeFor(lineTimeMs: number, offsetMs: number): number {
  return Math.max(0, (lineTimeMs + offsetMs) / 1000)
}
