import type { PluginListenerHandle } from '@capacitor/core'
import type { NativeNowPlaying, NowPlayingInfo, RemoteCommand, RepeatMode } from './index'

/**
 * JS side of the app-local Capacitor plugin `NocturneMedia`
 * (android/app/src/main/java/es/alexcloudweb/nocturne/media/NocturneMediaPlugin.java), which feeds an
 * AndroidX Media3 MediaSession: notification shade, lock screen, Samsung Now Bar, Bluetooth.
 */

/** What `update()` sends to native. Times are in seconds; native converts to ms. */
export interface NocturneMediaPayload {
  id: string
  title: string
  artist: string
  album: string
  artworkUrl: string
  duration: number
  position: number
  playing: boolean
  buffering: boolean
  hasPrev: boolean
  hasNext: boolean
  liked: boolean
  shuffle: boolean
  repeat: RepeatMode
}

export type NocturneMediaCommandKind =
  | 'play' | 'pause' | 'toggle' | 'next' | 'previous' | 'stop' | 'seekTo' | 'like' | 'shuffle' | 'repeat'

export interface NocturneMediaCommandEvent {
  kind: NocturneMediaCommandKind
  /** Seconds; only for `seekTo`. */
  position?: number
}

export interface NocturneMediaPlugin {
  update(info: NocturneMediaPayload): Promise<void>
  clear(): Promise<void>
  addListener(event: 'command', listener: (e: NocturneMediaCommandEvent) => void): Promise<PluginListenerHandle>
}

const finite = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0)

/** Normalises NowPlayingInfo into the strict payload the native side expects. */
export function toNativePayload(info: NowPlayingInfo): NocturneMediaPayload {
  const duration = finite(info.duration)
  const position = finite(info.position)
  const repeat: RepeatMode = info.repeat === 'all' || info.repeat === 'one' ? info.repeat : 'off'
  return {
    id: info.id ?? '',
    title: info.title ?? '',
    artist: info.artist ?? '',
    album: info.album ?? '',
    artworkUrl: info.artworkUrl ?? '',
    duration,
    position: duration > 0 ? Math.min(position, duration) : position,
    playing: info.playing === true,
    buffering: info.buffering === true,
    hasPrev: info.hasPrev === true,
    hasNext: info.hasNext === true,
    liked: info.liked === true,
    shuffle: info.shuffle === true,
    repeat
  }
}

const SIMPLE = new Set<string>(['play', 'pause', 'toggle', 'next', 'previous', 'stop', 'like', 'shuffle', 'repeat'])

/** Maps a native `command` event to a RemoteCommand; unknown or malformed events give null. */
export function parseCommand(raw: unknown): RemoteCommand | null {
  if (!raw || typeof raw !== 'object') return null
  const { kind, position } = raw as { kind?: unknown; position?: unknown }
  if (typeof kind !== 'string') return null
  if (kind === 'seekTo') {
    return typeof position === 'number' && Number.isFinite(position) && position >= 0 ? { seekTo: position } : null
  }
  return SIMPLE.has(kind) ? (kind as Exclude<RemoteCommand, { seekTo: number }>) : null
}

/**
 * Wraps the plugin in the platform's NativeNowPlaying interface. Never throws, never rejects.
 *
 * Takes the plugin boxed in a plain object: Capacitor plugins are Proxies that answer *any*
 * property (including `then`), so a Promise must never resolve to the plugin itself.
 * Calls are chained on the same promise, so update/clear reach native in call order.
 */
export function createNativeNowPlaying(box: Promise<{ plugin: NocturneMediaPlugin }>): NativeNowPlaying {
  box.catch(() => undefined) // plugin unavailable: every call below becomes a no-op
  let active = false
  let subscribed = false
  const listeners = new Set<(cmd: RemoteCommand) => void>()
  const onEvent = (e: unknown): void => {
    const cmd = parseCommand(e)
    if (cmd) listeners.forEach((l) => l(cmd))
  }
  const subscribe = (): void => {
    if (subscribed) return
    subscribed = true
    box
      .then(async ({ plugin }) => {
        await plugin.addListener('command', onEvent)
      })
      .catch(() => {
        subscribed = false
      })
  }
  const call = (fn: (plugin: NocturneMediaPlugin) => Promise<void>): void => {
    box.then(({ plugin }) => fn(plugin)).catch(() => undefined)
  }
  return {
    update(info) {
      subscribe()
      active = true
      const payload = toNativePayload(info)
      call((p) => p.update(payload))
    },
    clear() {
      if (!active) return
      active = false
      call((p) => p.clear())
    },
    onCommand(listener) {
      listeners.add(listener)
      subscribe()
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
