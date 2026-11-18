import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Eye, FileText, Loader2, PencilLine, Play, Replace, Search, Trash2, Upload, X } from 'lucide-react'
import type { AdminTrack, LyricsFormat } from '../../api/types'
import { describeError } from '../../api/errors'
import { artistNames, formatTime } from '../../lib/format'
import { api, playback } from '../../services'
import { useUi } from '../../store/ui'
import { usePaged } from '../../hooks/usePaged'
import { Artwork, EmptyState, ErrorState, Spinner } from '../../components/common'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { BulkImport } from './lyrics/BulkImport'
import { LyricsEditDialog } from './LyricsEditDialog'
import { LYRICS_ACCEPT, removeLyrics, uploadLyricsFile } from './lyrics/files'
import { Button, Card, Chip, ProgressBar, inputClass, useDebounced } from './ui'
import { useT } from '../../i18n'
import { formatNumber } from '../../i18n/format'

type Filter = 'missing' | 'present'

function play(t: AdminTrack, name: string): void {
  void playback.playTracks([t], 0, { type: 'tracks', name })
}

function Row({ track, format, children }: { track: AdminTrack; format?: LyricsFormat | null; children: ReactNode }): ReactNode {
  const tr = useT()
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl p-2 hover:bg-white/[0.04]" data-testid="lyrics-row">
      <Artwork images={track.artwork} size={44} className="h-11 w-11 shrink-0" />
      <div className="min-w-0 flex-1 basis-40">
        <p className="truncate text-sm font-semibold" title={track.title}>{track.title}</p>
        <p className="truncate text-[13px] text-fg-muted">
          {artistNames(track.artists) || tr('ly.unknownArtist')}
          {track.album ? ` · ${track.album.title}` : ''}
        </p>
      </div>
      <span className="hidden w-10 shrink-0 text-right text-[13px] text-fg-muted tabular-nums sm:block">{formatTime(track.duration)}</span>
      {format && <Chip tone={format === 'ttml' ? 'accent' : 'neutral'}>{format}</Chip>}
      <div className="flex shrink-0 items-center gap-1.5">{children}</div>
    </li>
  )
}

function SearchBox({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }): ReactNode {
  const tr = useT()
  return (
    <div className="relative mb-3">
      <Search className="pointer-events-none absolute top-1/2 left-4 h-4 w-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
      <input
        type="search"
        role="searchbox"
        aria-label={label}
        className={`${inputClass} pl-11`}
        placeholder={tr('ly.searchPlaceholder')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      {value && (
        <button type="button" aria-label={tr('search.clear')} onClick={() => onChange('')} className="absolute top-1/2 right-3 -translate-y-1/2 rounded-full p-1.5 text-fg-subtle hover:text-fg">
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}

/** One hidden file input shared by every row of a list. */
function useLyricsPicker(onFile: (track: AdminTrack, file: File) => void): { open: (t: AdminTrack) => void; input: ReactNode } {
  const tr = useT()
  const ref = useRef<HTMLInputElement>(null)
  const target = useRef<AdminTrack | null>(null)
  const input = (
    <input
      ref={ref}
      type="file"
      accept={LYRICS_ACCEPT}
      aria-label={tr('ly.chooseFile')}
      className="sr-only"
      tabIndex={-1}
      data-testid="lyrics-file-input"
      onChange={(e) => {
        const file = e.currentTarget.files?.[0]
        const t = target.current
        e.currentTarget.value = ''
        if (file && t) onFile(t, file)
      }}
    />
  )
  return {
    open: (t) => {
      target.current = t
      ref.current?.click()
    },
    input
  }
}

function PagedList({
  filter,
  query,
  rev,
  removed,
  empty,
  renderRow
}: {
  filter: Filter
  query: string
  rev: number
  removed: ReadonlySet<string>
  empty: { title: string; hint: string }
  renderRow: (t: AdminTrack) => ReactNode
}): ReactNode {
  const tr = useT()
  const q = useDebounced(query.trim(), 300)
  const paged = usePaged<AdminTrack>(
    `admin-lyrics:${filter}:${q}:${rev}`,
    (offset, limit, signal) => api.adminTracks({ q: q || undefined, lyrics: filter, offset, limit, signal }),
    50
  )
  const items = useMemo(() => paged.items.filter((t) => !removed.has(t.id)), [paged.items, removed])

  if (paged.error && items.length === 0) return <ErrorState message={paged.error} onRetry={paged.reload} />
  if (paged.loading && items.length === 0) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    )
  }
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<FileText className="h-8 w-8" strokeWidth={1.5} />}
        title={q ? tr('ly.noMatch') : empty.title} hint={q ? tr('ly.nothingMatched', { q }) : empty.hint}
      />
    )
  }
  return (
    <>
      <ul>{items.map((t) => renderRow(t))}</ul>
      <div ref={paged.sentinel} className="flex h-10 items-center justify-center" aria-hidden={!paged.loading}>
        {paged.loading && <Loader2 className="h-4 w-4 animate-spin text-fg-muted" />}
      </div>
      {paged.error && <ErrorState message={paged.error} onRetry={paged.loadMore} />}
    </>
  )
}

function Coverage({ nonce }: { nonce: number }): ReactNode {
  const tr = useT()
  const [counts, setCounts] = useState<{ missing: number; present: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const ctrl = new AbortController()
    setError(null)
    Promise.all([
      api.adminTracks({ lyrics: 'missing', limit: 1, signal: ctrl.signal }),
      api.adminTracks({ lyrics: 'present', limit: 1, signal: ctrl.signal })
    ]).then(
      ([missing, present]) => setCounts({ missing: missing.total, present: present.total }),
      (err: unknown) => {
        if (!ctrl.signal.aborted) setError(describeError(err))
      }
    )
    return () => ctrl.abort()
  }, [nonce])

  if (error) return <p role="alert" className="text-sm text-[#ff9b9b]">{error}</p>
  if (!counts) return <div className="h-12" aria-busy="true" />
  const total = counts.missing + counts.present
  return (
    <div data-testid="lyrics-coverage">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm">
          <span className="text-2xl font-extrabold tabular-nums">{formatNumber(counts.present)}</span>{' '}
          <span className="text-fg-muted">{tr('ly.ofTotal', { total })}</span>
        </p>
        <p className="text-[13px] text-fg-muted tabular-nums">{tr('ly.missingCount', { count: counts.missing })}</p>
      </div>
      <ProgressBar value={total > 0 ? counts.present / total : 0} label={tr('ly.tracksWithLyrics')} tone="good" />
    </div>
  )
}

export function LyricsTab(): ReactNode {
  const tr = useT()
  // Bumped whenever lyrics change so counts and lists refetch.
  const [nonce, setNonce] = useState(0)
  const [missingRev, setMissingRev] = useState(0)
  const [presentRev, setPresentRev] = useState(0)
  const [handled, setHandled] = useState<ReadonlySet<string>>(() => new Set())
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set())
  const [formats, setFormats] = useState<Readonly<Record<string, LyricsFormat>>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [missingQuery, setMissingQuery] = useState('')
  const [presentQuery, setPresentQuery] = useState('')
  const [pendingRemove, setPendingRemove] = useState<AdminTrack | null>(null)
  const [editing, setEditing] = useState<AdminTrack | null>(null)

  const changed = useCallback((): void => setNonce((n) => n + 1), [])

  const uploadMissing = async (t: AdminTrack, file: File): Promise<void> => {
    setBusy(t.id)
    try {
      const format = await uploadLyricsFile(t.id, file)
      setHandled((s) => new Set(s).add(t.id))
      setRemoved((s) => {
        const n = new Set(s)
        n.delete(t.id)
        return n
      })
      setFormats((f) => ({ ...f, [t.id]: format }))
      setPresentRev((r) => r + 1)
      changed()
      useUi.getState().toast(tr('ly.savedFormat', { format: format.toUpperCase(), title: t.title }))
    } catch (err) {
      useUi.getState().toast(`${file.name}: ${describeError(err)}`, 'error')
    } finally {
      setBusy(null)
    }
  }

  const replacePresent = async (t: AdminTrack, file: File): Promise<void> => {
    setBusy(t.id)
    try {
      const format = await uploadLyricsFile(t.id, file)
      setFormats((f) => ({ ...f, [t.id]: format }))
      useUi.getState().toast(tr('ly.replaced', { title: t.title }))
    } catch (err) {
      useUi.getState().toast(`${file.name}: ${describeError(err)}`, 'error')
    } finally {
      setBusy(null)
    }
  }

  const remove = async (t: AdminTrack): Promise<void> => {
    await removeLyrics(t.id)
    setRemoved((s) => new Set(s).add(t.id))
    setHandled((s) => {
      const n = new Set(s)
      n.delete(t.id)
      return n
    })
    setMissingRev((r) => r + 1)
    changed()
    useUi.getState().toast(tr('ly.removed', { title: t.title }))
  }

  const preview = (t: AdminTrack): void => {
    play(t, tr('ly.preview'))
    const ui = useUi.getState()
    if (ui.panel !== 'lyrics') ui.togglePanel('lyrics')
  }

  const missingPicker = useLyricsPicker((t, f) => void uploadMissing(t, f))
  const presentPicker = useLyricsPicker((t, f) => void replacePresent(t, f))

  const onBulkSaved = (ids: string[]): void => {
    setHandled((s) => new Set([...s, ...ids]))
    setRemoved((s) => {
      const n = new Set(s)
      ids.forEach((id) => n.delete(id))
      return n
    })
    setPresentRev((r) => r + 1)
    changed()
  }

  return (
    <div className="space-y-5">
      <Card id="lyrics-coverage-title" title={tr('ly.coverageTitle')}>
        <Coverage nonce={nonce} />
        <p className="mt-3 text-[13px] text-fg-muted">
          {tr('ly.coverageNote')}
        </p>
      </Card>

      <Card id="lyrics-bulk-title" title={tr('ly.importTitle')}>
        <BulkImport onSaved={onBulkSaved} />
      </Card>

      <Card id="lyrics-missing-title" title={tr('ly.missingTitle')}>
        <SearchBox value={missingQuery} onChange={setMissingQuery} label={tr('ly.searchMissing')} />
        {missingPicker.input}
        <PagedList
          filter="missing"
          query={missingQuery}
          rev={missingRev}
          removed={handled}
          empty={{ title: tr('ly.allHave'), hint: tr('ly.allHaveHint') }}
          renderRow={(t) => (
            <Row key={t.id} track={t}>
              <Button size="sm" icon={<Upload />} busy={busy === t.id} onClick={() => missingPicker.open(t)} aria-label={tr('ly.uploadLabel', { title: t.title })}>
                {tr('ly.upload')}
              </Button>
              <Button size="sm" icon={<PencilLine />} onClick={() => setEditing(t)} aria-label={tr('ly.editLabel', { title: t.title })}>
                <span className="max-md:sr-only">{tr('ly.edit')}</span>
              </Button>
              <Button size="sm" variant="ghost" icon={<Play />} onClick={() => play(t, tr('ly.adminLyrics'))} aria-label={tr('ly.playLabel', { title: t.title })}>
                <span className="max-sm:sr-only">{tr('ly.play')}</span>
              </Button>
            </Row>
          )}
        />
      </Card>

      <Card id="lyrics-present-title" title={tr('ly.withTitle')}>
        <SearchBox value={presentQuery} onChange={setPresentQuery} label={tr('ly.searchWith')} />
        {presentPicker.input}
        <PagedList
          filter="present"
          query={presentQuery}
          rev={presentRev}
          removed={removed}
          empty={{ title: tr('ly.noneStored'), hint: tr('ly.noneStoredHint') }}
          renderRow={(t) => (
            <Row key={t.id} track={t} format={formats[t.id] ?? t.lyrics}>
              <Button size="sm" variant="ghost" icon={<Eye />} onClick={() => preview(t)} aria-label={tr('ly.previewLabel', { title: t.title })}>
                <span className="max-md:sr-only">{tr('ly.previewBtn')}</span>
              </Button>
              <Button size="sm" icon={<PencilLine />} onClick={() => setEditing(t)} aria-label={tr('ly.editLabel', { title: t.title })}>
                <span className="max-md:sr-only">{tr('ly.edit')}</span>
              </Button>
              <Button size="sm" icon={<Replace />} busy={busy === t.id} onClick={() => presentPicker.open(t)} aria-label={tr('ly.replaceLabel', { title: t.title })}>
                <span className="max-md:sr-only">{tr('ly.replace')}</span>
              </Button>
              <Button size="sm" variant="danger" icon={<Trash2 />} onClick={() => setPendingRemove(t)} aria-label={tr('ly.removeLabel', { title: t.title })}>
                <span className="max-md:sr-only">{tr('ly.remove')}</span>
              </Button>
            </Row>
          )}
        />
      </Card>

      {editing && (
        <LyricsEditDialog
          track={editing}
          onClose={() => setEditing(null)}
          onChanged={(stored) => {
            const id = editing.id
            if (stored) {
              setFormats((f) => ({ ...f, [id]: stored }))
              setHandled((s) => new Set(s).add(id))
              setRemoved((s) => {
                const n = new Set(s)
                n.delete(id)
                return n
              })
              setPresentRev((r) => r + 1)
            } else {
              setRemoved((s) => new Set(s).add(id))
              setHandled((s) => {
                const n = new Set(s)
                n.delete(id)
                return n
              })
              setMissingRev((r) => r + 1)
            }
            changed()
          }}
        />
      )}

      {pendingRemove && (
        <ConfirmDialog
          title={tr('ly.removeQ')}
          tone="danger"
          confirmLabel={tr('ly.removeConfirm')}
          message={tr('ly.removeMsg', { title: pendingRemove.title })}
          onConfirm={() => remove(pendingRemove)}
          onClose={() => setPendingRemove(null)}
        />
      )}
    </div>
  )
}
