import { getLocale } from '../i18n'
import type { NocturneBridge, WindowState } from '../../../shared/ipc'
import { createNativeNowPlaying, type NocturneMediaPlugin } from './nocturneMedia'
import { capacitorSaveOrShare, desktopSaveOrShare, webSaveOrShare, type SaveOrShareImage } from './saveImage'
import { createNativeUpdates, type NativeUpdates, type NocturneUpdatesPlugin } from './nocturneUpdates'

export type { NativeUpdates } from './nocturneUpdates'
export type { ImageIntent, ImageResult, SaveOrShareImage } from './saveImage'

export type PlatformKind = 'desktop' | 'android' | 'ios' | 'web'

export type RepeatMode = 'off' | 'all' | 'one'

export interface NowPlayingInfo {
  /** Stable track identity (lets native tell "same track restarted" from "new track"). */
  id?: string
  title: string
  artist: string
  album: string
  artworkUrl?: string
  /** Seconds. */
  duration: number
  /** Seconds, valid now; native extrapolates while playing. */
  position: number
  /** True while playing or buffering (play intent). */
  playing: boolean
  /** Stalled while `playing`: the position does not advance. */
  buffering?: boolean
  hasPrev: boolean
  hasNext: boolean
  liked?: boolean
  shuffle?: boolean
  repeat?: RepeatMode
}

export type RemoteCommand =
  | 'play' | 'pause' | 'toggle' | 'next' | 'previous' | 'stop' | 'like' | 'shuffle' | 'repeat'
  | { seekTo: number }

export interface NativeNowPlaying {
  update(info: NowPlayingInfo): void
  clear(): void
  onCommand(listener: (cmd: RemoteCommand) => void): () => void
}

export interface SecureStorage {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

export interface Platform {
  kind: PlatformKind
  secure: SecureStorage
  /** True when secrets are encrypted at rest by the OS. */
  secureAtRest(): Promise<boolean>
  /**
   * Hosted web only: the origin that serves both the app and the API (`location.origin`).
   * When set, the server field is hidden and the session lives in an HttpOnly cookie.
   */
  hostedOrigin: string | null
  window: NocturneBridge['window'] | null
  openExternal(url: string): Promise<void>
  /** Export a rendered PNG: share sheet (mobile), save dialog / clipboard (desktop), Web Share or download (web). */
  saveOrShareImage: SaveOrShareImage
  /** Native now-playing controls (Android Media3 session). Desktop and iOS use navigator.mediaSession. */
  nativeNowPlaying: NativeNowPlaying | null
  /** Android only: background update check (WorkManager) + "update available" notification. */
  nativeUpdates?: NativeUpdates | null
  /**
   * Desktop only: show a native "update available" notification; clicking it focuses the window
   * and opens `url`. Resolves false when notifications are unsupported or the call fails.
   */
  notifyUpdate?: ((info: { version: string; url: string }) => Promise<boolean>) | null
}

function isCapacitor(name: 'android' | 'ios'): boolean {
  const cap = (globalThis as { Capacitor?: { getPlatform?: () => string; isNativePlatform?: () => boolean } }).Capacitor
  return Boolean(cap?.isNativePlatform?.() && cap.getPlatform?.() === name)
}

function isAndroid(): boolean {
  return isCapacitor('android')
}

function isIos(): boolean {
  return isCapacitor('ios')
}

/** Dev/web fallback: tokens live in sessionStorage only (cleared with the tab). */
function sessionStorageSecure(): SecureStorage {
  const prefix = 'nocturne.secure.'
  return {
    async get(key) {
      try {
        return sessionStorage.getItem(prefix + key)
      } catch {
        return null
      }
    },
    async set(key, value) {
      sessionStorage.setItem(prefix + key, value)
    },
    async delete(key) {
      sessionStorage.removeItem(prefix + key)
    }
  }
}

/** Hosted mode: nothing secret is ever written to browser storage (the refresh token is an HttpOnly cookie). */
function noopSecure(): SecureStorage {
  return {
    async get() {
      return null
    },
    async set() {
      /* intentionally not persisted */
    },
    async delete() {
      /* nothing stored */
    }
  }
}

function desktopPlatform(bridge: NocturneBridge): Platform {
  let atRest: Promise<boolean> | null = null
  return {
    kind: 'desktop',
    secure: bridge.secure,
    secureAtRest: () => (atRest ??= bridge.app.info().then((i) => i.secureStorage, () => false)),
    hostedOrigin: null,
    window: bridge.window,
    openExternal: (url) => bridge.app.openExternal(url),
    saveOrShareImage: desktopSaveOrShare(bridge),
    nativeNowPlaying: null,
    nativeUpdates: null,
    notifyUpdate: async (info) => {
      try {
        return typeof bridge.app.notifyUpdate === 'function' ? (await bridge.app.notifyUpdate({ ...info, locale: getLocale() })) === true : false
      } catch {
        return false
      }
    }
  }
}

function androidPlatform(): Platform {
  // Capacitor plugins are Proxies that forward *any* property (including `then`) to native code,
  // so a Promise must never resolve to a plugin directly: wrap it in a plain object.
  const storageBox = import('@aparajita/capacitor-secure-storage').then(async ({ SecureStorage }) => {
    await SecureStorage.setKeyPrefix('nocturne_')
    return { plugin: SecureStorage }
  })
  // App-local Media3 plugin (android/.../media/NocturneMediaPlugin.java), registered in MainActivity.
  const mediaBox = import('@capacitor/core').then(({ registerPlugin }) => ({
    plugin: registerPlugin<NocturneMediaPlugin>('NocturneMedia')
  }))
  // App-local update-check plugin (android/.../updates/NocturneUpdatesPlugin.java), registered in MainActivity.
  const updatesBox = import('@capacitor/core').then(({ registerPlugin }) => ({
    plugin: registerPlugin<NocturneUpdatesPlugin>('NocturneUpdates')
  }))

  return {
    kind: 'android',
    secure: {
      get: async (key) => {
        const { plugin: s } = await storageBox
        const v = await s.get(key)
        return typeof v === 'string' ? v : null
      },
      set: async (key, value) => (await storageBox).plugin.set(key, value),
      delete: async (key) => {
        await (await storageBox).plugin.remove(key)
      }
    },
    secureAtRest: async () => true,
    hostedOrigin: null,
    window: null,
    openExternal: async (url) => {
      window.open(url, '_blank', 'noopener,noreferrer')
    },
    nativeNowPlaying: createNativeNowPlaying(mediaBox),
    nativeUpdates: createNativeUpdates(updatesBox),
    notifyUpdate: null,
    saveOrShareImage: capacitorSaveOrShare()
  }
}

/**
 * iOS (Capacitor, sideloaded .ipa). Keychain secure storage; background audio is the WKWebView
 * <audio> element (AVAudioSession .playback, see AppDelegate.swift) and the lock-screen /
 * Control Center controls come from navigator.mediaSession, so there is no native now-playing
 * plugin. No in-app install or background update check: the update banner opens the release page.
 */
function iosPlatform(): Platform {
  const storageBox = import('@aparajita/capacitor-secure-storage').then(async ({ SecureStorage }) => {
    await SecureStorage.setKeyPrefix('nocturne_')
    return { plugin: SecureStorage }
  })
  return {
    kind: 'ios',
    secure: {
      get: async (key) => {
        const { plugin: s } = await storageBox
        const v = await s.get(key)
        return typeof v === 'string' ? v : null
      },
      set: async (key, value) => (await storageBox).plugin.set(key, value),
      delete: async (key) => {
        await (await storageBox).plugin.remove(key)
      }
    },
    secureAtRest: async () => true,
    hostedOrigin: null,
    window: null,
    openExternal: async (url) => {
      window.open(url, '_blank', 'noopener,noreferrer')
    },
    nativeNowPlaying: null,
    nativeUpdates: null,
    notifyUpdate: null,
    saveOrShareImage: capacitorSaveOrShare()
  }
}

function webPlatform(): Platform {
  const hostedOrigin = import.meta.env.VITE_HOSTED === 'true' && typeof location !== 'undefined' ? location.origin : null
  return {
    kind: 'web',
    secure: hostedOrigin ? noopSecure() : sessionStorageSecure(),
    secureAtRest: async () => false,
    hostedOrigin,
    window: null,
    openExternal: async (url) => {
      window.open(url, '_blank', 'noopener,noreferrer')
    },
    nativeNowPlaying: null,
    nativeUpdates: null,
    notifyUpdate: null,
    saveOrShareImage: webSaveOrShare()
  }
}

export function detectPlatform(): Platform {
  if (typeof window !== 'undefined' && window.nocturne) return desktopPlatform(window.nocturne)
  if (isAndroid()) return androidPlatform()
  if (isIos()) return iosPlatform()
  return webPlatform()
}

export const platform: Platform = detectPlatform()

export type { WindowState }
