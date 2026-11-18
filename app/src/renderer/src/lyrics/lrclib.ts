import { LruCache } from '../lib/lru'
import { t } from '../i18n'

export interface LrclibRecord {
  id: number
  trackName: string
  artistName: string
  albumName: string | null
  duration: number
  instrumental: boolean
  plainLyrics: string | null
  syncedLyrics: string | null
}

export interface LyricsQuery {
  title: string
  artist: string
  album?: string
  /** Seconds. */
  duration?: number
}

export type LrclibResult =
  | { kind: 'synced'; text: string; plain: string | null; source: 'lrclib' }
  | { kind: 'plain'; text: string; source: 'lrclib' }
  | { kind: 'instrumental'; source: 'lrclib' }
  | { kind: 'none' }

const BASE = 'https://lrclib.net'
// LRCLIB asks clients to identify themselves with a name, version and project URL.
// Builds can point it at their own fork/site with VITE_PROJECT_URL (build-time).
const PROJECT_URL = import.meta.env.VITE_PROJECT_URL || 'https://github.com/AlexproXD006/nocturne'
const CLIENT_ID = `Nocturne v${typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '1.0.0'} (${PROJECT_URL})`

export interface LrclibOptions {
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  cacheSize?: number
}

/** Removes "(feat. X)", "- Remastered 2011" and similar noise that breaks matching. */
export function cleanTitle(title: string): string {
  return title
    .replace(/\s*[([](?:feat\.?|ft\.?|with)\s[^)\]]*[)\]]/gi, '')
    .replace(/\s*-\s*(?:\d{4}\s*)?(?:remaster(?:ed)?|live|radio edit|single version|mono|stereo)(?:\s*\d{4})?.*$/i, '')
    .replace(/\s*[([](?:\d{4}\s*)?remaster(?:ed)?(?:\s*\d{4})?[)\]]/gi, '')
    .trim()
}

function normalize(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

/** Scores a search hit: lower is better. Returns Infinity for unusable hits. */
export function scoreRecord(rec: LrclibRecord, q: LyricsQuery): number {
  if (!rec.syncedLyrics && !rec.plainLyrics && !rec.instrumental) return Infinity
  let score = 0
  if (q.duration !== undefined) {
    const diff = Math.abs(rec.duration - q.duration)
    if (diff > 5) return Infinity
    score += diff * 10
  }
  if (normalize(rec.trackName) !== normalize(cleanTitle(q.title))) score += 30
  const artist = normalize(q.artist)
  if (!normalize(rec.artistName).includes(artist) && !artist.includes(normalize(rec.artistName))) score += 50
  if (!rec.syncedLyrics) score += 20
  return score
}

function toResult(rec: LrclibRecord): LrclibResult {
  if (rec.instrumental) return { kind: 'instrumental', source: 'lrclib' }
  if (rec.syncedLyrics) return { kind: 'synced', text: rec.syncedLyrics, plain: rec.plainLyrics, source: 'lrclib' }
  if (rec.plainLyrics) return { kind: 'plain', text: rec.plainLyrics, source: 'lrclib' }
  return { kind: 'none' }
}

export class LrclibClient {
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly random: () => number
  private readonly cache: LruCache<string, LrclibResult>
  /** Requests are serialized, as LRCLIB asks clients to do. */
  private chain: Promise<unknown> = Promise.resolve()
  private blockedUntil = 0

  constructor(opts: LrclibOptions = {}) {
    this.fetchImpl = opts.fetch ?? ((...a) => fetch(...a))
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.random = opts.random ?? Math.random
    this.cache = new LruCache(opts.cacheSize ?? 300)
  }

  static key(q: LyricsQuery): string {
    return [normalize(q.artist), normalize(cleanTitle(q.title)), q.duration === undefined ? '' : Math.round(q.duration)].join('|')
  }

  async find(q: LyricsQuery, signal?: AbortSignal): Promise<LrclibResult> {
    const key = LrclibClient.key(q)
    const hit = this.cache.get(key)
    if (hit) return hit
    const run = async (): Promise<LrclibResult> => {
      // A queued duplicate may have been answered while it waited its turn.
      const cached = this.cache.get(key)
      if (cached) return cached
      return this.lookup(q, signal)
    }
    const p = this.chain.then(run, run)
    this.chain = p.catch(() => undefined)
    const result = await p
    this.cache.set(key, result)
    return result
  }

  private async lookup(q: LyricsQuery, signal?: AbortSignal): Promise<LrclibResult> {
    const title = cleanTitle(q.title)
    const params = new URLSearchParams({ track_name: title, artist_name: q.artist })
    if (q.album) params.set('album_name', q.album)
    if (q.duration !== undefined && q.duration >= 1 && q.duration <= 3600) params.set('duration', String(Math.round(q.duration)))

    const exact = await this.get<LrclibRecord>(`/api/get?${params}`, signal)
    if (exact && (exact.syncedLyrics || exact.plainLyrics || exact.instrumental)) return toResult(exact)

    const search = new URLSearchParams({ track_name: title, artist_name: q.artist })
    const hits = await this.get<LrclibRecord[]>(`/api/search?${search}`, signal)
    if (!Array.isArray(hits) || hits.length === 0) return { kind: 'none' }
    const best = hits
      .map((rec) => ({ rec, score: scoreRecord(rec, q) }))
      .filter((h) => Number.isFinite(h.score))
      .sort((a, b) => a.score - b.score)[0]
    return best ? toResult(best.rec) : { kind: 'none' }
  }

  /** GET with 404→null and a single Retry-After–honoring retry on 429/503. */
  private async get<T>(path: string, signal?: AbortSignal, attempt = 0): Promise<T | null> {
    const wait = this.blockedUntil - Date.now()
    if (wait > 0) await this.sleep(wait)
    const res = await this.fetchImpl(`${BASE}${path}`, {
      headers: { Accept: 'application/json', 'Lrclib-Client': CLIENT_ID },
      credentials: 'omit',
      signal
    })
    if (res.status === 404) return null
    if ((res.status === 429 || res.status === 503) && attempt === 0) {
      const seconds = Number(res.headers.get('Retry-After') ?? '1')
      const base = (Number.isFinite(seconds) && seconds > 0 ? seconds : 1) * 1000
      const delay = base + base * 0.3 * this.random()
      this.blockedUntil = Date.now() + delay
      await this.sleep(delay)
      return this.get<T>(path, signal, 1)
    }
    if (!res.ok) throw new Error(t('lyrics.lookupFailed', { status: String(res.status) }))
    const type = res.headers.get('Content-Type') ?? ''
    if (!type.includes('json')) throw new Error(t('lyrics.badResponse'))
    return (await res.json()) as T
  }
}
