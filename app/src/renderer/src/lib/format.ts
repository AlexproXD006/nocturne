import type { ArtistRef } from '../api/types'

/** 83 → "1:23", 3723 → "1:02:03". */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const s = Math.floor(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** Long-form total: "47 min", "1 hr 12 min". */
export function formatTotal(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 min'
  const totalMin = Math.round(seconds / 60)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h === 0) return `${Math.max(1, m)} min`
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`
}

export function artistNames(artists: ArtistRef[] | undefined): string {
  return (artists ?? []).map((a) => a.name).join(', ')
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`
}

export function greeting(hour: number): string {
  if (hour >= 5 && hour < 12) return 'Good morning'
  if (hour >= 12 && hour < 18) return 'Good afternoon'
  return 'Good evening'
}
