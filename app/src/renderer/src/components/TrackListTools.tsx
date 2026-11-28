import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDownToLine, CheckCheck, Heart, ListEnd, ListPlus, ListStart, Search, SquareCheckBig, Trash2, X } from 'lucide-react'
import type { Track } from '../api/types'
import { playback, sendLike } from '../services'
import { useLikes } from '../store/likes'
import { usePlaylistUi } from '../store/playlists'
import { useUi } from '../store/ui'
import { describeError } from '../api/errors'
import { mapLimit } from '../lib/bulk'
import { useT } from '../i18n'
import { formatNumber } from '../i18n/format'
import { usePlaylistsEnabled } from './Playlists'
import { cx } from './common'

const grouped = (n: number): string => formatNumber(n, { useGrouping: 'always' })

/** Sticky strip above a list: expandable search field (with "12 of 1,795") and the Select toggle. */
export function ListToolbar({
  searchable,
  selectable,
  query,
  onQuery,
  shown,
  total,
  selecting,
  onToggleSelect,
  offlineOnly,
  onToggleOffline
}: {
  searchable: boolean
  selectable: boolean
  query: string
  onQuery: (q: string) => void
  shown: number
  total: number
  selecting: boolean
  onToggleSelect: () => void
  /** "Available offline" filter chip (omitted when there is no handler). */
  offlineOnly?: boolean
  onToggleOffline?: () => void
}): ReactNode {
  const tr = useT()
  const [open, setOpen] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const expanded = open || query !== ''
  useEffect(() => {
    if (open) input.current?.focus()
  }, [open])
  return (
    <div className="sticky top-[calc(4rem+env(safe-area-inset-top))] z-10 -mt-1 mb-1 flex min-h-12 items-center gap-2 bg-ink-900/70 px-3 py-1 backdrop-blur-xl md:top-16">
      {searchable && (
        <div className={cx('flex h-10 min-w-0 items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-3', expanded ? 'flex-1 md:max-w-md' : '')}>
          <button type="button" aria-label={tr('ts.search')} onClick={() => setOpen(true)} className="shrink-0 text-fg-muted hover:text-fg">
            <Search className="h-4 w-4" />
          </button>
          {expanded && (
            <>
              <input
                ref={input}
                type="search"
                value={query}
                onChange={(e) => onQuery(e.target.value)}
                onBlur={() => setOpen(false)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    onQuery('')
                    setOpen(false)
                    e.currentTarget.blur()
                  }
                }}
                placeholder={tr('ts.placeholder')}
                aria-label={tr('ts.search')}
                className="min-w-0 flex-1 appearance-none bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle [&::-webkit-search-cancel-button]:hidden"
              />
              {query !== '' && (
                <>
                  <span className="shrink-0 text-xs text-fg-muted tabular-nums">{tr('ts.count', { shown: grouped(shown), total: grouped(total) })}</span>
                  <button type="button" aria-label={tr('ts.clear')} onMouseDown={(e) => e.preventDefault()} onClick={() => onQuery('')} className="shrink-0 text-fg-muted hover:text-fg">
                    <X className="h-4 w-4" />
                  </button>
                </>
              )}
            </>
          )}
        </div>
      )}
      {onToggleOffline && !expanded && (
        <button
          type="button"
          aria-pressed={offlineOnly}
          onClick={onToggleOffline}
          className={cx(
            'inline-flex h-10 shrink-0 items-center gap-2 rounded-full px-3.5 text-sm font-semibold transition active:scale-[0.97]',
            offlineOnly ? 'bg-accent text-ink-950' : 'bg-white/[0.08] text-fg hover:bg-white/[0.14]',
            !selectable && 'ml-auto'
          )}
        >
          <ArrowDownToLine className="h-4 w-4" />
          <span className="max-sm:hidden">{tr('offline.filter')}</span>
        </button>
      )}
      {selectable && (
        <button
          type="button"
          aria-pressed={selecting}
          onClick={onToggleSelect}
          className={cx(
            'ml-auto inline-flex h-10 shrink-0 items-center gap-2 rounded-full px-4 text-sm font-semibold transition active:scale-[0.97]',
            selecting ? 'bg-fg text-ink-950' : 'bg-white/[0.08] text-fg hover:bg-white/[0.14]'
          )}
        >
          <SquareCheckBig className="h-4 w-4" />
          <span className={cx(expanded && 'max-sm:hidden')}>{selecting ? tr('bk.done') : tr('bk.select')}</span>
        </button>
      )}
    </div>
  )
}

function BarButton({ label, onClick, children, danger, className }: { label: string; onClick: () => void; children: ReactNode; danger?: boolean; className?: string }): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cx(
        'flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition hover:bg-white/10 active:scale-95 lg:w-auto lg:gap-2 lg:px-3.5',
        danger ? 'text-red-300' : 'text-fg',
        className
      )}
    >
      {children}
      <span className="hidden text-sm font-medium lg:inline">{label}</span>
    </button>
  )
}

/** Floating glass action bar shown while rows are selected. */
export function BulkBar({
  tracks,
  allSelected,
  onSelectAll,
  onClose,
  onRemove
}: {
  tracks: Track[]
  allSelected: boolean
  onSelectAll: () => void
  onClose: () => void
  /** Only on playlists the user may edit. */
  onRemove?: () => void
}): ReactNode {
  const tr = useT()
  const playlists = usePlaylistsEnabled()
  const toast = useUi((s) => s.toast)
  const n = tracks.length
  const none = n === 0

  const like = async (): Promise<void> => {
    const todo = tracks.filter((t) => !useLikes.getState().isLiked(t.id, t.liked))
    if (todo.length === 0) return toast(tr('bk.allLiked'))
    try {
      await mapLimit(todo, 6, (t) => useLikes.getState().toggle(t.id, false, (id, l) => sendLike(id, l)).then(() => undefined))
      toast(tr('bk.liked', { count: todo.length }))
    } catch (err) {
      toast(describeError(err), 'error')
    }
  }
  const done = (fn: () => void) => () => {
    if (none) return
    fn()
    onClose()
  }

  if (typeof document === 'undefined') return null
  return createPortal(
    <div
      role="toolbar"
      aria-label={tr('bk.bar')}
      className="pointer-events-auto fixed inset-x-3 bottom-[calc(8.75rem+env(safe-area-inset-bottom))] z-40 mx-auto flex max-w-fit items-center gap-1 rounded-full border border-white/15 bg-[rgb(18_26_44_/_0.7)] py-1.5 pr-2 pl-4 shadow-2xl shadow-black/60 backdrop-blur-xl backdrop-saturate-150 md:bottom-28"
    >
      <span className="mr-1 text-sm font-semibold whitespace-nowrap text-[rgb(170_210_255)] tabular-nums">
        <span className="max-sm:hidden">{tr('bk.count', { count: n })}</span>
        <span className="sm:hidden" aria-label={tr('bk.count', { count: n })}>
          {grouped(n)}
        </span>
      </span>
      <BarButton label={allSelected ? tr('bk.selectNone') : tr('bk.selectAll')} onClick={onSelectAll}>
        <CheckCheck className="h-5 w-5" />
      </BarButton>
      {playlists && (
        <BarButton label={tr('bk.addToPlaylist')} onClick={done(() => usePlaylistUi.getState().openPicker(tracks))}>
          <ListPlus className="h-5 w-5" />
        </BarButton>
      )}
      <BarButton
        label={tr('bk.queue')}
        onClick={done(() => {
          playback.addToQueue(tracks)
          toast(tr('bk.queued', { count: n }))
        })}
      >
        <ListEnd className="h-5 w-5" />
      </BarButton>
      <BarButton
        label={tr('bk.next')}
        onClick={done(() => {
          playback.addNext(tracks)
          toast(tr('bk.willNext', { count: n }))
        })}
      >
        <ListStart className="h-5 w-5" />
      </BarButton>
      <BarButton label={tr('bk.like')} onClick={done(() => void like())}>
        <Heart className="h-5 w-5" />
      </BarButton>
      {onRemove && (
        <BarButton label={tr('bk.remove')} danger onClick={() => !none && onRemove()}>
          <Trash2 className="h-5 w-5" />
        </BarButton>
      )}
      <BarButton label={tr('bk.done')} onClick={onClose} className="max-sm:hidden">
        <X className="h-5 w-5" />
      </BarButton>
    </div>,
    document.body
  )
}
