import type { Track, ServerLyrics } from '../api/types'
import { parseLrc, parsePlain, type ParsedLyrics } from './lrc'
import type { LrclibClient, LrclibResult } from './lrclib'
import { clampOffset } from './offset'
import { parseTtml } from './ttml'

export type LyricsSource = 'ttml' | 'lrclib' | 'server'

export type Lyrics =
  | { kind: 'synced'; parsed: ParsedLyrics; source: LyricsSource; offsetMs?: number }
  | { kind: 'plain'; parsed: ParsedLyrics; source: LyricsSource; offsetMs?: number }
  | { kind: 'instrumental'; source: LyricsSource; offsetMs?: number }
  | { kind: 'none' }

export interface LyricsDeps {
  lrclib: Pick<LrclibClient, 'find'>
  /** Optional server source, used when the server advertises the lyrics capability. */
  server?: (trackId: string, signal?: AbortSignal) => Promise<ServerLyrics>
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown }

function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  )
}

/** An AbortController that also aborts when `parent` does. */
function child(parent: AbortSignal | undefined): AbortController {
  const ctrl = new AbortController()
  if (parent) {
    if (parent.aborted) ctrl.abort()
    else parent.addEventListener('abort', () => ctrl.abort(), { once: true })
  }
  return ctrl
}

/**
 * Resolution order:
 *  1. TTML stored on the server (word- or line-synced, admin-curated), then admin-stored LRC / plain text
 *  2. LRCLIB synced (line)
 *  3. LRC stored on the server
 *  4. plain text: LRCLIB first, else the server's (a stored untimed TTML counts as server plain)
 *  5. instrumental / none
 * The server and LRCLIB are queried in parallel; a failure of either never blocks the other.
 * Aborts are propagated.
 */
export async function resolveLyrics(track: Track, deps: LyricsDeps, signal?: AbortSignal): Promise<Lyrics> {
  const seen: { offsetMs?: number } = {}
  const lyrics = await resolveSources(track, deps, signal, seen)
  // The server's per-track timing offset rides along with whichever source won.
  return seen.offsetMs && lyrics.kind !== 'none' ? { ...lyrics, offsetMs: seen.offsetMs } : lyrics
}

async function resolveSources(track: Track, deps: LyricsDeps, signal: AbortSignal | undefined, seen: { offsetMs?: number }): Promise<Lyrics> {
  const artist = track.artists[0]?.name ?? ''
  const lrcCtrl = child(signal)
  const lrclibP = settle(
    deps.lrclib.find({ title: track.title, artist, album: track.album?.title, duration: track.duration || undefined }, lrcCtrl.signal)
  )
  const serverP = deps.server ? settle(deps.server(track.id, signal)) : null

  const server = serverP ? await serverP : null
  if (server && !server.ok && signal?.aborted) {
    lrcCtrl.abort()
    throw server.error
  }
  const sv: ServerLyrics | null = server && server.ok ? server.value : null
  if (sv && typeof sv.offsetMs === 'number') seen.offsetMs = clampOffset(sv.offsetMs)

  // 1. Stored TTML wins outright, so LRCLIB is no longer needed.
  let ttmlPlain: Lyrics = { kind: 'none' }
  if (sv?.ttml) {
    const parsed = parseTtml(sv.ttml)
    if (parsed.synced && parsed.lines.length) {
      lrcCtrl.abort()
      return { kind: 'synced', parsed, source: 'ttml' }
    }
    if (parsed.lines.length) ttmlPlain = { kind: 'plain', parsed, source: 'ttml' }
  }

  // 1b. Admin-stored LRC / plain text also beats LRCLIB.
  if (sv?.source === 'admin') {
    const synced = parseLrc(sv.synced)
    if (synced.synced && synced.lines.length) {
      lrcCtrl.abort()
      return { kind: 'synced', parsed: synced, source: 'server' }
    }
    const plain = parsePlain(sv.plain)
    if (plain.lines.length) {
      lrcCtrl.abort()
      return { kind: 'plain', parsed: plain, source: 'server' }
    }
  }

  const lr = await lrclibP
  if (!lr.ok && signal?.aborted) throw lr.error
  const r: LrclibResult | null = lr.ok ? lr.value : null

  let lrclibPlain: Lyrics = { kind: 'none' }
  if (r?.kind === 'synced') {
    const parsed = parseLrc(r.text)
    if (parsed.lines.length) return { kind: 'synced', parsed, source: 'lrclib' }
    if (r.plain) lrclibPlain = { kind: 'plain', parsed: parsePlain(r.plain), source: 'lrclib' }
  } else if (r?.kind === 'plain') {
    lrclibPlain = { kind: 'plain', parsed: parsePlain(r.text), source: 'lrclib' }
  } else if (r?.kind === 'instrumental') {
    return { kind: 'instrumental', source: 'lrclib' }
  }

  let serverPlain: Lyrics = { kind: 'none' }
  if (sv) {
    const synced = parseLrc(sv.synced)
    if (synced.synced && synced.lines.length) return { kind: 'synced', parsed: synced, source: 'server' }
    const plain = parsePlain(sv.plain)
    if (plain.lines.length) serverPlain = { kind: 'plain', parsed: plain, source: 'server' }
  }

  if (ttmlPlain.kind !== 'none') return ttmlPlain
  if (lrclibPlain.kind !== 'none') return lrclibPlain
  return serverPlain
}
