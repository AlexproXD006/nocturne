import type { Track } from '../../api/types'

const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** Offline search over the tracks stored on this device: every word must appear in title, artist or album. */
export function searchStored(tracks: readonly Track[], query: string, limit = 50): Track[] {
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const out: Track[] = []
  for (const t of tracks) {
    const hay = fold(`${t.title} ${t.artists.map((a) => a.name).join(' ')} ${t.album?.title ?? ''}`)
    if (words.every((w) => hay.includes(w))) {
      out.push(t)
      if (out.length >= limit) break
    }
  }
  return out
}
