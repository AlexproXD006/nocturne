import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Archive, Disc3, KeyRound, ListMusic, MicVocal, Music, PlayCircle, Plus, RefreshCw, Users } from 'lucide-react'
import type { AdminStats } from '../../api/types'
import type { AdminTab } from '../../store/nav'
import { api } from '../../services'
import { useResource } from '../../hooks/useResource'
import { ErrorState, Spinner } from '../../components/common'
import { formatBytes, usageFraction } from './format'
import { JobRow } from './JobRow'
import { startBackup, startRescan, useJobs } from './useJobs'
import { Button, Card, ProgressBar, useTick } from './ui'

function Tile({ icon, label, value }: { icon: ReactNode; label: string; value: number }): ReactNode {
  return (
    <div className="g-card fade-up rounded-2xl bg-ink-850 p-4">
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/[0.06] text-fg-muted [&>svg]:h-4 [&>svg]:w-4" aria-hidden>
        {icon}
      </span>
      <p className="mt-3 text-2xl font-extrabold tracking-tight tabular-nums">{value.toLocaleString()}</p>
      <p className="text-[13px] text-fg-muted">{label}</p>
    </div>
  )
}

function StorageCard({ stats }: { stats: AdminStats }): ReactNode {
  const fraction = usageFraction(stats.storageBytes, stats.freeBytes)
  const pct = fraction === null ? null : Math.round(fraction * 100)
  return (
    <Card id="storage-title" title="Storage">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div>
          <p className="text-2xl font-extrabold tracking-tight tabular-nums">{formatBytes(stats.storageBytes)}</p>
          <p className="text-[13px] text-fg-muted">Used by the music library</p>
        </div>
        {stats.freeBytes !== undefined && (
          <div className="text-right">
            <p className="text-2xl font-extrabold tracking-tight tabular-nums">{formatBytes(stats.freeBytes)}</p>
            <p className="text-[13px] text-fg-muted">Free on the volume</p>
          </div>
        )}
      </div>
      {fraction !== null && (
        <div className="mt-4">
          <ProgressBar
            value={fraction}
            label="Storage used"
            tone={fraction > 0.95 ? 'bad' : fraction > 0.85 ? 'warn' : 'accent'}
          />
          <p className="mt-1.5 text-xs text-fg-subtle tabular-nums">{pct}% of the volume is used by the library</p>
        </div>
      )}
    </Card>
  )
}

export function OverviewTab({ onNavigate }: { onNavigate: (tab: AdminTab) => void }): ReactNode {
  const stats = useResource<AdminStats>('admin:stats', (signal) => api.adminStats(signal))
  const { active } = useJobs()
  const now = useTick()
  const [busy, setBusy] = useState<'scan' | 'backup' | null>(null)

  // Refresh the numbers whenever a job finishes.
  const prevActive = useRef(active.length)
  const reload = stats.reload
  useEffect(() => {
    if (active.length < prevActive.current) reload()
    prevActive.current = active.length
  }, [active.length, reload])

  const run = (kind: 'scan' | 'backup', fn: () => Promise<boolean>): void => {
    setBusy(kind)
    void fn().finally(() => setBusy(null))
  }

  const [ksBusy, setKsBusy] = useState(false)
  const [ksError, setKsError] = useState<string | null>(null)
  const downloadKeystore = async (): Promise<void> => {
    setKsBusy(true)
    setKsError(null)
    try {
      const blob = await api.adminDownloadKeystore()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'nocturne-keystore-backup.zip'
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) {
      setKsError(e instanceof Error ? e.message : 'Download failed')
    } finally {
      setKsBusy(false)
    }
  }

  if (stats.loading) return <div className="flex justify-center py-20"><Spinner /></div>
  if (stats.error && !stats.data) return <ErrorState message={stats.error} onRetry={stats.reload} />
  const s = stats.data
  if (!s) return null

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Tile icon={<Music />} label="Tracks" value={s.tracks} />
        <Tile icon={<Disc3 />} label="Albums" value={s.albums} />
        <Tile icon={<MicVocal />} label="Artists" value={s.artists} />
        <Tile icon={<ListMusic />} label="Playlists" value={s.playlists} />
        <Tile icon={<Users />} label="Users" value={s.users} />
        <Tile icon={<PlayCircle />} label="Plays" value={s.plays} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <StorageCard stats={s} />
        <Card id="actions-title" title="Quick actions">
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" icon={<Plus />} onClick={() => onNavigate('add')}>
              Add music
            </Button>
            <Button icon={<RefreshCw />} busy={busy === 'scan'} onClick={() => run('scan', startRescan)}>
              Rescan library
            </Button>
            <Button icon={<Archive />} busy={busy === 'backup'} onClick={() => run('backup', startBackup)}>
              Create backup
            </Button>
          </div>
          <p className="mt-3 text-[13px] text-fg-muted">Rescanning picks up files you copied into the music folder by hand.</p>
        </Card>
      </div>

      <Card id="signing-title" title="App signing keystore">
        <p className="text-[13px] text-fg-muted">
          Backup of the Android release signing key. It is needed to publish app updates.{' '}
          <strong className="text-fg">Keep several copies and never lose it</strong> — if it is lost, you can no longer update the
          installed app (users would have to reinstall).
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button icon={<KeyRound />} busy={ksBusy} onClick={() => void downloadKeystore()}>
            Download keystore backup
          </Button>
        </div>
        {ksError && <p className="mt-2 text-[13px] text-rose-400">{ksError}</p>}
      </Card>

      <Card
        id="active-jobs-title"
        title="Active jobs"
        action={
          <Button size="sm" variant="ghost" onClick={() => onNavigate('jobs')}>
            View all jobs
          </Button>
        }
      >
        {active.length === 0 ? (
          <p className="py-2 text-sm text-fg-muted">Nothing is running right now.</p>
        ) : (
          <ul className="space-y-2" aria-live="polite">
            {active.slice(0, 5).map((j) => (
              <JobRow key={j.id} job={j} now={now} compact />
            ))}
            {active.length > 5 && <li className="px-1 pt-1 text-xs text-fg-subtle">and {active.length - 5} more…</li>}
          </ul>
        )}
      </Card>
    </div>
  )
}
