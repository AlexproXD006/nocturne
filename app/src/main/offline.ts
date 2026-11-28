import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { DEFAULT_CACHE, planEviction, sanitizeCache, type CacheSettings } from '../shared/offlinePolicy'
import type { OfflineAudio } from '../shared/ipc'

/**
 * Desktop offline audio store (main process): files under <userData>/offline/audio, an index with
 * { bytes, pinned, lastPlayed }, the shared N-recent policy, and a streaming "tee" so a track that is
 * playing is cached while it streams (no second download). Served to the renderer by the
 * `nocturne-offline://` protocol (Range supported) — see index.ts.
 */

interface IndexEntry {
  bytes: number
  pinned: boolean
  lastPlayed: number
  mime: string
}

export const fileNameFor = (id: string): string => createHash('sha256').update(id).digest('hex').slice(0, 40)

/** Inclusive byte range of a single `bytes=a-b` header, or null when malformed / unsatisfiable. */
export function parseRange(header: string | null | undefined, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header ?? '').trim())
  if (!m || size <= 0) return null
  const [, a = '', b = ''] = m
  if (a === '' && b === '') return null
  if (a === '') {
    const n = Number(b)
    return n === 0 ? null : { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(a)
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1)
  return start >= size || end < start ? null : { start, end }
}

export class OfflineStore {
  private index = new Map<string, IndexEntry>()
  private settings: CacheSettings = DEFAULT_CACHE
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private inflight = new Map<string, AbortController>()

  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now
  ) {}

  private get audioDir(): string {
    return join(this.dir, 'audio')
  }

  pathOf(id: string): string {
    return join(this.audioDir, fileNameFor(id))
  }

  async init(): Promise<void> {
    await mkdir(this.audioDir, { recursive: true })
    try {
      const raw = JSON.parse(await readFile(join(this.dir, 'index.json'), 'utf8')) as Record<string, Partial<IndexEntry>>
      for (const [id, e] of Object.entries(raw)) {
        if (!e || typeof e.bytes !== 'number') continue
        this.index.set(id, { bytes: e.bytes, pinned: e.pinned === true, lastPlayed: Number(e.lastPlayed) || 0, mime: typeof e.mime === 'string' ? e.mime : 'audio/mpeg' })
      }
    } catch {
      /* first run or unreadable index: start empty */
    }
    // Drop entries whose file vanished or has a different size (an interrupted write).
    for (const [id, e] of [...this.index]) {
      try {
        if ((await stat(this.pathOf(id))).size !== e.bytes) throw new Error('size')
      } catch {
        this.index.delete(id)
        await rm(this.pathOf(id), { force: true })
      }
    }
  }

  configure(raw: unknown): string[] {
    this.settings = sanitizeCache(raw)
    return this.enforce()
  }

  list(): OfflineAudio[] {
    return [...this.index].map(([id, e]) => ({ id, bytes: e.bytes, pinned: e.pinned, lastPlayed: e.lastPlayed }))
  }

  has(id: string): boolean {
    return this.index.has(id)
  }

  mimeOf(id: string): string {
    return this.index.get(id)?.mime ?? 'audio/mpeg'
  }

  touch(id: string): void {
    const e = this.index.get(id)
    if (e) {
      e.lastPlayed = this.now()
      this.scheduleSave()
    }
  }

  setPinned(id: string, pinned: boolean): string[] {
    const e = this.index.get(id)
    if (e) e.pinned = pinned
    this.scheduleSave()
    return pinned ? [] : this.enforce()
  }

  async remove(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      this.inflight.get(id)?.abort()
      this.index.delete(id)
      await rm(this.pathOf(id), { force: true })
    }
    this.scheduleSave()
  }

  async clearAuto(): Promise<string[]> {
    const ids = [...this.index].filter(([, e]) => !e.pinned).map(([id]) => id)
    await this.remove(ids)
    return ids
  }

  /** Applies the N-recent policy; returns the evicted ids. Files are removed in the background. */
  enforce(protect: ReadonlySet<string> = new Set([...this.inflight.keys()])): string[] {
    const victims = planEviction(this.list().map((e) => ({ id: e.id, bytes: e.bytes, lastPlayed: e.lastPlayed, pinned: e.pinned })), this.settings, protect)
    for (const id of victims) {
      this.index.delete(id)
      void rm(this.pathOf(id), { force: true })
    }
    if (victims.length) this.scheduleSave()
    return victims
  }

  /**
   * Writes a track's bytes to disk while they are being read. Resolves with the size once the file is
   * complete (and indexed); rejects, leaving nothing behind, when the stream fails, is aborted or is shorter
   * than `expected`. The same call serves both an explicit download and the tee of a playing stream.
   */
  async capture(
    id: string,
    body: ReadableStream<Uint8Array>,
    opts: { expected?: number | null; pinned?: boolean; mime?: string; onProgress?: (bytes: number, total: number) => void } = {}
  ): Promise<number> {
    if (this.inflight.has(id)) {
      await body.cancel().catch(() => undefined)
      throw new Error('already being cached')
    }
    const ctl = new AbortController()
    this.inflight.set(id, ctl)
    const tmp = `${this.pathOf(id)}.part`
    let bytes = 0
    const total = opts.expected && opts.expected > 0 ? opts.expected : 0
    try {
      await mkdir(this.audioDir, { recursive: true })
      const count = new Transform({
        transform: (chunk: Buffer, _enc, cb) => {
          bytes += chunk.length
          opts.onProgress?.(bytes, total)
          cb(null, chunk)
        }
      })
      await pipeline(Readable.fromWeb(body as never), count, createWriteStream(tmp), { signal: ctl.signal })
      if (total > 0 && bytes !== total) throw new Error('incomplete')
      if (bytes === 0) throw new Error('empty')
      await rename(tmp, this.pathOf(id))
      const prev = this.index.get(id)
      this.index.set(id, { bytes, pinned: opts.pinned === true || prev?.pinned === true, lastPlayed: this.now(), mime: opts.mime ?? prev?.mime ?? 'audio/mpeg' })
      this.inflight.delete(id)
      this.scheduleSave()
      this.enforce(new Set([id]))
      return bytes
    } catch (err) {
      await rm(tmp, { force: true })
      throw err
    } finally {
      this.inflight.delete(id)
    }
  }

  abort(id: string): void {
    this.inflight.get(id)?.abort()
  }

  /** A response for a stored track (200, or 206 for a Range request). Null when it is not stored. */
  async serve(id: string, rangeHeader: string | null): Promise<{ status: number; headers: Record<string, string>; body: ReadableStream<Uint8Array> | null } | null> {
    const e = this.index.get(id)
    if (!e) return null
    const size = e.bytes
    const base: Record<string, string> = { 'Content-Type': e.mime, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
    if (rangeHeader) {
      const r = parseRange(rangeHeader, size)
      if (!r) return { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` }, body: null }
      return {
        status: 206,
        headers: { ...base, 'Content-Range': `bytes ${r.start}-${r.end}/${size}`, 'Content-Length': String(r.end - r.start + 1) },
        body: Readable.toWeb(createReadStream(this.pathOf(id), { start: r.start, end: r.end })) as unknown as ReadableStream<Uint8Array>
      }
    }
    return {
      status: 200,
      headers: { ...base, 'Content-Length': String(size) },
      body: Readable.toWeb(createReadStream(this.pathOf(id))) as unknown as ReadableStream<Uint8Array>
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.save()
    }, 500)
  }

  async save(): Promise<void> {
    const out: Record<string, IndexEntry> = {}
    for (const [id, e] of this.index) out[id] = e
    const tmp = join(this.dir, 'index.json.tmp')
    await mkdir(this.dir, { recursive: true })
    await writeFile(tmp, JSON.stringify(out))
    await rename(tmp, join(this.dir, 'index.json'))
  }
}

/** Only our own signed stream URLs may be tee'd (no open proxy for arbitrary URLs). */
export function isSignedStreamUrl(raw: string): URL | null {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    if (u.username || u.password) return null
    if (!u.pathname.includes('/v1/media/stream/')) return null
    return u
  } catch {
    return null
  }
}

/** Total length of a full-range response (Content-Length, or the total of `Content-Range: bytes 0-x/total`). */
export function fullLength(status: number, headers: { get(name: string): string | null }): number | null {
  if (status === 200) {
    const n = Number(headers.get('content-length'))
    return Number.isFinite(n) && n > 0 ? n : null
  }
  if (status === 206) {
    const m = /^bytes 0-\d+\/(\d+)$/.exec(headers.get('content-range') ?? '')
    return m ? Number(m[1]) : null
  }
  return null
}

/** Only an open-ended request from byte 0 (what <audio> sends first) can be tee'd into a complete file. */
export function isTeeableRange(range: string | null): boolean {
  return range === null || range === '' || /^bytes=0-$/.test(range.trim())
}
