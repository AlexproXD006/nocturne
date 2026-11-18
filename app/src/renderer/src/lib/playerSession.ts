import type { QueueContext, QueueItem, QueueState, RepeatMode } from '../player/queue'
import { emptyQueue } from '../player/queue'
import { readJson, removeKey, writeJson } from './storage'

/** What is remembered of the player between runs (app closed, process killed, reboot). */
export interface SavedSession {
  v: 1
  queue: {
    items: QueueItem[]
    index: number
    shuffle: boolean
    repeat: RepeatMode
    /** Uids of the original (unshuffled) context order, or null. */
    ordered: string[] | null
    context: QueueContext | null
  }
  /** Seconds into the current item. */
  position: number
  savedAt: number
}

export const SESSION_KEY = 'nocturne.player.session'
/** Upper bound of stored entries (keeps localStorage small; history before the current item is cut first). */
export const MAX_SAVED_ITEMS = 500

export function serializeSession(queue: QueueState, position: number, now: number): SavedSession | null {
  if (queue.items.length === 0 || queue.index < 0) return null
  let items = queue.items
  let index = queue.index
  if (items.length > MAX_SAVED_ITEMS) {
    const cut = Math.min(index, items.length - MAX_SAVED_ITEMS)
    items = items.slice(cut, cut + MAX_SAVED_ITEMS)
    index -= cut
  }
  return {
    v: 1,
    queue: {
      items,
      index,
      shuffle: queue.shuffle,
      repeat: queue.repeat,
      ordered: queue.ordered ? queue.ordered.map((it) => it.uid) : null,
      context: queue.context
    },
    position: Number.isFinite(position) && position > 0 ? position : 0,
    savedAt: now
  }
}

const isItem = (v: unknown): v is QueueItem => {
  if (!v || typeof v !== 'object') return false
  const r = v as { uid?: unknown; track?: unknown }
  const t = r.track as { id?: unknown; title?: unknown } | undefined
  return typeof r.uid === 'string' && !!t && typeof t === 'object' && typeof t.id === 'string' && typeof t.title === 'string'
}

/** Validates raw stored data; anything malformed gives null (a corrupt entry must never break startup). */
export function parseSavedSession(raw: unknown): SavedSession | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const q = r.queue as Record<string, unknown> | undefined
  if (r.v !== 1 || !q || typeof q !== 'object' || !Array.isArray(q.items)) return null
  const items = q.items.filter(isItem).map((it) => ({
    uid: it.uid,
    track: { ...it.track, artists: Array.isArray(it.track.artists) ? it.track.artists : [], artwork: Array.isArray(it.track.artwork) ? it.track.artwork : [] },
    ...(it.queued ? { queued: true } : {}),
    ...(it.autoplay ? { autoplay: true } : {})
  })) as QueueItem[]
  if (items.length === 0 || items.length !== q.items.length) return null
  const idx = typeof q.index === 'number' && Number.isFinite(q.index) ? Math.trunc(q.index) : 0
  const repeat: RepeatMode = q.repeat === 'all' || q.repeat === 'one' ? q.repeat : 'off'
  const byUid = new Map(items.map((it) => [it.uid, it]))
  let ordered: string[] | null = null
  if (Array.isArray(q.ordered)) ordered = q.ordered.filter((u): u is string => typeof u === 'string' && byUid.has(u))
  const c = q.context as Record<string, unknown> | null | undefined
  const types = ['album', 'playlist', 'artist', 'search', 'library', 'home', 'tracks']
  const context: QueueContext | null =
    c && typeof c === 'object' && typeof c.type === 'string' && types.includes(c.type)
      ? {
          type: c.type as QueueContext['type'],
          ...(typeof c.id === 'string' ? { id: c.id } : {}),
          ...(typeof c.name === 'string' ? { name: c.name } : {})
        }
      : null
  const pos = typeof r.position === 'number' && Number.isFinite(r.position) ? Math.max(0, r.position) : 0
  return {
    v: 1,
    queue: { items, index: Math.min(Math.max(0, idx), items.length - 1), shuffle: q.shuffle === true, repeat, ordered, context },
    position: pos,
    savedAt: typeof r.savedAt === 'number' ? r.savedAt : 0
  }
}

/** Turns a saved session back into queue state. */
export function queueFromSaved(s: SavedSession): QueueState {
  const byUid = new Map(s.queue.items.map((it) => [it.uid, it]))
  const ordered = s.queue.shuffle && s.queue.ordered ? s.queue.ordered.map((u) => byUid.get(u)!).filter(Boolean) : null
  return { ...emptyQueue, items: s.queue.items, index: s.queue.index, shuffle: s.queue.shuffle, repeat: s.queue.repeat, ordered, context: s.queue.context }
}

export function loadSavedSession(): SavedSession | null {
  return parseSavedSession(readJson<unknown>(SESSION_KEY, null))
}

export function storeSavedSession(s: SavedSession | null): void {
  if (s) writeJson(SESSION_KEY, s)
  else removeKey(SESSION_KEY)
}
