import type { PlaybackEngine } from '../store/player'
import type { NativePlayer } from '../platform/nativePlayerTypes'

/**
 * PlaybackEngine facade over the Android Media3 service. The store feeds the native queue itself
 * (see `deps.native` in store/player.ts); this class carries transport calls and mirrors the
 * position the service reports. There is no crossfade and no Web Audio analyser on this path.
 */
export class NativeEngine implements PlaybackEngine {
  currentTime = 0
  duration = 0
  readonly isTransitioning = false
  readonly reactive = false

  constructor(private readonly native: NativePlayer) {}

  /** Position/duration pushed by the service (seconds). */
  mirror(position: number, duration: number): void {
    this.currentTime = position
    if (duration > 0) this.duration = duration
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
    this.currentTime = Math.max(0, seconds)
    this.native.seek(Math.max(0, seconds))
  }
  setVolume(v: number): void {
    this.native.setVolume(v)
  }
  stop(): void {
    this.currentTime = 0
    this.duration = 0
    this.native.stop()
  }
}
