import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { AdminJob } from '../../api/types'
import { describeError } from '../../api/errors'
import { resources } from '../../lib/resource'
import { api, useSession } from '../../services'
import { useUi } from '../../store/ui'
import { createJobsStore, isActiveJob } from './jobsStore'

export function jobKindLabel(kind: AdminJob['kind']): string {
  switch (kind) {
    case 'download': return 'Download'
    case 'import': return 'Playlist import'
    case 'rescan': return 'Library scan'
    case 'backup': return 'Backup'
    case 'restore': return 'Restore'
  }
}

function announce(job: AdminJob): void {
  const toast = useUi.getState().toast
  if (job.status === 'done') {
    // New tracks / a restored database make cached home, library and search data stale.
    if (job.kind !== 'backup') resources.invalidate('')
    toast(job.kind === 'download' || job.kind === 'import' ? `Added “${job.title}”` : `${jobKindLabel(job.kind)} finished`)
  } else if (job.status === 'failed') {
    toast(`${jobKindLabel(job.kind)} failed${job.error ? `: ${job.error}` : ''}`, 'error')
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
    useUi.getState().toast('Job cancelled')
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
    useUi.getState().toast('Library scan started')
    return true
  } catch (err) {
    useUi.getState().toast(describeError(err), 'error')
    return false
  }
}

export async function startBackup(): Promise<boolean> {
  try {
    jobsStore.upsert(await api.adminCreateBackup())
    useUi.getState().toast('Backup started')
    return true
  } catch (err) {
    useUi.getState().toast(describeError(err), 'error')
    return false
  }
}
