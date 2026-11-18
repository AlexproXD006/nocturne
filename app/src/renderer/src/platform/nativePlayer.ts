import type { PluginListenerHandle } from '@capacitor/core'
import type {
  NativePlayer,
  NativeEq,
  NativePlayerEvent,
  NativeQueueItem,
  NativeRepeat,
  NativeSession,
  NativeSnapshot,
  SetQueueOptions
} from './nativePlayerTypes'

/**
 * JS side of the app-local Capacitor plugin `NocturneMedia`
 * (android/app/src/main/java/es/alexcloudweb/nocturne/media/NocturneMediaPlugin.java).
 */
export interface NocturneNativePlugin {
  setQueue(args: { items: NativeQueueItem[]; index: number; play?: boolean; startAt: number; reset: boolean }): Promise<void>
  play(): Promise<void>
  pause(): Promise<void>
  seek(args: { position: number }): Promise<void>
  setVolume(args: { volume: number }): Promise<void>
  setRepeat(args: { mode: NativeRepeat }): Promise<void>
  setShuffle(args: { on: boolean }): Promise<void>
  setPauseAtEnd(args: { on: boolean }): Promise<void>
  stop(): Promise<void>
  setLiked(args: { trackId: string; liked: boolean }): Promise<void>
  setAuth(args: { session: NativeSession | null }): Promise<void>
  getAuth(): Promise<{ session: NativeSession | null }>
  setLyricsInCar(args: { enabled: boolean }): Promise<void>
  setEq(args: NativeEq): Promise<void>
  getSnapshot(): Promise<{ snapshot: NativeSnapshot | null }>
  addListener(event: 'event', listener: (e: unknown) => void): Promise<PluginListenerHandle>
}

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

const STATES = new Set(['idle', 'buffering', 'playing', 'paused', 'ended'])

export function parseSession(raw: unknown): NativeSession | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.accessToken !== 'string' || typeof r.refreshToken !== 'string' || typeof r.serverUrl !== 'string') return null
  return {
    serverUrl: r.serverUrl,
    accessToken: r.accessToken,
    refreshToken: r.refreshToken,
    expiresAt: num(r.expiresAt),
    userId: str(r.userId)
  }
}

export function parseSnapshot(raw: unknown): NativeSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.items) || r.items.length === 0) return null
  const items = r.items
    .filter((i): i is Record<string, unknown> => Boolean(i) && typeof i === 'object' && typeof (i as { uid?: unknown }).uid === 'string' && typeof (i as { trackId?: unknown }).trackId === 'string')
    .map((i) => ({
      uid: str(i.uid),
      trackId: str(i.trackId),
      title: str(i.title),
      artist: str(i.artist),
      album: str(i.album),
      artworkUrl: str(i.artworkUrl),
      duration: num(i.duration),
      track: i.track
    }))
  if (items.length === 0) return null
  const repeat: NativeRepeat = r.repeat === 'all' || r.repeat === 'one' ? r.repeat : 'off'
  return {
    items,
    index: Math.min(Math.max(0, num(r.index)), items.length - 1),
    position: Math.max(0, num(r.position)),
    playing: r.playing === true,
    repeat,
    shuffle: r.shuffle === true,
    contextName: typeof r.contextName === 'string' && r.contextName ? r.contextName : undefined
  }
}

/** Maps a raw native `event` payload to a typed event; malformed payloads give null. */
export function parseEvent(raw: unknown): NativePlayerEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  switch (r.type) {
    case 'state':
      return typeof r.status === 'string' && STATES.has(r.status) ? { type: 'state', status: r.status as 'idle' } : null
    case 'position':
      return { type: 'position', position: Math.max(0, num(r.position)), duration: Math.max(0, num(r.duration)) }
    case 'index':
      return typeof r.uid === 'string' && r.uid ? { type: 'index', uid: r.uid } : null
    case 'error':
      return { type: 'error', message: str(r.message) }
    case 'queue': {
      const snapshot = parseSnapshot(r.snapshot)
      return snapshot ? { type: 'queue', snapshot } : null
    }
    case 'liked':
      return typeof r.trackId === 'string' ? { type: 'liked', trackId: r.trackId, liked: r.liked === true } : null
    case 'command':
      return r.kind === 'shuffle' || r.kind === 'repeat' ? { type: 'command', kind: r.kind } : null
    case 'auth': {
      const session = parseSession(r.session)
      return session ? { type: 'auth', session } : null
    }
    default:
      return null
  }
}

/**
 * Wraps the plugin in the platform-neutral NativePlayer. Never throws, never rejects.
 *
 * Takes the plugin boxed in a plain object: Capacitor plugins are Proxies that answer *any*
 * property (including `then`), so a Promise must never resolve to the plugin itself.
 * Calls are chained on one promise so they reach native in call order.
 */
export function createNativePlayer(box: Promise<{ plugin: NocturneNativePlugin }>): NativePlayer {
  box.catch(() => undefined) // plugin unavailable: every call below becomes a no-op
  let chain: Promise<unknown> = Promise.resolve()
  const call = (fn: (p: NocturneNativePlugin) => Promise<unknown>): void => {
    chain = chain.then(() => box.then(({ plugin }) => fn(plugin))).catch(() => undefined)
  }
  const listeners = new Set<(e: NativePlayerEvent) => void>()
  let subscribed = false
  const subscribe = (): void => {
    if (subscribed) return
    subscribed = true
    box
      .then(async ({ plugin }) => {
        await plugin.addListener('event', (raw) => {
          const e = parseEvent(raw)
          if (e) listeners.forEach((l) => l(e))
        })
      })
      .catch(() => {
        subscribed = false
      })
  }
  return {
    setQueue(items, index, opts: SetQueueOptions = {}) {
      call((p) => p.setQueue({ items, index, play: opts.play, startAt: opts.startAt ?? 0, reset: opts.reset === true }))
    },
    play: () => call((p) => p.play()),
    pause: () => call((p) => p.pause()),
    seek: (position) => call((p) => p.seek({ position })),
    setVolume: (volume) => call((p) => p.setVolume({ volume })),
    setRepeat: (mode) => call((p) => p.setRepeat({ mode })),
    setShuffle: (on) => call((p) => p.setShuffle({ on })),
    setPauseAtEnd: (on) => call((p) => p.setPauseAtEnd({ on })),
    stop: () => call((p) => p.stop()),
    setLiked: (trackId, liked) => call((p) => p.setLiked({ trackId, liked })),
    setAuth: (session) => call((p) => p.setAuth({ session })),
    async getAuth() {
      try {
        const { plugin } = await box
        return parseSession((await plugin.getAuth()).session)
      } catch {
        return null
      }
    },
    setLyricsInCar: (enabled) => call((p) => p.setLyricsInCar({ enabled })),
    setEq: (eq) => call((p) => p.setEq({ enabled: eq.enabled, preamp: eq.preamp, gains: eq.gains })),
    async getSnapshot() {
      try {
        const { plugin } = await box
        return parseSnapshot((await plugin.getSnapshot()).snapshot)
      } catch {
        return null
      }
    },
    on(listener) {
      listeners.add(listener)
      subscribe()
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
