import type { Track } from '../api/types'
import { useConnect, usePlayer } from '../services'
import { currentItem, type QueueContext, type RepeatMode } from '../player/queue'
import type { PlayerStatus } from '../store/player'

/**
 * "Now playing" as the UI should show it: the controlled Connect device's playback while
 * controlling one, else the local player. Each hook selects one primitive / stable value.
 */
export function useIsRemote(): boolean {
  return useConnect((s) => s.remote !== null)
}

export function useRemoteName(): string | null {
  return useConnect((s) => s.remote?.name ?? null)
}

export function useNowTrack(): Track | null {
  const remote = useConnect((s) => (s.remote ? s.remote.state.track ?? null : undefined))
  const local = usePlayer((s) => currentItem(s.queue)?.track ?? null)
  return remote === undefined ? local : remote
}

export function useNowStatus(): PlayerStatus {
  const remote = useConnect((s) => (s.remote ? s.remote.state.status ?? 'idle' : undefined))
  const local = usePlayer((s) => s.status)
  return remote ?? local
}

export function useNowPlaying(): boolean {
  const st = useNowStatus()
  return st === 'playing' || st === 'buffering' || st === 'loading'
}

export function useNowDuration(): number {
  const remote = useConnect((s) => (s.remote ? s.remote.state.duration || s.remote.state.track?.duration || 0 : undefined))
  const local = usePlayer((s) => s.duration)
  return remote ?? local
}

export function useNowShuffle(): boolean {
  const remote = useConnect((s) => (s.remote ? Boolean(s.remote.state.shuffle) : undefined))
  const local = usePlayer((s) => s.queue.shuffle)
  return remote ?? local
}

export function useNowRepeat(): RepeatMode {
  const remote = useConnect((s) => (s.remote ? s.remote.state.repeat ?? 'off' : undefined))
  const local = usePlayer((s) => s.queue.repeat)
  return remote ?? local
}

export function useNowVolume(): { volume: number; muted: boolean } {
  const rv = useConnect((s) => (s.remote ? s.remote.state.volume ?? 1 : undefined))
  const rm = useConnect((s) => (s.remote ? Boolean(s.remote.state.muted) : undefined))
  const lv = usePlayer((s) => s.volume)
  const lm = usePlayer((s) => s.muted)
  return rv === undefined ? { volume: lv, muted: lm } : { volume: rv, muted: rm ?? false }
}

/** Something to show / control: a remote track, or a non-empty local queue. */
export function useHasNowPlaying(): boolean {
  const remote = useConnect((s) => (s.remote ? s.remote.state.track != null : undefined))
  const local = usePlayer((s) => s.queue.items.length > 0)
  return remote ?? local
}

export function useNowContext(): Pick<QueueContext, 'type' | 'id' | 'name'> | null {
  const rt = useConnect((s) => (s.remote ? s.remote.state.context?.type ?? null : undefined))
  const rid = useConnect((s) => s.remote?.state.context?.id)
  const rname = useConnect((s) => s.remote?.state.context?.name)
  const local = usePlayer((s) => s.queue.context)
  if (rt === undefined) return local
  return rt ? { type: rt, id: rid, name: rname } : null
}

/** Re-render trigger for discrete position changes (seeks) of either source. */
export function useNowPositionTick(): number {
  const r = useConnect((s) => (s.remote ? s.remote.at + (s.remote.state.position ?? 0) : undefined))
  const l = usePlayer((s) => s.position)
  return r ?? l
}
