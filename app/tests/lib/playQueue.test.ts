import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/errors'
import { createPlayQueue, MAX_PENDING, MAX_PENDING_AGE_MS, newPlayId, PENDING_KEY, qualifies } from '@/lib/playQueue'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

const play = (id: string, seconds = 40, extra = {}) => ({ playId: id, trackId: 't1', seconds, at: '2026-01-01T00:00:00.000Z', dur: 200, ...extra })

function make(send = vi.fn(async () => undefined), owner = 'u1', now = () => Date.parse('2026-01-02T00:00:00Z')) {
  const ownerRef = { v: owner }
  const q = createPlayQueue({ send, owner: () => ownerRef.v, now })
  return { q, send, ownerRef }
}

describe('qualifies / newPlayId', () => {
  it('counts 30 s or half the track', () => {
    expect(qualifies(30, 200)).toBe(true)
    expect(qualifies(29, 200)).toBe(false)
    expect(qualifies(10, 20)).toBe(true)
    expect(qualifies(9, 0)).toBe(false)
  })
  it('generates unique ids, with a fallback without crypto.randomUUID', () => {
    expect(newPlayId()).not.toBe(newPlayId())
    vi.stubGlobal('crypto', undefined)
    const a = newPlayId()
    expect(a).toMatch(/^p/)
    expect(newPlayId()).not.toBe(a)
    vi.unstubAllGlobals()
  })
})

describe('play queue', () => {
  it('a live (in-progress) entry is persisted but not sent by a flush in the same process', async () => {
    const { q, send } = make()
    q.save(play('a'))
    expect(JSON.parse(localStorage.getItem(PENDING_KEY)!)).toHaveLength(1)
    await q.flush()
    expect(send).not.toHaveBeenCalled()
  })

  it('after a restart (new queue, empty live set) the saved listen is sent with its playId and removed', async () => {
    make().q.save(play('a', 45))
    const { q, send } = make()
    await q.flush()
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ playId: 'a', seconds: 45, owner: 'u1' }))
    expect(q.list()).toEqual([])
  })

  it('upserts the same playId and keeps the latest seconds', async () => {
    const { q } = make()
    q.save(play('a', 15)); q.save(play('a', 30)); q.complete(play('a', 31))
    expect(q.list()).toHaveLength(1)
    expect(q.list()[0]!.seconds).toBe(31)
  })

  it('completed entries are sent; unqualified leftovers and drops are removed without sending', async () => {
    const { q, send } = make()
    q.complete(play('ok', 40))
    q.complete(play('short', 10))
    q.save(play('gone', 20)); q.drop('gone')
    await q.flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(q.list()).toEqual([])
  })

  it('keeps entries on network/5xx/401/429 errors and stops, drops them on definitive 4xx', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new ApiError('network', 'x', 0))
    const { q } = make(send)
    q.complete(play('a')); q.complete(play('b'))
    await q.flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(q.list()).toHaveLength(2)
    for (const st of [500, 401, 429, 408]) {
      send.mockReset().mockRejectedValueOnce(new ApiError('server', 'x', st))
      await q.flush()
      expect(q.list()).toHaveLength(2)
    }
    send.mockReset().mockRejectedValueOnce(new ApiError('not_found', 'gone', 404)).mockResolvedValue(undefined)
    await q.flush()
    expect(send).toHaveBeenCalledTimes(2)
    expect(q.list()).toEqual([])
  })

  it('a non-ApiError failure keeps the entry', async () => {
    const { q } = make(vi.fn().mockRejectedValue(new Error('offline')))
    q.complete(play('a'))
    await q.flush()
    expect(q.list()).toHaveLength(1)
  })

  it('does nothing when signed out and never sends another account\'s plays', async () => {
    const { q, send, ownerRef } = make()
    q.complete(play('a'))
    ownerRef.v = ''
    await q.flush()
    ownerRef.v = 'u2'
    await q.flush()
    expect(send).not.toHaveBeenCalled()
    expect(q.list()).toHaveLength(1)
  })

  it('concurrent flushes share one run', async () => {
    const { q, send } = make()
    q.complete(play('a'))
    await Promise.all([q.flush(), q.flush()])
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('caps the queue and discards entries older than the max age', () => {
    const now = Date.parse('2026-02-01T00:00:00Z')
    const { q } = make(undefined, 'u1', () => now)
    q.complete(play('old', 40, { at: new Date(now - MAX_PENDING_AGE_MS - 1000).toISOString() }))
    q.complete(play('fresh', 40, { at: new Date(now - 1000).toISOString() }))
    expect(q.list().map((e) => e.playId)).toEqual(['fresh'])
    for (let i = 0; i < MAX_PENDING + 20; i++) q.complete(play(`n${i}`, 40, { at: new Date(now - 1000).toISOString() }))
    expect(q.list()).toHaveLength(MAX_PENDING)
    expect(q.list().at(-1)!.playId).toBe(`n${MAX_PENDING + 19}`)
  })

  it('survives broken or unavailable storage', async () => {
    localStorage.setItem(PENDING_KEY, '{oops')
    const { q } = make()
    expect(q.list()).toEqual([])
    localStorage.setItem(PENDING_KEY, JSON.stringify([{ nope: 1 }]))
    expect(q.list()).toEqual([])
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    expect(() => q.save(play('a'))).not.toThrow()
  })
})
