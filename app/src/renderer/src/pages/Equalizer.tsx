import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { Copy, Loader2, Pencil, RotateCcw, Save, Trash2, Wand2 } from 'lucide-react'
import { Page } from './Page'
import { Toggle } from './SettingsControls'
import { EqCurve, formatDb } from '../components/EqCurve'
import { Modal } from '../components/Modal'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { cx } from '../components/common'
import { describeError } from '../api/errors'
import { useUi } from '../store/ui'
import { isPresetDirty, type EqStore } from '../store/eq'
import { platform, useEq } from '../services'
import {
  BUILTIN_PRESETS,
  clippingMarginDb,
  EQ_PREAMP_MAX,
  EQ_PREAMP_MIN,
  EQ_STEP,
  isClippingRisk,
  isCustomId,
  isFlat,
  type CustomPreset
} from '../lib/eq'
import { useT } from '../i18n'

const MAX_NAME = 40

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }): ReactNode {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cx(
        'eq-chip min-h-9 rounded-full px-3.5 text-sm font-medium transition-colors',
        active ? 'bg-fg text-ink-950' : 'bg-white/[0.07] text-fg-muted hover:bg-white/[0.12] hover:text-fg'
      )}
    >
      {children}
    </button>
  )
}

function NameDialog({
  title,
  initial,
  confirm,
  onSubmit,
  onClose
}: {
  title: string
  initial: string
  confirm: string
  onSubmit: (name: string) => Promise<void>
  onClose: () => void
}): ReactNode {
  const tr = useT()
  const id = useId()
  const [name, setName] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const clean = name.trim().replace(/\s+/g, ' ')
  const submit = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault()
    if (!clean || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(clean)
      onClose()
    } catch (err) {
      setError(describeError(err))
      setBusy(false)
    }
  }
  return (
    <Modal
      title={title}
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className="rounded-full px-4 py-2 text-sm font-semibold text-fg-muted hover:text-fg">
            {tr('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!clean || busy}
            className="inline-flex items-center gap-2 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-ink-950 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} {confirm}
          </button>
        </>
      }
    >
      <form onSubmit={(e) => void submit(e)}>
        <label htmlFor={id} className="mb-1.5 block text-sm font-medium">
          {tr('eq.presetName')}
        </label>
        <input
          id={id}
          data-autofocus
          value={name}
          maxLength={MAX_NAME}
          onChange={(e) => setName(e.currentTarget.value)}
          className="min-h-11 w-full rounded-xl border border-line bg-ink-800 px-3 text-[15px] outline-none focus:border-accent/70"
        />
        {error && (
          <p role="alert" className="mt-2 text-sm text-red-400">
            {error}
          </p>
        )}
      </form>
    </Modal>
  )
}

type Dialog = { kind: 'save' } | { kind: 'rename' | 'duplicate' | 'delete'; preset: CustomPreset } | null

export function EqualizerPage(): ReactNode {
  const tr = useT()
  const eq = useEq()
  const toast = useUi((s) => s.toast)
  const preampId = useId()
  const [dialog, setDialog] = useState<Dialog>(null)
  const [busy, setBusy] = useState(false)

  const selectedCustom = isCustomId(eq.presetId) ? eq.presets.find((p) => p.id === eq.presetId) : undefined
  const dirty = isPresetDirty(eq)
  const risk = isClippingRisk(eq.gains, eq.preamp)
  const margin = Math.max(0, Math.round(clippingMarginDb(eq.gains, eq.preamp) * 2) / 2)

  const run = async (fn: (s: EqStore) => Promise<unknown>, ok?: string): Promise<void> => {
    setBusy(true)
    try {
      await fn(useEq.getState())
      if (ok) toast(ok, 'info')
    } catch (err) {
      toast(describeError(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Page>
      <div className="max-w-3xl">
        <div className="mb-2 flex items-center justify-between gap-4">
          <h1 className="text-3xl font-extrabold tracking-tight">{tr('eq.title')}</h1>
          <div className="flex items-center gap-3">
            <span className="text-sm text-fg-muted" aria-hidden>
              {eq.enabled ? tr('eq.on') : tr('eq.off')}
            </span>
            <Toggle label={tr('eq.enabled')} checked={eq.enabled} onChange={eq.setEnabled} />
          </div>
        </div>
        <p className="mb-6 text-sm text-fg-muted">{tr('eq.intro')}</p>

        <section className="g-card eq-card mb-6 rounded-2xl bg-white/[0.035] p-4 sm:p-5 fade-up">
          <EqCurve gains={eq.gains} disabled={!eq.enabled} onChange={eq.setGain} />

          <div className={cx('mt-5 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-5', !eq.enabled && 'opacity-50')}>
            <div className="min-w-0 sm:w-44">
              <label htmlFor={preampId} className="block text-[15px] font-medium">
                {tr('eq.preamp')}
              </label>
              <p className="text-[12px] text-fg-muted">{tr('eq.preampHint')}</p>
            </div>
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <input
                id={preampId}
                type="range"
                className="range"
                min={EQ_PREAMP_MIN}
                max={EQ_PREAMP_MAX}
                step={EQ_STEP}
                value={eq.preamp}
                disabled={!eq.enabled}
                aria-valuetext={tr('eq.bandValue', { db: formatDb(eq.preamp) })}
                style={{ ['--fill' as string]: `${((eq.preamp - EQ_PREAMP_MIN) / (EQ_PREAMP_MAX - EQ_PREAMP_MIN)) * 100}%` }}
                onChange={(e) => eq.setPreamp(Number(e.currentTarget.value))}
              />
              <span className="w-16 shrink-0 text-right text-sm text-fg-muted tabular-nums">{tr('eq.bandValue', { db: formatDb(eq.preamp) })}</span>
              <button
                type="button"
                onClick={eq.autoPreamp}
                disabled={!eq.enabled}
                aria-pressed={eq.autoHeadroom}
                title={eq.autoHeadroom ? tr('eq.autoOn') : tr('eq.autoOff')}
                className={cx(
                  'inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm font-medium',
                  eq.autoHeadroom ? 'bg-accent text-ink-950' : 'bg-white/[0.08] hover:bg-white/[0.14]'
                )}
              >
                <Wand2 className="h-3.5 w-3.5" /> {tr('eq.auto')}
              </button>
            </div>
          </div>
          {risk && eq.enabled && (
            <p role="alert" className="eq-warn mt-3 rounded-lg bg-amber-400/10 px-3 py-2 text-sm text-amber-300">
              {tr('eq.clipping', { db: margin.toFixed(1) })}
            </p>
          )}
          {eq.unsynced && eq.synced === false && <p className="mt-3 text-xs text-fg-muted">{tr('eq.offline')}</p>}
        </section>

        <section className="g-card mb-6 rounded-2xl bg-white/[0.035] p-4 sm:p-5 fade-up">
          <h2 className="mb-3 text-lg font-bold tracking-tight">{tr('eq.presets')}</h2>
          <div role="radiogroup" aria-label={tr('eq.presets')} className="flex flex-wrap gap-2">
            {BUILTIN_PRESETS.map((p) => (
              <Chip key={p.id} active={eq.presetId === p.id} onClick={() => eq.selectBuiltin(p.id)}>
                {tr(p.labelKey)}
              </Chip>
            ))}
            {eq.presetId === null && !isFlat(eq.gains) && (
              <Chip active onClick={() => undefined}>
                {tr('eq.customCurve')}
              </Chip>
            )}
          </div>

          <h2 className="mt-6 mb-3 text-lg font-bold tracking-tight">{tr('eq.myPresets')}</h2>
          {eq.presets.length === 0 ? (
            <p className="mb-3 text-sm text-fg-muted">{tr('eq.noCustom')}</p>
          ) : (
            <div role="radiogroup" aria-label={tr('eq.myPresets')} className="mb-3 flex flex-wrap gap-2">
              {eq.presets.map((p) => (
                <Chip key={p.id} active={eq.presetId === p.id} onClick={() => eq.selectCustom(p.id)}>
                  {p.name}
                  {eq.presetId === p.id && dirty ? ` (${tr('eq.modified')})` : ''}
                </Chip>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => setDialog({ kind: 'save' })} className="eq-act inline-flex min-h-9 items-center gap-1.5 rounded-full bg-white/[0.08] px-3.5 text-sm font-medium hover:bg-white/[0.14] disabled:opacity-50">
              <Save className="h-4 w-4" /> {tr('eq.saveAs')}
            </button>
            {selectedCustom && dirty && (
              <button type="button" disabled={busy} onClick={() => void run((s) => s.updatePreset(selectedCustom.id), tr('eq.saved'))} className="eq-act inline-flex min-h-9 items-center gap-1.5 rounded-full bg-accent px-3.5 text-sm font-semibold text-ink-950 disabled:opacity-50">
                <Save className="h-4 w-4" /> {tr('eq.saveChanges')}
              </button>
            )}
            {selectedCustom && (
              <>
                <button type="button" disabled={busy} onClick={() => setDialog({ kind: 'rename', preset: selectedCustom })} className="eq-act inline-flex min-h-9 items-center gap-1.5 rounded-full bg-white/[0.08] px-3.5 text-sm font-medium hover:bg-white/[0.14] disabled:opacity-50">
                  <Pencil className="h-4 w-4" /> {tr('eq.rename')}
                </button>
                <button type="button" disabled={busy} onClick={() => setDialog({ kind: 'duplicate', preset: selectedCustom })} className="eq-act inline-flex min-h-9 items-center gap-1.5 rounded-full bg-white/[0.08] px-3.5 text-sm font-medium hover:bg-white/[0.14] disabled:opacity-50">
                  <Copy className="h-4 w-4" /> {tr('eq.duplicate')}
                </button>
                <button type="button" disabled={busy} onClick={() => setDialog({ kind: 'delete', preset: selectedCustom })} className="eq-act inline-flex min-h-9 items-center gap-1.5 rounded-full bg-white/[0.08] px-3.5 text-sm font-medium text-red-300 hover:bg-red-400/15 disabled:opacity-50">
                  <Trash2 className="h-4 w-4" /> {tr('eq.delete')}
                </button>
              </>
            )}
            <button type="button" onClick={() => eq.selectBuiltin('flat')} className="eq-act inline-flex min-h-9 items-center gap-1.5 rounded-full px-3.5 text-sm font-medium text-fg-muted hover:text-fg">
              <RotateCcw className="h-4 w-4" /> {tr('eq.reset')}
            </button>
          </div>
          {platform.kind === 'android' && <p className="mt-4 text-xs text-fg-muted">{tr('eq.android')}</p>}
        </section>
      </div>

      {dialog?.kind === 'save' && (
        <NameDialog
          title={tr('eq.saveTitle')}
          initial={tr('eq.defaultName', { n: eq.presets.length + 1 })}
          confirm={tr('common.save')}
          onSubmit={async (name) => {
            await useEq.getState().createPreset(name)
            toast(tr('eq.saved'), 'info')
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'rename' && (
        <NameDialog
          title={tr('eq.renameTitle')}
          initial={dialog.preset.name}
          confirm={tr('common.save')}
          onSubmit={(name) => useEq.getState().renamePreset(dialog.preset.id, name)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'duplicate' && (
        <NameDialog
          title={tr('eq.duplicate')}
          initial={tr('eq.copyName', { name: dialog.preset.name }).slice(0, MAX_NAME)}
          confirm={tr('eq.duplicate')}
          onSubmit={async (name) => void (await useEq.getState().duplicatePreset(dialog.preset.id, name))}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title={tr('eq.deleteTitle', { name: dialog.preset.name })}
          message={tr('eq.deleteBody')}
          confirmLabel={tr('eq.delete')}
          tone="danger"
          onConfirm={() => useEq.getState().deletePreset(dialog.preset.id)}
          onClose={() => setDialog(null)}
        />
      )}
    </Page>
  )
}
