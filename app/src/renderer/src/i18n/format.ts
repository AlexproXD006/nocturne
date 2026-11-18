import { getLocale } from './index'

/** Locale-aware formatting helpers (Intl) bound to the active UI language. */

export function formatNumber(n: number, opts?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(getLocale(), opts).format(Number.isFinite(n) ? n : 0)
}

type DateInput = Date | number | string

function toDate(d: DateInput): Date | null {
  const v = d instanceof Date ? d : new Date(d)
  return Number.isNaN(v.getTime()) ? null : v
}

export function formatDate(d: DateInput, opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' }): string {
  const v = toDate(d)
  return v ? new Intl.DateTimeFormat(getLocale(), opts).format(v) : ''
}

export function formatDateTime(d: DateInput): string {
  return formatDate(d, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** "5 min ago" / "hace 5 min" (Intl.RelativeTimeFormat, short style). `seconds` is how long ago (positive = past). */
export function formatRelative(secondsAgo: number): string {
  const rtf = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'always', style: 'short' })
  const s = Math.floor(secondsAgo)
  if (s < 60) return rtf.format(-s, 'second')
  const m = Math.floor(s / 60)
  if (m < 60) return rtf.format(-m, 'minute')
  const h = Math.floor(m / 60)
  if (h < 24) return rtf.format(-h, 'hour')
  return rtf.format(-Math.floor(h / 24), 'day')
}

/** Joins items with the locale's list conjunction ("A, B and C" / "A, B y C"). */
export function formatList(items: string[]): string {
  return new Intl.ListFormat(getLocale(), { style: 'long', type: 'conjunction' }).format(items)
}
