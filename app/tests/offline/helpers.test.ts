import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/errors'
import { availabilityOf, nextAvailableIndex, onlyAvailable } from '@/lib/offline/availability'
import { computeOnline, isNetworkFailure } from '@/lib/offline/connectivity'
import { searchStored } from '@/lib/offline/localSearch'
import { createLikeQueue } from '@/lib/offline/pendingLikes'
import { collectionKey, diffCollection, idsKeptBy, type DownloadedCollection } from '@/lib/offline/sync'
import { artTrackId } from '@/lib/url'
import { createConnectivityStore } from '@/store/connectivity'
import { track } from '../helpers/fixtures'

describe('playlist sync diff', () => {
  it('downloads new tracks and removes the ones that left', () => {
    expect(diffCollection(['a', 'b', 'c'], ['b', 'c', 'd', 'e'])).toEqual({ add: ['d', 'e'], remove: ['a'] })
  })
  it('keeps tracks another collection or a single download still wants', () => {
    expect(diffCollection(['a', 'b'], ['b'], new Set(['a']))).toEqual({ add: [], remove: [] })
  })
  it('dedupes repeated songs and handles empty sides', () => {
    expect(diffCollection([], ['a', 'a', 'b'])).toEqual({ add: ['a', 'b'], remove: [] })
    expect(diffCollection(['a'], [])).toEqual({ add: [], remove: ['a'] })
  })
  it('idsKeptBy ignores the collection being synced', () => {
    const c = (key: string, ids: string[]): DownloadedCollection => ({ key, kind: 'playlist', id: key, name: key, trackIds: ids, syncedAt: 0 })
    const cols = { [collectionKey('playlist', 'p1')]: c('playlist:p1', ['a']), 'playlist:p2': c('playlist:p2', ['b']) }
    expect([...idsKeptBy(cols, ['s'], 'playlist:p1')].sort()).toEqual(['b', 's'])
  })
})

describe('availability', () => {
  const have = new Set(['a'])
  it('badges stored tracks, greys unavailable ones only offline', () => {
    expect(availabilityOf('a', have, true)).toBe('available')
    expect(availabilityOf('b', have, true)).toBe('normal')
    expect(availabilityOf('b', have, false)).toBe('unavailable')
    expect(availabilityOf('a', { a: 'pinned' }, false)).toBe('available')
  })
  it('filters "available offline" and finds the next playable index', () => {
    const tracks = [track('a'), track('b'), track('c')]
    expect(onlyAvailable(tracks, new Set(['c', 'a'])).map((t) => t.id)).toEqual(['a', 'c'])
    expect(nextAvailableIndex(['a', 'b', 'c'], 0, new Set(['c']))).toBe(2)
    expect(nextAvailableIndex(['a', 'b', 'c'], 2, new Set(['a']))).toBe(-1)
    expect(nextAvailableIndex(['a', 'b', 'c'], 2, new Set(['a']), true)).toBe(0)
  })
})

describe('offline detection', () => {
  it('classifies transport failures, not server answers', () => {
    expect(isNetworkFailure(new ApiError('network', 'x'))).toBe(true)
    expect(isNetworkFailure(new ApiError('timeout', 'x'))).toBe(true)
    expect(isNetworkFailure(new ApiError('server', 'x', 500))).toBe(false)
    expect(isNetworkFailure(new ApiError('unauthorized', 'x', 401))).toBe(false)
    expect(isNetworkFailure(new TypeError('Failed to fetch'))).toBe(true)
    expect(isNetworkFailure(new Error('boom'))).toBe(false)
  })
  it('computeOnline combines the OS network, native connectivity and the server', () => {
    expect(computeOnline({ browser: true, native: null, apiReachable: true })).toBe(true)
    expect(computeOnline({ browser: false, native: null, apiReachable: true })).toBe(false)
    expect(computeOnline({ browser: true, native: false, apiReachable: true })).toBe(false)
    expect(computeOnline({ browser: false, native: true, apiReachable: true })).toBe(true)
    expect(computeOnline({ browser: true, native: null, apiReachable: false })).toBe(false)
  })

  it('the store goes offline after a network failure and recovers when the probe answers', async () => {
    vi.useFakeTimers()
    try {
      let up = false
      const ping = vi.fn(async () => {
        if (!up) throw new ApiError('network', 'down')
      })
      const s = createConnectivityStore({ browserOnline: () => true, ping, probeEveryMs: 1000 })
      expect(s.getState().online).toBe(true)
      s.getState().report(new ApiError('server', 'oops', 500)) // a server error is still "reachable"
      expect(s.getState().online).toBe(true)
      s.getState().report(new ApiError('network', 'down'))
      expect(s.getState().online).toBe(false)
      await vi.advanceTimersByTimeAsync(1000)
      expect(ping).toHaveBeenCalled()
      expect(s.getState().online).toBe(false)
      up = true
      await vi.advanceTimersByTimeAsync(1000)
      expect(s.getState().online).toBe(true)
      s.getState().setBrowser(false)
      expect(s.getState().online).toBe(false)
      s.getState().setBrowser(true)
      expect(s.getState().online).toBe(true)
      s.getState().setNative(false, false)
      expect(s.getState().online).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('offline search + art ids', () => {
  const t1 = track('1', { title: 'Árbol', artists: [{ id: 'a', name: 'Zeta' }] })
  const t2 = track('2', { title: 'Bruma', artists: [{ id: 'b', name: 'Yota' }], album: { id: 'al', title: 'Niebla' } })
  it('matches accent-insensitively over title, artist and album', () => {
    expect(searchStored([t1, t2], 'arbol').map((t) => t.id)).toEqual(['1'])
    expect(searchStored([t1, t2], 'yota niebla').map((t) => t.id)).toEqual(['2'])
    expect(searchStored([t1, t2], '   ')).toEqual([])
  })
  it('extracts the track id from art urls', () => {
    expect(artTrackId('https://s/v1/media/art/abc%20d?s=64&sig=1')).toBe('abc d')
    expect(artTrackId('https://s/other')).toBeNull()
  })
})

describe('offline like queue', () => {
  it('queues taps made offline (last one wins) and sends them later', async () => {
    let online = false
    const sent: [string, boolean][] = []
    const q = createLikeQueue({
      owner: () => 'u1',
      key: 'test.likes',
      now: () => 1,
      send: async (id, liked) => {
        if (!online) throw new ApiError('network', 'down')
        sent.push([id, liked])
      }
    })
    localStorage.removeItem('test.likes')
    await q.set('t1', true)
    await q.set('t1', false)
    await q.set('t2', true)
    expect(q.list().map((e) => [e.trackId, e.liked])).toEqual([['t1', false], ['t2', true]])
    await q.flush()
    expect(sent).toEqual([]) // still offline: kept
    online = true
    await q.flush()
    expect(sent).toEqual([['t1', false], ['t2', true]])
    expect(q.list()).toEqual([])
  })
  it('rethrows non-network errors without queueing', async () => {
    const q = createLikeQueue({ owner: () => 'u1', key: 'test.likes2', send: async () => { throw new ApiError('not_found', 'gone', 404) } })
    await expect(q.set('x', true)).rejects.toBeInstanceOf(ApiError)
    expect(q.list()).toEqual([])
  })
})
