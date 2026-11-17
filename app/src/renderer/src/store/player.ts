import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { StreamInfo, Track } from '../api/types'
import { describeError } from '../api/errors'
import * as Q from '../player/queue'

/** The subset of AudioEngine the store relies on (lets tests use a fake). */
export interface PlaybackEngine {
  load(key: string, url: string, opts?: { autoplay?: boolean; startAt?: number }): void
  preload(key: string, url: string): void
  hasPreloaded(key: string): boolean
  crossfadeTo(key: string, url: string, seconds: number): void
  play(): Promise<void>
  pause(): Promise<void>
  seek(seconds: number): void
  setVolume(v: number): void
  stop(): void
  readonly currentTime: number
  readonly duration: number
  readonly isTransitioning: boolean
  readonly reactive: boolean
}

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'buffering' | 'error'

export interface PlayerState {
  queue: Q.QueueState
  status: PlayerStatus
  position: number
  duration: number
  volume: number
  muted: boolean
  error: string | null
  reactive: boolean

  playTracks(tracks: Track[], startIndex?: number, context?: Q.QueueContext | null, opts?: { shuffle?: boolean }): Promise<void>
  playItem(uid: string): Promise<void>
  toggle(): void
  play(): void
  pause(): void
  next(): Promise<void>
  previous(): Promise<void>
  seek(seconds: number): void
  setVolume(v: number): void
  toggleMute(): void
  setShuffle(on: boolean): void
  cycleRepeat(): void
  setRepeat(mode: Q.RepeatMode): void
  addNext(tracks: Track[]): void
  addToQueue(tracks: Track[]): void
  removeFromQueue(uid: string): void
  moveInQueue(from: number, to: number): void
  clearUpcoming(): void
  stop(): void
}

export interface PlayerDeps {
  createEngine(events: {
    onTime(c: number, d: number): void
    onPlaying(): void
    onPause(): void
    onWaiting(): void
    onEnded(): void
    onError(message: string): void
    onReactiveChange(reactive: boolean): void
  }): PlaybackEngine
  resolveStream(trackId: string): Promise<StreamInfo>
  reportPlayed?(trackId: string, seconds: number): void
  getCrossfade(): number
  initialVolume?: number
  initialMuted?: boolean
  onVolumeChange?(volume: number, muted: boolean): void
  onError?(message: string): void
  now?: () => number
  rng?: Q.Rng
}

const PRELOAD_WINDOW = 45
const URL_SAFETY_MS = 60_000
const RESTART_THRESHOLD = 3

export function createPlayerStore(deps: PlayerDeps): UseBoundStore<StoreApi<PlayerState>> {
  const now = deps.now ?? Date.now
  const streams = new Map<string, { url: string; expiresAt: number }>()
  const retried = new Set<string>()
  let played = { uid: '', trackId: '', seconds: 0, last: 0, reported: false }

  async function resolveUrl(trackId: string, force = false): Promise<string> {
    const cached = streams.get(trackId)
    if (!force && cached && cached.expiresAt - URL_SAFETY_MS > now()) return cached.url
    const info = await deps.resolveStream(trackId)
    const parsed = Date.parse(info.expiresAt)
    streams.set(trackId, { url: info.url, expiresAt: Number.isFinite(parsed) ? parsed : now() + 5 * 60_000 })
    if (streams.size > 64) streams.delete(streams.keys().next().value as string)
    return info.url
  }

  function reportIfListened(): void {
    const p = played
    if (!p.trackId || p.reported || !deps.reportPlayed) return
    const item = Q.currentItem(store.getState().queue)
    const dur = item?.uid === p.uid ? item.track.duration : 0
    if (p.seconds >= 30 || (dur > 0 && p.seconds >= dur * 0.5)) {
      p.reported = true
      try {
        deps.reportPlayed(p.trackId, p.seconds)
      } catch {
        /* best effort */
      }
    }
  }

  function trackPlayback(c: number): void {
    const item = Q.currentItem(store.getState().queue)
    if (!item) return
    if (played.uid !== item.uid) played = { uid: item.uid, trackId: item.track.id, seconds: 0, last: c, reported: false }
    const delta = c - played.last
    if (delta > 0 && delta < 2) played.seconds += delta
    played.last = c
    reportIfListened()
  }

  let preloadingKey: string | null = null

  async function maybePreload(c: number, d: number): Promise<void> {
    const { queue } = store.getState()
    const next = Q.peekNext(queue)
    if (!next || d <= 0 || d - c > PRELOAD_WINDOW) return
    if (engine.hasPreloaded(next.uid) || preloadingKey === next.uid) return
    preloadingKey = next.uid
    try {
      engine.preload(next.uid, await resolveUrl(next.track.id))
    } catch {
      /* it will be resolved again when it starts */
    } finally {
      preloadingKey = null
    }
  }

  let crossfading = false
  async function maybeCrossfade(c: number, d: number): Promise<void> {
    const fade = deps.getCrossfade()
    const { queue, status } = store.getState()
    if (fade <= 0 || crossfading || engine.isTransitioning || status !== 'playing') return
    if (queue.repeat === 'one' || d <= fade * 2 || d - c > fade) return
    const nextQ = Q.advance(queue, true)
    const item = nextQ && Q.currentItem(nextQ)
    if (!nextQ || !item) return
    crossfading = true
    try {
      const url = await resolveUrl(item.track.id)
      reportIfListened()
      store.setState({ queue: nextQ, position: 0, duration: item.track.duration, error: null })
      engine.crossfadeTo(item.uid, url, fade)
    } catch (err) {
      deps.onError?.(describeError(err))
    } finally {
      crossfading = false
    }
  }

  let lastTimeSet = 0
  const engine = deps.createEngine({
    onTime(c, d) {
      trackPlayback(c)
      const s = store.getState()
      if (Math.abs(c - s.position) >= 0.25 || d !== s.duration || now() - lastTimeSet > 500) {
        lastTimeSet = now()
        store.setState({ position: c, duration: d || s.duration })
      }
      void maybePreload(c, d)
      void maybeCrossfade(c, d)
    },
    onPlaying() {
      const item = Q.currentItem(store.getState().queue)
      if (item) retried.delete(item.uid)
      store.setState({ status: 'playing', error: null })
    },
    onPause() {
      if (store.getState().status !== 'loading') store.setState({ status: 'paused' })
    },
    onWaiting() {
      store.setState({ status: 'buffering' })
    },
    onEnded() {
      void handleEnded()
    },
    onError(message) {
      void handleError(message)
    },
    onReactiveChange(reactive) {
      store.setState({ reactive })
    }
  })

  async function startCurrent(opts: { autoplay?: boolean; startAt?: number; forceUrl?: boolean } = {}): Promise<void> {
    const item = Q.currentItem(store.getState().queue)
    if (!item) {
      engine.stop()
      store.setState({ status: 'idle', position: 0, duration: 0 })
      return
    }
    reportIfListened()
    store.setState({ status: 'loading', position: opts.startAt ?? 0, duration: item.track.duration, error: null })
    try {
      const url = await resolveUrl(item.track.id, opts.forceUrl)
      // The user may have skipped again while we were resolving.
      if (Q.currentItem(store.getState().queue)?.uid !== item.uid) return
      engine.load(item.uid, url, { autoplay: opts.autoplay !== false, startAt: opts.startAt })
      if (opts.autoplay === false) store.setState({ status: 'paused' })
    } catch (err) {
      if (Q.currentItem(store.getState().queue)?.uid !== item.uid) return
      const message = describeError(err)
      store.setState({ status: 'error', error: message })
      deps.onError?.(message)
    }
  }

  async function handleEnded(): Promise<void> {
    if (engine.isTransitioning) return
    const s = store.getState()
    const nextQ = Q.advance(s.queue, true)
    if (!nextQ) {
      reportIfListened()
      engine.seek(0)
      store.setState({ status: 'paused', position: 0 })
      return
    }
    store.setState({ queue: nextQ })
    if (nextQ.index === s.queue.index) {
      // repeat one
      engine.seek(0)
      played.reported = false
      played.seconds = 0
      void engine.play()
      return
    }
    await startCurrent()
  }

  async function handleError(message: string): Promise<void> {
    const s = store.getState()
    const item = Q.currentItem(s.queue)
    if (!item) return
    if (!retried.has(item.uid)) {
      // Signed URLs expire: fetch a fresh one once and resume where we were.
      retried.add(item.uid)
      await startCurrent({ startAt: engine.currentTime || s.position, forceUrl: true })
      return
    }
    store.setState({ status: 'error', error: message })
    deps.onError?.(message)
    const nextQ = Q.advance(s.queue, false)
    if (nextQ && nextQ.index !== s.queue.index) {
      store.setState({ queue: nextQ })
      await startCurrent()
    }
  }

  const initialVolume = deps.initialVolume ?? 0.8
  const initialMuted = deps.initialMuted ?? false
  engine.setVolume(initialMuted ? 0 : initialVolume)

  const store = create<PlayerState>((set, get) => ({
    queue: Q.emptyQueue,
    status: 'idle',
    position: 0,
    duration: 0,
    volume: initialVolume,
    muted: initialMuted,
    error: null,
    reactive: engine.reactive,

    async playTracks(tracks, startIndex = 0, context = null, opts = {}) {
      if (tracks.length === 0) return
      const { queue } = get()
      const shuffle = opts.shuffle ?? queue.shuffle
      set({ queue: Q.createQueue(tracks, startIndex, { shuffle, repeat: queue.repeat, context, rng: deps.rng }) })
      await startCurrent()
    },

    async playItem(uid) {
      const q = Q.jumpTo(get().queue, uid)
      if (q === get().queue && Q.currentItem(q)?.uid !== uid) return
      set({ queue: q })
      await startCurrent()
    },

    toggle() {
      const { status } = get()
      if (status === 'playing' || status === 'buffering' || status === 'loading') get().pause()
      else get().play()
    },

    play() {
      const { status, queue, position } = get()
      if (!Q.currentItem(queue)) return
      if (status === 'error' || status === 'idle') {
        void startCurrent({ startAt: position })
        return
      }
      void engine.play()
    },

    pause() {
      void engine.pause()
      set({ status: 'paused' })
    },

    async next() {
      const nextQ = Q.advance(get().queue, false)
      if (!nextQ) return
      set({ queue: nextQ })
      await startCurrent()
    },

    async previous() {
      if (engine.currentTime > RESTART_THRESHOLD || get().queue.index === 0 && get().queue.repeat !== 'all') {
        get().seek(0)
        return
      }
      set({ queue: Q.previous(get().queue) })
      await startCurrent()
    },

    seek(seconds) {
      if (!Number.isFinite(seconds)) return
      engine.seek(seconds)
      set({ position: Math.max(0, seconds) })
      if (played.uid) played.last = seconds
    },

    setVolume(v) {
      const volume = Math.min(1, Math.max(0, v))
      engine.setVolume(volume)
      set({ volume, muted: volume === 0 ? get().muted : false })
      deps.onVolumeChange?.(volume, volume === 0 ? get().muted : false)
    },

    toggleMute() {
      const muted = !get().muted
      engine.setVolume(muted ? 0 : get().volume)
      set({ muted })
      deps.onVolumeChange?.(get().volume, muted)
    },

    setShuffle(on) {
      set({ queue: Q.setShuffle(get().queue, on, deps.rng) })
    },

    cycleRepeat() {
      const q = get().queue
      set({ queue: { ...q, repeat: Q.cycleRepeat(q.repeat) } })
    },

    setRepeat(mode) {
      const q = get().queue
      if (q.repeat !== mode) set({ queue: { ...q, repeat: mode } })
    },

    addNext(tracks) {
      const wasEmpty = get().queue.items.length === 0
      set({ queue: Q.insertNext(get().queue, tracks) })
      if (wasEmpty) void startCurrent()
    },

    addToQueue(tracks) {
      const wasEmpty = get().queue.items.length === 0
      set({ queue: Q.append(get().queue, tracks) })
      if (wasEmpty) void startCurrent()
    },

    removeFromQueue(uid) {
      const { queue, removedCurrent } = Q.remove(get().queue, uid)
      set({ queue })
      if (removedCurrent) void startCurrent({ autoplay: get().status === 'playing' })
    },

    moveInQueue(from, to) {
      set({ queue: Q.move(get().queue, from, to) })
    },

    clearUpcoming() {
      set({ queue: Q.clearUpcoming(get().queue) })
    },

    stop() {
      reportIfListened()
      engine.stop()
      set({ queue: { ...Q.emptyQueue, repeat: get().queue.repeat, shuffle: get().queue.shuffle }, status: 'idle', position: 0, duration: 0, error: null })
    }
  }))

  return store
}
