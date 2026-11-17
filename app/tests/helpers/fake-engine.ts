import { vi } from 'vitest'
import type { PlaybackEngine, PlayerDeps } from '@/store/player'

export type EngineEventsArg = Parameters<PlayerDeps['createEngine']>[0]

/** Records every call the store makes on the engine and exposes the event callbacks. */
export class FakeEngine implements PlaybackEngine {
  events!: EngineEventsArg
  currentTime = 0
  duration = 0
  isTransitioning = false
  reactive = false
  preloaded = new Set<string>()

  load = vi.fn((_key: string, _url: string, _opts?: { autoplay?: boolean; startAt?: number }) => undefined)
  preload = vi.fn((key: string, _url: string) => {
    this.preloaded.add(key)
  })
  hasPreloaded = vi.fn((key: string) => this.preloaded.has(key))
  crossfadeTo = vi.fn((_key: string, _url: string, _seconds: number) => undefined)
  play = vi.fn(async () => undefined)
  pause = vi.fn(async () => undefined)
  seek = vi.fn((_s: number) => undefined)
  setVolume = vi.fn((_v: number) => undefined)
  stop = vi.fn(() => undefined)
}
