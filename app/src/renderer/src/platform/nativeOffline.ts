import type { PluginListenerHandle } from '@capacitor/core'
import type { Track } from '../api/types'
import type { NativeDownloadItem, NativeOffline, NativeOfflineEvent, NativeOfflineState } from './offline/types'

/**
 * JS side of the app-local Capacitor plugin `NocturneOffline`
 * (android/app/src/main/java/es/alexcloudweb/nocturne/media/NocturneOfflinePlugin.java).
 */
export interface NocturneOfflinePlugin {
  configure(args: { autoTracks: number; autoBytes: number; wifiOnly: boolean; prefetchWifiOnly: boolean; limitBytes: number }): Promise<void>
  download(args: { tracks: Track[] }): Promise<{ accepted?: number; rejected?: number }>
  pause(args: { id: string }): Promise<void>
  resume(args: { id: string }): Promise<void>
  cancel(args: { ids: string[] }): Promise<void>
  removeAll(): Promise<void>
  clearCache(): Promise<void>
  state(): Promise<unknown>
  availability(args: { ids: string[] }): Promise<{ available?: string[]; pinned?: string[] }>
  network(): Promise<{ online?: boolean; unmetered?: boolean }>
  addListener(event: 'event', listener: (e: unknown) => void): Promise<PluginListenerHandle>
}

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const STATES = new Set(['queued', 'downloading', 'paused', 'done', 'failed', 'removing'])

export function parseState(raw: unknown): NativeOfflineState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const items: NativeDownloadItem[] = []
  if (Array.isArray(r.downloads)) {
    for (const d of r.downloads) {
      if (!d || typeof d !== 'object') continue
      const o = d as Record<string, unknown>
      if (typeof o.id !== 'string' || typeof o.state !== 'string' || !STATES.has(o.state)) continue
      items.push({ id: o.id, state: o.state as NativeDownloadItem['state'], percent: num(o.percent, -1), bytes: num(o.bytes), total: num(o.total) })
    }
  }
  return {
    downloads: items,
    autoBytes: num(r.autoBytes),
    pinnedBytes: num(r.pinnedBytes),
    autoTracks: num(r.autoTracks),
    limitBytes: num(r.limitBytes),
    paused: r.paused === true
  }
}

export function parseOfflineEvent(raw: unknown): NativeOfflineEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.type === 'downloads') return { type: 'downloads', state: parseState(r.state) }
  if (r.type === 'network') return { type: 'network', online: r.online !== false, unmetered: r.unmetered === true }
  return null
}

export function createNativeOffline(box: Promise<{ plugin: NocturneOfflinePlugin }>): NativeOffline {
  box.catch(() => undefined)
  const plugin = async (): Promise<NocturneOfflinePlugin> => (await box).plugin
  const listeners = new Set<(e: NativeOfflineEvent) => void>()
  let subscribed = false
  const subscribe = (): void => {
    if (subscribed) return
    subscribed = true
    box
      .then(async ({ plugin: p }) => {
        await p.addListener('event', (raw) => {
          const e = parseOfflineEvent(raw)
          if (e) listeners.forEach((l) => l(e))
        })
      })
      .catch(() => {
        subscribed = false
      })
  }
  const quiet = async (fn: (p: NocturneOfflinePlugin) => Promise<unknown>): Promise<void> => {
    try {
      await fn(await plugin())
    } catch {
      /* plugin missing or call failed: offline features degrade */
    }
  }
  return {
    configure: (opts) => quiet((p) => p.configure(opts)),
    async download(tracks) {
      try {
        const r = await (await plugin()).download({ tracks })
        return { accepted: num(r.accepted), rejected: num(r.rejected) }
      } catch {
        return { accepted: 0, rejected: tracks.length }
      }
    },
    pause: (id) => quiet((p) => p.pause({ id })),
    resume: (id) => quiet((p) => p.resume({ id })),
    cancel: (ids) => quiet((p) => p.cancel({ ids })),
    removeAll: () => quiet((p) => p.removeAll()),
    clearCache: () => quiet((p) => p.clearCache()),
    async state() {
      try {
        return parseState(await (await plugin()).state())
      } catch {
        return parseState(null)
      }
    },
    async availability(ids) {
      try {
        const r = await (await plugin()).availability({ ids })
        return { available: Array.isArray(r.available) ? r.available : [], pinned: Array.isArray(r.pinned) ? r.pinned : [] }
      } catch {
        return { available: [], pinned: [] }
      }
    },
    async network() {
      try {
        const r = await (await plugin()).network()
        return { online: r.online !== false, unmetered: r.unmetered === true }
      } catch {
        return { online: true, unmetered: false }
      }
    },
    on(listener) {
      listeners.add(listener)
      subscribe()
      return () => listeners.delete(listener)
    }
  }
}
