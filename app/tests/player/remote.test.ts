import { describe, expect, it, vi } from 'vitest'
import { applyRemoteCommand, hasNextOf, hasPrevOf, isPositionJump, nowPlayingInfo, type RemoteTarget } from '@/player/remote'
import { createQueue, emptyQueue } from '@/player/queue'
import type { RemoteCommand } from '@/platform'
import { track, tracks } from '../helpers/fixtures'

type Target = { [K in keyof RemoteTarget]: ReturnType<typeof vi.fn<RemoteTarget[K]>> }

function target(): Target {
  return {
    play: vi.fn<RemoteTarget['play']>(),
    pause: vi.fn<RemoteTarget['pause']>(),
    toggle: vi.fn<RemoteTarget['toggle']>(),
    next: vi.fn<RemoteTarget['next']>(),
    previous: vi.fn<RemoteTarget['previous']>(),
    seek: vi.fn<RemoteTarget['seek']>(),
    toggleShuffle: vi.fn<RemoteTarget['toggleShuffle']>(),
    cycleRepeat: vi.fn<RemoteTarget['cycleRepeat']>(),
    toggleLike: vi.fn<RemoteTarget['toggleLike']>()
  }
}

describe('applyRemoteCommand', () => {
  const cases: [RemoteCommand, keyof RemoteTarget][] = [
    ['play', 'play'],
    ['pause', 'pause'],
    ['stop', 'pause'],
    ['toggle', 'toggle'],
    ['next', 'next'],
    ['previous', 'previous'],
    ['like', 'toggleLike'],
    ['shuffle', 'toggleShuffle'],
    ['repeat', 'cycleRepeat']
  ]
  for (const [cmd, method] of cases) {
    it(`${cmd} -> ${method}`, () => {
      const t = target()
      applyRemoteCommand(cmd, t)
      expect(t[method]).toHaveBeenCalledTimes(1)
      const others = (Object.keys(t) as (keyof RemoteTarget)[]).filter((k) => k !== method)
      for (const k of others) expect(t[k]).not.toHaveBeenCalled()
    })
  }

  it('seekTo seeks (clamped at 0) and ignores non-finite positions', () => {
    const t = target()
    applyRemoteCommand({ seekTo: 42.5 }, t)
    applyRemoteCommand({ seekTo: -3 }, t)
    applyRemoteCommand({ seekTo: Number.NaN }, t)
    expect(t.seek.mock.calls).toEqual([[42.5], [0]])
  })
})

describe('nowPlayingInfo', () => {
  const liked = (): boolean => false

  it('is null with an empty queue', () => {
    expect(nowPlayingInfo({ queue: emptyQueue, status: 'idle', position: 0, duration: 0 }, liked)).toBeNull()
  })

  it('maps the current item, flags and extended fields', () => {
    const list = [
      track('a', { artwork: [{ url: 'https://img/a-64.jpg', width: 64 }, { url: 'https://img/a-640.jpg', width: 640 }], liked: true }),
      track('b'),
      track('c')
    ]
    const queue = { ...createQueue(list, 1, { repeat: 'one' }), shuffle: true }
    const info = nowPlayingInfo({ queue, status: 'buffering', position: 12, duration: 180 }, (id, server) => id === 'b' || server === true)
    expect(info).toEqual({
      id: queue.items[1]!.uid,
      title: 'Title b',
      artist: 'Artist b',
      album: 'Album b',
      artworkUrl: undefined,
      duration: 180,
      position: 12,
      playing: true,
      buffering: true,
      hasNext: true,
      hasPrev: true,
      liked: true,
      shuffle: true,
      repeat: 'one'
    })
    const first = nowPlayingInfo({ queue: createQueue(list, 0), status: 'paused', position: 0, duration: 0 }, (_id, server) => server === true)!
    expect(first.artworkUrl).toBe('https://img/a-640.jpg')
    expect(first.duration).toBe(200) // falls back to the track duration
    expect(first.playing).toBe(false)
    expect(first.buffering).toBe(false)
    expect(first.liked).toBe(true) // server value
    expect(first.hasPrev).toBe(false)
    expect(first.repeat).toBe('off')
  })

  it('hasPrev/hasNext follow the queue and repeat-all', () => {
    const q = createQueue(tracks(2), 1)
    expect(hasNextOf({ queue: q })).toBe(false)
    expect(hasPrevOf({ queue: q })).toBe(true)
    expect(hasNextOf({ queue: { ...q, repeat: 'all' } })).toBe(true)
    expect(hasPrevOf({ queue: { ...createQueue(tracks(2), 0), repeat: 'all' } })).toBe(true)
  })
})

describe('isPositionJump', () => {
  it('normal playback progress is not a jump', () => {
    expect(isPositionJump(10, 10.25, 0.25, true)).toBe(false)
    expect(isPositionJump(10, 12, 2, true)).toBe(false) // throttled timeupdates in background
  })
  it('seeks and restarts are jumps', () => {
    expect(isPositionJump(10, 60, 0.25, true)).toBe(true)
    expect(isPositionJump(199, 0, 0.25, true)).toBe(true)
    expect(isPositionJump(10, 40, 0, false)).toBe(true)
  })
  it('while paused small drifts are ignored', () => {
    expect(isPositionJump(10, 10.4, 5, false)).toBe(false)
  })
})
