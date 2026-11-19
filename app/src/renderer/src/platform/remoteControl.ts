import type { StoreApi } from 'zustand'
import type { ConnectStoreState } from '../store/connect'
import type { Playback } from '../player/playback'
import { artistNames } from '../lib/format'
import { pickImage } from '../lib/url'
import type { NativePlayer, NativeRemoteControl } from './nativePlayerTypes'

/** Position jumps larger than this (seconds, against native's own extrapolation) are re-sent. */
const POSITION_JUMP_S = 2

type Active = Extract<NativeRemoteControl, { active: true }>

/** What native should mirror for the current Connect state (`{active:false}` when controlling nothing). */
export function remoteControlPayload(s: Pick<ConnectStoreState, 'controlling' | 'remote'> & Partial<Pick<ConnectStoreState, 'remotePosition'>>): NativeRemoteControl {
  const r = s.remote
  if (!s.controlling || !r) return { active: false }
  const st = r.state
  const status = st.status === 'playing' ? 'playing' : st.status === 'buffering' || st.status === 'loading' ? 'buffering' : st.status === 'paused' ? 'paused' : 'idle'
  const t = st.track
  return {
    active: true,
    deviceName: r.name,
    volume: Math.min(1, Math.max(0, st.volume ?? 1)),
    muted: st.muted === true,
    status,
    position: Math.max(0, s.remotePosition ? s.remotePosition() : (st.position ?? 0)),
    duration: Math.max(0, st.duration ?? t?.duration ?? 0),
    track: t ? { id: t.id, title: t.title, artist: artistNames(t.artists), album: t.album?.title ?? '', artworkUrl: pickImage(t.artwork, 512) ?? '' } : null
  }
}

/** True when `next` carries nothing native does not already know (position drift is native's job). */
export function sameRemoteControl(a: NativeRemoteControl | null, b: NativeRemoteControl, nowPos: number, sentPos: number): boolean {
  if (!a) return false
  if (!a.active || !b.active) return a.active === b.active
  if (a.deviceName !== b.deviceName || a.volume !== b.volume || a.muted !== b.muted || a.status !== b.status || a.duration !== b.duration) return false
  if ((a.track?.id ?? '') !== (b.track?.id ?? '') || (a.track?.title ?? '') !== (b.track?.title ?? '') || (a.track?.artworkUrl ?? '') !== (b.track?.artworkUrl ?? '')) return false
  return Math.abs(nowPos - sentPos) <= POSITION_JUMP_S
}

/**
 * Android: while this phone controls another Connect device, mirrors that device into the Media3
 * session (so the hardware volume keys and the system volume slider drive it) and turns native
 * volume / transport events back into Connect commands. Returns the unsubscribe function.
 */
export function bindRemoteControl(
  native: Pick<NativePlayer, 'setRemoteControl' | 'on'>,
  connect: Pick<StoreApi<ConnectStoreState>, 'getState' | 'subscribe'>,
  playback: Pick<Playback, 'play' | 'pause' | 'next' | 'previous' | 'seek'>,
  now: () => number = Date.now
): () => void {
  let sent: NativeRemoteControl | null = null
  let sentPos = 0
  let sentAt = 0

  const push = (): void => {
    const s = connect.getState()
    const next = remoteControlPayload(s)
    // Native extrapolates the position while playing, so compare against where it should be by now.
    const expected = next.active && sent?.active && sent.status === 'playing' ? sentPos + (now() - sentAt) / 1000 : sentPos
    if (sameRemoteControl(sent, next, next.active ? next.position : 0, expected)) return
    if (!sent && !next.active) return // never controlled: nothing to revert
    sent = next
    sentPos = next.active ? next.position : 0
    sentAt = now()
    native.setRemoteControl(next)
  }

  const unsub = connect.subscribe(push)
  const off = native.on((e) => {
    const s = connect.getState()
    if (!s.controlling) return
    if (e.type === 'remoteVolume') s.setRemoteVolume(e.volume)
    else if (e.type === 'remoteMuted') s.setRemoteMuted(e.muted)
    else if (e.type === 'remoteTransport') {
      if (e.action === 'seek') playback.seek(e.position)
      else playback[e.action]()
    }
  })
  push()
  return () => {
    unsub()
    off()
    if (sent?.active) native.setRemoteControl({ active: false })
    sent = null
  }
}
