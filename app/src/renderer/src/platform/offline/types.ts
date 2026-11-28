import type { CacheSettings } from '../../lib/offline/policy'
import type { Track, ServerLyrics } from '../../api/types'

/** One audio file the device can play with no network. */
export interface StoredAudio {
  id: string
  bytes: number
  pinned: boolean
  /** Epoch ms of the last play. */
  lastPlayed: number
}

export interface StoreOptions {
  pinned: boolean
  mime?: string
  onProgress(bytes: number, total: number): void
  signal: AbortSignal
}

/** Thrown when the browser refuses more storage (quota): the UI degrades instead of failing playback. */
export class QuotaError extends Error {
  constructor() {
    super('storage quota exceeded')
    this.name = 'QuotaError'
  }
}

/**
 * Where the audio of the offline features lives. Android does not use this (the Media3 service owns its
 * own SimpleCache, see NativeOffline); desktop uses the main process, web/iOS use IndexedDB.
 */
export interface OfflineBackend {
  readonly kind: 'idb' | 'desktop'
  init(): Promise<void>
  list(): Promise<StoredAudio[]>
  /** URL an <audio> element can play for a stored track, or null. */
  playbackUrl(id: string): Promise<string | null>
  /** Downloads `url` (a signed stream URL) into the store. Resolves with the size. */
  store(id: string, url: string, opts: StoreOptions): Promise<number>
  setPinned(id: string, pinned: boolean): Promise<void>
  touch(id: string): Promise<void>
  remove(ids: string[]): Promise<void>
  /** Removes every auto-cached track (never pinned ones). Resolves with the removed ids. */
  clearAuto(): Promise<string[]>
  /** Applies the cache budget now; resolves with the evicted ids. */
  applyPolicy(settings: CacheSettings, protect?: ReadonlySet<string>): Promise<string[]>
  /** Subscribes to tracks cached by the streaming tee (desktop). */
  onCached?(listener: (id: string) => void): () => void
  /**
   * Desktop: a URL that streams `signedUrl` and caches it on the fly (no second download). Other
   * backends cache with a separate fetch, see `store`.
   */
  teeUrl?(id: string, signedUrl: string): string
  /** Browser quota (bytes), when the platform can tell. */
  estimate?(): Promise<{ usage: number; quota: number } | null>
}

/** What the Android plugin tells the WebView (see NocturneOfflinePlugin.java). */
export interface NativeDownloadItem {
  id: string
  state: 'queued' | 'downloading' | 'paused' | 'done' | 'failed' | 'removing'
  percent: number
  bytes: number
  total: number
}

export interface NativeOfflineState {
  downloads: NativeDownloadItem[]
  autoBytes: number
  pinnedBytes: number
  autoTracks: number
  limitBytes: number
  paused: boolean
}

export type NativeOfflineEvent =
  | { type: 'downloads'; state: NativeOfflineState }
  | { type: 'network'; online: boolean; unmetered: boolean }

export interface NativeOffline {
  configure(opts: { autoTracks: number; autoBytes: number; wifiOnly: boolean; prefetchWifiOnly: boolean; limitBytes: number }): Promise<void>
  /** Queues raw Track JSON objects for download (pinned). */
  download(tracks: Track[]): Promise<{ accepted: number; rejected: number }>
  pause(id: string): Promise<void>
  resume(id: string): Promise<void>
  cancel(ids: string[]): Promise<void>
  removeAll(): Promise<void>
  clearCache(): Promise<void>
  state(): Promise<NativeOfflineState>
  availability(ids: string[]): Promise<{ available: string[]; pinned: string[] }>
  network(): Promise<{ online: boolean; unmetered: boolean }>
  on(listener: (e: NativeOfflineEvent) => void): () => void
}

/** Track extras stored next to the audio, for every platform (IndexedDB in the WebView / browser). */
export interface MetaStore {
  putTrack(track: Track): Promise<void>
  getTrack(id: string): Promise<Track | undefined>
  allTracks(): Promise<Track[]>
  deleteTrack(id: string): Promise<void>
  putLyrics(id: string, lyrics: ServerLyrics): Promise<void>
  getLyrics(id: string): Promise<ServerLyrics | undefined>
  putArt(id: string, blob: Blob): Promise<void>
  getArt(id: string): Promise<Blob | undefined>
  clearAll(): Promise<void>
}
