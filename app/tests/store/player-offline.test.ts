import { describe, expect, it, vi } from 'vitest'
import { createPlayerStore } from '@/store/player'
import type { StreamInfo } from '@/api/types'
import { currentItem } from '@/player/queue'
import { FakeEngine } from '../helpers/fake-engine'
import { tracks } from '../helpers/fixtures'

function setup(playable: (id: string) => boolean) {
  const engine = new FakeEngine()
  const nothing = vi.fn()
  const started = vi.fn()
  const store = createPlayerStore({
    createEngine: (events) => {
      engine.events = events
      return engine
    },
    resolveStream: vi.fn(async (id: string): Promise<StreamInfo> => ({ url: `https://s/${id}.mp3`, expiresAt: new Date(Date.now() + 600_000).toISOString() })),
    getCrossfade: () => 0,
    isPlayable: playable,
    onNothingPlayable: nothing,
    onTrackStarted: started,
    rng: () => 0
  })
  return { store, engine, nothing, started, cur: (): string | undefined => currentItem(store.getState().queue)?.track.id }
}

describe('offline playback in the player store', () => {
  it('skips tracks that are not stored and plays the first that is', async () => {
    const c = setup((id) => id === 't2')
    await c.store.getState().playTracks(tracks(4), 0)
    expect(c.cur()).toBe('t2')
    expect(c.engine.load).toHaveBeenCalledTimes(1)
    expect(c.started).toHaveBeenCalledTimes(1)
  })

  it('moves on to the next stored track when one ends', async () => {
    const c = setup((id) => id !== 't1')
    await c.store.getState().playTracks(tracks(4), 0)
    expect(c.cur()).toBe('t0')
    c.engine.events.onPlaying()
    c.engine.events.onEnded()
    await new Promise((r) => setTimeout(r, 0))
    expect(c.cur()).toBe('t2')
  })

  it('stops with a message when nothing in the queue can play', async () => {
    const c = setup(() => false)
    await c.store.getState().playTracks(tracks(3), 0)
    expect(c.nothing).toHaveBeenCalledTimes(1)
    expect(c.engine.load).not.toHaveBeenCalled()
    expect(c.store.getState().status).toBe('paused')
  })

  it('plays everything as usual when every track is playable (online)', async () => {
    const c = setup(() => true)
    await c.store.getState().playTracks(tracks(3), 1)
    expect(c.cur()).toBe('t1')
  })
})
