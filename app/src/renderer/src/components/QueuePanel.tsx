import { useEffect, useState, type ReactNode } from 'react'
import { GripVertical, ListMusic, MonitorSpeaker, X } from 'lucide-react'
import { api, useConnect, usePlayer } from '../services'
import { useNowStatus } from '../hooks/useNowPlaying'
import { autoplayUpcoming, contextUpcoming, currentItem, userUpcoming, type QueueItem, type QueueSection } from '../player/queue'
import { resolveTracks } from '../player/resolveTracks'
import type { Track } from '../api/types'
import { artistNames } from '../lib/format'
import { Artwork, EmptyState, cx } from './common'
import { Equalizer } from './TrackList'
import { t, useT } from '../i18n'

function QueueRow({
  item,
  index,
  current,
  readOnly,
  draggable,
  onDragStart,
  onDropAt
}: {
  item: QueueItem
  index: number
  current?: boolean
  /** Remote queue rows: shown, not editable. */
  readOnly?: boolean
  draggable?: boolean
  onDragStart?: (index: number) => void
  onDropAt?: (index: number) => void
}): ReactNode {
  const tr = useT()
  const [over, setOver] = useState(false)
  const playing = useNowStatus() === 'playing'
  const play = (): void => {
    if (!current && !readOnly) void usePlayer.getState().playItem(item.uid)
  }
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
      onDoubleClick={play}
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
      <button type="button" className="min-w-0 flex-1 text-left" onClick={play} aria-label={tr('card.play', { title: item.track.title })}>
        <p className={cx('truncate text-sm font-medium', current && 'text-accent')}>{item.track.title}</p>
        <p className="truncate text-xs text-fg-muted">{artistNames(item.track.artists)}</p>
      </button>
      {!current && !readOnly && (
        <button
          type="button"
          aria-label={tr('queue.remove', { title: item.track.title })}
          onClick={() => usePlayer.getState().removeFromQueue(item.uid)}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-fg-subtle opacity-0 hover:bg-white/8 hover:text-fg group-hover:opacity-100 focus:opacity-100 max-md:h-10 max-md:w-10 max-md:opacity-100"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}

function SectionHeader({ title, onClear }: { title: string; onClear?: () => void }): ReactNode {
  const tr = useT()
  return (
    <div className="mt-5 flex items-center justify-between gap-3 px-2 pb-2">
      <p className="min-w-0 truncate text-xs font-semibold tracking-wide text-fg-subtle uppercase">{title}</p>
      {onClear && (
        <button onClick={onClear} aria-label={tr('queue.clearLabel', { title })} className="-my-2 shrink-0 px-1 py-2 text-xs text-fg-muted hover:text-fg">
          {tr('queue.clear')}
        </button>
      )}
    </div>
  )
}

/** One editable section ("Next in queue" or "Next from …"); drag reorders within the section. */
function Section({ section, items }: { section: QueueSection; items: QueueItem[] }): ReactNode {
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  return (
    <>
      {items.map((item, i) => (
        <QueueRow
          key={item.uid}
          item={item}
          index={i}
          draggable
          onDragStart={setDragFrom}
          onDropAt={(to) => {
            if (dragFrom !== null) usePlayer.getState().moveInSection(section, dragFrom, to)
            setDragFrom(null)
          }}
        />
      ))}
    </>
  )
}

function contextTitle(name: string | undefined): string {
  return name ? t('queue.nextFrom', { name }) : t('queue.nextUp')
}

/** Tracks for remote queue ids (resolved through the API, cached for the session). */
const remoteCache = new Map<string, Track>()
function useResolved(ids: readonly string[]): Track[] {
  const key = ids.join(',')
  const [, bump] = useState(0)
  useEffect(() => {
    const missing = key ? key.split(',').filter((id) => !remoteCache.has(id)) : []
    if (missing.length === 0) return
    let live = true
    resolveTracks(missing, api, { maxLookups: 60 })
      .then((list) => {
        list.forEach((t) => t && remoteCache.set(t.id, t))
        if (live) bump((n) => n + 1)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [key])
  return ids.map((id) => remoteCache.get(id)).filter((t): t is Track => Boolean(t))
}

const asItems = (tracks: Track[], prefix: string): QueueItem[] => tracks.map((track, i) => ({ uid: `${prefix}${i}:${track.id}`, track }))

/** Read-only view of the controlled device's queue (both tiers). */
function RemoteQueue(): ReactNode {
  const tr = useT()
  const remote = useConnect((s) => s.remote)
  const user = useResolved(remote?.state.userQueue ?? [])
  const next = useResolved(remote?.state.upNext ?? [])
  if (!remote) return null
  const t = remote.state.track
  if (!t) {
    return <EmptyState icon={<MonitorSpeaker className="h-8 w-8" strokeWidth={1.4} />} title={tr('queue.nothingOn', { name: remote.name })} hint={tr('queue.nothingOnHint')} />
  }
  return (
    <div className="flex h-full flex-col">
      <div className="hide-scrollbar flex-1 overflow-y-auto px-3 pb-6">
        <p className="flex items-center gap-1.5 px-2 pt-2 pb-2 text-xs font-semibold tracking-wide text-accent uppercase">
          <MonitorSpeaker className="h-3.5 w-3.5" /> Now playing on {remote.name}
        </p>
        <QueueRow item={{ uid: 'remote-now', track: t }} index={0} current readOnly />
        {user.length > 0 && <SectionHeader title={tr('queue.nextInQueue')} />}
        {asItems(user, 'ru').map((item, i) => <QueueRow key={item.uid} item={item} index={i} readOnly />)}
        {next.length > 0 && <SectionHeader title={contextTitle(remote.state.context?.name)} />}
        {asItems(next, 'rn').map((item, i) => <QueueRow key={item.uid} item={item} index={i} readOnly />)}
        <p className="px-2 pt-4 text-xs text-fg-subtle">{tr('queue.remoteNote')}</p>
      </div>
    </div>
  )
}

export function QueuePanel(): ReactNode {
  const tr = useT()
  const queue = usePlayer((s) => s.queue)
  const remote = useConnect((s) => s.remote !== null)
  const now = currentItem(queue)

  if (remote) return <RemoteQueue />

  if (!now) {
    return <EmptyState icon={<ListMusic className="h-8 w-8" strokeWidth={1.4} />} title={tr('queue.empty')} hint={tr('queue.emptyHint')} />
  }
  const user = userUpcoming(queue)
  const next = contextUpcoming(queue)
  const auto = autoplayUpcoming(queue)

  return (
    <div className="flex h-full flex-col">
      <div className="hide-scrollbar flex-1 overflow-y-auto px-3 pb-6">
        <p className="px-2 pt-2 pb-2 text-xs font-semibold tracking-wide text-fg-subtle uppercase">{tr('queue.nowPlaying')}</p>
        <QueueRow item={now} index={queue.index} current />
        {user.length > 0 && (
          <>
            <SectionHeader title={tr('queue.nextInQueue')} onClear={() => usePlayer.getState().clearUserQueue()} />
            <Section section="user" items={user} />
          </>
        )}
        {next.length > 0 && (
          <>
            <SectionHeader title={contextTitle(queue.context?.name)} onClear={() => usePlayer.getState().clearContextUpcoming()} />
            <Section section="context" items={next} />
          </>
        )}
        {auto.length > 0 && (
          <>
            <SectionHeader title={tr('queue.autoplay')} onClear={() => usePlayer.getState().clearAutoplay()} />
            <p className="-mt-1 px-2 pb-2 text-xs text-fg-subtle">{tr('queue.autoplayHint')}</p>
            {auto.map((item, i) => (
              <QueueRow key={item.uid} item={item} index={i} />
            ))}
          </>
        )}
      </div>
    </div>
  )
}
