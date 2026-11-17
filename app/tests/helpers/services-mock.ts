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
  return { useConnect, playback, autoDeviceName: () => 'Test device' }
}
