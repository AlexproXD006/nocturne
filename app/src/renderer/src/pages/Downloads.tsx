import { ArrowDownToLine, Disc3, ListMusic, Pause, Play, Trash2, X } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import type { Track } from '../api/types'
import { useT } from '../i18n'
import { useConnectivity, useOffline } from '../services'
import { useNav } from '../store/nav'
import { EmptyState, IconButton, cx, Artwork } from '../components/common'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { ProgressRing, statusOf } from '../components/DownloadButton'
import { TrackList } from '../components/TrackList'
import { formatBytes } from '../hooks/useAvailability'
import { GB } from '../lib/offline/policy'
import { type DownloadedCollection } from '../lib/offline/sync'
import { Page, PlayButtons } from './Page'

function StorageBar(): ReactNode {
  const t = useT()
  const usage = useOffline((s) => s.usage)
  const limitGb = useOffline((s) => s.settings.limitGb)
  const limit = limitGb * GB
  const total = usage.pinnedBytes + usage.autoBytes
  // With a limit the bar shows downloads against it; without one, downloads against everything this app stores.
  const denominator = limit > 0 ? limit : Math.max(total, 1)
  const dl = Math.min(100, (usage.pinnedBytes / denominator) * 100)
  const auto = limit > 0 ? 0 : Math.min(100 - dl, (usage.autoBytes / denominator) * 100)
  const warn = limit > 0 && usage.pinnedBytes >= limit * 0.9
  return (
    <section className="g-card mb-6 rounded-2xl bg-white/[0.035] p-4" aria-label={t('dl.storage')}>
      <div className="mb-2 flex items-baseline justify-between gap-3 text-sm">
        <h2 className="font-semibold">{t('dl.storage')}</h2>
        <span className="text-fg-muted tabular-nums">
          {limit > 0 ? t('dl.storageLimit', { used: formatBytes(usage.pinnedBytes), limit: formatBytes(limit) }) : formatBytes(usage.pinnedBytes)}
        </span>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-white/[0.08]" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(dl)}>
        <div className={cx('h-full', warn ? 'bg-[#ff7a5c]' : 'bg-accent')} style={{ width: `${dl}%` }} />
        <div className="h-full bg-white/25" style={{ width: `${auto}%` }} />
      </div>
      <p className="mt-2 text-xs text-fg-muted">{t('dl.storageUsed', { downloads: formatBytes(usage.pinnedBytes), cache: formatBytes(usage.autoBytes) })}</p>
      {warn && <p className="mt-1 text-xs font-medium text-[#ff7a5c]">{t('dl.limitWarn')}</p>}
    </section>
  )
}

function TransferRow({ track, id }: { track?: Track; id: string }): ReactNode {
  const t = useT()
  const tr = useOffline((s) => s.transfers[id])
  const unmetered = useConnectivity((s) => s.unmetered)
  const wifiOnly = useOffline((s) => s.settings.downloadsWifiOnly)
  if (!tr) return null
  const waitingWifi = wifiOnly && unmetered === false && tr.state !== 'active'
  const state = waitingWifi ? t('dl.waitingWifi') : t(`dl.state.${tr.state}` as 'dl.state.queued')
  const act = useOffline.getState()
  return (
    <li className="flex items-center gap-3 rounded-lg px-1 py-2">
      <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full">
        <ProgressRing percent={tr.state === 'active' ? tr.percent : tr.state === 'queued' ? 0 : Math.max(0, tr.percent)} />
        <ArrowDownToLine className="h-4 w-4 text-fg-muted" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{track?.title ?? id}</p>
        <p className="truncate text-xs text-fg-muted">
          {state}
          {tr.total > 0 && ` · ${formatBytes(tr.bytes)} / ${formatBytes(tr.total)}`}
        </p>
      </div>
      {tr.state === 'paused' || tr.state === 'failed' ? (
        <IconButton label={t('dl.resume')} size="sm" onClick={() => act.resume(id)}>
          <Play className="h-4 w-4" />
        </IconButton>
      ) : (
        <IconButton label={t('dl.pause')} size="sm" onClick={() => act.pause(id)}>
          <Pause className="h-4 w-4" />
        </IconButton>
      )}
      <IconButton label={t('dl.cancel')} size="sm" onClick={() => act.cancel(id)}>
        <X className="h-4 w-4" />
      </IconButton>
    </li>
  )
}

function CollectionRow({ col, onOpen }: { col: DownloadedCollection; onOpen: () => void }): ReactNode {
  const t = useT()
  const available = useOffline((s) => s.available)
  const transfers = useOffline((s) => s.transfers)
  const tracks = useOffline((s) => s.tracks)
  const [confirm, setConfirm] = useState(false)
  const st = statusOf(col.trackIds, available, transfers)
  const bytesHint = st.state === 'downloaded' ? t('dl.songsProgress', { done: st.done, total: st.total }) : t('dl.downloading', { done: st.done, total: st.total })
  const art = tracks[col.trackIds[0] ?? '']?.artwork
  const Icon = col.kind === 'album' ? Disc3 : ListMusic
  return (
    <li className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-white/[0.05]">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <div className="relative h-12 w-12 shrink-0">
          {art ? <Artwork images={art} size={48} className="h-12 w-12" rounded="rounded-md" /> : <div className="flex h-12 w-12 items-center justify-center rounded-md bg-white/[0.08]"><Icon className="h-5 w-5 text-fg-muted" /></div>}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{col.name}</p>
          <p className="truncate text-xs text-fg-muted">
            {t(`dl.kind.${col.kind}` as 'dl.kind.mix')} · {bytesHint}
          </p>
        </div>
      </button>
      {st.state === 'downloading' && (
        <div className="relative h-8 w-8 shrink-0">
          <ProgressRing percent={st.percent} />
        </div>
      )}
      <IconButton label={t('dl.remove')} size="sm" onClick={() => setConfirm(true)}>
        <Trash2 className="h-4 w-4" />
      </IconButton>
      {confirm && (
        <ConfirmDialog
          title={t('dl.removeTitle', { name: col.name })}
          message={t('dl.removeBody')}
          confirmLabel={t('dl.remove')}
          tone="danger"
          onClose={() => setConfirm(false)}
          onConfirm={() => useOffline.getState().removeCollection(col.key)}
        />
      )}
    </li>
  )
}

/** Library → Downloads: what is stored (or being stored), with progress, pause / resume / cancel and the storage bar. */
export function DownloadsPage(): ReactNode {
  const t = useT()
  const go = useNav((s) => s.go)
  const collections = useOffline((s) => s.collections)
  const transfers = useOffline((s) => s.transfers)
  const tracksMap = useOffline((s) => s.tracks)
  const available = useOffline((s) => s.available)
  const paused = useOffline((s) => s.paused)
  const [confirmAll, setConfirmAll] = useState(false)

  const cols = useMemo(() => Object.values(collections).sort((a, b) => a.name.localeCompare(b.name)), [collections])
  const active = Object.keys(transfers)
  const stored = useMemo(
    () => Object.entries(available).filter(([, k]) => k === 'pinned').map(([id]) => tracksMap[id]).filter((x): x is Track => Boolean(x)),
    [available, tracksMap]
  )
  const empty = cols.length === 0 && active.length === 0 && stored.length === 0
  const ctx = useMemo(() => ({ type: 'tracks' as const, id: 'downloads', name: t('dl.title') }), [t])

  return (
    <Page>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">{t('dl.title')}</h1>
        <div className="flex items-center gap-2">
          {active.length > 0 && (
            <button
              type="button"
              onClick={() => (paused ? useOffline.getState().resume() : useOffline.getState().pause())}
              className="inline-flex h-10 items-center gap-2 rounded-full bg-white/[0.08] px-4 text-sm font-semibold hover:bg-white/[0.14]"
            >
              {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
              {paused ? t('dl.resumeAll') : t('dl.pauseAll')}
            </button>
          )}
          {!empty && (
            <button
              type="button"
              onClick={() => setConfirmAll(true)}
              className="inline-flex h-10 items-center gap-2 rounded-full bg-white/[0.08] px-4 text-sm font-semibold text-[#ff7a5c] hover:bg-white/[0.14]"
            >
              <Trash2 className="h-4 w-4" /> {t('dl.removeAll')}
            </button>
          )}
        </div>
      </div>
      <StorageBar />
      {empty ? (
        <EmptyState icon={<ArrowDownToLine className="h-9 w-9" strokeWidth={1.4} />} title={t('dl.emptyTitle')} hint={t('dl.emptyHint')} />
      ) : (
        <>
          {active.length > 0 && (
            <section className="mb-8">
              <h2 className="mb-2 text-lg font-bold tracking-tight">{t('dl.inProgress')}</h2>
              <ul>
                {active.map((id) => (
                  <TransferRow key={id} id={id} track={tracksMap[id]} />
                ))}
              </ul>
            </section>
          )}
          {cols.length > 0 && (
            <section className="mb-8">
              <h2 className="mb-2 text-lg font-bold tracking-tight">{t('dl.collections')}</h2>
              <ul>
                {cols.map((c) => (
                  <CollectionRow key={c.key} col={c} onOpen={() => go({ name: c.kind, id: c.id })} />
                ))}
              </ul>
            </section>
          )}
          {stored.length > 0 && (
            <section>
              <h2 className="mb-1 text-lg font-bold tracking-tight">{t('dl.songs')}</h2>
              <PlayButtons tracks={stored} context={ctx} />
              <TrackList tracks={stored} context={ctx} searchable />
            </section>
          )}
        </>
      )}
      {confirmAll && (
        <ConfirmDialog
          title={t('dl.removeAllTitle')}
          message={t('dl.removeBody')}
          confirmLabel={t('dl.removeAll')}
          tone="danger"
          onClose={() => setConfirmAll(false)}
          onConfirm={() => useOffline.getState().removeAll()}
        />
      )}
    </Page>
  )
}

