import type { ServerLyrics, Track } from '../../api/types'
import { idbKv, memoryKv, type Kv } from './kv'
import type { MetaStore } from './types'

export interface MetaTables {
  tracks: Kv<Track>
  lyrics: Kv<ServerLyrics>
  art: Kv<Blob>
}

export function createMetaStore(t: MetaTables): MetaStore {
  return {
    putTrack: (track) => t.tracks.put(track.id, track),
    getTrack: (id) => t.tracks.get(id),
    allTracks: () => t.tracks.all(),
    deleteTrack: async (id) => {
      await Promise.all([t.tracks.delete(id), t.lyrics.delete(id), t.art.delete(id)])
    },
    putLyrics: (id, l) => t.lyrics.put(id, l),
    getLyrics: (id) => t.lyrics.get(id),
    putArt: (id, b) => t.art.put(id, b),
    getArt: (id) => t.art.get(id),
    clearAll: async () => {
      await Promise.all([t.tracks.clear(), t.lyrics.clear(), t.art.clear()])
    }
  }
}

export const idbMetaStore = (): MetaStore => createMetaStore({ tracks: idbKv('tracks'), lyrics: idbKv('lyrics'), art: idbKv('art') })
export const memoryMetaStore = (): MetaStore => createMetaStore({ tracks: memoryKv(), lyrics: memoryKv(), art: memoryKv() })
