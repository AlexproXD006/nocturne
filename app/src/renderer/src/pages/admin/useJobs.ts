import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { AdminJob } from '../../api/types'
import { describeError } from '../../api/errors'
import { resources } from '../../lib/resource'
import { api, useSession } from '../../services'
import { useUi } from '../../store/ui'
import { createJobsStore, isActiveJob } from './jobsStore'
import { t } from '../../i18n'

export function jobKindLabel(kind: AdminJob['kind']): string {
  switch (kind) {
    case 'download': return t('job.kind.download')
    case 'import': return t('job.kind.import')
    case 'rescan': return t('job.kind.rescan')
    case 'backup': return t('job.kind.backup')
    case 'restore': return t('job.kind.restore')
  }
}

function announce(job: AdminJob): void {
  const toast = useUi.getState().toast
  if (job.status === 'done') {
    // New tracks / a restored database make cached home, library and search data stale.
    if (job.kind !== 'backup') resources.invalidate('')
    toast(job.kind === 'download' || job.kind === 'import' ? t('job.toastAdded', { title: job.title }) : t('job.toastFinished', { kind: jobKindLabel(job.kind) }))
  } else if (job.status === 'failed') {
    toast(job.error ? t('job.toastFailedWith', { kind: jobKindLabel(job.kind), error: job.error }) : t('job.toastFailed', { kind: jobKindLabel(job.kind) }), 'error')
  }
}

export const jobsStore = createJobsStore({
  fetchJobs: async (signal) => (await api.adminJobs(signal)).jobs,
  onJobFinished: announce
})

// A different account must never see the previous one's jobs.
useSession.subscribe((s, prev) => {
  if (prev.status === 'signedIn' && s.status !== 'signedIn') jobsStore.reset()
})

export interface UseJobs {
  jobs: AdminJob[]
  active: AdminJob[]
  loaded: boolean
  error: string | null
  refresh(): Promise<void>
  upsert(job: AdminJob): void
}

/** Live admin job list (shared poller: 1.5 s while jobs are active, 10 s otherwise, paused while hidden). */
export function useJobs(): UseJobs {
  const snap = useSyncExternalStore(jobsStore.subscribe, jobsStore.getSnapshot)
  const active = useMemo(() => snap.jobs.filter(isActiveJob), [snap.jobs])
  const refresh = useCallback(() => jobsStore.refresh(), [])
  const upsert = useCallback((job: AdminJob) => jobsStore.upsert(job), [])
  return { jobs: snap.jobs, active, loaded: snap.loaded, error: snap.error, refresh, upsert }
}

/** Cancels a queued/running job; resolves true on success and toasts failures. */
export async function cancelJob(id: string): Promise<boolean> {
  try {
    await api.adminCancelJob(id)
    await jobsStore.refresh()
    useUi.getState().toast(t('job.toastCancelled'))
    return true
  } catch (err) {
    useUi.getState().toast(describeError(err), 'error')
    void jobsStore.refresh()
    return false
  }
}

export async function startRescan(): Promise<boolean> {
  try {
    jobsStore.upsert(await api.adminRescan())
    useUi.getState().toast(t('job.toastScan'))
    return true
  } catch (err) {
    useUi.getState().toast(describeError(err), 'error')
    return false
  }
}

export async function startBackup(): Promise<boolean> {
  try {
    jobsStore.upsert(await api.adminCreateBackup())
    useUi.getState().toast(t('job.toastBackup'))
    return true
  } catch (err) {
    useUi.getState().toast(describeError(err), 'error')
    return false
  }
}
