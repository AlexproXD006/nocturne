import { useCallback, useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import {
  clampGain,
  EQ_BANDS,
  EQ_BAND_COUNT,
  EQ_GAIN_MAX,
  EQ_GAIN_MIN,
  EQ_STEP,
  frequencyGrid,
  responseDb
} from '../lib/eq'
import { cx } from './common'
import { useT } from '../i18n'

const W = 1000
const H = 300
/** Plot range shown vertically (a little over the +-12 dB limits so handles at the edge stay visible). */
const DB_RANGE = 14
/** Plot frequency span: band i sits at the centre of the i-th tenth (22 Hz .. 22.6 kHz), matching the labels below. */
const F_LO = 31.25 * Math.pow(2, -0.5)
const F_HI = 31.25 * Math.pow(2, 9.5)
const GRID = frequencyGrid(160).map((_, i, a) => F_LO * Math.pow(F_HI / F_LO, i / (a.length - 1)))

const xOf = (freq: number): number => ((Math.log2(freq / 31.25) + 0.5) / 10) * W
const yOf = (db: number): number => H / 2 - (db / DB_RANGE) * (H / 2)

export function freqLabel(f: number): string {
  return f >= 1000 ? `${f / 1000}k` : String(f)
}

export function formatDb(v: number): string {
  return `${v > 0 ? '+' : ''}${v.toFixed(1).replace(/\.0$/, '')}`
}

/** Maps a pointer position inside the plot to the nearest band and a snapped gain. */
export function pointToBand(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }): { band: number; gain: number } {
  const fx = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  const fy = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height))
  let band = 0
  let best = Infinity
  for (let i = 0; i < EQ_BAND_COUNT; i++) {
    const d = Math.abs(xOf(EQ_BANDS[i]!) / W - fx)
    if (d < best) {
      best = d
      band = i
    }
  }
  return { band, gain: clampGain(((0.5 - fy) * 2) * DB_RANGE) }
}

export interface EqCurveProps {
  gains: readonly number[]
  disabled?: boolean
  onChange(band: number, gain: number): void
}

/**
 * Draggable 10-handle response curve. Pointer (mouse/touch/pen) drags the nearest handle anywhere in the plot;
 * every handle is also a focusable `role="slider"` (arrows +-0.5 dB, PageUp/PageDown +-3 dB, Home/End = limits).
 */
export function EqCurve({ gains, disabled = false, onChange }: EqCurveProps): ReactNode {
  const tr = useT()
  const plot = useRef<HTMLDivElement>(null)
  const dragging = useRef<number | null>(null)

  const path = GRID.map((f, i) => {
    const y = Math.max(0, Math.min(H, yOf(responseDb(gains, f))))
    return `${i === 0 ? 'M' : 'L'}${xOf(f).toFixed(1)},${y.toFixed(1)}`
  }).join(' ')

  const move = useCallback(
    (e: PointerEvent<HTMLDivElement>, band?: number): void => {
      const r = plot.current?.getBoundingClientRect()
      if (!r || r.width === 0) return
      const p = pointToBand(e.clientX, e.clientY, r)
      const b = band ?? dragging.current ?? p.band
      dragging.current = b
      onChange(b, p.gain)
    },
    [onChange]
  )

  const onKey = (e: KeyboardEvent<HTMLDivElement>, band: number): void => {
    if (disabled) return
    const g = gains[band] ?? 0
    let next: number | null = null
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        next = g + EQ_STEP
        break
      case 'ArrowDown':
      case 'ArrowLeft':
        next = g - EQ_STEP
        break
      case 'PageUp':
        next = g + 3
        break
      case 'PageDown':
        next = g - 3
        break
      case 'Home':
        next = EQ_GAIN_MIN
        break
      case 'End':
        next = EQ_GAIN_MAX
        break
      case '0':
        next = 0
        break
    }
    if (next === null) return
    e.preventDefault()
    e.stopPropagation()
    onChange(band, clampGain(next))
  }

  return (
    <div className={cx('select-none', disabled && 'opacity-50')}>
      <div
        ref={plot}
        className="eq-plot relative w-full touch-none"
        style={{ aspectRatio: `${W} / ${H}` }}
        onPointerDown={(e) => {
          if (disabled || (e.pointerType === 'mouse' && e.button !== 0)) return
          e.currentTarget.setPointerCapture?.(e.pointerId)
          dragging.current = null
          move(e)
        }}
        onPointerMove={(e) => {
          if (disabled || dragging.current === null) return
          move(e)
        }}
        onPointerUp={() => (dragging.current = null)}
        onPointerCancel={() => (dragging.current = null)}
        role="group"
        aria-label={tr('eq.curve')}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden>
          {[-12, -6, 0, 6, 12].map((db) => (
            <line key={db} x1={0} x2={W} y1={yOf(db)} y2={yOf(db)} className={db === 0 ? 'eq-zero' : 'eq-grid'} vectorEffect="non-scaling-stroke" />
          ))}
          {EQ_BANDS.map((f) => (
            <line key={f} x1={xOf(f)} x2={xOf(f)} y1={0} y2={H} className="eq-grid" vectorEffect="non-scaling-stroke" />
          ))}
          <path d={`${path} L${W},${H / 2} L0,${H / 2} Z`} className="eq-fill" />
          <path d={path} className="eq-line" fill="none" vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="eq-db pointer-events-none absolute top-0 left-1 text-[10px] text-fg-muted/70">+12</span>
        <span className="eq-db pointer-events-none absolute bottom-0 left-1 text-[10px] text-fg-muted/70">-12</span>
        {EQ_BANDS.map((f, i) => {
          const g = gains[i] ?? 0
          return (
            <div
              key={f}
              role="slider"
              tabIndex={disabled ? -1 : 0}
              aria-label={tr('eq.band', { freq: freqLabel(f) })}
              aria-orientation="vertical"
              aria-valuemin={EQ_GAIN_MIN}
              aria-valuemax={EQ_GAIN_MAX}
              aria-valuenow={g}
              aria-valuetext={tr('eq.bandValue', { db: formatDb(g) })}
              aria-disabled={disabled}
              onKeyDown={(e) => onKey(e, i)}
              onPointerDown={(e) => {
                if (disabled || (e.pointerType === 'mouse' && e.button !== 0)) return
                e.stopPropagation()
                plot.current?.setPointerCapture?.(e.pointerId)
                dragging.current = i
                move(e, i)
              }}
              className="eq-handle group absolute flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 cursor-grab items-center justify-center outline-none active:cursor-grabbing"
              style={{ left: `${(xOf(f) / W) * 100}%`, top: `${(yOf(g) / H) * 100}%` }}
            >
              <span className="eq-dot block h-4 w-4 rounded-full bg-accent shadow-[0_0_0_3px_rgb(var(--accent-rgb)/0.25)] ring-2 ring-white/80 transition-transform group-focus-visible:scale-125 group-focus-visible:ring-4 group-active:scale-125" />
            </div>
          )
        })}
      </div>
      <div className="mt-1 grid grid-cols-10 text-center text-[11px] text-fg-muted tabular-nums" aria-hidden>
        {EQ_BANDS.map((f, i) => (
          <div key={f}>
            <div className="font-medium text-fg/80">{freqLabel(f)}</div>
            <div>{formatDb(gains[i] ?? 0)}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
