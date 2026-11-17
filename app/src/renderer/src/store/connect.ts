import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type {
  ConnectCommandKind,
  ConnectEvent,
  ConnectPlaybackState,
  ConnectSession
} from '../api/types'
import type { PlayerState } from './player'
import * as Q from '../player/queue'

/** Minimal API surface the Connect store needs (keeps tests independent of ApiClient). */
export interface ConnectApi {
  connectRegister(name: string, platform: string, controllable: boolean): Promise<ConnectSession>
  connectSessions(signal?: AbortSignal): Promise<{ sessions: ConnectSession[] }>
  connectUnregister(id: string): Promise<void>
  connectPutState(id: string, state: ConnectPlaybackState): Promise<void>
  connectHeartbeat(id: string): Promise<void>
  connectCommand(id: string, kind: ConnectCommandKind, payload?: Record<string, unknown>): Promise<void>
  connectEventsUrl(id: string): Promise<string>
}

export interface ConnectDeps {
  api: ConnectApi
  player: Pick<StoreApi<PlayerState>, 'getState' | 'subscribe'>
  deviceName: string
  platform: string
  /** Injectable for tests; defaults to the global EventSource. */
  makeEventSource?: (url: string) => EventSource
  now?: () => number
}

export interface ConnectStoreState {
  /** The server advertises /v1/connect and we are signed in. */
  active: boolean
  /** This device's own session id, once registered. */
  selfId: string | null
  /** Other sessions of the same user (for the devices panel). */
  sessions: ConnectSession[]
  /** Session id currently being remote-controlled from here, or null for local. */
  controlling: string | null
  /** True while the devices panel is open (drives polling). */
  panelOpen: boolean

  start(): Promise<void>
  stop(): Promise<void>
  refresh(): Promise<void>
  openPanel(): void
  closePanel(): void
  command(sessionId: string, kind: ConnectCommandKind, payload?: Record<string, unknown>): Promise<void>
  /** Bring playback from a remote session to this device (plays the remote's current
   *  track locally from its position, then pauses the remote). */
  playHereFrom(sessionId: string): Promise<void>
}

const STATE_PUSH_INTERVAL_MS = 20_000 // heartbeat + position sync while active
const PANEL_POLL_MS = 3_000
const STREAM_REFRESH_MS = 10 * 60_000 // re-open SSE before the 15-min access token expires

function snapshot(player: ConnectDeps['player']): ConnectPlaybackState {
  const s = player.getState()
  const item = Q.currentItem(s.queue)
  return {
    status: s.status,
    track: item?.track ?? null,
    position: Math.round(s.position),
    duration: Math.round(s.duration),
    shuffle: s.queue.shuffle,
    repeat: s.queue.repeat,
    volume: s.volume,
    muted: s.muted,
    queueLength: s.queue.items.length
  }
}

/** Fields whose change triggers an immediate push (position handled separately). */
function stateKey(s: ConnectPlaybackState): string {
  return `${s.status}|${s.track?.id ?? ''}|${s.shuffle ? 1 : 0}|${s.repeat}|${s.volume}|${s.muted ? 1 : 0}|${s.queueLength}`
}

export function createConnectStore(deps: ConnectDeps): UseBoundStore<StoreApi<ConnectStoreState>> {
  const now = deps.now ?? Date.now
  const makeES = deps.makeEventSource ?? ((url: string) => new EventSource(url))

  let es: EventSource | null = null
  let unsubPlayer: (() => void) | null = null
  let pushTimer: ReturnType<typeof setInterval> | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let streamTimer: ReturnType<typeof setInterval> | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let lastKey = ''
  let stopped = true

  function executeCommand(kind: ConnectCommandKind, payload: Record<string, unknown>): void {
    const p = deps.player.getState()
    switch (kind) {
      case 'play': p.play(); break
      case 'pause': p.pause(); break
      case 'toggle': p.toggle(); break
      case 'next': void p.next(); break
      case 'previous': void p.previous(); break
      case 'stop': p.stop(); break
      case 'seek': if (typeof payload.position === 'number') p.seek(payload.position); break
      case 'setShuffle': p.setShuffle(Boolean(payload.on)); break
      case 'setRepeat': {
        const m = payload.mode
        if (m === 'off' || m === 'all' || m === 'one') p.setRepeat(m)
        break
      }
      case 'setVolume': if (typeof payload.volume === 'number') p.setVolume(payload.volume); break
      case 'transferTo': break // controller-side only
    }
    // Reflect the change back to the server promptly so controllers see it.
    void pushState(true)
  }

  async function pushState(force = false): Promise<void> {
    const id = store.getState().selfId
    if (!id) return
    const snap = snapshot(deps.player)
    const key = stateKey(snap)
    if (!force && key === lastKey) {
      // No meaningful change; still beat the heartbeat occasionally via the interval.
      return
    }
    lastKey = key
    try {
      await deps.api.connectPutState(id, snap)
    } catch {
      /* best effort */
    }
  }

  async function openStream(id: string): Promise<void> {
    if (stopped) return
    try {
      const url = await deps.api.connectEventsUrl(id)
      if (stopped) return
      const source = makeES(url)
      es = source
      source.onmessage = (e: MessageEvent): void => {
        let event: ConnectEvent
        try {
          event = JSON.parse(e.data as string) as ConnectEvent
        } catch {
          return
        }
        if (event.type === 'command') executeCommand(event.kind, event.payload)
        else if (event.type === 'closed') void reregister()
      }
      source.onerror = (): void => {
        // CONNECTING(0) means the browser is already retrying; only act when fully closed.
        if (source.readyState === 2 /* CLOSED */) {
          source.close()
          if (es === source) es = null
          scheduleReconnect(id)
        }
      }
    } catch {
      scheduleReconnect(id)
    }
  }

  function scheduleReconnect(id: string): void {
    if (stopped || reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (!stopped && store.getState().selfId === id) void openStream(id)
    }, 3_000)
  }

  async function reregister(): Promise<void> {
    // Our session was pruned/closed server-side; register a fresh one.
    if (stopped) return
    closeStream()
    store.setState({ selfId: null })
    await registerSelf()
  }

  function closeStream(): void {
    if (es) {
      es.close()
      es = null
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  async function registerSelf(): Promise<void> {
    try {
      const s = await deps.api.connectRegister(deps.deviceName, deps.platform, true)
      if (stopped) {
        void deps.api.connectUnregister(s.id).catch(() => undefined)
        return
      }
      store.setState({ selfId: s.id })
      lastKey = ''
      await pushState(true)
      await openStream(s.id)
    } catch {
      /* will retry on next start/visibility */
    }
  }

  const store = create<ConnectStoreState>((set, get) => ({
    active: false,
    selfId: null,
    sessions: [],
    controlling: null,
    panelOpen: false,

    async start() {
      if (!stopped) return
      stopped = false
      set({ active: true })
      await registerSelf()
      // Push state on relevant player changes.
      unsubPlayer = deps.player.subscribe(() => {
        void pushState(false)
      })
      // Heartbeat + position sync.
      pushTimer = setInterval(() => void pushState(true), STATE_PUSH_INTERVAL_MS)
      // Refresh the SSE stream before the access token in its URL expires.
      streamTimer = setInterval(() => {
        const id = get().selfId
        if (id) {
          closeStream()
          void openStream(id)
        }
      }, STREAM_REFRESH_MS)
    },

    async stop() {
      stopped = true
      const id = get().selfId
      if (unsubPlayer) { unsubPlayer(); unsubPlayer = null }
      if (pushTimer) { clearInterval(pushTimer); pushTimer = null }
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
      if (streamTimer) { clearInterval(streamTimer); streamTimer = null }
      closeStream()
      set({ active: false, selfId: null, sessions: [], controlling: null, panelOpen: false })
      if (id) await deps.api.connectUnregister(id).catch(() => undefined)
    },

    async refresh() {
      const id = get().selfId
      try {
        const { sessions } = await deps.api.connectSessions()
        // Exclude our own session from the devices list.
        set({ sessions: sessions.filter((s) => s.id !== id) })
      } catch {
        /* keep previous list */
      }
    },

    openPanel() {
      if (get().panelOpen) return
      set({ panelOpen: true })
      void get().refresh()
      pollTimer = setInterval(() => void get().refresh(), PANEL_POLL_MS)
    },

    closePanel() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
      set({ panelOpen: false })
    },

    async command(sessionId, kind, payload) {
      await deps.api.connectCommand(sessionId, kind, payload)
      // Refresh soon so the panel reflects the result.
      setTimeout(() => void get().refresh(), 500)
    },

    async playHereFrom(sessionId) {
      const remote = get().sessions.find((s) => s.id === sessionId)
      const track = remote?.state.track
      if (!remote || !track) return
      const pos = remote.state.position ?? 0
      // Play the remote's current track locally, then pause the remote.
      await deps.player.getState().playTracks([track], 0, { type: 'tracks', name: `From ${remote.name}` })
      deps.player.getState().seek(pos)
      await deps.api.connectCommand(sessionId, 'pause').catch(() => undefined)
      set({ controlling: null })
    }
  }))

  return store
}
