import { useEffect, useRef } from 'react'
import { getEngine, usePlayer } from '../services'

/** Current playback position in seconds, read straight from the engine (sub-frame accurate). */
export function readPosition(): number {
  return getEngine()?.currentTime ?? usePlayer.getState().position
}

/**
 * Calls `fn` every animation frame while active. Uses refs so the loop never restarts
 * because of re-renders.
 */
export function useFrame(fn: (dt: number, now: number) => void, active = true): void {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    if (!active) return
    let raf = 0
    let last = performance.now()
    const loop = (now: number): void => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      ref.current(dt, now)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [active])
}
