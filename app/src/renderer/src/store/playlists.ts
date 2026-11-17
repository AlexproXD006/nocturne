import { create } from 'zustand'
import type { ApiClient } from '../api/client'
import type { Page, Playlist, PlaylistDetail, Track } from '../api/types'
import { resources, type ResourceCache } from '../lib/resource'

/**
 * Playlist editing helpers shared by the Library, the Playlist page and the "Add to playlist" picker.
 *
 * Resource keys involved (see pages/Library.tsx, pages/Playlist.tsx, components/Shell.tsx, pages/Home.tsx):
 *   - `library:playlists`           Library → Playlists grid (paged)
 *   - `library:playlists:sidebar`   desktop sidebar list
 *   - `library:playlists:editable`  the picker's list (below)
 *   - `playlist:<id>`               a playlist page
 *   - `home`                        home shelves ("Made for you" etc. can list playlists)
 */
export const LIBRARY_PLAYLISTS_KEY = 'library:playlists'
export const EDITABLE_PLAYLISTS_KEY = 'library:playlists:editable'
export const playlistKey = (id: string): string => `playlist:${id}`

export type PlaylistApi = Pick<
  ApiClient,
  'libraryPlaylists' | 'createPlaylist' | 'updatePlaylist' | 'deletePlaylist' | 'addToPlaylist' | 'removeFromPlaylist' | 'reorderPlaylist'
>

const PAGE = 50
const MAX_PAGES = 40

/** Every playlist in the user's library that they may edit (walks all pages). */
export async function fetchEditablePlaylists(api: Pick<PlaylistApi, 'libraryPlaylists'>, signal?: AbortSignal): Promise<Playlist[]> {
  const all: Playlist[] = []
  for (let i = 0; i < MAX_PAGES; i++) {
    const page: Page<Playlist> = await api.libraryPlaylists(i * PAGE, PAGE, signal)
    all.push(...page.items)
    if (page.items.length < PAGE || all.length >= page.total) break
  }
  return all.filter((p) => p.editable === true)
}

/**
 * Marks every cached view of the user's playlists stale (mounted views refetch).
 * Pass the id of a playlist whose page should reload too.
 */
export function invalidatePlaylists(id?: string, cache: ResourceCache = resources): void {
  cache.invalidate(LIBRARY_PLAYLISTS_KEY)
  cache.invalidate('home')
  if (id) cache.invalidate(playlistKey(id))
}

export interface AddOutcome {
  added: number
  skipped: number
  /** Ready-made toast text. */
  message: string
}

export function describeAdd(name: string, requested: number, added: number, skipped: number): string {
  if (requested <= 1) return added > 0 ? `Added to ${name}` : `Already in ${name}`
  if (added === 0) return `All ${requested} songs are already in ${name}`
  if (skipped > 0) return `Added ${added} ${added === 1 ? 'song' : 'songs'} to ${name} (${skipped} already there)`
  return `Added ${added} songs to ${name}`
}

/** Appends songs to a playlist and refreshes cached views of it. Duplicates in `tracks` are dropped. */
export async function addTracks(api: Pick<PlaylistApi, 'addToPlaylist'>, playlist: Pick<Playlist, 'id' | 'name'>, tracks: Track[], cache: ResourceCache = resources): Promise<AddOutcome> {
  const ids = [...new Set(tracks.map((t) => t.id))]
  const res = await api.addToPlaylist(playlist.id, ids)
  const added = Number.isFinite(res?.added) ? res.added : ids.length
  const skipped = Array.isArray(res?.skipped) ? res.skipped.length : 0
  invalidatePlaylists(playlist.id, cache)
  return { added, skipped, message: describeAdd(res?.playlist?.name || playlist.name, ids.length, added, skipped) }
}

/** Creates a playlist (optionally with songs), seeds its page cache and refreshes the lists. */
export async function createPlaylist(
  api: Pick<PlaylistApi, 'createPlaylist'>,
  input: { name: string; description?: string; tracks?: Track[] },
  cache: ResourceCache = resources
): Promise<PlaylistDetail> {
  const name = input.name.trim()
  const description = input.description?.trim()
  const trackIds = input.tracks?.length ? [...new Set(input.tracks.map((t) => t.id))] : undefined
  const created = await api.createPlaylist({ name, ...(description ? { description } : {}), ...(trackIds ? { trackIds } : {}) })
  if (created && typeof created.id === 'string') {
    cache.set(playlistKey(created.id), { ...created, tracks: Array.isArray(created.tracks) ? created.tracks : [] })
  }
  invalidatePlaylists(undefined, cache)
  return created
}

/** Moves one element; returns a new array. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list]
  if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) return next
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item as T)
  return next
}

// ---- Picker / dialog state ---------------------------------------------------

export interface PickerRequest {
  tracks: Track[]
  /** What is being added, for the dialog subtitle (e.g. a song or album title). */
  label: string
}

interface PlaylistUiState {
  picker: PickerRequest | null
  openPicker(tracks: Track[], label?: string): void
  closePicker(): void
}

/** Global "Add to playlist" picker: any view can open it, App renders it once. */
export const usePlaylistUi = create<PlaylistUiState>((set) => ({
  picker: null,
  openPicker(tracks, label) {
    if (tracks.length === 0) return
    set({ picker: { tracks, label: label ?? (tracks.length === 1 ? tracks[0]!.title : `${tracks.length} songs`) } })
  },
  closePicker() {
    set({ picker: null })
  }
}))
