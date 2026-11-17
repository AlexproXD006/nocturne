import { describe, expect, it, vi } from 'vitest'
import { createNativeNowPlaying, parseCommand, toNativePayload, type NocturneMediaCommandEvent, type NocturneMediaPlugin } from '@/platform/nocturneMedia'
import type { NowPlayingInfo, RemoteCommand } from '@/platform'

const INFO: NowPlayingInfo = {
  id: 'q1',
  title: 'Song',
  artist: 'Artist',
  album: 'Album',
  artworkUrl: 'https://img.example.com/a.jpg',
  duration: 200,
  position: 12.5,
  playing: true,
  hasPrev: false,
  hasNext: true,
  liked: true,
  shuffle: true,
  repeat: 'one'
}

function fakePlugin() {
  let handler: ((e: NocturneMediaCommandEvent) => void) | null = null
  const plugin = {
    update: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
    addListener: vi.fn(async (_event: 'command', fn: (e: NocturneMediaCommandEvent) => void) => {
      handler = fn
      return { remove: async () => undefined }
    })
  } satisfies NocturneMediaPlugin
  return { plugin, fire: (e: unknown) => handler?.(e as NocturneMediaCommandEvent) }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('toNativePayload', () => {
  it('passes the extended fields through', () => {
    expect(toNativePayload(INFO)).toEqual({
      id: 'q1',
      title: 'Song',
      artist: 'Artist',
      album: 'Album',
      artworkUrl: 'https://img.example.com/a.jpg',
      duration: 200,
      position: 12.5,
      playing: true,
      buffering: false,
      hasPrev: false,
      hasNext: true,
      liked: true,
      shuffle: true,
      repeat: 'one'
    })
  })

  it('fills defaults and sanitises numbers', () => {
    const p = toNativePayload({
      title: 'x',
      artist: 'y',
      album: '',
      duration: Number.NaN,
      position: -4,
      playing: false,
      hasPrev: true,
      hasNext: false,
      repeat: 'bogus' as never
    })
    expect(p).toMatchObject({ id: '', artworkUrl: '', duration: 0, position: 0, liked: false, shuffle: false, repeat: 'off', buffering: false })
    expect(toNativePayload({ ...INFO, position: 999 }).position).toBe(200)
    expect(toNativePayload({ ...INFO, duration: 0, position: 30 }).position).toBe(30)
  })
})

describe('parseCommand', () => {
  it('maps every simple kind', () => {
    for (const k of ['play', 'pause', 'toggle', 'next', 'previous', 'stop', 'like', 'shuffle', 'repeat'] as const) {
      expect(parseCommand({ kind: k })).toBe(k)
    }
  })
  it('maps seekTo with a position in seconds', () => {
    expect(parseCommand({ kind: 'seekTo', position: 61.2 })).toEqual({ seekTo: 61.2 })
    expect(parseCommand({ kind: 'seekTo', position: 0 })).toEqual({ seekTo: 0 })
  })
  it('rejects malformed events', () => {
    for (const raw of [null, undefined, 'play', 3, {}, { kind: 7 }, { kind: 'explode' }, { kind: 'seekTo' }, { kind: 'seekTo', position: -1 }, { kind: 'seekTo', position: Number.POSITIVE_INFINITY }]) {
      expect(parseCommand(raw)).toBeNull()
    }
  })
})

describe('createNativeNowPlaying', () => {
  it('update sends the payload; clear only after something was shown', async () => {
    const { plugin } = fakePlugin()
    const np = createNativeNowPlaying(Promise.resolve({ plugin }))
    np.clear()
    await flush()
    expect(plugin.clear).not.toHaveBeenCalled()
    np.update(INFO)
    np.clear()
    np.clear()
    await flush()
    expect(plugin.update).toHaveBeenCalledWith(toNativePayload(INFO))
    expect(plugin.clear).toHaveBeenCalledTimes(1)
    // update reaches native before clear
    expect(plugin.update.mock.invocationCallOrder[0]!).toBeLessThan(plugin.clear.mock.invocationCallOrder[0]!)
  })

  it('forwards parsed commands to listeners (subscribing once) and unsubscribes', async () => {
    const { plugin, fire } = fakePlugin()
    const np = createNativeNowPlaying(Promise.resolve({ plugin }))
    const got: RemoteCommand[] = []
    const off = np.onCommand((c) => got.push(c))
    np.update(INFO)
    await flush()
    expect(plugin.addListener).toHaveBeenCalledTimes(1)
    expect(plugin.addListener.mock.calls[0]![0]).toBe('command')
    fire({ kind: 'like' })
    fire({ kind: 'seekTo', position: 30 })
    fire({ kind: 'nonsense' })
    fire({ kind: 'repeat' })
    expect(got).toEqual(['like', { seekTo: 30 }, 'repeat'])
    off()
    fire({ kind: 'play' })
    expect(got).toHaveLength(3)
  })

  it('never throws or rejects when the plugin is missing or failing', async () => {
    const failing = {
      update: vi.fn(async () => {
        throw new Error('not implemented')
      }),
      clear: vi.fn(async () => {
        throw new Error('not implemented')
      }),
      addListener: vi.fn(async () => {
        throw new Error('not implemented')
      })
    } as unknown as NocturneMediaPlugin
    const np = createNativeNowPlaying(Promise.resolve({ plugin: failing }))
    expect(() => {
      np.onCommand(() => undefined)
      np.update(INFO)
      np.clear()
    }).not.toThrow()
    await flush()
    const missing = createNativeNowPlaying(Promise.reject(new Error('no core')))
    expect(() => {
      missing.update(INFO)
      missing.clear()
      missing.onCommand(() => undefined)()
    }).not.toThrow()
    await flush()
  })
})
