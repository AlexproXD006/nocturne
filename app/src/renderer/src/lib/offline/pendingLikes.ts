/**
 * Durable queue of like / unlike taps made while offline. The last tap per track wins; entries are sent
 * when the app is back online (see services.ts). A definitive rejection (track gone) drops the entry.
 */
import { ApiError } from '../../api/errors'
import { readJson, writeJson } from '../storage'
import { isNetworkFailure } from './connectivity'

export interface PendingLike {
  trackId: string
  liked: boolean
  at: number
  owner: string
}

export const PENDING_LIKES_KEY = 'nocturne.pendingLikes.v1'
export const MAX_PENDING_LIKES = 500

const isEntries = (v: unknown): v is PendingLike[] =>
  Array.isArray(v) && v.every((e) => e && typeof e.trackId === 'string' && typeof e.liked === 'boolean' && typeof e.at === 'number')

export interface LikeQueueOptions {
  send(trackId: string, liked: boolean): Promise<void>
  owner(): string
  key?: string
  now?: () => number
}

export interface LikeQueue {
  /** Sends now; when the network is down the tap is queued and the call still resolves. */
  set(trackId: string, liked: boolean): Promise<void>
  list(): PendingLike[]
  flush(): Promise<void>
}

export function createLikeQueue(opts: LikeQueueOptions): LikeQueue {
  const key = opts.key ?? PENDING_LIKES_KEY
  const now = opts.now ?? Date.now
  let flushing: Promise<void> | null = null
  const load = (): PendingLike[] => readJson<PendingLike[]>(key, [], isEntries)
  const store = (l: PendingLike[]): void => writeJson(key, l.slice(-MAX_PENDING_LIKES))

  const enqueue = (trackId: string, liked: boolean): void => {
    const owner = opts.owner()
    store([...load().filter((e) => !(e.trackId === trackId && e.owner === owner)), { trackId, liked, at: now(), owner }])
  }

  async function doFlush(): Promise<void> {
    const owner = opts.owner()
    if (!owner) return
    for (const e of load()) {
      if (e.owner !== owner) continue
      try {
        await opts.send(e.trackId, e.liked)
      } catch (err) {
        const s = err instanceof ApiError ? err.status : 0
        if (!(s >= 400 && s < 500 && s !== 401 && s !== 408 && s !== 429)) return // retry later
      }
      // Only drop it if the user did not tap again meanwhile.
      store(load().filter((x) => !(x.trackId === e.trackId && x.owner === e.owner && x.at === e.at)))
    }
  }

  return {
    async set(trackId, liked) {
      try {
        await opts.send(trackId, liked)
        // A newer direct answer supersedes anything queued for the track.
        const owner = opts.owner()
        const rest = load().filter((e) => !(e.trackId === trackId && e.owner === owner))
        if (rest.length !== load().length) store(rest)
      } catch (err) {
        if (!isNetworkFailure(err)) throw err
        enqueue(trackId, liked)
      }
    },
    list: load,
    flush() {
      flushing ??= doFlush().finally(() => {
        flushing = null
      })
      return flushing
    }
  }
}
