import { useState, type ReactNode } from 'react'
import { Archive, Download, ListPlus, RefreshCw, RotateCcw, X } from 'lucide-react'
import type { AdminJob, JobStatus } from '../../api/types'
import { cx } from '../../components/common'
import { relativeTime } from './format'
import { cancelJob, jobKindLabel } from './useJobs'
import { Button, Chip, ProgressBar, type ChipTone } from './ui'
import { useT, type MessageKey } from '../../i18n'

const STATUS: Record<JobStatus, { label: MessageKey; tone: ChipTone }> = {
  queued: { label: 'job.queued', tone: 'neutral' },
  running: { label: 'job.running', tone: 'accent' },
  done: { label: 'job.done', tone: 'good' },
  failed: { label: 'job.failed', tone: 'bad' },
  cancelled: { label: 'job.cancelled', tone: 'warn' }
}

const KIND_ICON: Record<AdminJob['kind'], typeof Download> = {
  download: Download,
  import: ListPlus,
  rescan: RefreshCw,
  backup: Archive,
  restore: RotateCcw
}

export function JobStatusChip({ status }: { status: JobStatus }): ReactNode {
  const tr = useT()
  const s = STATUS[status]
  return <Chip tone={s.tone}>{tr(s.label)}</Chip>
}

export function JobRow({ job, now, compact }: { job: AdminJob; now: number; compact?: boolean }): ReactNode {
  const tr = useT()
  const [cancelling, setCancelling] = useState(false)
  const Icon = KIND_ICON[job.kind]
  const active = job.status === 'queued' || job.status === 'running'
  const detail = job.error ?? job.message
  const when = relativeTime(job.finishedAt ?? job.createdAt, now)
  const added = job.trackIds?.length ?? 0

  return (
    <li className={cx('flex items-start gap-3 rounded-xl bg-white/[0.03] p-3', !compact && 'sm:gap-4 sm:p-4')}>
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-fg-muted" aria-hidden>
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="min-w-0 truncate text-sm font-semibold [overflow-wrap:anywhere]" title={job.title}>
            {job.title}
          </p>
          <JobStatusChip status={job.status} />
        </div>
        <p className="mt-0.5 text-xs text-fg-subtle tabular-nums">
          {jobKindLabel(job.kind)}
          {job.source && job.source !== 'url' ? ` · ${job.source === 'spotify' ? 'Spotify' : 'YouTube'}` : ''}
          {when ? ` · ${when}` : ''}
          {added > 0 ? ` · ${tr('job.added', { count: added })}` : ''}
        </p>
        {job.status === 'running' && (
          <div className="mt-2.5 flex items-center gap-3">
            <ProgressBar value={job.progress} label={tr('job.progress', { title: job.title })} />
            {job.progress !== undefined && (
              <span className="w-10 shrink-0 text-right text-xs text-fg-muted tabular-nums">{Math.round(job.progress * 100)}%</span>
            )}
          </div>
        )}
        {detail && (
          <p className={cx('mt-1.5 text-[13px] [overflow-wrap:anywhere]', job.error ? 'text-[#ff9b9b]' : 'text-fg-muted')} role={job.error ? 'alert' : undefined}>
            {detail}
          </p>
        )}
      </div>
      {active && (
        <Button
          size="sm"
          variant="ghost"
          busy={cancelling}
          aria-label={tr('job.cancelLabel', { title: job.title })}
          icon={<X />}
          onClick={() => {
            setCancelling(true)
            void cancelJob(job.id).finally(() => setCancelling(false))
          }}
        >
          <span className="max-sm:sr-only">{tr('job.cancel')}</span>
        </Button>
      )}
    </li>
  )
}
