import { create } from 'zustand'
import type { Platform } from '../platform'
import { readJson, writeJson } from '../lib/storage'

/**
 * System notifications for "a new Nocturne version is available".
 *
 * - Android: after sign-in the NocturneUpdates plugin is configured with the server + feed channel,
 *   which schedules a WorkManager periodic check that notifies even with the app closed. When the
 *   in-app check (useUpdates) finds an update, the same native notification is posted (native dedupes
 *   per version in SharedPreferences, shared with the worker). Logout clears the schedule. Tapping the
 *   notification opens the app and re-reveals the update banner.
 * - Desktop: the in-app check result is shown once per version as a native notification (dedupe in
 *   localStorage); clicking it focuses the window and opens the download URL.
 * - Web / hosted: nothing.
 */

/** Desktop: the last version a system notification was shown for. */
export const NOTIFIED_KEY = 'nocturne.update.notified'

/** Banner override: a version the user explicitly asked to see (tapped the notification). */
interface RevealState {
  version: string | null
  reveal(version: string | null): void
}

export const useUpdateReveal = create<RevealState>((set) => ({
  version: null,
  reveal: (version) => set({ version })
}))

export function readNotified(): string {
  return readJson<string>(NOTIFIED_KEY, '', (v): v is string => typeof v === 'string')
}

/** Records `version` as notified; false when it already was (i.e. don't notify again). */
export function markNotified(version: string): boolean {
  if (!version || readNotified() === version) return false
  writeJson(NOTIFIED_KEY, version)
  return true
}

interface SessionSnapshot {
  status: 'restoring' | 'signedOut' | 'signedIn'
  session: { serverUrl: string } | null
  lastServerUrl: string
}

interface UpdatesSnapshot {
  available: boolean
  latest: { version: string } | null
  downloadUrl: string | null
  checked: boolean
  check(): Promise<void>
}

interface Subscribable<T> {
  getState(): T
  subscribe(listener: (state: T, prev: T) => void): () => void
}

export interface UpdateNotificationDeps {
  platform: Pick<Platform, 'kind' | 'hostedOrigin' | 'nativeUpdates' | 'notifyUpdate'>
  session: Subscribable<SessionSnapshot>
  updates: Subscribable<UpdatesSnapshot>
  /** Feed channel for this build (`android` / `android-beta` / `desktop`), or null. */
  channel(): string | null
}

/** Wires session + update-check state to the native notifiers. Returns an unsubscribe function. */
export function createUpdateNotifications(deps: UpdateNotificationDeps): () => void {
  const { platform } = deps
  if (platform.hostedOrigin || platform.kind === 'web') return () => undefined
  const native = platform.kind === 'android' ? platform.nativeUpdates ?? null : null
  const desktopNotify = platform.kind === 'desktop' ? platform.notifyUpdate ?? null : null
  const cleanups: Array<() => void> = []

  // Android: keep the background check configured while signed in; clear it on logout.
  let configuredFor: string | null = null
  const syncSession = (s: SessionSnapshot): void => {
    if (!native) return
    if (s.status === 'signedIn') {
      const serverUrl = s.session?.serverUrl || s.lastServerUrl
      const channel = deps.channel()
      if (!serverUrl || !channel) return
      const key = `${serverUrl}\n${channel}`
      if (configuredFor === key) return
      configuredFor = key
      void native.configure(serverUrl, channel)
    } else if (s.status === 'signedOut' && configuredFor !== '') {
      configuredFor = '' // '' = cleared; null = never touched (still clears once at startup)
      void native.clear()
    }
  }

  // In-app check found an update: post the system notification once per version.
  const attempted = new Set<string>()
  const syncUpdates = (u: UpdatesSnapshot): void => {
    const version = u.available ? u.latest?.version : undefined
    if (!version || attempted.has(version)) return
    if (native) {
      attempted.add(version)
      void native.notify(version)
    } else if (desktopNotify && u.downloadUrl) {
      attempted.add(version)
      if (!markNotified(version)) return
      const url = u.downloadUrl
      void desktopNotify({ version, url }).catch(() => false)
    }
  }

  const safe = <T,>(fn: (v: T) => void) => (v: T): void => {
    try {
      fn(v)
    } catch {
      /* never let notification plumbing break the app */
    }
  }

  cleanups.push(deps.session.subscribe(safe(syncSession)))
  cleanups.push(deps.updates.subscribe(safe(syncUpdates)))
  safe(syncSession)(deps.session.getState())
  safe(syncUpdates)(deps.updates.getState())

  if (native) {
    cleanups.push(
      native.onTapped(
        safe((version: string | null) => {
          const u = deps.updates.getState()
          useUpdateReveal.getState().reveal(version ?? u.latest?.version ?? null)
          // Refresh the feed so the banner reflects the newest build; before the first check
          // (cold start) the banner's own autoCheck runs after sign-in.
          if (u.checked) void u.check().catch(() => undefined)
        })
      )
    )
  }

  return () => {
    for (const c of cleanups.splice(0)) {
      try {
        c()
      } catch {
        /* ignore */
      }
    }
  }
}
