/** App-wide singletons wired together. */
import { platform } from './platform'
import { createSessionStore } from './store/session'
import { createPlayerStore } from './store/player'
import { createConnectStore } from './store/connect'
import { AudioEngine } from './player/engine'
import { LrclibClient } from './lyrics/lrclib'
import { useSettings } from './store/settings'
import { useUi } from './store/ui'
import { defaultDeviceName } from './lib/deviceName'
import { resolveTracks } from './player/resolveTracks'
import { createPlayback } from './player/playback'

export { platform }

/** A human label for this device, used as the Connect session name. */
export function autoDeviceName(): string {
  return defaultDeviceName(platform.kind, typeof navigator !== 'undefined' ? navigator.userAgent : '')
}

function deviceName(): string {
  return useSettings.getState().deviceName || autoDeviceName()
}

export const { useSession, api } = createSessionStore({
  secure: platform.secure,
  cookieSession: Boolean(platform.hostedOrigin),
  hostedOrigin: platform.hostedOrigin,
  defaultServer: import.meta.env.VITE_DEFAULT_SERVER ?? ''
})

export const lrclib = new LrclibClient()

let engineRef: AudioEngine | null = null
export function getEngine(): AudioEngine | null {
  return engineRef
}

export const usePlayer = createPlayerStore({
  createEngine: (events) => (engineRef = new AudioEngine(events)),
  resolveStream: (trackId) => api.stream(trackId),
  reportPlayed: (trackId, seconds) => {
    if (useSession.getState().server?.capabilities?.scrobble === false) return
    void api.reportPlayed(trackId, seconds).catch(() => undefined)
  },
  getCrossfade: () => useSettings.getState().crossfade,
  initialVolume: useSettings.getState().volume,
  initialMuted: useSettings.getState().muted,
  onVolumeChange: (volume, muted) => useSettings.getState().update({ volume, muted }),
  onError: (message) => useUi.getState().toast(message, 'error')
})

export const useConnect = createConnectStore({
  api,
  player: usePlayer,
  deviceName: deviceName(),
  platform: platform.kind,
  resolveTracks: (ids, context, known) => resolveTracks(ids, api, { context, known }),
  notify: (message, tone) => useUi.getState().toast(message, tone)
})

/** Routes play / transport actions to the local player or the controlled Connect device. */
export const playback = createPlayback({ player: usePlayer, connect: useConnect })

// Renaming this device in the devices panel updates the live session too.
useSettings.subscribe((s, prev) => {
  if (s.deviceName !== prev.deviceName) void useConnect.getState().rename(s.deviceName || autoDeviceName())
})

// Signing out stops playback and forgets the queue.
useSession.subscribe((s, prev) => {
  if (prev.status === 'signedIn' && s.status === 'signedOut') usePlayer.getState().stop()
})

// Start/stop Connect with the session, but only when the server supports it.
function syncConnect(status: string, connectCapable: boolean): void {
  if (status === 'signedIn' && connectCapable) void useConnect.getState().start()
  else void useConnect.getState().stop()
}
useSession.subscribe((s, prev) => {
  const capable = s.server?.capabilities?.connect === true
  const prevCapable = prev.server?.capabilities?.connect === true
  if (s.status !== prev.status || capable !== prevCapable) syncConnect(s.status, capable)
})
