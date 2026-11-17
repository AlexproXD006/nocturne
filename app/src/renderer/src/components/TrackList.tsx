import { memo, useCallback, useRef, useState, type ReactNode } from 'react'
import { Clock3, Disc3, GripVertical, ListEnd, ListMinus, ListMusic, ListPlus, MoreHorizontal, Pause, Play, UserRound } from 'lucide-react'
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
}

const TrackRow = memo(function TrackRow({ track, index, showArt, showAlbum, isCurrent, isPlaying, onPlay, onRemove, dnd }: RowProps): ReactNode {
  const { menu, open, close } = useMenu()
  const go = useNav((s) => s.go)
  const toast = useUi((s) => s.toast)
  const toggle = playback.toggle
  const playlists = usePlaylistsEnabled()
  // The row only becomes draggable while the mouse is down on the grip, so touch scrolling and
  // text selection elsewhere in the row behave normally.
  const [armed, setArmed] = useState(false)
  const [over, setOver] = useState(false)

  const items = [
    { label: 'Play next', icon: <ListPlus />, onSelect: () => (playback.addNext([track]), toast(`“${track.title}” will play next`)) },
    { label: 'Add to queue', icon: <ListEnd />, onSelect: () => (playback.addToQueue([track]), toast('Added to queue')) },
    ...(playlists ? [{ label: 'Add to playlist…', icon: <ListMusic />, onSelect: () => usePlaylistUi.getState().openPicker([track]) }] : []),
    ...(playlists && onRemove ? [{ label: 'Remove from this playlist', icon: <ListMinus />, onSelect: () => onRemove(index) }] : []),
    ...(track.album ? [{ label: 'Go to album', icon: <Disc3 />, onSelect: () => go({ name: 'album', id: track.album!.id }) }] : []),
    ...(track.artists[0] ? [{ label: 'Go to artist', icon: <UserRound />, onSelect: () => go({ name: 'artist', id: track.artists[0]!.id }) }] : [])
  ]

  const activate = (): void => (isCurrent ? toggle() : onPlay(index))
  const quickQueue = (): void => {
    const undo = playback.addToQueue([track])
    toast('Added to queue', 'info', undo ? { action: { label: 'Undo', run: undo } } : undefined)
  }

  return (
    <div
      role="row"
      tabIndex={0}
      aria-current={isCurrent || undefined}
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
      onDoubleClick={activate}
      onClick={(e) => {
        // Single tap plays on touch screens; desktop uses double-click like other players.
        if ((e.nativeEvent as PointerEvent).pointerType === 'touch') activate()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') activate()
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        open(e.clientX, e.clientY)
      }}
      className={cx(
        'group grid h-14 cursor-default items-center gap-3 rounded-lg px-3 text-sm transition-colors duration-100',
        'grid-cols-[28px_minmax(0,1fr)_auto] md:grid-cols-[28px_minmax(0,1fr)_minmax(0,0.7fr)_auto]',
        !showAlbum && 'md:grid-cols-[28px_minmax(0,1fr)_auto]',
        'hover:bg-white/[0.05] focus-visible:bg-white/[0.05]',
        over && 'ring-1 ring-accent/60'
      )}
    >
      <div className="relative flex w-7 items-center justify-center text-fg-muted tabular-nums">
        <span className={cx('group-hover:invisible', isCurrent && 'invisible')}>{index + 1}</span>
        {isCurrent && !isPlaying && <Equalizer paused />}
        {isCurrent && isPlaying && (
          <span className="absolute group-hover:invisible">
            <Equalizer />
          </span>
        )}
        <button
          type="button"
          aria-label={isCurrent && isPlaying ? `Pause ${track.title}` : `Play ${track.title}`}
          onClick={(e) => {
            e.stopPropagation()
            activate()
          }}
          className="absolute inset-0 hidden items-center justify-center text-fg group-hover:flex"
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
            title="Drag to reorder"
            onPointerDown={(e) => e.pointerType === 'mouse' && setArmed(true)}
            onPointerUp={() => setArmed(false)}
            className="hidden h-8 w-6 cursor-grab items-center justify-center text-fg-subtle opacity-0 transition group-hover:opacity-100 active:cursor-grabbing md:flex"
          >
            <GripVertical className="h-4 w-4" />
          </span>
        )}
        <button
          type="button"
          aria-label={`Add ${track.title} to queue`}
          title="Add to queue"
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
          aria-label={`More options for ${track.title}`}
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
  rowKeys
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
}): ReactNode {
  const currentId = useNowTrack()?.id
  const nowCtx = useNowContext()
  const sameContext = nowCtx?.type === context.type && nowCtx?.id === context.id
  const isPlaying = useNowPlaying()

  const onPlay = useCallback(
    (index: number) => void playback.playTracks(tracks, index, context),
    [tracks, context]
  )

  const dragFrom = useRef<number | null>(null)
  const moveRef = useRef(onMove)
  moveRef.current = onMove
  const hasMove = Boolean(onMove)
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
    <div role="table" aria-label="Tracks" className="-mx-3">
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
          <span>Title</span>
          {showAlbum && <span className="hidden md:block">Album</span>}
          <span className="flex justify-end pr-10">
            <Clock3 className="hidden h-4 w-4 sm:block" aria-label="Duration" />
          </span>
        </div>
      )}
      {tracks.map((t, i) => (
        <TrackRow
          key={rowKeys?.[i] ?? `${t.id}:${i}`}
          track={t}
          index={i}
          showArt={showArt}
          showAlbum={showAlbum}
          isCurrent={t.id === currentId && (sameContext || context.type === 'search' || context.type === 'home')}
          isPlaying={isPlaying}
          onPlay={onPlay}
          onRemove={onRemove}
          dnd={hasMove ? dnd : undefined}
        />
      ))}
    </div>
  )
}

export { artistNames }
