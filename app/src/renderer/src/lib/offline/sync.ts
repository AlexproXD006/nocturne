/** Downloaded collections (playlists, albums, mixes) and their auto-sync. */

export type CollectionKind = 'playlist' | 'album' | 'mix'

export interface DownloadedCollection {
  key: string
  kind: CollectionKind
  id: string
  name: string
  /** Server order. */
  trackIds: string[]
  /** Epoch ms of the last successful sync. */
  syncedAt: number
}

export const collectionKey = (kind: CollectionKind, id: string): string => `${kind}:${id}`

export interface SyncDiff {
  add: string[]
  remove: string[]
}

/**
 * What a collection sync has to do: download the tracks the server list has that we do not, and delete
 * the ones that left the collection - unless another downloaded collection (or an explicitly downloaded
 * single track) still wants them.
 */
export function diffCollection(local: readonly string[], remote: readonly string[], keep: ReadonlySet<string> = new Set()): SyncDiff {
  const have = new Set(local)
  const want = new Set(remote)
  return {
    add: [...new Set(remote)].filter((id) => !have.has(id)),
    remove: [...have].filter((id) => !want.has(id) && !keep.has(id))
  }
}

/** Ids wanted by every collection except `exceptKey` plus the single-track downloads. */
export function idsKeptBy(collections: Readonly<Record<string, DownloadedCollection>>, singles: readonly string[], exceptKey?: string): Set<string> {
  const out = new Set(singles)
  for (const c of Object.values(collections)) if (c.key !== exceptKey) for (const id of c.trackIds) out.add(id)
  return out
}
