import type { NowPlayingInfo, RemoteCommand } from '../platform'
import type { PlayerState } from '../store/player'
import { currentItem, peekNext } from './queue'
import { artistNames } from '../lib/format'
import { pickImage } from '../lib/url'

/** What remote commands (OS media controls) act on. */
export interface RemoteTarget {
  play(): void
  pause(): void
  toggle(): void
  next(): void
  previous(): void
  seek(seconds: number): void
  toggleShuffle(): void
  cycleRepeat(): void
  toggleLike(): void
}

/** Routes a command from the notification / lock screen / Bluetooth to the player. */
export function applyRemoteCommand(cmd: RemoteCommand, t: RemoteTarget): void {
  switch (cmd) {
    case 'play': return t.play()
    case 'pause':
    case 'stop': return t.pause()
    case 'toggle': return t.toggle()
    case 'next': return t.next()
    case 'previous': return t.previous()
    case 'shuffle': return t.toggleShuffle()
    case 'repeat': return t.cycleRepeat()
    case 'like': return t.toggleLike()
    default:
      if (typeof cmd === 'object' && cmd !== null && Number.isFinite(cmd.seekTo)) t.seek(Math.max(0, cmd.seekTo))
  }
}

type PlayerSnapshot = Pick<PlayerState, 'queue' | 'status' | 'position' | 'duration'>

export function hasNextOf(s: Pick<PlayerState, 'queue'>): boolean {
  return peekNext(s.queue) !== null || s.queue.index < s.queue.items.length - 1
}

export function hasPrevOf(s: Pick<PlayerState, 'queue'>): boolean {
  return s.queue.index > 0 || s.queue.repeat === 'all'
}

/** The now-playing snapshot for native controls, or null when nothing is loaded. */
export function nowPlayingInfo(
  s: PlayerSnapshot,
  isLiked: (trackId: string, serverValue?: boolean) => boolean
): NowPlayingInfo | null {
  const item = currentItem(s.queue)
  if (!item) return null
  const t = item.track
  return {
    id: item.uid,
    title: t.title,
    artist: artistNames(t.artists),
    album: t.album?.title ?? '',
    artworkUrl: pickImage(t.artwork, 512),
    duration: s.duration || t.duration || 0,
    position: s.position,
    playing: s.status === 'playing' || s.status === 'buffering',
    buffering: s.status === 'buffering',
    hasNext: hasNextOf(s),
    hasPrev: hasPrevOf(s),
    liked: isLiked(t.id, t.liked),
    shuffle: s.queue.shuffle,
    repeat: s.queue.repeat
  }
}

/**
 * True when the position moved in a way playback alone does not explain (a seek, a restart):
 * the native side extrapolates while playing, so only such jumps need to be re-sent.
 */
export function isPositionJump(prevPos: number, pos: number, elapsedSeconds: number, advancing: boolean, tolerance = 1.5): boolean {
  const expected = advancing ? Math.max(0, elapsedSeconds) : 0
  return Math.abs(pos - prevPos - expected) > tolerance
}
