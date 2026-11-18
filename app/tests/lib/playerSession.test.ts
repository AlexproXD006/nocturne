import { beforeEach, describe, expect, it } from 'vitest'
import * as Q from '@/player/queue'
import { loadSavedSession, MAX_SAVED_ITEMS, parseSavedSession, queueFromSaved, serializeSession, storeSavedSession } from '@/lib/playerSession'
import { tracks } from '../helpers/fixtures'

const mk = (n = 4, index = 1) => Q.createQueue(tracks(n), index, { context: { type: 'album', id: 'al1', name: 'Disc' }, repeat: 'all' })

describe('player session persistence', () => {
  beforeEach(() => {
    const mem = new Map<string, string>()
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) }
    })
  })

  it('round-trips queue, index, position, repeat and context through storage', () => {
    const q = mk()
    storeSavedSession(serializeSession(q, 42.5, 1))
    const back = loadSavedSession()!
    const r = queueFromSaved(back)
    expect(r.items.map((i) => i.uid)).toEqual(q.items.map((i) => i.uid))
    expect(r.index).toBe(1)
    expect(r.repeat).toBe('all')
    expect(r.context).toEqual({ type: 'album', id: 'al1', name: 'Disc' })
    expect(back.position).toBe(42.5)
  })

  it('keeps user-queue and autoplay sections and the shuffle order', () => {
    let q = Q.createQueue(tracks(4), 0, { shuffle: true, rng: () => 0 })
    q = Q.insertNext(q, tracks(1).map((t) => ({ ...t, id: 'u1' })))
    q = Q.appendAutoplay(q, tracks(1).map((t) => ({ ...t, id: 'ap' })))
    const r = queueFromSaved(parseSavedSession(JSON.parse(JSON.stringify(serializeSession(q, 3, 1))))!)
    expect(Q.userUpcoming(r).map((i) => i.track.id)).toEqual(['u1'])
    expect(Q.autoplayUpcoming(r).map((i) => i.track.id)).toEqual(['ap'])
    expect(r.shuffle).toBe(true)
    expect(r.ordered?.map((i) => i.uid)).toEqual(q.ordered?.map((i) => i.uid))
  })

  it('an empty queue is not saved, and removal clears the entry', () => {
    expect(serializeSession(Q.emptyQueue, 0, 1)).toBeNull()
    storeSavedSession(serializeSession(mk(), 1, 1))
    storeSavedSession(null)
    expect(loadSavedSession()).toBeNull()
  })

  it('cuts old history when the queue is huge, keeping the current item', () => {
    const q = Q.createQueue(tracks(MAX_SAVED_ITEMS + 50), MAX_SAVED_ITEMS + 49)
    const s = serializeSession(q, 0, 1)!
    expect(s.queue.items).toHaveLength(MAX_SAVED_ITEMS)
    expect(s.queue.items[s.queue.index]!.uid).toBe(q.items[q.index]!.uid)
  })

  it('corrupt data never throws and gives null', () => {
    expect(parseSavedSession(null)).toBeNull()
    expect(parseSavedSession({ v: 2 })).toBeNull()
    expect(parseSavedSession({ v: 1, queue: { items: [{ uid: 1 }] } })).toBeNull()
    expect(parseSavedSession({ v: 1, queue: { items: [] } })).toBeNull()
    localStorage.setItem('nocturne.player.session', '{nope')
    expect(loadSavedSession()).toBeNull()
  })

  it('clamps a bad index and position', () => {
    const s = JSON.parse(JSON.stringify(serializeSession(mk(2, 0), 5, 1)))
    s.queue.index = 99
    s.position = -4
    const p = parseSavedSession(s)!
    expect(p.queue.index).toBe(1)
    expect(p.position).toBe(0)
  })
})
