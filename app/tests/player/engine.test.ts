import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AudioEngine, type EngineEvents } from '@/player/engine'
import { domError, FakeAudio, FakeAudioContext } from '../helpers/fake-audio'

type Events = { [K in keyof EngineEvents]-?: ReturnType<typeof vi.fn> }

interface Setup {
  engine: AudioEngine
  els: FakeAudio[]
  events: Events
  ctx: () => FakeAudioContext
  active: () => FakeAudio
  standby: () => FakeAudio
}

function setup(opts: { reactive?: boolean; microFadeSec?: number } = {}): Setup {
  const els: FakeAudio[] = []
  const events: Events = {
    onTime: vi.fn(),
    onPlaying: vi.fn(),
    onPause: vi.fn(),
    onWaiting: vi.fn(),
    onEnded: vi.fn(),
    onError: vi.fn(),
    onReactiveChange: vi.fn()
  }
  const engine = new AudioEngine(events as unknown as EngineEvents, {
    createAudio: () => {
      const el = new FakeAudio()
      els.push(el)
      return el as unknown as HTMLAudioElement
    },
    AudioContextCtor: opts.reactive ? (FakeAudioContext as unknown as typeof AudioContext) : null,
    microFadeSec: opts.microFadeSec
  })
  const decks = (): { el: unknown }[] => engine['decks']
  const active = (): FakeAudio => decks()[engine['active']]!.el as FakeAudio
  const standby = (): FakeAudio => decks()[engine['active'] === 0 ? 1 : 0]!.el as FakeAudio
  return { engine, els, events, ctx: () => FakeAudioContext.instances.at(-1)!, active, standby }
}

/** Lets promise chains (play().then, fades) settle, advancing fake timers. */
async function settle(ms = 400): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] })
  FakeAudioContext.reset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('construction (plain mode)', () => {
  it('creates two preloading decks without CORS', () => {
    const { els } = setup()
    expect(els).toHaveLength(2)
    for (const el of els) {
      expect(el.preload).toBe('auto')
      expect(el.crossOrigin).toBeNull()
    }
  })

  it('starts idle', () => {
    const { engine } = setup()
    expect(engine.currentKey).toBeNull()
    expect(engine.currentTime).toBe(0)
    expect(engine.duration).toBe(0)
    expect(engine.paused).toBe(true)
    expect(engine.isTransitioning).toBe(false)
    expect(engine.reactive).toBe(false)
    expect(engine.frequencyBinCount).toBe(1024)
    expect(engine.sampleRate).toBe(44100)
  })

  it('defaults to the Audio constructor and global AudioContext when no options are given', () => {
    const created: unknown[] = []
    vi.stubGlobal('Audio', class extends FakeAudio { constructor() { super(); created.push(this) } })
    vi.stubGlobal('AudioContext', undefined)
    const e = new AudioEngine()
    expect(created).toHaveLength(2)
    expect(e.reactive).toBe(false)
    vi.unstubAllGlobals()
  })

  it('picks up a global AudioContext when the option is omitted', () => {
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('AudioContext', FakeAudioContext)
    const e = new AudioEngine()
    expect(e['decks'][0].el.crossOrigin).toBe('anonymous')
    vi.unstubAllGlobals()
  })
})

describe('load & playback (plain mode)', () => {
  it('loads a url, starts playing and reports playing', async () => {
    const { engine, events, active } = setup()
    engine.load('k1', 'https://s/1.mp3')
    await settle()
    const el = active()
    expect(el.src).toBe('https://s/1.mp3')
    expect(el.loadCalls).toBe(1)
    expect(el.playCalls).toBe(1)
    expect(engine.currentKey).toBe('k1')
    expect(events.onPlaying).toHaveBeenCalledTimes(1)
    expect(engine.paused).toBe(false)
  })

  it('fades in on start to avoid clicks (volume ramps from 0 to the master volume)', async () => {
    const { engine, active } = setup({ microFadeSec: 0.12 })
    engine.setVolume(0.5)
    engine.load('k1', 'u1')
    await vi.advanceTimersByTimeAsync(0)
    expect(active().volume).toBe(0)
    await settle(60)
    expect(active().volume).toBeGreaterThan(0)
    expect(active().volume).toBeLessThan(0.5)
    await settle(300)
    expect(active().volume).toBeCloseTo(0.5)
  })

  it('does not play with autoplay: false', async () => {
    const { engine, active, events } = setup()
    engine.load('k1', 'u1', { autoplay: false })
    await settle()
    expect(active().playCalls).toBe(0)
    expect(active().src).toBe('u1')
    expect(events.onPlaying).not.toHaveBeenCalled()
  })

  it('seeks to startAt once metadata is available', async () => {
    const { engine, active } = setup()
    engine.load('k1', 'u1', { startAt: 42 })
    expect(active().currentTime).toBe(0)
    active().emit('loadedmetadata')
    expect(active().currentTime).toBe(42)
  })

  it('seeks to startAt immediately when metadata is already available', () => {
    const { engine, active } = setup()
    active().readyState = 1
    engine.load('k1', 'u1', { startAt: 12.5 })
    expect(active().currentTime).toBe(12.5)
  })

  it('applies startAt only once', () => {
    const { engine, active } = setup()
    engine.load('k1', 'u1', { startAt: 10 })
    active().emit('loadedmetadata')
    active().currentTime = 99
    active().emit('loadedmetadata')
    expect(active().currentTime).toBe(99)
  })

  it('rewinds to 0 when loading without startAt', () => {
    const { engine, active } = setup()
    active().currentTime = 77
    engine.load('k1', 'u1')
    expect(active().currentTime).toBe(0)
    active().currentTime = 5
    engine.load('k2', 'u2', { startAt: 0 })
    expect(active().currentTime).toBe(0)
  })

  it('loading another track pauses the current one, then reuses the deck for the new source', async () => {
    const { engine, active } = setup()
    engine.load('k1', 'u1')
    await settle()
    const el = active()
    const pauses = el.pauseCalls
    engine.load('k2', 'u2')
    expect(el.pauseCalls).toBe(pauses + 1)
    expect(el.src).toBe('u2')
    expect(engine.currentKey).toBe('k2')
  })

  it('surfaces autoplay blocking as a friendly message', async () => {
    const { engine, active, events, els } = setup()
    els.forEach((e) => (e.playError = domError('NotAllowedError')))
    engine.load('k1', 'u1')
    await settle()
    expect(events.onError).toHaveBeenCalledWith('Press play to start listening.')
    expect(active().paused).toBe(true)
  })

  it('ignores AbortError from interrupted play() calls', async () => {
    const { engine, events, els } = setup()
    els.forEach((e) => (e.playError = domError('AbortError')))
    engine.load('k1', 'u1')
    await settle()
    expect(events.onError).not.toHaveBeenCalled()
  })

  it('leaves other play() errors to the element error event', async () => {
    const { engine, events, els } = setup()
    els.forEach((e) => (e.playError = domError('NotSupportedError')))
    engine.load('k1', 'u1')
    await settle()
    expect(events.onError).not.toHaveBeenCalled()
  })

  it('a newer load invalidates the previous start (stale play results are ignored)', async () => {
    const { engine, events, els } = setup()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    els[0]!.playGate = gate
    els[0]!.playError = domError('NotAllowedError')
    engine.load('k1', 'u1') // its play() will fail once the gate opens...
    els[0]!.playGate = null
    els[0]!.playError = null
    engine.load('k2', 'u2') // ...but a newer load bumped the token
    release()
    await settle()
    expect(events.onError).not.toHaveBeenCalled()
  })
})

describe('events', () => {
  it('forwards time updates with finite durations', async () => {
    const { engine, active, events } = setup()
    engine.load('k', 'u', { autoplay: false })
    active().currentTime = 12
    active().duration = 200
    active().emit('timeupdate')
    expect(events.onTime).toHaveBeenLastCalledWith(12, 200)
    active().duration = Number.POSITIVE_INFINITY
    active().emit('durationchange')
    expect(events.onTime).toHaveBeenLastCalledWith(12, 0)
    active().duration = Number.NaN
    active().emit('timeupdate')
    expect(events.onTime).toHaveBeenLastCalledWith(12, 0)
  })

  it('forwards waiting, ended and pause', async () => {
    const { engine, active, events } = setup()
    engine.load('k', 'u', { autoplay: false })
    active().emit('waiting')
    expect(events.onWaiting).toHaveBeenCalledOnce()
    active().emit('ended')
    expect(events.onEnded).toHaveBeenCalledOnce()
    active().emit('pause')
    expect(events.onPause).toHaveBeenCalledOnce()
  })

  it('does not report pause when the pause is caused by the track ending', () => {
    const { engine, active, events } = setup()
    engine.load('k', 'u', { autoplay: false })
    active().ended = true
    active().emit('pause')
    expect(events.onPause).not.toHaveBeenCalled()
  })

  it('ignores events from the standby deck', () => {
    const { engine, standby, events } = setup()
    engine.load('k', 'u', { autoplay: false })
    for (const type of ['timeupdate', 'durationchange', 'playing', 'pause', 'waiting', 'ended']) standby().emit(type)
    expect(events.onTime).not.toHaveBeenCalled()
    expect(events.onPlaying).not.toHaveBeenCalled()
    expect(events.onPause).not.toHaveBeenCalled()
    expect(events.onWaiting).not.toHaveBeenCalled()
    expect(events.onEnded).not.toHaveBeenCalled()
  })

  it('canplay is accepted without side effects', () => {
    const { engine, active, events } = setup()
    engine.load('k', 'u', { autoplay: false })
    active().emit('canplay')
    expect(Object.values(events).every((f) => f.mock.calls.length === 0)).toBe(true)
  })
})

describe('preload & gapless', () => {
  it('preloads on the standby deck', () => {
    const { engine, active, standby } = setup()
    engine.load('k1', 'u1', { autoplay: false })
    engine.preload('k2', 'u2')
    expect(standby().src).toBe('u2')
    expect(standby().loadCalls).toBe(1)
    expect(active().src).toBe('u1')
    expect(engine.hasPreloaded('k2')).toBe(true)
    expect(engine.hasPreloaded('k3')).toBe(false)
    expect(engine.currentKey).toBe('k1')
  })

  it('preloading the same key again is a no-op', () => {
    const { engine, standby } = setup()
    engine.preload('k2', 'u2')
    engine.preload('k2', 'u2')
    expect(standby().loadCalls).toBe(1)
  })

  it('preloading another key replaces the standby content', () => {
    const { engine, standby } = setup()
    engine.preload('k2', 'u2')
    engine.preload('k3', 'u3')
    expect(standby().src).toBe('u3')
    expect(engine.hasPreloaded('k2')).toBe(false)
    expect(engine.hasPreloaded('k3')).toBe(true)
  })

  it('load() reuses the preloaded standby deck without reloading (gapless swap)', async () => {
    const { engine, els, active, events } = setup()
    engine.load('k1', 'u1')
    await settle()
    const first = active()
    engine.preload('k2', 'u2')
    const second = els.find((e) => e !== first)!
    expect(second.loadCalls).toBe(1)

    engine.load('k2', 'ignored-url')
    expect(active()).toBe(second)
    expect(second.src).toBe('u2') // not replaced
    expect(second.loadCalls).toBe(1) // not reloaded
    expect(engine.currentKey).toBe('k2')
    expect(first.paused).toBe(true)
    expect(engine.hasPreloaded('k2')).toBe(false)
    await settle()
    expect(second.playCalls).toBe(1)
    expect(events.onPlaying).toHaveBeenCalledTimes(2)
    // events from the outgoing deck no longer leak
    events.onTime.mockClear()
    first.emit('timeupdate')
    expect(events.onTime).not.toHaveBeenCalled()
  })

  it('the old deck is free to take the next preload after a swap', async () => {
    const { engine, els, active, standby } = setup()
    engine.load('k1', 'u1')
    engine.preload('k2', 'u2')
    engine.load('k2', 'u2')
    engine.preload('k3', 'u3')
    expect(standby().src).toBe('u3')
    expect(standby()).not.toBe(active())
    expect(els).toHaveLength(2)
  })

  it('does not preload during a crossfade', async () => {
    const { engine, standby } = setup()
    engine.load('k1', 'u1')
    await settle()
    engine.preload('k2', 'u2')
    engine.crossfadeTo('k2', 'u2', 2)
    const loads = engine['decks'].map((d) => (d.el as unknown as FakeAudio).loadCalls)
    engine.preload('k3', 'u3')
    expect(engine['decks'].map((d) => (d.el as unknown as FakeAudio).loadCalls)).toEqual(loads)
    expect(standby().src).not.toBe('u3')
  })

  it('a preload error is forgotten and does not surface', async () => {
    const { engine, standby, events } = setup()
    engine.load('k1', 'u1', { autoplay: false })
    engine.preload('k2', 'u2')
    standby().error = { code: 4 }
    standby().emit('error')
    expect(events.onError).not.toHaveBeenCalled()
    expect(engine.hasPreloaded('k2')).toBe(false)
  })
})

describe('crossfade (plain mode)', () => {
  it('starts the next track on the other deck and swaps the active deck', async () => {
    const { engine, active, events } = setup()
    engine.load('k1', 'u1')
    await settle()
    const outgoing = active()
    engine.crossfadeTo('k2', 'u2', 2)
    expect(engine.isTransitioning).toBe(true)
    const incoming = active()
    expect(incoming).not.toBe(outgoing)
    expect(incoming.src).toBe('u2')
    expect(engine.currentKey).toBe('k2')
    await settle(10)
    expect(incoming.playCalls).toBe(1)
    expect(outgoing.paused).toBe(false) // still audible while fading out
    // outgoing 'pause' events never leak
    expect(events.onPause).not.toHaveBeenCalled()
  })

  it('fades volumes in opposite directions and pauses the outgoing deck after the fade', async () => {
    const { engine, active } = setup()
    engine.setVolume(1)
    engine.load('k1', 'u1')
    await settle()
    const outgoing = active()
    engine.crossfadeTo('k2', 'u2', 2)
    const incoming = active()
    await settle(1000)
    expect(incoming.volume).toBeGreaterThan(0.3)
    expect(incoming.volume).toBeLessThan(0.7)
    expect(outgoing.volume).toBeGreaterThan(0.3)
    expect(outgoing.volume).toBeLessThan(0.7)
    expect(engine.isTransitioning).toBe(true)
    await settle(1300)
    expect(incoming.volume).toBeCloseTo(1)
    expect(outgoing.paused).toBe(true)
    expect(engine.isTransitioning).toBe(false)
    expect(engine.currentKey).toBe('k2')
  })

  it('reuses a preloaded standby deck instead of reloading', async () => {
    const { engine, standby } = setup()
    engine.load('k1', 'u1')
    await settle()
    engine.preload('k2', 'u2')
    const target = standby()
    const loads = target.loadCalls
    engine.crossfadeTo('k2', 'ignored', 1)
    expect(target.loadCalls).toBe(loads)
    expect(target.src).toBe('u2')
  })

  it('ignores a second crossfade while one is running', async () => {
    const { engine, active } = setup()
    engine.load('k1', 'u1')
    await settle()
    engine.crossfadeTo('k2', 'u2', 2)
    const incoming = active()
    engine.crossfadeTo('k3', 'u3', 2)
    expect(active()).toBe(incoming)
    expect(engine.currentKey).toBe('k2')
  })

  it('reports blocked playback and resets the transition state', async () => {
    const { engine, events, standby } = setup()
    engine.load('k1', 'u1')
    await settle()
    standby().playError = domError('NotAllowedError')
    engine.crossfadeTo('k2', 'u2', 2)
    await settle(10)
    expect(events.onError).toHaveBeenCalledWith('Playback was blocked by the system.')
    expect(engine.isTransitioning).toBe(false)
  })

  it('load() during a crossfade cancels it', async () => {
    const { engine, active } = setup()
    engine.load('k1', 'u1')
    await settle()
    engine.crossfadeTo('k2', 'u2', 2)
    engine.load('k3', 'u3')
    expect(engine.isTransitioning).toBe(false)
    await settle(3000)
    expect(engine.currentKey).toBe('k3')
    expect(active().src).toBe('u3')
  })

  it('pause() during a crossfade silences both decks', async () => {
    const { engine, els } = setup()
    engine.load('k1', 'u1')
    await settle()
    engine.crossfadeTo('k2', 'u2', 4)
    await settle(100)
    const p = engine.pause()
    await settle(400)
    await p
    expect(els.every((e) => e.paused)).toBe(true)
    expect(engine.isTransitioning).toBe(false)
  })

  it('seek and stop work mid-fade', async () => {
    const { engine, els } = setup()
    engine.load('k1', 'u1')
    await settle()
    engine.crossfadeTo('k2', 'u2', 4)
    engine.stop()
    expect(engine.isTransitioning).toBe(false)
    await settle(5000)
    expect(els.every((e) => e.paused)).toBe(true)
    expect(engine.currentKey).toBeNull()
  })
})

describe('pause / play', () => {
  it('pauses after a short fade-out and reports pause', async () => {
    const { engine, active, events } = setup()
    engine.load('k', 'u')
    await settle()
    const p = engine.pause()
    expect(active().paused).toBe(false) // still fading
    await settle(300)
    await p
    expect(active().paused).toBe(true)
    expect(events.onPause).toHaveBeenCalledOnce()
  })

  it('pause when already paused is a no-op', async () => {
    const { engine, events } = setup()
    engine.load('k', 'u', { autoplay: false })
    await engine.pause()
    expect(events.onPause).not.toHaveBeenCalled()
  })

  it('play resumes a paused track and fades back in', async () => {
    const { engine, active } = setup()
    engine.load('k', 'u')
    await settle()
    void engine.pause()
    await settle(300)
    const playing = engine.play()
    await settle(400)
    await playing
    expect(active().paused).toBe(false)
    expect(active().volume).toBeCloseTo(1)
  })

  it('play without a loaded track does nothing', async () => {
    const { engine, els } = setup()
    await engine.play()
    expect(els.every((e) => e.playCalls === 0)).toBe(true)
  })

  it('play() while a pause fade is running cancels the pause', async () => {
    const { engine, active } = setup()
    engine.load('k', 'u')
    await settle()
    void engine.pause()
    await settle(40)
    const playing = engine.play()
    await settle(500)
    await playing
    expect(active().paused).toBe(false)
  })

  it('pause() right after pause() only applies the latest token', async () => {
    const { engine, active } = setup()
    engine.load('k', 'u')
    await settle()
    void engine.pause()
    const second = engine.pause()
    await settle(500)
    await second
    expect(active().paused).toBe(true)
  })
})

describe('seek', () => {
  it('sets the time and reports it', async () => {
    const { engine, active, events } = setup()
    engine.load('k', 'u', { autoplay: false })
    active().duration = 100
    engine.seek(30)
    expect(active().currentTime).toBe(30)
    expect(events.onTime).toHaveBeenLastCalledWith(30, 100)
  })

  it('clamps to [0, duration - 0.05]', () => {
    const { engine, active } = setup()
    engine.load('k', 'u', { autoplay: false })
    active().duration = 100
    engine.seek(250)
    expect(active().currentTime).toBeCloseTo(99.95)
    engine.seek(-10)
    expect(active().currentTime).toBe(0)
  })

  it('does not upper-clamp when the duration is unknown', () => {
    const { engine, active } = setup()
    engine.load('k', 'u', { autoplay: false })
    engine.seek(500)
    expect(active().currentTime).toBe(500)
    engine.seek(-1)
    expect(active().currentTime).toBe(0)
  })
})

describe('volume', () => {
  it('clamps to 0..1 and applies to both decks in plain mode', () => {
    const { engine, els } = setup()
    engine.setVolume(0.3)
    expect(els.map((e) => e.volume)).toEqual([0.3, 0.3])
    engine.setVolume(5)
    expect(els.map((e) => e.volume)).toEqual([1, 1])
    engine.setVolume(-2)
    expect(els.map((e) => e.volume)).toEqual([0, 0])
  })

  it('ignores non-finite values', () => {
    const { engine, els } = setup()
    engine.setVolume(0.4)
    engine.setVolume(Number.NaN)
    engine.setVolume(Number.POSITIVE_INFINITY)
    expect(els[0]!.volume).toBe(0.4)
  })

  it('a deck volume is volume x fade level', async () => {
    const { engine, standby } = setup()
    engine.setVolume(0.5)
    engine.load('k1', 'u1')
    await settle()
    engine.crossfadeTo('k2', 'u2', 2)
    await settle(10)
    // incoming (the active one) starts silent
    expect(engine['decks'][engine['active']]!.el.volume).toBeLessThan(0.1)
    expect(standby().volume).toBeGreaterThan(0.4)
  })
})

describe('stop', () => {
  it('pauses both decks, forgets the tracks and clears sources', async () => {
    const { engine, els } = setup()
    engine.load('k1', 'u1')
    engine.preload('k2', 'u2')
    await settle()
    engine.stop()
    expect(els.every((e) => e.paused && e.srcRemoved)).toBe(true)
    expect(engine.currentKey).toBeNull()
    expect(engine.hasPreloaded('k2')).toBe(false)
  })

  it('cancels a pending start', async () => {
    const { engine, events, els } = setup()
    els.forEach((e) => (e.playError = domError('NotAllowedError')))
    engine.load('k', 'u')
    engine.stop()
    await settle()
    expect(events.onError).not.toHaveBeenCalled()
  })
})

describe('errors (plain mode)', () => {
  it.each([
    [2, 'Network error while streaming.'],
    [3, 'This track could not be decoded.'],
    [4, "This track can't be played (unsupported format or link expired)."],
    [1, 'Playback failed.'],
    [undefined, 'Playback failed.']
  ])('maps media error code %s', (code, message) => {
    const { engine, active, events } = setup()
    engine.load('k', 'u', { autoplay: false })
    active().error = code === undefined ? null : { code }
    active().emit('error')
    expect(events.onError).toHaveBeenCalledWith(message)
  })

  it('ignores errors on a deck without a source', () => {
    const { engine, events, els } = setup()
    els[0]!.emit('error')
    els[1]!.emit('error')
    expect(events.onError).not.toHaveBeenCalled()
    expect(engine.currentKey).toBeNull()
  })

  it('does not rebuild decks in plain mode', () => {
    const { engine, active, els } = setup()
    engine.load('k', 'u', { autoplay: false })
    active().error = { code: 4 }
    active().emit('error')
    expect(els).toHaveLength(2)
  })
})

describe('getFrequencyData', () => {
  it('returns false without an analyser and leaves the buffer untouched', () => {
    const { engine } = setup()
    const out = new Uint8Array(8)
    expect(engine.getFrequencyData(out)).toBe(false)
    expect([...out]).toEqual(new Array(8).fill(0))
  })
})

describe('destroy', () => {
  it('detaches listeners and silences the decks', async () => {
    const { engine, els, events } = setup()
    engine.load('k', 'u')
    await settle()
    engine.destroy()
    events.onTime.mockClear()
    els[0]!.emit('timeupdate')
    els[1]!.emit('timeupdate')
    expect(events.onTime).not.toHaveBeenCalled()
    expect(els.every((e) => e.paused)).toBe(true)
  })

  it('is safe to call twice', () => {
    const { engine } = setup()
    engine.destroy()
    expect(() => engine.destroy()).not.toThrow()
  })
})

describe('reactive mode (Web Audio)', () => {
  it('requests CORS on both decks and builds the graph lazily on first load', () => {
    const { engine, els, events } = setup({ reactive: true })
    expect(els.every((e) => e.crossOrigin === 'anonymous')).toBe(true)
    expect(FakeAudioContext.instances).toHaveLength(0)
    expect(engine.reactive).toBe(false)
    engine.load('k', 'u', { autoplay: false })
    expect(FakeAudioContext.instances).toHaveLength(1)
    expect(engine.reactive).toBe(true)
    expect(events.onReactiveChange).toHaveBeenCalledWith(true)
  })

  it('wires master gain -> analyser -> destination and each deck source -> gain -> master', () => {
    const { engine, ctx } = setup({ reactive: true })
    engine.setVolume(0.6)
    engine.load('k', 'u', { autoplay: false })
    const c = ctx()
    expect((c.options as { latencyHint: string }).latencyHint).toBe('playback')
    const analyser = c.analysers[0]!
    expect(analyser.fftSize).toBe(2048)
    expect(analyser.smoothingTimeConstant).toBe(0.78)
    expect(analyser.connect).toHaveBeenCalledWith(c.destination)
    const master = c.gains[0]!
    expect(master.gain.value).toBe(0.6)
    expect(master.connect).toHaveBeenCalledWith(analyser)
    expect(c.sources).toHaveLength(2)
    for (let i = 0; i < 2; i++) {
      const gain = c.gains[i + 1]!
      expect(c.sources[i]!.connect).toHaveBeenCalledWith(gain)
      expect(gain.connect).toHaveBeenCalledWith(master)
    }
  })

  it('creates the graph only once', () => {
    const { engine } = setup({ reactive: true })
    engine.load('k1', 'u1', { autoplay: false })
    engine.load('k2', 'u2', { autoplay: false })
    expect(FakeAudioContext.instances).toHaveLength(1)
  })

  it('exposes analyser data, bin count and sample rate', () => {
    const { engine } = setup({ reactive: true })
    engine.load('k', 'u', { autoplay: false })
    const out = new Uint8Array(4)
    expect(engine.getFrequencyData(out as Uint8Array<ArrayBuffer>)).toBe(true)
    expect([...out]).toEqual([7, 7, 7, 7])
    expect(engine.frequencyBinCount).toBe(1024)
    expect(engine.sampleRate).toBe(48000)
  })

  it('resumes a suspended context before playing', async () => {
    const { engine, ctx } = setup({ reactive: true })
    engine.load('k', 'u', { autoplay: false })
    ctx().state = 'suspended'
    const p = engine.play()
    await settle()
    await p
    expect(ctx().resume).toHaveBeenCalledOnce()
  })

  it('sets the element volume to 1 and uses the master gain for loudness', () => {
    const { engine, els, ctx } = setup({ reactive: true })
    engine.load('k', 'u', { autoplay: false })
    engine.setVolume(0.25)
    expect(els.every((e) => e.volume === 1)).toBe(true)
    expect(ctx().gains[0]!.gain.setTargetAtTime).toHaveBeenCalledWith(0.25, 5, 0.015)
  })

  it('fades through gain automation on start', async () => {
    const { engine, ctx } = setup({ reactive: true, microFadeSec: 0.12 })
    engine.load('k', 'u')
    await settle(500)
    const deckGain = ctx().gains[1]!.gain
    expect(deckGain.setValueAtTime).toHaveBeenCalled()
    expect(deckGain.linearRampToValueAtTime).toHaveBeenCalledWith(1, 5 + 0.12)
  })

  it('crossfades via gain ramps and pauses the outgoing deck afterwards', async () => {
    const { engine, ctx, active } = setup({ reactive: true })
    engine.load('k1', 'u1')
    await settle()
    const outgoing = active()
    engine.crossfadeTo('k2', 'u2', 3)
    await settle(10)
    const ramps = ctx().gains.slice(1).flatMap((g) => g.gain.linearRampToValueAtTime.mock.calls.filter((c) => c[1] === 5 + 3))
    expect(ramps.map((c) => c[0]).sort()).toEqual([0, 1])
    expect(outgoing.paused).toBe(false)
    await settle(3100)
    expect(outgoing.paused).toBe(true)
    expect(engine.isTransitioning).toBe(false)
  })

  it('falls back to plain mode and clears CORS when the AudioContext cannot be created', async () => {
    const { engine, els, events, active } = setup({ reactive: true })
    FakeAudioContext.throwOnConstruct = true
    engine.load('k', 'u')
    await settle()
    expect(engine.reactive).toBe(false)
    expect(events.onReactiveChange).not.toHaveBeenCalledWith(true)
    expect(els.every((e) => e.crossOrigin === null)).toBe(true)
    expect(active().playCalls).toBe(1)
    // a later element error is a real error, not a CORS problem
    active().error = { code: 4 }
    active().emit('error')
    expect(events.onError).toHaveBeenCalledWith(expect.stringContaining("can't be played"))
    expect(els).toHaveLength(2)
  })

  it('destroy disconnects the graph and closes the context', () => {
    const { engine, ctx } = setup({ reactive: true })
    engine.load('k', 'u', { autoplay: false })
    const c = ctx()
    engine.destroy()
    expect(c.close).toHaveBeenCalled()
    expect(c.sources.every((s) => s.disconnect.mock.calls.length === 1)).toBe(true)
  })
})

describe('CORS fallback (reactive -> plain)', () => {
  it('rebuilds in plain mode and reloads at the same position on the first error', async () => {
    const { engine, els, events, ctx, active } = setup({ reactive: true })
    engine.load('k1', 'https://s/1.mp3')
    await settle()
    const failing = active()
    failing.currentTime = 42
    failing.error = { code: 4 }
    const firstCtx = ctx()

    failing.emit('error')

    // new decks, graph torn down, plain mode
    expect(els).toHaveLength(4)
    expect(firstCtx.close).toHaveBeenCalled()
    expect(engine.reactive).toBe(false)
    expect(events.onReactiveChange).toHaveBeenLastCalledWith(false)
    expect(events.onError).not.toHaveBeenCalled()
    const fresh = active()
    expect(fresh).not.toBe(failing)
    expect(els.slice(2).every((e) => e.crossOrigin === null)).toBe(true)
    // old decks are disposed
    expect(failing.srcRemoved).toBe(true)
    // reloaded on the same key / url, resuming at 42s
    expect(engine.currentKey).toBe('k1')
    expect(fresh.src).toBe('https://s/1.mp3')
    fresh.emit('loadedmetadata')
    expect(fresh.currentTime).toBe(42)
    await settle()
    expect(fresh.playCalls).toBe(1)
    // no second AudioContext is created in plain mode
    expect(FakeAudioContext.instances).toHaveLength(1)
  })

  it('does not forward events from the disposed decks', async () => {
    const { engine, active, events } = setup({ reactive: true })
    engine.load('k1', 'u1')
    await settle()
    const failing = active()
    failing.error = { code: 4 }
    failing.emit('error')
    events.onTime.mockClear()
    failing.emit('timeupdate')
    expect(events.onTime).not.toHaveBeenCalled()
  })

  it('reports onError when the plain retry fails too (a second error)', async () => {
    const { engine, els, events, active } = setup({ reactive: true })
    engine.load('k1', 'u1')
    await settle()
    const first = active()
    first.error = { code: 4 }
    first.emit('error')
    await settle()

    const second = active()
    second.error = { code: 2 }
    second.emit('error')

    expect(events.onError).toHaveBeenCalledTimes(1)
    expect(events.onError).toHaveBeenCalledWith('Network error while streaming.')
    // the engine goes back to being ready for reactive playback of the next track
    expect(els).toHaveLength(6)
    expect(engine.currentKey).toBeNull()
  })

  it('a successful canplay after fallback clears the probe, so later errors are reported directly', async () => {
    const { engine, els, events, active } = setup({ reactive: true })
    engine.load('k1', 'u1')
    await settle()
    active().error = { code: 4 }
    active().emit('error')
    await settle()
    active().emit('canplay')

    active().error = { code: 3 }
    active().emit('error')
    expect(events.onError).toHaveBeenCalledWith('This track could not be decoded.')
    expect(els).toHaveLength(4) // no further rebuild
  })

  it('a canplay on the standby deck does not clear the probe', async () => {
    const { engine, events, active, standby } = setup({ reactive: true })
    engine.load('k1', 'u1')
    await settle()
    active().error = { code: 4 }
    active().emit('error')
    await settle()
    standby().emit('canplay')
    active().error = { code: 4 }
    active().emit('error')
    expect(events.onError).toHaveBeenCalledOnce()
  })

  it('preload errors in reactive mode do not trigger the fallback', async () => {
    const { engine, els, events, standby } = setup({ reactive: true })
    engine.load('k1', 'u1', { autoplay: false })
    engine.preload('k2', 'u2')
    standby().error = { code: 4 }
    standby().emit('error')
    expect(els).toHaveLength(2)
    expect(events.onError).not.toHaveBeenCalled()
    expect(engine.reactive).toBe(true)
  })

  it('can play again in reactive mode after a failed fallback cycle', async () => {
    const { engine, events, ctx, active } = setup({ reactive: true })
    engine.load('k1', 'u1')
    await settle()
    active().error = { code: 4 }
    active().emit('error')
    await settle()
    active().error = { code: 4 }
    active().emit('error')
    engine.load('k2', 'u2')
    await settle()
    expect(FakeAudioContext.instances).toHaveLength(2)
    expect(engine.reactive).toBe(true)
    expect(ctx().state).toBe('running')
    expect(events.onReactiveChange).toHaveBeenLastCalledWith(true)
  })
})
