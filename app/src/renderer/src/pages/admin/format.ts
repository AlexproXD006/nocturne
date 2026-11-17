import type { AdminSource } from '../../api/types'

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const

/** 0 → "0 B", 1536 → "1.5 KB", 5_368_709_120 → "5 GB". Binary (1024) steps. */
export function formatBytes(bytes: number | undefined | null): string {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes) || bytes <= 0) return '0 B'
  let i = Math.min(UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  let value = bytes / 1024 ** i
  // 1023.96 KB would round to "1024 KB"; promote it.
  if (i > 0 && Number(value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)) >= 1024 && i < UNITS.length - 1) {
    i += 1
    value = bytes / 1024 ** i
  }
  if (i === 0) return `${Math.round(value)} B`
  const text = value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)
  return `${text.includes('.') ? text.replace(/\.?0+$/, '') : text} ${UNITS[i]}`
}

/** Share of the volume that is used, 0..1; null when free space is unknown. */
export function usageFraction(used: number, free: number | undefined): number | null {
  if (free === undefined || !Number.isFinite(free) || free < 0 || !Number.isFinite(used) || used < 0) return null
  const total = used + free
  return total > 0 ? Math.min(1, used / total) : null
}

/** "just now", "42 s ago", "5 min ago", "3 hr ago", "2 d ago", then a short date. Empty for invalid input. */
export function relativeTime(iso: string | undefined | null, now: number = Date.now()): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const s = Math.floor((now - t) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s} s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} hr ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} d ago`
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function formatDateTime(iso: string | undefined | null): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  return new Date(t).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const SPOTIFY_HOSTS = new Set(['open.spotify.com', 'play.spotify.com'])
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'])

export interface DetectedLink {
  source: AdminSource
  /** Normalised, absolute https URL. */
  url: string
}

/** Recognises a Spotify / YouTube link. Accepts scheme-less input ("open.spotify.com/track/…"). */
export function detectSource(input: string): DetectedLink | null {
  const raw = input.trim()
  if (!raw || /\s/.test(raw)) return null
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const host = url.hostname.toLowerCase()
  if (SPOTIFY_HOSTS.has(host)) {
    return url.pathname.length > 1 ? { source: 'spotify', url: url.toString() } : null
  }
  if (YOUTUBE_HOSTS.has(host)) {
    const hasTarget = host === 'youtu.be' ? url.pathname.length > 1 : url.pathname.length > 1 || url.searchParams.has('v') || url.searchParams.has('list')
    return hasTarget ? { source: 'youtube', url: url.toString() } : null
  }
  return null
}

const LOWER = 'abcdefghjkmnpqrstuvwxyz'
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const DIGITS = '23456789'
const SYMBOLS = '!@#$%^&*-_=+?'

type RandomSource = (array: Uint32Array) => Uint32Array

function randomIndex(max: number, random: RandomSource): number {
  // Rejection sampling avoids modulo bias.
  const limit = Math.floor(0x1_0000_0000 / max) * max
  const buf = new Uint32Array(1)
  for (;;) {
    random(buf)
    if (buf[0]! < limit) return buf[0]! % max
  }
}

/** Strong random password with at least one of each character class. Uses crypto.getRandomValues. */
export function generatePassword(length = 18, random: RandomSource = (a) => crypto.getRandomValues(a)): string {
  const len = Math.max(12, Math.floor(length))
  const all = LOWER + UPPER + DIGITS + SYMBOLS
  const chars = [LOWER, UPPER, DIGITS, SYMBOLS].map((set) => set[randomIndex(set.length, random)]!)
  while (chars.length < len) chars.push(all[randomIndex(all.length, random)]!)
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1, random)
    ;[chars[i], chars[j]] = [chars[j]!, chars[i]!]
  }
  return chars.join('')
}
