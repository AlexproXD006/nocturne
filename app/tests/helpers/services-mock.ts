// Extra '@/services' exports for tests that mock the module wholesale: a Connect store that is
// never controlling a remote, and the real playback router on top of the test's player.
import { create } from 'zustand'
import { createPlayback } from '@/player/playback'

export function connectMocks(usePlayer: { getState: () => unknown }) {
  const useConnect = create(() => ({
    active: false,
    selfId: null,
    selfName: 'Test device',
    sessions: [],
    controlling: null,
    remote: null,
    panelOpen: false,
    openPanel: () => undefined,
    closePanel: () => undefined,
    remotePosition: () => 0
  }))
  const playback = createPlayback({ player: usePlayer as never, connect: useConnect as never })
  return { useConnect, playback, autoDeviceName: () => 'Test device', ...offlineMocks() }
}

/** Offline exports of '@/services': always online, nothing stored. */
export function offlineMocks() {
  const useConnectivity = Object.assign(
    create(() => ({ online: true, browser: true, native: null, unmetered: null, apiReachable: true, probe: async () => undefined })),
    {}
  )
  const state = {
    available: {} as Record<string, string>,
    transfers: {} as Record<string, unknown>,
    collections: {} as Record<string, unknown>,
    singles: [] as string[],
    tracks: {} as Record<string, unknown>,
    settings: { cache: { mode: 'tracks', tracks: 30, gb: 1 }, prefetchWifiOnly: true, downloadsWifiOnly: true, quality: 'original', limitGb: 0 },
    usage: { autoBytes: 0, pinnedBytes: 0, autoTracks: 0, quota: 0 },
    paused: false,
    isAvailable: () => false,
    artFor: async () => null,
    downloadTracks: async () => undefined,
    removeTrack: async () => undefined,
    removeTrackIds: async () => undefined
  }
  const useOffline = create(() => state)
  return {
    useConnectivity,
    useOffline,
    sendLike: async () => undefined,
    lyricsWithOffline: async () => ({ synced: null, plain: null }),
    collectionWithOffline: async (_k: string, _id: string, f: () => Promise<unknown>) => f()
  }
}
