import { describe, expect, it, vi } from 'vitest'
import { createPlayerStore, toNativeItems, trackFromNative } from '@/store/player'
import type { NativePlayer, NativePlayerEvent } from '@/platform/nativePlayerTypes'
import { NativeEngine } from '@/player/nativeEngine'
import * as Q from '@/player/queue'
import { currentItem } from '@/player/queue'
import { serializeSession } from '@/lib/playerSession'
import { tracks } from '../helpers/fixtures'

function fakeNative(snapshot: Awaited<ReturnType<NativePlayer['getSnapshot']>> = null) {
  let listener: (e: NativePlayerEvent) => void = () => undefined
  const n = {
    setQueue: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    setVolume: vi.fn(),
    setRepeat: vi.fn(),
    setShuffle: vi.fn(),
    setPauseAtEnd: vi.fn(),
    stop: vi.fn(),
    setLiked: vi.fn(),
    setAuth: vi.fn(),
    getAuth: vi.fn(async () => null),
    setLyricsInCar: vi.fn(),
    getSnapshot: vi.fn(async () => snapshot),
    on: vi.fn((l: (e: NativePlayerEvent) => void) => {
      listener = l
      return () => undefined
    })
  }
  return { n: n as unknown as NativePlayer & typeof n, fire: (e: NativePlayerEvent) => listener(e) }
}

function setup(snapshot?: Parameters<typeof fakeNative>[0]) {
  const f = fakeNative(snapshot)
  const reportPlayed = vi.fn()
  const resolveStream = vi.fn()
  const store = createPlayerStore({
    native: f.n,
    createEngine: () => new NativeEngine(f.n),
    resolveStream,
    reportPlayed,
    getCrossfade: () => 5,
    rng: () => 0
  })
  return { ...f, store, reportPlayed, resolveStream, s: store.getState }
}

describe('player store on the native Android path', () => {
  it('playTracks sends the whole queue to native, never resolves URLs in JS', async () => {
    const c = setup()
    await c.s().playTracks(tracks(3), 1)
    expect(c.resolveStream).not.toHaveBeenCalled()
    expect(c.n.setQueue).toHaveBeenCalledTimes(1)
    const [items, index, opts] = c.n.setQueue.mock.calls[0]!
    expect(items).toHaveLength(3)
    expect(index).toBe(1)
    expect(opts).toMatchObject({ play: true, reset: true, startAt: 0 })
    expect(c.s().status).toBe('loading')
    // The queue change is not sent a second time by the deferred sync.
    await Promise.resolve()
    expect(c.n.setQueue).toHaveBeenCalledTimes(1)
  })

  it('queue edits are synced in place (no restart) and add-to-queue is mirrored', async () => {
    const c = setup()
    await c.s().playTracks(tracks(3), 0)
    c.n.setQueue.mockClear()
    c.s().addToQueue(tracks(2).map((t) => ({ ...t, id: `x${t.id}` })))
    await Promise.resolve()
    expect(c.n.setQueue).toHaveBeenCalledTimes(1)
    expect(c.n.setQueue.mock.calls[0]![0]).toHaveLength(5)
    expect(c.n.setQueue.mock.calls[0]![2]).toBeUndefined()
  })

  it('follows native state, position and automatic track changes', async () => {
    const c = setup()
    await c.s().playTracks(tracks(3), 0)
    c.fire({ type: 'state', status: 'playing' })
    expect(c.s().status).toBe('playing')
    c.fire({ type: 'position', position: 12.5, duration: 180 })
    expect(c.s().position).toBe(12.5)
    expect(c.s().duration).toBe(180)
    const second = c.s().queue.items[1]!
    c.n.setQueue.mockClear()
    c.fire({ type: 'index', uid: second.uid })
    expect(currentItem(c.s().queue)?.uid).toBe(second.uid)
    expect(c.s().position).toBe(0)
    await Promise.resolve()
    expect(c.n.setQueue).not.toHaveBeenCalled() // same queue: nothing to resend
  })

  it('transport goes to native; plays are reported by native only', async () => {
    const c = setup()
    await c.s().playTracks(tracks(2), 0)
    c.s().pause()
    expect(c.n.pause).toHaveBeenCalled()
    c.s().seek(30)
    expect(c.n.seek).toHaveBeenCalledWith(30)
    c.s().setVolume(0.5)
    expect(c.n.setVolume).toHaveBeenCalledWith(0.5)
    c.s().stop()
    expect(c.n.stop).toHaveBeenCalled()
    expect(c.reportPlayed).not.toHaveBeenCalled()
  })

  it('sleep "end of track" and repeat are delegated', async () => {
    const c = setup()
    await c.s().playTracks(tracks(2), 0)
    c.s().setSleepAfterTrack(true)
    expect(c.n.setPauseAtEnd).toHaveBeenCalledWith(true)
    const second = c.s().queue.items[1]!
    c.fire({ type: 'index', uid: second.uid })
    expect(c.s().sleepAfterTrack).toBe(false)
    c.s().cycleRepeat()
    expect(c.n.setRepeat).toHaveBeenLastCalledWith('all')
  })

  it('native errors surface as an error status', async () => {
    const onError = vi.fn()
    const f = fakeNative()
    const store = createPlayerStore({ native: f.n, createEngine: () => new NativeEngine(f.n), resolveStream: vi.fn(), getCrossfade: () => 0, onError })
    await store.getState().playTracks(tracks(1), 0)
    f.fire({ type: 'error', message: 'boom' })
    expect(store.getState().status).toBe('error')
    expect(onError).toHaveBeenCalledWith('boom')
  })

  it('adopts a queue started from outside the WebView (Android Auto), keeping native uids', async () => {
    const c = setup()
    await c.s().playTracks(tracks(1), 0)
    c.n.setQueue.mockClear()
    c.fire({
      type: 'queue',
      snapshot: {
        items: [
          { uid: 'n1', trackId: 'a', title: 'A', artist: 'X, Y', album: 'Al', artworkUrl: 'http://i', duration: 100 },
          { uid: 'n2', trackId: 'b', title: 'B', artist: '', album: '', artworkUrl: '', duration: 90 }
        ],
        index: 1,
        position: 4,
        playing: true,
        repeat: 'all',
        shuffle: false
      }
    })
    const q = c.s().queue
    expect(q.items.map((i) => i.uid)).toEqual(['n1', 'n2'])
    expect(q.index).toBe(1)
    expect(q.repeat).toBe('all')
    expect(c.s().status).toBe('playing')
    await Promise.resolve()
    expect(c.n.setQueue).not.toHaveBeenCalled()
  })

  it('adopts the running native queue on startup when the WebView has none', async () => {
    const c = setup({
      items: [{ uid: 'n1', trackId: 'a', title: 'A', artist: 'X', album: '', artworkUrl: '', duration: 50 }],
      index: 0, position: 10, playing: false, repeat: 'off', shuffle: false
    })
    await vi.waitFor(() => expect(c.s().queue.items).toHaveLength(1))
    expect(c.s().position).toBe(10)
    expect(c.s().status).toBe('paused')
  })

  it('native shuffle/repeat buttons toggle the store', async () => {
    const c = setup()
    await c.s().playTracks(tracks(4), 0)
    c.fire({ type: 'command', kind: 'shuffle' })
    expect(c.s().queue.shuffle).toBe(true)
    c.fire({ type: 'command', kind: 'repeat' })
    expect(c.s().queue.repeat).toBe('all')
  })
})

describe('native queue mapping', () => {
  it('toNativeItems carries uid, ids, names and art', () => {
    const f = fakeNative()
    const store = createPlayerStore({ native: f.n, createEngine: () => new NativeEngine(f.n), resolveStream: vi.fn(), getCrossfade: () => 0 })
    void store.getState().playTracks(tracks(2), 0)
    const items = toNativeItems(store.getState().queue)
    expect(items[0]).toMatchObject({ trackId: store.getState().queue.items[0]!.track.id, uid: store.getState().queue.items[0]!.uid })
  })
  it('trackFromNative keeps the full track when native has it', () => {
    const t = tracks(1)[0]!
    expect(trackFromNative({ uid: 'u', trackId: t.id, title: '', artist: '', album: '', artworkUrl: '', duration: 0, track: t })).toBe(t)
  })
})

describe('session restore and adoption', () => {
  const saved = (n = 3, index = 1, position = 37) => {
    const q = Q.createQueue(tracks(n), index, { context: { type: 'playlist', id: 'p1', name: 'Mix' } })
    return serializeSession(q, position, 1)!
  }

  it('restores the saved queue paused and loads it into native without autoplay', async () => {
    const f = fakeNative(null)
    const store = createPlayerStore({ native: f.n, createEngine: () => new NativeEngine(f.n), resolveStream: vi.fn(), getCrossfade: () => 0, loadSession: () => saved() })
    expect(store.getState().queue.index).toBe(1)
    expect(store.getState().status).toBe('paused')
    expect(store.getState().position).toBe(37)
    await vi.waitFor(() => expect(f.n.setQueue).toHaveBeenCalledTimes(1))
    const [items, index, opts] = f.n.setQueue.mock.calls[0]!
    expect(items).toHaveLength(3)
    expect(index).toBe(1)
    expect(opts).toMatchObject({ play: false, startAt: 37 })
    expect(f.n.play).not.toHaveBeenCalled()
  })

  it('adopts the playing native state over the saved session, keeping its structure when the entries match', async () => {
    const s = saved(3, 0, 5)
    const snap = {
      items: s.queue.items.map((it) => ({ uid: it.uid, trackId: it.track.id, title: it.track.title, artist: '', album: '', artworkUrl: '', duration: it.track.duration })),
      index: 2,
      position: 99,
      playing: true,
      repeat: 'off' as const,
      shuffle: false
    }
    const f = fakeNative(snap)
    const store = createPlayerStore({ native: f.n, createEngine: () => new NativeEngine(f.n), resolveStream: vi.fn(), getCrossfade: () => 0, loadSession: () => s })
    await vi.waitFor(() => expect(store.getState().status).toBe('playing'))
    expect(store.getState().queue.index).toBe(2)
    expect(store.getState().position).toBe(99)
    expect(store.getState().queue.context).toEqual({ type: 'playlist', id: 'p1', name: 'Mix' })
    expect(f.n.setQueue).not.toHaveBeenCalled()
  })

  it('adopts a native snapshot when nothing was saved', async () => {
    const f = fakeNative({ items: [{ uid: 'a', trackId: 't1', title: 'X', artist: 'Y', album: '', artworkUrl: '', duration: 10 }], index: 0, position: 4, playing: false, repeat: 'off', shuffle: false })
    const store = createPlayerStore({ native: f.n, createEngine: () => new NativeEngine(f.n), resolveStream: vi.fn(), getCrossfade: () => 0 })
    await vi.waitFor(() => expect(currentItem(store.getState().queue)?.uid).toBe('a'))
    expect(store.getState().status).toBe('paused')
    expect(store.getState().position).toBe(4)
  })

  it('persists on queue change and forgets when stopped', async () => {
    const saves: unknown[] = []
    const f = fakeNative(null)
    const store = createPlayerStore({ native: f.n, createEngine: () => new NativeEngine(f.n), resolveStream: vi.fn(), getCrossfade: () => 0, saveSession: (x) => void saves.push(x) })
    await store.getState().playTracks(tracks(2), 0)
    await Promise.resolve()
    expect(saves.at(-1)).toMatchObject({ v: 1, queue: { index: 0 } })
    store.getState().stop()
    await Promise.resolve()
    expect(saves.at(-1)).toBeNull()
  })
})

describe('native clock hooks', () => {
  it('feeds position, play state and track changes to the local clock', async () => {
    const f = fakeNative(null)
    const onNativeTime = vi.fn()
    const onNativePlaying = vi.fn()
    const store = createPlayerStore({ native: f.n, createEngine: () => new NativeEngine(f.n), resolveStream: vi.fn(), getCrossfade: () => 0, onNativeTime, onNativePlaying })
    await store.getState().playTracks(tracks(2), 0)
    f.fire({ type: 'state', status: 'playing' })
    expect(onNativePlaying).toHaveBeenLastCalledWith(true)
    f.fire({ type: 'state', status: 'buffering' })
    expect(onNativePlaying).toHaveBeenLastCalledWith(false)
    onNativeTime.mockClear()
    f.fire({ type: 'index', uid: store.getState().queue.items[1]!.uid })
    expect(onNativeTime).toHaveBeenCalledWith(0, expect.any(Number))
  })
})
