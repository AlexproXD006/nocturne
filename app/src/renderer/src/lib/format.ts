import type { ArtistRef } from '../api/types'
import { t, type MessageKey } from '../i18n'

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
  if (!Number.isFinite(seconds) || seconds <= 0) return t('dur.min', { m: 0 })
  const totalMin = Math.round(seconds / 60)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h === 0) return t('dur.min', { m: Math.max(1, m) })
  return m === 0 ? t('dur.hr', { h }) : t('dur.hrMin', { h, m })
}

export function artistNames(artists: ArtistRef[] | undefined): string {
  return (artists ?? []).map((a) => a.name).join(', ')
}

/** "1 song" / "2 songs" in the active language: `key` is a plural message taking `{count}`. */
export function plural(n: number, key: MessageKey = 'common.song'): string {
  return t(key, { count: n })
}

export function greeting(hour: number): string {
  if (hour >= 5 && hour < 12) return t('greet.morning')
  if (hour >= 12 && hour < 18) return t('greet.afternoon')
  return t('greet.evening')
}
