import { useEffect, useState } from 'react'
import type { Track } from '../api/types'
import { resolveLyrics, type Lyrics } from '../lyrics/service'
import { api, lrclib, useSession } from '../services'
import { LruCache } from '../lib/lru'

export type LyricsState = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; lyrics: Lyrics } | { status: 'error' }

const cache = new LruCache<string, Lyrics>(100)
/** Bumped by every invalidation so a request that was in flight at the time is not cached. */
let epoch = 0
const listeners = new Set<(trackId: string) => void>()

/**
 * Forgets the cached lyrics of a track (after an admin changed them) and makes any mounted
 * lyrics view for that track reload.
 */
export function invalidateLyrics(trackId: string): void {
  epoch++
  cache.delete(trackId)
  for (const fn of [...listeners]) fn(trackId)
}

export function useLyrics(track: Track | null | undefined, enabled = true): LyricsState {
  const serverLyrics = useSession((s) => s.server?.capabilities?.lyrics === true)
  const [state, setState] = useState<LyricsState>({ status: 'idle' })
  const [nonce, setNonce] = useState(0)
  const trackId = track?.id

  useEffect(() => {
    if (!trackId) return
    const fn = (id: string): void => {
      if (id === trackId) setNonce((n) => n + 1)
    }
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  }, [trackId])

  useEffect(() => {
    if (!track || !enabled) {
      setState({ status: 'idle' })
      return
    }
    const hit = cache.get(track.id)
    if (hit) {
      setState({ status: 'ready', lyrics: hit })
      return
    }
    const ctrl = new AbortController()
    const startedAt = epoch
    setState({ status: 'loading' })
    resolveLyrics(
      track,
      { lrclib, server: serverLyrics ? (id, signal) => api.lyrics(id, signal) : undefined },
      ctrl.signal
    ).then(
      (lyrics) => {
        if (startedAt === epoch) cache.set(track.id, lyrics)
        if (!ctrl.signal.aborted) setState({ status: 'ready', lyrics })
      },
      () => {
        if (!ctrl.signal.aborted) setState({ status: 'error' })
      }
    )
    return () => ctrl.abort()
  }, [track, enabled, serverLyrics, nonce])

  return state
}
