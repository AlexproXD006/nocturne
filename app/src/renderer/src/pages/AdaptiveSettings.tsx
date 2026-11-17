import { useId, useState, type CSSProperties, type ReactNode } from 'react'
import { Check, ChevronDown, RotateCcw } from 'lucide-react'
import {
  ADAPTIVE_PRESET_IDS,
  ADAPTIVE_PRESETS,
  DEFAULT_ADAPTIVE,
  isLowEndAndroid,
  resolveBackdrop,
  SAVER_BLUR_CAP,
  type AccentSource,
  type AdaptiveDimMode,
  type AdaptiveMotion,
  type AdaptivePerformance,
  type AdaptiveScope,
  type AdaptiveSpeed,
  type AdaptiveStyle
} from '../lib/adaptive'
import { useSettings } from '../store/settings'
import { useDeviceEnv } from '../hooks/useAdaptive'
import { AdaptiveBackdrop } from '../components/AdaptiveBackdrop'
import { cx } from '../components/common'
import { Segmented, Toggle } from './SettingsControls'

const STYLES: { id: AdaptiveStyle; label: string }[] = [
  { id: 'cover', label: 'Cover' },
  { id: 'aurora', label: 'Aurora' },
  { id: 'solid', label: 'Solid' }
]
const MOTIONS: { id: AdaptiveMotion; label: string }[] = [
  { id: 'static', label: 'Still' },
  { id: 'drift', label: 'Drift' },
  { id: 'spin', label: 'Spin' },
  { id: 'pulse', label: 'Pulse' }
]
const SPEEDS: { id: AdaptiveSpeed; label: string }[] = [
  { id: 'slow', label: 'Slow' },
  { id: 'medium', label: 'Medium' },
  { id: 'fast', label: 'Fast' }
]
const DIM_MODES: { id: AdaptiveDimMode; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'manual', label: 'Manual' }
]
const ACCENT_SOURCES: { id: AccentSource; label: string }[] = [
  { id: 'dominant', label: 'Dominant' },
  { id: 'vibrant', label: 'Vibrant' },
  { id: 'muted', label: 'Muted' }
]
const SCOPES: { id: AdaptiveScope; label: string }[] = [
  { id: 'everywhere', label: 'Everywhere' },
  { id: 'fullscreen', label: 'Now playing only' }
]
const PERFORMANCE: { id: AdaptivePerformance; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'quality', label: 'Quality' },
  { id: 'saver', label: 'Saver' }
]

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <div className="space-y-2">
      <div>
        <div className="text-[15px] font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-[13px] text-fg-muted">{hint}</div>}
      </div>
      {children}
    </div>
  )
}

function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  format,
  hint,
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  format: (v: number) => string
  hint?: ReactNode
  onChange: (v: number) => void
}): ReactNode {
  const id = useId()
  const pct = ((value - min) / (max - min)) * 100
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-[15px] font-medium">
          {label}
        </label>
        <span className="shrink-0 text-sm text-fg-muted tabular-nums">{format(value)}</span>
      </div>
      {hint && <div className="mt-0.5 text-[13px] text-fg-muted">{hint}</div>}
      <input
        id={id}
        type="range"
        className="range block"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={format(value)}
        style={{ height: 44, ['--fill' as string]: `${pct}%` } as CSSProperties}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
      />
    </div>
  )
}

function ToggleRow({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }): ReactNode {
  return (
    <div className="flex min-h-11 items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-[15px] font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-[13px] text-fg-muted">{hint}</div>}
      </div>
      <Toggle label={label} checked={checked} onChange={onChange} />
    </div>
  )
}

const pct = (v: number): string => `${v}%`

/**
 * Settings → Visuals → "Adaptive background" (shown while the Adaptive theme is
 * selected): presets, a live preview and the options. Advanced options sit
 * under "More options".
 */
export function AdaptiveSettingsPanel(): ReactNode {
  const a = useSettings((s) => s.adaptive)
  const set = useSettings((s) => s.updateAdaptive)
  const env = useDeviceEnv()
  const r = resolveBackdrop(a, env)
  const [more, setMore] = useState(false)
  const moreId = useId()

  const motionNote = env.reducedMotion
    ? 'Motion is off because reduced motion is on (Settings → Motion or your device).'
    : r.tier === 'saver'
      ? 'Battery saver keeps the background still.'
      : null
  const autoReason = env.reducedMotion ? 'reduced motion is on' : isLowEndAndroid(env) ? 'this device is low on cores or memory' : null

  return (
    <div className="space-y-5 rounded-2xl bg-white/[0.03] p-4 ring-1 ring-inset ring-line" aria-label="Adaptive background" role="group">
      <div>
        <h3 className="text-[15px] font-semibold">Adaptive background</h3>
        <p className="mt-0.5 text-[13px] text-fg-muted">Pick a preset, then tweak anything. Changes apply instantly.</p>
      </div>

      <div role="radiogroup" aria-label="Background preset" className="flex flex-wrap gap-2">
        {ADAPTIVE_PRESET_IDS.map((id) => {
          const p = ADAPTIVE_PRESETS[id]
          const selected = a.preset === id
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={selected}
              title={p.hint}
              onClick={() => set({ preset: id })}
              className={cx(
                'inline-flex min-h-11 items-center gap-1.5 rounded-full px-4 text-sm font-medium transition-colors',
                selected ? 'bg-fg text-ink-950' : 'bg-white/[0.07] text-fg-muted hover:text-fg'
              )}
            >
              {selected && <Check className="h-4 w-4" strokeWidth={3} />}
              {p.label}
            </button>
          )
        })}
        {a.preset === 'custom' && (
          <span className="inline-flex min-h-11 items-center rounded-full px-4 text-sm font-medium text-fg ring-1 ring-inset ring-accent">
            Custom
          </span>
        )}
      </div>

      <div
        className="relative isolate h-40 overflow-hidden rounded-xl ring-1 ring-inset ring-line sm:h-48"
        data-testid="adaptive-preview"
      >
        <AdaptiveBackdrop variant="preview" settings={a} />
        <div className="relative z-[1] flex h-full flex-col justify-end gap-1 p-4">
          <span className="w-fit rounded-full bg-accent px-2.5 py-0.5 text-[11px] font-bold text-ink-950">Now playing</span>
          <span className="truncate text-lg font-bold text-fg">Song title</span>
          <span className="truncate text-sm text-fg-muted">Artist name · Album</span>
        </div>
      </div>

      <Field label="Style" hint="Blurred cover, a gradient from its colours, or its main colour.">
        <Segmented large label="Style" value={a.style} options={STYLES} onChange={(v) => set({ style: v })} />
      </Field>

      <Field label="Motion" hint={motionNote ?? 'Pulse follows the bass of the music.'}>
        <Segmented large label="Motion" value={a.motion} options={MOTIONS} onChange={(v) => set({ motion: v })} />
      </Field>
      {(a.motion === 'drift' || a.motion === 'spin' || a.style === 'aurora') && (
        <Field label="Speed">
          <Segmented large label="Speed" value={a.speed} options={SPEEDS} onChange={(v) => set({ speed: v })} />
        </Field>
      )}

      <Slider
        label={a.style === 'cover' ? 'Cover visibility' : 'Colour visibility'}
        value={a.visibility}
        min={0}
        max={100}
        format={pct}
        onChange={(v) => set({ visibility: v })}
      />

      <Field label="Readability" hint="Auto darkens bright covers just enough to keep text readable (WCAG AA).">
        <Segmented large label="Readability" value={a.dimMode} options={DIM_MODES} onChange={(v) => set({ dimMode: v })} />
      </Field>
      {a.dimMode === 'manual' && <Slider label="Dim" value={a.dim} min={0} max={90} format={pct} onChange={(v) => set({ dim: v })} />}

      <Slider label="Glow" value={a.glow} min={0} max={100} format={pct} onChange={(v) => set({ glow: v })} />

      <button
        type="button"
        aria-expanded={more}
        aria-controls={moreId}
        onClick={() => setMore((m) => !m)}
        className="flex min-h-11 w-full items-center justify-between rounded-xl px-1 text-[15px] font-semibold"
      >
        More options
        <ChevronDown className={cx('h-5 w-5 transition-transform', more && 'rotate-180')} />
      </button>

      {more && (
        <div id={moreId} className="space-y-5">
          <Slider
            label="Blur"
            value={a.blur}
            min={0}
            max={80}
            format={(v) => `${v}px`}
            hint={r.tier === 'saver' && a.blur > SAVER_BLUR_CAP ? `Capped at ${SAVER_BLUR_CAP}px in battery saver.` : undefined}
            onChange={(v) => set({ blur: v })}
          />
          <Slider label="Saturation" value={a.saturation} min={0} max={200} format={pct} onChange={(v) => set({ saturation: v })} />
          <ToggleRow
            label="Grain"
            hint={r.tier === 'saver' && a.grain ? 'Off in battery saver.' : 'Subtle film-like texture.'}
            checked={a.grain}
            onChange={(v) => set({ grain: v })}
          />
          <ToggleRow label="Vignette" hint="Darker edges." checked={a.vignette} onChange={(v) => set({ vignette: v })} />
          <ToggleRow
            label="Freeze when paused"
            hint="Stops the motion and dims the background a little."
            checked={a.pauseFreeze}
            onChange={(v) => set({ pauseFreeze: v })}
          />
          <Slider
            label="Cover crossfade"
            value={a.fade}
            min={0}
            max={3}
            step={0.1}
            format={(v) => (v === 0 ? 'Instant' : `${v.toFixed(1)}s`)}
            onChange={(v) => set({ fade: v })}
          />
          <Field label="Accent source" hint="Which cover colour tints buttons and highlights.">
            <Segmented large label="Accent source" value={a.accentSource} options={ACCENT_SOURCES} onChange={(v) => set({ accentSource: v })} />
          </Field>
          <Field label="Show background" hint="Now playing only keeps the rest of the app on solid dark surfaces.">
            <Segmented large label="Show background" value={a.scope} options={SCOPES} onChange={(v) => set({ scope: v })} />
          </Field>
          {a.scope === 'everywhere' && (
            <Slider
              label="Panel glass"
              value={a.glass}
              min={0}
              max={100}
              format={pct}
              hint="How much of the background shows through the panels."
              onChange={(v) => set({ glass: v })}
            />
          )}
          <Field
            label="Performance"
            hint={
              a.performance === 'auto'
                ? `Auto is using ${r.tier === 'saver' ? `battery saver (${autoReason})` : 'full quality'}. Saver: no motion, lighter blur, no grain.`
                : 'Saver: no motion, lighter blur, no grain. Easier on battery.'
            }
          >
            <Segmented large label="Performance" value={a.performance} options={PERFORMANCE} onChange={(v) => set({ performance: v })} />
          </Field>
          <button
            type="button"
            onClick={() => useSettings.getState().update({ adaptive: DEFAULT_ADAPTIVE })}
            className="inline-flex min-h-11 items-center gap-2 rounded-full bg-white/[0.08] px-4 text-sm font-semibold hover:bg-white/[0.14]"
          >
            <RotateCcw className="h-4 w-4" /> Reset background options
          </button>
        </div>
      )}
    </div>
  )
}
