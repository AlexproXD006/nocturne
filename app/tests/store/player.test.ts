import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPlayerStore, type PlayerDeps } from '@/store/player'
import type { StreamInfo } from '@/api/types'
import { ApiError } from '@/api/errors'
import { currentItem } from '@/player/queue'
import { FakeEngine } from '../helpers/fake-engine'
import { flush } from '../helpers/http'
import { seq, track, tracks } from '../helpers/fixtures'

const T0 = Date.parse('2026-01-01T00:00:00Z')

function setup(over: Partial<PlayerDeps> = {}) {
  const clock = { t: T0 }
  const crossfade = { value: 0 }
  const engine = new FakeEngine()
  const resolveStream = vi.fn(
    async (id: string): Promise<StreamInfo> => ({ url: `https://s/${id}.mp3`, expiresAt: new Date(clock.t + 600_000).toISOString() })
  )
  const reportPlayed = vi.fn()
  const onError = vi.fn()
  const onVolumeChange = vi.fn()
  const store = createPlayerStore({
    createEngine: (events) => {
      engine.events = events
      return engine
    },
    resolveStream,
    reportPlayed,
    getCrossfade: () => crossfade.value,
    onError,
    onVolumeChange,
    now: () => clock.t,
    rng: () => 0,
    ...over
  })
  const s = () => store.getState()
  const uid = (i: number): string => s().queue.items[i]!.uid
  const cur = (): string | undefined => currentItem(s().queue)?.track.id
  return { store, s, engine, clock, crossfade, resolveStream, reportPlayed, onError, onVolumeChange, uid, cur }
}

type Ctx = ReturnType<typeof setup>

/** Plays n tracks and lets the first load settle. */
async function playing(n = 3, index = 0, over: Partial<PlayerDeps> = {}): Promise<Ctx> {
  const c = setup(over)
  await c.s().playTracks(tracks(n), index)
  c.engine.events.onPlaying()
  c.engine.load.mockClear()
  c.resolveStream.mockClear()
  return c
}

beforeEach(() => {
  vi.useRealTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('initialisation', () => {
  it('starts idle with default volume and applies it to the engine', () => {
    const { s, engine } = setup()
    expect(s()).toMatchObject({ status: 'idle', position: 0, duration: 0, volume: 0.8, muted: false, error: null, reactive: false })
    expect(s().queue.items).toEqual([])
    expect(engine.setVolume).toHaveBeenCalledWith(0.8)
  })

  it('honours initial volume and mute', () => {
    const a = setup({ initialVolume: 0.3 })
    expect(a.engine.setVolume).toHaveBeenCalledWith(0.3)
    expect(a.s().volume).toBe(0.3)
    const b = setup({ initialVolume: 0.3, initialMuted: true })
    expect(b.engine.setVolume).toHaveBeenCalledWith(0)
    expect(b.s()).toMatchObject({ volume: 0.3, muted: true })
  })

  it('mirrors the engine reactive flag and its changes', () => {
    const engine = new FakeEngine()
    engine.reactive = true
    const store = createPlayerStore({
      createEngine: (e) => ((engine.events = e), engine),
      resolveStream: vi.fn(),
      getCrossfade: () => 0
    })
    expect(store.getState().reactive).toBe(true)
    engine.events.onReactiveChange(false)
    expect(store.getState().reactive).toBe(false)
  })

  it('uses Date.now when no clock is injected', async () => {
    const engine = new FakeEngine()
    const resolveStream = vi.fn(async (id: string) => ({ url: `u-${id}`, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }))
    const store = createPlayerStore({ createEngine: (e) => ((engine.events = e), engine), resolveStream, getCrossfade: () => 0 })
    await store.getState().playTracks(tracks(1))
    await store.getState().playTracks(tracks(1))
    expect(resolveStream).toHaveBeenCalledTimes(1)
  })
})

describe('playTracks', () => {
  it('resolves the stream and loads it with the item uid as engine key', async () => {
    const c = setup()
    const list = tracks(3)
    const p = c.s().playTracks(list, 1, { type: 'album', id: 'al' })
    expect(c.s().status).toBe('loading')
    expect(c.s().duration).toBe(200)
    await p
    expect(c.resolveStream).toHaveBeenCalledWith('t1')
    expect(c.engine.load).toHaveBeenCalledWith(c.uid(1), 'https://s/t1.mp3', { autoplay: true, startAt: undefined })
    expect(c.s().queue.index).toBe(1)
    expect(c.s().queue.context).toEqual({ type: 'album', id: 'al' })
    expect(c.s().error).toBeNull()
  })

  it('becomes "playing" only once the engine says so', async () => {
    const c = setup()
    await c.s().playTracks(tracks(2))
    expect(c.s().status).toBe('loading')
    c.engine.events.onPlaying()
    expect(c.s().status).toBe('playing')
  })

  it('ignores an empty list', async () => {
    const c = setup()
    await c.s().playTracks([])
    expect(c.engine.load).not.toHaveBeenCalled()
    expect(c.s().status).toBe('idle')
  })

  it('keeps the current repeat mode and shuffle preference by default', async () => {
    const c = setup()
    c.s().cycleRepeat()
    c.s().setShuffle(true)
    await c.s().playTracks(tracks(4), 2)
    expect(c.s().queue.repeat).toBe('all')
    expect(c.s().queue.shuffle).toBe(true)
    expect(c.cur()).toBe('t2') // started track first even though shuffled
    expect(c.s().queue.index).toBe(0)
  })

  it('opts.shuffle overrides the stored preference', async () => {
    const c = setup()
    c.s().setShuffle(true)
    await c.s().playTracks(tracks(4), 1, null, { shuffle: false })
    expect(c.s().queue.shuffle).toBe(false)
    expect(c.s().queue.index).toBe(1)
  })

  it('shuffles with the injected rng', async () => {
    const c = setup({ rng: seq([0.99, 0.99, 0.99]) })
    await c.s().playTracks(tracks(4), 0, null, { shuffle: true })
    expect(c.s().queue.items.map((i) => i.track.id)).toEqual(['t0', 't1', 't2', 't3'])
    const d = setup({ rng: () => 0 })
    await d.s().playTracks(tracks(4), 0, null, { shuffle: true })
    expect(d.s().queue.items.map((i) => i.track.id)).toEqual(['t0', 't2', 't3', 't1'])
  })

  it('sets an error state and notifies when the stream cannot be resolved', async () => {
    const c = setup()
    c.resolveStream.mockRejectedValueOnce(new ApiError('not_found', 'Track missing'))
    await c.s().playTracks(tracks(2))
    expect(c.s().status).toBe('error')
    expect(c.s().error).toBe('Track missing')
    expect(c.onError).toHaveBeenCalledWith('Track missing')
    expect(c.engine.load).not.toHaveBeenCalled()
  })

  it('drops a stale resolution when the user already moved on', async () => {
    const c = setup()
    let release!: (v: StreamInfo) => void
    c.resolveStream.mockImplementationOnce(() => new Promise((r) => (release = r)))
    const first = c.s().playTracks(tracks(1, 'a'))
    const second = c.s().playTracks(tracks(1, 'b'))
    await second
    release({ url: 'late', expiresAt: new Date(T0 + 600_000).toISOString() })
    await first
    expect(c.engine.load).toHaveBeenCalledTimes(1)
    expect(c.engine.load).toHaveBeenCalledWith(expect.any(String), 'https://s/b0.mp3', expect.anything())
  })

  it('drops a stale failure too', async () => {
    const c = setup()
    let fail!: (e: unknown) => void
    c.resolveStream.mockImplementationOnce(() => new Promise((_, rej) => (fail = rej)))
    const first = c.s().playTracks(tracks(1, 'a'))
    await c.s().playTracks(tracks(1, 'b'))
    fail(new Error('late failure'))
    await first
    expect(c.onError).not.toHaveBeenCalled()
    expect(c.s().status).not.toBe('error')
  })
})

describe('stream url cache', () => {
  it('reuses a valid cached url', async () => {
    const c = setup()
    const list = [track('a')]
    await c.s().playTracks(list)
    await c.s().playTracks(list)
    expect(c.resolveStream).toHaveBeenCalledTimes(1)
  })

  it('refreshes when the url is within 60s of expiry', async () => {
    const c = setup()
    const list = [track('a')]
    await c.s().playTracks(list)
    c.clock.t += 600_000 - 60_001
    await c.s().playTracks(list)
    expect(c.resolveStream).toHaveBeenCalledTimes(1)
    c.clock.t += 2
    await c.s().playTracks(list)
    expect(c.resolveStream).toHaveBeenCalledTimes(2)
  })

  it('caches by track, not by queue item', async () => {
    const c = setup()
    await c.s().playTracks([track('a'), track('b')], 0)
    await c.s().next()
    await c.s().previous()
    expect(c.resolveStream).toHaveBeenCalledTimes(2)
  })

  it('falls back to a 5 minute lifetime when expiresAt is unparsable', async () => {
    const c = setup()
    c.resolveStream.mockResolvedValue({ url: 'u', expiresAt: 'not a date' })
    await c.s().playTracks([track('a')])
    c.clock.t += 4 * 60_000 - 1000 // 5 min lifetime minus the 60s safety margin => valid until 4:00
    await c.s().playTracks([track('a')])
    expect(c.resolveStream).toHaveBeenCalledTimes(1)
    c.clock.t += 1001
    await c.s().playTracks([track('a')])
    expect(c.resolveStream).toHaveBeenCalledTimes(2)
  })

  it('evicts the oldest entries beyond 64', async () => {
    const c = setup()
    const many = tracks(66)
    for (const t of many) await c.s().playTracks([t])
    c.resolveStream.mockClear()
    await c.s().playTracks([many[65]!])
    expect(c.resolveStream).not.toHaveBeenCalled()
    await c.s().playTracks([many[0]!])
    expect(c.resolveStream).toHaveBeenCalledTimes(1)
  })
})

describe('transport', () => {
  it('toggle pauses while playing/buffering/loading and plays otherwise', async () => {
    const c = await playing()
    c.s().toggle()
    expect(c.engine.pause).toHaveBeenCalledTimes(1)
    expect(c.s().status).toBe('paused')
    c.s().toggle()
    expect(c.engine.play).toHaveBeenCalledTimes(1)
    c.engine.events.onWaiting()
    expect(c.s().status).toBe('buffering')
    c.s().toggle()
    expect(c.engine.pause).toHaveBeenCalledTimes(2)
  })

  it('pause() is reflected immediately and play() resumes the engine', async () => {
    const c = await playing()
    c.s().pause()
    expect(c.s().status).toBe('paused')
    c.s().play()
    expect(c.engine.play).toHaveBeenCalled()
  })

  it('play does nothing without a current track', () => {
    const c = setup()
    c.s().play()
    c.s().toggle()
    expect(c.engine.play).not.toHaveBeenCalled()
    expect(c.resolveStream).not.toHaveBeenCalled()
  })

  it('play after an error reloads the current track at the same position', async () => {
    const c = await playing()
    c.resolveStream.mockRejectedValueOnce(new Error('offline'))
    await c.s().playItem(c.uid(1))
    expect(c.s().status).toBe('error')
    c.s().play()
    await flush(20)
    expect(c.engine.load).toHaveBeenCalledWith(c.uid(1), 'https://s/t1.mp3', { autoplay: true, startAt: 0 })
  })

  it('engine pause events set paused, except while loading', async () => {
    const c = setup()
    const p = c.s().playTracks(tracks(1))
    c.engine.events.onPause()
    expect(c.s().status).toBe('loading')
    await p
    c.engine.events.onPlaying()
    c.engine.events.onPause()
    expect(c.s().status).toBe('paused')
  })

  it('seek forwards to the engine and updates position', async () => {
    const c = await playing()
    c.s().seek(42)
    expect(c.engine.seek).toHaveBeenCalledWith(42)
    expect(c.s().position).toBe(42)
    c.s().seek(-5)
    expect(c.s().position).toBe(0)
    c.engine.seek.mockClear()
    c.s().seek(Number.NaN)
    c.s().seek(Number.POSITIVE_INFINITY)
    expect(c.engine.seek).not.toHaveBeenCalled()
  })

  it('playItem jumps within the queue', async () => {
    const c = await playing(4)
    await c.s().playItem(c.uid(3))
    expect(c.cur()).toBe('t3')
    expect(c.engine.load).toHaveBeenCalledWith(c.uid(3), 'https://s/t3.mp3', expect.anything())
  })

  it('playItem ignores unknown uids and re-starts the current one', async () => {
    const c = await playing(3)
    await c.s().playItem('nope')
    expect(c.engine.load).not.toHaveBeenCalled()
    await c.s().playItem(c.uid(0))
    expect(c.engine.load).toHaveBeenCalledTimes(1)
  })
})

describe('next / previous', () => {
  it('next advances and loads', async () => {
    const c = await playing(3)
    await c.s().next()
    expect(c.cur()).toBe('t1')
    expect(c.engine.load).toHaveBeenCalledWith(c.uid(1), 'https://s/t1.mp3', expect.anything())
  })

  it('next at the end of the queue does nothing (repeat off)', async () => {
    const c = await playing(2, 1)
    await c.s().next()
    expect(c.cur()).toBe('t1')
    expect(c.engine.load).not.toHaveBeenCalled()
  })

  it('next wraps with repeat all', async () => {
    const c = await playing(2, 1)
    c.s().cycleRepeat()
    await c.s().next()
    expect(c.cur()).toBe('t0')
  })

  it('next skips forward even with repeat one', async () => {
    const c = await playing(3, 0)
    c.s().cycleRepeat()
    c.s().cycleRepeat()
    expect(c.s().queue.repeat).toBe('one')
    await c.s().next()
    expect(c.cur()).toBe('t1')
  })

  it('previous restarts the track when more than 3 seconds in', async () => {
    const c = await playing(3, 1)
    c.engine.currentTime = 3.01
    await c.s().previous()
    expect(c.engine.seek).toHaveBeenCalledWith(0)
    expect(c.cur()).toBe('t1')
    expect(c.engine.load).not.toHaveBeenCalled()
  })

  it('previous goes to the previous track within the first 3 seconds', async () => {
    const c = await playing(3, 1)
    c.engine.currentTime = 3
    await c.s().previous()
    expect(c.cur()).toBe('t0')
    expect(c.engine.load).toHaveBeenCalledWith(c.uid(0), 'https://s/t0.mp3', expect.anything())
  })

  it('previous on the first track restarts it', async () => {
    const c = await playing(3, 0)
    c.engine.currentTime = 1
    await c.s().previous()
    expect(c.engine.seek).toHaveBeenCalledWith(0)
    expect(c.engine.load).not.toHaveBeenCalled()
  })

  it('previous on the first track wraps with repeat all', async () => {
    const c = await playing(3, 0)
    c.s().cycleRepeat()
    c.engine.currentTime = 1
    await c.s().previous()
    expect(c.cur()).toBe('t2')
  })
})

describe('track end', () => {
  it('advances to the next track and loads it', async () => {
    const c = await playing(3)
    c.engine.events.onEnded()
    await flush(20)
    expect(c.cur()).toBe('t1')
    expect(c.engine.load).toHaveBeenCalledWith(c.uid(1), 'https://s/t1.mp3', expect.anything())
  })

  it('repeat one restarts the same track without reloading', async () => {
    const c = await playing(3, 1)
    c.s().cycleRepeat()
    c.s().cycleRepeat()
    c.engine.events.onEnded()
    await flush(20)
    expect(c.cur()).toBe('t1')
    expect(c.engine.seek).toHaveBeenCalledWith(0)
    expect(c.engine.play).toHaveBeenCalled()
    expect(c.engine.load).not.toHaveBeenCalled()
  })

  it('at the end of the queue it rewinds and pauses at 0', async () => {
    const c = await playing(2, 1)
    c.engine.events.onTime(150, 200)
    c.engine.events.onEnded()
    await flush(20)
    expect(c.engine.seek).toHaveBeenCalledWith(0)
    expect(c.s()).toMatchObject({ status: 'paused', position: 0 })
    expect(c.cur()).toBe('t1')
    expect(c.engine.load).not.toHaveBeenCalled()
  })

  it('repeat all wraps around at the end', async () => {
    const c = await playing(2, 1)
    c.s().cycleRepeat()
    c.engine.events.onEnded()
    await flush(20)
    expect(c.cur()).toBe('t0')
  })

  it('ignores ended events while a crossfade is in progress', async () => {
    const c = await playing(3)
    c.engine.isTransitioning = true
    c.engine.events.onEnded()
    await flush(20)
    expect(c.cur()).toBe('t0')
    expect(c.engine.load).not.toHaveBeenCalled()
  })
})

describe('playback errors', () => {
  it('first error forces a fresh url and resumes at the same position', async () => {
    const c = await playing(3, 0)
    c.engine.currentTime = 37.5
    c.engine.events.onError('Playback failed.')
    await flush(20)
    expect(c.resolveStream).toHaveBeenCalledTimes(1) // forced despite a valid cached url
    expect(c.engine.load).toHaveBeenCalledWith(c.uid(0), 'https://s/t0.mp3', { autoplay: true, startAt: 37.5 })
    expect(c.onError).not.toHaveBeenCalled()
    expect(c.cur()).toBe('t0')
  })

  it('falls back to the stored position when the engine reports 0', async () => {
    const c = await playing(3, 0)
    c.engine.events.onTime(20, 200)
    c.engine.currentTime = 0
    c.engine.events.onError('x')
    await flush(20)
    expect(c.engine.load).toHaveBeenCalledWith(expect.any(String), expect.any(String), { autoplay: true, startAt: 20 })
  })

  it('second error shows a toast (onError) and skips to the next track', async () => {
    const c = await playing(3, 0)
    c.engine.events.onError('Boom')
    await flush(20)
    c.engine.load.mockClear()
    c.engine.events.onError('Boom')
    await flush(20)
    expect(c.onError).toHaveBeenCalledExactlyOnceWith('Boom')
    expect(c.cur()).toBe('t1')
    expect(c.engine.load).toHaveBeenCalledWith(c.uid(1), 'https://s/t1.mp3', expect.anything())
  })

  it('the next track gets its own retry', async () => {
    const c = await playing(3, 0)
    c.engine.events.onError('e')
    await flush(20)
    c.engine.events.onError('e')
    await flush(20)
    expect(c.cur()).toBe('t1')
    c.engine.load.mockClear()
    c.engine.events.onError('e') // first error for t1 -> retry, not skip
    await flush(20)
    expect(c.cur()).toBe('t1')
    expect(c.engine.load).toHaveBeenCalledTimes(1)
  })

  it('a successful play clears the retry flag', async () => {
    const c = await playing(3, 0)
    c.engine.events.onError('e')
    await flush(20)
    c.engine.events.onPlaying()
    c.engine.load.mockClear()
    c.engine.events.onError('e')
    await flush(20)
    expect(c.cur()).toBe('t0') // retried again instead of skipping
    expect(c.engine.load).toHaveBeenCalledTimes(1)
    expect(c.onError).not.toHaveBeenCalled()
  })

  it('stays on the failing track when it is the last one', async () => {
    const c = await playing(2, 1)
    c.engine.events.onError('e')
    await flush(20)
    c.engine.events.onError('final')
    await flush(20)
    expect(c.s()).toMatchObject({ status: 'error', error: 'final' })
    expect(c.cur()).toBe('t1')
    expect(c.onError).toHaveBeenCalledWith('final')
  })

  it('ignores errors when nothing is queued', async () => {
    const c = setup()
    c.engine.events.onError('stray')
    await flush(20)
    expect(c.onError).not.toHaveBeenCalled()
    expect(c.s().status).toBe('idle')
  })

  it('does not skip with repeat one + manual semantics (skip uses a non-auto advance)', async () => {
    const c = await playing(3, 0)
    c.s().cycleRepeat()
    c.s().cycleRepeat()
    c.engine.events.onError('e')
    await flush(20)
    c.engine.events.onError('e')
    await flush(20)
    expect(c.cur()).toBe('t1')
  })
})

describe('progress and position', () => {
  it('updates position and duration from time events', async () => {
    const c = await playing()
    c.engine.events.onTime(12, 201)
    expect(c.s()).toMatchObject({ position: 12, duration: 201 })
  })

  it('keeps the previous duration when the engine reports 0', async () => {
    const c = await playing()
    c.engine.events.onTime(1, 0)
    expect(c.s().duration).toBe(200)
  })

  it('throttles tiny position changes unless 500ms passed or the duration changed', async () => {
    const c = await playing()
    c.engine.events.onTime(10, 200)
    c.engine.events.onTime(10.1, 200)
    expect(c.s().position).toBe(10)
    c.clock.t += 501
    c.engine.events.onTime(10.1, 200)
    expect(c.s().position).toBe(10.1)
    c.engine.events.onTime(10.2, 205)
    expect(c.s().position).toBe(10.2)
    c.engine.events.onTime(10.5, 205)
    expect(c.s().position).toBe(10.5)
  })
})

describe('preloading', () => {
  it('preloads the next track within 45 seconds of the end', async () => {
    const c = await playing(3)
    c.engine.events.onTime(155, 200)
    await flush(20)
    expect(c.engine.preload).toHaveBeenCalledWith(c.uid(1), 'https://s/t1.mp3')
  })

  it('does not preload earlier than that', async () => {
    const c = await playing(3)
    c.engine.events.onTime(154.9, 200)
    await flush(20)
    expect(c.engine.preload).not.toHaveBeenCalled()
  })

  it('does not preload without a known duration', async () => {
    const c = await playing(3)
    c.engine.events.onTime(10, 0)
    await flush(20)
    expect(c.engine.preload).not.toHaveBeenCalled()
  })

  it('does not preload at the end of the queue, nor for repeat one', async () => {
    const last = await playing(2, 1)
    last.engine.events.onTime(190, 200)
    await flush(20)
    expect(last.engine.preload).not.toHaveBeenCalled()
    const one = await playing(3, 0)
    one.s().cycleRepeat()
    one.s().cycleRepeat()
    one.engine.events.onTime(190, 200)
    await flush(20)
    expect(one.engine.preload).not.toHaveBeenCalled()
  })

  it('preloads the first track when repeat all wraps', async () => {
    const c = await playing(2, 1)
    c.s().cycleRepeat()
    c.engine.events.onTime(190, 200)
    await flush(20)
    expect(c.engine.preload).toHaveBeenCalledWith(c.uid(0), 'https://s/t0.mp3')
  })

  it('does not preload twice', async () => {
    const c = await playing(3)
    c.engine.events.onTime(160, 200)
    c.engine.events.onTime(161, 200)
    c.engine.events.onTime(162, 200)
    await flush(20)
    expect(c.engine.preload).toHaveBeenCalledTimes(1)
    c.engine.events.onTime(170, 200)
    await flush(20)
    expect(c.engine.preload).toHaveBeenCalledTimes(1)
  })

  it('swallows resolve failures (the track is resolved again when it starts)', async () => {
    const c = await playing(3)
    c.resolveStream.mockRejectedValueOnce(new Error('nope'))
    c.engine.events.onTime(160, 200)
    await flush(20)
    expect(c.engine.preload).not.toHaveBeenCalled()
    expect(c.onError).not.toHaveBeenCalled()
    c.engine.events.onTime(161, 200)
    await flush(20)
    expect(c.engine.preload).toHaveBeenCalledTimes(1)
  })
})

describe('crossfade', () => {
  it('starts a crossfade when within the fade window of the end', async () => {
    const c = await playing(3)
    c.crossfade.value = 4
    c.engine.events.onTime(197, 200)
    await flush(20)
    expect(c.engine.crossfadeTo).toHaveBeenCalledWith(c.uid(1), 'https://s/t1.mp3', 4)
    expect(c.cur()).toBe('t1')
    expect(c.s()).toMatchObject({ position: 0, duration: 200, error: null })
  })

  it('does nothing while the fade window has not been reached', async () => {
    const c = await playing(3)
    c.crossfade.value = 4
    c.engine.events.onTime(190, 200)
    await flush(20)
    expect(c.engine.crossfadeTo).not.toHaveBeenCalled()
  })

  it.each([
    ['crossfade disabled', (c: Ctx) => void (c.crossfade.value = 0)],
    ['repeat one', (c: Ctx) => { c.s().cycleRepeat(); c.s().cycleRepeat() }],
    ['already transitioning', (c: Ctx) => void (c.engine.isTransitioning = true)],
    ['paused', (c: Ctx) => c.s().pause()],
    ['buffering', (c: Ctx) => c.engine.events.onWaiting()]
  ])('does not crossfade: %s', async (_name, arrange) => {
    const c = await playing(3)
    c.crossfade.value = 4
    arrange(c)
    c.engine.events.onTime(198, 200)
    await flush(20)
    expect(c.engine.crossfadeTo).not.toHaveBeenCalled()
  })

  it('does not crossfade tracks shorter than twice the fade', async () => {
    const c = await playing(3)
    c.crossfade.value = 4
    c.engine.events.onTime(5, 8)
    await flush(20)
    expect(c.engine.crossfadeTo).not.toHaveBeenCalled()
  })

  it('does not crossfade at the end of the queue', async () => {
    const c = await playing(2, 1)
    c.crossfade.value = 4
    c.engine.events.onTime(198, 200)
    await flush(20)
    expect(c.engine.crossfadeTo).not.toHaveBeenCalled()
  })

  it('triggers only once even with rapid time updates', async () => {
    const c = await playing(3)
    c.crossfade.value = 4
    c.engine.events.onTime(197, 200)
    c.engine.events.onTime(197.2, 200)
    c.engine.events.onTime(197.4, 200)
    await flush(20)
    expect(c.engine.crossfadeTo).toHaveBeenCalledTimes(1)
  })

  it('reports resolve failures and leaves the queue untouched', async () => {
    const c = await playing(3)
    c.crossfade.value = 4
    c.resolveStream.mockRejectedValue(new ApiError('network', 'offline')) // (preloading fails silently too)
    c.engine.events.onTime(197, 200)
    await flush(20)
    expect(c.onError).toHaveBeenCalledWith('offline')
    expect(c.cur()).toBe('t0')
    expect(c.engine.crossfadeTo).not.toHaveBeenCalled()
  })

  it('does not trigger the ended-handler double advance afterwards', async () => {
    const c = await playing(3)
    c.crossfade.value = 4
    c.engine.events.onTime(197, 200)
    await flush(20)
    c.engine.isTransitioning = true
    c.engine.events.onEnded()
    await flush(20)
    expect(c.cur()).toBe('t1')
  })
})

describe('volume and mute', () => {
  it('setVolume clamps, forwards to the engine and reports', () => {
    const c = setup()
    c.s().setVolume(0.5)
    expect(c.engine.setVolume).toHaveBeenLastCalledWith(0.5)
    expect(c.s().volume).toBe(0.5)
    expect(c.onVolumeChange).toHaveBeenLastCalledWith(0.5, false)
    c.s().setVolume(7)
    expect(c.s().volume).toBe(1)
    c.s().setVolume(-3)
    expect(c.s().volume).toBe(0)
  })

  it('raising the volume unmutes', () => {
    const c = setup({ initialMuted: true })
    c.s().setVolume(0.6)
    expect(c.s().muted).toBe(false)
    expect(c.onVolumeChange).toHaveBeenLastCalledWith(0.6, false)
  })

  it('setting the volume to 0 keeps the mute flag as is', () => {
    const c = setup({ initialMuted: true })
    c.s().setVolume(0)
    expect(c.s().muted).toBe(true)
    expect(c.onVolumeChange).toHaveBeenLastCalledWith(0, true)
    const d = setup()
    d.s().setVolume(0)
    expect(d.s().muted).toBe(false)
  })

  it('toggleMute silences the engine and restores the volume', () => {
    const c = setup({ initialVolume: 0.7 })
    c.s().toggleMute()
    expect(c.s().muted).toBe(true)
    expect(c.engine.setVolume).toHaveBeenLastCalledWith(0)
    expect(c.onVolumeChange).toHaveBeenLastCalledWith(0.7, true)
    c.s().toggleMute()
    expect(c.s().muted).toBe(false)
    expect(c.engine.setVolume).toHaveBeenLastCalledWith(0.7)
    expect(c.onVolumeChange).toHaveBeenLastCalledWith(0.7, false)
  })

  it('works without a volume callback', () => {
    const engine = new FakeEngine()
    const store = createPlayerStore({ createEngine: (e) => ((engine.events = e), engine), resolveStream: vi.fn(), getCrossfade: () => 0 })
    expect(() => {
      store.getState().setVolume(0.2)
      store.getState().toggleMute()
    }).not.toThrow()
  })
})

describe('queue management', () => {
  it('addNext on an empty queue starts playing it', async () => {
    const c = setup()
    c.s().addNext(tracks(2))
    await flush(20)
    expect(c.cur()).toBe('t0')
    expect(c.engine.load).toHaveBeenCalledWith(c.uid(0), 'https://s/t0.mp3', { autoplay: true, startAt: undefined })
  })

  it('addToQueue on an empty queue starts playing it', async () => {
    const c = setup()
    c.s().addToQueue(tracks(2))
    await flush(20)
    expect(c.engine.load).toHaveBeenCalledTimes(1)
    expect(c.s().queue.items).toHaveLength(2)
  })

  it('adding to a non-empty queue does not interrupt playback', async () => {
    const c = await playing(2)
    c.s().addNext([track('n1')])
    c.s().addToQueue([track('n2')])
    await flush(20)
    expect(c.engine.load).not.toHaveBeenCalled()
    // Both go to the user queue (play next first), ahead of the rest of the context.
    expect(c.s().queue.items.map((i) => i.track.id)).toEqual(['t0', 'n1', 'n2', 't1'])
  })

  it('adding nothing to an empty queue does not start anything', async () => {
    const c = setup()
    c.s().addNext([])
    c.s().addToQueue([])
    await flush(20)
    expect(c.engine.load).not.toHaveBeenCalled()
  })

  it('removing a non-current item leaves playback alone', async () => {
    const c = await playing(3)
    c.s().removeFromQueue(c.uid(2))
    await flush(20)
    expect(c.engine.load).not.toHaveBeenCalled()
    expect(c.s().queue.items).toHaveLength(2)
  })

  it('removing the current item while playing starts the next one', async () => {
    const c = await playing(3)
    c.s().removeFromQueue(c.uid(0))
    await flush(20)
    expect(c.cur()).toBe('t1')
    expect(c.engine.load).toHaveBeenCalledWith(expect.any(String), 'https://s/t1.mp3', { autoplay: true, startAt: undefined })
  })

  it('removing the current item while paused loads the next without autoplay', async () => {
    const c = await playing(3)
    c.s().pause()
    c.s().removeFromQueue(c.uid(0))
    await flush(20)
    expect(c.engine.load).toHaveBeenCalledWith(expect.any(String), 'https://s/t1.mp3', { autoplay: false, startAt: undefined })
    expect(c.s().status).toBe('paused')
  })

  it('removing the only item stops the engine and goes idle', async () => {
    const c = await playing(1)
    c.s().removeFromQueue(c.uid(0))
    await flush(20)
    expect(c.engine.stop).toHaveBeenCalled()
    expect(c.s()).toMatchObject({ status: 'idle', position: 0, duration: 0 })
    expect(c.s().queue.items).toEqual([])
  })

  it('moveInQueue, clearUpcoming, setShuffle and cycleRepeat delegate to the queue module', async () => {
    const c = await playing(4)
    c.s().moveInQueue(3, 1)
    expect(c.s().queue.items.map((i) => i.track.id)).toEqual(['t0', 't3', 't1', 't2'])
    c.s().clearUpcoming()
    expect(c.s().queue.items.map((i) => i.track.id)).toEqual(['t0'])
    c.s().setShuffle(true)
    expect(c.s().queue.shuffle).toBe(true)
    c.s().setShuffle(false)
    expect(c.s().queue.shuffle).toBe(false)
    c.s().cycleRepeat()
    expect(c.s().queue.repeat).toBe('all')
    c.s().cycleRepeat()
    expect(c.s().queue.repeat).toBe('one')
    c.s().cycleRepeat()
    expect(c.s().queue.repeat).toBe('off')
  })
})

describe('stop', () => {
  it('stops the engine and clears the queue but keeps repeat/shuffle preferences', async () => {
    const c = await playing(3)
    c.s().cycleRepeat()
    c.s().setShuffle(true)
    c.engine.events.onTime(10, 200)
    c.s().stop()
    expect(c.engine.stop).toHaveBeenCalled()
    expect(c.s().queue.items).toEqual([])
    expect(c.s().queue).toMatchObject({ repeat: 'all', shuffle: true, index: -1 })
    expect(c.s()).toMatchObject({ status: 'idle', position: 0, duration: 0, error: null })
  })
})

describe('scrobbling', () => {
  /** Simulates continuous playback from `from` to `to` seconds in 1s steps. */
  function tick(c: Ctx, from: number, to: number, duration = 200): void {
    for (let t = from; t <= to; t++) c.engine.events.onTime(t, duration)
  }

  it('reports after 30 seconds of continuous playback, when the track is left', async () => {
    const c = await playing(2)
    tick(c, 0, 29)
    await c.s().next()
    expect(c.reportPlayed).not.toHaveBeenCalled()
    const d = await playing(2)
    tick(d, 0, 30)
    expect(d.reportPlayed).not.toHaveBeenCalled() // not mid-track
    await d.s().next()
    expect(d.reportPlayed).toHaveBeenCalledExactlyOnceWith('t0', 30, expect.any(Object))
  })

  it('persists the listen in progress every ~15 s with a stable playId, and sends that playId on report', async () => {
    const persistListen = vi.fn()
    const dropListen = vi.fn()
    const c = await playing(2, 0, { persistListen, dropListen })
    tick(c, 0, 14)
    expect(persistListen).not.toHaveBeenCalled()
    tick(c, 15, 31)
    const calls = persistListen.mock.calls.map((x) => x[0])
    expect(calls.map((x) => x.seconds)).toEqual([15, 30])
    const id = calls[0].playId
    expect(id).toBeTruthy()
    expect(calls[1].playId).toBe(id)
    expect(calls[0]).toMatchObject({ trackId: 't0', at: new Date(T0).toISOString() })
    await c.s().next()
    expect(c.reportPlayed).toHaveBeenCalledExactlyOnceWith('t0', 31, expect.objectContaining({ playId: id }))
    expect(dropListen).not.toHaveBeenCalled()
  })

  it('drops the persisted entry of a listen that never counted, and uses a new playId per track and repeat', async () => {
    const persistListen = vi.fn()
    const dropListen = vi.fn()
    const c = await playing(3, 0, { persistListen, dropListen })
    tick(c, 0, 20)
    const first = persistListen.mock.calls[0]![0].playId
    await c.s().next()
    tick(c, 0, 16)
    expect(dropListen).toHaveBeenCalledWith(first)
    expect(persistListen.mock.calls.at(-1)![0].playId).not.toBe(first)
    expect(c.reportPlayed).not.toHaveBeenCalled()
  })

  it('a persistence failure never breaks playback', async () => {
    const c = await playing(2, 0, { persistListen: () => { throw new Error('quota') }, dropListen: () => { throw new Error('x') } })
    expect(() => tick(c, 0, 40)).not.toThrow()
    await c.s().next()
    expect(c.reportPlayed).toHaveBeenCalledTimes(1)
  })

  it('reports the real listened seconds, once, at the end of the track', async () => {
    const c = await playing(2)
    tick(c, 0, 199)
    c.engine.events.onEnded()
    await flush(20)
    expect(c.reportPlayed).toHaveBeenCalledExactlyOnceWith('t0', 199, expect.any(Object))
  })

  it('does not count seeks / jumps as listened time', async () => {
    const c = await playing(2)
    tick(c, 0, 10)
    c.engine.events.onTime(100, 200) // jump
    tick(c, 101, 118)
    c.s().stop()
    expect(c.reportPlayed).not.toHaveBeenCalled() // only ~29s of real listening
    const d = await playing(2)
    tick(d, 0, 10)
    d.engine.events.onTime(100, 200)
    tick(d, 101, 121)
    d.s().stop()
    expect(d.reportPlayed).toHaveBeenCalledTimes(1)
  })

  it('does not count time going backwards', async () => {
    const c = await playing(2)
    tick(c, 0, 20)
    c.engine.events.onTime(5, 200)
    tick(c, 6, 10)
    c.s().stop()
    expect(c.reportPlayed).not.toHaveBeenCalled()
  })

  it('counts a user seek without double counting (seek moves the reference point)', async () => {
    const c = await playing(2)
    tick(c, 0, 20)
    c.s().seek(100)
    tick(c, 101, 110)
    c.s().stop()
    expect(c.reportPlayed).toHaveBeenCalledExactlyOnceWith('t0', 30, expect.any(Object))
  })

  it('short tracks count as listened after half their length', async () => {
    const c = setup()
    await c.s().playTracks([track('short', { duration: 40 })])
    for (let t = 0; t <= 19; t++) c.engine.events.onTime(t, 40)
    c.s().stop()
    expect(c.reportPlayed).not.toHaveBeenCalled()
    const d = setup()
    await d.s().playTracks([track('short', { duration: 40 })])
    for (let t = 0; t <= 20; t++) d.engine.events.onTime(t, 40)
    await d.s().playTracks([track('other', { duration: 40 })])
    expect(d.reportPlayed).toHaveBeenCalledExactlyOnceWith('short', 20, expect.any(Object))
  })

  it('each track is tracked separately', async () => {
    const c = await playing(3)
    tick(c, 0, 30)
    await c.s().next()
    tick(c, 0, 30)
    await c.s().next()
    expect(c.reportPlayed.mock.calls.map((x) => x[0])).toEqual(['t0', 't1'])
  })

  it('does not report a track that was skipped early', async () => {
    const c = await playing(3)
    tick(c, 0, 10)
    await c.s().next()
    tick(c, 0, 10)
    expect(c.reportPlayed).not.toHaveBeenCalled()
  })

  it('repeat one counts each loop again', async () => {
    const c = await playing(2)
    c.s().cycleRepeat()
    c.s().cycleRepeat()
    tick(c, 0, 30)
    c.engine.events.onEnded()
    await flush(20)
    expect(c.reportPlayed).toHaveBeenCalledTimes(1)
    tick(c, 0, 30)
    c.engine.events.onEnded()
    await flush(20)
    expect(c.reportPlayed).toHaveBeenCalledTimes(2)
  })

  it('works without a reporter and survives a throwing reporter', async () => {
    const quiet = await playing(2, 0, { reportPlayed: undefined })
    expect(() => tick(quiet, 0, 40)).not.toThrow()
    const c = await playing(2, 0, { reportPlayed: () => { throw new Error('boom') } })
    expect(() => tick(c, 0, 40)).not.toThrow()
  })

  it('ignores time events when nothing is queued', () => {
    const c = setup()
    c.engine.events.onTime(5, 100)
    expect(c.reportPlayed).not.toHaveBeenCalled()
  })

  it('stop() right after a listened play does not report twice', async () => {
    const c = await playing(2)
    tick(c, 0, 31)
    c.s().stop()
    c.s().stop()
    expect(c.reportPlayed).toHaveBeenCalledTimes(1)
  })
})
