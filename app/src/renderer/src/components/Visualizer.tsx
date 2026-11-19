import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import type { Rgb } from '../lib/color'
import { getEngine, usePlayer } from '../services'
import { useFrame } from '../hooks/useClock'
import { BeatDetector, computeBands, smoothBands, syntheticBands, type Bands } from '../player/analysis'
import type { VisualizerStyle } from '../store/settings'

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  size: number
}

function shiftHue({ r, g, b }: Rgb, deg: number): Rgb {
  // Rotate in YIQ space: cheap and good enough for palette variations.
  const rad = (deg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const m = [
    0.299 + 0.701 * cos + 0.168 * sin, 0.587 - 0.587 * cos + 0.330 * sin, 0.114 - 0.114 * cos - 0.497 * sin,
    0.299 - 0.299 * cos - 0.328 * sin, 0.587 + 0.413 * cos + 0.035 * sin, 0.114 - 0.114 * cos + 0.292 * sin,
    0.299 - 0.3 * cos + 1.25 * sin, 0.587 - 0.588 * cos - 1.05 * sin, 0.114 + 0.886 * cos - 0.203 * sin
  ] as const
  const c = (v: number): number => Math.max(0, Math.min(255, Math.round(v)))
  return { r: c(m[0] * r + m[1] * g + m[2] * b), g: c(m[3] * r + m[4] * g + m[5] * b), b: c(m[6] * r + m[7] * g + m[8] * b) }
}

const rgba = (c: Rgb, a: number): string => `rgba(${c.r},${c.g},${c.b},${a})`

/**
 * Full-bleed reactive background. Reads the analyser every frame (no React state),
 * so it costs one canvas draw per frame and nothing else.
 */
export function Visualizer({
  accent,
  style,
  reduced,
  anchor
}: {
  accent: Rgb
  style: VisualizerStyle
  reduced: boolean
  /** Element the spectrum ring is centred on (e.g. the album cover). Falls back to the canvas centre. */
  anchor?: RefObject<HTMLElement | null>
}): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const playing = usePlayer((s) => s.status === 'playing')
  const state = useRef({
    bands: { bass: 0, mid: 0, treble: 0, energy: 0 } as Bands,
    beat: new BeatDetector(),
    pulse: 0,
    t: 0,
    particles: [] as Particle[],
    freq: new Uint8Array(1024) as Uint8Array<ArrayBuffer>,
    palette: [accent, shiftHue(accent, 40), shiftHue(accent, -50), shiftHue(accent, 160)]
  })

  useEffect(() => {
    state.current.palette = [accent, shiftHue(accent, 40), shiftHue(accent, -50), shiftHue(accent, 160)]
  }, [accent])

  // Keep the canvas sized to its box at a capped device pixel ratio.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const resize = (): void => {
      const scale = style === 'spectrum' ? Math.min(1.5, devicePixelRatio || 1) : 0.5
      canvas.width = Math.max(1, Math.floor(canvas.clientWidth * scale))
      canvas.height = Math.max(1, Math.floor(canvas.clientHeight * scale))
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [style])

  useFrame((dt) => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const s = state.current
    s.t += dt * (reduced ? 0.25 : 1)

    const engine = getEngine()
    let next: Bands
    if (engine && engine.reactive && s.freq.length === engine.frequencyBinCount && engine.getFrequencyData(s.freq)) {
      next = computeBands(s.freq, engine.sampleRate)
    } else {
      if (engine && s.freq.length !== engine.frequencyBinCount) s.freq = new Uint8Array(engine.frequencyBinCount)
      next = syntheticBands(s.t, playing)
    }
    s.bands = smoothBands(s.bands, next, dt)
    if (!reduced && s.beat.update(next.bass, dt)) s.pulse = 1
    s.pulse = Math.max(0, s.pulse - dt * 2.8)

    const { width: w, height: h } = canvas
    ctx.clearRect(0, 0, w, h)
    if (style === 'spectrum') {
      let ring: Ring = { cx: w / 2, cy: h / 2, radius: Math.min(w, h) * 0.2 }
      const el = anchor?.current
      if (el && el.offsetParent !== null) {
        const a = el.getBoundingClientRect()
        const c = canvas.getBoundingClientRect()
        if (a.width > 0 && c.width > 0) {
          const k = w / c.width
          ring = { cx: (a.left + a.width / 2 - c.left) * k, cy: (a.top + a.height / 2 - c.top) * k, radius: (a.width / 2) * k * 0.98 }
        }
      }
      drawSpectrum(ctx, w, h, s, ring)
    }
    else drawAurora(ctx, w, h, s, style === 'minimal' || reduced)
  }, true)

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={style === 'spectrum' ? undefined : { filter: 'blur(48px) saturate(1.25)', transform: 'scale(1.15)' }}
    />
  )
}

type Ring = { cx: number; cy: number; radius: number }

type VisState = {
  bands: Bands
  pulse: number
  t: number
  particles: Particle[]
  freq: Uint8Array<ArrayBuffer>
  palette: Rgb[]
}

function drawAurora(ctx: CanvasRenderingContext2D, w: number, h: number, s: VisState, calm: boolean): void {
  const { bands, t, palette } = s
  const base = Math.min(w, h)
  ctx.globalCompositeOperation = 'lighter'
  const blobs = calm ? 3 : 4
  for (let i = 0; i < blobs; i++) {
    const phase = i * 1.7
    const speed = 0.08 + i * 0.03
    const cx = w * (0.5 + 0.32 * Math.sin(t * speed + phase) * Math.cos(t * speed * 0.6 + i))
    const cy = h * (0.5 + 0.3 * Math.cos(t * speed * 0.9 + phase * 1.3))
    const raw = i === 0 ? bands.bass : i === 1 ? bands.mid : i === 2 ? bands.treble : bands.energy
    // Analyser levels can go negative/NaN (EQ graph, silence); canvas throws on negative radii.
    const level = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0
    const pulse = Number.isFinite(s.pulse) ? Math.max(0, s.pulse) : 0
    const r = Math.max(1, base * (0.32 + (calm ? 0.1 : 0.42) * level + (i === 0 && !calm ? 0.12 * pulse : 0)))
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
    const color = palette[i % palette.length]!
    g.addColorStop(0, rgba(color, calm ? 0.35 : 0.42 + 0.3 * level))
    g.addColorStop(0.55, rgba(color, 0.12 + 0.1 * level))
    g.addColorStop(1, rgba(color, 0))
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
  }
  ctx.globalCompositeOperation = 'source-over'
}

function drawSpectrum(ctx: CanvasRenderingContext2D, w: number, h: number, s: VisState, ring: Ring): void {
  const { bands, palette, freq, t } = s
  // Soft glow background
  const { cx, cy } = ring
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, Math.max(w, h) * 0.7))
  g.addColorStop(0, rgba(palette[0]!, 0.22 + bands.energy * 0.25))
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)

  const radius = ring.radius * (1 + s.pulse * 0.04)
  const bars = 120
  const usable = Math.floor(freq.length * 0.6)
  ctx.lineCap = 'round'
  ctx.lineWidth = Math.max(2, (Math.PI * 2 * radius) / bars * 0.45)
  for (let i = 0; i < bars; i++) {
    // Log-ish mapping so the bass doesn't dominate the ring.
    const idx = Math.min(usable - 1, Math.floor(Math.pow(i / bars, 1.8) * usable))
    const v = freq[idx]! / 255 || syntheticBar(i, t, bands)
    const len = Math.min(radius, Math.min(w, h) * 0.22) * (0.1 + v * 0.95)
    const a = (i / bars) * Math.PI * 2 - Math.PI / 2
    const x1 = cx + Math.cos(a) * radius
    const y1 = cy + Math.sin(a) * radius
    const x2 = cx + Math.cos(a) * (radius + len)
    const y2 = cy + Math.sin(a) * (radius + len)
    ctx.strokeStyle = rgba(i % 2 ? palette[0]! : palette[1]!, 0.55 + v * 0.45)
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()
  }

  // Beat particles
  if (s.pulse > 0.95 && s.particles.length < 160) {
    for (let i = 0; i < 18; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = (40 + Math.random() * 120) * (w / 800)
      s.particles.push({ x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, size: 1 + Math.random() * 2.5 })
    }
  }
  const dt = 1 / 60
  s.particles = s.particles.filter((p) => (p.life -= dt * 0.9) > 0)
  for (const p of s.particles) {
    p.x += p.vx * dt
    p.y += p.vy * dt
    ctx.fillStyle = rgba(palette[1]!, p.life * 0.8)
    ctx.beginPath()
    ctx.arc(p.x, p.y, Math.max(0.1, p.size * (w / 1000 + 0.6)) || 0.1, 0, Math.PI * 2)
    ctx.fill()
  }
}

function syntheticBar(i: number, t: number, b: Bands): number {
  return Math.max(0, 0.15 + b.energy * 0.6 * (0.6 + 0.4 * Math.sin(i * 0.37 + t * 3)))
}
