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
  /** Explicitly queued by the user ("Add to queue" / "Play next"): the user queue. */
  queued?: boolean
  /** Added by Autoplay when the queue ran out: similar songs after the context, always at the tail. */
  autoplay?: boolean
}

export interface QueueState {
  items: QueueItem[]
  /** Index of the current item, -1 when empty. */
  index: number
  shuffle: boolean
  repeat: RepeatMode
  /** Original order of the context items (never user-queued ones) while shuffle is on,
   *  so turning it off restores it. */
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

/*
 * Two-tier queue (Spotify style). `items` is the flat play order: history, the current item,
 * then the upcoming items. Right after the current item sits the user queue ("Next in queue":
 * items with `queued`, in the order the user added them); after it the rest of the context
 * ("Next from <album/playlist>"), which is what shuffle reorders. Shuffle never touches the
 * user queue, and when it runs out playback simply continues with the context.
 */

/** Number of user-queued items directly after the current one. */
export function userQueueLength(q: QueueState): number {
  let n = 0
  for (let i = q.index + 1; i < q.items.length && q.items[i]!.queued; i++) n++
  return n
}

/** "Next in queue": the user queue, in play order. */
export function userUpcoming(q: QueueState): QueueItem[] {
  return q.index < 0 ? [] : q.items.slice(q.index + 1, q.index + 1 + userQueueLength(q))
}

/** "Next from <context>": what plays after the user queue runs out. */
export function contextUpcoming(q: QueueState): QueueItem[] {
  return q.index < 0 ? [] : q.items.slice(q.index + 1 + userQueueLength(q)).filter((it) => !it.autoplay)
}

/** "Autoplay": similar songs appended after everything else once the queue ran out. */
export function autoplayUpcoming(q: QueueState): QueueItem[] {
  return q.index < 0 ? [] : q.items.slice(q.index + 1).filter((it) => it.autoplay)
}

/** Appends Autoplay songs at the very end (tracks already in the queue are skipped). */
export function appendAutoplay(q: QueueState, tracks: Track[], uid: () => string = makeUid): QueueState {
  const have = new Set(q.items.map((it) => it.track.id))
  const fresh: Track[] = []
  for (const t of tracks) {
    if (!have.has(t.id)) {
      have.add(t.id)
      fresh.push(t)
    }
  }
  if (fresh.length === 0 || q.index < 0) return q
  return { ...q, items: [...q.items, ...wrap(fresh, uid).map((it) => ({ ...it, autoplay: true }))] }
}

/** Empties the Autoplay section. */
export function clearAutoplay(q: QueueState): QueueState {
  const ids = new Set(autoplayUpcoming(q).map((it) => it.uid))
  return ids.size === 0 ? q : { ...q, items: q.items.filter((it) => !ids.has(it.uid)) }
}

/** True when nothing is left after the current item (the moment Autoplay kicks in). */
export function isAtEnd(q: QueueState): boolean {
  return q.index >= 0 && q.index === q.items.length - 1
}

/** Sets the current index to `index` (in `q.items`) and moves the pending user queue right after it. */
function moveToWithUserQueue(q: QueueState, index: number): QueueState {
  const block = userUpcoming(q)
  if (block.length === 0) return { ...q, index }
  const target = q.items[index]
  if (!target || block.some((b) => b.uid === target.uid)) return { ...q, index }
  const ids = new Set(block.map((b) => b.uid))
  const rest = q.items.filter((it) => !ids.has(it.uid))
  const at = rest.findIndex((it) => it.uid === target.uid)
  return { ...q, items: [...rest.slice(0, at + 1), ...block, ...rest.slice(at + 1)], index: at }
}

export function previous(q: QueueState): QueueState {
  if (q.items.length === 0) return q
  if (q.index > 0) return moveToWithUserQueue(q, q.index - 1)
  return q.repeat === 'all' ? moveToWithUserQueue(q, q.items.length - 1) : { ...q, index: 0 }
}

/** Jumps to an item. Jumping within the context keeps the user queue pending after it. */
export function jumpTo(q: QueueState, uid: string): QueueState {
  const i = q.items.findIndex((it) => it.uid === uid)
  if (i < 0) return q
  if (q.items[i]!.queued) {
    // Skipping ahead inside the user queue drops the queued songs before it (they were skipped).
    const block = userUpcoming(q)
    const k = block.findIndex((b) => b.uid === uid)
    if (k > 0) {
      const skipped = new Set(block.slice(0, k).map((b) => b.uid))
      const items = q.items.filter((it) => !skipped.has(it.uid))
      return { ...q, items, index: items.findIndex((it) => it.uid === uid) }
    }
    return { ...q, index: i }
  }
  return moveToWithUserQueue(q, i)
}

function insertAt<T>(list: T[], at: number, add: T[]): T[] {
  return [...list.slice(0, at), ...add, ...list.slice(at)]
}

/** "Play next": to the front of the user queue. An empty queue just starts with the tracks. */
export function insertNext(q: QueueState, tracks: Track[], uid: () => string = makeUid): QueueState {
  if (tracks.length === 0) return q
  if (q.items.length === 0) {
    const add = wrap(tracks, uid)
    return { ...q, items: add, index: 0, ordered: q.shuffle ? add : null }
  }
  const add = wrap(tracks, uid).map((it) => ({ ...it, queued: true }))
  return { ...q, items: insertAt(q.items, q.index + 1, add) }
}

/** "Add to queue": to the end of the user queue (before the rest of the context). */
export function append(q: QueueState, tracks: Track[], uid: () => string = makeUid): QueueState {
  if (tracks.length === 0) return q
  if (q.items.length === 0) {
    const add = wrap(tracks, uid)
    return { ...q, items: add, index: 0, ordered: q.shuffle ? add : null }
  }
  const add = wrap(tracks, uid).map((it) => ({ ...it, queued: true }))
  return { ...q, items: insertAt(q.items, q.index + 1 + userQueueLength(q), add) }
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

export type QueueSection = 'user' | 'context'

/** Reorders within one upcoming section; `from`/`to` are indices inside that section. */
export function moveInSection(q: QueueState, section: QueueSection, from: number, to: number): QueueState {
  const len = section === 'user' ? userQueueLength(q) : contextUpcoming(q).length
  if (from === to || from < 0 || to < 0 || from >= len || to >= len) return q
  const base = q.index + 1 + (section === 'user' ? 0 : userQueueLength(q))
  return move(q, base + from, base + to)
}

/** Removes everything after the current item. */
export function clearUpcoming(q: QueueState): QueueState {
  if (q.index < 0) return q
  const keep = q.items.slice(0, q.index + 1)
  const keepIds = new Set(keep.map((k) => k.uid))
  return { ...q, items: keep, ordered: q.ordered ? q.ordered.filter((it) => keepIds.has(it.uid)) : null }
}

/** Empties "Next in queue" (the user queue). */
export function clearUserQueue(q: QueueState): QueueState {
  const block = userUpcoming(q)
  if (block.length === 0) return q
  const ids = new Set(block.map((b) => b.uid))
  return { ...q, items: q.items.filter((it) => !ids.has(it.uid)) }
}

/** Empties "Next from <context>", keeping the user queue. */
export function clearContextUpcoming(q: QueueState): QueueState {
  const rest = contextUpcoming(q)
  if (rest.length === 0) return q
  const ids = new Set(rest.map((b) => b.uid))
  return { ...q, items: q.items.filter((it) => !ids.has(it.uid)), ordered: q.ordered ? q.ordered.filter((it) => !ids.has(it.uid)) : null }
}

/** Shuffles / unshuffles the context part only; the user queue keeps its order and place. */
export function setShuffle(q: QueueState, on: boolean, rng: Rng = Math.random): QueueState {
  if (on === q.shuffle) return q
  const cur = currentItem(q)
  const user = userUpcoming(q)
  // Autoplay songs are neither context nor user queue: they stay at the tail, untouched.
  const tail = autoplayUpcoming(q).filter((it) => it.uid !== cur?.uid)
  const extra = (it: QueueItem): boolean => Boolean(it.queued || it.autoplay)
  if (on) {
    // Played user-queued songs are dropped from history; the context keeps all its songs.
    const context = q.items.filter((it) => !extra(it))
    if (!cur) return { ...q, shuffle: true, ordered: context }
    const rest = shuffled(context.filter((it) => it.uid !== cur.uid), rng)
    return { ...q, shuffle: true, ordered: context, items: [cur, ...user, ...rest, ...tail], index: 0 }
  }
  const ordered = q.ordered ?? q.items.filter((it) => !extra(it))
  if (!cur) return { ...q, shuffle: false, ordered: null, items: ordered, index: ordered.length ? 0 : -1 }
  if (!extra(cur)) {
    const pos = ordered.findIndex((it) => it.uid === cur.uid)
    if (pos < 0) return { ...q, shuffle: false, ordered: null, items: ordered, index: ordered.length ? 0 : -1 }
    return { ...q, shuffle: false, ordered: null, items: [...ordered.slice(0, pos + 1), ...user, ...ordered.slice(pos + 1), ...tail], index: pos }
  }
  // A user-queued (or Autoplay) song is playing: resume the context after the last context song played.
  let anchor = -1
  for (let i = q.index - 1; i >= 0 && anchor < 0; i--) {
    const it = q.items[i]!
    if (!extra(it)) anchor = ordered.findIndex((o) => o.uid === it.uid)
  }
  const items = [...ordered.slice(0, anchor + 1), cur, ...user, ...ordered.slice(anchor + 1), ...tail]
  return { ...q, shuffle: false, ordered: null, items, index: anchor + 1 }
}

export function cycleRepeat(mode: RepeatMode): RepeatMode {
  return mode === 'off' ? 'all' : mode === 'all' ? 'one' : 'off'
}

export function upcoming(q: QueueState): QueueItem[] {
  return q.index < 0 ? [] : q.items.slice(q.index + 1)
}
