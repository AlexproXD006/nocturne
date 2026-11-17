import { describe, expect, it, vi } from 'vitest'
import { resolveLyrics, type LyricsDeps } from '@/lyrics/service'
import type { LrclibResult } from '@/lyrics/lrclib'
import type { ServerLyrics } from '@/api/types'
import { track } from '../helpers/fixtures'

const TTML_WORDS =
  '<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="1s" end="3s"><span begin="1s" end="2s">stored</span> <span begin="2s" end="3s">words</span></p></div></body></tt>'
const TTML_LINES = '<tt><body><div><p begin="1s" end="3s">stored line</p><p begin="4s">second</p></div></body></tt>'
const TTML_UNTIMED = '<tt><body><div><p>untimed one</p><p>untimed two</p></div></body></tt>'

const SYNCED = '[00:01.00] one\n[00:02.00] two'

function deps(lrclib: LrclibResult | Error, server?: ServerLyrics | Error | null): LyricsDeps & { find: ReturnType<typeof vi.fn>; serverFn?: ReturnType<typeof vi.fn> } {
  const find = vi.fn(async () => {
    if (lrclib instanceof Error) throw lrclib
    return lrclib
  })
  if (server === undefined) return { lrclib: { find }, find }
  const serverFn = vi.fn(async () => {
    if (server instanceof Error) throw server
    return server as ServerLyrics
  })
  return { lrclib: { find }, server: serverFn, find, serverFn }
}

describe('resolveLyrics', () => {
  it('queries LRCLIB with title, first artist, album and duration', async () => {
    const d = deps({ kind: 'none' })
    await resolveLyrics(
      track('t1', { title: 'Hello', artists: [{ id: 'a', name: 'Adele' }, { id: 'b', name: 'Other' }], album: { id: 'x', title: '25' }, duration: 295 }),
      d
    )
    expect(d.find).toHaveBeenCalledWith({ title: 'Hello', artist: 'Adele', album: '25', duration: 295 }, expect.any(AbortSignal))
  })

  it('handles tracks with no artist, no album and zero duration', async () => {
    const d = deps({ kind: 'none' })
    await resolveLyrics(track('t1', { artists: [], album: null, duration: 0 }), d)
    expect(d.find).toHaveBeenCalledWith({ title: 'Title t1', artist: '', album: undefined, duration: undefined }, expect.any(AbortSignal))
  })

  it('LRCLIB synced wins over server LRC (the server is asked in parallel)', async () => {
    const d = deps({ kind: 'synced', text: SYNCED, plain: 'x', source: 'lrclib' }, { synced: '[00:00.00] server', plain: null })
    const r = await resolveLyrics(track('t1'), d)
    expect(r).toMatchObject({ kind: 'synced', source: 'lrclib' })
    expect(r.kind === 'synced' && r.parsed.lines.map((l) => l.text)).toEqual(['one', 'two'])
  })

  it('instrumental from LRCLIB is final', async () => {
    const d = deps({ kind: 'instrumental', source: 'lrclib' }, { synced: SYNCED, plain: null })
    expect(await resolveLyrics(track('t1'), d)).toEqual({ kind: 'instrumental', source: 'lrclib' })
  })

  describe('plain LRCLIB result', () => {
    const plain: LrclibResult = { kind: 'plain', text: 'line one\nline two', source: 'lrclib' }

    it('is returned when no server is configured', async () => {
      const r = await resolveLyrics(track('t1'), deps(plain))
      expect(r).toMatchObject({ kind: 'plain', source: 'lrclib' })
      expect(r.kind === 'plain' && r.parsed.lines.map((l) => l.text)).toEqual(['line one', 'line two'])
    })

    it('is upgraded by synced lyrics from the server', async () => {
      const r = await resolveLyrics(track('t1'), deps(plain, { synced: SYNCED, plain: 'ignored' }))
      expect(r).toMatchObject({ kind: 'synced', source: 'server' })
    })

    it('is kept when the server only has plain lyrics', async () => {
      const r = await resolveLyrics(track('t1'), deps(plain, { synced: null, plain: 'server plain' }))
      expect(r).toMatchObject({ kind: 'plain', source: 'lrclib' })
    })

    it('is kept when the server has nothing', async () => {
      const r = await resolveLyrics(track('t1'), deps(plain, { synced: null, plain: null }))
      expect(r).toMatchObject({ kind: 'plain', source: 'lrclib' })
    })

    it('is kept when the server fails', async () => {
      const r = await resolveLyrics(track('t1'), deps(plain, new Error('500') as never))
      expect(r).toMatchObject({ kind: 'plain', source: 'lrclib' })
    })
  })

  describe('LRCLIB synced but unparsable', () => {
    it('falls back to its plain text when present', async () => {
      const d = deps({ kind: 'synced', text: 'no timestamps here', plain: 'plain fallback', source: 'lrclib' })
      expect(await resolveLyrics(track('t1'), d)).toMatchObject({ kind: 'plain', source: 'lrclib' })
    })

    it('goes to the server when there is no plain text either', async () => {
      const d = deps({ kind: 'synced', text: 'garbage', plain: null, source: 'lrclib' }, { synced: SYNCED, plain: null })
      expect(await resolveLyrics(track('t1'), d)).toMatchObject({ kind: 'synced', source: 'server' })
    })

    it('returns none when nothing else works', async () => {
      const d = deps({ kind: 'synced', text: 'garbage', plain: null, source: 'lrclib' })
      expect(await resolveLyrics(track('t1'), d)).toEqual({ kind: 'none' })
    })
  })

  describe('LRCLIB has nothing', () => {
    it('uses server synced lyrics', async () => {
      const r = await resolveLyrics(track('t1'), deps({ kind: 'none' }, { synced: SYNCED, plain: null }))
      expect(r).toMatchObject({ kind: 'synced', source: 'server' })
    })

    it('uses server plain lyrics', async () => {
      const r = await resolveLyrics(track('t1'), deps({ kind: 'none' }, { synced: null, plain: 'a\nb' }))
      expect(r).toMatchObject({ kind: 'plain', source: 'server' })
    })

    it('prefers server synced over server plain', async () => {
      const r = await resolveLyrics(track('t1'), deps({ kind: 'none' }, { synced: SYNCED, plain: 'plain' }))
      expect(r.kind).toBe('synced')
    })

    it('falls back to server plain when the server synced text is unparsable', async () => {
      const r = await resolveLyrics(track('t1'), deps({ kind: 'none' }, { synced: 'no stamps', plain: 'plain' }))
      expect(r).toMatchObject({ kind: 'plain', source: 'server' })
    })

    it('returns none when the server has nothing, returns null, or is absent', async () => {
      expect(await resolveLyrics(track('t1'), deps({ kind: 'none' }, { synced: null, plain: null }))).toEqual({ kind: 'none' })
      expect(await resolveLyrics(track('t1'), deps({ kind: 'none' }, { synced: ' \n ', plain: '  ' }))).toEqual({ kind: 'none' })
      expect(await resolveLyrics(track('t1'), deps({ kind: 'none' }, null))).toEqual({ kind: 'none' })
      expect(await resolveLyrics(track('t1'), deps({ kind: 'none' }))).toEqual({ kind: 'none' })
    })

    it('passes the track id and signal to the server fetcher', async () => {
      const d = deps({ kind: 'none' }, { synced: null, plain: null })
      const ctrl = new AbortController()
      await resolveLyrics(track('track-42'), d, ctrl.signal)
      expect(d.serverFn).toHaveBeenCalledWith('track-42', ctrl.signal)
    })
  })

  describe('failures', () => {
    it('falls back to the server when LRCLIB throws', async () => {
      const r = await resolveLyrics(track('t1'), deps(new Error('network'), { synced: SYNCED, plain: null }))
      expect(r).toMatchObject({ kind: 'synced', source: 'server' })
    })

    it('returns none when both fail', async () => {
      const r = await resolveLyrics(track('t1'), deps(new Error('network'), new Error('server')))
      expect(r).toEqual({ kind: 'none' })
    })

    it('returns none when LRCLIB fails and there is no server', async () => {
      expect(await resolveLyrics(track('t1'), deps(new Error('network')))).toEqual({ kind: 'none' })
    })

    it('propagates aborts from LRCLIB', async () => {
      const ctrl = new AbortController()
      const err = new DOMException('aborted', 'AbortError')
      const d = deps(err, { synced: SYNCED, plain: null })
      d.find.mockImplementation(async () => {
        ctrl.abort()
        throw err
      })
      await expect(resolveLyrics(track('t1'), d, ctrl.signal)).rejects.toBe(err)
    })

    it('propagates aborts from the server', async () => {
      const ctrl = new AbortController()
      const err = new DOMException('aborted', 'AbortError')
      const d = deps({ kind: 'none' }, { synced: null, plain: null })
      d.serverFn!.mockImplementation(async () => {
        ctrl.abort()
        throw err
      })
      await expect(resolveLyrics(track('t1'), d, ctrl.signal)).rejects.toBe(err)
    })

    it('does not treat errors as aborts when the signal is not aborted', async () => {
      const ctrl = new AbortController()
      const r = await resolveLyrics(track('t1'), deps(new Error('x'), new Error('y')), ctrl.signal)
      expect(r).toEqual({ kind: 'none' })
    })
  })

  describe('stored TTML', () => {
    it('wins over LRCLIB synced and server LRC, with word timing', async () => {
      const d = deps({ kind: 'synced', text: SYNCED, plain: null, source: 'lrclib' }, { synced: SYNCED, plain: 'p', ttml: TTML_WORDS })
      const r = await resolveLyrics(track('t1'), d)
      expect(r).toMatchObject({ kind: 'synced', source: 'ttml' })
      expect(r.kind === 'synced' && r.parsed.wordSynced).toBe(true)
      expect(r.kind === 'synced' && r.parsed.lines[0]!.text).toBe('stored words')
    })

    it('supports line-only TTML', async () => {
      const r = await resolveLyrics(track('t1'), deps({ kind: 'none' }, { synced: null, plain: null, ttml: TTML_LINES }))
      expect(r).toMatchObject({ kind: 'synced', source: 'ttml' })
      expect(r.kind === 'synced' && r.parsed.wordSynced).toBeUndefined()
    })

    it('wins even when LRCLIB says instrumental', async () => {
      const r = await resolveLyrics(track('t1'), deps({ kind: 'instrumental', source: 'lrclib' }, { synced: null, plain: null, ttml: TTML_WORDS }))
      expect(r).toMatchObject({ kind: 'synced', source: 'ttml' })
    })

    it('cancels the LRCLIB request once TTML has won', async () => {
      let signal: AbortSignal | undefined
      const d = deps({ kind: 'none' }, { synced: null, plain: null, ttml: TTML_WORDS })
      d.find.mockImplementation((async (_q: unknown, s?: AbortSignal) => {
        signal = s
        return new Promise(() => undefined)
      }) as never)
      const r = await resolveLyrics(track('t1'), d)
      expect(r).toMatchObject({ source: 'ttml' })
      expect(signal?.aborted).toBe(true)
    })

    it('is ignored when it cannot be parsed, falling through the chain', async () => {
      const bad = '<!DOCTYPE tt [<!ENTITY x "y">]><tt><body><p begin="1s">x</p></body></tt>'
      const r = await resolveLyrics(track('t1'), deps({ kind: 'synced', text: SYNCED, plain: null, source: 'lrclib' }, { synced: null, plain: null, ttml: bad }))
      expect(r).toMatchObject({ kind: 'synced', source: 'lrclib' })
    })

    it('null ttml (older servers or none stored) falls through', async () => {
      const r = await resolveLyrics(track('t1'), deps({ kind: 'none' }, { synced: SYNCED, plain: null, ttml: null }))
      expect(r).toMatchObject({ kind: 'synced', source: 'server' })
    })

    it('untimed TTML is plain lyrics from the library, preferred over LRCLIB plain but not over any synced source', async () => {
      const plain: LrclibResult = { kind: 'plain', text: 'lrclib plain', source: 'lrclib' }
      const a = await resolveLyrics(track('t1'), deps(plain, { synced: null, plain: 'server plain', ttml: TTML_UNTIMED }))
      expect(a).toMatchObject({ kind: 'plain', source: 'ttml' })
      expect(a.kind === 'plain' && a.parsed.lines.map((l) => l.text)).toEqual(['untimed one', 'untimed two'])
      const b = await resolveLyrics(track('t1'), deps({ kind: 'synced', text: SYNCED, plain: null, source: 'lrclib' }, { synced: null, plain: null, ttml: TTML_UNTIMED }))
      expect(b).toMatchObject({ kind: 'synced', source: 'lrclib' })
      const c = await resolveLyrics(track('t1'), deps({ kind: 'none' }, { synced: SYNCED, plain: null, ttml: TTML_UNTIMED }))
      expect(c).toMatchObject({ kind: 'synced', source: 'server' })
    })
  })

  describe('resolution order without TTML', () => {
    it('LRCLIB synced > server LRC > LRCLIB plain > server plain', async () => {
      const lrclibSynced: LrclibResult = { kind: 'synced', text: '[00:01.00] l', plain: null, source: 'lrclib' }
      const lrclibPlain: LrclibResult = { kind: 'plain', text: 'lp', source: 'lrclib' }
      const srv = { synced: '[00:01.00] s', plain: 'sp' }
      expect(await resolveLyrics(track('t1'), deps(lrclibSynced, srv))).toMatchObject({ kind: 'synced', source: 'lrclib' })
      expect(await resolveLyrics(track('t1'), deps(lrclibPlain, srv))).toMatchObject({ kind: 'synced', source: 'server' })
      expect(await resolveLyrics(track('t1'), deps(lrclibPlain, { synced: null, plain: 'sp' }))).toMatchObject({ kind: 'plain', source: 'lrclib' })
      expect(await resolveLyrics(track('t1'), deps({ kind: 'none' }, { synced: null, plain: 'sp' }))).toMatchObject({ kind: 'plain', source: 'server' })
    })
  })

  describe('parallel requests', () => {
    it('starts the server and LRCLIB requests together, not one after the other', async () => {
      const order: string[] = []
      let releaseServer!: (v: ServerLyrics) => void
      const find = vi.fn(async () => {
        order.push('lrclib')
        return { kind: 'none' } as LrclibResult
      })
      const serverFn = vi.fn(
        () =>
          new Promise<ServerLyrics>((res) => {
            order.push('server')
            releaseServer = res
          })
      )
      const p = resolveLyrics(track('t1'), { lrclib: { find }, server: serverFn })
      await Promise.resolve()
      // The server has not answered yet, but LRCLIB was already asked.
      expect([...order].sort()).toEqual(['lrclib', 'server'])
      releaseServer({ synced: null, plain: null, ttml: TTML_WORDS })
      expect(await p).toMatchObject({ source: 'ttml' })
    })

    it('a slow LRCLIB does not delay stored TTML', async () => {
      const d = deps({ kind: 'none' }, { synced: null, plain: null, ttml: TTML_WORDS })
      d.find.mockImplementation((() => new Promise(() => undefined)) as never)
      await expect(resolveLyrics(track('t1'), d)).resolves.toMatchObject({ source: 'ttml' })
    })

    it('a failing server request never blocks LRCLIB', async () => {
      const r = await resolveLyrics(track('t1'), deps({ kind: 'synced', text: SYNCED, plain: null, source: 'lrclib' }, new Error('down')))
      expect(r).toMatchObject({ kind: 'synced', source: 'lrclib' })
    })

    it('a failing LRCLIB request never blocks the server TTML', async () => {
      const r = await resolveLyrics(track('t1'), deps(new Error('down'), { synced: null, plain: null, ttml: TTML_WORDS }))
      expect(r).toMatchObject({ source: 'ttml' })
    })

    it('an already aborted signal rejects with the abort error and aborts LRCLIB', async () => {
      const ctrl = new AbortController()
      ctrl.abort()
      const err = new DOMException('aborted', 'AbortError')
      const d = deps({ kind: 'none' }, { synced: null, plain: null })
      d.find.mockImplementation((async (_q: unknown, s?: AbortSignal) => {
        expect(s?.aborted).toBe(true)
        throw err
      }) as never)
      d.serverFn!.mockRejectedValue(err)
      await expect(resolveLyrics(track('t1'), d, ctrl.signal)).rejects.toBe(err)
    })
  })
})
