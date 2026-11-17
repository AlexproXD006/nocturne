import type { AdminTrack } from '../../../api/types'
import { pickBestMatch, type LyricsFileDescription } from '../../../lyrics/match'

/** Bounded-concurrency task queue. */
export interface Pool {
  push(task: () => Promise<void>): void
  /** Drops tasks that have not started. */
  clear(): void
  /** Resolves when nothing is running or queued. */
  drain(): Promise<void>
  readonly pending: number
}

export function createPool(concurrency: number): Pool {
  let active = 0
  const queue: Array<() => Promise<void>> = []
  let waiters: Array<() => void> = []
  const settle = (): void => {
    if (active === 0 && queue.length === 0) {
      const w = waiters
      waiters = []
      w.forEach((fn) => fn())
    }
  }
  const pump = (): void => {
    while (active < concurrency && queue.length) {
      const task = queue.shift()!
      active++
      task()
        .catch(() => undefined)
        .finally(() => {
          active--
          pump()
          settle()
        })
    }
  }
  return {
    push(task) {
      queue.push(task)
      pump()
    },
    clear() {
      queue.length = 0
      settle()
    },
    drain() {
      return active === 0 && queue.length === 0 ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve))
    },
    get pending() {
      return active + queue.length
    }
  }
}

export type SearchFn = (query: string, signal: AbortSignal) => Promise<AdminTrack[]>

/**
 * Finds candidate tracks for a described file. Searches "artist title" first; servers whose search only
 * looks at one field return nothing for that, so it falls back to the title alone.
 */
export async function findCandidates(desc: Pick<LyricsFileDescription, 'title' | 'artist'>, search: SearchFn, signal: AbortSignal): Promise<AdminTrack[]> {
  const title = desc.title?.trim()
  if (!title) return []
  const artist = desc.artist?.trim()
  const seen = new Map<string, AdminTrack>()
  const add = (list: AdminTrack[]): void => {
    for (const t of list) if (!seen.has(t.id)) seen.set(t.id, t)
  }
  add(await search(`${artist ?? ''} ${title}`.trim(), signal))
  if (seen.size === 0 && artist) add(await search(title, signal))
  return [...seen.values()]
}

export interface Selection {
  selected: AdminTrack | null
  score: number
  /** Pre-checked for saving: only automatic-level matches. */
  checked: boolean
}

/** Chooses the best candidate; `checked` is true only for scores at the automatic threshold. */
export function selectBest(desc: LyricsFileDescription, candidates: AdminTrack[], autoThreshold: number): Selection {
  const best = pickBestMatch(desc, candidates)
  if (!best) return { selected: null, score: 0, checked: false }
  return { selected: best.track as AdminTrack, score: best.score, checked: best.score >= autoThreshold }
}
