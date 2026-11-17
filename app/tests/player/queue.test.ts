import { describe, expect, it } from 'vitest'
import * as Q from '@/player/queue'
import { counter, seq, tracks, track } from '../helpers/fixtures'

const ids = (q: Q.QueueState): string[] => q.items.map((i) => i.track.id)
const orderedIds = (q: Q.QueueState): string[] | null => (q.ordered ? q.ordered.map((i) => i.track.id) : null)
const cur = (q: Q.QueueState): string | undefined => Q.currentItem(q)?.track.id

function mk(n: number, index = 0, opts: Parameters<typeof Q.createQueue>[2] = {}): Q.QueueState {
  return Q.createQueue(tracks(n), index, { uid: counter(), ...opts })
}

/** rng that always returns 0 => shuffled() rotates elements left (deterministic). */
const rng0 = (): number => 0

describe('makeUid', () => {
  it('produces unique ids', () => {
    const set = new Set(Array.from({ length: 500 }, () => Q.makeUid()))
    expect(set.size).toBe(500)
  })
})

describe('shuffled', () => {
  it('returns a permutation without mutating the input', () => {
    const input = [1, 2, 3, 4, 5, 6]
    const out = Q.shuffled(input, seq([0.9, 0.1, 0.5, 0.3, 0.7]))
    expect([...out].sort()).toEqual(input)
    expect(input).toEqual([1, 2, 3, 4, 5, 6])
    expect(out).not.toBe(input)
  })

  it('is deterministic for a given rng', () => {
    const a = Q.shuffled([1, 2, 3, 4, 5], seq([0.2, 0.8, 0.4, 0.6]))
    const b = Q.shuffled([1, 2, 3, 4, 5], seq([0.2, 0.8, 0.4, 0.6]))
    expect(a).toEqual(b)
  })

  it('handles empty and single element lists', () => {
    expect(Q.shuffled([])).toEqual([])
    expect(Q.shuffled([1])).toEqual([1])
  })

  it('uses Math.random by default and can reach every permutation of 3 items', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 400; i++) seen.add(Q.shuffled([1, 2, 3]).join(''))
    expect(seen.size).toBe(6)
  })
})

describe('createQueue', () => {
  it('creates an unshuffled queue starting at the index', () => {
    const q = mk(4, 2)
    expect(ids(q)).toEqual(['t0', 't1', 't2', 't3'])
    expect(q.index).toBe(2)
    expect(q.shuffle).toBe(false)
    expect(q.ordered).toBeNull()
    expect(q.repeat).toBe('off')
    expect(q.context).toBeNull()
  })

  it('assigns unique uids even for duplicate tracks', () => {
    const t = track('same')
    const q = Q.createQueue([t, t, t], 0)
    expect(new Set(q.items.map((i) => i.uid)).size).toBe(3)
  })

  it('clamps out-of-range start indexes', () => {
    expect(mk(3, 99).index).toBe(2)
    expect(mk(3, -5).index).toBe(0)
  })

  it('returns an empty queue for no tracks, preserving options', () => {
    const ctx: Q.QueueContext = { type: 'album', id: 'a' }
    const q = Q.createQueue([], 0, { repeat: 'all', shuffle: true, context: ctx })
    expect(q).toMatchObject({ items: [], index: -1, repeat: 'all', shuffle: true, context: ctx, ordered: null })
    expect(Q.createQueue([], 3)).toMatchObject({ index: -1, shuffle: false, repeat: 'off' })
  })

  it('stores repeat and context', () => {
    const ctx: Q.QueueContext = { type: 'playlist', id: 'p', name: 'P' }
    const q = mk(2, 0, { repeat: 'one', context: ctx })
    expect(q.repeat).toBe('one')
    expect(q.context).toBe(ctx)
  })

  describe('shuffled', () => {
    it('keeps the start track first and the others shuffled after it', () => {
      const q = mk(6, 3, { shuffle: true, rng: seq([0.7, 0.2, 0.5, 0.9]) })
      expect(q.index).toBe(0)
      expect(cur(q)).toBe('t3')
      expect([...ids(q)].sort()).toEqual(['t0', 't1', 't2', 't3', 't4', 't5'])
      expect(q.shuffle).toBe(true)
    })

    it('remembers the original order in `ordered`', () => {
      const q = mk(5, 2, { shuffle: true, rng: rng0 })
      expect(orderedIds(q)).toEqual(['t0', 't1', 't2', 't3', 't4'])
      // same item objects in both lists
      for (const it of q.items) expect(q.ordered).toContain(it)
    })

    it('is reproducible with a seeded rng', () => {
      const a = mk(8, 0, { shuffle: true, rng: seq([0.31, 0.77, 0.12, 0.99, 0.5]) })
      const b = mk(8, 0, { shuffle: true, rng: seq([0.31, 0.77, 0.12, 0.99, 0.5]) })
      expect(ids(a)).toEqual(ids(b))
    })

    it('works for a single track', () => {
      const q = mk(1, 0, { shuffle: true })
      expect(ids(q)).toEqual(['t0'])
      expect(q.index).toBe(0)
    })
  })
})

describe('currentItem', () => {
  it('returns the current item or null', () => {
    expect(Q.currentItem(mk(3, 1))?.track.id).toBe('t1')
    expect(Q.currentItem(Q.emptyQueue)).toBeNull()
  })
})

describe('nextIndex / advance', () => {
  it('returns -1 for an empty queue in every mode', () => {
    for (const repeat of ['off', 'all', 'one'] as const) {
      for (const auto of [true, false]) {
        expect(Q.nextIndex({ ...Q.emptyQueue, repeat }, auto)).toBe(-1)
      }
    }
  })

  describe('repeat off', () => {
    it('moves forward for auto and manual', () => {
      const q = mk(3, 0)
      expect(Q.nextIndex(q, true)).toBe(1)
      expect(Q.nextIndex(q, false)).toBe(1)
    })
    it('stops at the end', () => {
      const q = mk(3, 2)
      expect(Q.nextIndex(q, true)).toBe(-1)
      expect(Q.nextIndex(q, false)).toBe(-1)
      expect(Q.advance(q, true)).toBeNull()
      expect(Q.advance(q, false)).toBeNull()
    })
  })

  describe('repeat all', () => {
    it('wraps to the start at the end', () => {
      const q = mk(3, 2, { repeat: 'all' })
      expect(Q.nextIndex(q, true)).toBe(0)
      expect(Q.nextIndex(q, false)).toBe(0)
      expect(Q.advance(q, true)!.index).toBe(0)
    })
    it('moves forward normally elsewhere', () => {
      expect(Q.nextIndex(mk(3, 0, { repeat: 'all' }), true)).toBe(1)
    })
    it('a single-track queue loops to itself', () => {
      expect(Q.nextIndex(mk(1, 0, { repeat: 'all' }), true)).toBe(0)
    })
  })

  describe('repeat one', () => {
    it('auto-advance stays on the same track', () => {
      const q = mk(3, 1, { repeat: 'one' })
      expect(Q.nextIndex(q, true)).toBe(1)
      expect(Q.advance(q, true)!.index).toBe(1)
    })
    it('manual next still moves forward', () => {
      expect(Q.nextIndex(mk(3, 1, { repeat: 'one' }), false)).toBe(2)
    })
    it('manual next at the end stops (repeat one does not wrap)', () => {
      expect(Q.nextIndex(mk(3, 2, { repeat: 'one' }), false)).toBe(-1)
    })
  })

  it('advance preserves everything but the index and does not mutate', () => {
    const q = mk(3, 0)
    const n = Q.advance(q, false)!
    expect(n.index).toBe(1)
    expect(n.items).toBe(q.items)
    expect(q.index).toBe(0)
  })
})

describe('peekNext', () => {
  it('returns the following item', () => {
    expect(Q.peekNext(mk(3, 0))?.track.id).toBe('t1')
  })
  it('returns null at the end with repeat off', () => {
    expect(Q.peekNext(mk(3, 2))).toBeNull()
  })
  it('wraps with repeat all', () => {
    expect(Q.peekNext(mk(3, 2, { repeat: 'all' }))?.track.id).toBe('t0')
  })
  it('returns null for repeat one (nothing to preload) and for single-track repeat all', () => {
    expect(Q.peekNext(mk(3, 1, { repeat: 'one' }))).toBeNull()
    expect(Q.peekNext(mk(1, 0, { repeat: 'all' }))).toBeNull()
  })
  it('returns null for an empty queue', () => {
    expect(Q.peekNext(Q.emptyQueue)).toBeNull()
  })
})

describe('previous', () => {
  it('goes back one', () => {
    expect(Q.previous(mk(3, 2)).index).toBe(1)
  })
  it('stays at 0 at the start with repeat off/one', () => {
    expect(Q.previous(mk(3, 0)).index).toBe(0)
    expect(Q.previous(mk(3, 0, { repeat: 'one' })).index).toBe(0)
  })
  it('wraps to the last with repeat all', () => {
    expect(Q.previous(mk(3, 0, { repeat: 'all' })).index).toBe(2)
  })
  it('returns the same object for an empty queue', () => {
    expect(Q.previous(Q.emptyQueue)).toBe(Q.emptyQueue)
  })
})

describe('jumpTo', () => {
  it('jumps to an item by uid', () => {
    const q = mk(4, 0)
    expect(Q.jumpTo(q, q.items[3]!.uid).index).toBe(3)
    expect(Q.jumpTo(q, q.items[0]!.uid).index).toBe(0)
  })
  it('returns the same queue for an unknown uid', () => {
    const q = mk(4, 1)
    expect(Q.jumpTo(q, 'nope')).toBe(q)
  })
})

describe('insertNext', () => {
  it('inserts right after the current item, in order', () => {
    const q = Q.insertNext(mk(3, 1), tracks(2, 'n'), counter('x'))
    expect(ids(q)).toEqual(['t0', 't1', 'n0', 'n1', 't2'])
    expect(q.index).toBe(1)
    expect(q.ordered).toBeNull()
  })

  it('inserts after the last item', () => {
    expect(ids(Q.insertNext(mk(2, 1), tracks(1, 'n')))).toEqual(['t0', 't1', 'n0'])
  })

  it('is a no-op for no tracks', () => {
    const q = mk(2)
    expect(Q.insertNext(q, [])).toBe(q)
  })

  it('seeds an empty queue and makes the first item current', () => {
    const q = Q.insertNext(Q.emptyQueue, tracks(2, 'n'))
    expect(ids(q)).toEqual(['n0', 'n1'])
    expect(q.index).toBe(0)
    expect(q.ordered).toBeNull()
  })

  it('seeds an empty shuffled queue and tracks the original order', () => {
    const q = Q.insertNext({ ...Q.emptyQueue, shuffle: true }, tracks(2, 'n'))
    expect(q.index).toBe(0)
    expect(orderedIds(q)).toEqual(['n0', 'n1'])
  })

  it('keeps `ordered` in sync while shuffled: inserted after the current item in the original order', () => {
    const base = mk(5, 2, { shuffle: true, rng: rng0 }) // current = t2
    const q = Q.insertNext(base, tracks(2, 'n'), counter('x'))
    expect(q.items.slice(1, 3).map((i) => i.track.id)).toEqual(['n0', 'n1'])
    expect(q.index).toBe(0)
    expect(orderedIds(q)).toEqual(['t0', 't1', 't2', 'n0', 'n1', 't3', 't4'])
    // both lists hold the same set of items
    expect(new Set(q.items.map((i) => i.uid))).toEqual(new Set(q.ordered!.map((i) => i.uid)))
  })

  it('does not mutate the original queue', () => {
    const q = mk(3, 0)
    const before = ids(q)
    Q.insertNext(q, tracks(1, 'n'))
    expect(ids(q)).toEqual(before)
  })

  it('inserted items get fresh unique uids', () => {
    const q = Q.insertNext(mk(2), tracks(3, 'n'))
    expect(new Set(q.items.map((i) => i.uid)).size).toBe(q.items.length)
  })
})

describe('append', () => {
  it('adds to the end', () => {
    const q = Q.append(mk(2, 0), tracks(2, 'n'))
    expect(ids(q)).toEqual(['t0', 't1', 'n0', 'n1'])
    expect(q.index).toBe(0)
  })

  it('is a no-op for no tracks', () => {
    const q = mk(2)
    expect(Q.append(q, [])).toBe(q)
  })

  it('seeds an empty queue', () => {
    const q = Q.append(Q.emptyQueue, tracks(2, 'n'))
    expect(ids(q)).toEqual(['n0', 'n1'])
    expect(q.index).toBe(0)
  })

  it('seeds an empty shuffled queue with ordered', () => {
    const q = Q.append({ ...Q.emptyQueue, shuffle: true }, tracks(1, 'n'))
    expect(orderedIds(q)).toEqual(['n0'])
  })

  it('keeps `ordered` in sync while shuffled', () => {
    const base = mk(4, 1, { shuffle: true, rng: rng0 })
    const q = Q.append(base, tracks(2, 'n'))
    expect(ids(q).slice(-2)).toEqual(['n0', 'n1'])
    expect(orderedIds(q)).toEqual(['t0', 't1', 't2', 't3', 'n0', 'n1'])
  })
})

describe('remove', () => {
  it('ignores unknown uids', () => {
    const q = mk(3, 1)
    const r = Q.remove(q, 'nope')
    expect(r.queue).toBe(q)
    expect(r.removedCurrent).toBe(false)
  })

  it('removing an item before the current shifts the index down', () => {
    const q = mk(4, 2)
    const r = Q.remove(q, q.items[0]!.uid)
    expect(ids(r.queue)).toEqual(['t1', 't2', 't3'])
    expect(r.queue.index).toBe(1)
    expect(cur(r.queue)).toBe('t2')
    expect(r.removedCurrent).toBe(false)
  })

  it('removing an item after the current keeps the index', () => {
    const q = mk(4, 1)
    const r = Q.remove(q, q.items[3]!.uid)
    expect(r.queue.index).toBe(1)
    expect(cur(r.queue)).toBe('t1')
    expect(r.removedCurrent).toBe(false)
  })

  it('removing the current item makes the following one current', () => {
    const q = mk(4, 1)
    const r = Q.remove(q, q.items[1]!.uid)
    expect(r.removedCurrent).toBe(true)
    expect(ids(r.queue)).toEqual(['t0', 't2', 't3'])
    expect(cur(r.queue)).toBe('t2')
  })

  it('removing the current LAST item falls back to the new last', () => {
    const q = mk(3, 2)
    const r = Q.remove(q, q.items[2]!.uid)
    expect(r.removedCurrent).toBe(true)
    expect(r.queue.index).toBe(1)
    expect(cur(r.queue)).toBe('t1')
  })

  it('removing the only item empties the queue (index -1)', () => {
    const q = mk(1, 0)
    const r = Q.remove(q, q.items[0]!.uid)
    expect(r.queue.items).toEqual([])
    expect(r.queue.index).toBe(-1)
    expect(r.removedCurrent).toBe(true)
    expect(Q.currentItem(r.queue)).toBeNull()
  })

  it('removing the first item while it is current', () => {
    const q = mk(3, 0)
    const r = Q.remove(q, q.items[0]!.uid)
    expect(cur(r.queue)).toBe('t1')
    expect(r.queue.index).toBe(0)
  })

  it('removes from `ordered` too while shuffled', () => {
    const q = mk(5, 0, { shuffle: true, rng: rng0 })
    const victim = q.items[3]!
    const r = Q.remove(q, victim.uid)
    expect(r.queue.items).not.toContain(victim)
    expect(r.queue.ordered).not.toContain(victim)
    expect(r.queue.ordered).toHaveLength(4)
  })

  it('does not mutate the original queue', () => {
    const q = mk(3, 1)
    Q.remove(q, q.items[0]!.uid)
    expect(q.items).toHaveLength(3)
  })
})

describe('move', () => {
  const run = (n: number, index: number, from: number, to: number): { order: string[]; index: number; current: string | undefined } => {
    const r = Q.move(mk(n, index), from, to)
    return { order: ids(r), index: r.index, current: cur(r) }
  }

  it('returns the same queue for no-op and invalid moves', () => {
    const q = mk(4, 1)
    expect(Q.move(q, 1, 1)).toBe(q)
    expect(Q.move(q, -1, 2)).toBe(q)
    expect(Q.move(q, 0, -1)).toBe(q)
    expect(Q.move(q, 4, 0)).toBe(q)
    expect(Q.move(q, 0, 4)).toBe(q)
  })

  it('moving the current item takes the index with it', () => {
    expect(run(5, 2, 2, 4)).toEqual({ order: ['t0', 't1', 't3', 't4', 't2'], index: 4, current: 't2' })
    expect(run(5, 2, 2, 0)).toEqual({ order: ['t2', 't0', 't1', 't3', 't4'], index: 0, current: 't2' })
  })

  it('moving an item from before the current to at/after it decrements the index', () => {
    expect(run(5, 2, 0, 2)).toMatchObject({ index: 1, current: 't2' })
    expect(run(5, 2, 1, 4)).toMatchObject({ index: 1, current: 't2' })
    expect(run(5, 2, 0, 4)).toMatchObject({ index: 1, current: 't2' })
  })

  it('moving an item from before the current to before it leaves the index', () => {
    expect(run(5, 3, 0, 1)).toMatchObject({ index: 3, current: 't3' })
    expect(run(5, 3, 0, 2)).toMatchObject({ index: 3, current: 't3' })
  })

  it('moving an item from after the current to at/before it increments the index', () => {
    expect(run(5, 2, 4, 2)).toMatchObject({ index: 3, current: 't2' })
    expect(run(5, 2, 3, 0)).toMatchObject({ index: 3, current: 't2' })
    expect(run(5, 2, 3, 1)).toMatchObject({ index: 3, current: 't2' })
  })

  it('moving an item from after the current to after it leaves the index', () => {
    expect(run(5, 1, 4, 2)).toMatchObject({ index: 1, current: 't1' })
    expect(run(5, 1, 2, 4)).toMatchObject({ index: 1, current: 't1' })
  })

  it('always keeps the same current item (exhaustive over all moves)', () => {
    for (let n = 1; n <= 5; n++) {
      for (let index = 0; index < n; index++) {
        for (let from = 0; from < n; from++) {
          for (let to = 0; to < n; to++) {
            const q = mk(n, index)
            const r = Q.move(q, from, to)
            expect(cur(r)).toBe(cur(q))
            expect([...ids(r)].sort()).toEqual([...ids(q)].sort())
          }
        }
      }
    }
  })

  it('does not mutate the original queue', () => {
    const q = mk(3, 0)
    Q.move(q, 0, 2)
    expect(ids(q)).toEqual(['t0', 't1', 't2'])
  })
})

describe('clearUpcoming', () => {
  it('removes everything after the current item', () => {
    const q = Q.clearUpcoming(mk(5, 2))
    expect(ids(q)).toEqual(['t0', 't1', 't2'])
    expect(q.index).toBe(2)
  })

  it('is harmless at the end of the queue', () => {
    expect(ids(Q.clearUpcoming(mk(3, 2)))).toEqual(['t0', 't1', 't2'])
  })

  it('returns the same queue when nothing is playing', () => {
    expect(Q.clearUpcoming(Q.emptyQueue)).toBe(Q.emptyQueue)
  })

  it('prunes `ordered` of removed items while shuffled', () => {
    const q = Q.clearUpcoming(mk(5, 0, { shuffle: true, rng: rng0 }))
    expect(q.items).toHaveLength(1)
    expect(q.ordered).toEqual(q.items)
  })
})

describe('setShuffle', () => {
  it('is a no-op when the mode already matches', () => {
    const q = mk(3)
    expect(Q.setShuffle(q, false)).toBe(q)
    const s = mk(3, 0, { shuffle: true })
    expect(Q.setShuffle(s, true)).toBe(s)
  })

  it('turning on keeps the current item first and remembers the order', () => {
    const q = Q.setShuffle(mk(6, 3), true, seq([0.9, 0.3, 0.6]))
    expect(q.shuffle).toBe(true)
    expect(q.index).toBe(0)
    expect(cur(q)).toBe('t3')
    expect(orderedIds(q)).toEqual(['t0', 't1', 't2', 't3', 't4', 't5'])
    expect([...ids(q)].sort()).toEqual(['t0', 't1', 't2', 't3', 't4', 't5'])
  })

  it('turning off restores the original order and the current position', () => {
    const base = mk(6, 3)
    const on = Q.setShuffle(base, true, seq([0.9, 0.3, 0.6]))
    const off = Q.setShuffle(on, false)
    expect(off.shuffle).toBe(false)
    expect(off.ordered).toBeNull()
    expect(ids(off)).toEqual(ids(base))
    expect(off.index).toBe(3)
    expect(cur(off)).toBe('t3')
  })

  it('restores the position after advancing within the shuffled order', () => {
    const on = Q.setShuffle(mk(5, 0), true, seq([0.1, 0.8, 0.4]))
    const moved = Q.advance(Q.advance(on, false)!, false)!
    const playing = cur(moved)
    const off = Q.setShuffle(moved, false)
    expect(cur(off)).toBe(playing)
    expect(ids(off)).toEqual(['t0', 't1', 't2', 't3', 't4'])
  })

  it('includes tracks added while shuffled when restoring', () => {
    let q = Q.setShuffle(mk(3, 0), true, rng0)
    q = Q.append(q, tracks(1, 'n'))
    q = Q.insertNext(q, tracks(1, 'm'))
    const off = Q.setShuffle(q, false)
    expect(ids(off)).toEqual(['t0', 'm0', 't1', 't2', 'n0'])
    expect(cur(off)).toBe('t0')
  })

  it('omits tracks removed while shuffled when restoring', () => {
    let q = Q.setShuffle(mk(4, 0), true, rng0)
    q = Q.remove(q, q.ordered![2]!.uid).queue
    expect(ids(Q.setShuffle(q, false))).toEqual(['t0', 't1', 't3'])
  })

  it('turning on for an empty queue just flips the flag', () => {
    const q = Q.setShuffle(Q.emptyQueue, true)
    expect(q).toMatchObject({ shuffle: true, items: [], ordered: [], index: -1 })
    const off = Q.setShuffle(q, false)
    expect(off).toMatchObject({ shuffle: false, items: [], index: -1, ordered: null })
  })

  it('turning off a shuffled queue without `ordered` falls back to the current items', () => {
    const q: Q.QueueState = { ...mk(3, 1), shuffle: true, ordered: null }
    const off = Q.setShuffle(q, false)
    expect(ids(off)).toEqual(['t0', 't1', 't2'])
    expect(off.index).toBe(1)
  })

  it('turning off when the current item vanished from `ordered` picks index 0', () => {
    const q = mk(3, 0, { shuffle: true, rng: rng0 })
    const broken: Q.QueueState = { ...q, ordered: q.ordered!.filter((i) => i.uid !== q.items[0]!.uid) }
    expect(Q.setShuffle(broken, false).index).toBe(0)
  })

  it('preserves repeat and context', () => {
    const ctx: Q.QueueContext = { type: 'album', id: 'a' }
    const q = Q.setShuffle(mk(3, 0, { repeat: 'all', context: ctx }), true)
    expect(q.repeat).toBe('all')
    expect(q.context).toBe(ctx)
  })

  it('uses Math.random by default (permutation preserved)', () => {
    const q = Q.setShuffle(mk(10, 4), true)
    expect([...ids(q)].sort()).toEqual([...ids(mk(10, 4))].sort())
    expect(cur(q)).toBe('t4')
  })
})

describe('cycleRepeat', () => {
  it('cycles off -> all -> one -> off', () => {
    expect(Q.cycleRepeat('off')).toBe('all')
    expect(Q.cycleRepeat('all')).toBe('one')
    expect(Q.cycleRepeat('one')).toBe('off')
  })
})

describe('upcoming', () => {
  it('lists the items after the current one', () => {
    expect(Q.upcoming(mk(4, 1)).map((i) => i.track.id)).toEqual(['t2', 't3'])
  })
  it('is empty at the end and for an empty queue', () => {
    expect(Q.upcoming(mk(3, 2))).toEqual([])
    expect(Q.upcoming(Q.emptyQueue)).toEqual([])
  })
})
