import { describe, expect, it, vi } from 'vitest'
import { addTracks, createPlaylist } from '@/store/playlists'
import { ResourceCache } from '@/lib/resource'

const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}` }))

describe('bulk playlist writes are chunked', () => {
  it('addTracks sends 500 per request and sums the outcome', async () => {
    const addToPlaylist = vi.fn(async (_id: string, part: string[]) => ({ added: part.length - 1, skipped: [part[0]!], playlist: { id: 'p', name: 'Fav' } }))
    const out = await addTracks({ addToPlaylist } as never, { id: 'p', name: 'Fav' }, ids(1200), new ResourceCache())
    expect(addToPlaylist.mock.calls.map((c) => c[1].length)).toEqual([500, 500, 200])
    expect(out.added).toBe(1197)
    expect(out.skipped).toBe(3)
  })
  it('createPlaylist creates with the first chunk and appends the rest', async () => {
    const createApi = vi.fn(async (input: { trackIds?: string[] }) => ({ id: 'new', name: 'N', tracks: [], trackCount: input.trackIds?.length ?? 0 }))
    const addToPlaylist = vi.fn(async () => ({ added: 500, skipped: [], playlist: { id: 'new', name: 'N' } }))
    await createPlaylist({ createPlaylist: createApi, addToPlaylist } as never, { name: 'N', tracks: ids(1100) as never }, new ResourceCache())
    expect(createApi.mock.calls[0]![0].trackIds).toHaveLength(500)
    expect(addToPlaylist).toHaveBeenCalledTimes(2)
  })
})
