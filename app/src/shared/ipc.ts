/** IPC channel names shared by main, preload and renderer. */
export const IPC = {
  secureGet: 'secure:get',
  secureSet: 'secure:set',
  secureDelete: 'secure:delete',
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
  windowSetFullscreen: 'window:set-fullscreen',
  windowState: 'window:state',
  appInfo: 'app:info',
  openExternal: 'shell:open-external',
  notifyUpdate: 'app:notify-update',
  imageSave: 'image:save',
  imageCopy: 'image:copy',
  offlineList: 'offline:list',
  offlineStore: 'offline:store',
  offlineAbort: 'offline:abort',
  offlineProgress: 'offline:progress',
  offlineSetPinned: 'offline:set-pinned',
  offlineTouch: 'offline:touch',
  offlineRemove: 'offline:remove',
  offlineClear: 'offline:clear',
  offlineConfigure: 'offline:configure'
} as const

/** One track in the desktop offline store. */
export interface OfflineAudio {
  id: string
  bytes: number
  pinned: boolean
  lastPlayed: number
}

/** Progress of a store; `done` also fires for a track cached by the streaming tee. */
export interface OfflineProgress {
  id: string
  bytes: number
  total: number
  done?: boolean
}

/** Custom schemes served by the main process (see src/main/offline.ts). */
export const OFFLINE_SCHEME = 'nocturne-offline'
export const STREAM_SCHEME = 'nocturne-stream'

export interface WindowState {
  maximized: boolean
  fullscreen: boolean
  focused: boolean
}

export interface AppInfo {
  version: string
  platform: string
  /** True when tokens are encrypted with the OS keychain (DPAPI / libsecret / kwallet). */
  secureStorage: boolean
}

/** API exposed on `window.nocturne` by the preload script. */
export interface NocturneBridge {
  secure: {
    get(key: string): Promise<string | null>
    set(key: string, value: string): Promise<void>
    delete(key: string): Promise<void>
  }
  window: {
    minimize(): Promise<void>
    toggleMaximize(): Promise<void>
    close(): Promise<void>
    setFullscreen(on: boolean): Promise<void>
    onState(listener: (state: WindowState) => void): () => void
  }
  app: {
    info(): Promise<AppInfo>
    openExternal(url: string): Promise<void>
    /**
     * Native "Nocturne <version> available" notification; clicking it focuses the window and
     * opens `url` (http/https only). Resolves false when the OS has no notification support.
     * Optional so older preloads / test fakes stay valid.
     */
    notifyUpdate?(info: { version: string; url: string; locale?: string }): Promise<boolean>
  }
  /** Desktop offline audio store (optional so older preloads / fakes stay valid). */
  offline?: {
    list(): Promise<OfflineAudio[]>
    /** Main downloads `url` (a signed stream URL) into the store; resolves with the size. */
    store(id: string, url: string, opts: { pinned: boolean; mime?: string }): Promise<number>
    abort(id: string): Promise<void>
    onProgress(listener: (p: OfflineProgress) => void): () => void
    setPinned(id: string, pinned: boolean): Promise<void>
    touch(id: string): Promise<void>
    remove(ids: string[]): Promise<void>
    /** Removes every auto-cached track (never pinned ones); resolves with the removed ids. */
    clearAuto(): Promise<string[]>
    /** Cache budget (see shared/offlinePolicy); resolves with the evicted ids. */
    configure(settings: unknown): Promise<string[]>
  }
  /** Desktop image export (optional so older preloads / fakes stay valid). */
  image?: {
    /** Save dialog + write; resolves false when the user cancels. */
    save(bytes: Uint8Array, filename: string): Promise<boolean>
    /** Puts the PNG on the system clipboard. */
    copy(bytes: Uint8Array): Promise<boolean>
  }
}

/** Keys accepted by the secure store. Lowercase, short, no path characters. */
export const SECURE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
export const SECURE_VALUE_MAX = 64 * 1024
