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
  notifyUpdate: 'app:notify-update'
} as const

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
    notifyUpdate?(info: { version: string; url: string }): Promise<boolean>
  }
}

/** Keys accepted by the secure store. Lowercase, short, no path characters. */
export const SECURE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
export const SECURE_VALUE_MAX = 64 * 1024
