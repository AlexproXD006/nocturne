import { useState, type ReactNode } from 'react'
import { GripVertical, ListMusic, X } from 'lucide-react'
import { usePlayer } from '../services'
import { currentItem, upcoming, type QueueItem } from '../player/queue'
import { artistNames } from '../lib/format'
import { Artwork, EmptyState, cx } from './common'
import { Equalizer } from './TrackList'

function QueueRow({
  item,
  index,
  current,
  draggable,
  onDragStart,
  onDropAt
}: {
  item: QueueItem
  index: number
  current?: boolean
  draggable?: boolean
  onDragStart?: (index: number) => void
  onDropAt?: (index: number) => void
}): ReactNode {
  const [over, setOver] = useState(false)
  const playing = usePlayer((s) => s.status === 'playing')
  return (
    <div
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        onDragStart?.(index)
      }}
      onDragOver={(e) => {
        if (!draggable) return
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        onDropAt?.(index)
      }}
      onDoubleClick={() => !current && void usePlayer.getState().playItem(item.uid)}
      className={cx(
        'group flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-white/[0.05]',
        over && 'ring-1 ring-accent/60'
      )}
    >
      {/* Drag handle (mouse only: HTML5 drag-and-drop does not work on touch). The current row gets
          an equal spacer so both kinds of rows line up. */}
      {draggable ? (
        <GripVertical className="hidden h-4 w-4 shrink-0 cursor-grab text-fg-subtle opacity-0 group-hover:opacity-100 md:block" />
      ) : (
        <span className="hidden w-4 shrink-0 md:block" aria-hidden />
      )}
      <div className="relative shrink-0">
        <Artwork images={item.track.artwork} size={44} className="h-11 w-11" rounded="rounded-md" />
        {current && (
          <div className="absolute inset-0 flex items-center justify-center rounded-md bg-black/45">
            <Equalizer paused={!playing} />
          </div>
        )}
      </div>
      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        onClick={() => !current && void usePlayer.getState().playItem(item.uid)}
        aria-label={`Play ${item.track.title}`}
      >
        <p className={cx('truncate text-sm font-medium', current && 'text-accent')}>{item.track.title}</p>
        <p className="truncate text-xs text-fg-muted">{artistNames(item.track.artists)}</p>
      </button>
      {!current && (
        <button
          type="button"
          aria-label={`Remove ${item.track.title} from queue`}
          onClick={() => usePlayer.getState().removeFromQueue(item.uid)}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-fg-subtle opacity-0 hover:bg-white/8 hover:text-fg group-hover:opacity-100 focus:opacity-100 max-md:h-10 max-md:w-10 max-md:opacity-100"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}

export function QueuePanel(): ReactNode {
  const queue = usePlayer((s) => s.queue)
  const now = currentItem(queue)
  const next = upcoming(queue)
  const [dragFrom, setDragFrom] = useState<number | null>(null)

  if (!now) {
    return <EmptyState icon={<ListMusic className="h-8 w-8" strokeWidth={1.4} />} title="Your queue is empty" hint="Play an album or playlist and it will show up here." />
  }

  return (
    <div className="flex h-full flex-col">
      <div className="hide-scrollbar flex-1 overflow-y-auto px-3 pb-6">
        <p className="px-2 pt-2 pb-2 text-xs font-semibold tracking-wide text-fg-subtle uppercase">Now playing</p>
        <QueueRow item={now} index={queue.index} current />
        {next.length > 0 && (
          <div className="mt-5 flex items-center justify-between gap-3 px-2 pb-2">
            <p className="min-w-0 truncate text-xs font-semibold tracking-wide text-fg-subtle uppercase">
              Next{queue.context?.name ? ` from ${queue.context.name}` : ''}
            </p>
            <button onClick={() => usePlayer.getState().clearUpcoming()} className="-my-2 shrink-0 px-1 py-2 text-xs text-fg-muted hover:text-fg">
              Clear
            </button>
          </div>
        )}
        {next.map((item, i) => {
          const index = queue.index + 1 + i
          return (
            <QueueRow
              key={item.uid}
              item={item}
              index={index}
              draggable
              onDragStart={setDragFrom}
              onDropAt={(to) => {
                if (dragFrom !== null) usePlayer.getState().moveInQueue(dragFrom, Math.max(queue.index + 1, to))
                setDragFrom(null)
              }}
            />
          )
        })}
      </div>
    </div>
  )
}
