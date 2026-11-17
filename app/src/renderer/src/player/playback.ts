import type { StoreApi } from 'zustand'
import { CONNECT_MAX_TRACK_IDS, type ConnectContext, type Track } from '../api/types'
import type { PlayerState } from '../store/player'
import type { ConnectStoreState } from '../store/connect'
import { cycleRepeat, type QueueContext } from './queue'

/**
 * One entry point for every "play" / transport action in the UI. When this device is
 * controlling a remote Connect session the action becomes a command to that session;
 * otherwise it goes to the local player. Pages and components call this instead of
 * `usePlayer.getState().playTracks(...)` so remote control works everywhere.
 */
export interface Playback {
  /** True while actions are routed to a remote session. */
  isRemote(): boolean
  playTracks(tracks: Track[], startIndex?: number, context?: QueueContext | null, opts?: { shuffle?: boolean }): Promise<void>
  /** Adds to the end of the user queue. Returns an undo function (local only), else null. */
  addToQueue(tracks: Track[]): (() => void) | null
  addNext(tracks: Track[]): void
  toggle(): void
  play(): void
  pause(): void
  next(): void
  previous(): void
  seek(seconds: number): void
  setShuffle(on: boolean): void
  cycleRepeat(): void
  setVolume(v: number): void
  toggleMute(): void
  /** Current position (remote: interpolated). */
  position(): number
  volume(): number
  shuffle(): boolean
  /** Something is loaded (remote track, or a non-empty local queue). */
  hasItem(): boolean
}

export interface PlaybackDeps {
  player: Pick<StoreApi<PlayerState>, 'getState'>
  connect: Pick<StoreApi<ConnectStoreState>, 'getState'>
}

const ACTIVE = new Set(['playing', 'buffering', 'loading'])

/** Fits a long list into the command limit, keeping a window around the start track. */
export function windowIds(ids: string[], startIndex: number, max = CONNECT_MAX_TRACK_IDS): { ids: string[]; startIndex: number } {
  const start = Math.min(Math.max(0, startIndex), Math.max(0, ids.length - 1))
  if (ids.length <= max) return { ids, startIndex: start }
  const from = Math.min(Math.max(0, start - Math.floor(max / 2)), ids.length - max)
  return { ids: ids.slice(from, from + max), startIndex: start - from }
}

function capIds(tracks: Track[]): string[] {
  return tracks.slice(0, CONNECT_MAX_TRACK_IDS).map((t) => t.id)
}

export function createPlayback({ player, connect }: PlaybackDeps): Playback {
  const c = (): ConnectStoreState => connect.getState()
  const p = (): PlayerState => player.getState()
  const remote = (): boolean => c().controlling !== null && c().remote !== null

  const api: Playback = {
    isRemote: remote,

    async playTracks(...args) {
      const [tracks, startIndex = 0, context = null, opts = {}] = args
      if (tracks.length === 0) return
      // Local: pass the arguments through untouched.
      if (!remote()) return p().playTracks(...args)
      const w = windowIds(tracks.map((t) => t.id), startIndex)
      const first = tracks[Math.min(Math.max(0, startIndex), tracks.length - 1)]!
      const ctx: ConnectContext = context ? { type: context.type, id: context.id, name: context.name } : { type: 'tracks' }
      const payload: Record<string, unknown> = { context: ctx, trackIds: w.ids, startIndex: w.startIndex }
      if (opts.shuffle !== undefined) payload.shuffle = opts.shuffle
      await c().remoteCommand('playContext', payload, {
        track: first,
        status: 'loading',
        position: 0,
        duration: first.duration,
        context: ctx,
        ...(opts.shuffle !== undefined ? { shuffle: opts.shuffle } : {})
      })
    },

    addToQueue(tracks) {
      if (tracks.length === 0) return null
      if (remote()) {
        void c().remoteCommand('addToQueue', { trackIds: capIds(tracks) })
        return null
      }
      const before = new Set(p().queue.items.map((i) => i.uid))
      p().addToQueue(tracks)
      const added = (p().queue.items ?? []).filter((i) => !before.has(i.uid)).map((i) => i.uid)
      if (added.length === 0) return null
      return () => {
        for (const uid of added) p().removeFromQueue(uid)
      }
    },

    addNext(tracks) {
      if (tracks.length === 0) return
      if (!remote()) return p().addNext(tracks)
      void c().remoteCommand('playNext', { trackIds: capIds(tracks) })
    },

    toggle() {
      if (!remote()) return p().toggle()
      const playing = ACTIVE.has(c().remote!.state.status ?? '')
      void c().remoteCommand(playing ? 'pause' : 'play', undefined, { status: playing ? 'paused' : 'playing' })
    },

    play() {
      if (!remote()) return p().play()
      void c().remoteCommand('play', undefined, { status: 'playing' })
    },

    pause() {
      if (!remote()) return p().pause()
      void c().remoteCommand('pause', undefined, { status: 'paused' })
    },

    next() {
      if (!remote()) return void p().next()
      void c().remoteCommand('next')
    },

    previous() {
      if (!remote()) return void p().previous()
      void c().remoteCommand('previous')
    },

    seek(seconds) {
      if (!Number.isFinite(seconds)) return
      if (!remote()) return p().seek(seconds)
      const s = Math.max(0, seconds)
      void c().remoteCommand('seek', { position: s }, { position: s })
    },

    setShuffle(on) {
      if (!remote()) return p().setShuffle(on)
      void c().remoteCommand('setShuffle', { on }, { shuffle: on })
    },

    cycleRepeat() {
      if (!remote()) return p().cycleRepeat()
      const mode = cycleRepeat(c().remote!.state.repeat ?? 'off')
      void c().remoteCommand('setRepeat', { mode }, { repeat: mode })
    },

    setVolume(v) {
      if (!remote()) return p().setVolume(v)
      c().setRemoteVolume(v)
    },

    toggleMute() {
      if (!remote()) return p().toggleMute()
      c().setRemoteMuted(!c().remote!.state.muted)
    },

    position() {
      return remote() ? c().remotePosition() : p().position
    },

    volume() {
      return remote() ? c().remote!.state.volume ?? 1 : p().volume
    },

    shuffle() {
      return remote() ? Boolean(c().remote!.state.shuffle) : p().queue.shuffle
    },

    hasItem() {
      return remote() ? c().remote!.state.track != null : p().queue.items.length > 0
    }
  }
  return api
}
