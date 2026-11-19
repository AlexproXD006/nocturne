import { describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { bindRemoteControl, remoteControlPayload } from '@/platform/remoteControl'
import type { ConnectStoreState } from '@/store/connect'
import type { NativePlayerEvent, NativeRemoteControl } from '@/platform/nativePlayerTypes'
import { track } from '../helpers/fixtures'

function setup() {
  const store = create<Pick<ConnectStoreState, 'controlling' | 'remote' | 'remotePosition' | 'setRemoteVolume' | 'setRemoteMuted'>>(() => ({
    controlling: null,
    remote: null,
    remotePosition: () => 30,
    setRemoteVolume: vi.fn(),
    setRemoteMuted: vi.fn()
  }))
  let handler: (e: NativePlayerEvent) => void = () => undefined
  const calls: NativeRemoteControl[] = []
  const native = {
    setRemoteControl: vi.fn((s: NativeRemoteControl) => void calls.push(s)),
    on: vi.fn((l: (e: NativePlayerEvent) => void) => {
      handler = l
      return () => undefined
    })
  }
  const playback = { play: vi.fn(), pause: vi.fn(), next: vi.fn(), previous: vi.fn(), seek: vi.fn() }
  const off = bindRemoteControl(native, store as never, playback)
  const control = (state: object = {}): void =>
    store.setState({
      controlling: 'pc',
      remote: { id: 'pc', name: 'My PC', platform: 'windows', at: 0, state: { status: 'playing', track: track('t1'), volume: 0.5, muted: false, position: 30, duration: 200, ...state } } as never
    })
  return { store, native, calls, playback, fire: (e: NativePlayerEvent) => handler(e), control, off }
}

describe('remote control bridge', () => {
  it('does nothing while not controlling', () => {
    const { native, store } = setup()
    store.setState({ remotePosition: () => 1 })
    expect(native.setRemoteControl).not.toHaveBeenCalled()
  })

  it('activates native with device name, volume, mute and metadata when controlling starts', () => {
    const { calls, control } = setup()
    control()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ active: true, deviceName: 'My PC', volume: 0.5, muted: false, status: 'playing', position: 30, duration: 200 })
    expect((calls[0] as { track: { id: string } }).track.id).toBe('t1')
  })

  it('follows volume / mute changes made on the PC and does not repeat identical state', () => {
    const { calls, control, store } = setup()
    control()
    store.setState({ remotePosition: () => 31 }) // same state, position within extrapolation
    expect(calls).toHaveLength(1)
    control({ volume: 0.8 })
    expect(calls).toHaveLength(2)
    expect(calls[1]).toMatchObject({ volume: 0.8 })
    control({ volume: 0.8, muted: true })
    expect(calls[2]).toMatchObject({ muted: true })
  })

  it('goes back to local (active:false) when controlling stops, once', () => {
    const { calls, control, store } = setup()
    control()
    store.setState({ controlling: null, remote: null })
    store.setState({ remotePosition: () => 2 })
    expect(calls.map((c) => c.active)).toEqual([true, false])
  })

  it('turns native volume events into Connect volume / mute commands, only while controlling', () => {
    const { store, fire, control } = setup()
    fire({ type: 'remoteVolume', volume: 0.3 })
    expect(store.getState().setRemoteVolume).not.toHaveBeenCalled()
    control()
    fire({ type: 'remoteVolume', volume: 0.3 })
    fire({ type: 'remoteMuted', muted: true })
    expect(store.getState().setRemoteVolume).toHaveBeenCalledWith(0.3)
    expect(store.getState().setRemoteMuted).toHaveBeenCalledWith(true)
  })

  it('routes notification transport buttons through playback', () => {
    const { fire, control, playback } = setup()
    control()
    fire({ type: 'remoteTransport', action: 'pause', position: 0 })
    fire({ type: 'remoteTransport', action: 'next', position: 0 })
    fire({ type: 'remoteTransport', action: 'seek', position: 42 })
    expect(playback.pause).toHaveBeenCalled()
    expect(playback.next).toHaveBeenCalled()
    expect(playback.seek).toHaveBeenCalledWith(42)
  })

  it('maps statuses and clamps volume', () => {
    const p = remoteControlPayload({
      controlling: 'x',
      remote: { id: 'x', name: 'n', platform: 'p', at: 0, state: { status: 'loading', volume: 4 } }
    })
    expect(p).toMatchObject({ active: true, status: 'buffering', volume: 1, track: null })
    expect(remoteControlPayload({ controlling: null, remote: null })).toEqual({ active: false })
  })
})
