import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanTitle, LrclibClient, scoreRecord, type LrclibRecord, type LyricsQuery } from '@/lyrics/lrclib'
import { fakeFetch, hangUntilAbort, jsonResponse, textResponse, type FakeFetch } from '../helpers/http'

function rec(over: Partial<LrclibRecord> = {}): LrclibRecord {
  return {
    id: 1,
    trackName: 'Song',
    artistName: 'Artist',
    albumName: 'Album',
    duration: 200,
    instrumental: false,
    plainLyrics: 'plain words',
    syncedLyrics: '[00:01.00] synced words',
    ...over
  }
}

const Q: LyricsQuery = { title: 'Song', artist: 'Artist', album: 'Album', duration: 200 }

describe('cleanTitle', () => {
  it.each([
    ['Song', 'Song'],
    ['Song (feat. Someone)', 'Song'],
    ['Song (ft. Someone)', 'Song'],
    ['Song [feat. A & B]', 'Song'],
    ['Song (with Other Artist)', 'Song'],
    ['Song (Feat Someone) ', 'Song'],
    ['Song - Remastered', 'Song'],
    ['Song - Remastered 2011', 'Song'],
    ['Song - 2011 Remaster', 'Song'],
    ['Song - 2011 Remastered Version', 'Song'],
    ['Song (Remastered)', 'Song'],
    ['Song (2011 Remaster)', 'Song'],
    ['Song [Remastered 2009]', 'Song'],
    ['Song - Live at Wembley', 'Song'],
    ['Song - Radio Edit', 'Song'],
    ['Song - Single Version', 'Song'],
    ['Song - Mono', 'Song'],
    ['Song - Stereo Mix', 'Song'],
    ['Song (feat. X) - Remastered 2011', 'Song'],
    ['  Song  ', 'Song']
  ])('%j -> %j', (input, out) => {
    expect(cleanTitle(input)).toBe(out)
  })

  it('leaves meaningful parentheticals and hyphens alone', () => {
    expect(cleanTitle('Song (Part II)')).toBe('Song (Part II)')
    expect(cleanTitle('Half-Life')).toBe('Half-Life')
    expect(cleanTitle('Song - Interlude')).toBe('Song - Interlude')
    expect(cleanTitle('Without You')).toBe('Without You')
  })

  it('returns an empty string for an empty title', () => {
    expect(cleanTitle('')).toBe('')
  })
})

describe('scoreRecord', () => {
  it('scores a perfect synced match as 0', () => {
    expect(scoreRecord(rec(), Q)).toBe(0)
  })

  it('rejects records with no lyrics at all', () => {
    expect(scoreRecord(rec({ plainLyrics: null, syncedLyrics: null }), Q)).toBe(Infinity)
  })

  it('accepts instrumental records without lyrics', () => {
    expect(scoreRecord(rec({ plainLyrics: null, syncedLyrics: null, instrumental: true }), Q)).toBeLessThan(Infinity)
  })

  it('rejects duration differences above 5 seconds, accepts up to 5', () => {
    expect(scoreRecord(rec({ duration: 206 }), Q)).toBe(Infinity)
    expect(scoreRecord(rec({ duration: 194 }), Q)).toBe(Infinity)
    expect(scoreRecord(rec({ duration: 205 }), Q)).toBe(50)
    expect(scoreRecord(rec({ duration: 197 }), Q)).toBe(30)
  })

  it('ignores duration when the query has none', () => {
    expect(scoreRecord(rec({ duration: 9999 }), { title: 'Song', artist: 'Artist' })).toBe(0)
  })

  it('penalizes title mismatch (+30), ignoring case, accents and punctuation', () => {
    expect(scoreRecord(rec({ trackName: 'Other' }), Q)).toBe(30)
    expect(scoreRecord(rec({ trackName: 'SÓNG!' }), Q)).toBe(0)
  })

  it('compares against the cleaned query title', () => {
    expect(scoreRecord(rec(), { ...Q, title: 'Song (feat. X) - Remastered 2011' })).toBe(0)
  })

  it('penalizes artist mismatch (+50) but accepts containment either way', () => {
    expect(scoreRecord(rec({ artistName: 'Someone Else' }), Q)).toBe(50)
    expect(scoreRecord(rec({ artistName: 'Artist & Friends' }), Q)).toBe(0)
    expect(scoreRecord(rec({ artistName: 'Art' }), Q)).toBe(0)
  })

  it('penalizes unsynced lyrics (+20)', () => {
    expect(scoreRecord(rec({ syncedLyrics: null }), Q)).toBe(20)
  })

  it('accumulates penalties', () => {
    expect(scoreRecord(rec({ trackName: 'X', artistName: 'Y', syncedLyrics: null, duration: 202 }), Q)).toBe(20 + 30 + 50 + 20)
  })
})

describe('LrclibClient.find', () => {
  let delays: number[]
  let sleep: (ms: number) => Promise<void>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    delays = []
    // A sleep that records the delay and advances the (fake) wall clock.
    sleep = async (ms) => {
      delays.push(ms)
      vi.setSystemTime(Date.now() + ms)
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const client = (f: FakeFetch, random = () => 0.5): LrclibClient => new LrclibClient({ fetch: f, sleep, random })
  const path = (c: { url: string }): string => c.url.replace('https://lrclib.net', '')

  it('returns synced lyrics from an exact /api/get hit and sends cleaned params', async () => {
    const f = fakeFetch(() => jsonResponse(rec()))
    const r = await client(f).find({ title: 'Song (feat. X) - Remastered 2011', artist: 'Artist', album: 'Album', duration: 199.6 })
    expect(r).toEqual({ kind: 'synced', text: '[00:01.00] synced words', plain: 'plain words', source: 'lrclib' })
    expect(f.calls).toHaveLength(1)
    const url = new URL(f.calls[0]!.url)
    expect(url.origin + url.pathname).toBe('https://lrclib.net/api/get')
    expect(Object.fromEntries(url.searchParams)).toEqual({ track_name: 'Song', artist_name: 'Artist', album_name: 'Album', duration: '200' })
  })

  it('omits album and out-of-range durations', async () => {
    for (const duration of [undefined, 0, 0.5, 3601]) {
      const f = fakeFetch(() => jsonResponse(rec()))
      await client(f).find({ title: 'S', artist: 'A', duration })
      const params = new URL(f.calls[0]!.url).searchParams
      expect(params.has('album_name')).toBe(false)
      expect(params.has('duration')).toBe(false)
    }
    const f = fakeFetch(() => jsonResponse(rec()))
    await client(f).find({ title: 'S', artist: 'A', duration: 3600 })
    expect(new URL(f.calls[0]!.url).searchParams.get('duration')).toBe('3600')
  })

  it('returns plain lyrics when only plain exists', async () => {
    const f = fakeFetch(() => jsonResponse(rec({ syncedLyrics: null })))
    expect(await client(f).find(Q)).toEqual({ kind: 'plain', text: 'plain words', source: 'lrclib' })
  })

  it('returns instrumental', async () => {
    const f = fakeFetch(() => jsonResponse(rec({ instrumental: true, plainLyrics: null, syncedLyrics: null })))
    expect(await client(f).find(Q)).toEqual({ kind: 'instrumental', source: 'lrclib' })
  })

  it('prefers instrumental over lyrics text if both flagged', async () => {
    const f = fakeFetch(() => jsonResponse(rec({ instrumental: true })))
    expect(await client(f).find(Q)).toEqual({ kind: 'instrumental', source: 'lrclib' })
  })

  it('falls back to /api/search on 404 and picks the best match by duration', async () => {
    const hits = [
      rec({ id: 1, duration: 204, syncedLyrics: '[00:01.00] far' }),
      rec({ id: 2, duration: 200, syncedLyrics: '[00:01.00] exact' }),
      rec({ id: 3, duration: 230, syncedLyrics: '[00:01.00] way off' })
    ]
    const f = fakeFetch((c) => (c.url.includes('/api/get') ? jsonResponse({ code: 404 }, { status: 404 }) : jsonResponse(hits)))
    const r = await client(f).find(Q)
    expect(r).toMatchObject({ kind: 'synced', text: '[00:01.00] exact' })
    expect(f.calls.map(path).map((p) => p.split('?')[0])).toEqual(['/api/get', '/api/search'])
    const search = new URL(f.calls[1]!.url).searchParams
    expect(Object.fromEntries(search)).toEqual({ track_name: 'Song', artist_name: 'Artist' })
  })

  it('falls back to search when the exact record has no usable content', async () => {
    const f = fakeFetch((c) =>
      c.url.includes('/api/get')
        ? jsonResponse(rec({ plainLyrics: null, syncedLyrics: null, instrumental: false }))
        : jsonResponse([rec({ syncedLyrics: '[00:01.00] from search' })])
    )
    expect(await client(f).find(Q)).toMatchObject({ text: '[00:01.00] from search' })
  })

  it('prefers synced over plain among otherwise equal hits', async () => {
    const hits = [rec({ id: 1, syncedLyrics: null, plainLyrics: 'only plain' }), rec({ id: 2 })]
    const f = fakeFetch((c) => (c.url.includes('/api/get') ? jsonResponse({}, { status: 404 }) : jsonResponse(hits)))
    expect((await client(f).find(Q)).kind).toBe('synced')
  })

  it('returns none when search yields nothing usable', async () => {
    const notFound = (c: { url: string }, hits: unknown) => (c.url.includes('/api/get') ? jsonResponse({}, { status: 404 }) : jsonResponse(hits))
    for (const hits of [[], {}, null, [rec({ duration: 500 })], [rec({ plainLyrics: null, syncedLyrics: null })]]) {
      const f = fakeFetch((c) => notFound(c, hits))
      expect(await client(f).find(Q)).toEqual({ kind: 'none' })
    }
  })

  it('returns none when both endpoints 404', async () => {
    const f = fakeFetch(() => jsonResponse({}, { status: 404 }))
    expect(await client(f).find(Q)).toEqual({ kind: 'none' })
    expect(f.calls).toHaveLength(2)
  })

  it('search uses the query duration to ignore hits when none was given', async () => {
    const hits = [rec({ duration: 999 })]
    const f = fakeFetch((c) => (c.url.includes('/api/get') ? jsonResponse({}, { status: 404 }) : jsonResponse(hits)))
    expect((await client(f).find({ title: 'Song', artist: 'Artist' })).kind).toBe('synced')
  })

  describe('rate limiting', () => {
    it('honours Retry-After once, adding jitter, then succeeds', async () => {
      let n = 0
      const f = fakeFetch(() => (n++ === 0 ? jsonResponse({}, { status: 429, headers: { 'Retry-After': '2' } }) : jsonResponse(rec())))
      const r = await client(f, () => 0.5).find(Q)
      expect(r.kind).toBe('synced')
      expect(delays).toEqual([2000 + 2000 * 0.3 * 0.5])
      expect(f.calls).toHaveLength(2)
      expect(f.calls[1]!.url).toBe(f.calls[0]!.url)
    })

    it('adds no jitter when random() is 0 and max jitter (30%) when it is 1', async () => {
      for (const [rnd, expected] of [[0, 3000], [1, 3900]] as const) {
        delays.length = 0
        let n = 0
        const f = fakeFetch(() => (n++ === 0 ? jsonResponse({}, { status: 429, headers: { 'Retry-After': '3' } }) : jsonResponse(rec())))
        await client(f, () => rnd).find({ ...Q, title: `T${rnd}` })
        expect(delays).toEqual([expected])
      }
    })

    it.each([[undefined], ['abc'], ['0'], ['-3']])('defaults to 1s for Retry-After %p', async (header) => {
      let n = 0
      const headers: Record<string, string> = header === undefined ? {} : { 'Retry-After': header }
      const f = fakeFetch(() => (n++ === 0 ? jsonResponse({}, { status: 429, headers }) : jsonResponse(rec())))
      await client(f, () => 0).find(Q)
      expect(delays).toEqual([1000])
    })

    it('retries on 503 as well', async () => {
      let n = 0
      const f = fakeFetch(() => (n++ === 0 ? jsonResponse({}, { status: 503 }) : jsonResponse(rec())))
      expect((await client(f).find(Q)).kind).toBe('synced')
      expect(delays).toHaveLength(1)
    })

    it('gives up (throws) when the retry is rate limited again', async () => {
      const f = fakeFetch(() => jsonResponse({}, { status: 429, headers: { 'Retry-After': '1' } }))
      await expect(client(f).find(Q)).rejects.toThrow('Lyrics lookup failed (429)')
      expect(f.calls).toHaveLength(2)
      expect(delays).toHaveLength(1)
    })

    it('delays the next queued request until the rate-limit window has passed', async () => {
      let n = 0
      const f = fakeFetch((c) => {
        n++
        if (n === 1) return jsonResponse({}, { status: 429, headers: { 'Retry-After': '1' } })
        if (c.url.includes('track_name=Song') && c.url.includes('/api/get')) return jsonResponse(rec())
        return jsonResponse(rec())
      })
      const lrc = client(f, () => 0)
      await lrc.find(Q)
      // Pretend the clock did not advance (e.g. clock skew): the next call must wait out the window.
      vi.setSystemTime(1_000_000)
      delays.length = 0
      await lrc.find({ ...Q, title: 'Another' })
      expect(delays.length).toBe(1)
      expect(delays[0]).toBeGreaterThan(0)
      expect(delays[0]).toBeLessThanOrEqual(1000)
    })
  })

  describe('errors', () => {
    it('throws on non-OK, non-404 responses', async () => {
      await expect(client(fakeFetch(() => jsonResponse({}, { status: 500 }))).find(Q)).rejects.toThrow('Lyrics lookup failed (500)')
      await expect(client(fakeFetch(() => jsonResponse({}, { status: 400 }))).find({ ...Q, title: 'x' })).rejects.toThrow('(400)')
    })

    it('throws on a non-JSON success response', async () => {
      const f = fakeFetch(() => textResponse('<html>captive portal</html>'))
      await expect(client(f).find(Q)).rejects.toThrow('unexpected response')
    })

    it('propagates network errors and does not cache failures', async () => {
      let n = 0
      const f = fakeFetch(() => {
        if (n++ === 0) throw new TypeError('Failed to fetch')
        return jsonResponse(rec())
      })
      const lrc = client(f)
      await expect(lrc.find(Q)).rejects.toThrow('Failed to fetch')
      await expect(lrc.find(Q)).resolves.toMatchObject({ kind: 'synced' })
    })

    it('a failed lookup does not block later ones', async () => {
      let n = 0
      const f = fakeFetch(() => (n++ === 0 ? jsonResponse({}, { status: 500 }) : jsonResponse(rec())))
      const lrc = client(f)
      const a = lrc.find({ ...Q, title: 'A' })
      const b = lrc.find({ ...Q, title: 'B' })
      await expect(a).rejects.toThrow()
      await expect(b).resolves.toMatchObject({ kind: 'synced' })
    })

    it('forwards the abort signal to fetch and rejects when aborted', async () => {
      const f = fakeFetch((c) => hangUntilAbort(c.signal))
      const ctrl = new AbortController()
      const p = client(f).find(Q, ctrl.signal)
      const assertion = expect(p).rejects.toMatchObject({ name: 'AbortError' })
      await Promise.resolve()
      await Promise.resolve()
      ctrl.abort()
      await assertion
      expect(f.calls[0]!.signal).toBe(ctrl.signal)
    })
  })

  describe('caching', () => {
    it('serves a repeated query from cache without fetching', async () => {
      const f = fakeFetch(() => jsonResponse(rec()))
      const lrc = client(f)
      const a = await lrc.find(Q)
      const b = await lrc.find(Q)
      expect(b).toBe(a)
      expect(f.calls).toHaveLength(1)
    })

    it('shares the cache between equivalent queries (title noise, case, rounded duration)', async () => {
      const f = fakeFetch(() => jsonResponse(rec()))
      const lrc = client(f)
      await lrc.find({ title: 'Song', artist: 'Artist', duration: 200 })
      await lrc.find({ title: 'SONG (feat. X)', artist: 'ARTIST', duration: 200.4 })
      expect(f.calls).toHaveLength(1)
    })

    it('does not share between different artists or durations', async () => {
      const f = fakeFetch(() => jsonResponse(rec()))
      const lrc = client(f)
      await lrc.find(Q)
      await lrc.find({ ...Q, artist: 'Someone Else' })
      await lrc.find({ ...Q, duration: 260 })
      expect(f.calls).toHaveLength(3)
    })

    it('caches "none" results', async () => {
      const f = fakeFetch(() => jsonResponse({}, { status: 404 }))
      const lrc = client(f)
      await lrc.find(Q)
      await lrc.find(Q)
      expect(f.calls).toHaveLength(2) // get + search only for the first call
    })

    it('evicts old entries beyond cacheSize', async () => {
      const f = fakeFetch(() => jsonResponse(rec()))
      const lrc = new LrclibClient({ fetch: f, sleep, cacheSize: 1 })
      await lrc.find({ ...Q, title: 'A' })
      await lrc.find({ ...Q, title: 'B' })
      await lrc.find({ ...Q, title: 'A' })
      expect(f.calls).toHaveLength(3)
    })

    it('computes stable keys', () => {
      expect(LrclibClient.key({ title: 'Song (feat. X)', artist: 'Ärtist', duration: 199.6 })).toBe('artist|song|200')
      expect(LrclibClient.key({ title: 'Song', artist: 'A' })).toBe('a|song|')
    })
  })

  describe('serialization', () => {
    it('never has two requests in flight at once', async () => {
      let inflight = 0
      let max = 0
      const f = fakeFetch(async () => {
        inflight++
        max = Math.max(max, inflight)
        await new Promise((r) => setTimeout(r, 10))
        inflight--
        return jsonResponse(rec())
      })
      const lrc = client(f)
      const all = Promise.all(['a', 'b', 'c', 'd'].map((t) => lrc.find({ ...Q, title: t })))
      await vi.advanceTimersByTimeAsync(100)
      await all
      expect(max).toBe(1)
      expect(f.calls).toHaveLength(4)
    })

    it('answers queued duplicates from the cache instead of fetching twice', async () => {
      const f = fakeFetch(async () => {
        await new Promise((r) => setTimeout(r, 10))
        return jsonResponse(rec())
      })
      const lrc = client(f)
      const all = Promise.all([lrc.find(Q), lrc.find(Q), lrc.find(Q)])
      await vi.advanceTimersByTimeAsync(100)
      const [a, b, c] = await all
      expect(f.calls).toHaveLength(1)
      expect(b).toBe(a)
      expect(c).toBe(a)
    })

    it('processes requests in call order', async () => {
      const order: string[] = []
      const f = fakeFetch((c) => {
        order.push(new URL(c.url).searchParams.get('track_name')!)
        return jsonResponse(rec())
      })
      const lrc = client(f)
      await Promise.all(['one', 'two', 'three'].map((t) => lrc.find({ ...Q, title: t })))
      expect(order).toEqual(['one', 'two', 'three'])
    })
  })

  describe('privacy', () => {
    it('identifies the client and never sends credentials or auth headers', async () => {
      const f = fakeFetch((c) => (c.url.includes('/api/get') ? jsonResponse({}, { status: 404 }) : jsonResponse([rec()])))
      await client(f).find(Q)
      expect(f.calls).toHaveLength(2)
      for (const c of f.calls) {
        expect(c.init.credentials).toBe('omit')
        expect(c.headers['Lrclib-Client']).toMatch(/^Nocturne v/)
        expect(c.headers['Lrclib-Client']).toContain('(https://')
        expect(c.headers.Accept).toBe('application/json')
        expect(Object.keys(c.headers).map((h) => h.toLowerCase())).not.toContain('authorization')
        expect(Object.keys(c.headers).map((h) => h.toLowerCase())).not.toContain('cookie')
        expect(new URL(c.url).origin).toBe('https://lrclib.net')
      }
    })
  })

  describe('defaults', () => {
    it('uses global fetch, real sleep and Math.random when none are injected', async () => {
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(rec()))
      const lrc = new LrclibClient()
      await expect(lrc.find(Q)).resolves.toMatchObject({ kind: 'synced' })
      expect(spy).toHaveBeenCalledOnce()
    })

    it('real sleep path: retries after a timer-driven delay', async () => {
      let n = 0
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        n++ === 0 ? jsonResponse({}, { status: 429, headers: { 'Retry-After': '1' } }) : jsonResponse(rec())
      )
      vi.spyOn(Math, 'random').mockReturnValue(0)
      const p = new LrclibClient().find(Q)
      await vi.advanceTimersByTimeAsync(1000)
      await expect(p).resolves.toMatchObject({ kind: 'synced' })
    })
  })
})
