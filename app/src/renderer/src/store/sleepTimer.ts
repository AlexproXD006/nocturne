import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { FADE_SECONDS, fadeFactor } from '../lib/sleepTimer'

export type SleepMode = 'off' | 'time' | 'track'

export interface SleepState {
  mode: SleepMode
  /** Wall-clock deadline (epoch ms) for mode 'time'. */
  deadline: number | null
  /** Starts a countdown of `minutes`. */
  start(minutes: number): void
  /** Pauses when the current track ends. */
  startEndOfTrack(): void
  cancel(): void
  /** Re-evaluates the timer (called by the interval, player updates and app resume). */
  tick(): void
}

/** The slice of the player store the timer needs (lets tests use a fake). */
export interface SleepPlayer {
  getState(): {
    status: string
    position: number
    duration: number
    volume: number
    muted: boolean
    sleepAfterTrack: boolean
    pause(): void
    setSleepAfterTrack(on: boolean): void
  }
  subscribe(listener: () => void): () => void
}

export interface SleepDeps {
  player: SleepPlayer
  /** Sets the raw output volume without touching the saved setting (used for the fade). */
  setOutputVolume(v: number): void
  now?: () => number
  /** Called once when the timer paused playback. */
  onFinished?(): void
}

const TICK_MS = 500

/**
 * Sleep timer. The deadline is a wall-clock time and is re-checked on a 0.5 s interval, on every player
 * update (audio `timeupdate` keeps firing while a WebView plays in the background) and when the app
 * becomes visible again, so a throttled timer can never overshoot unnoticed. The last 10 s fade the
 * output volume; then playback pauses and the volume is restored.
 */
export function createSleepTimer(deps: SleepDeps): UseBoundStore<StoreApi<SleepState>> {
  const now = deps.now ?? Date.now
  let interval: ReturnType<typeof setInterval> | null = null
  let unsubscribe: (() => void) | null = null
  let faded = false

  const restoreVolume = (): void => {
    if (!faded) return
    faded = false
    const p = deps.player.getState()
    deps.setOutputVolume(p.muted ? 0 : p.volume)
  }

  const stopLoop = (): void => {
    if (interval) clearInterval(interval)
    interval = null
    unsubscribe?.()
    unsubscribe = null
  }

  const startLoop = (): void => {
    stopLoop()
    interval = setInterval(() => store.getState().tick(), TICK_MS)
    unsubscribe = deps.player.subscribe(() => store.getState().tick())
  }

  const applyFade = (remainingSec: number): void => {
    const p = deps.player.getState()
    if (p.status !== 'playing') return
    const f = fadeFactor(remainingSec)
    if (f >= 1) {
      restoreVolume()
      return
    }
    faded = true
    deps.setOutputVolume(p.muted ? 0 : p.volume * f)
  }

  const store = create<SleepState>((set, get) => ({
    mode: 'off',
    deadline: null,

    start(minutes) {
      if (!Number.isFinite(minutes) || minutes <= 0) return
      deps.player.getState().setSleepAfterTrack(false)
      restoreVolume()
      set({ mode: 'time', deadline: now() + minutes * 60_000 })
      startLoop()
    },

    startEndOfTrack() {
      restoreVolume()
      deps.player.getState().setSleepAfterTrack(true)
      set({ mode: 'track', deadline: null })
      startLoop()
    },

    cancel() {
      if (get().mode === 'track') deps.player.getState().setSleepAfterTrack(false)
      stopLoop()
      restoreVolume()
      set({ mode: 'off', deadline: null })
    },

    tick() {
      const { mode, deadline } = get()
      if (mode === 'off') return
      const p = deps.player.getState()
      if (mode === 'time') {
        const remaining = ((deadline ?? 0) - now()) / 1000
        if (remaining <= 0) {
          stopLoop()
          p.pause()
          restoreVolume()
          set({ mode: 'off', deadline: null })
          deps.onFinished?.()
          return
        }
        applyFade(remaining)
        return
      }
      // 'track': the player pauses at the end of the track (sleepAfterTrack) and clears the flag.
      if (!p.sleepAfterTrack) {
        stopLoop()
        restoreVolume()
        set({ mode: 'off', deadline: null })
        deps.onFinished?.()
        return
      }
      if (p.duration > 0) applyFade(p.duration - p.position)
    }
  }))
  return store
}

export { FADE_SECONDS }
