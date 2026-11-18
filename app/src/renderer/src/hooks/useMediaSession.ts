import { useEffect } from 'react'
import { api, platform, usePlayer } from '../services'
import { currentItem } from '../player/queue'
import { applyRemoteCommand, hasNextOf, hasPrevOf, isPositionJump, nowPlayingInfo } from '../player/remote'
import { useLikes } from '../store/likes'
import { useUi } from '../store/ui'
import { describeError } from '../api/errors'
import { artistNames } from '../lib/format'

/** Toggles "liked" on the current track through the same store/API path as the heart buttons. */
function toggleCurrentLike(): void {
  const it = currentItem(usePlayer.getState().queue)
  if (!it) return
  const likes = useLikes.getState()
  const id = it.track.id
  likes
    .toggle(id, likes.isLiked(id, it.track.liked), (trackId, liked) => api.setLiked(trackId, liked))
    .catch((err: unknown) => useUi.getState().toast(describeError(err), 'error'))
}

/** Pushes the full now-playing snapshot to the native controls (Android Media3 session). */
function pushNative(): void {
  const native = platform.nativeNowPlaying
  if (!native) return
  const info = nowPlayingInfo(usePlayer.getState(), (id, server) => useLikes.getState().isLiked(id, server))
  if (info) native.update(info)
  else native.clear()
}

/**
 * Bridges the player to OS media controls:
 *  - desktop: navigator.mediaSession → media keys, Windows SMTC, Linux MPRIS
 *  - Android: the NocturneMedia plugin (Media3 session: notification, lock screen, Now Bar)
 */
export function useMediaSession(): void {
  const item = usePlayer((s) => currentItem(s.queue))
  const status = usePlayer((s) => s.status)
  const hasNext = usePlayer(hasNextOf)
  const hasPrev = usePlayer(hasPrevOf)
  const shuffle = usePlayer((s) => s.queue.shuffle)
  const repeat = usePlayer((s) => s.queue.repeat)
  const liked = useLikes((s) => (item ? (s.overrides[item.track.id] ?? item.track.liked === true) : false))
  const playing = status === 'playing' || status === 'buffering'
  const trackId = item?.track.id
  const native = platform.nativePlayer ?? null

  // Android: the Media3 service owns the system controls; just keep its heart button in step.
  useEffect(() => {
    if (native && trackId) native.setLiked(trackId, liked)
  }, [native, trackId, liked])

  // Action handlers (once).
  useEffect(() => {
    if (native) return
    const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined
    const p = (): ReturnType<typeof usePlayer.getState> => usePlayer.getState()
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => p().play()],
      ['pause', () => p().pause()],
      ['stop', () => p().pause()],
      ['nexttrack', () => void p().next()],
      ['previoustrack', () => void p().previous()],
      ['seekto', (d) => d.seekTime !== undefined && p().seek(d.seekTime)],
      ['seekbackward', (d) => p().seek(p().position - (d.seekOffset ?? 10))],
      ['seekforward', (d) => p().seek(p().position + (d.seekOffset ?? 10))]
    ]
    if (ms) {
      for (const [action, fn] of handlers) {
        try {
          ms.setActionHandler(action, fn)
        } catch {
          /* action unsupported */
        }
      }
    }
    const off = platform.nativeNowPlaying?.onCommand((cmd) =>
      applyRemoteCommand(cmd, {
        play: () => p().play(),
        pause: () => p().pause(),
        toggle: () => p().toggle(),
        next: () => void p().next(),
        previous: () => void p().previous(),
        seek: (seconds) => p().seek(seconds),
        toggleShuffle: () => p().setShuffle(!p().queue.shuffle),
        cycleRepeat: () => p().cycleRepeat(),
        toggleLike: toggleCurrentLike
      })
    )
    return () => {
      off?.()
      if (ms) for (const [action] of handlers) {
        try {
          ms.setActionHandler(action, null)
        } catch {
          /* ignore */
        }
      }
    }
  }, [])

  // Metadata + state.
  useEffect(() => {
    if (native) return
    const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined
    if (!item) {
      if (ms) {
        ms.metadata = null
        ms.playbackState = 'none'
      }
      platform.nativeNowPlaying?.clear()
      return
    }
    const t = item.track
    if (ms && typeof MediaMetadata !== 'undefined') {
      ms.metadata = new MediaMetadata({
        title: t.title,
        artist: artistNames(t.artists),
        album: t.album?.title ?? '',
        artwork: (t.artwork ?? []).map((a) => ({ src: a.url, sizes: a.width ? `${a.width}x${a.height ?? a.width}` : undefined }))
      })
    }
    if (ms) ms.playbackState = playing ? 'playing' : 'paused'
    pushNative()
  }, [item, status, playing, hasNext, hasPrev, liked, shuffle, repeat])

  // Native seek bar: the native side extrapolates while playing, so only re-send on jumps
  // (seek, restart) or when the real duration becomes known; no periodic timer.
  useEffect(() => {
    if (native || !platform.nativeNowPlaying) return
    let lastAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
    return usePlayer.subscribe((s, prev) => {
      if (s.position === prev.position && s.duration === prev.duration) return
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
      const elapsed = (now - lastAt) / 1000
      lastAt = now
      if (!currentItem(s.queue)) return
      const durationKnown = s.duration > 0 && Math.abs(s.duration - prev.duration) > 0.5
      if (durationKnown || isPositionJump(prev.position, s.position, elapsed, prev.status === 'playing')) pushNative()
    })
  }, [])

  // Position state for scrubbers in OS widgets.
  useEffect(() => {
    const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined
    if (native || !ms?.setPositionState) return
    return usePlayer.subscribe((s, prev) => {
      if (s.duration <= 0) return
      if (Math.abs(s.position - prev.position) < 0.9 && s.duration === prev.duration) return
      try {
        ms.setPositionState({ duration: s.duration, position: Math.min(s.position, s.duration), playbackRate: 1 })
      } catch {
        /* invalid state during transitions */
      }
    })
  }, [])
}
