import { describe, expect, it, vi } from 'vitest'
import { createNativePlayer, parseEvent, parseSession, parseSnapshot, type NocturneNativePlugin } from '@/platform/nativePlayer'

function fakePlugin() {
  let handler: (e: unknown) => void = () => undefined
  const plugin = {
    setQueue: vi.fn(async () => undefined),
    play: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    seek: vi.fn(async () => undefined),
    setVolume: vi.fn(async () => undefined),
    setRepeat: vi.fn(async () => undefined),
    setShuffle: vi.fn(async () => undefined),
    setPauseAtEnd: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    setLiked: vi.fn(async () => undefined),
    setAuth: vi.fn(async () => undefined),
    getAuth: vi.fn(async () => ({ session: { serverUrl: 'https://s', accessToken: 'a', refreshToken: 'r', expiresAt: 5, userId: 'u' } })),
    setLyricsInCar: vi.fn(async () => undefined),
    getSnapshot: vi.fn(async () => ({ snapshot: null })),
    addListener: vi.fn(async (_e: string, fn: (e: unknown) => void) => {
      handler = fn
      return { remove: async () => undefined }
    })
  }
  return { plugin: plugin as unknown as NocturneNativePlugin & typeof plugin, fire: (e: unknown) => handler(e) }
}

describe('parseEvent', () => {
  it('accepts well formed events and rejects the rest', () => {
    expect(parseEvent({ type: 'state', status: 'playing' })).toEqual({ type: 'state', status: 'playing' })
    expect(parseEvent({ type: 'state', status: 'weird' })).toBeNull()
    expect(parseEvent({ type: 'position', position: 3, duration: -1 })).toEqual({ type: 'position', position: 3, duration: 0 })
    expect(parseEvent({ type: 'index', uid: '' })).toBeNull()
    expect(parseEvent({ type: 'command', kind: 'repeat' })).toEqual({ type: 'command', kind: 'repeat' })
    expect(parseEvent({ type: 'command', kind: 'x' })).toBeNull()
    expect(parseEvent({ type: 'liked', trackId: 't', liked: true })).toEqual({ type: 'liked', trackId: 't', liked: true })
    expect(parseEvent(null)).toBeNull()
    expect(parseEvent({ type: 'nope' })).toBeNull()
  })

  it('parses a session and a snapshot defensively', () => {
    expect(parseSession({ serverUrl: 'u', accessToken: 'a' })).toBeNull()
    expect(parseSession({ serverUrl: 'u', accessToken: 'a', refreshToken: 'r', expiresAt: 9 })?.expiresAt).toBe(9)
    expect(parseSnapshot({ items: [] })).toBeNull()
    const snap = parseSnapshot({ items: [{ uid: 'a', trackId: 't', title: 'T', duration: 10 }, { bogus: true }], index: 9, repeat: 'one' })
    expect(snap?.items).toHaveLength(1)
    expect(snap?.index).toBe(0)
    expect(snap?.repeat).toBe('one')
  })
})

describe('createNativePlayer', () => {
  it('forwards calls in order and delivers events', async () => {
    const { plugin, fire } = fakePlugin()
    const n = createNativePlayer(Promise.resolve({ plugin }))
    const got: unknown[] = []
    n.on((e) => got.push(e))
    n.setQueue([], 0, { play: true, startAt: 5 })
    n.pause()
    n.seek(7)
    await vi.waitFor(() => expect(plugin.seek).toHaveBeenCalledWith({ position: 7 }))
    expect(plugin.setQueue).toHaveBeenCalledWith({ items: [], index: 0, play: true, startAt: 5, reset: false })
    await vi.waitFor(() => expect(plugin.addListener).toHaveBeenCalled())
    fire({ type: 'state', status: 'paused' })
    expect(got).toEqual([{ type: 'state', status: 'paused' }])
    await expect(n.getAuth()).resolves.toMatchObject({ accessToken: 'a' })
    await expect(n.getSnapshot()).resolves.toBeNull()
  })

  it('never rejects when the plugin is missing', async () => {
    const n = createNativePlayer(Promise.reject(new Error('no plugin')))
    n.play()
    await expect(n.getAuth()).resolves.toBeNull()
    await expect(n.getSnapshot()).resolves.toBeNull()
  })
})
