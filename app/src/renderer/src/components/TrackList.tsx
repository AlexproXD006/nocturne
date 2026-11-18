import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, Clock3, Disc3, GripVertical, ListEnd, ListMinus, ListMusic, ListPlus, MoreHorizontal, Pause, Play, UserRound } from 'lucide-react'
import type { Track } from '../api/types'
import type { QueueContext } from '../player/queue'
import { playback } from '../services'
import { useNowContext, useNowPlaying, useNowTrack } from '../hooks/useNowPlaying'
import { useNav } from '../store/nav'
import { useUi } from '../store/ui'
import { artistNames, formatTime } from '../lib/format'
import { Artwork, LikeButton, cx } from './common'
import { Menu, useMenu } from './Menu'
import { usePlaylistsEnabled } from './Playlists'
import { usePlaylistUi } from '../store/playlists'
import { useT } from '../i18n'
import { FastScroll } from './FastScroll'
import { BulkBar, ListToolbar } from './TrackListTools'
import { ConfirmDialog } from './ConfirmDialog'
import { filterIndices, selectionClick, toggleAll, type SelectionState } from '../lib/bulk'
import { letterFor, sortText, type SortKey } from '../lib/fastScroll'

export function Equalizer({ paused }: { paused?: boolean }): ReactNode {
  return (
    <span className={cx('eq inline-flex h-3.5 items-end gap-[2px]', paused && 'paused')} aria-hidden>
      <span style={{ height: '100%' }} />
      <span style={{ height: '70%' }} />
      <span style={{ height: '85%' }} />
    </span>
  )
}

function ArtistLinks({ track }: { track: Track }): ReactNode {
  const go = useNav((s) => s.go)
  return (
    <>
      {track.artists.map((a, i) => (
        <span key={a.id}>
          {i > 0 && ', '}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              go({ name: 'artist', id: a.id })
            }}
            className="hover:text-fg hover:underline"
          >
            {a.name}
          </button>
        </span>
      ))}
    </>
  )
}

interface RowProps {
  track: Track
  index: number
  showArt: boolean
  showAlbum: boolean
  isCurrent: boolean
  isPlaying: boolean
  onPlay: (index: number) => void
  /** Editable playlist: adds "Remove from this playlist" to the row menu. */
  onRemove?: (index: number) => void
  /** Editable playlist (desktop): drag-and-drop reordering via a grip handle. */
  dnd?: { start: (index: number) => void; drop: (index: number) => void; end: () => void }
  /** Multi-select mode: rows show a checkbox and clicks toggle instead of playing. */
  selecting?: boolean
  selected?: boolean
  /** Click on a row while selecting (or with Ctrl/Cmd): toggles / extends the selection. */
  onSelect?: (index: number, shift: boolean) => void
  /** Long press on touch: enters selection mode with this row selected. */
  onLongPress?: (index: number) => void
}

const TrackRow = memo(function TrackRow({ track, index, showArt, showAlbum, isCurrent, isPlaying, onPlay, onRemove, dnd, selecting, selected, onSelect, onLongPress }: RowProps): ReactNode {
  const tr = useT()
  const { menu, open, close } = useMenu()
  const go = useNav((s) => s.go)
  const toast = useUi((s) => s.toast)
  const toggle = playback.toggle
  const playlists = usePlaylistsEnabled()
  // The row only becomes draggable while the mouse is down on the grip, so touch scrolling and
  // text selection elsewhere in the row behave normally.
  const [armed, setArmed] = useState(false)
  const [over, setOver] = useState(false)
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null)
  const touched = useRef(false)
  const swallowClick = useRef(false)
  const cancelPress = (): void => {
    if (press.current) clearTimeout(press.current.timer)
    press.current = null
  }

  const items = [
    { label: tr('tl.playNext'), icon: <ListPlus />, onSelect: () => (playback.addNext([track]), toast(tr('tl.willPlayNext', { title: track.title }))) },
    { label: tr('tl.addToQueue'), icon: <ListEnd />, onSelect: () => (playback.addToQueue([track]), toast(tr('tl.addedToQueue'))) },
    ...(playlists ? [{ label: tr('tl.addToPlaylist'), icon: <ListMusic />, onSelect: () => usePlaylistUi.getState().openPicker([track]) }] : []),
    ...(playlists && onRemove ? [{ label: tr('tl.removeFromPlaylist'), icon: <ListMinus />, onSelect: () => onRemove(index) }] : []),
    ...(track.album ? [{ label: tr('tl.goAlbum'), icon: <Disc3 />, onSelect: () => go({ name: 'album', id: track.album!.id }) }] : []),
    ...(track.artists[0] ? [{ label: tr('tl.goArtist'), icon: <UserRound />, onSelect: () => go({ name: 'artist', id: track.artists[0]!.id }) }] : [])
  ]

  const activate = (): void => (isCurrent ? toggle() : onPlay(index))
  const pick = (shift: boolean): void => onSelect?.(index, shift)
  const quickQueue = (): void => {
    const undo = playback.addToQueue([track])
    toast(tr('tl.addedToQueue'), 'info', undo ? { action: { label: tr('tl.undo'), run: undo } } : undefined)
  }

  return (
    <div
      role="row"
      tabIndex={0}
      aria-current={isCurrent || undefined}
      aria-selected={selecting ? Boolean(selected) : undefined}
      onPointerDown={
        onLongPress
          ? (e) => {
              touched.current = e.pointerType === 'touch'
              if (e.pointerType !== 'touch' || selecting) return
              cancelPress()
              press.current = {
                x: e.clientX,
                y: e.clientY,
                timer: setTimeout(() => {
                  press.current = null
                  swallowClick.current = true
                  onLongPress(index)
                }, 450)
              }
            }
          : undefined
      }
      onPointerMove={(e) => {
        if (press.current && Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > 8) cancelPress()
      }}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      draggable={dnd ? armed : undefined}
      onDragStart={
        dnd &&
        ((e) => {
          e.dataTransfer.effectAllowed = 'move'
          try {
            e.dataTransfer.setData('text/plain', track.title)
          } catch {
            /* some engines refuse setData; the drag still works */
          }
          dnd.start(index)
        })
      }
      onDragOver={
        dnd &&
        ((e) => {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          if (!over) setOver(true)
        })
      }
      onDragLeave={dnd && (() => setOver(false))}
      onDrop={
        dnd &&
        ((e) => {
          e.preventDefault()
          setOver(false)
          dnd.drop(index)
        })
      }
      onDragEnd={
        dnd &&
        (() => {
          setArmed(false)
          setOver(false)
          dnd.end()
        })
      }
      onDoubleClick={selecting ? undefined : activate}
      onClick={(e) => {
        if (swallowClick.current) {
          swallowClick.current = false
          return
        }
        if (onSelect && (selecting || e.ctrlKey || e.metaKey)) {
          pick(e.shiftKey)
          return
        }
        // Single tap plays on touch screens; desktop uses double-click like other players.
        if ((e.nativeEvent as PointerEvent).pointerType === 'touch') activate()
      }}
      onKeyDown={(e) => {
        if (selecting && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          pick(e.shiftKey)
        } else if (e.key === 'Enter') activate()
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        // A touch long press selects the row (see onLongPress); the "more" button still opens the menu.
        if (onLongPress && touched.current) return
        open(e.clientX, e.clientY)
      }}
      className={cx(
        'group grid h-14 cursor-default items-center gap-3 rounded-lg px-3 text-sm transition-colors duration-100',
        'grid-cols-[28px_minmax(0,1fr)_auto] md:grid-cols-[28px_minmax(0,1fr)_minmax(0,0.7fr)_auto]',
        !showAlbum && 'md:grid-cols-[28px_minmax(0,1fr)_auto]',
        'hover:bg-white/[0.05] focus-visible:bg-white/[0.05]',
        over && 'ring-1 ring-accent/60',
        selected && 'bg-accent/[0.12] hover:bg-accent/[0.16]'
      )}
    >
      <div className="relative flex w-7 items-center justify-center text-fg-muted tabular-nums">
        {selecting && (
          <span
            role="checkbox"
            aria-checked={Boolean(selected)}
            aria-label={tr('bk.row', { title: track.title })}
            className={cx(
              'absolute z-10 flex h-5 w-5 items-center justify-center rounded-md border',
              selected ? 'border-accent bg-accent text-ink-950' : 'border-white/35 bg-ink-900/80'
            )}
          >
            {selected && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
          </span>
        )}
        <span className={cx('group-hover:invisible', (isCurrent || selecting) && 'invisible')}>{index + 1}</span>
        {isCurrent && !isPlaying && <Equalizer paused />}
        {isCurrent && isPlaying && (
          <span className="absolute group-hover:invisible">
            <Equalizer />
          </span>
        )}
        <button
          type="button"
          tabIndex={selecting ? -1 : undefined}
          aria-label={isCurrent && isPlaying ? tr('tl.pauseTrack', { title: track.title }) : tr('tl.playTrack', { title: track.title })}
          onClick={(e) => {
            e.stopPropagation()
            activate()
          }}
          className={cx('absolute inset-0 hidden items-center justify-center text-fg', !selecting && 'group-hover:flex')}
        >
          {isCurrent && isPlaying ? <Pause className="h-4 w-4" fill="currentColor" /> : <Play className="h-4 w-4" fill="currentColor" />}
        </button>
      </div>

      <div className="flex min-w-0 items-center gap-3">
        {showArt && <Artwork images={track.artwork} size={40} className="h-10 w-10 shrink-0" rounded="rounded-md" />}
        <div className="min-w-0">
          <p className={cx('truncate font-medium', isCurrent ? 'text-accent' : 'text-fg')}>{track.title}</p>
          <p className="truncate text-[13px] text-fg-muted">
            {track.explicit && (
              <span className="mr-1.5 inline-flex h-4 items-center rounded-[3px] bg-white/15 px-1 text-[10px] font-bold text-fg/80">E</span>
            )}
            <ArtistLinks track={track} />
          </p>
        </div>
      </div>

      {showAlbum && (
        <div className="hidden min-w-0 md:block">
          {track.album && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                go({ name: 'album', id: track.album!.id })
              }}
              className="max-w-full truncate text-[13px] text-fg-muted hover:text-fg hover:underline"
            >
              {track.album.title}
            </button>
          )}
        </div>
      )}

      <div className="flex items-center gap-1">
        {dnd && (
          <span
            aria-hidden
            title={tr('tl.drag')}
            onPointerDown={(e) => e.pointerType === 'mouse' && setArmed(true)}
            onPointerUp={() => setArmed(false)}
            className="hidden h-8 w-6 cursor-grab items-center justify-center text-fg-subtle opacity-0 transition group-hover:opacity-100 active:cursor-grabbing md:flex"
          >
            <GripVertical className="h-4 w-4" />
          </span>
        )}
        <button
          type="button"
          aria-label={tr('tl.addTrackToQueue', { title: track.title })}
          title={tr('tl.addToQueue')}
          onClick={(e) => {
            e.stopPropagation()
            quickQueue()
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          className="flex h-8 w-8 items-center justify-center rounded-full text-fg-subtle opacity-0 transition hover:bg-white/8 hover:text-fg group-hover:opacity-100 focus:opacity-100 max-md:opacity-100"
        >
          <ListEnd className="h-4 w-4" />
        </button>
        <span className="opacity-0 transition group-hover:opacity-100 focus-within:opacity-100 max-md:opacity-100">
          <LikeButton trackId={track.id} serverValue={track.liked} />
        </span>
        <span className="hidden w-12 text-right text-[13px] text-fg-muted tabular-nums sm:inline">{formatTime(track.duration)}</span>
        <button
          type="button"
          aria-label={tr('tl.more', { title: track.title })}
          onClick={(e) => {
            e.stopPropagation()
            const r = e.currentTarget.getBoundingClientRect()
            open(r.left - 160, r.bottom + 4)
          }}
          className="flex h-8 w-8 items-center justify-center rounded-full text-fg-muted opacity-0 transition hover:bg-white/8 hover:text-fg group-hover:opacity-100 focus:opacity-100 max-md:opacity-100"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </div>
      {menu && <Menu x={menu.x} y={menu.y} items={items} onClose={close} />}
    </div>
  )
})

export function TrackList({
  tracks,
  context,
  showArt = true,
  showAlbum = true,
  header = true,
  onRemove,
  onMove,
  rowKeys,
  total,
  sortedBy,
  searchable = false,
  selectable,
  onRemoveMany
}: {
  tracks: Track[]
  context: QueueContext
  showArt?: boolean
  showAlbum?: boolean
  header?: boolean
  /** Editable playlist: remove the song at `index`. */
  onRemove?: (index: number) => void
  /** Editable playlist: move the song at `from` to `to` (desktop drag-and-drop). */
  onMove?: (from: number, to: number) => void
  /** Stable React keys per row (e.g. playlist entry ids, so the same song can appear twice). Default: id + index. */
  rowKeys?: readonly string[]
  /** Items on the server for paged lists (shown in the fast-scroll position bubble). */
  total?: number
  /** List is sorted by this field: the fast-scroll bubble shows the A–Z letter instead of the position. */
  sortedBy?: SortKey
  /** Shows a search field that filters the visible rows (accent/case-insensitive). */
  searchable?: boolean
  /** Multi-select + bulk actions bar. Default: on whenever the column header is shown. */
  selectable?: boolean
  /** Editable playlist: remove these rows (original-list items, in order). Resolves when done. */
  onRemoveMany?: (items: { index: number; track: Track }[]) => void | Promise<void>
}): ReactNode {
  const tr = useT()
  const rootRef = useRef<HTMLDivElement>(null)
  const currentId = useNowTrack()?.id
  const nowCtx = useNowContext()
  const sameContext = nowCtx?.type === context.type && nowCtx?.id === context.id
  const isPlaying = useNowPlaying()
  const canSelect = (selectable ?? header) && tracks.length > 1

  const [query, setQuery] = useState('')
  const [selecting, setSelecting] = useState(false)
  const [sel, setSel] = useState<SelectionState>({ selected: new Set(), anchor: null })
  const [confirmRemove, setConfirmRemove] = useState(false)
  const filtering = query.trim() !== ''

  // `view` = indices into `tracks` that are shown; everything below works on the shown rows.
  const view = useMemo(() => filterIndices(tracks, query), [tracks, query])
  const viewTracks = useMemo(() => (filtering ? view.map((i) => tracks[i]!) : tracks), [filtering, view, tracks])
  const keyAt = useCallback((i: number): string => rowKeys?.[i] ?? `${tracks[i]!.id}:${i}`, [rowKeys, tracks])
  const viewKeys = useMemo(() => view.map(keyAt), [view, keyAt])
  const letterAt = useMemo(
    () => (sortedBy ? (i: number) => letterFor(viewTracks[i] ? sortText(viewTracks[i]!, sortedBy) : '') : undefined),
    [sortedBy, viewTracks]
  )

  const selectedViewIdx = useMemo(() => viewKeys.flatMap((k, vi) => (sel.selected.has(k) ? [vi] : [])), [viewKeys, sel.selected])
  const selectedTracks = useMemo(() => selectedViewIdx.map((vi) => viewTracks[vi]!), [selectedViewIdx, viewTracks])

  const exitSelect = useCallback((): void => {
    setSelecting(false)
    setSel({ selected: new Set(), anchor: null })
  }, [])
  useEffect(() => {
    if (!selecting) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !confirmRemove) exitSelect()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selecting, exitSelect, confirmRemove])
  // The list changed under the selection (e.g. rows removed): drop the keys that no longer exist.
  useEffect(() => {
    if (!selecting) return
    const all = new Set(tracks.map((_, i) => keyAt(i)))
    setSel((s) => (s.selected.size === 0 || [...s.selected].every((k) => all.has(k)) ? s : { ...s, selected: new Set([...s.selected].filter((k) => all.has(k))) }))
  }, [tracks, keyAt, selecting])

  const viewKeysRef = useRef(viewKeys)
  viewKeysRef.current = viewKeys
  const onSelect = useCallback((vi: number, shift: boolean): void => {
    setSelecting(true)
    setSel((s) => selectionClick(s, viewKeysRef.current[vi]!, viewKeysRef.current, shift))
  }, [])
  const onLongPress = useCallback((vi: number): void => {
    setSelecting(true)
    setSel({ selected: new Set([viewKeysRef.current[vi]!]), anchor: viewKeysRef.current[vi]! })
    try {
      navigator.vibrate?.(15)
    } catch {
      /* haptics are best-effort */
    }
  }, [])

  const viewRef = useRef(view)
  viewRef.current = view
  const onPlay = useCallback(
    (index: number) => void playback.playTracks(viewTracks, index, context),
    [viewTracks, context]
  )
  const removeRef = useRef(onRemove)
  removeRef.current = onRemove
  const removeAt = useCallback((vi: number) => removeRef.current?.(viewRef.current[vi]!), [])

  const dragFrom = useRef<number | null>(null)
  const moveRef = useRef(onMove)
  moveRef.current = onMove
  const hasMove = Boolean(onMove) && !filtering && !selecting
  const [dnd] = useState(() => ({
    start: (i: number) => {
      dragFrom.current = i
    },
    drop: (to: number) => {
      const from = dragFrom.current
      dragFrom.current = null
      if (from !== null && from !== to) moveRef.current?.(from, to)
    },
    end: () => {
      dragFrom.current = null
    }
  }))

  return (
    <div ref={rootRef} role="table" aria-label={tr('tl.tracks')} className="-mx-3">
      {header && (searchable || canSelect) && (
        <ListToolbar
          searchable={searchable}
          selectable={canSelect}
          query={query}
          onQuery={setQuery}
          shown={view.length}
          total={tracks.length}
          selecting={selecting}
          onToggleSelect={() => (selecting ? exitSelect() : setSelecting(true))}
        />
      )}
      {header && (
        <div
          role="row"
          className={cx(
            'mb-1 grid h-9 items-center gap-3 border-b border-line px-3 text-xs font-medium tracking-wide text-fg-subtle uppercase',
            'grid-cols-[28px_minmax(0,1fr)_auto]',
            showAlbum ? 'md:grid-cols-[28px_minmax(0,1fr)_minmax(0,0.7fr)_auto]' : 'md:grid-cols-[28px_minmax(0,1fr)_auto]'
          )}
        >
          <span className="text-center">#</span>
          <span>{tr('tl.title')}</span>
          {showAlbum && <span className="hidden md:block">{tr('tl.album')}</span>}
          <span className="flex justify-end pr-10">
            <Clock3 className="hidden h-4 w-4 sm:block" aria-label={tr('tl.duration')} />
          </span>
        </div>
      )}
      {filtering && view.length === 0 && <p className="px-3 py-10 text-center text-sm text-fg-muted">{tr('ts.noMatches', { q: query.trim() })}</p>}
      {view.map((oi, vi) => {
        const t = tracks[oi]!
        return (
          <TrackRow
            key={viewKeys[vi]}
            track={t}
            index={vi}
            showArt={showArt}
            showAlbum={showAlbum}
            isCurrent={t.id === currentId && (sameContext || context.type === 'search' || context.type === 'home')}
            isPlaying={isPlaying}
            onPlay={onPlay}
            onRemove={onRemove ? removeAt : undefined}
            dnd={hasMove ? dnd : undefined}
            selecting={selecting}
            selected={selecting && sel.selected.has(viewKeys[vi]!)}
            onSelect={canSelect ? onSelect : undefined}
            onLongPress={canSelect ? onLongPress : undefined}
          />
        )
      })}
      <FastScroll anchorRef={rootRef} count={viewTracks.length} total={filtering ? undefined : total} letterAt={letterAt} />
      {selecting && (
        <BulkBar
          tracks={selectedTracks}
          allSelected={view.length > 0 && selectedViewIdx.length === view.length}
          onSelectAll={() => setSel((s) => toggleAll(s, viewKeys))}
          onClose={exitSelect}
          onRemove={onRemoveMany ? () => selectedTracks.length > 0 && setConfirmRemove(true) : undefined}
        />
      )}
      {confirmRemove && onRemoveMany && (
        <ConfirmDialog
          title={tr('bk.removeQ', { count: selectedViewIdx.length })}
          message={tr('bk.removeMsg')}
          confirmLabel={tr('common.delete')}
          tone="danger"
          onClose={() => setConfirmRemove(false)}
          onConfirm={async () => {
            await onRemoveMany(selectedViewIdx.map((vi) => ({ index: view[vi]!, track: viewTracks[vi]! })))
            exitSelect()
          }}
        />
      )}
    </div>
  )
}

export { artistNames }
