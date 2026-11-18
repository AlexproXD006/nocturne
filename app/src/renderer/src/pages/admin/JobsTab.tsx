import { useState, type ReactNode } from 'react'
import { ListChecks } from 'lucide-react'
import { EmptyState, ErrorState, Spinner } from '../../components/common'
import { JobRow } from './JobRow'
import { useJobs } from './useJobs'
import { Card, Segmented, useTick } from './ui'
import { useT } from '../../i18n'

type Filter = 'all' | 'active' | 'finished'

export function JobsTab(): ReactNode {
  const tr = useT()
  const { jobs, active, loaded, error, refresh } = useJobs()
  const [filter, setFilter] = useState<Filter>('all')
  const now = useTick()

  if (!loaded) return <div className="flex justify-center py-20"><Spinner /></div>
  if (error && jobs.length === 0) return <ErrorState message={error} onRetry={() => void refresh()} />

  const shown = filter === 'all' ? jobs : filter === 'active' ? active : jobs.filter((j) => j.status !== 'queued' && j.status !== 'running')

  return (
    <Card
      id="jobs-title"
      title={tr('jobs.title')}
      action={
        <Segmented
          label={tr('jobs.filter')}
          value={filter}
          onChange={setFilter}
          options={[
            { id: 'all', label: tr('jobs.all') },
            { id: 'active', label: active.length ? tr('jobs.activeN', { count: active.length }) : tr('jobs.active') },
            { id: 'finished', label: tr('jobs.finished') }
          ]}
        />
      }
    >
      {error && <p role="status" className="mb-3 text-sm text-[#ffc15e]">{tr('jobs.paused', { error: error ?? '' })}</p>}
      {shown.length === 0 ? (
        <EmptyState
          icon={<ListChecks className="h-8 w-8" strokeWidth={1.5} />}
          title={filter === 'active' ? tr('jobs.nothingRunning') : tr('jobs.none')}
          hint={tr('jobs.hint')}
        />
      ) : (
        <ul className="space-y-2" aria-live="polite">
          {shown.map((j) => (
            <JobRow key={j.id} job={j} now={now} />
          ))}
        </ul>
      )}
    </Card>
  )
}
