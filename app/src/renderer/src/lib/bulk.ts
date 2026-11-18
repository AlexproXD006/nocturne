/** Pure helpers for filtering a track list and for multi-select / bulk actions. */

/** Server-friendly request size for bulk playlist writes. */
export const BULK_CHUNK = 500

/** Lower-case, accent-insensitive form used for searching. */
export function normalizeText(s: string | undefined | null): string {
  return (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}

interface Searchable {
  title?: string
  artists?: { name: string }[]
  album?: { title: string } | null
}

/** True when every word of the (normalised) query appears in the title, an artist or the album. */
export function matchesQuery(track: Searchable, query: string): boolean {
  const words = normalizeText(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const hay = normalizeText([track.title, ...(track.artists ?? []).map((a) => a.name), track.album?.title].join(' '))
  return words.every((w) => hay.includes(w))
}

/** Indices (into `tracks`) that match the query; all indices for an empty query. */
export function filterIndices(tracks: readonly Searchable[], query: string): number[] {
  const out: number[] = []
  const empty = normalizeText(query) === ''
  for (let i = 0; i < tracks.length; i++) if (empty || matchesQuery(tracks[i]!, query)) out.push(i)
  return out
}

export function chunk<T>(items: readonly T[], size = BULK_CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Runs `fn` over `items` with at most `limit` in flight; rejects with the first error. */
export async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      await fn(items[i]!, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

export interface SelectionState {
  selected: ReadonlySet<string>
  /** Row key of the last plain click, the start of a Shift range. */
  anchor: string | null
}

/**
 * Applies a click on `key` (one of the visible `keys`, in display order).
 * Shift extends from the anchor to `key`; anything else toggles just that row.
 */
export function selectionClick(state: SelectionState, key: string, keys: readonly string[], shift: boolean): SelectionState {
  const next = new Set(state.selected)
  if (shift && state.anchor !== null) {
    const a = keys.indexOf(state.anchor)
    const b = keys.indexOf(key)
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a]
      for (let i = lo; i <= hi; i++) next.add(keys[i]!)
      return { selected: next, anchor: state.anchor }
    }
  }
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return { selected: next, anchor: key }
}

/** Select every visible row, or clear them when they are all selected already. */
export function toggleAll(state: SelectionState, keys: readonly string[]): SelectionState {
  const all = keys.length > 0 && keys.every((k) => state.selected.has(k))
  return { selected: all ? new Set() : new Set(keys), anchor: null }
}
