import { useMemo, useState, type ReactNode } from 'react'
import { FileText, Loader2, Music, PencilLine, Play, Search, Trash2, X } from 'lucide-react'
import type { AdminTrack } from '../../api/types'
import { describeError } from '../../api/errors'
import { api, playback } from '../../services'
import { useUi } from '../../store/ui'
import { useNav } from '../../store/nav'
import { usePaged } from '../../hooks/usePaged'
import { resources } from '../../lib/resource'
import { artistNames, formatTime } from '../../lib/format'
import { Artwork, EmptyState, ErrorState, IconButton, Spinner } from '../../components/common'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { formatBytes, relativeTime } from './format'
import { LyricsEditDialog } from './LyricsEditDialog'
import type { EditFormat } from './lyrics/edit'
import { Card, Chip, inputClass, useDebounced, useTick } from './ui'
import { useT } from '../../i18n'
import { formatNumber } from '../../i18n/format'

function TrackRow({ t, now, onDelete, onEditLyrics }: { t: AdminTrack; now: number; onDelete: () => void; onEditLyrics: () => void }): ReactNode {
  const tr = useT()
  const play = (): void => void playback.playTracks([t], 0, { type: 'tracks', name: 'Admin library' })
  return (
    <li className="flex items-center gap-3 rounded-xl p-2 hover:bg-white/[0.04]">
      <button
        type="button"
        onClick={play}
        aria-label={tr('card.play', { title: t.title })}
        className="group relative h-11 w-11 shrink-0 overflow-hidden rounded-lg"
      >
        <Artwork images={t.artwork} size={44} className="h-11 w-11" />
        <span className="absolute inset-0 flex items-center justify-center bg-black/55 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          <Play className="h-4 w-4" fill="currentColor" />
        </span>
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-sm font-semibold" title={t.title}>{t.title}</p>
          {t.lyrics && <Chip tone="accent" className="!px-1.5 !py-px !text-[10px]"><span className="sr-only">{tr('albl.lyrics')} </span>{t.lyrics.toUpperCase()}</Chip>}
        </div>
        <p className="truncate text-[13px] text-fg-muted">
          {artistNames(t.artists) || tr('albl.unknownArtist')}
          {t.album ? ` · ${t.album.title}` : ''}
        </p>
        <p className="mt-0.5 text-xs text-fg-subtle tabular-nums md:hidden">
          {[t.format?.toUpperCase(), t.sizeBytes ? formatBytes(t.sizeBytes) : '', tr('albl.playsN', { count: t.playCount ?? 0 })].filter(Boolean).join(' · ')}
        </p>
      </div>
      <div className="hidden shrink-0 items-center gap-5 text-[13px] text-fg-muted tabular-nums md:flex">
        {t.format && <Chip>{t.format}</Chip>}
        <span className="w-10 text-right">{formatTime(t.duration)}</span>
        <span className="w-16 text-right">{t.sizeBytes ? formatBytes(t.sizeBytes) : '—'}</span>
        <span className="w-16 text-right" title={tr('albl.plays')}>{formatNumber(t.playCount ?? 0)} ▶</span>
        <span className="w-20 text-right">{relativeTime(t.addedAt, now) || '—'}</span>
      </div>
      <IconButton label={tr('albl.editLyrics', { title: t.title })} size="sm" onClick={onEditLyrics}>
        <PencilLine className="h-4 w-4" />
      </IconButton>
      <IconButton label={tr('albl.manageLyrics', { title: t.title })} size="sm" onClick={() => useNav.getState().go({ name: 'admin', tab: 'lyrics' })}>
        <FileText className="h-4 w-4" />
      </IconButton>
      <IconButton label={tr('albl.delete', { title: t.title })} size="sm" onClick={onDelete} className="hover:text-[#ff8f93]">
        <Trash2 className="h-4 w-4" />
      </IconButton>
    </li>
  )
}

export function LibraryTab(): ReactNode {
  const tr = useT()
  const [query, setQuery] = useState('')
  const q = useDebounced(query.trim(), 300)
  const paged = usePaged<AdminTrack>(`admin-tracks:${q}`, (offset, limit, signal) => api.adminTracks({ q: q || undefined, offset, limit, signal }), 50)
  const [removed, setRemoved] = useState<Set<string>>(() => new Set())
  const [pending, setPending] = useState<AdminTrack | null>(null)
  const [editLyrics, setEditLyrics] = useState<AdminTrack | null>(null)
  const [lyricsFormat, setLyricsFormat] = useState<Readonly<Record<string, EditFormat | null>>>({})
  const now = useTick()

  const items = useMemo(() => paged.items.filter((t) => !removed.has(t.id)), [paged.items, removed])
  const total = Math.max(0, paged.total - (paged.items.length - items.length))

  const remove = async (t: AdminTrack): Promise<void> => {
    setRemoved((s) => new Set(s).add(t.id))
    try {
      await api.adminDeleteTrack(t.id)
      resources.invalidate('')
      useUi.getState().toast(tr('albl.deleted', { title: t.title }))
    } catch (err) {
      setRemoved((s) => {
        const n = new Set(s)
        n.delete(t.id)
        return n
      })
      useUi.getState().toast(describeError(err), 'error')
    }
  }

  return (
    <Card id="library-title" title={tr('albl.title')} action={<span className="text-[13px] text-fg-muted tabular-nums">{paged.loading && items.length === 0 ? '' : tr('albl.trackCount', { count: total })}</span>}>
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute top-1/2 left-4 h-4 w-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
        <input
          type="search"
          role="searchbox"
          aria-label={tr('albl.searchLabel')}
          className={`${inputClass} pl-11`}
          placeholder={tr('albl.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        {query && (
          <button type="button" aria-label={tr('search.clear')} onClick={() => setQuery('')} className="absolute top-1/2 right-3 -translate-y-1/2 rounded-full p-1.5 text-fg-subtle hover:text-fg">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {paged.error && items.length === 0 ? (
        <ErrorState message={paged.error} onRetry={paged.reload} />
      ) : paged.loading && items.length === 0 ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : items.length === 0 ? (
        <EmptyState icon={<Music className="h-8 w-8" strokeWidth={1.5} />} title={q ? tr('albl.noMatch') : tr('albl.empty')} hint={q ? tr('albl.nothingMatched', { q }) : tr('albl.addFromTab')} />
      ) : (
        <>
          <ul>
            {items.map((t) => (
              <TrackRow key={t.id} t={t.id in lyricsFormat ? { ...t, lyrics: lyricsFormat[t.id] } : t} now={now} onDelete={() => setPending(t)} onEditLyrics={() => setEditLyrics(t)} />
            ))}
          </ul>
          <div ref={paged.sentinel} className="flex h-12 items-center justify-center" aria-hidden={!paged.loading}>
            {paged.loading && <Loader2 className="h-4 w-4 animate-spin text-fg-muted" />}
          </div>
          {paged.error && <ErrorState message={paged.error} onRetry={paged.loadMore} />}
        </>
      )}

      {editLyrics && (
        <LyricsEditDialog
          track={{ ...editLyrics, lyrics: editLyrics.id in lyricsFormat ? lyricsFormat[editLyrics.id] : editLyrics.lyrics }}
          onClose={() => setEditLyrics(null)}
          onChanged={(stored) => setLyricsFormat((m) => ({ ...m, [editLyrics.id]: stored }))}
        />
      )}

      {pending && (
        <ConfirmDialog
          title={tr('albl.deleteQ')}
          tone="danger"
          confirmLabel={tr('albl.deleteConfirm')}
          message={tr('albl.deleteMsg', { title: pending.title })}
          onConfirm={() => void remove(pending)}
          onClose={() => setPending(null)}
        />
      )}
    </Card>
  )
}
