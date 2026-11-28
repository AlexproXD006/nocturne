import type { Track } from '../../api/types'

export type Availability = 'available' | 'unavailable' | 'normal'

/**
 * How a row looks: online everything is 'normal' except downloaded/cached tracks, which show the badge
 * ('available'); offline the tracks that are not stored are 'unavailable' (greyed out, skipped).
 */
export function availabilityOf(id: string, available: ReadonlySet<string> | Record<string, unknown>, online: boolean): Availability {
  const has = available instanceof Set ? available.has(id) : Object.prototype.hasOwnProperty.call(available, id)
  if (has) return 'available'
  return online ? 'normal' : 'unavailable'
}

/** The "Disponibles sin conexión" filter. */
export function onlyAvailable<T extends Pick<Track, 'id'>>(tracks: readonly T[], available: ReadonlySet<string> | Record<string, unknown>): T[] {
  return tracks.filter((t) => availabilityOf(t.id, available, true) === 'available')
}

/** Index of the next playable track after `from` (wrapping only when `wrap`), or -1. */
export function nextAvailableIndex(ids: readonly string[], from: number, available: ReadonlySet<string> | Record<string, unknown>, wrap = false): number {
  const n = ids.length
  for (let step = 1; step < n; step++) {
    const i = from + step
    if (i >= n && !wrap) return -1
    const id = ids[i % n]!
    if (availabilityOf(id, available, false) === 'available') return i % n
  }
  return -1
}
