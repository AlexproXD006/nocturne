import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowLeft, ListPlus, Plus, Search } from 'lucide-react'
import { api, useSession } from '../services'
import { describeError } from '../api/errors'
import { PLAYLIST_DESCRIPTION_MAX, PLAYLIST_NAME_MAX, type Playlist, type Track } from '../api/types'
import { useResource } from '../hooks/useResource'
import { useNav } from '../store/nav'
import { useUi } from '../store/ui'
import { EDITABLE_PLAYLISTS_KEY, addTracks, createPlaylist, fetchEditablePlaylists, usePlaylistUi, type AddOutcome } from '../store/playlists'
import { plural } from '../lib/format'
import { Button, Field, InlineError, inputClass } from '../pages/admin/ui'
import { Artwork, IconButton, Spinner, cx } from './common'
import { Modal } from './Modal'
import { t, useT } from '../i18n'

/** True when the connected server supports creating / editing playlists. Hide all editing UI otherwise. */
export function usePlaylistsEnabled(): boolean {
  return useSession((s) => s.server?.capabilities?.playlists === true)
}

// ---- Name / description form ------------------------------------------------------

export interface PlaylistValues {
  name: string
  description: string
}

function validate(v: PlaylistValues): string | null {
  const name = v.name.trim()
  if (!name) return t('plui.nameRequired')
  if (name.length > PLAYLIST_NAME_MAX) return t('plui.nameMax', { max: PLAYLIST_NAME_MAX })
  if (v.description.trim().length > PLAYLIST_DESCRIPTION_MAX) return t('plui.descMax', { max: PLAYLIST_DESCRIPTION_MAX })
  return null
}

/** Name + description inputs. Submitting the surrounding form (id `formId`) calls `onSubmit`. */
function PlaylistFields({
  formId,
  values,
  onChange,
  onSubmit,
  error,
  busy
}: {
  formId: string
  values: PlaylistValues
  onChange: (v: PlaylistValues) => void
  onSubmit: () => void
  error: string | null
  busy: boolean
}): ReactNode {
  const tr = useT()
  const ids = useId()
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    nameRef.current?.focus()
  }, [])
  const descLeft = PLAYLIST_DESCRIPTION_MAX - values.description.length
  return (
    <form
      id={formId}
      noValidate
      className="space-y-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault()
        onSubmit()
      }}
    >
      <Field label={tr('plui.name')} htmlFor={`${ids}-name`}>
        <input
          id={`${ids}-name`}
          ref={nameRef}
          data-autofocus
          className={inputClass}
          value={values.name}
          maxLength={PLAYLIST_NAME_MAX}
          required
          aria-required="true"
          disabled={busy}
          autoComplete="off"
          placeholder={tr('plui.namePlaceholder')}
          onChange={(e) => onChange({ ...values, name: e.target.value })}
        />
      </Field>
      <Field
        label={tr('plui.desc')}
        htmlFor={`${ids}-desc`}
        hint={descLeft <= 50 ? <span className={descLeft < 0 ? 'text-[#ff9b9b]' : undefined}>{tr('plui.charsLeft', { count: descLeft })}</span> : undefined}
      >
        <textarea
          id={`${ids}-desc`}
          className={cx(inputClass, 'min-h-20 resize-none')}
          rows={3}
          value={values.description}
          maxLength={PLAYLIST_DESCRIPTION_MAX}
          disabled={busy}
          placeholder={tr('plui.descPlaceholder')}
          onChange={(e) => onChange({ ...values, description: e.target.value })}
        />
      </Field>
      <InlineError message={error} />
    </form>
  )
}

/** Hook holding the form state + submit flow shared by every name/description dialog. */
function usePlaylistForm(initial: PlaylistValues, submit: (v: PlaylistValues) => Promise<void>) {
  const [values, setValues] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (): Promise<void> => {
    if (busy) return
    const invalid = validate(values)
    if (invalid) {
      setError(invalid)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await submit({ name: values.name.trim(), description: values.description.trim() })
    } catch (err) {
      setError(describeError(err))
      setBusy(false)
    }
  }
  return { values, setValues, busy, error, run, valid: values.name.trim().length > 0 }
}

/** Generic "name + description" dialog (create / edit details). Closes itself after `onSubmit` resolves. */
export function PlaylistFormDialog({
  title,
  submitLabel,
  initial = { name: '', description: '' },
  onSubmit,
  onClose
}: {
  title: string
  submitLabel: string
  initial?: PlaylistValues
  onSubmit: (v: PlaylistValues) => Promise<void>
  onClose: () => void
}): ReactNode {
  const tr = useT()
  const formId = useId()
  const form = usePlaylistForm(initial, async (v) => {
    await onSubmit(v)
    onClose()
  })
  return (
    <Modal
      title={title}
      size="md"
      dismissible={!form.busy}
      onClose={onClose}
      footer={
        <>
          <Button disabled={form.busy} onClick={onClose}>
            {tr('common.cancel')}
          </Button>
          <Button type="submit" form={formId} variant="primary" busy={form.busy} disabled={!form.valid}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <PlaylistFields formId={formId} values={form.values} onChange={form.setValues} onSubmit={() => void form.run()} error={form.error} busy={form.busy} />
    </Modal>
  )
}

/** "New playlist" dialog used by the Library: creates the playlist and opens it. */
export function CreatePlaylistDialog({ onClose }: { onClose: () => void }): ReactNode {
  const tr = useT()
  const go = useNav((s) => s.go)
  return (
    <PlaylistFormDialog
      title={tr('plui.new')}
      submitLabel={tr('plui.create')}
      onClose={onClose}
      onSubmit={async (v) => {
        const created = await createPlaylist(api, v)
        useUi.getState().toast(tr('plui.created', { name: created.name || v.name }))
        if (created?.id) go({ name: 'playlist', id: created.id })
      }}
    />
  )
}

/** Library grid tile that opens the create dialog. Sized like a MediaCard. */
export function NewPlaylistTile({ onClick }: { onClick: () => void }): ReactNode {
  const tr = useT()
  return (
    <button
      type="button"
      onClick={onClick}
      className="group w-full rounded-[var(--radius-card)] p-2.5 text-left transition-colors duration-200 hover:bg-white/[0.045] focus-visible:bg-white/[0.045]"
    >
      <span className="mb-3 flex aspect-square w-full items-center justify-center rounded-lg border-2 border-dashed border-line bg-white/[0.03] text-fg-muted transition-colors group-hover:border-accent/60 group-hover:text-accent">
        <Plus className="h-10 w-10" strokeWidth={1.6} aria-hidden />
      </span>
      <span className="block truncate text-[15px] font-semibold">{tr('plui.new')}</span>
      <span className="mt-0.5 block truncate text-[13px] text-fg-muted">{tr('plui.createOwn')}</span>
    </button>
  )
}

// ---- Add to playlist ----------------------------------------------------------

/**
 * Shows the toast for an add. When the server skipped songs that were already in the playlist, the
 * toast offers "Add again" ("Add them again" for several), which appends those songs once more.
 */
export function notifyAdd(playlist: Pick<Playlist, 'id' | 'name'>, out: AddOutcome): void {
  const { toast } = useUi.getState()
  const again = out.skippedIds
  if (again.length === 0) {
    toast(out.message)
    return
  }
  toast(out.message, 'info', {
    action: {
      label: again.length === 1 ? t('plui.addAgain') : t('plui.addThemAgain'),
      run: () => void addAgain({ id: playlist.id, name: out.name || playlist.name }, again)
    }
  })
}

async function addAgain(playlist: Pick<Playlist, 'id' | 'name'>, ids: string[]): Promise<void> {
  const { toast } = useUi.getState()
  try {
    const res = await addTracks(
      api,
      playlist,
      ids.map((id) => ({ id })),
      undefined,
      { allowDuplicates: true }
    )
    // A server without duplicate support ignores the flag and skips them again.
    if (res.added === 0 && res.skipped > 0) toast(t('plui.noDuplicates', { message: res.message }), 'error')
    else toast(res.message)
  } catch (err) {
    toast(describeError(err), 'error')
  }
}

/** Button that opens the picker for the given songs; renders nothing on servers without playlist editing. */
export function AddToPlaylistButton({
  tracks,
  label,
  size = 'sm',
  className
}: {
  tracks: Track[]
  label?: string
  size?: 'sm' | 'md' | 'lg'
  className?: string
}): ReactNode {
  const tr = useT()
  const enabled = usePlaylistsEnabled()
  const open = usePlaylistUi((s) => s.openPicker)
  if (!enabled) return null
  return (
    <IconButton label={tr('plui.addTo')} size={size} disabled={tracks.length === 0} onClick={() => open(tracks, label)} className={className}>
      <ListPlus className={size === 'sm' ? 'h-4 w-4' : 'h-5 w-5'} />
    </IconButton>
  )
}

function matches(p: Playlist, q: string): boolean {
  const needle = q.trim().toLocaleLowerCase()
  if (!needle) return true
  return `${p.name} ${p.description ?? ''}`.toLocaleLowerCase().includes(needle)
}

/** The picker dialog: search the user's editable playlists, or create a new one with the songs in it. */
export function AddToPlaylistDialog({ tracks, label, onClose }: { tracks: Track[]; label: string; onClose: () => void }): ReactNode {
  const tr = useT()
  const list = useResource<Playlist[]>(EDITABLE_PLAYLISTS_KEY, (signal) => fetchEditablePlaylists(api, signal))
  const [step, setStep] = useState<'pick' | 'create'>('pick')
  const [query, setQuery] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const formId = useId()
  const searchId = useId()
  const toast = useUi((s) => s.toast)
  const playlists = useMemo(() => (list.data ?? []).filter((p) => matches(p, query)), [list.data, query])

  const form = usePlaylistForm({ name: '', description: '' }, async (v) => {
    const created = await createPlaylist(api, { ...v, tracks })
    toast(t('pl.addedTo', { name: created.name || v.name }))
    onClose()
  })

  const pick = async (p: Playlist): Promise<void> => {
    if (busyId) return
    setBusyId(p.id)
    setError(null)
    try {
      const res = await addTracks(api, p, tracks)
      notifyAdd(p, res)
      onClose()
    } catch (err) {
      setError(describeError(err))
      setBusyId(null)
    }
  }

  if (step === 'create') {
    return (
      <Modal
        title={tr('plui.new')}
        description={<span className="block truncate">{tr('plui.with', { label })}</span>}
        size="md"
        dismissible={!form.busy}
        onClose={onClose}
        footer={
          <>
            <Button disabled={form.busy} onClick={() => setStep('pick')} icon={<ArrowLeft />}>
              {tr('plui.back')}
            </Button>
            <Button type="submit" form={formId} variant="primary" busy={form.busy} disabled={!form.valid}>
              {tr('plui.createAndAdd')}
            </Button>
          </>
        }
      >
        <PlaylistFields formId={formId} values={form.values} onChange={form.setValues} onSubmit={() => void form.run()} error={form.error} busy={form.busy} />
      </Modal>
    )
  }

  const busy = busyId !== null
  return (
    <Modal title={tr('plui.addTo')} description={<span className="block truncate">{label}</span>} size="md" dismissible={!busy} onClose={onClose}>
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
        <label htmlFor={searchId} className="sr-only">
          {tr('plui.search')}
        </label>
        <input
          id={searchId}
          type="search"
          data-autofocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tr('plui.search')}
          autoComplete="off"
          className={cx(inputClass, 'pl-10')}
        />
      </div>
      <InlineError message={error} />
      <ul className="-mx-2 pb-2" aria-label={tr('plui.yours')} aria-busy={busy || list.loading || undefined}>
        <li>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (query.trim() && !form.values.name) form.setValues({ name: query.trim().slice(0, PLAYLIST_NAME_MAX), description: '' })
              setStep('create')
            }}
            className="flex min-h-14 w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-white/[0.06] focus-visible:bg-white/[0.06] disabled:opacity-50"
          >
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-white/[0.08] text-fg">
              <Plus className="h-5 w-5" aria-hidden />
            </span>
            <span className="min-w-0 truncate text-sm font-semibold">{tr('plui.newEllipsis')}</span>
          </button>
        </li>
        {list.loading && (
          <li className="flex justify-center py-6">
            <Spinner />
          </li>
        )}
        {list.error && !list.data && (
          <li className="px-2 py-4 text-sm text-fg-muted">
            {list.error}{' '}
            <button type="button" onClick={list.reload} className="font-semibold text-fg underline-offset-2 hover:underline">
              {tr('common.retry')}
            </button>
          </li>
        )}
        {list.data && list.data.length === 0 && <li className="px-2 py-4 text-sm text-fg-muted">{tr('plui.none')}</li>}
        {list.data && list.data.length > 0 && playlists.length === 0 && <li className="px-2 py-4 text-sm text-fg-muted">{tr('plui.noMatch', { query: query.trim() })}</li>}
        {playlists.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              disabled={busy}
              onClick={() => void pick(p)}
              className="flex min-h-14 w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-white/[0.06] focus-visible:bg-white/[0.06] disabled:opacity-50"
            >
              <Artwork images={p.artwork} size={44} className="h-11 w-11 shrink-0" rounded="rounded-md" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{p.name}</span>
                {typeof p.trackCount === 'number' && <span className="block truncate text-xs text-fg-muted">{plural(p.trackCount)}</span>}
              </span>
              {busyId === p.id && <Spinner className="h-4 w-4 shrink-0" />}
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  )
}

/** Renders the global picker when some view asked for it (see `usePlaylistUi.openPicker`). */
export function PlaylistPickerHost(): ReactNode {
  const picker = usePlaylistUi((s) => s.picker)
  const close = usePlaylistUi((s) => s.closePicker)
  const enabled = usePlaylistsEnabled()
  if (!picker || !enabled) return null
  return <AddToPlaylistDialog tracks={picker.tracks} label={picker.label} onClose={close} />
}
