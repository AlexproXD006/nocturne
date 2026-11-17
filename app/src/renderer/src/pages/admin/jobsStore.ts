import type { AdminJob } from '../../api/types'
import { describeError, isAbort } from '../../api/errors'

export interface JobsSnapshot {
  jobs: AdminJob[]
  /** True once the first response (or error) arrived. */
  loaded: boolean
  error: string | null
}

export interface JobsStoreOptions {
  fetchJobs(signal: AbortSignal): Promise<AdminJob[]>
  /** Called once when a job we saw queued/running reaches a terminal status. */
  onJobFinished?(job: AdminJob): void
  /** Poll period while any job is queued/running. */
  activeMs?: number
  /** Poll period otherwise. */
  idleMs?: number
  isHidden?(): boolean
}

export function isActiveJob(job: AdminJob): boolean {
  return job.status === 'queued' || job.status === 'running'
}

const EMPTY: JobsSnapshot = { jobs: [], loaded: false, error: null }

/**
 * Shared job poller. Runs only while somebody is subscribed, polls fast while jobs are
 * active, slowly otherwise, and pauses while the document is hidden.
 */
export function createJobsStore(opts: JobsStoreOptions) {
  const activeMs = opts.activeMs ?? 1500
  const idleMs = opts.idleMs ?? 10_000
  const isHidden = opts.isHidden ?? (() => typeof document !== 'undefined' && document.hidden)

  let snapshot: JobsSnapshot = EMPTY
  const listeners = new Set<() => void>()
  const seenActive = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let ctrl: AbortController | null = null
  let running = false

  const emit = (): void => listeners.forEach((fn) => fn())
  const set = (next: JobsSnapshot): void => {
    snapshot = next
    emit()
  }

  function observe(jobs: AdminJob[]): void {
    for (const job of jobs) {
      if (isActiveJob(job)) {
        seenActive.add(job.id)
      } else if (seenActive.delete(job.id)) {
        opts.onJobFinished?.(job)
      }
    }
  }

  async function load(): Promise<void> {
    ctrl?.abort()
    const mine = (ctrl = new AbortController())
    try {
      const jobs = await opts.fetchJobs(mine.signal)
      if (mine.signal.aborted) return
      observe(jobs)
      set({ jobs, loaded: true, error: null })
    } catch (err) {
      if (mine.signal.aborted || isAbort(err)) return
      set({ ...snapshot, loaded: true, error: describeError(err) })
    }
  }

  function schedule(): void {
    if (timer) clearTimeout(timer)
    timer = null
    if (!running) return
    const delay = snapshot.error ? idleMs : snapshot.jobs.some(isActiveJob) ? activeMs : idleMs
    timer = setTimeout(() => {
      timer = null
      const next = isHidden() ? Promise.resolve() : load()
      void next.then(schedule)
    }, delay)
  }

  const onVisibility = (): void => {
    if (!running || isHidden()) return
    void load().then(schedule)
  }

  function start(): void {
    running = true
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
    void load().then(schedule)
  }

  function stop(): void {
    running = false
    if (timer) clearTimeout(timer)
    timer = null
    ctrl?.abort()
    ctrl = null
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
  }

  return {
    subscribe(fn: () => void): () => void {
      listeners.add(fn)
      if (listeners.size === 1) start()
      return () => {
        listeners.delete(fn)
        if (listeners.size === 0) stop()
      }
    },
    getSnapshot: (): JobsSnapshot => snapshot,
    /** Fetches now and re-arms the timer (use after starting or cancelling something). */
    async refresh(): Promise<void> {
      await load()
      schedule()
    },
    /** Inserts/replaces a job we just received from a POST so the UI reacts immediately. */
    upsert(job: AdminJob): void {
      const rest = snapshot.jobs.filter((j) => j.id !== job.id)
      observe([job])
      set({ ...snapshot, jobs: [job, ...rest], loaded: true })
      schedule()
    },
    /** Forgets everything (sign-out). */
    reset(): void {
      seenActive.clear()
      set(EMPTY)
    }
  }
}

export type JobsStore = ReturnType<typeof createJobsStore>
