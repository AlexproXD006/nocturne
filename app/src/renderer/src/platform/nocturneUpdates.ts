import type { PluginListenerHandle } from '@capacitor/core'

/**
 * JS side of the app-local Capacitor plugin `NocturneUpdates`
 * (android/app/src/main/java/es/alexcloudweb/nocturne/updates/NocturneUpdatesPlugin.java):
 * a WorkManager periodic check of `GET <serverUrl>/v1/updates/<channel>` that posts an
 * "update available" notification even with the app closed, plus the same notification on demand.
 */
export interface NocturneUpdatesPlugin {
  configure(options: { serverUrl: string; channel: string }): Promise<void>
  clear(): Promise<void>
  notify(options: { version: string }): Promise<{ posted?: boolean } | undefined>
  addListener(event: 'updateTapped', listener: (e: { version?: string }) => void): Promise<PluginListenerHandle>
}

/** Android background update checks + system notification. Every method is fail-safe. */
export interface NativeUpdates {
  /** Remember the feed and (re)schedule the periodic background check. */
  configure(serverUrl: string, channel: string): Promise<void>
  /** Logout: cancel the background check and forget the feed. */
  clear(): Promise<void>
  /** Post the "Nocturne <version> available" notification unless already shown for that version. */
  notify(version: string): Promise<boolean>
  /** The app was opened by tapping the notification (version, or null when unknown). */
  onTapped(listener: (version: string | null) => void): () => void
}

/** Wraps the (lazily registered) plugin; native/bridge failures are swallowed, never thrown. */
export function createNativeUpdates(box: Promise<{ plugin: NocturneUpdatesPlugin }>): NativeUpdates {
  const listeners = new Set<(version: string | null) => void>()
  let subscribed: Promise<unknown> | null = null
  const pending: Array<string | null> = []

  const ensureSubscribed = (): void => {
    subscribed ??= box
      .then(({ plugin }) =>
        plugin.addListener('updateTapped', (e) => {
          const v = e && typeof e.version === 'string' && e.version ? e.version : null
          if (listeners.size === 0) pending.push(v)
          for (const fn of listeners) {
            try {
              fn(v)
            } catch {
              /* listener bug: keep the others going */
            }
          }
        })
      )
      .catch(() => undefined)
  }

  return {
    async configure(serverUrl, channel) {
      try {
        await (await box).plugin.configure({ serverUrl, channel })
      } catch {
        /* plugin missing / rejected: the in-app banner still works */
      }
    },
    async clear() {
      try {
        await (await box).plugin.clear()
      } catch {
        /* ignore */
      }
    },
    async notify(version) {
      try {
        const res = await (await box).plugin.notify({ version })
        return res?.posted === true
      } catch {
        return false
      }
    },
    onTapped(listener) {
      listeners.add(listener)
      ensureSubscribed()
      // A tap that arrived before anyone listened (cold start) is replayed once.
      for (const v of pending.splice(0)) {
        try {
          listener(v)
        } catch {
          /* ignore */
        }
      }
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
