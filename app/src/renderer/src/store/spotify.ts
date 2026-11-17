import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { ApiClient } from '../api/client'
import { ApiError, describeError } from '../api/errors'
import type { SpotifyImport, SpotifyPlaylist, SpotifyStatus } from '../api/types'
import { resources, type ResourceCache } from '../lib/resource'
import { invalidatePlaylists } from './playlists'

/**
 * Spotify import (capabilities.spotifyImport): connection status, the user's Spotify playlists and
 * the import jobs. Active imports are polled every few seconds while at least one view `watch()`es
 * the store and the document is visible; polling stops on its own once every import has finished.
 */

export type SpotifyApi = Pick<
  ApiClient,
  | 'spotifyStatus'
  | 'spotifyAuthorize'
  | 'spotifyDisconnect'
  | 'spotifyPlaylists'
  | 'spotifyStartImport'
  | 'spotifyImports'
  | 'spotifyImport'
  | 'spotifyCancelImport'
>

// ---- Pure helpers -------------------------------------------------------------

const FINISHED = new Set<SpotifyImport['status']>(['done', 'failed', 'cancelled'])

export function isActiveImport(imp: Pick<SpotifyImport, 'status'>): boolean {
  return !FINISHED.has(imp.status)
}

const num = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0)

/** Songs that ended up in the playlist (already in the library + downloaded) and the 0..1 fraction of `total`. */
export function importProgress(imp: Pick<SpotifyImport, 'total' | 'matched' | 'downloaded'>): { ready: number; total: number; fraction: number | undefined } {
  const total = num(imp.total)
  const ready = Math.min(total || Infinity, num(imp.matched) + num(imp.downloaded))
  return { ready: Number.isFinite(ready) ? ready : 0, total, fraction: total > 0 ? ready / total : undefined }
}

export const IMPORT_STATUS_LABEL: Record<SpotifyImport['status'], string> = {
  queued: 'Queued',
  reading: 'Reading playlist',
  matching: 'Matching songs',
  downloading: 'Downloading',
  done: 'Imported',
  failed: 'Failed',
  cancelled: 'Cancelled'
}

const songs = (n: number): string => `${n} ${n === 1 ? 'song' : 'songs'}`

/** Toast text for an import that just finished. */
export function describeFinished(imp: SpotifyImport): string {
  const name = imp.spotifyPlaylist?.name || 'playlist'
  if (imp.status === 'failed') return imp.error ? `Couldn't import '${name}': ${imp.error}` : `Couldn't import '${name}'`
  if (imp.status === 'cancelled') return `Import of '${name}' cancelled`
  const { ready } = importProgress(imp)
  const missing = num(imp.failed)
  return `Imported '${name}': ${songs(ready)}${missing > 0 ? `, ${missing} not found` : ''}`
}

const ID_RE = /^[A-Za-z0-9]{16,40}$/

/**
 * Accepts a Spotify playlist link (open.spotify.com/…/playlist/<id>, with or without locale / query),
 * a `spotify:playlist:<id>` URI or a bare id. Returns the playlist id, or null.
 */
export function parseSpotifyPlaylist(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  if (ID_RE.test(raw)) return raw
  const uri = /^spotify:(?:user:[^:]+:)?playlist:([A-Za-z0-9]+)$/i.exec(raw)
  if (uri) return ID_RE.test(uri[1]!) ? uri[1]! : null
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.hostname !== 'open.spotify.com' && url.hostname !== 'play.spotify.com') return null
  const parts = url.pathname.split('/').filter(Boolean)
  const i = parts.indexOf('playlist')
  const id = i >= 0 ? parts[i + 1] : undefined
  return id && ID_RE.test(id) ? id : null
}

/** Days before expiry when the UI starts warning about reconnecting. */
export const EXPIRY_WARNING_DAYS = 14

export interface ConnectionExpiry {
  at: Date
  expired: boolean
  /** Within EXPIRY_WARNING_DAYS. */
  soon: boolean
  daysLeft: number
}

export function connectionExpiry(status: Pick<SpotifyStatus, 'expiresAt'> | null | undefined, now = Date.now()): ConnectionExpiry | null {
  if (!status?.expiresAt) return null
  const at = new Date(status.expiresAt)
  const ms = at.getTime()
  if (!Number.isFinite(ms)) return null
  const daysLeft = Math.ceil((ms - now) / 86_400_000)
  return { at, expired: ms <= now, soon: ms > now && daysLeft <= EXPIRY_WARNING_DAYS, daysLeft }
}

/** A 409 from /v1/spotify/* means "no Spotify account connected". */
export function isNotConnected(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409
}

// ---- Store --------------------------------------------------------------------

export interface SpotifyState {
  status: SpotifyStatus | null
  statusLoading: boolean
  statusError: string | null
  playlists: SpotifyPlaylist[] | null
  playlistsLoading: boolean
  playlistsError: string | null
  /** Newest first. */
  imports: SpotifyImport[]
  importsLoaded: boolean
  /** True while a poll is scheduled. */
  polling: boolean

  loadStatus(): Promise<SpotifyStatus | null>
  /** Asks the server for the Spotify login URL (the caller opens it externally). */
  authorize(): Promise<string>
  disconnect(): Promise<void>
  loadPlaylists(force?: boolean): Promise<void>
  startImport(playlist: string, download: boolean): Promise<SpotifyImport>
  cancelImport(id: string): Promise<void>
  /** Reloads the full import list. */
  refreshImports(): Promise<void>
  /** Fetches every active import once (normally driven by the poll timer). */
  pollOnce(): Promise<void>
  /** Registers an interested view; returns the matching unwatch. Polling only runs while watched. */
  watch(): () => void
  reset(): void
}

export interface SpotifyStoreDeps {
  api: SpotifyApi
  cache?: ResourceCache
  /** Poll period for active imports. */
  intervalMs?: number
  /** Minimum gap between playlist cache invalidations caused by progress (finishing always invalidates). */
  invalidateEveryMs?: number
  now?: () => number
  isVisible?: () => boolean
  onFinished?: (imp: SpotifyImport) => void
}

const INITIAL = {
  status: null,
  statusLoading: false,
  statusError: null,
  playlists: null,
  playlistsLoading: false,
  playlistsError: null,
  imports: [] as SpotifyImport[],
  importsLoaded: false,
  polling: false
}

const docVisible = (): boolean => typeof document === 'undefined' || document.visibilityState !== 'hidden'

export function createSpotifyStore(deps: SpotifyStoreDeps): UseBoundStore<StoreApi<SpotifyState>> {
  const cache = deps.cache ?? resources
  const intervalMs = deps.intervalMs ?? 3000
  const invalidateEveryMs = deps.invalidateEveryMs ?? 10_000
  const now = deps.now ?? Date.now
  const visible = deps.isVisible ?? docVisible

  let timer: ReturnType<typeof setTimeout> | null = null
  let watchers = 0
  let generation = 0
  const lastInvalidated = new Map<string, number>()
  let onVisibility: (() => void) | null = null

  return create<SpotifyState>((set, get) => {
    /** Merges fresh copies of imports; fires toasts / invalidations for transitions. */
    const merge = (fresh: SpotifyImport[], replaceAll: boolean): void => {
      const prevById = new Map(get().imports.map((i) => [i.id, i]))
      for (const next of fresh) {
        const prev = prevById.get(next.id)
        const finished = Boolean(prev && isActiveImport(prev) && !isActiveImport(next))
        if (next.playlistId) {
          const progressed = prev !== undefined && importProgress(prev).ready !== importProgress(next).ready
          const appeared = prev !== undefined ? prev.playlistId !== next.playlistId : isActiveImport(next)
          const last = lastInvalidated.get(next.id) ?? Number.NEGATIVE_INFINITY
          if (finished || appeared || (progressed && now() - last >= invalidateEveryMs)) {
            lastInvalidated.set(next.id, now())
            invalidatePlaylists(next.playlistId, cache)
          }
        }
        if (finished) {
          lastInvalidated.delete(next.id)
          deps.onFinished?.(next)
        }
      }
      if (replaceAll) {
        set({ imports: fresh, importsLoaded: true })
        return
      }
      const freshById = new Map(fresh.map((i) => [i.id, i]))
      const kept = get().imports.map((i) => freshById.get(i.id) ?? i)
      const added = fresh.filter((i) => !prevById.has(i.id))
      set({ imports: [...added, ...kept] })
    }

    const stopTimer = (): void => {
      if (timer) clearTimeout(timer)
      timer = null
    }

    const schedule = (delay = intervalMs): void => {
      if (timer) return
      if (watchers === 0 || !visible() || !get().imports.some(isActiveImport)) {
        if (get().polling) set({ polling: false })
        return
      }
      timer = setTimeout(() => {
        timer = null
        const gen = generation
        void get()
          .pollOnce()
          .finally(() => {
            if (gen === generation) schedule()
          })
      }, delay)
      if (!get().polling) set({ polling: true })
    }

    return {
      ...INITIAL,

      async loadStatus() {
        const gen = generation
        set({ statusLoading: true, statusError: null })
        try {
          const status = await deps.api.spotifyStatus()
          if (gen !== generation) return null
          set({ status, statusLoading: false })
          if (!status.connected) set({ playlists: null, playlistsError: null })
          return status
        } catch (err) {
          if (gen === generation) set({ statusLoading: false, statusError: describeError(err) })
          return null
        }
      },

      async authorize() {
        const { url } = await deps.api.spotifyAuthorize()
        return url
      },

      async disconnect() {
        await deps.api.spotifyDisconnect()
        const configured = get().status?.configured ?? true
        set({ status: { configured, connected: false }, playlists: null, playlistsError: null })
      },

      async loadPlaylists(force = false) {
        if (get().playlistsLoading || (!force && get().playlists)) return
        const gen = generation
        set({ playlistsLoading: true, playlistsError: null })
        try {
          const list = await deps.api.spotifyPlaylists()
          if (gen !== generation) return
          set({ playlists: Array.isArray(list) ? list : [], playlistsLoading: false })
        } catch (err) {
          if (gen !== generation) return
          if (isNotConnected(err)) {
            const configured = get().status?.configured ?? true
            set({ status: { configured, connected: false }, playlists: null, playlistsLoading: false, playlistsError: null })
            return
          }
          set({ playlistsLoading: false, playlistsError: describeError(err) })
        }
      },

      async startImport(playlist, download) {
        try {
          const imp = await deps.api.spotifyStartImport({ playlist, download })
          merge([imp], false)
          schedule()
          return imp
        } catch (err) {
          if (isNotConnected(err)) void get().loadStatus()
          throw err
        }
      },

      async cancelImport(id) {
        await deps.api.spotifyCancelImport(id)
        const current = get().imports.find((i) => i.id === id)
        if (current && isActiveImport(current)) {
          // Local update: no "finished" toast for a cancel the user asked for.
          set({
            imports: get().imports.map((i) => (i.id === id ? { ...i, status: 'cancelled' as const, finishedAt: new Date(now()).toISOString() } : i))
          })
          if (current.playlistId) invalidatePlaylists(current.playlistId, cache)
        }
        try {
          const fresh = await deps.api.spotifyImport(id)
          if (!isActiveImport(fresh)) set({ imports: get().imports.map((i) => (i.id === id ? fresh : i)) })
        } catch {
          /* keep the local copy */
        }
        schedule()
      },

      async refreshImports() {
        const gen = generation
        try {
          const list = await deps.api.spotifyImports()
          if (gen !== generation) return
          merge(Array.isArray(list) ? list : [], true)
        } catch {
          if (gen === generation) set({ importsLoaded: true })
        }
        schedule()
      },

      async pollOnce() {
        const active = get().imports.filter(isActiveImport)
        if (active.length === 0) return
        const gen = generation
        const results = await Promise.allSettled(active.map((i) => deps.api.spotifyImport(i.id)))
        if (gen !== generation) return
        const fresh: SpotifyImport[] = []
        const gone = new Set<string>()
        results.forEach((r, idx) => {
          if (r.status === 'fulfilled' && r.value && typeof r.value.id === 'string') fresh.push(r.value)
          else if (r.status === 'rejected' && r.reason instanceof ApiError && r.reason.code === 'not_found') gone.add(active[idx]!.id)
        })
        if (gone.size) set({ imports: get().imports.filter((i) => !gone.has(i.id)) })
        if (fresh.length) merge(fresh, false)
      },

      watch() {
        watchers++
        if (watchers === 1 && typeof document !== 'undefined') {
          onVisibility = () => {
            if (visible()) {
              // Back in view: catch up right away, then resume the normal cadence.
              stopTimer()
              schedule(0)
            } else {
              stopTimer()
              if (get().polling) set({ polling: false })
            }
          }
          document.addEventListener('visibilitychange', onVisibility)
        }
        schedule()
        let done = false
        return () => {
          if (done) return
          done = true
          watchers = Math.max(0, watchers - 1)
          if (watchers === 0) {
            stopTimer()
            if (onVisibility && typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
            onVisibility = null
            if (get().polling) set({ polling: false })
          }
        }
      },

      reset() {
        generation++
        stopTimer()
        lastInvalidated.clear()
        set({ ...INITIAL })
      }
    }
  })
}
