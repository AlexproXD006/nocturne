import { describe, expect, it, vi } from 'vitest'
import { compactResolved, resolveTracks, type TrackSource } from '@/player/resolveTracks'
import { track } from '../helpers/fixtures'

function source(over: Partial<TrackSource> = {}): TrackSource & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    track: vi.fn(async (id: string) => {
      calls.push(`track:${id}`)
      if (id.startsWith('missing')) throw new Error('404')
      return track(id)
    }),
    album: vi.fn(async (id: string) => { calls.push(`album:${id}`); return { id, tracks: [track('a1'), track('a2')] } as never }),
    playlist: vi.fn(async (id: string) => { calls.push(`playlist:${id}`); return { id, tracks: [track('p1')] } as never }),
    artist: vi.fn(async (id: string) => { calls.push(`artist:${id}`); return { id, topTracks: [track('r1')] } as never }),
    libraryTracks: vi.fn(async (offset: number) => {
      calls.push(`liked:${offset}`)
      return { items: offset === 0 ? [track('l1')] : [track('l2')], offset, limit: 200, total: 400 }
    }),
    librarySongs: vi.fn(async () => ({ items: [], offset: 0, limit: 200, total: 0 })),
    ...over
  }
}

describe('resolveTracks', () => {
  it('uses known tracks and the album before single lookups, aligned with the input', async () => {
    const api = source()
    const out = await resolveTracks(['a2', 'k', 'x', 'missing1'], api, { context: { type: 'album', id: 'al' }, known: [track('k')] })
    expect(out.map((t) => t?.id ?? null)).toEqual(['a2', 'k', 'x', null])
    expect(api.calls).toEqual(['album:al', 'track:x', 'track:missing1'])
  })

  it('pages the liked library until every id is found', async () => {
    const api = source()
    const out = await resolveTracks(['l2', 'l1'], api, { context: { type: 'library', id: 'liked' } })
    expect(out.map((t) => t?.id)).toEqual(['l2', 'l1'])
    expect(api.calls).toEqual(['liked:0', 'liked:200'])
  })

  it('falls back to single lookups when the context request fails, and caps them', async () => {
    const api = source({ playlist: vi.fn(async () => { throw new Error('boom') }) })
    const out = await resolveTracks(['a', 'b', 'c'], api, { context: { type: 'playlist', id: 'p' }, maxLookups: 2 })
    expect(out.map((t) => t?.id ?? null)).toEqual(['a', 'b', null])
  })
})

describe('compactResolved', () => {
  it('drops missing tracks and keeps the start track', () => {
    const r = compactResolved([track('a'), null, track('c'), track('d')], 2)
    expect(r.tracks.map((t) => t.id)).toEqual(['a', 'c', 'd'])
    expect(r.startIndex).toBe(1)
  })
  it('moves to the next available track when the start one is missing', () => {
    expect(compactResolved([track('a'), null, track('c')], 1).startIndex).toBe(1)
    expect(compactResolved([track('a'), null], 1).startIndex).toBe(0)
  })
})
