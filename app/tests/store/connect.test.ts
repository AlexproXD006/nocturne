import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConnectStore, type ConnectApi } from '@/store/connect'
import { createQueue, emptyQueue, type QueueState } from '@/player/queue'
import type { ConnectSession } from '@/api/types'
import { track } from '../helpers/fixtures'

class FakeEventSource {
  static instances: FakeEventSource[] = []
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  readyState = 1
  constructor(public url: string) { FakeEventSource.instances.push(this) }
  close(): void { this.readyState = 2 }
  emit(data: unknown): void { this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent) }
}

function fakePlayer(initial?: Partial<QueueState>) {
  const calls: string[] = []
  const subs = new Set<(...a: never[]) => void>()
  const state = {
    status: 'playing' as const,
    position: 12,
    duration: 100,
    volume: 0.8,
    muted: false,
    queue: { ...createQueue([track('t1')], 0), ...initial } as QueueState,
    play: () => calls.push('play'),
    pause: () => calls.push('pause'),
    toggle: () => calls.push('toggle'),
    next: async () => { calls.push('next') },
    previous: async () => { calls.push('previous') },
    seek: (s: number) => calls.push(`seek:${s}`),
    setShuffle: (on: boolean) => calls.push(`shuffle:${on}`),
    setRepeat: (m: string) => calls.push(`repeat:${m}`),
    setVolume: (v: number) => calls.push(`volume:${v}`),
    stop: () => calls.push('stop'),
    playTracks: async () => { calls.push('playTracks') }
  }
  return {
    calls,
    getState: () => state as never,
    subscribe: (fn: (...a: never[]) => void) => { subs.add(fn); return () => { subs.delete(fn) } },
    fire: () => subs.forEach((f) => f())
  }
}

function fakeApi(sessions: ConnectSession[] = []) {
  const log: string[] = []
  const api: ConnectApi & { log: string[]; sessions: ConnectSession[] } = {
    log,
    sessions,
    async connectRegister(name, platform, controllable) {
      log.push('register')
      return { id: 'cs_self', name, platform, controllable, state: {}, online: false, lastSeenAt: '' }
    },
    async connectSessions() { log.push('sessions'); return { sessions: api.sessions } },
    async connectUnregister(id) { log.push(`unregister:${id}`) },
    async connectPutState() { log.push('putState') },
    async connectHeartbeat() { log.push('heartbeat') },
    async connectCommand(id, kind) { log.push(`command:${id}:${kind}`) },
    async connectEventsUrl() { return 'https://x/events?access_token=t' }
  }
  return api
}

function session(over: Partial<ConnectSession> = {}): ConnectSession {
  return {
    id: 'cs_pc', name: 'PC Chrome', platform: 'web', controllable: true,
    state: { status: 'playing', track: track('remote'), position: 30 },
    online: true, lastSeenAt: '2026-11-10T00:00:00Z', ...over
  }
}

beforeEach(() => { FakeEventSource.instances = [] })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('connect store', () => {
  it('registers a session and opens an SSE stream on start', async () => {
    const api = fakeApi()
    const player = fakePlayer()
    const store = createConnectStore({
      api, player, deviceName: 'My PC', platform: 'web',
      makeEventSource: (u) => new FakeEventSource(u) as unknown as EventSource
    })
    await store.getState().start()
    expect(api.log).toContain('register')
    expect(store.getState().selfId).toBe('cs_self')
    expect(FakeEventSource.instances).toHaveLength(1)
    await store.getState().stop()
    expect(api.log).toContain('unregister:cs_self')
  })

  it('executes an incoming command on the local player', async () => {
    const api = fakeApi()
    const player = fakePlayer()
    const store = createConnectStore({
      api, player, deviceName: 'My PC', platform: 'web',
      makeEventSource: (u) => new FakeEventSource(u) as unknown as EventSource
    })
    await store.getState().start()
    const es = FakeEventSource.instances[0]!
    es.emit({ type: 'command', kind: 'pause', payload: {} })
    es.emit({ type: 'command', kind: 'setShuffle', payload: { on: true } })
    es.emit({ type: 'command', kind: 'seek', payload: { position: 55 } })
    expect(player.calls).toContain('pause')
    expect(player.calls).toContain('shuffle:true')
    expect(player.calls).toContain('seek:55')
    await store.getState().stop()
  })

  it('refresh() lists other sessions, excluding our own', async () => {
    const api = fakeApi([session({ id: 'cs_self' }), session({ id: 'cs_pc' })])
    const store = createConnectStore({
      api, player: fakePlayer(), deviceName: 'X', platform: 'web',
      makeEventSource: (u) => new FakeEventSource(u) as unknown as EventSource
    })
    await store.getState().start()
    await store.getState().refresh()
    const ids = store.getState().sessions.map((s) => s.id)
    expect(ids).toEqual(['cs_pc'])
    await store.getState().stop()
  })

  it('command() forwards to the API', async () => {
    const api = fakeApi()
    const store = createConnectStore({
      api, player: fakePlayer(), deviceName: 'X', platform: 'web',
      makeEventSource: (u) => new FakeEventSource(u) as unknown as EventSource
    })
    await store.getState().command('cs_pc', 'next')
    expect(api.log).toContain('command:cs_pc:next')
  })

  it('playHereFrom() plays the remote track locally and pauses the remote', async () => {
    const api = fakeApi([session({ id: 'cs_pc' })])
    const player = fakePlayer()
    const store = createConnectStore({
      api, player, deviceName: 'X', platform: 'web',
      makeEventSource: (u) => new FakeEventSource(u) as unknown as EventSource
    })
    await store.getState().start()
    await store.getState().refresh()
    await store.getState().playHereFrom('cs_pc')
    expect(player.calls).toContain('playTracks')
    expect(player.calls).toContain('seek:30')
    expect(api.log).toContain('command:cs_pc:pause')
    await store.getState().stop()
  })

  it('does nothing when inactive (active=false until start)', () => {
    const store = createConnectStore({
      api: fakeApi(), player: fakePlayer(), deviceName: 'X', platform: 'web',
      makeEventSource: (u) => new FakeEventSource(u) as unknown as EventSource
    })
    expect(store.getState().active).toBe(false)
    expect(store.getState().selfId).toBeNull()
  })
})
