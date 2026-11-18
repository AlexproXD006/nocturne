import { describe, expect, it, vi } from 'vitest'
import { createPlayerStore, type PlayerDeps } from '@/store/player'
import * as Q from '@/player/queue'
import { FakeEngine } from '../helpers/fake-engine'
import { flush } from '../helpers/http'
import { tracks, track } from '../helpers/fixtures'

function setup(over: Partial<PlayerDeps> = {}) {
  const engine = new FakeEngine()
  const autoplay = { on: true }
  const fetchAutoplay = vi.fn(async (_seed: string, _ex: string[]) => tracks(3, 'r'))
  const store = createPlayerStore({
    createEngine: (e) => ((engine.events = e), engine),
    resolveStream: async (id) => ({ url: `https://s/${id}`, expiresAt: new Date(Date.now() + 600_000).toISOString() }),
    getCrossfade: () => 0,
    getAutoplay: () => autoplay.on,
    fetchAutoplay,
    rng: () => 0,
    ...over
  })
  return { store, engine, autoplay, fetchAutoplay, s: () => store.getState() }
}

describe('queue autoplay helpers', () => {
  it('appends at the tail, flags items, skips duplicates, keeps sections apart', () => {
    let q = Q.createQueue(tracks(2), 0)
    q = Q.append(q, [track('u1')])
    q = Q.appendAutoplay(q, [track('t1'), track('r1'), track('r2'), track('r1')])
    expect(q.items.map((i) => i.track.id)).toEqual(['t0', 'u1', 't1', 'r1', 'r2'])
    expect(Q.autoplayUpcoming(q).map((i) => i.track.id)).toEqual(['r1', 'r2'])
    expect(Q.contextUpcoming(q).map((i) => i.track.id)).toEqual(['t1'])
    expect(Q.userUpcoming(q).map((i) => i.track.id)).toEqual(['u1'])
    expect(Q.clearContextUpcoming(q).items.map((i) => i.track.id)).toEqual(['t0', 'u1', 'r1', 'r2'])
    expect(Q.clearAutoplay(q).items.map((i) => i.track.id)).toEqual(['t0', 'u1', 't1'])
    expect(Q.clearUpcoming(q).items).toHaveLength(1)
  })

  it('isAtEnd and no-ops', () => {
    const q = Q.createQueue(tracks(2), 1)
    expect(Q.isAtEnd(q)).toBe(true)
    expect(Q.appendAutoplay(q, [])).toBe(q)
    expect(Q.appendAutoplay(Q.emptyQueue, tracks(1))).toBe(Q.emptyQueue)
    expect(Q.isAtEnd(Q.emptyQueue)).toBe(false)
  })

  it('shuffle keeps autoplay songs at the tail and un-shuffle restores the order', () => {
    let q = Q.createQueue(tracks(4), 0)
    q = Q.appendAutoplay(q, [track('r1'), track('r2')])
    const on = Q.setShuffle(q, true, () => 0)
    expect(on.items.slice(-2).map((i) => i.track.id)).toEqual(['r1', 'r2'])
    expect(on.items).toHaveLength(6)
    const off = Q.setShuffle(on, false)
    expect(off.items.map((i) => i.track.id)).toEqual(['t0', 't1', 't2', 't3', 'r1', 'r2'])
  })

  it('un-shuffling while an autoplay song plays keeps it current', () => {
    let q = Q.createQueue(tracks(2), 1)
    q = Q.appendAutoplay(q, [track('r1'), track('r2')])
    q = Q.setShuffle(q, true, () => 0)
    q = { ...q, index: q.items.findIndex((i) => i.track.id === 'r1') }
    const off = Q.setShuffle(q, false)
    expect(Q.currentItem(off)?.track.id).toBe('r1')
    expect(off.items.map((i) => i.track.id)).toContain('r2')
  })
})

describe('player autoplay', () => {
  it('fetches similar songs when the last song starts, seeded by it', async () => {
    const c = setup()
    await c.s().playTracks(tracks(2), 1)
    await flush()
    expect(c.fetchAutoplay).toHaveBeenCalledTimes(1)
    expect(c.fetchAutoplay).toHaveBeenCalledWith('t1', ['t0', 't1'])
    expect(Q.autoplayUpcoming(c.s().queue).map((i) => i.track.id)).toEqual(['r0', 'r1', 'r2'])
  })

  it('does nothing in the middle of a queue, with repeat on, or when disabled', async () => {
    const c = setup()
    await c.s().playTracks(tracks(3), 0)
    await flush()
    expect(c.fetchAutoplay).not.toHaveBeenCalled()
    const d = setup()
    d.s().setRepeat('all')
    await d.s().playTracks(tracks(1), 0)
    await flush()
    expect(d.fetchAutoplay).not.toHaveBeenCalled()
    const e = setup()
    e.autoplay.on = false
    await e.s().playTracks(tracks(1), 0)
    await flush()
    expect(e.fetchAutoplay).not.toHaveBeenCalled()
  })

  it('continues into the autoplay songs when the last song ends, and refills', async () => {
    const c = setup()
    await c.s().playTracks(tracks(1), 0)
    await flush()
    c.fetchAutoplay.mockResolvedValueOnce([track('n1')])
    c.engine.events.onEnded()
    await flush()
    expect(Q.currentItem(c.s().queue)?.track.id).toBe('r0')
    expect(c.s().queue.items[c.s().queue.index]!.autoplay).toBe(true)
  })

  it('fetches on demand when next() is pressed and the earlier fetch failed', async () => {
    const c = setup()
    c.fetchAutoplay.mockRejectedValueOnce(new Error('offline'))
    await c.s().playTracks(tracks(1), 0)
    await flush()
    expect(Q.autoplayUpcoming(c.s().queue)).toHaveLength(0)
    await c.s().next()
    expect(Q.currentItem(c.s().queue)?.track.id).toBe('r0')
  })

  it('drops a stale result (queue replaced while fetching) and survives empty results', async () => {
    const c = setup()
    let resolve!: (t: ReturnType<typeof tracks>) => void
    c.fetchAutoplay.mockImplementationOnce(() => new Promise((r) => (resolve = r)))
    await c.s().playTracks(tracks(1), 0)
    await c.s().playTracks(tracks(1, 'x'), 0)
    resolve(tracks(2, 'old'))
    await flush()
    expect(Q.autoplayUpcoming(c.s().queue).map((i) => i.track.id)).not.toContain('old0')
    const d = setup()
    d.fetchAutoplay.mockResolvedValue([])
    await d.s().playTracks(tracks(1), 0)
    await flush()
    await d.s().next()
    expect(d.s().queue.index).toBe(0)
  })

  it('clearAutoplay empties only that section', async () => {
    const c = setup()
    await c.s().playTracks(tracks(1), 0)
    await flush()
    c.s().clearAutoplay()
    expect(c.s().queue.items).toHaveLength(1)
  })
})

describe('sleep after track', () => {
  it('pauses at the end of the track, loads the next one paused and disarms', async () => {
    const c = setup({ getAutoplay: () => false })
    await c.s().playTracks(tracks(3), 0)
    c.engine.events.onPlaying()
    c.s().setSleepAfterTrack(true)
    c.engine.load.mockClear()
    c.engine.events.onEnded()
    await flush()
    expect(c.s().sleepAfterTrack).toBe(false)
    expect(Q.currentItem(c.s().queue)?.track.id).toBe('t1')
    expect(c.engine.load).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ autoplay: false }))
    expect(c.s().status).toBe('paused')
  })

  it('stays on the last track when the queue is over, and blocks crossfade while armed', async () => {
    const c = setup({ getAutoplay: () => false, getCrossfade: () => 5 })
    await c.s().playTracks(tracks(2), 0)
    c.engine.events.onPlaying()
    c.s().setSleepAfterTrack(true)
    c.engine.events.onTime(95, 100)
    await flush()
    expect(c.engine.crossfadeTo).not.toHaveBeenCalled()
    await c.s().next()
    c.s().setSleepAfterTrack(true)
    c.engine.events.onEnded()
    await flush()
    expect(c.s().status).toBe('paused')
    expect(c.s().position).toBe(0)
  })

  it('stop() disarms', async () => {
    const c = setup()
    await c.s().playTracks(tracks(2), 0)
    c.s().setSleepAfterTrack(true)
    c.s().stop()
    expect(c.s().sleepAfterTrack).toBe(false)
  })
})
