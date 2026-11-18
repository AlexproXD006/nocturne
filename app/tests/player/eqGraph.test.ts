import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dbToLinear, EqGraph } from '@/player/eqGraph'
import { AudioEngine } from '@/player/engine'
import { DEFAULT_EQ, EQ_BANDS, type EqState } from '@/lib/eq'
import { FakeAudio, FakeAudioContext, FakeGain } from '../helpers/fake-audio'

const state = (over: Partial<EqState> = {}): EqState => ({ ...DEFAULT_EQ, gains: [...DEFAULT_EQ.gains], ...over })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] })
  FakeAudioContext.reset()
})
afterEach(() => vi.useRealTimers())

function build() {
  const ctx = new FakeAudioContext()
  const input = new FakeGain()
  const output = new FakeGain()
  const graph = new EqGraph(ctx as unknown as AudioContext, input as unknown as AudioNode, output as unknown as AudioNode)
  return { ctx, input, output, graph }
}

describe('EqGraph construction', () => {
  it('creates 10 filters (shelf, 8 peaking, shelf) at the band centres with Q 1, chained into the preamp', () => {
    const { ctx, graph } = build()
    expect(ctx.filters).toHaveLength(10)
    expect(ctx.filters.map((f) => f.type)).toEqual(['lowshelf', ...new Array<string>(8).fill('peaking'), 'highshelf'])
    expect(ctx.filters.map((f) => f.frequency.value)).toEqual([...EQ_BANDS])
    expect(ctx.filters.every((f) => f.Q.value === 1 && f.gain.value === 0)).toBe(true)
    for (let i = 0; i < 9; i++) expect(ctx.filters[i]!.connect).toHaveBeenCalledWith(ctx.filters[i + 1])
    expect(ctx.filters[9]!.connect).toHaveBeenCalledWith(graph.preampNode)
    expect(graph.preampNode.connect).toHaveBeenCalled()
  })
  it('starts bypassed: input is wired straight to the output', () => {
    const { input, output, graph } = build()
    expect(graph.isBypassed).toBe(true)
    expect(input.connect).toHaveBeenCalledWith(output)
  })
})

describe('EqGraph parameters and bypass', () => {
  it('engages the filters and smooths band gains and the preamp', () => {
    const { ctx, input, output, graph } = build()
    const gains = [6, 0, 0, 0, 0, 3, 0, 0, 0, -4]
    graph.apply(state({ preamp: -6, gains }))
    expect(graph.isBypassed).toBe(false)
    expect(input.connect).toHaveBeenCalledWith(ctx.filters[0])
    expect(input.disconnect).toHaveBeenCalledWith(output)
    gains.forEach((g, i) => expect(ctx.filters[i]!.gain.setTargetAtTime).toHaveBeenLastCalledWith(g, ctx.currentTime, expect.any(Number)))
    const call = (graph.preampNode.gain.setTargetAtTime as ReturnType<typeof vi.fn>).mock.calls.at(-1)!
    expect(call[0]).toBeCloseTo(dbToLinear(-6), 6)
  })
  it('clamps out-of-range values', () => {
    const { ctx, graph } = build()
    graph.apply(state({ preamp: 99, gains: [99, -99, 0, 0, 0, 0, 0, 0, 0, 0] }))
    expect(ctx.filters[0]!.gain.setTargetAtTime).toHaveBeenLastCalledWith(12, expect.any(Number), expect.any(Number))
    expect(ctx.filters[1]!.gain.setTargetAtTime).toHaveBeenLastCalledWith(-12, expect.any(Number), expect.any(Number))
    expect((graph.preampNode.gain.setTargetAtTime as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]).toBeCloseTo(dbToLinear(6), 6)
  })
  it('disabled: flattens first, then routes around the filters (bypass)', () => {
    const { ctx, input, output, graph } = build()
    graph.apply(state({ preamp: -3, gains: [6, 6, 6, 6, 6, 6, 6, 6, 6, 6] }))
    input.connect.mockClear()
    input.disconnect.mockClear()
    graph.apply(state({ enabled: false, preamp: -3, gains: [6, 6, 6, 6, 6, 6, 6, 6, 6, 6] }))
    expect(ctx.filters.every((f) => (f.gain.setTargetAtTime as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] === 0)).toBe(true)
    expect((graph.preampNode.gain.setTargetAtTime as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]).toBe(1)
    expect(graph.isBypassed).toBe(false) // still settling: no click
    vi.advanceTimersByTime(200)
    expect(graph.isBypassed).toBe(true)
    expect(input.connect).toHaveBeenCalledWith(output)
    expect(input.disconnect).toHaveBeenCalledWith(ctx.filters[0])
  })
  it('re-enabling before the settle timer cancels the bypass', () => {
    const { graph } = build()
    graph.apply(state({ gains: [3, 0, 0, 0, 0, 0, 0, 0, 0, 0] }))
    graph.apply(state({ enabled: false }))
    graph.apply(state({ gains: [3, 0, 0, 0, 0, 0, 0, 0, 0, 0] }))
    vi.advanceTimersByTime(500)
    expect(graph.isBypassed).toBe(false)
  })
  it('destroy disconnects everything', () => {
    const { ctx, graph } = build()
    graph.destroy()
    expect(ctx.filters.every((f) => f.disconnect.mock.calls.length > 0)).toBe(true)
  })
})

describe('AudioEngine integration', () => {
  function engine() {
    const els: FakeAudio[] = []
    const e = new AudioEngine({}, {
      createAudio: () => {
        const el = new FakeAudio()
        els.push(el)
        return el as unknown as HTMLAudioElement
      },
      AudioContextCtor: FakeAudioContext as unknown as typeof AudioContext
    })
    return { e, els, ctx: () => FakeAudioContext.instances.at(-1)! }
  }

  it('builds the equalizer lazily with the audio graph, between master gain and analyser', () => {
    const { e, ctx } = engine()
    e.setEq(state({ gains: [4, 0, 0, 0, 0, 0, 0, 0, 0, 0], preamp: -4 })) // before the graph exists: remembered
    expect(FakeAudioContext.instances).toHaveLength(0)
    e.load('k', 'u', { autoplay: false })
    const c = ctx()
    expect(c.filters).toHaveLength(10)
    const master = c.gains[0]!
    expect(master.connect).toHaveBeenCalledWith(c.filters[0])
    expect(c.filters[0]!.gain.setTargetAtTime).toHaveBeenLastCalledWith(4, expect.any(Number), expect.any(Number))
    expect(c.analysers[0]!.connect).toHaveBeenCalledWith(c.destination)
    expect(e.eqActive).toBe(true)
  })

  it('routes both decks (crossfade) through the same graph', () => {
    const { e, ctx } = engine()
    e.load('a', 'u', { autoplay: false })
    const c = ctx()
    expect(c.sources).toHaveLength(2)
    const master = c.gains[0]!
    for (const gain of [c.gains[1]!, c.gains[2]!]) expect(gain.connect).toHaveBeenCalledWith(master)
    expect(c.filters).toHaveLength(10) // one equalizer, not one per deck
  })

  it('bypasses when disabled and updates live', () => {
    const { e, ctx } = engine()
    e.load('k', 'u', { autoplay: false })
    e.setEq(state({ gains: [0, 0, 0, 0, 0, 5, 0, 0, 0, 0] }))
    expect(e.eqActive).toBe(true)
    expect(ctx().filters[5]!.gain.setTargetAtTime).toHaveBeenLastCalledWith(5, expect.any(Number), expect.any(Number))
    e.setEq(state({ enabled: false }))
    vi.advanceTimersByTime(300)
    expect(e.eqActive).toBe(false)
  })

  it('is a no-op without Web Audio', () => {
    const e = new AudioEngine({}, { createAudio: () => new FakeAudio() as unknown as HTMLAudioElement, AudioContextCtor: null })
    e.setEq(state({ preamp: -3 }))
    e.load('k', 'u', { autoplay: false })
    expect(e.eqActive).toBe(false)
  })
})
