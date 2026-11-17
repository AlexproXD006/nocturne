import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { getEngine, usePlayer } from '../services'
import { useNowTrack } from '../hooks/useNowPlaying'
import { pickImage } from '../lib/url'
import { FALLBACK_ACCENT, relativeLuminance, saturate, type ImagePalette, type Rgb } from '../lib/color'
import {
  PAUSE_DIM,
  pulseActive,
  resolveBackdrop,
  resolveDim,
  showAppBackdrop,
  styleLuminance,
  type AdaptiveSettings,
  type ResolvedBackdrop
} from '../lib/adaptive'
import { bandLevel, syntheticBands } from '../player/analysis'
import { useSettings } from '../store/settings'
import { useUi } from '../store/ui'
import { usePalette } from '../hooks/useAccent'
import { useDeviceEnv } from '../hooks/useAdaptive'
import { useFrame } from '../hooks/useClock'
import { cx } from './common'

/** Palette used when there is no cover (or it can't be read): the Adaptive theme swatch colours. */
const SAMPLE_PALETTE: ImagePalette = {
  dominant: { r: 255, g: 122, b: 92 },
  vibrant: { r: 123, g: 92, b: 255 },
  muted: { r: 92, g: 70, b: 120 },
  luminance: 0.2
}

const rgb = (c: Rgb): string => `rgb(${c.r} ${c.g} ${c.b})`

function auroraColors(p: ImagePalette, sat: number): [Rgb, Rgb, Rgb] {
  const a = p.dominant ?? p.vibrant ?? p.muted ?? FALLBACK_ACCENT
  const b = p.vibrant ?? a
  const c = p.muted ?? b
  return [saturate(a, sat), saturate(b, sat), saturate(c, sat)]
}

function auroraBackground([a, b, c]: [Rgb, Rgb, Rgb]): string {
  return (
    `radial-gradient(45% 55% at 25% 30%, ${rgb(a)}, transparent 70%),` +
    `radial-gradient(50% 50% at 75% 35%, ${rgb(b)}, transparent 70%),` +
    `radial-gradient(60% 55% at 50% 80%, ${rgb(c)}, transparent 72%)`
  )
}

/** Keeps the previous layer underneath while the new one fades in (max two layers). */
function useLayers(key: string | undefined): string[] {
  const [layers, setLayers] = useState<string[]>(key ? [key] : [])
  useEffect(() => {
    if (!key) return
    setLayers((prev) => (prev[prev.length - 1] === key ? prev : [...prev.slice(-1), key]))
  }, [key])
  return layers
}

export type BackdropVariant = 'app' | 'embedded' | 'preview'

/**
 * Ambient background for the "Adaptive" theme. Variants:
 *  - 'app': fixed behind the whole shell (only when the scope is "everywhere")
 *  - 'embedded': fills its positioned parent (the fullscreen player)
 *  - 'preview': fills its parent, for the live preview in Settings
 *
 * Styles: the blurred cover (default), an aurora of radial gradients built from
 * the cover palette, or the dominant colour alone. Everything tunable is pushed
 * as CSS variables / inline styles on this root, so changes are cheap. Drift and
 * spin are CSS keyframes (transform only) paused via animation-play-state; only
 * "pulse" runs a per-frame loop, reading the engine's existing AnalyserNode.
 *
 * Display only (an <img>, never read into a canvas), so no CORS is needed here;
 * the palette comes from lib/color's cached sampling (same as the accent).
 */
export function AdaptiveBackdrop({ variant = 'app', settings }: { variant?: BackdropVariant; settings?: AdaptiveSettings }): ReactNode {
  const theme = useSettings((st) => st.theme)
  const stored = useSettings((st) => st.adaptive)
  // Mount nothing (no palette work, no loops) when the app-wide layer is off.
  if (variant === 'app' && !showAppBackdrop(theme, stored)) return null
  return <Backdrop variant={variant} s={settings ?? stored} />
}

function Backdrop({ variant, s }: { variant: BackdropVariant; s: AdaptiveSettings }): ReactNode {
  const env = useDeviceEnv()
  const fullscreenOpen = useUi((u) => u.fullscreen)
  const artwork = useNowTrack()?.artwork
  const playing = usePlayer((p) => p.status === 'playing')
  const r = resolveBackdrop(s, env)
  const src = pickImage(artwork, r.imageSize)
  const sampled = usePalette(pickImage(artwork, 120))
  const palette = sampled ?? SAMPLE_PALETTE
  const hasCover = Boolean(src)
  // Without a cover, "cover" falls back to the sample gradient.
  const style = r.style === 'cover' && !hasCover ? 'aurora' : r.style

  const aurora = useMemo(() => auroraColors(palette, r.saturation), [palette, r.saturation])
  const auroraBg = auroraBackground(aurora)
  const solid = saturate(palette.dominant ?? palette.vibrant ?? palette.muted ?? FALLBACK_ACCENT, r.saturation)
  const coverLayers = useLayers(style === 'cover' ? src : undefined)
  const auroraLayers = useLayers(style === 'aurora' ? auroraBg : undefined)

  // The app-wide layer is hidden under the fullscreen player: freeze it there.
  const visible = variant !== 'app' || !fullscreenOpen
  // The Settings preview keeps moving while paused, so motion changes are visible there.
  const freezeOnPause = s.pauseFreeze && variant !== 'preview'
  const frozen = !visible || (freezeOnPause && !playing)
  const pausedDim = freezeOnPause && !playing ? PAUSE_DIM : 0

  const accentLum = relativeLuminance(palette.dominant ?? FALLBACK_ACCENT)
  const dim = resolveDim(s, {
    luminance: styleLuminance(style, { luminance: palette.luminance, colors: style === 'solid' ? [solid] : aurora }),
    opacity: r.opacity,
    glow: r.glow,
    accentLuminance: accentLum
  })

  const mediaRef = useRef<HTMLDivElement>(null)
  const glowRef = useRef<HTMLDivElement>(null)
  usePulse(r, { playing, freezeOnPause, visible }, mediaRef, glowRef)

  const saver = r.tier === 'saver'
  const blurPx = saver ? r.blur / 2 : r.blur // saver renders the layer at half size, scaled up 2x
  const filter = [blurPx > 0 ? `blur(${blurPx}px)` : '', r.saturation !== 1 ? `saturate(${Math.round(r.saturation * 100)}%)` : '']
    .filter(Boolean)
    .join(' ')
  const rootStyle = {
    '--ab-opacity': String(r.opacity),
    '--ab-filter': filter || 'none',
    '--ab-fade': `${r.fade}s`,
    '--ab-motion-duration': `${r.motionDuration}s`,
    '--ab-aurora-duration': `${r.auroraDuration}s`
  } as CSSProperties
  const g = r.glow

  return (
    <div
      aria-hidden
      data-testid={`adaptive-backdrop-${variant}`}
      data-motion={r.motion}
      data-tier={r.tier}
      className={cx(
        'adaptive-backdrop pointer-events-none overflow-hidden bg-black',
        variant === 'app' ? 'fixed inset-0 -z-10' : 'absolute inset-0',
        frozen && 'ab-frozen',
        saver && 'ab-saver'
      )}
      style={rootStyle}
    >
      <div
        ref={mediaRef}
        className={cx('ab-media', r.motion === 'drift' && 'ab-drift', r.motion === 'spin' && 'ab-spin', r.motion === 'pulse' && 'ab-pulse')}
      >
        {style === 'cover' &&
          coverLayers.map((url, i) => (
            <img
              key={url}
              src={url}
              alt=""
              draggable={false}
              decoding="async"
              className={cx('ab-cover', r.fade > 0 && i === coverLayers.length - 1 && coverLayers.length > 1 && 'ambient-in')}
            />
          ))}
        {style === 'aurora' &&
          auroraLayers.map((bg, i) => (
            <div
              key={bg}
              className={cx('ab-aurora', r.fade > 0 && i === auroraLayers.length - 1 && auroraLayers.length > 1 && 'ambient-in')}
            >
              <div className={cx('ab-aurora-field', r.auroraAnimated && 'ab-aurora-animated')} style={{ background: bg }} />
            </div>
          ))}
        {style === 'solid' && <div className="ab-solid" style={{ backgroundColor: rgb(solid) }} />}
      </div>
      {g > 0 && (
        <div
          ref={glowRef}
          className="ab-glow absolute inset-0 transition-[background] duration-1000"
          style={{
            background:
              `radial-gradient(120% 80% at 15% 0%, rgb(var(--accent-rgb) / ${round(0.42 * g)}), transparent 60%),` +
              `radial-gradient(110% 80% at 100% 100%, rgb(var(--accent-rgb) / ${round(0.22 * g)}), transparent 65%)`
          }}
        />
      )}
      {r.vignette && <div className="ab-vignette absolute inset-0" />}
      {r.grain && <div className="ab-grain absolute inset-0" />}
      <div className="ab-dim absolute inset-0 bg-black" style={{ opacity: Math.min(0.95, dim + pausedDim) }} />
    </div>
  )
}

const round = (v: number): number => Math.round(Math.min(1, v) * 1000) / 1000

/**
 * Beat reaction for motion "pulse": reads bass energy from the engine's existing
 * analyser (falls back to synthetic bands without CORS, like the visualizer),
 * smooths it and writes transform/opacity straight to the DOM — no React renders,
 * and only when the value moved noticeably. Runs only while pulse is active.
 */
function usePulse(
  r: ResolvedBackdrop,
  opts: { playing: boolean; freezeOnPause: boolean; visible: boolean },
  mediaRef: RefObject<HTMLDivElement | null>,
  glowRef: RefObject<HTMLDivElement | null>
): void {
  const active = pulseActive(r, opts)
  const st = useRef({ level: 0, written: -1, t: 0, freq: new Uint8Array(1024) as Uint8Array<ArrayBuffer> })

  // Leaving pulse mode: drop the inline styles so CSS takes over again.
  const isPulse = r.motion === 'pulse'
  useEffect(() => {
    if (isPulse) return
    st.current.written = -1
    st.current.level = 0
    mediaRef.current?.style.removeProperty('transform')
    glowRef.current?.style.removeProperty('opacity')
  }, [isPulse, mediaRef, glowRef])

  useFrame((dt) => {
    const s = st.current
    s.t += dt
    const engine = getEngine()
    let bass: number
    if (engine && engine.reactive && s.freq.length === engine.frequencyBinCount && engine.getFrequencyData(s.freq)) {
      bass = bandLevel(s.freq, engine.sampleRate, 20, 160)
    } else {
      if (engine && s.freq.length !== engine.frequencyBinCount) s.freq = new Uint8Array(engine.frequencyBinCount)
      bass = syntheticBands(s.t, opts.playing).bass
    }
    const rate = bass > s.level ? 14 : 3.5
    s.level += (bass - s.level) * (1 - Math.exp(-rate * dt))
    const p = Math.min(1, Math.max(0, (s.level - 0.12) / 0.55))
    if (Math.abs(p - s.written) < 0.004) return
    s.written = p
    if (mediaRef.current) mediaRef.current.style.transform = `scale(${(1 + 0.07 * p).toFixed(4)})`
    if (glowRef.current) glowRef.current.style.opacity = (0.65 + 0.35 * p).toFixed(3)
  }, active)
}
