import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSleepTimer, type SleepPlayer } from '@/store/sleepTimer'
import { FADE_SECONDS, fadeFactor, formatRemaining, parseCustomMinutes, SLEEP_PRESETS } from '@/lib/sleepTimer'

function setup(over: Partial<ReturnType<SleepPlayer['getState']>> = {}) {
  const st = {
    status: 'playing',
    position: 0,
    duration: 200,
    volume: 0.8,
    muted: false,
    sleepAfterTrack: false,
    pause: vi.fn(() => {
      st.status = 'paused'
      listeners.forEach((l) => l())
    }),
    setSleepAfterTrack: vi.fn((on: boolean) => void (st.sleepAfterTrack = on)),
    ...over
  }
  const listeners = new Set<() => void>()
  const player: SleepPlayer = {
    getState: () => st,
    subscribe: (l) => (listeners.add(l), () => listeners.delete(l))
  }
  const setOutputVolume = vi.fn()
  const onFinished = vi.fn()
  const store = createSleepTimer({ player, setOutputVolume, onFinished, now: Date.now })
  return { st, store, setOutputVolume, onFinished, listeners }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('sleep timer helpers', () => {
  it('fadeFactor is 1 before the fade, linear inside it, 0 at the end', () => {
    expect(FADE_SECONDS).toBe(10)
    expect(fadeFactor(30)).toBe(1)
    expect(fadeFactor(10)).toBe(1)
    expect(fadeFactor(5)).toBe(0.5)
    expect(fadeFactor(0)).toBe(0)
    expect(fadeFactor(-3)).toBe(0)
    expect(fadeFactor(NaN)).toBe(1)
  })
  it('parses custom minutes', () => {
    expect(parseCustomMinutes(' 45 ')).toBe(45)
    for (const bad of ['', '0', '1.5', '-5', 'abc', '721', '99999', '1e2']) expect(parseCustomMinutes(bad)).toBeNull()
    expect(parseCustomMinutes('720')).toBe(720)
  })
  it('formats remaining time', () => {
    expect(formatRemaining(0)).toBe('0:00')
    expect(formatRemaining(61_000)).toBe('1:01')
    expect(formatRemaining(60_001)).toBe('1:01')
    expect(formatRemaining(3_723_000)).toBe('1:02:03')
    expect(SLEEP_PRESETS).toEqual([5, 15, 30, 45, 60])
  })
})

describe('sleep timer (time)', () => {
  it('fades over the last 10 s, then pauses and restores the volume', () => {
    const { st, store, setOutputVolume, onFinished } = setup()
    store.getState().start(1)
    expect(store.getState().mode).toBe('time')
    vi.advanceTimersByTime(49_000)
    expect(setOutputVolume).not.toHaveBeenCalled()
    vi.advanceTimersByTime(5_000) // 5 s left
    const last = setOutputVolume.mock.calls.at(-1)![0] as number
    expect(last).toBeGreaterThan(0.4)
    expect(last).toBeLessThan(0.5)
    vi.advanceTimersByTime(6_000)
    expect(st.pause).toHaveBeenCalledTimes(1)
    expect(setOutputVolume).toHaveBeenLastCalledWith(0.8)
    expect(store.getState()).toMatchObject({ mode: 'off', deadline: null })
    expect(onFinished).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(5_000)
    expect(st.pause).toHaveBeenCalledTimes(1)
  })

  it('a throttled background timer cannot overshoot: the next tick (resume) catches up on the wall clock', () => {
    const { st, store } = setup()
    store.getState().start(5)
    vi.setSystemTime(Date.now() + 10 * 60_000) // device slept; no interval ticks ran
    store.getState().tick()
    expect(st.pause).toHaveBeenCalledTimes(1)
    expect(store.getState().mode).toBe('off')
  })

  it('player updates also drive it (audio timeupdate keeps firing in the background)', () => {
    const { st, store, listeners } = setup()
    store.getState().start(1)
    vi.setSystemTime(Date.now() + 61_000)
    listeners.forEach((l) => l())
    expect(st.pause).toHaveBeenCalledTimes(1)
  })

  it('cancel restores the volume and stops the loop', () => {
    const { st, store, setOutputVolume, listeners } = setup()
    store.getState().start(1)
    vi.advanceTimersByTime(55_000)
    store.getState().cancel()
    expect(setOutputVolume).toHaveBeenLastCalledWith(0.8)
    expect(listeners.size).toBe(0)
    vi.advanceTimersByTime(120_000)
    expect(st.pause).not.toHaveBeenCalled()
  })

  it('respects mute, only fades while playing, and ignores bad input', () => {
    const a = setup({ muted: true })
    a.store.getState().start(1)
    vi.advanceTimersByTime(55_000)
    expect(a.setOutputVolume).toHaveBeenLastCalledWith(0)
    const b = setup({ status: 'paused' })
    b.store.getState().start(1)
    vi.advanceTimersByTime(55_000)
    expect(b.setOutputVolume).not.toHaveBeenCalled()
    b.store.getState().start(0)
    b.store.getState().start(NaN)
    expect(b.store.getState().deadline).not.toBeNull()
  })

  it('starting a new timer replaces the previous one', () => {
    const { st, store } = setup()
    store.getState().start(1)
    store.getState().start(10)
    vi.advanceTimersByTime(90_000)
    expect(st.pause).not.toHaveBeenCalled()
  })
})

describe('sleep timer (end of track)', () => {
  it('arms the player, fades the last 10 s of the track and finishes when the player disarms', () => {
    const { st, store, setOutputVolume, onFinished } = setup({ position: 195, duration: 200 })
    store.getState().startEndOfTrack()
    expect(st.sleepAfterTrack).toBe(true)
    expect(st.pause).not.toHaveBeenCalled()
    store.getState().tick()
    expect(setOutputVolume.mock.calls.at(-1)![0]).toBeCloseTo(0.8 * 0.5, 1)
    st.position = 150
    store.getState().tick()
    expect(setOutputVolume).toHaveBeenLastCalledWith(0.8)
    st.sleepAfterTrack = false // the player paused at the end of the track
    store.getState().tick()
    expect(store.getState().mode).toBe('off')
    expect(onFinished).toHaveBeenCalled()
  })

  it('cancel disarms the player', () => {
    const { st, store } = setup()
    store.getState().startEndOfTrack()
    store.getState().cancel()
    expect(st.sleepAfterTrack).toBe(false)
    expect(store.getState().mode).toBe('off')
  })

  it('switching to a time timer disarms end-of-track', () => {
    const { st, store } = setup()
    store.getState().startEndOfTrack()
    store.getState().start(5)
    expect(st.sleepAfterTrack).toBe(false)
    expect(store.getState().mode).toBe('time')
  })
})
