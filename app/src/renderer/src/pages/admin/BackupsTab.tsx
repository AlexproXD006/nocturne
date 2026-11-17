import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Archive, History } from 'lucide-react'
import type { Backup } from '../../api/types'
import { api } from '../../services'
import { useUi } from '../../store/ui'
import { useResource } from '../../hooks/useResource'
import { resources } from '../../lib/resource'
import { EmptyState, ErrorState, Spinner } from '../../components/common'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { formatBytes, formatDateTime } from './format'
import { startBackup, useJobs } from './useJobs'
import { Button, Card, Chip } from './ui'

const KEY = 'admin:backups'

export function BackupsTab(): ReactNode {
  const backups = useResource<Backup[]>(KEY, async (signal) => (await api.adminBackups(signal)).backups)
  const { jobs, upsert } = useJobs()
  const [creating, setCreating] = useState(false)
  const [restoring, setRestoring] = useState<Backup | null>(null)

  // A finished backup job adds a row.
  const doneBackups = jobs.filter((j) => j.kind === 'backup' && j.status === 'done').length
  const prev = useRef(doneBackups)
  const { reload } = backups
  useEffect(() => {
    if (doneBackups > prev.current) {
      resources.invalidate(KEY)
      reload()
    }
    prev.current = doneBackups
  }, [doneBackups, reload])

  if (backups.loading) return <div className="flex justify-center py-20"><Spinner /></div>
  if (backups.error && !backups.data) return <ErrorState message={backups.error} onRetry={backups.reload} />
  const list = backups.data ?? []

  return (
    <Card
      id="backups-title"
      title="Backups"
      action={
        <Button
          variant="primary"
          icon={<Archive />}
          busy={creating}
          onClick={() => {
            setCreating(true)
            void startBackup().finally(() => setCreating(false))
          }}
        >
          Create backup
        </Button>
      }
    >
      {list.length === 0 ? (
        <EmptyState icon={<Archive className="h-8 w-8" strokeWidth={1.5} />} title="No backups yet" hint="Create one before making big changes to your library or users." />
      ) : (
        <ul className="space-y-2">
          {list.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center gap-3 rounded-xl bg-white/[0.03] p-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-fg-muted" aria-hidden>
                <Archive className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold tabular-nums">{formatDateTime(b.createdAt) || b.id}</p>
                <p className="flex flex-wrap items-center gap-2 text-[13px] text-fg-muted tabular-nums">
                  {formatBytes(b.sizeBytes)}
                  {b.label && <Chip>{b.label}</Chip>}
                </p>
              </div>
              <Button size="sm" icon={<History />} aria-label={`Restore backup from ${formatDateTime(b.createdAt)}`} onClick={() => setRestoring(b)}>
                Restore
              </Button>
            </li>
          ))}
        </ul>
      )}

      {restoring && (
        <ConfirmDialog
          title="Restore this backup?"
          tone="danger"
          confirmLabel="Restore backup"
          requireText="RESTORE"
          message={
            <>
              This <strong className="text-fg">replaces all current data</strong> with the backup from {formatDateTime(restoring.createdAt)}. Anything added or changed since then is lost.
            </>
          }
          onConfirm={async () => {
            const job = await api.adminRestoreBackup(restoring.id)
            upsert(job)
            useUi.getState().toast('Restore started')
          }}
          onClose={() => setRestoring(null)}
        />
      )}
    </Card>
  )
}
