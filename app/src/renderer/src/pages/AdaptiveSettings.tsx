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
import { useT, type MessageKey } from '../i18n'
import { formatNumber } from '../i18n/format'

const STYLES: { id: AdaptiveStyle; label: MessageKey }[] = [
  { id: 'cover', label: 'ad.style.cover' },
  { id: 'aurora', label: 'ad.style.aurora' },
  { id: 'solid', label: 'ad.style.solid' }
]
const MOTIONS: { id: AdaptiveMotion; label: MessageKey }[] = [
  { id: 'static', label: 'ad.motion.static' },
  { id: 'drift', label: 'ad.motion.drift' },
  { id: 'spin', label: 'ad.motion.spin' },
  { id: 'pulse', label: 'ad.motion.pulse' }
]
const SPEEDS: { id: AdaptiveSpeed; label: MessageKey }[] = [
  { id: 'slow', label: 'ad.speed.slow' },
  { id: 'medium', label: 'ad.speed.medium' },
  { id: 'fast', label: 'ad.speed.fast' }
]
const DIM_MODES: { id: AdaptiveDimMode; label: MessageKey }[] = [
  { id: 'auto', label: 'ad.dim.auto' },
  { id: 'manual', label: 'ad.dim.manual' }
]
const ACCENT_SOURCES: { id: AccentSource; label: MessageKey }[] = [
  { id: 'dominant', label: 'ad.src.dominant' },
  { id: 'vibrant', label: 'ad.src.vibrant' },
  { id: 'muted', label: 'ad.src.muted' }
]
const SCOPES: { id: AdaptiveScope; label: MessageKey }[] = [
  { id: 'everywhere', label: 'ad.scope.everywhere' },
  { id: 'fullscreen', label: 'ad.scope.fullscreen' }
]
const PERFORMANCE: { id: AdaptivePerformance; label: MessageKey }[] = [
  { id: 'auto', label: 'ad.perf.auto' },
  { id: 'quality', label: 'ad.perf.quality' },
  { id: 'saver', label: 'ad.perf.saver' }
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
  const tr = useT()
  const a = useSettings((s) => s.adaptive)
  const set = useSettings((s) => s.updateAdaptive)
  const env = useDeviceEnv()
  const r = resolveBackdrop(a, env)
  const [more, setMore] = useState(false)
  const moreId = useId()
  const tOpts = <T extends string>(o: { id: T; label: MessageKey }[]): { id: T; label: string }[] => o.map((x) => ({ id: x.id, label: tr(x.label) }))

  const motionNote = env.reducedMotion
    ? tr('ad.motionOffReduced')
    : r.tier === 'saver'
      ? tr('ad.motionOffSaver')
      : null
  const autoReason = env.reducedMotion ? tr('ad.reasonReduced') : isLowEndAndroid(env) ? tr('ad.reasonLowEnd') : null

  return (
    <div className="space-y-5 rounded-2xl bg-white/[0.03] p-4 ring-1 ring-inset ring-line" aria-label={tr('ad.title')} role="group">
      <div>
        <h3 className="text-[15px] font-semibold">{tr('ad.title')}</h3>
        <p className="mt-0.5 text-[13px] text-fg-muted">{tr('ad.intro')}</p>
      </div>

      <div role="radiogroup" aria-label={tr('ad.preset')} className="flex flex-wrap gap-2">
        {ADAPTIVE_PRESET_IDS.map((id) => {
          const p = ADAPTIVE_PRESETS[id]
          const selected = a.preset === id
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={selected}
              title={tr(p.hintKey)}
              onClick={() => set({ preset: id })}
              className={cx(
                'inline-flex min-h-11 items-center gap-1.5 rounded-full px-4 text-sm font-medium transition-colors',
                selected ? 'bg-fg text-ink-950' : 'bg-white/[0.07] text-fg-muted hover:text-fg'
              )}
            >
              {selected && <Check className="h-4 w-4" strokeWidth={3} />}
              {tr(p.labelKey)}
            </button>
          )
        })}
        {a.preset === 'custom' && (
          <span className="inline-flex min-h-11 items-center rounded-full px-4 text-sm font-medium text-fg ring-1 ring-inset ring-accent">
            {tr('ad.custom')}
          </span>
        )}
      </div>

      <div
        className="relative isolate h-40 overflow-hidden rounded-xl ring-1 ring-inset ring-line sm:h-48"
        data-testid="adaptive-preview"
      >
        <AdaptiveBackdrop variant="preview" settings={a} />
        <div className="relative z-[1] flex h-full flex-col justify-end gap-1 p-4">
          <span className="w-fit rounded-full bg-accent px-2.5 py-0.5 text-[11px] font-bold text-ink-950">{tr('ad.previewNow')}</span>
          <span className="truncate text-lg font-bold text-fg">{tr('ad.previewSong')}</span>
          <span className="truncate text-sm text-fg-muted">{tr('ad.previewArtist')}</span>
        </div>
      </div>

      <Field label={tr('ad.style')} hint={tr('ad.styleHint')}>
        <Segmented large label={tr('ad.style')} value={a.style} options={tOpts(STYLES)} onChange={(v) => set({ style: v })} />
      </Field>

      <Field label={tr('ad.motion')} hint={motionNote ?? tr('ad.motionHint')}>
        <Segmented large label={tr('ad.motion')} value={a.motion} options={tOpts(MOTIONS)} onChange={(v) => set({ motion: v })} />
      </Field>
      {(a.motion === 'drift' || a.motion === 'spin' || a.style === 'aurora') && (
        <Field label={tr('ad.speed')}>
          <Segmented large label={tr('ad.speed')} value={a.speed} options={tOpts(SPEEDS)} onChange={(v) => set({ speed: v })} />
        </Field>
      )}

      <Slider
        label={a.style === 'cover' ? tr('ad.coverVisibility') : tr('ad.colourVisibility')}
        value={a.visibility}
        min={0}
        max={100}
        format={pct}
        onChange={(v) => set({ visibility: v })}
      />

      <Field label={tr('ad.readability')} hint={tr('ad.readabilityHint')}>
        <Segmented large label={tr('ad.readability')} value={a.dimMode} options={tOpts(DIM_MODES)} onChange={(v) => set({ dimMode: v })} />
      </Field>
      {a.dimMode === 'manual' && <Slider label={tr('ad.dim')} value={a.dim} min={0} max={90} format={pct} onChange={(v) => set({ dim: v })} />}

      <Slider label={tr('ad.glow')} value={a.glow} min={0} max={100} format={pct} onChange={(v) => set({ glow: v })} />

      <button
        type="button"
        aria-expanded={more}
        aria-controls={moreId}
        onClick={() => setMore((m) => !m)}
        className="flex min-h-11 w-full items-center justify-between rounded-xl px-1 text-[15px] font-semibold"
      >
        {tr('ad.more')} <ChevronDown className={cx('h-5 w-5 transition-transform', more && 'rotate-180')} />
      </button>

      {more && (
        <div id={moreId} className="space-y-5">
          <Slider
            label={tr('ad.blur')} value={a.blur}
            min={0}
            max={80}
            format={(v) => `${v}px`}
            hint={r.tier === 'saver' && a.blur > SAVER_BLUR_CAP ? tr('ad.blurCapped', { px: SAVER_BLUR_CAP }) : undefined}
            onChange={(v) => set({ blur: v })}
          />
          <Slider label={tr('ad.saturation')} value={a.saturation} min={0} max={200} format={pct} onChange={(v) => set({ saturation: v })} />
          <ToggleRow
            label={tr('ad.grain')} hint={r.tier === 'saver' && a.grain ? tr('ad.grainOff') : tr('ad.grainHint')}
            checked={a.grain}
            onChange={(v) => set({ grain: v })}
          />
          <ToggleRow label={tr('ad.vignette')} hint={tr('ad.vignetteHint')} checked={a.vignette} onChange={(v) => set({ vignette: v })} />
          <ToggleRow
            label={tr('ad.freeze')} hint={tr('ad.freezeHint')}
            checked={a.pauseFreeze}
            onChange={(v) => set({ pauseFreeze: v })}
          />
          <Slider
            label={tr('ad.fade')}
            value={a.fade}
            min={0}
            max={3}
            step={0.1}
            format={(v) => (v === 0 ? tr('ad.instant') : `${formatNumber(v, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`)}
            onChange={(v) => set({ fade: v })}
          />
          <Field label={tr('ad.accentSource')} hint={tr('ad.accentSourceHint')}> <Segmented large label={tr('ad.accentSource')} value={a.accentSource} options={tOpts(ACCENT_SOURCES)} onChange={(v) => set({ accentSource: v })} />
          </Field>
          <Field label={tr('ad.scope')} hint={tr('ad.scopeHint')}> <Segmented large label={tr('ad.scope')} value={a.scope} options={tOpts(SCOPES)} onChange={(v) => set({ scope: v })} />
          </Field>
          {a.scope === 'everywhere' && (
            <Slider
              label={tr('ad.glass')}
              value={a.glass}
              min={0}
              max={100}
              format={pct}
              hint={tr('ad.glassHint')}
              onChange={(v) => set({ glass: v })}
            />
          )}
          <Field
            label={tr('ad.perf')} hint={
              a.performance === 'auto'
                ? tr('ad.perfAuto', { mode: r.tier === 'saver' ? tr('ad.perfSaverWhy', { reason: autoReason ?? '' }) : tr('ad.perfFull') }) : tr('ad.perfSaverHint')
            }
          >
            <Segmented large label={tr('ad.perf')} value={a.performance} options={tOpts(PERFORMANCE)} onChange={(v) => set({ performance: v })} />
          </Field>
          <button
            type="button"
            onClick={() => useSettings.getState().update({ adaptive: DEFAULT_ADAPTIVE })}
            className="inline-flex min-h-11 items-center gap-2 rounded-full bg-white/[0.08] px-4 text-sm font-semibold hover:bg-white/[0.14]"
          >
            <RotateCcw className="h-4 w-4" /> {tr('ad.reset')}
          </button>
        </div>
      )}
    </div>
  )
}
