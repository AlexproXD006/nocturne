import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ResourceCache } from '@/lib/resource'
import type { Playlist } from '@/api/types'
import {
  EDITABLE_PLAYLISTS_KEY,
  addTracks,
  createPlaylist,
  describeAdd,
  fetchEditablePlaylists,
  invalidatePlaylists,
  moveItem,
  playlistKey,
  usePlaylistUi
} from '@/store/playlists'
import { track, tracks } from '../helpers/fixtures'

const pl = (id: string, editable?: boolean): Playlist => ({ id, name: `P ${id}`, artwork: [], editable })

describe('fetchEditablePlaylists', () => {
  it('walks every page and keeps only editable playlists', async () => {
    const all = Array.from({ length: 120 }, (_, i) => pl(`p${i}`, i % 3 === 0 ? true : i % 3 === 1 ? false : undefined))
    const libraryPlaylists = vi.fn(async (offset: number, limit: number) => ({ items: all.slice(offset, offset + limit), offset, limit, total: all.length }))
    const out = await fetchEditablePlaylists({ libraryPlaylists } as never)
    expect(libraryPlaylists).toHaveBeenCalledTimes(3)
    expect(out.map((p) => p.id)).toEqual(all.filter((p) => p.editable === true).map((p) => p.id))
  })
})

describe('invalidation', () => {
  it('marks the library lists, home and the playlist page stale', () => {
    const cache = new ResourceCache()
    for (const k of ['library:playlists:sidebar', EDITABLE_PLAYLISTS_KEY, 'home', 'playlist:a', 'playlist:b', 'album:x']) cache.set(k, 1)
    invalidatePlaylists('a', cache)
    expect(cache.isFresh('library:playlists:sidebar')).toBe(false)
    expect(cache.isFresh(EDITABLE_PLAYLISTS_KEY)).toBe(false)
    expect(cache.isFresh('home')).toBe(false)
    expect(cache.isFresh('playlist:a')).toBe(false)
    expect(cache.isFresh('playlist:b')).toBe(true)
    expect(cache.isFresh('album:x')).toBe(true)
  })
})

describe('describeAdd', () => {
  it('words single and bulk outcomes', () => {
    expect(describeAdd('Mix', 1, 1, 0)).toBe('Added to Mix')
    expect(describeAdd('Mix', 1, 0, 1)).toBe('Already in Mix')
    expect(describeAdd('Mix', 3, 3, 0)).toBe('Added 3 songs to Mix')
    expect(describeAdd('Mix', 3, 1, 2)).toBe('Added 1 song to Mix (2 already there)')
    expect(describeAdd('Mix', 3, 0, 3)).toBe('All 3 songs are already in Mix')
  })
})

describe('addTracks / createPlaylist', () => {
  it('sends de-duplicated ids, reports skipped songs and invalidates', async () => {
    const cache = new ResourceCache()
    cache.set('playlist:p1', 1)
    const addToPlaylist = vi.fn().mockResolvedValue({ added: 0, skipped: ['t0'], playlist: pl('p1') })
    const out = await addTracks({ addToPlaylist } as never, { id: 'p1', name: 'P p1' }, [track('t0'), track('t0')], cache)
    expect(addToPlaylist).toHaveBeenCalledWith('p1', ['t0'])
    expect(out.message).toBe('Already in P p1')
    expect(cache.isFresh('playlist:p1')).toBe(false)
  })

  it('creates with trimmed fields and trackIds, and seeds the new page', async () => {
    const cache = new ResourceCache()
    const created = { ...pl('n1', true), tracks: tracks(2) }
    const api = { createPlaylist: vi.fn().mockResolvedValue(created) }
    await createPlaylist(api as never, { name: '  New ', description: '  ', tracks: tracks(2) }, cache)
    expect(api.createPlaylist).toHaveBeenCalledWith({ name: 'New', trackIds: ['t0', 't1'] })
    expect(cache.peek(playlistKey('n1'))).toEqual(created)
  })
})

describe('moveItem', () => {
  it('moves forwards and backwards and ignores out-of-range moves', () => {
    expect(moveItem([1, 2, 3, 4], 0, 2)).toEqual([2, 3, 1, 4])
    expect(moveItem([1, 2, 3, 4], 3, 0)).toEqual([4, 1, 2, 3])
    expect(moveItem([1, 2], 0, 5)).toEqual([1, 2])
  })
})

describe('usePlaylistUi', () => {
  beforeEach(() => usePlaylistUi.setState({ picker: null }))
  it('opens the picker with a label and ignores empty requests', () => {
    usePlaylistUi.getState().openPicker([])
    expect(usePlaylistUi.getState().picker).toBeNull()
    usePlaylistUi.getState().openPicker([track('a')])
    expect(usePlaylistUi.getState().picker?.label).toBe('Title a')
    usePlaylistUi.getState().openPicker(tracks(3), 'Album X')
    expect(usePlaylistUi.getState().picker?.label).toBe('Album X')
    usePlaylistUi.getState().closePicker()
    expect(usePlaylistUi.getState().picker).toBeNull()
  })
})
