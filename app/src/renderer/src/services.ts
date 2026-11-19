/** App-wide singletons wired together. */
import { platform } from './platform'
import { createSessionStore } from './store/session'
import { createPlayerStore } from './store/player'
import { createConnectStore } from './store/connect'
import { bindRemoteControl } from './platform/remoteControl'
import { AudioEngine } from './player/engine'
import { NativeEngine } from './player/nativeEngine'
import { useLikes } from './store/likes'
import type { StoredSession } from './api/client'
import { LrclibClient } from './lyrics/lrclib'
import { useSettings } from './store/settings'
import { createEqStore } from './store/eq'
import { useUi } from './store/ui'
import { defaultDeviceName } from './lib/deviceName'
import { resolveTracks } from './player/resolveTracks'
import { createPlayback } from './player/playback'
import { createPlayQueue } from './lib/playQueue'
import { createSleepTimer } from './store/sleepTimer'
import { createListenBrainzStore } from './store/listenbrainz'
import { currentItem } from './player/queue'
import { appThemePayload, sameAppTheme, type AppThemePayload } from './lib/widgetTheme'
import { loadSavedSession, storeSavedSession } from './lib/playerSession'

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

/** Android: the engine facade whose `currentTime` is interpolated between the service's position reports. */
export function getNativeClock(): { currentTime: number } | null {
  return nativeEngine
}

/** Durable queue of play reports: a play is not lost when the app is killed or offline. */
export const playQueue = createPlayQueue({
  owner: () => useSession.getState().session?.user.id ?? '',
  send: (p) => api.reportPlayed(p.trackId, p.seconds, { playId: p.playId, at: p.at })
})

function scrobbleOff(): boolean {
  return useSession.getState().server?.capabilities?.scrobble === false
}

/**
 * Equalizer: per-user state kept on the server and cached locally. It is applied to the Web Audio graph
 * (web, desktop, iOS) or sent to the Android Media3 service, which also persists it for when the app is closed.
 */
export const useEq = createEqStore({
  api,
  apply: (state) => {
    if (platform.nativePlayer) platform.nativePlayer.setEq({ enabled: state.enabled, preamp: state.preamp, gains: state.gains })
    else engineRef?.setEq(state)
  }
})
useSession.subscribe((s, prev) => {
  if (s.status === 'signedIn' && prev.status !== 'signedIn') void useEq.getState().load()
  if (s.status === 'signedOut' && prev.status === 'signedIn') useEq.getState().reset()
})
if (platform.nativePlayer) {
  const st = useEq.getState().snapshot()
  platform.nativePlayer.setEq({ enabled: st.enabled, preamp: st.preamp, gains: st.gains })
}

/** Android: the Media3 service plays (and reports plays); null elsewhere, where <audio> does. */
const nativePlayer = platform.nativePlayer ?? null
let nativeEngine: NativeEngine | null = null

export const usePlayer = createPlayerStore({
  native: nativePlayer ?? undefined,
  onNativeTime: (position, duration) => nativeEngine?.mirror(position, duration),
  onNativePlaying: (playing) => nativeEngine?.setPlaying(playing),
  createEngine: (events) => {
    if (nativePlayer) return (nativeEngine = new NativeEngine(nativePlayer))
    engineRef = new AudioEngine(events)
    engineRef.setEq(useEq.getState().snapshot())
    return engineRef
  },
  resolveStream: (trackId) => api.stream(trackId),
  reportPlayed: (trackId, seconds, meta) => {
    if (scrobbleOff()) return
    if (!meta) {
      void api.reportPlayed(trackId, seconds).catch(() => undefined)
      return
    }
    playQueue.complete({ trackId, seconds: Math.round(seconds), ...meta })
    void playQueue.flush().catch(() => undefined)
  },
  persistListen: (listen) => {
    if (!scrobbleOff()) playQueue.save(listen)
  },
  dropListen: (playId) => playQueue.drop(playId),
  getCrossfade: () => useSettings.getState().crossfade,
  getAutoplay: () => useSettings.getState().autoplay,
  fetchAutoplay: async (seedId, exclude) => (useSession.getState().server?.capabilities?.radio === false ? [] : api.radio(seedId, exclude, 20)),
  loadSession: loadSavedSession,
  saveSession: storeSavedSession,
  initialVolume: useSettings.getState().volume,
  initialMuted: useSettings.getState().muted,
  onVolumeChange: (volume, muted) => useSettings.getState().update({ volume, muted }),
  onError: (message) => useUi.getState().toast(message, 'error')
})

/** Sleep timer (fullscreen player menu): fades out and pauses; see store/sleepTimer.ts. */
export const useSleepTimer = createSleepTimer({
  player: usePlayer,
  setOutputVolume: (v) => (nativePlayer ? nativePlayer.setVolume(v) : engineRef?.setVolume(v))
})
// A WebView may throttle timers in the background: re-check the wall-clock deadline when we come back.
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => useSleepTimer.getState().tick())
}
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('focus', () => useSleepTimer.getState().tick())
  window.addEventListener('pageshow', () => useSleepTimer.getState().tick())
}

export const useListenBrainz = createListenBrainzStore(api)

// Optional ListenBrainz "now playing": the server only sends it when the user turned it on.
let nowPlayingUid = ''
usePlayer.subscribe((s) => {
  const it = currentItem(s.queue)
  const uid = s.status === 'playing' && it ? it.uid : ''
  if (uid === nowPlayingUid) return
  nowPlayingUid = uid
  const st = useListenBrainz.getState().status
  if (uid && it && st?.connected && st.enabled && st.nowPlaying) void api.listenBrainzNowPlaying(it.track.id).catch(() => undefined)
})
useSession.subscribe((s, prev) => {
  const on = (x: typeof s): boolean => x.status === 'signedIn' && x.server?.capabilities?.listenbrainz === true
  if (on(s) && !on(prev)) void useListenBrainz.getState().load()
  if (s.status !== 'signedIn' && prev.status === 'signedIn') useListenBrainz.getState().reset()
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

// Send plays left over from a previous run (app killed, offline) once signed in, and whenever we are back online.
function flushPlays(): void {
  if (!scrobbleOff()) void playQueue.flush().catch(() => undefined)
}
useSession.subscribe((s, prev) => {
  if (s.status === 'signedIn' && prev.status !== 'signedIn') flushPlays()
})
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('online', flushPlays)
}
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') flushPlays()
  })
}

// ---- Android native player (Media3 service, also the Android Auto backend) --------------------------

if (nativePlayer) {
  // Hand the session to native secure storage so the service can browse and stream with no WebView
  // (Android Auto cold start, phone locked). Tokens are never logged.
  const pushAuth = (session: StoredSession | null): void => {
    nativePlayer.setAuth(
      session
        ? { serverUrl: session.serverUrl, accessToken: session.accessToken, refreshToken: session.refreshToken, expiresAt: session.expiresAt, userId: session.user.id }
        : null
    )
  }
  useSession.subscribe((s, prev) => {
    if (s.session !== prev.session) pushAuth(s.session)
  })
  pushAuth(useSession.getState().session)

  // The service refreshed the (rotating) refresh token while the WebView slept: adopt it.
  const adoptNativeAuth = (n: { serverUrl: string; accessToken: string; refreshToken: string; expiresAt: number }): void => {
    const cur = useSession.getState().session
    if (!cur || cur.serverUrl !== n.serverUrl || n.expiresAt <= cur.expiresAt) return
    useSession.getState().setSession({ ...cur, accessToken: n.accessToken, refreshToken: n.refreshToken, expiresAt: n.expiresAt })
  }
  nativePlayer.on((e) => {
    if (e.type === 'auth') adoptNativeAuth(e.session)
    else if (e.type === 'liked') {
      useLikes.setState((st) => ({ overrides: { ...st.overrides, [e.trackId]: e.liked } }))
    }
  })
  const syncAuthFromNative = (): void => {
    void nativePlayer.getAuth().then((n) => n && adoptNativeAuth(n))
  }
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') syncAuthFromNative()
    })
  }
  syncAuthFromNative()

  // Theme + accent for the home-screen widgets' "Like the app" colours (stored natively, works with the app closed).
  let sentTheme: AppThemePayload | null = null
  const pushTheme = (): void => {
    const { theme, accent } = useSettings.getState()
    const next = appThemePayload(theme, accent)
    if (sameAppTheme(sentTheme, next)) return
    sentTheme = next
    nativePlayer.setAppTheme(next)
  }
  pushTheme()
  useSettings.subscribe((s, prev) => {
    if (s.theme !== prev.theme || s.accent !== prev.accent) pushTheme()
  })

  // Controlling another Connect device: hardware volume keys + notification mirror it (see remoteControl.ts).
  bindRemoteControl(nativePlayer, useConnect, playback)

  // "Show current lyric line in the car" (off by default).
  nativePlayer.setLyricsInCar(useSettings.getState().lyricsInCar)
  useSettings.subscribe((s, prev) => {
    if (s.lyricsInCar !== prev.lyricsInCar) nativePlayer.setLyricsInCar(s.lyricsInCar)
  })
}
