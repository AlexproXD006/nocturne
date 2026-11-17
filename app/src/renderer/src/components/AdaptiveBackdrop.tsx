import { useEffect, useState, type ReactNode } from 'react'
import { usePlayer } from '../services'
import { currentItem } from '../player/queue'
import { pickImage } from '../lib/url'
import { prefersReducedMotion, useSettings } from '../store/settings'
import { cx } from './common'

/**
 * Ambient background for the "Adaptive" theme: the current cover, heavily
 * blurred, plus a glow in its dominant colour (the live --accent-rgb, which
 * useGlobalAccent sets from the artwork in this theme). Covers crossfade on
 * track change; with reduced motion they swap instantly.
 *
 * Display only (an <img>, never read into a canvas), so no CORS is needed.
 */
export function AdaptiveBackdrop(): ReactNode {
  const theme = useSettings((s) => s.theme)
  const motion = useSettings((s) => s.motion)
  const artwork = usePlayer((s) => currentItem(s.queue)?.track.artwork)
  const src = pickImage(artwork, 300)
  const reduced = prefersReducedMotion(motion)

  // Keep the previous cover underneath while the new one fades in.
  const [layers, setLayers] = useState<string[]>(src ? [src] : [])
  useEffect(() => {
    if (!src) return
    setLayers((prev) => (prev[prev.length - 1] === src ? prev : [...prev.slice(-1), src]))
  }, [src])

  if (theme !== 'adaptive') return null

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-black">
      {layers.map((url, i) => (
        <img
          key={url}
          src={url}
          alt=""
          draggable={false}
          className={cx(
            'absolute inset-0 h-full w-full scale-125 object-cover opacity-55 blur-3xl saturate-150',
            !reduced && i === layers.length - 1 && layers.length > 1 && 'ambient-in'
          )}
        />
      ))}
      <div
        className="absolute inset-0 transition-[background] duration-1000"
        style={{
          background:
            'radial-gradient(120% 80% at 15% 0%, rgb(var(--accent-rgb) / 0.42), transparent 60%),' +
            'radial-gradient(110% 80% at 100% 100%, rgb(var(--accent-rgb) / 0.22), transparent 65%)'
        }}
      />
      <div className="absolute inset-0 bg-black/45" />
    </div>
  )
}
