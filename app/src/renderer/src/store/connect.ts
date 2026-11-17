import { create, type StoreApi, type UseBoundStore } from 'zustand'
import {
  CONNECT_MAX_TRACK_IDS,
  CONNECT_UP_NEXT,
  type ConnectCommandKind,
  type ConnectContext,
  type ConnectEvent,
  type ConnectPlaybackState,
  type ConnectSession,
  type Track
} from '../api/types'
import type { PlayerState } from './player'
import * as Q from '../player/queue'
import { compactResolved } from '../player/resolveTracks'
import { throttle } from '../lib/throttle'
import { sessionDisplayName } from '../lib/deviceName'

/** Minimal API surface the Connect store needs (keeps tests independent of ApiClient). */
export interface ConnectApi {
  connectRegister(name: string, platform: string, controllable: boolean): Promise<ConnectSession>
  connectSessions(signal?: AbortSignal): Promise<{ sessions: ConnectSession[] }>
  connectUnregister(id: string): Promise<void>
  connectPutState(id: string, state: ConnectPlaybackState): Promise<void>
  connectHeartbeat(id: string): Promise<void>
  connectCommand(id: string, kind: ConnectCommandKind, payload?: Record<string, unknown>): Promise<void>
  connectEventsUrl(id: string): Promise<string>
  connectRename?(id: string, name: string): Promise<void>
}

export interface ConnectDeps {
  api: ConnectApi
  player: Pick<StoreApi<PlayerState>, 'getState' | 'subscribe'>
  deviceName: string
  platform: string
  /** Turns track ids from a remote command back into tracks (aligned, null = not found). */
  resolveTracks?: (ids: string[], context: ConnectContext | null, known: Track[]) => Promise<(Track | null)[]>
  /** User-facing notices (e.g. "Lost connection to PC"). */
  notify?: (message: string, tone?: 'info' | 'error') => void
  /** Injectable for tests; defaults to the global EventSource. */
  makeEventSource?: (url: string) => EventSource
  now?: () => number
  /** setVolume throttle while dragging (ms). */
  volumeThrottleMs?: number
}

/** The session this device is controlling, with the local time its position was last known. */
export interface RemoteView {
  id: string
  name: string
  platform: string
  state: ConnectPlaybackState
  /** Local clock (ms) at which `state.position` was true. */
  at: number
}

export interface ConnectStoreState {
  /** The server advertises /v1/connect and we are signed in. */
  active: boolean
  /** This device's own session id, once registered. */
  selfId: string | null
  /** This device's session name. */
  selfName: string
  /** Other sessions of the same user (for the devices panel). */
  sessions: ConnectSession[]
  /** Session id currently being remote-controlled from here, or null for local. */
  controlling: string | null
  /** Live view of the controlled session (null when playing locally). */
  remote: RemoteView | null
  /** True while the devices panel is open (drives polling). */
  panelOpen: boolean

  start(): Promise<void>
  stop(): Promise<void>
  refresh(): Promise<void>
  openPanel(): void
  closePanel(): void
  command(sessionId: string, kind: ConnectCommandKind, payload?: Record<string, unknown>): Promise<void>
  /** Bring playback from a remote session to this device (plays the remote's current
   *  track and up-next locally from its position, then pauses the remote). */
  playHereFrom(sessionId: string): Promise<void>
  /** Start controlling `sessionId`: local playback pauses, play actions go to that device. */
  control(sessionId: string): void
  /** Stop controlling and go back to local playback. */
  release(): void
  /** Sends a command to the controlled session, optimistically applying `patch` to `remote.state`. */
  remoteCommand(kind: ConnectCommandKind, payload?: Record<string, unknown>, patch?: ConnectPlaybackState): Promise<void>
  /** Sets the controlled session's volume (throttled while dragging; the UI updates at once). */
  setRemoteVolume(volume: number): void
  /** Mutes / unmutes the controlled session. */
  setRemoteMuted(muted: boolean): void
  /** Interpolated playback position of the controlled session. */
  remotePosition(): number
  /** Renames this device's session. */
  rename(name: string): Promise<void>
}

const STATE_PUSH_INTERVAL_MS = 20_000 // heartbeat + position sync while active
const PANEL_POLL_MS = 3_000
const CONTROL_POLL_MS = 2_500
const STREAM_REFRESH_MS = 10 * 60_000 // re-open SSE before the 15-min access token expires
/** After an optimistic change, polled (possibly stale) state is ignored this long. */
const OPTIMISTIC_HOLD_MS = 2_000
/** Consecutive refreshes the controlled session may be missing/offline before we let go. */
const MAX_MISSES = 2

const ACTIVE = new Set(['playing', 'buffering', 'loading'])

/** Position of a remote playback at local time `now`, extrapolated while it is playing. */
export function interpolatePosition(state: ConnectPlaybackState, at: number, now: number): number {
  const pos = Math.max(0, state.position ?? 0)
  const dur = state.duration ?? 0
  if (state.status !== 'playing') return dur > 0 ? Math.min(pos, dur) : pos
  const p = pos + Math.max(0, now - at) / 1000
  return dur > 0 ? Math.min(p, dur) : p
}

function sameMoment(a: ConnectPlaybackState, b: ConnectPlaybackState): boolean {
  return a.status === b.status && (a.track?.id ?? '') === (b.track?.id ?? '') && Math.round(a.position ?? 0) === Math.round(b.position ?? 0)
}

function snapshot(player: ConnectDeps['player'], now: number): ConnectPlaybackState {
  const s = player.getState()
  const item = Q.currentItem(s.queue)
  const ctx = s.queue.context
  return {
    status: s.status,
    track: item?.track ?? null,
    position: Math.round(s.position),
    duration: Math.round(s.duration),
    shuffle: s.queue.shuffle,
    repeat: s.queue.repeat,
    volume: s.volume,
    muted: s.muted,
    queueLength: s.queue.items.length,
    context: ctx ? { type: ctx.type, id: ctx.id, name: ctx.name } : null,
    upNext: Q.contextUpcoming(s.queue).slice(0, CONNECT_UP_NEXT).map((i) => i.track.id),
    userQueue: Q.userUpcoming(s.queue).slice(0, CONNECT_UP_NEXT).map((i) => i.track.id),
    updatedAt: now
  }
}

/** Fields whose change triggers an immediate push (position handled separately). */
function stateKey(s: ConnectPlaybackState): string {
  return `${s.status}|${s.track?.id ?? ''}|${s.shuffle ? 1 : 0}|${s.repeat}|${s.volume}|${s.muted ? 1 : 0}|${s.queueLength}|${s.context?.type ?? ''}:${s.context?.id ?? ''}|${s.upNext?.[0] ?? ''}|${(s.userQueue ?? []).join(',')}`
}

function idList(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > CONNECT_MAX_TRACK_IDS) return null
  if (!v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 128)) return null
  return v as string[]
}

const CONTEXT_TYPES = new Set(['album', 'playlist', 'artist', 'search', 'library', 'home', 'tracks'])
function contextOf(v: unknown): ConnectContext | null {
  if (!v || typeof v !== 'object') return null
  const c = v as Record<string, unknown>
  if (typeof c.type !== 'string' || !CONTEXT_TYPES.has(c.type)) return null
  return {
    type: c.type as ConnectContext['type'],
    id: typeof c.id === 'string' ? c.id : undefined,
    name: typeof c.name === 'string' ? c.name : undefined
  }
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
  let holdUntil = 0
  let misses = 0
  let playSeq = 0

  async function resolve(ids: string[], context: ConnectContext | null): Promise<(Track | null)[]> {
    const known = deps.player.getState().queue.items.map((i) => i.track)
    if (deps.resolveTracks) return deps.resolveTracks(ids, context, known)
    const byId = new Map(known.map((t) => [t.id, t]))
    return ids.map((id) => byId.get(id) ?? null)
  }

  async function executeCommand(kind: ConnectCommandKind, payload: Record<string, unknown>): Promise<void> {
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
      case 'setVolume': {
        if (typeof payload.volume === 'number') p.setVolume(payload.volume)
        if (typeof payload.muted === 'boolean' && payload.muted !== deps.player.getState().muted) deps.player.getState().toggleMute()
        break
      }
      case 'playContext': {
        const ids = idList(payload.trackIds)
        if (!ids) return
        const seq = ++playSeq
        const context = contextOf(payload.context)
        const start = typeof payload.startIndex === 'number' && Number.isInteger(payload.startIndex) ? Math.min(Math.max(0, payload.startIndex), ids.length - 1) : 0
        const resolved = await resolve(ids, context)
        if (seq !== playSeq) return // superseded by a newer playContext
        const { tracks, startIndex } = compactResolved(resolved, start)
        if (tracks.length === 0) return
        // Being controlled from elsewhere takes priority over controlling another device.
        if (store.getState().controlling) store.getState().release()
        await deps.player.getState().playTracks(tracks, startIndex, context, typeof payload.shuffle === 'boolean' ? { shuffle: payload.shuffle } : {})
        break
      }
      case 'addToQueue':
      case 'playNext': {
        const ids = idList(payload.trackIds)
        if (!ids) return
        const tracks = (await resolve(ids, null)).filter((t): t is Track => t !== null)
        if (tracks.length === 0) return
        if (kind === 'addToQueue') deps.player.getState().addToQueue(tracks)
        else deps.player.getState().addNext(tracks)
        break
      }
      case 'transferTo': break // controller-side only
    }
    // Reflect the change back to the server promptly so controllers see it.
    void pushState(true)
  }

  async function pushState(force = false): Promise<void> {
    const id = store.getState().selfId
    if (!id) return
    const snap = snapshot(deps.player, now())
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

  /** Applies a fresh state for `sessionId` to the sessions list and, if controlled, the remote view. */
  function applyState(sessionId: string, state: ConnectPlaybackState, authoritative: boolean): void {
    const s = store.getState()
    const sessions = s.sessions.map((x) => (x.id === sessionId ? { ...x, state } : x))
    const patch: Partial<ConnectStoreState> = { sessions }
    if (s.remote && s.remote.id === sessionId && (authoritative || now() >= holdUntil)) {
      const at = sameMoment(s.remote.state, state) && !authoritative ? s.remote.at : now()
      patch.remote = { ...s.remote, state, at }
    }
    store.setState(patch)
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
        if (event.type === 'command') void executeCommand(event.kind, event.payload ?? {})
        else if (event.type === 'closed') void reregister()
        else if (event.type === 'state' && event.sessionId && event.sessionId !== store.getState().selfId) {
          applyState(event.sessionId, event.state ?? {}, true)
        }
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
      const s = await deps.api.connectRegister(store.getState().selfName, deps.platform, true)
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

  /** Polls the sessions list while the panel is open or a remote is being controlled. */
  function syncPolling(): void {
    const s = store.getState()
    const want = s.panelOpen || s.controlling !== null
    if (want && !pollTimer) {
      pollTimer = setInterval(() => void store.getState().refresh(), s.controlling ? CONTROL_POLL_MS : PANEL_POLL_MS)
    } else if (!want && pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  function remoteName(sessionId: string): string {
    const s = store.getState().sessions.find((x) => x.id === sessionId)
    return s ? sessionDisplayName(s) : 'the other device'
  }

  const sendVolume = throttle((id: string, volume: number) => {
    void deps.api.connectCommand(id, 'setVolume', { volume }).catch(() => undefined)
  }, deps.volumeThrottleMs ?? 100)

  const store = create<ConnectStoreState>((set, get) => ({
    active: false,
    selfId: null,
    selfName: deps.deviceName,
    sessions: [],
    controlling: null,
    remote: null,
    panelOpen: false,

    async start() {
      if (!stopped) return
      stopped = false
      set({ active: true })
      await registerSelf()
      // Push state on relevant player changes; local playback starting ends remote control.
      unsubPlayer = deps.player.subscribe((st, prev) => {
        void pushState(false)
        if (get().controlling && st && prev && st.status === 'playing' && prev.status !== 'playing') get().release()
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
      sendVolume.cancel()
      closeStream()
      set({ active: false, selfId: null, sessions: [], controlling: null, remote: null, panelOpen: false })
      if (id) await deps.api.connectUnregister(id).catch(() => undefined)
    },

    async refresh() {
      const id = get().selfId
      let sessions: ConnectSession[]
      try {
        sessions = (await deps.api.connectSessions()).sessions.filter((s) => s.id !== id)
      } catch {
        return // keep previous list
      }
      set({ sessions })
      const ctl = get().controlling
      if (!ctl) return
      const target = sessions.find((s) => s.id === ctl)
      if (!target || !target.online) {
        misses += 1
        if (misses >= MAX_MISSES) {
          const name = get().remote?.name ?? 'the other device'
          get().release()
          deps.notify?.(`Lost connection to ${name}. Playing on this device.`, 'info')
        }
        return
      }
      misses = 0
      const r = get().remote
      if (r) set({ remote: { ...r, name: sessionDisplayName(target) } })
      applyState(ctl, target.state ?? {}, false)
    },

    openPanel() {
      if (get().panelOpen) return
      set({ panelOpen: true })
      void get().refresh()
      syncPolling()
    },

    closePanel() {
      set({ panelOpen: false })
      syncPolling()
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
      const live = get().remote?.id === sessionId ? get().remote : null
      const pos = live ? interpolatePosition(live.state, live.at, now()) : remote.state.position ?? 0
      const wasPlaying = ACTIVE.has(remote.state.status ?? '')
      if (get().controlling) get().release()
      // Pause the remote first so audio never plays on both.
      await deps.api.connectCommand(sessionId, 'pause').catch(() => undefined)
      let tracks: Track[] = [track]
      let queued: Track[] = []
      const upNext = (remote.state.upNext ?? []).slice(0, CONNECT_UP_NEXT)
      const userQueue = (remote.state.userQueue ?? []).slice(0, CONNECT_UP_NEXT)
      if (upNext.length + userQueue.length > 0) {
        try {
          const all = await resolve([...userQueue, ...upNext], remote.state.context ?? null)
          queued = all.slice(0, userQueue.length).filter((t): t is Track => t !== null)
          tracks = [track, ...all.slice(userQueue.length).filter((t): t is Track => t !== null)]
        } catch {
          /* just the current track */
        }
      }
      const ctx = remote.state.context ?? { type: 'tracks' as const, name: `From ${sessionDisplayName(remote)}` }
      const p = deps.player.getState()
      if (remote.state.repeat && remote.state.repeat !== p.queue.repeat) p.setRepeat(remote.state.repeat)
      await p.playTracks(tracks, 0, ctx, { shuffle: false })
      // The remote's user queue stays a user queue here ("Next in queue").
      if (queued.length > 0) deps.player.getState().addToQueue(queued)
      deps.player.getState().seek(pos)
      if (!wasPlaying) deps.player.getState().pause()
    },

    control(sessionId) {
      const target = get().sessions.find((s) => s.id === sessionId)
      if (!target || sessionId === get().selfId) return
      const p = deps.player.getState()
      if (ACTIVE.has(p.status)) p.pause()
      misses = 0
      holdUntil = 0
      set({
        controlling: sessionId,
        remote: { id: sessionId, name: sessionDisplayName(target), platform: target.platform, state: target.state ?? {}, at: now() }
      })
      // Re-arm polling at the faster control interval.
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
      syncPolling()
      void get().refresh()
    },

    release() {
      sendVolume.flush()
      set({ controlling: null, remote: null })
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
      syncPolling()
    },

    async remoteCommand(kind, payload, patch) {
      const id = get().controlling
      if (!id) return
      if (patch) {
        const r = get().remote
        if (r) {
          const state = { ...r.state, ...patch }
          const moved = patch.position !== undefined || patch.status !== undefined || patch.track !== undefined
          const at = moved ? now() : r.at
          // Keep the interpolated position when only the status changes (e.g. pause).
          if (patch.status !== undefined && patch.position === undefined) state.position = interpolatePosition(r.state, r.at, now())
          set({ remote: { ...r, state, at } })
          holdUntil = now() + OPTIMISTIC_HOLD_MS
        }
      }
      try {
        await deps.api.connectCommand(id, kind, payload)
      } catch (err) {
        const status = (err as { status?: number }).status
        if (status === 404 || status === 409) {
          const name = remoteName(id)
          get().release()
          deps.notify?.(`${name} is no longer available. Playing on this device.`, 'error')
        } else {
          deps.notify?.(`Couldn't reach ${remoteName(id)}.`, 'error')
        }
      }
    },

    setRemoteVolume(volume) {
      const id = get().controlling
      const r = get().remote
      if (!id || !r) return
      const v = Math.min(1, Math.max(0, volume))
      set({ remote: { ...r, state: { ...r.state, volume: v, muted: v === 0 ? r.state.muted : false } } })
      holdUntil = now() + OPTIMISTIC_HOLD_MS
      sendVolume(id, v)
    },

    setRemoteMuted(muted) {
      void get().remoteCommand('setVolume', { muted }, { muted })
    },

    remotePosition() {
      const r = get().remote
      return r ? interpolatePosition(r.state, r.at, now()) : 0
    },

    async rename(name) {
      const clean = name.trim().slice(0, 80)
      if (!clean || clean === get().selfName) return
      set({ selfName: clean })
      const id = get().selfId
      if (id && deps.api.connectRename) await deps.api.connectRename(id, clean).catch(() => undefined)
    }
  }))

  return store
}
