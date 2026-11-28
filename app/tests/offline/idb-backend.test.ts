import { describe, expect, it } from 'vitest'
import { createIdbBackend } from '@/platform/offline/idbBackend'
import { memoryKv } from '@/platform/offline/kv'
import { QuotaError } from '@/platform/offline/types'

const resp = (n: number, headers: Record<string, string> = {}): Response =>
  new Response(new Uint8Array(n), { status: 200, headers: { 'content-length': String(n), ...headers } })

describe('IndexedDB audio backend', () => {
  const opts = (over: Partial<Parameters<typeof createIdbBackend>[0]> = {}) => {
    let t = 0
    return createIdbBackend({ audio: memoryKv(), fetch: (async () => resp(50)) as never, now: () => ++t, createObjectURL: () => 'blob:u', revokeObjectURL: () => undefined, storage: null, ...over })
  }
  const signal = new AbortController().signal

  it('stores, lists, plays and removes', async () => {
    const b = opts()
    const progress: number[] = []
    expect(await b.store('a', 'https://x/a', { pinned: true, onProgress: (n) => progress.push(n), signal })).toBe(50)
    expect(progress.at(-1)).toBe(50)
    expect((await b.list())[0]).toMatchObject({ id: 'a', bytes: 50, pinned: true })
    expect(await b.playbackUrl('a')).toBe('blob:u')
    expect(await b.playbackUrl('nope')).toBeNull()
    await b.remove(['a'])
    expect(await b.list()).toEqual([])
  })

  it('does not download a track twice (pins the cached copy)', async () => {
    let calls = 0
    const b = opts({ fetch: (async () => (calls++, resp(10))) as never })
    await b.store('a', 'u', { pinned: false, onProgress: () => undefined, signal })
    await b.store('a', 'u', { pinned: true, onProgress: () => undefined, signal })
    expect(calls).toBe(1)
    expect((await b.list())[0]!.pinned).toBe(true)
  })

  it('rejects truncated and failed responses', async () => {
    const short = opts({ fetch: (async () => new Response(new Uint8Array(5), { headers: { 'content-length': '10' } })) as never })
    await expect(short.store('a', 'u', { pinned: false, onProgress: () => undefined, signal })).rejects.toThrow()
    const bad = opts({ fetch: (async () => new Response('x', { status: 403 })) as never })
    await expect(bad.store('a', 'u', { pinned: false, onProgress: () => undefined, signal })).rejects.toThrow('403')
    expect(await bad.list()).toEqual([])
  })

  it('turns a quota error into QuotaError', async () => {
    const audio = memoryKv<never>()
    audio.put = async () => {
      throw new DOMException('full', 'QuotaExceededError')
    }
    const b = createIdbBackend({ audio, fetch: (async () => resp(5)) as never, storage: null })
    await expect(b.store('a', 'u', { pinned: false, onProgress: () => undefined, signal })).rejects.toBeInstanceOf(QuotaError)
  })

  it('applies the N-recent policy and clears only auto tracks', async () => {
    const b = opts()
    await b.store('dl', 'u', { pinned: true, onProgress: () => undefined, signal })
    for (let i = 0; i < 4; i++) await b.store(`p${i}`, 'u', { pinned: false, onProgress: () => undefined, signal })
    await b.touch('p0')
    const gone = await b.applyPolicy({ mode: 'tracks', tracks: 30, gb: 1 })
    expect(gone).toEqual([])
    expect((await b.estimate?.()) ?? null).toBeNull()
    expect(await b.clearAuto()).toHaveLength(4)
    expect((await b.list()).map((a) => a.id)).toEqual(['dl'])
  })

  it('reports the browser quota when available', async () => {
    const b = opts({ storage: { estimate: async () => ({ usage: 5, quota: 10 }) } })
    expect(await b.estimate?.()).toEqual({ usage: 5, quota: 10 })
  })
})
