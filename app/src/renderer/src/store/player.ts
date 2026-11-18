import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { StreamInfo, Track } from '../api/types'
import { describeError } from '../api/errors'
import * as Q from '../player/queue'
import { newPlayId, PERSIST_EVERY_S } from '../lib/playQueue'
import type { NativePlayer, NativePlayerEvent, NativeQueueItem, NativeSnapshot } from '../platform/nativePlayerTypes'
import { artistNames } from '../lib/format'
import { pickImage } from '../lib/url'
import { queueFromSaved, serializeSession, type SavedSession } from '../lib/playerSession'

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
  /** Sleep timer "End of track": playback pauses (instead of advancing) when the current track ends. */
  sleepAfterTrack: boolean

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
  /** Empties "Next in queue" (the user queue). */
  clearUserQueue(): void
  /** Empties "Next from <context>", keeping the user queue. */
  clearContextUpcoming(): void
  /** Reorders within one upcoming section (indices inside that section). */
  moveInSection(section: Q.QueueSection, from: number, to: number): void
  /** Arms/disarms "pause when the current track ends" (sleep timer). */
  setSleepAfterTrack(on: boolean): void
  /** Empties the Autoplay section of the queue. */
  clearAutoplay(): void
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
  reportPlayed?(trackId: string, seconds: number, meta?: { playId: string; at: string; dur: number }): void
  /** Persists the listen in progress (~every 15 s) so it survives the app being killed. */
  persistListen?(listen: { playId: string; trackId: string; seconds: number; at: string; dur: number }): void
  /** The listen ended without counting as a play: forget its persisted entry. */
  dropListen?(playId: string): void
  getCrossfade(): number
  /**
   * Android: the Media3 service plays the queue (and reports plays itself). The store keeps the queue
   * model and mirrors the service's state; crossfade is not applied on this path.
   */
  native?: NativePlayer
  /** Called with every position/duration the native service reports (keeps the engine facade in sync). */
  onNativeTime?(position: number, duration: number): void
  /** Called when the service starts/stops actually playing (drives the local interpolated clock). */
  onNativePlaying?(playing: boolean): void
  /** "Autoplay similar songs" setting. Autoplay is off when this is missing. */
  getAutoplay?(): boolean
  /** Library songs similar to `seedId`, skipping `exclude`. Rejections are ignored (Autoplay is best effort). */
  fetchAutoplay?(seedId: string, exclude: string[]): Promise<Track[]>
  /** The session remembered from the previous run (queue, index, position); restored paused, never auto-played. */
  loadSession?(): SavedSession | null
  /** Persists the session (null forgets it). Called on queue/state changes and about every 5 s while playing. */
  saveSession?(session: SavedSession | null): void
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
/** Ids sent as `exclude` to the radio endpoint (most recent queue entries). */
const AUTOPLAY_EXCLUDE = 100
/** How often the session (queue position) is written while playing. */
const PERSIST_SESSION_MS = 5000

/** The queue as sent to the native service. */
export function toNativeItems(q: Q.QueueState): NativeQueueItem[] {
  return q.items.map((it) => ({
    uid: it.uid,
    trackId: it.track.id,
    title: it.track.title,
    artist: artistNames(it.track.artists),
    album: it.track.album?.title ?? '',
    artworkUrl: pickImage(it.track.artwork, 512) ?? '',
    duration: it.track.duration
  }))
}

/** Rebuilds a Track from a native queue entry (the full JSON when native has it, else the basics). */
export function trackFromNative(it: NativeSnapshot['items'][number]): Track {
  const raw = it.track as Partial<Track> | undefined
  if (raw && typeof raw === 'object' && typeof raw.id === 'string' && Array.isArray(raw.artists)) return raw as Track
  return {
    id: it.trackId,
    title: it.title,
    artists: it.artist ? it.artist.split(', ').map((name) => ({ id: '', name })) : [],
    album: it.album ? { id: '', title: it.album } : null,
    duration: it.duration,
    artwork: it.artworkUrl ? [{ url: it.artworkUrl }] : []
  }
}

/** Structural sharing: a track the queue already holds keeps its object (and artwork array) so views don't re-render or reload covers. */
export function keepTrack(q: Q.QueueState, next: Track): Track {
  const old = q.items.find((it) => it.track.id === next.id)?.track
  if (!old) return next
  const oa = old.artwork ?? []
  const na = next.artwork ?? []
  if (oa.length > na.length) return old // native only knew the basics
  const same = oa.length === na.length && oa.every((im, i) => im.url === na[i]!.url)
  return same ? { ...next, artwork: oa } : next
}

const uidSig = (q: Q.QueueState): string => q.items.map((it) => it.uid).join(',')

export function createPlayerStore(deps: PlayerDeps): UseBoundStore<StoreApi<PlayerState>> {
  const now = deps.now ?? Date.now
  const streams = new Map<string, { url: string; expiresAt: number }>()
  const retried = new Set<string>()
  let played = { uid: '', trackId: '', seconds: 0, last: 0, reported: false, dur: 0, playId: '', at: '', persisted: 0 }
  const newListen = (uid: string, trackId: string, last: number, dur: number): typeof played => ({
    uid, trackId, seconds: 0, last, reported: false, dur, playId: newPlayId(), at: new Date(now()).toISOString(), persisted: 0
  })

  async function resolveUrl(trackId: string, force = false): Promise<string> {
    const cached = streams.get(trackId)
    if (!force && cached && cached.expiresAt - URL_SAFETY_MS > now()) return cached.url
    const info = await deps.resolveStream(trackId)
    const parsed = Date.parse(info.expiresAt)
    streams.set(trackId, { url: info.url, expiresAt: Number.isFinite(parsed) ? parsed : now() + 5 * 60_000 })
    if (streams.size > 64) streams.delete(streams.keys().next().value as string)
    return info.url
  }

  /** The listen being left did not count (or already went out): its persisted entry is not needed. */
  function forgetListen(): void {
    if (played.playId && !played.reported) {
      try {
        deps.dropListen?.(played.playId)
      } catch {
        /* best effort */
      }
    }
  }

  /**
   * Reports the play once, with the real listened seconds. Called when a track is left (skip, end,
   * crossfade, repeat-one loop, stop, page close), never mid-track, so minutes are not undercounted.
   * A play counts after 30 s or half the track.
   */
  function reportIfListened(): void {
    const p = played
    if (deps.native || !p.trackId || p.reported || !deps.reportPlayed) return
    const dur = p.dur
    if (p.seconds >= 30 || (dur > 0 && p.seconds >= dur * 0.5)) {
      p.reported = true
      try {
        deps.reportPlayed(p.trackId, p.seconds, { playId: p.playId, at: p.at, dur })
      } catch {
        /* best effort */
      }
    }
  }

  function trackPlayback(c: number): void {
    const item = Q.currentItem(store.getState().queue)
    if (!item) return
    if (played.uid !== item.uid) {
      forgetListen()
      played = newListen(item.uid, item.track.id, c, item.track.duration)
    }
    const delta = c - played.last
    if (delta > 0 && delta < 2) played.seconds += delta
    played.last = c
    if (played.seconds - played.persisted >= PERSIST_EVERY_S && !played.reported) {
      played.persisted = played.seconds
      try {
        deps.persistListen?.({ playId: played.playId, trackId: played.trackId, seconds: Math.round(played.seconds), at: played.at, dur: played.dur })
      } catch {
        /* best effort */
      }
    }
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
    if (fade <= 0 || crossfading || engine.isTransitioning || status !== 'playing' || store.getState().sleepAfterTrack) return
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

  const native = deps.native ?? null
  /** Signature of the queue last sent to (or received from) the native service. */
  let nativeSig = ''
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

  let autoplayBusy = false
  /**
   * Autoplay: when the context and the user queue are exhausted (current is the last item, repeat off),
   * appends similar songs from the library to the queue. Resolves true when songs were added.
   */
  async function ensureAutoplay(): Promise<boolean> {
    const s0 = store.getState()
    const cur = Q.currentItem(s0.queue)
    if (!deps.fetchAutoplay || !deps.getAutoplay?.() || autoplayBusy || !cur) return false
    if (s0.queue.repeat !== 'off' || !Q.isAtEnd(s0.queue)) return false
    autoplayBusy = true
    try {
      const exclude = s0.queue.items.slice(-AUTOPLAY_EXCLUDE).map((it) => it.track.id)
      const tracks = await deps.fetchAutoplay(cur.track.id, exclude)
      const q = store.getState().queue
      // The queue changed while we were asking (new context, skip, user added songs): drop the result.
      if (Q.currentItem(q)?.uid !== cur.uid || q.repeat !== 'off' || !Q.isAtEnd(q)) return false
      const next = Q.appendAutoplay(q, tracks)
      if (next === q) return false
      store.setState({ queue: next })
      return true
    } catch {
      return false
    } finally {
      autoplayBusy = false
    }
  }

  /** True once something started playback in this run (a late native snapshot must not override it). */
  let touched = false
  async function startCurrent(opts: { autoplay?: boolean; startAt?: number; forceUrl?: boolean } = {}): Promise<void> {
    touched = true
    const item = Q.currentItem(store.getState().queue)
    if (!item) {
      engine.stop()
      store.setState({ status: 'idle', position: 0, duration: 0 })
      return
    }
    reportIfListened()
    store.setState({ status: 'loading', position: opts.startAt ?? 0, duration: item.track.duration, error: null })
    if (native) {
      const q = store.getState().queue
      nativeSig = uidSig(q)
      native.setQueue(toNativeItems(q), q.index, { play: opts.autoplay !== false, startAt: opts.startAt ?? 0, reset: true })
      if (opts.autoplay === false) store.setState({ status: 'paused' })
      void ensureAutoplay()
      return
    }
    try {
      const url = await resolveUrl(item.track.id, opts.forceUrl)
      // The user may have skipped again while we were resolving.
      if (Q.currentItem(store.getState().queue)?.uid !== item.uid) return
      engine.load(item.uid, url, { autoplay: opts.autoplay !== false, startAt: opts.startAt })
      if (opts.autoplay === false) store.setState({ status: 'paused' })
      void ensureAutoplay()
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
    if (s.sleepAfterTrack) {
      // Sleep timer: stop here; the next song (if any) is loaded paused.
      reportIfListened()
      store.setState({ sleepAfterTrack: false })
      const after = Q.advance(s.queue, true)
      if (after && after.index !== s.queue.index) {
        store.setState({ queue: after })
        await startCurrent({ autoplay: false })
      } else {
        engine.seek(0)
        store.setState({ status: 'paused', position: 0 })
      }
      return
    }
    let nextQ = Q.advance(s.queue, true)
    if (!nextQ && (await ensureAutoplay())) nextQ = Q.advance(store.getState().queue, true)
    if (!nextQ) {
      reportIfListened()
      engine.seek(0)
      store.setState({ status: 'paused', position: 0 })
      return
    }
    store.setState({ queue: nextQ })
    if (nextQ.index === s.queue.index) {
      // repeat one
      reportIfListened()
      engine.seek(0)
      forgetListen()
      played = newListen(played.uid, played.trackId, played.last, played.dur)
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
    sleepAfterTrack: false,

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
      let nextQ = Q.advance(get().queue, false)
      if (!nextQ && (await ensureAutoplay())) nextQ = Q.advance(get().queue, false)
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

    clearUserQueue() {
      set({ queue: Q.clearUserQueue(get().queue) })
    },

    clearContextUpcoming() {
      set({ queue: Q.clearContextUpcoming(get().queue) })
    },

    moveInSection(section, from, to) {
      set({ queue: Q.moveInSection(get().queue, section, from, to) })
    },

    setSleepAfterTrack(on) {
      if (get().sleepAfterTrack !== on) {
        set({ sleepAfterTrack: on })
        native?.setPauseAtEnd(on)
      }
    },

    clearAutoplay() {
      set({ queue: Q.clearAutoplay(get().queue) })
    },

    stop() {
      reportIfListened()
      forgetListen()
      played = newListen('', '', 0, 0)
      engine.stop()
      nativeSig = ''
      set({ queue: { ...Q.emptyQueue, repeat: get().queue.repeat, shuffle: get().queue.shuffle }, status: 'idle', position: 0, duration: 0, error: null, sleepAfterTrack: false })
    }
  }))

  // Restore the last session paused (the user presses play to continue from where they were).
  const saved = deps.loadSession?.() ?? null
  if (saved) {
    const queue = queueFromSaved(saved)
    const item = Q.currentItem(queue)
    if (item) {
      store.setState({
        queue,
        status: native ? 'paused' : 'idle',
        position: Math.min(saved.position, item.track.duration > 0 ? item.track.duration : saved.position),
        duration: item.track.duration
      })
    }
  }

  if (native) wireNative(native, saved && Q.currentItem(store.getState().queue) ? store.getState().queue : null)
  if (deps.saveSession) wirePersistence(deps.saveSession)

  /** Remembers the session so the next run restores it. */
  function wirePersistence(save: (s: SavedSession | null) => void): void {
    let lastSave = 0
    let scheduled = false
    const persist = (): void => {
      lastSave = now()
      const s = store.getState()
      try {
        save(serializeSession(s.queue, s.position, now()))
      } catch {
        /* best effort */
      }
    }
    store.subscribe((s, prev) => {
      const changed = s.queue !== prev.queue || s.status !== prev.status
      if (changed && !scheduled) {
        scheduled = true
        // Deferred a microtask so an action's follow-up state (position reset, status) is included.
        queueMicrotask(() => {
          scheduled = false
          persist()
        })
      } else if (!changed && s.status === 'playing' && now() - lastSave >= PERSIST_SESSION_MS) {
        persist()
      }
    })
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') persist()
      })
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('pagehide', persist)
    }
  }

  /** Mirrors the Media3 service into the store and keeps the native queue in step with the store's. */
  function wireNative(n: NativePlayer, restored: Q.QueueState | null): void {
    let flushScheduled = false
    store.subscribe((s, prev) => {
      if (s.queue.repeat !== prev.queue.repeat) n.setRepeat(s.queue.repeat)
      if (s.queue.shuffle !== prev.queue.shuffle) n.setShuffle(s.queue.shuffle)
      if (s.queue.items === prev.queue.items || flushScheduled) return
      flushScheduled = true
      // Deferred a microtask so an action that starts playback (startCurrent) syncs the queue itself first.
      queueMicrotask(() => {
        flushScheduled = false
        const q = store.getState().queue
        if (q.items.length === 0 || uidSig(q) === nativeSig) return
        nativeSig = uidSig(q)
        n.setQueue(toNativeItems(q), q.index)
      })
    })
    n.setRepeat(store.getState().queue.repeat)
    n.setShuffle(store.getState().queue.shuffle)

    const adopt = (snap: NativeSnapshot): void => {
      const uids = snap.items.map((i) => i.uid)
      let k = 0
      const cur = store.getState().queue
      // Same entries as the queue we already hold (restored session / WebView recreated): keep its
      // structure (user queue, autoplay, shuffle order, context) and take only the native position.
      const sameQueue = cur.items.length === uids.length && cur.items.every((it, i) => it.uid === uids[i])
      const queue = sameQueue
        ? { ...cur, index: Math.min(Math.max(0, snap.index), cur.items.length - 1), repeat: snap.repeat }
        : Q.createQueue(snap.items.map((it) => keepTrack(cur, trackFromNative(it))), snap.index, {
            repeat: snap.repeat,
            uid: () => uids[k++] ?? Q.makeUid(),
            context: snap.contextName ? { type: 'tracks', name: snap.contextName } : null
          })
      nativeSig = uidSig(queue)
      const item = Q.currentItem(queue)
      deps.onNativeTime?.(snap.position, item?.track.duration ?? 0)
      deps.onNativePlaying?.(snap.playing)
      store.setState({
        queue,
        status: snap.playing ? 'playing' : 'paused',
        position: snap.position,
        duration: item?.track.duration ?? 0,
        error: null
      })
    }

    const handle = (e: NativePlayerEvent): void => {
      const s = store.getState()
      switch (e.type) {
        case 'state':
          deps.onNativePlaying?.(e.status === 'playing')
          if (e.status === 'playing') store.setState({ status: 'playing', error: null })
          else if (e.status === 'buffering') store.setState({ status: 'buffering' })
          else if (e.status === 'paused') store.setState({ status: 'paused' })
          else if (e.status === 'ended') {
            void (async () => {
              if (await ensureAutoplay()) {
                const nextQ = Q.advance(store.getState().queue, false)
                if (nextQ) {
                  store.setState({ queue: nextQ })
                  await startCurrent()
                  return
                }
              }
              store.setState({ status: 'paused', position: 0 })
            })()
          }
          return
        case 'position': {
          deps.onNativeTime?.(e.position, e.duration)
          if (Math.abs(e.position - s.position) >= 0.25 || (e.duration > 0 && e.duration !== s.duration)) {
            store.setState({ position: e.position, duration: e.duration > 0 ? e.duration : s.duration })
          }
          return
        }
        case 'index': {
          const i = s.queue.items.findIndex((it) => it.uid === e.uid)
          if (i < 0 || i === s.queue.index) return
          const item = s.queue.items[i]!
          deps.onNativeTime?.(0, item.track.duration)
          store.setState({
            queue: { ...s.queue, index: i },
            position: 0,
            duration: item.track.duration,
            error: null,
            // "End of track" sleep timer: the service paused right at the boundary.
            sleepAfterTrack: false
          })
          void ensureAutoplay()
          return
        }
        case 'error':
          store.setState({ status: 'error', error: e.message || null })
          if (e.message) deps.onError?.(e.message)
          return
        case 'queue':
          adopt(e.snapshot)
          return
        case 'command':
          if (e.kind === 'shuffle') store.getState().setShuffle(!s.queue.shuffle)
          else store.getState().cycleRepeat()
          return
        default:
      }
    }
    n.on(handle)

    // The service may already be playing (Android Auto started it, or the WebView was recreated).
    void n.getSnapshot().then((snap) => {
      if (touched) return
      if (snap) {
        // The service holds a queue (still playing, or restored from its own saved session): adopt it.
        adopt(snap)
      } else if (restored && store.getState().queue.items.length > 0) {
        // Nothing native: load the restored queue paused at the saved position.
        const q = store.getState().queue
        nativeSig = uidSig(q)
        n.setQueue(toNativeItems(q), q.index, { play: false, startAt: store.getState().position })
      }
    })
  }

  // Best effort: a listen in progress is reported when the page/app is closed.
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', () => reportIfListened())
  }
  return store
}
