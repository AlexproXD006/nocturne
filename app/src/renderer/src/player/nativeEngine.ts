import type { PlaybackEngine } from '../store/player'
import type { NativePlayer } from '../platform/nativePlayerTypes'

/**
 * PlaybackEngine facade over the Android Media3 service. The store feeds the native queue itself
 * (see `deps.native` in store/player.ts); this class carries transport calls and mirrors the
 * position the service reports. There is no crossfade and no Web Audio analyser on this path.
 */
/** Beyond this the local clock is replaced instead of nudged (seek, track change, long stall). */
const MAX_DRIFT_S = 0.6

export class NativeEngine implements PlaybackEngine {
  duration = 0
  /** Local clock: the service reports the position about once a second, so between reports
   *  `currentTime` advances by itself (smooth lyrics / progress bar). */
  private base = 0
  /** Wall-clock ms at which `base` was true (may be in the future to hold the clock while the service catches up). */
  private at = 0
  private playing = false
  readonly isTransitioning = false
  readonly reactive = false

  constructor(
    private readonly native: NativePlayer,
    private readonly clock: () => number = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
  ) {}

  /** Interpolated position in seconds: never runs backwards except for a real seek / track change. */
  get currentTime(): number {
    if (!this.playing) return this.base
    const t = this.base + Math.max(0, this.clock() - this.at) / 1000
    return this.duration > 0 ? Math.min(t, this.duration) : t
  }

  /** Position/duration pushed by the service (seconds). Re-syncs the local clock. */
  mirror(position: number, duration: number): void {
    if (duration > 0) this.duration = duration
    const now = this.clock()
    const cur = this.currentTime
    const drift = position - cur
    if (this.playing && Math.abs(drift) <= MAX_DRIFT_S) {
      if (drift >= 0) {
        this.base = position
        this.at = now
      } else {
        // We are slightly ahead: hold the clock still until the service catches up (no backwards jump).
        this.base = cur
        this.at = now - drift * 1000
      }
    } else {
      this.base = Math.max(0, position)
      this.at = now
    }
  }

  /** Play state reported by the service: freezes or resumes the local clock from the current value. */
  setPlaying(playing: boolean): void {
    if (playing === this.playing) return
    this.base = this.currentTime
    this.at = this.clock()
    this.playing = playing
  }

  load(): void {
    /* the store loads through native.setQueue */
  }
  preload(): void {
    /* ExoPlayer preloads the next item itself */
  }
  hasPreloaded(): boolean {
    return true
  }
  crossfadeTo(): void {
    /* crossfade is not available on the native path */
  }
  async play(): Promise<void> {
    this.native.play()
  }
  async pause(): Promise<void> {
    this.native.pause()
  }
  seek(seconds: number): void {
    this.base = Math.max(0, seconds)
    this.at = this.clock()
    this.native.seek(Math.max(0, seconds))
  }
  setVolume(v: number): void {
    this.native.setVolume(v)
  }
  stop(): void {
    this.base = 0
    this.at = this.clock()
    this.playing = false
    this.duration = 0
    this.native.stop()
  }
}
