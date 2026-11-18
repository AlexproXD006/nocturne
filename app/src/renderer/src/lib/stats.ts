import type { StatsDelta, StatsHistoryItem, StatsRange, StatsSummary } from '../api/types'
import { formatDate, formatNumber } from '../i18n/format'
import { getLanguage, getLocale, t, type MessageKey } from '../i18n'
import { artistNames } from './format'
import { pickImage } from './url'

export const RANGE_TABS: ReadonlyArray<{ id: StatsRange; labelKey: MessageKey }> = [
  { id: 'week', labelKey: 'stats.week' },
  { id: 'month', labelKey: 'stats.month' },
  { id: 'year', labelKey: 'stats.year' },
  { id: 'all', labelKey: 'stats.all' }
]

/** 47 → "47 min", 135 → "2 h 15 min", 0.4 → "<1 min". */
export function formatMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return t('dur.min', { m: 0 })
  if (minutes < 1) return t('dur.minShort')
  const total = Math.round(minutes)
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0) return t('dur.min', { m })
  return m === 0 ? t('dur.hShort', { h }) : t('dur.hmShort', { h, m })
}

/** The big headline number: whole minutes with thousands separators. */
export function formatBigMinutes(minutes: number): string {
  return formatNumber(Math.round(Number.isFinite(minutes) ? Math.max(0, minutes) : 0))
}

export interface DeltaView {
  direction: 'up' | 'down' | 'flat'
  text: string
}

/** "+25% vs last week", "-12 min vs last month", or null when there is nothing to compare. */
export function describeDelta(delta: StatsDelta | null, range: StatsRange): DeltaView | null {
  if (!delta || range === 'all') return null
  const unit = t(range === 'week' ? 'stats.unitWeek' : range === 'month' ? 'stats.unitMonth' : 'stats.unitYear')
  const direction = delta.minutes > 0 ? 'up' : delta.minutes < 0 ? 'down' : 'flat'
  if (direction === 'flat') return { direction, text: t('stats.deltaSame', { unit }) }
  const sign = delta.minutes > 0 ? '+' : '-'
  const body =
    delta.minutesPct != null ? `${sign}${Math.abs(Math.round(delta.minutesPct))}%` : `${sign}${formatMinutes(Math.abs(delta.minutes))}`
  return { direction, text: t('stats.deltaVs', { body, unit }) }
}

/** Whether the "next period" arrow is usable (offset 0 is the current period). */
export function canGoForward(range: StatsRange, offset: number): boolean {
  return range !== 'all' && offset > 0
}

export interface Bar {
  start: string
  minutes: number
  /** 0–1 of the tallest bar; 0 when the bucket is empty. Non-empty buckets are at least `minRatio`. */
  ratio: number
}

export function barRatios(items: ReadonlyArray<StatsHistoryItem>, minRatio = 0.03): Bar[] {
  const max = items.reduce((m, i) => Math.max(m, i.minutes), 0)
  return items.map((i) => ({
    start: i.start,
    minutes: i.minutes,
    ratio: max <= 0 || i.minutes <= 0 ? 0 : Math.max(minRatio, i.minutes / max)
  }))
}

/** "2026-11-16" → "Nov 16" (no timezone shifts: parsed as plain parts). */
export function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return formatDate(new Date(Date.UTC(y, m - 1, d)), { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

// ---- Recap card data -------------------------------------------------------

/** Period caption ("Nov 16 – 22, 2026"): English keeps the server's label, other languages are formatted locally with Intl. */
export function periodLabel(s: Pick<StatsSummary, 'range' | 'start' | 'end' | 'label'>): string {
  if (s.range === 'all') return t('stats.all')
  if (getLanguage() === 'en' && s.label) return s.label
  const parse = (iso: string | null): Date | null => {
    const [y, m, d] = (iso ?? '').split('-').map(Number)
    return y && m && d ? new Date(Date.UTC(y, m - 1, d)) : null
  }
  const start = parse(s.start)
  if (!start) return s.label
  const fmt = (o: Intl.DateTimeFormatOptions): Intl.DateTimeFormat => new Intl.DateTimeFormat(getLocale(), { ...o, timeZone: 'UTC' })
  if (s.range === 'year') return fmt({ year: 'numeric' }).format(start)
  if (s.range === 'month') return fmt({ month: 'long', year: 'numeric' }).format(start)
  const end = parse(s.end)
  const last = end ? new Date(end.getTime() - 86_400_000) : new Date(start.getTime() + 6 * 86_400_000)
  return fmt({ month: 'short', day: 'numeric', year: 'numeric' }).formatRange(start, last)
}

export interface RecapArtist {
  name: string
  image: string | null
  minutes: number
}

export interface RecapData {
  heading: string
  periodLabel: string
  totalMinutes: number
  plays: number
  delta: DeltaView | null
  artists: RecapArtist[]
  topTrack: { title: string; artist: string; coverUrl: string | null; plays: number } | null
}


/** Everything the 1080×1920 recap image needs, derived from a summary. */
export function buildRecapData(s: StatsSummary, maxArtists = 5): RecapData {
  const top = s.topTracks[0]
  return {
    heading: t(`stats.recap.${s.range}` as const),
    periodLabel: periodLabel(s),
    totalMinutes: s.totals.minutes,
    plays: s.totals.plays,
    delta: describeDelta(s.delta, s.range),
    artists: s.topArtists.slice(0, maxArtists).map((a) => ({ name: a.artist.name, image: a.artist.image ?? null, minutes: a.minutes })),
    topTrack: top
      ? { title: top.track.title, artist: artistNames(top.track.artists), coverUrl: pickImage(top.track.artwork, 640) ?? null, plays: top.plays }
      : null
  }
}
