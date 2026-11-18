import type { StatsDelta, StatsHistoryItem, StatsRange, StatsSummary } from '../api/types'
import { artistNames } from './format'
import { pickImage } from './url'

export const RANGE_TABS: ReadonlyArray<{ id: StatsRange; label: string }> = [
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'year', label: 'Year' },
  { id: 'all', label: 'All time' }
]

/** 47 → "47 min", 135 → "2 h 15 min", 0.4 → "<1 min". */
export function formatMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '0 min'
  if (minutes < 1) return '<1 min'
  const total = Math.round(minutes)
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0) return `${m} min`
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

/** The big headline number: whole minutes with thousands separators. */
export function formatBigMinutes(minutes: number): string {
  return Math.round(Number.isFinite(minutes) ? Math.max(0, minutes) : 0).toLocaleString('en-US')
}

export interface DeltaView {
  direction: 'up' | 'down' | 'flat'
  text: string
}

/** "+25% vs last week", "-12 min vs last month", or null when there is nothing to compare. */
export function describeDelta(delta: StatsDelta | null, range: StatsRange): DeltaView | null {
  if (!delta || range === 'all') return null
  const unit = range === 'week' ? 'last week' : range === 'month' ? 'last month' : 'last year'
  const direction = delta.minutes > 0 ? 'up' : delta.minutes < 0 ? 'down' : 'flat'
  if (direction === 'flat') return { direction, text: `Same as ${unit}` }
  const sign = delta.minutes > 0 ? '+' : '-'
  const body =
    delta.minutesPct != null ? `${sign}${Math.abs(Math.round(delta.minutesPct))}%` : `${sign}${formatMinutes(Math.abs(delta.minutes))}`
  return { direction, text: `${body} vs ${unit}` }
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
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

// ---- Recap card data -------------------------------------------------------

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

const HEADINGS: Record<StatsRange, string> = { week: 'Weekly recap', month: 'Monthly recap', year: 'Yearly recap', all: 'All-time recap' }

/** Everything the 1080×1920 recap image needs, derived from a summary. */
export function buildRecapData(s: StatsSummary, maxArtists = 5): RecapData {
  const top = s.topTracks[0]
  return {
    heading: HEADINGS[s.range],
    periodLabel: s.label,
    totalMinutes: s.totals.minutes,
    plays: s.totals.plays,
    delta: describeDelta(s.delta, s.range),
    artists: s.topArtists.slice(0, maxArtists).map((a) => ({ name: a.artist.name, image: a.artist.image ?? null, minutes: a.minutes })),
    topTrack: top
      ? { title: top.track.title, artist: artistNames(top.track.artists), coverUrl: pickImage(top.track.artwork, 640) ?? null, plays: top.plays }
      : null
  }
}
