import { create } from 'zustand'
import { api, platform, useSession } from '../services'
import { buildUrl } from '../lib/url'
import { isNewerVersion, isPrerelease } from '../lib/version'
import { iosUpdateUrl } from '../platform/iosUpdates'

/** One platform entry from GET /v1/updates/{platform}. */
export interface LatestInfo {
  version: string
  url: string
  sha256?: string
  notes?: string
}

interface UpdatesState {
  /** True when the feed advertises a version newer than the installed build. */
  available: boolean
  latest: LatestInfo | null
  /** Absolute URL to open to download/install the update, or null. */
  downloadUrl: string | null
  /** A check is in flight. */
  checking: boolean
  /** At least one check has completed (success or failure). */
  checked: boolean
  /** Query the update feed for this build target. Never runs on web. Fails silently. */
  check(): Promise<void>
  /** Run check() once (after login/startup); a no-op if already checked or in flight. */
  autoCheck(): void
}

/** The installed app version, from the `__APP_VERSION__` build-time define. */
function installedVersion(): string {
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0'
}

/**
 * The feed to query, or null when updates don't apply (hosted/self-hosted web).
 * Pre-release Android builds follow the beta channel (`android-beta`), whose
 * feed always points at the newest of the latest beta and the latest stable.
 */
export function targetPlatform(installed: string = installedVersion()): string | null {
  if (platform.hostedOrigin) return null
  if (platform.kind === 'android') return isPrerelease(installed) ? 'android-beta' : 'android'
  if (platform.kind === 'desktop') return 'desktop'
  // iOS has no feed of its own yet: the server's `desktop` feed carries the release version (the
  // download link is overridden below, so only the version number is used).
  if (platform.kind === 'ios') return 'desktop'
  return null // web: the browser app updates itself
}

export { compareVersions, isNewerVersion, isPrerelease } from '../lib/version'

export const useUpdates = create<UpdatesState>((set, get) => ({
  available: false,
  latest: null,
  downloadUrl: null,
  checking: false,
  checked: false,

  async check() {
    const target = targetPlatform()
    if (!target) {
      set({ checked: true })
      return
    }
    set({ checking: true })
    try {
      const latest = await api.checkUpdate(target)
      const s = useSession.getState()
      const serverUrl = s.session?.serverUrl || s.lastServerUrl
      const available = isNewerVersion(latest.version, installedVersion())
      // iOS cannot install in-app: point at the release page / AltStore source instead.
      const downloadUrl = platform.kind === 'ios'
        ? iosUpdateUrl(isPrerelease(installedVersion()))
        : serverUrl && latest.url ? buildUrl(serverUrl, latest.url) : null
      set({ latest, available, downloadUrl, checking: false, checked: true })
    } catch {
      // Offline / 404 / feed unavailable: stay quiet.
      set({ checking: false, checked: true })
    }
  },

  autoCheck() {
    const { checking, checked } = get()
    if (checking || checked) return
    void get().check()
  }
}))
