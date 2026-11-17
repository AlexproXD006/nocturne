import { describe, expect, it, vi } from 'vitest'
import { createPlayback, windowIds } from '@/player/playback'
import { CONNECT_MAX_TRACK_IDS } from '@/api/types'
import { tracks } from '../helpers/fixtures'

function setup(remote: boolean, remoteState: Record<string, unknown> = {}) {
  const player = {
    playTracks: vi.fn(async () => undefined), addToQueue: vi.fn(), addNext: vi.fn(),
    removeFromQueue: vi.fn(), toggle: vi.fn(), next: vi.fn(), setVolume: vi.fn(),
    queue: { items: [] as { uid: string }[], shuffle: false }, volume: 0.5, position: 7
  }
  player.addToQueue.mockImplementation(() => { player.queue.items.push({ uid: 'u1' }) })
  const connect = {
    controlling: remote ? 'cs_x' : null,
    remote: remote ? { id: 'cs_x', state: { status: 'playing', volume: 0.9, ...remoteState }, at: 0 } : null,
    remoteCommand: vi.fn(async () => undefined), setRemoteVolume: vi.fn(), setRemoteMuted: vi.fn(),
    remotePosition: () => 42
  }
  const pb = createPlayback({ player: { getState: () => player as never }, connect: { getState: () => connect as never } })
  return { pb, player, connect }
}

describe('windowIds', () => {
  it('keeps short lists and clamps start', () => {
    expect(windowIds(['a', 'b', 'c'], 9)).toEqual({ ids: ['a', 'b', 'c'], startIndex: 2 })
  })
  it('windows long lists around the start track', () => {
    const ids = Array.from({ length: CONNECT_MAX_TRACK_IDS + 500 }, (_, i) => String(i))
    const w = windowIds(ids, 3000)
    expect(w.ids).toHaveLength(CONNECT_MAX_TRACK_IDS)
    expect(w.ids[w.startIndex]).toBe('3000')
    expect(windowIds(ids, 0).startIndex).toBe(0)
    expect(windowIds(ids, ids.length - 1).ids.at(-1)).toBe(String(ids.length - 1))
  })
})

describe('playback router', () => {
  it('local: delegates to the player untouched', async () => {
    const { pb, player, connect } = setup(false)
    const t = tracks(3)
    await pb.playTracks(t, 1, null, { shuffle: true })
    expect(player.playTracks).toHaveBeenCalledWith(t, 1, null, { shuffle: true })
    pb.toggle(); pb.setVolume(0.3)
    expect(player.toggle).toHaveBeenCalled()
    expect(player.setVolume).toHaveBeenCalledWith(0.3)
    expect(connect.remoteCommand).not.toHaveBeenCalled()
    expect(pb.isRemote()).toBe(false)
    expect(pb.position()).toBe(7)
  })

  it('local addToQueue returns an undo that removes the added items', () => {
    const { pb, player } = setup(false)
    const undo = pb.addToQueue(tracks(1))
    expect(undo).toBeTypeOf('function')
    undo!()
    expect(player.removeFromQueue).toHaveBeenCalledWith('u1')
  })

  it('remote: playTracks becomes playContext with an optimistic patch', async () => {
    const { pb, player, connect } = setup(true)
    const t = tracks(3)
    await pb.playTracks(t, 2, { type: 'album', id: 'al1', name: 'Alb' }, { shuffle: false })
    expect(player.playTracks).not.toHaveBeenCalled()
    const [kind, payload, patch] = connect.remoteCommand.mock.calls[0] as unknown as [string, Record<string, unknown>, Record<string, unknown>]
    expect(kind).toBe('playContext')
    expect(payload).toEqual({ context: { type: 'album', id: 'al1', name: 'Alb' }, trackIds: ['t0', 't1', 't2'], startIndex: 2, shuffle: false })
    expect(patch).toMatchObject({ status: 'loading', position: 0, shuffle: false })
  })

  it('remote: queue commands, transport and volume go to the session', () => {
    const { pb, player, connect } = setup(true)
    expect(pb.addToQueue(tracks(2))).toBeNull()
    pb.addNext(tracks(1, 'n'))
    pb.toggle()
    pb.setVolume(0.2)
    pb.toggleMute()
    const calls = connect.remoteCommand.mock.calls as unknown as unknown[][]
    expect(calls[0]).toEqual(['addToQueue', { trackIds: ['t0', 't1'] }])
    expect(calls[1]).toEqual(['playNext', { trackIds: ['n0'] }])
    expect(calls[2]).toEqual(['pause', undefined, { status: 'paused' }])
    expect(connect.setRemoteVolume).toHaveBeenCalledWith(0.2)
    expect(connect.setRemoteMuted).toHaveBeenCalledWith(true)
    expect(player.toggle).not.toHaveBeenCalled()
    expect(pb.isRemote()).toBe(true)
    expect(pb.position()).toBe(42)
    expect(pb.volume()).toBe(0.9)
  })

  it('ignores empty lists', async () => {
    const { pb, connect, player } = setup(true)
    await pb.playTracks([])
    expect(pb.addToQueue([])).toBeNull()
    expect(connect.remoteCommand).not.toHaveBeenCalled()
    expect(player.playTracks).not.toHaveBeenCalled()
  })
})
