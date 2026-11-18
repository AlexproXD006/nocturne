import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../services'
import { clampOffset, OFFSET_STEP_MS } from '../lyrics/offset'
import { useUi } from '../store/ui'
import { patchCachedOffset } from './useLyrics'

/** How long to wait after the last click before saving to the server. */
export const OFFSET_SAVE_DEBOUNCE_MS = 600

export interface LyricsOffset {
  offsetMs: number
  /** Adds `deltaMs` (default step 0.5 s). */
  nudge(deltaMs: number): void
  reset(): void
}

/**
 * Per-track lyrics offset. `initial` is the server's value; changes apply instantly (optimistic) and
 * are saved debounced. A pending save is flushed when the track changes or the view unmounts.
 */
export function useLyricsOffset(trackId: string | undefined, initial: number | undefined): LyricsOffset {
  const [offsetMs, setOffsetMs] = useState(clampOffset(initial ?? 0))
  const value = useRef(offsetMs)
  const dirty = useRef<{ id: string; ms: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = useCallback((): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const d = dirty.current
    dirty.current = null
    if (!d) return
    api.setLyricsOffset(d.id, d.ms).catch(() => useUi.getState().toast("Couldn't save the lyrics offset.", 'error'))
  }, [])

  // New track (or freshly loaded lyrics): adopt the server value after saving anything pending.
  useEffect(() => {
    flush()
    const v = clampOffset(initial ?? 0)
    value.current = v
    setOffsetMs(v)
    return () => flush()
  }, [trackId, initial, flush])

  const set = useCallback(
    (ms: number): void => {
      if (!trackId) return
      const v = clampOffset(ms)
      value.current = v
      setOffsetMs(v)
      patchCachedOffset(trackId, v)
      dirty.current = { id: trackId, ms: v }
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(flush, OFFSET_SAVE_DEBOUNCE_MS)
    },
    [trackId, flush]
  )

  const nudge = useCallback((delta: number = OFFSET_STEP_MS): void => set(value.current + delta), [set])
  const reset = useCallback((): void => set(0), [set])
  return { offsetMs, nudge, reset }
}
