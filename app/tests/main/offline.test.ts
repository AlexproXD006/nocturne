// @vitest-environment node
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OfflineStore, fileNameFor, fullLength, isSignedStreamUrl, isTeeableRange, parseRange } from '../../src/main/offline'

let dir: string
let clock = 0
let store: OfflineStore

const body = (n: number, chunks = 4): ReadableStream<Uint8Array> => {
  const bytes = new Uint8Array(n).map((_, i) => i % 251)
  const size = Math.ceil(n / chunks)
  return new ReadableStream({
    start(c) {
      for (let i = 0; i < n; i += size) c.enqueue(bytes.slice(i, i + size))
      c.close()
    }
  })
}
const broken = (): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(10))
      c.error(new Error('connection lost'))
    }
  })

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nocturne-offline-'))
  clock = 1000
  store = new OfflineStore(dir, () => ++clock)
  await store.init()
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('desktop offline store', () => {
  it('stores a stream, indexes it and survives a restart', async () => {
    expect(await store.capture('t1', body(1000), { expected: 1000, pinned: true, mime: 'audio/flac' })).toBe(1000)
    expect(store.list()).toEqual([{ id: 't1', bytes: 1000, pinned: true, lastPlayed: expect.any(Number) }])
    await store.save()
    const again = new OfflineStore(dir)
    await again.init()
    expect(again.has('t1')).toBe(true)
    expect(again.mimeOf('t1')).toBe('audio/flac')
    expect((await readFile(again.pathOf('t1'))).length).toBe(1000)
  })

  it('leaves nothing behind when the stream fails or is shorter than announced', async () => {
    await expect(store.capture('bad', broken(), { expected: 1000 })).rejects.toThrow()
    await expect(store.capture('short', body(500), { expected: 1000 })).rejects.toThrow('incomplete')
    expect(store.list()).toEqual([])
    expect(await readdir(join(dir, 'audio'))).toEqual([])
  })

  it('drops index entries whose file vanished or has the wrong size', async () => {
    await store.capture('t1', body(100), { expected: 100 })
    await store.save()
    await rm(store.pathOf('t1'))
    const again = new OfflineStore(dir)
    await again.init()
    expect(again.list()).toEqual([])
  })

  it('keeps the 30 most recently played auto-cached tracks and never evicts pinned ones', async () => {
    store.configure({ mode: 'tracks', tracks: 30, gb: 1 })
    await store.capture('dl', body(10), { expected: 10, pinned: true })
    for (let i = 0; i < 33; i++) await store.capture(`p${i}`, body(10), { expected: 10 })
    const ids = store.list().map((a) => a.id)
    expect(ids).toContain('dl')
    expect(ids.filter((i) => i !== 'dl')).toHaveLength(30)
    expect(ids).not.toContain('p0')
    expect(ids).toContain('p32')
    await new Promise((r) => setTimeout(r, 20))
    expect((await readdir(join(dir, 'audio'))).length).toBe(31)
  })

  it('touch makes a track the most recent one; clearAuto spares pinned', async () => {
    store.configure({ mode: 'tracks', tracks: 30, gb: 1 })
    for (let i = 0; i < 30; i++) await store.capture(`p${i}`, body(10), { expected: 10 })
    store.touch('p0')
    await store.capture('new', body(10), { expected: 10 })
    expect(store.has('p0')).toBe(true)
    expect(store.has('p1')).toBe(false)
    await store.capture('dl', body(10), { expected: 10, pinned: true })
    const removed = await store.clearAuto()
    expect(removed).toContain('new')
    expect(store.list().map((a) => a.id)).toEqual(['dl'])
  })

  it('pins an already cached track instead of downloading it again', async () => {
    await store.capture('t', body(10), { expected: 10 })
    store.setPinned('t', true)
    expect(store.list()[0]!.pinned).toBe(true)
    store.configure({ mode: 'tracks', tracks: 30, gb: 1 })
    expect(store.has('t')).toBe(true)
  })

  it('serves whole files and ranges', async () => {
    await store.capture('t', body(100), { expected: 100, mime: 'audio/mpeg' })
    const whole = await store.serve('t', null)
    expect(whole).toMatchObject({ status: 200 })
    expect(whole!.headers['Content-Length']).toBe('100')
    expect(whole!.headers['Accept-Ranges']).toBe('bytes')
    const part = await store.serve('t', 'bytes=10-19')
    expect(part).toMatchObject({ status: 206 })
    expect(part!.headers['Content-Range']).toBe('bytes 10-19/100')
    const buf = Buffer.from(await new Response(part!.body).arrayBuffer())
    expect(buf.length).toBe(10)
    expect(buf[0]).toBe(10)
    expect((await store.serve('t', 'bytes=500-'))!.status).toBe(416)
    expect(await store.serve('nope', null)).toBeNull()
  })
})

describe('helpers', () => {
  it('parses ranges', () => {
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=5-500', 100)).toEqual({ start: 5, end: 99 })
    expect(parseRange('bytes=100-', 100)).toBeNull()
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull()
    expect(parseRange(null, 100)).toBeNull()
  })
  it('hashes ids to safe file names', () => {
    expect(fileNameFor('../../etc/passwd')).toMatch(/^[0-9a-f]{40}$/)
  })
  it('only tees full-from-the-start responses of our signed stream urls', () => {
    expect(isTeeableRange(null)).toBe(true)
    expect(isTeeableRange('bytes=0-')).toBe(true)
    expect(isTeeableRange('bytes=1000-')).toBe(false)
    expect(isSignedStreamUrl('https://srv/v1/media/stream/abc?sig=1&exp=2')).not.toBeNull()
    expect(isSignedStreamUrl('https://srv/other')).toBeNull()
    expect(isSignedStreamUrl('file:///etc/passwd')).toBeNull()
    expect(isSignedStreamUrl('https://u:p@srv/v1/media/stream/a')).toBeNull()
    const h = (m: Record<string, string>) => ({ get: (k: string) => m[k] ?? null })
    expect(fullLength(200, h({ 'content-length': '123' }))).toBe(123)
    expect(fullLength(206, h({ 'content-range': 'bytes 0-99/500' }))).toBe(500)
    expect(fullLength(206, h({ 'content-range': 'bytes 10-99/500' }))).toBeNull()
  })
})
