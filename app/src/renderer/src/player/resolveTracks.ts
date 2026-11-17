import type { AlbumDetail, ArtistDetail, ConnectContext, Page, PlaylistDetail, Track } from '../api/types'

/** API calls used to turn track ids back into Track objects (Connect receivers). */
export interface TrackSource {
  track(id: string): Promise<Track>
  album(id: string): Promise<AlbumDetail>
  playlist(id: string): Promise<PlaylistDetail>
  artist(id: string): Promise<ArtistDetail>
  libraryTracks(offset: number, limit: number): Promise<Page<Track>>
  librarySongs(offset: number, limit: number): Promise<Page<Track>>
}

export interface ResolveOptions {
  context?: ConnectContext | null
  /** Tracks already in memory (e.g. the current queue), checked first. */
  known?: readonly Track[]
  /** Parallel single-track lookups. */
  concurrency?: number
  /** Most single-track lookups (anything beyond is dropped). */
  maxLookups?: number
  /** Most library pages (200 tracks each) scanned for a library context. */
  maxPages?: number
}

const PAGE = 200

/**
 * Resolves `ids` to tracks, aligned with the input (null where a track could not be found).
 * Cheapest sources first: known tracks, then the context's collection (one request for an
 * album / playlist / artist, paged for the library), then individual lookups.
 */
export async function resolveTracks(ids: readonly string[], api: TrackSource, opts: ResolveOptions = {}): Promise<(Track | null)[]> {
  const found = new Map<string, Track>()
  for (const t of opts.known ?? []) found.set(t.id, t)
  const missing = (): string[] => [...new Set(ids)].filter((id) => !found.has(id))
  const add = (list: readonly Track[]): void => {
    for (const t of list) if (!found.has(t.id)) found.set(t.id, t)
  }

  const ctx = opts.context
  if (missing().length > 0 && ctx?.id) {
    try {
      if (ctx.type === 'album') add((await api.album(ctx.id)).tracks)
      else if (ctx.type === 'playlist') add((await api.playlist(ctx.id)).tracks)
      else if (ctx.type === 'artist') add((await api.artist(ctx.id)).topTracks)
      else if (ctx.type === 'library' && (ctx.id === 'liked' || ctx.id === 'all')) {
        const fetchPage = ctx.id === 'liked' ? api.libraryTracks.bind(api) : api.librarySongs.bind(api)
        const maxPages = opts.maxPages ?? 50
        for (let i = 0, offset = 0; i < maxPages && missing().length > 0; i++, offset += PAGE) {
          const page = await fetchPage(offset, PAGE)
          add(page.items)
          if (page.items.length === 0 || offset + page.items.length >= page.total) break
        }
      }
    } catch {
      /* fall back to single lookups */
    }
  }

  const rest = missing().slice(0, opts.maxLookups ?? 300)
  const concurrency = Math.max(1, opts.concurrency ?? 6)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < rest.length) {
      const id = rest[next++]!
      try {
        found.set(id, await api.track(id))
      } catch {
        /* unknown or deleted track: skipped */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rest.length) }, worker))
  return ids.map((id) => found.get(id) ?? null)
}

/** Drops unresolved entries and maps `startIndex` onto the compacted list. */
export function compactResolved(resolved: readonly (Track | null)[], startIndex: number): { tracks: Track[]; startIndex: number } {
  const tracks: Track[] = []
  let start = -1
  resolved.forEach((t, i) => {
    if (!t) return
    if (i >= startIndex && start < 0) start = tracks.length
    tracks.push(t)
  })
  if (start < 0) start = Math.max(0, tracks.length - 1)
  return { tracks, startIndex: start }
}
