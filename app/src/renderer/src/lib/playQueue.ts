/**
 * Durable queue of play reports. A listen in progress is saved every ~15 s, so if the app is killed
 * the plays are not lost: the next start (or the next `online` event) sends them. Every entry carries a
 * client-generated `playId`; the server ignores a play id it has already stored, so a retry after an
 * unknown outcome never double counts.
 */
import { ApiError } from '../api/errors'
import { readJson, writeJson } from './storage'

export interface PendingPlay {
  playId: string
  trackId: string
  seconds: number
  /** ISO time the listen started. */
  at: string
  /** Track duration in seconds (0 when unknown). */
  dur: number
  /** Account id the play belongs to. */
  owner: string
}

export const PENDING_KEY = 'nocturne.pendingPlays.v1'
export const MAX_PENDING = 200
export const MAX_PENDING_AGE_MS = 14 * 24 * 3600_000
/** How often (listened seconds) the in-progress entry is persisted. */
export const PERSIST_EVERY_S = 15

/** A play counts after 30 s or half the track. */
export function qualifies(seconds: number, dur: number): boolean {
  return seconds >= 30 || (dur > 0 && seconds >= dur * 0.5)
}

let counter = 0
export function newPlayId(): string {
  try {
    const c = globalThis.crypto as Crypto | undefined
    if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  } catch {
    /* fall through */
  }
  counter += 1
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}${counter}`
}

function isEntries(v: unknown): v is PendingPlay[] {
  return (
    Array.isArray(v) &&
    v.every(
      (e) =>
        e && typeof e.playId === 'string' && typeof e.trackId === 'string' && typeof e.seconds === 'number' &&
        typeof e.at === 'string'
    )
  )
}

export interface PlayQueueOptions {
  send(play: PendingPlay): Promise<void>
  /** Current account id ('' when signed out: nothing is sent). */
  owner(): string
  key?: string
  now?: () => number
}

export interface PlayQueue {
  /** Persist an in-progress listen (not sent until completed or the app restarts). */
  save(play: Omit<PendingPlay, 'owner'>): void
  /** Mark a listen as finished and ready to send. */
  complete(play: Omit<PendingPlay, 'owner'>): void
  drop(playId: string): void
  list(): PendingPlay[]
  flush(): Promise<void>
}

export function createPlayQueue(opts: PlayQueueOptions): PlayQueue {
  const key = opts.key ?? PENDING_KEY
  const now = opts.now ?? Date.now
  /** Listens of this process that are still being played: never sent by a flush. */
  const live = new Set<string>()
  let flushing: Promise<void> | null = null

  const load = (): PendingPlay[] => readJson<PendingPlay[]>(key, [], isEntries)
  const store = (list: PendingPlay[]): void => {
    const fresh = list.filter((e) => {
      const t = Date.parse(e.at)
      return !Number.isFinite(t) || now() - t < MAX_PENDING_AGE_MS
    })
    writeJson(key, fresh.length > MAX_PENDING ? fresh.slice(fresh.length - MAX_PENDING) : fresh)
  }
  const upsert = (p: PendingPlay): void => {
    const list = load()
    const i = list.findIndex((e) => e.playId === p.playId)
    if (i >= 0) list[i] = p
    else list.push(p)
    store(list)
  }
  const remove = (playId: string): void => store(load().filter((e) => e.playId !== playId))

  async function doFlush(): Promise<void> {
    const owner = opts.owner()
    if (!owner) return
    for (const e of load()) {
      if (live.has(e.playId) || e.owner !== owner) continue
      if (!qualifies(e.seconds, e.dur)) {
        remove(e.playId)
        continue
      }
      try {
        await opts.send(e)
        remove(e.playId)
      } catch (err) {
        // A definitive rejection (track deleted, bad request) will never succeed: drop it.
        // Network errors, 5xx, 401 and 429 are retried on the next flush.
        const s = err instanceof ApiError ? err.status : 0
        if (s >= 400 && s < 500 && s !== 401 && s !== 408 && s !== 429) remove(e.playId)
        else return
      }
    }
  }

  return {
    save(play) {
      live.add(play.playId)
      upsert({ ...play, owner: opts.owner() })
    },
    complete(play) {
      live.delete(play.playId)
      upsert({ ...play, owner: opts.owner() })
    },
    drop(playId) {
      live.delete(playId)
      remove(playId)
    },
    list: load,
    flush() {
      if (!flushing) {
        flushing = doFlush().finally(() => {
          flushing = null
        })
      }
      return flushing
    }
  }
}
