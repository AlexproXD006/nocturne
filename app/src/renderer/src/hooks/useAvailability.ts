import { useConnectivity, useOffline } from '../services'
import { availabilityOf, type Availability } from '../lib/offline/availability'

/** How a track row should look: badge (stored), normal, or greyed out (offline and not stored). */
export function useAvailability(trackId: string): Availability {
  const online = useConnectivity((s) => s.online)
  const stored = useOffline((s) => trackId in s.available)
  return availabilityOf(trackId, stored ? { [trackId]: true } : {}, online)
}

/** Format used by the downloads UI. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  const mb = bytes / (1024 * 1024)
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}
