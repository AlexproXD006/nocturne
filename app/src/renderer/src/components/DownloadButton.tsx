import { ArrowDownToLine, Check } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import type { Track } from '../api/types'
import { useT } from '../i18n'
import { useOffline } from '../services'
import { useUi } from '../store/ui'
import { collectionKey, type CollectionKind } from '../lib/offline/sync'
import { cx } from './common'
import { ConfirmDialog } from './ConfirmDialog'

/** Circular progress around the icon (0..100); indeterminate (a quarter arc) when unknown. */
export function ProgressRing({ percent, className }: { percent: number; className?: string }): ReactNode {
  const r = 10
  const c = 2 * Math.PI * r
  const known = percent >= 0
  const dash = known ? (Math.min(100, percent) / 100) * c : c * 0.25
  return (
    <svg viewBox="0 0 24 24" className={cx('absolute inset-0 h-full w-full -rotate-90', !known && 'animate-spin')} aria-hidden>
      <circle cx="12" cy="12" r={r} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
      <circle cx="12" cy="12" r={r} fill="none" stroke="rgb(var(--accent-rgb))" strokeWidth="2" strokeLinecap="round" strokeDasharray={`${dash} ${c}`} className={className} />
    </svg>
  )
}

export interface DownloadStatus {
  state: 'none' | 'downloading' | 'downloaded'
  done: number
  total: number
  /** 0..100 over all tracks of the collection. */
  percent: number
}

/** Progress of a set of tracks: stored ones count as done, active ones add their fraction. */
export function statusOf(ids: readonly string[], available: Record<string, string>, transfers: Record<string, { percent: number; state: string }>): DownloadStatus {
  if (ids.length === 0) return { state: 'none', done: 0, total: 0, percent: 0 }
  let done = 0
  let partial = 0
  let busy = false
  for (const id of ids) {
    if (available[id] === 'pinned') done++
    else if (transfers[id]) {
      busy = true
      if (transfers[id]!.percent > 0) partial += transfers[id]!.percent / 100
    }
  }
  const total = ids.length
  if (done === total) return { state: 'downloaded', done, total, percent: 100 }
  const percent = Math.round(((done + partial) / total) * 100)
  return { state: busy || done > 0 ? 'downloading' : 'none', done, total, percent }
}

/**
 * "Descargar" button with a progress ring for a playlist, album, mix (a collection that is kept in sync)
 * or a list of songs. Tapping a downloaded one asks before removing it.
 */
export function DownloadButton({
  tracks,
  collection,
  size = 'lg',
  label
}: {
  tracks: Track[]
  collection?: { kind: CollectionKind; id: string; name: string }
  size?: 'md' | 'lg'
  label?: string
}): ReactNode {
  const t = useT()
  const available = useOffline((s) => s.available)
  const transfers = useOffline((s) => s.transfers)
  const col = useOffline((s) => (collection ? s.collections[collectionKey(collection.kind, collection.id)] : undefined))
  const [confirm, setConfirm] = useState(false)
  const ids = useMemo(() => tracks.map((x) => x.id), [tracks])
  const st = statusOf(col ? col.trackIds : ids, available, transfers)
  const wanted = Boolean(col) || st.state !== 'none'
  const state = wanted && st.state === 'none' ? 'downloading' : st.state
  const dims = size === 'lg' ? 'h-11 w-11' : 'h-9 w-9'
  const text = state === 'downloaded' ? t('dl.downloaded') : state === 'downloading' ? t('dl.downloading', { done: st.done, total: st.total }) : (label ?? t('dl.download'))

  const start = (): void => {
    if (tracks.length === 0) return
    const st0 = useOffline.getState()
    if (collection) void st0.downloadCollection(collection.kind, collection.id, collection.name, tracks)
    else void st0.downloadTracks(tracks)
    useUi.getState().toast(t('dl.queued', { count: tracks.length }))
  }
  const remove = async (): Promise<void> => {
    const s = useOffline.getState()
    if (col) await s.removeCollection(col.key)
    else await s.removeTrackIds(ids)
  }

  return (
    <>
      <button
        type="button"
        aria-label={text}
        title={text}
        disabled={tracks.length === 0 && !col}
        onClick={() => (state === 'none' ? start() : setConfirm(true))}
        className={cx(
          'relative inline-flex shrink-0 items-center justify-center rounded-full text-fg-muted transition hover:bg-white/[0.08] hover:text-fg active:scale-95 disabled:opacity-40',
          dims,
          state === 'downloaded' && 'text-accent'
        )}
      >
        {state === 'downloading' && <ProgressRing percent={st.percent} />}
        {state === 'downloaded' ? <Check className="h-5 w-5" strokeWidth={2.5} /> : <ArrowDownToLine className={cx('h-5 w-5', state === 'downloading' && 'h-4 w-4')} />}
      </button>
      {confirm && (
        <ConfirmDialog
          title={t('dl.removeTitle', { name: collection?.name ?? label ?? '' })}
          message={t('dl.removeBody')}
          confirmLabel={t('dl.remove')}
          tone="danger"
          onClose={() => setConfirm(false)}
          onConfirm={remove}
        />
      )}
    </>
  )
}
