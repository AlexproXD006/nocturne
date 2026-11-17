import type { Track } from '../api/types'

export type RepeatMode = 'off' | 'all' | 'one'

export interface QueueContext {
  type: 'album' | 'playlist' | 'artist' | 'search' | 'library' | 'home' | 'tracks'
  id?: string
  name?: string
}

export interface QueueItem {
  uid: string
  track: Track
}

export interface QueueState {
  items: QueueItem[]
  /** Index of the current item, -1 when empty. */
  index: number
  shuffle: boolean
  repeat: RepeatMode
  /** Original order while shuffle is on, so turning it off restores it. */
  ordered: QueueItem[] | null
  context: QueueContext | null
}

export type Rng = () => number

let uidCounter = 0
export function makeUid(): string {
  uidCounter += 1
  return `q${Date.now().toString(36)}${uidCounter.toString(36)}`
}

export const emptyQueue: QueueState = { items: [], index: -1, shuffle: false, repeat: 'off', ordered: null, context: null }

function wrap(tracks: Track[], uid: () => string): QueueItem[] {
  return tracks.map((track) => ({ uid: uid(), track }))
}

/** Fisher–Yates on a copy. */
export function shuffled<T>(list: readonly T[], rng: Rng = Math.random): T[] {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

export function createQueue(
  tracks: Track[],
  startIndex = 0,
  opts: { shuffle?: boolean; repeat?: RepeatMode; context?: QueueContext | null; rng?: Rng; uid?: () => string } = {}
): QueueState {
  const items = wrap(tracks, opts.uid ?? makeUid)
  const repeat = opts.repeat ?? 'off'
  if (items.length === 0) return { ...emptyQueue, repeat, shuffle: opts.shuffle ?? false, context: opts.context ?? null }
  const start = Math.min(Math.max(0, startIndex), items.length - 1)
  if (!opts.shuffle) return { items, index: start, shuffle: false, repeat, ordered: null, context: opts.context ?? null }
  const first = items[start]!
  const rest = shuffled(items.filter((_, i) => i !== start), opts.rng)
  return { items: [first, ...rest], index: 0, shuffle: true, repeat, ordered: items, context: opts.context ?? null }
}

export function currentItem(q: QueueState): QueueItem | null {
  return q.items[q.index] ?? null
}

/** Index to play after the current one. `auto` = track ended by itself. -1 = stop. */
export function nextIndex(q: QueueState, auto: boolean): number {
  if (q.items.length === 0) return -1
  if (auto && q.repeat === 'one') return q.index
  if (q.index + 1 < q.items.length) return q.index + 1
  return q.repeat === 'all' ? 0 : -1
}

export function peekNext(q: QueueState): QueueItem | null {
  const i = nextIndex(q, true)
  return i >= 0 && i !== q.index ? q.items[i]! : null
}

export function advance(q: QueueState, auto: boolean): QueueState | null {
  const i = nextIndex(q, auto)
  return i < 0 ? null : { ...q, index: i }
}

export function previous(q: QueueState): QueueState {
  if (q.items.length === 0) return q
  if (q.index > 0) return { ...q, index: q.index - 1 }
  return q.repeat === 'all' ? { ...q, index: q.items.length - 1 } : { ...q, index: 0 }
}

export function jumpTo(q: QueueState, uid: string): QueueState {
  const i = q.items.findIndex((it) => it.uid === uid)
  return i < 0 ? q : { ...q, index: i }
}

function insertAt<T>(list: T[], at: number, add: T[]): T[] {
  return [...list.slice(0, at), ...add, ...list.slice(at)]
}

export function insertNext(q: QueueState, tracks: Track[], uid: () => string = makeUid): QueueState {
  if (tracks.length === 0) return q
  const add = wrap(tracks, uid)
  if (q.items.length === 0) return { ...q, items: add, index: 0, ordered: q.shuffle ? add : null }
  const items = insertAt(q.items, q.index + 1, add)
  let ordered = q.ordered
  if (ordered) {
    const cur = currentItem(q)
    const pos = cur ? ordered.findIndex((it) => it.uid === cur.uid) : -1
    ordered = insertAt(ordered, pos + 1, add)
  }
  return { ...q, items, ordered }
}

export function append(q: QueueState, tracks: Track[], uid: () => string = makeUid): QueueState {
  if (tracks.length === 0) return q
  const add = wrap(tracks, uid)
  if (q.items.length === 0) return { ...q, items: add, index: 0, ordered: q.shuffle ? add : null }
  return { ...q, items: [...q.items, ...add], ordered: q.ordered ? [...q.ordered, ...add] : null }
}

/** Removes an item. If it was the current one, the following item becomes current. */
export function remove(q: QueueState, uid: string): { queue: QueueState; removedCurrent: boolean } {
  const i = q.items.findIndex((it) => it.uid === uid)
  if (i < 0) return { queue: q, removedCurrent: false }
  const items = q.items.filter((it) => it.uid !== uid)
  const ordered = q.ordered ? q.ordered.filter((it) => it.uid !== uid) : null
  let index = q.index
  const removedCurrent = i === q.index
  if (i < q.index) index -= 1
  if (items.length === 0) index = -1
  else if (index >= items.length) index = items.length - 1
  return { queue: { ...q, items, ordered, index }, removedCurrent }
}

/** Moves the item at `from` to `to` (indices in the visible order). */
export function move(q: QueueState, from: number, to: number): QueueState {
  const n = q.items.length
  if (from === to || from < 0 || to < 0 || from >= n || to >= n) return q
  const items = [...q.items]
  const [it] = items.splice(from, 1)
  items.splice(to, 0, it!)
  let index = q.index
  if (from === q.index) index = to
  else if (from < q.index && to >= q.index) index -= 1
  else if (from > q.index && to <= q.index) index += 1
  return { ...q, items, index }
}

/** Removes everything after the current item. */
export function clearUpcoming(q: QueueState): QueueState {
  if (q.index < 0) return q
  const keep = q.items.slice(0, q.index + 1)
  const keepIds = new Set(keep.map((k) => k.uid))
  return { ...q, items: keep, ordered: q.ordered ? q.ordered.filter((it) => keepIds.has(it.uid)) : null }
}

export function setShuffle(q: QueueState, on: boolean, rng: Rng = Math.random): QueueState {
  if (on === q.shuffle) return q
  if (on) {
    const cur = currentItem(q)
    if (!cur) return { ...q, shuffle: true, ordered: [...q.items] }
    const rest = shuffled(q.items.filter((it) => it.uid !== cur.uid), rng)
    return { ...q, shuffle: true, ordered: [...q.items], items: [cur, ...rest], index: 0 }
  }
  const ordered = q.ordered ?? q.items
  const cur = currentItem(q)
  const found = cur ? ordered.findIndex((it) => it.uid === cur.uid) : -1
  const index = found >= 0 ? found : ordered.length ? 0 : -1
  return { ...q, shuffle: false, ordered: null, items: ordered, index }
}

export function cycleRepeat(mode: RepeatMode): RepeatMode {
  return mode === 'off' ? 'all' : mode === 'all' ? 'one' : 'off'
}

export function upcoming(q: QueueState): QueueItem[] {
  return q.index < 0 ? [] : q.items.slice(q.index + 1)
}
