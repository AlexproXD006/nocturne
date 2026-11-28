/**
 * Background download queue of the renderer (desktop, web, iOS): at most `concurrency` jobs run at once,
 * jobs can be paused / resumed / cancelled, and the ids still to do are persisted so a restart picks up
 * where it left off. Android uses the native Media3 DownloadManager instead.
 */

export type JobState = 'queued' | 'active' | 'paused' | 'done' | 'failed'

export interface Job {
  id: string
  state: JobState
  bytes: number
  total: number
  error?: string
}

export interface JobControl {
  signal: AbortSignal
  progress(bytes: number, total: number): void
}

export interface QueueDeps {
  /** Downloads one track. Resolves when it is stored; rejects on failure; must honour `signal`. */
  run(id: string, ctl: JobControl): Promise<void>
  /** Called with the ids that are still to do (queued, active, paused, failed) after every change. */
  persist?(pending: { id: string; paused: boolean }[]): void
  concurrency?: number
  /** Retries after a failure before the job is marked failed. */
  retries?: number
}

export class DownloadQueue {
  private jobs = new Map<string, Job>()
  private order: string[] = []
  private running = new Map<string, AbortController>()
  private listeners = new Set<() => void>()
  private globalPause = false
  private attempts = new Map<string, number>()
  private readonly concurrency: number
  private readonly retries: number

  constructor(private readonly deps: QueueDeps) {
    this.concurrency = Math.max(1, deps.concurrency ?? 2)
    this.retries = deps.retries ?? 1
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  list(): Job[] {
    return this.order.map((id) => ({ ...this.jobs.get(id)! }))
  }

  get(id: string): Job | undefined {
    const j = this.jobs.get(id)
    return j ? { ...j } : undefined
  }

  get paused(): boolean {
    return this.globalPause
  }

  /** Adds jobs (ids already queued, running or done are ignored). `paused` restores a persisted pause. */
  add(ids: readonly string[], opts: { paused?: boolean } = {}): void {
    let changed = false
    for (const id of ids) {
      const prev = this.jobs.get(id)
      if (prev && prev.state !== 'failed') continue
      if (!prev) this.order.push(id)
      this.attempts.delete(id)
      this.jobs.set(id, { id, state: opts.paused ? 'paused' : 'queued', bytes: 0, total: 0 })
      changed = true
    }
    if (changed) this.changed()
  }

  /** Pause one job, or every job when no id is given. */
  pause(id?: string): void {
    if (id === undefined) {
      this.globalPause = true
      for (const j of this.jobs.values()) if (j.state === 'queued') j.state = 'paused'
      for (const [rid, ctl] of this.running) {
        const j = this.jobs.get(rid)
        if (j) j.state = 'paused'
        ctl.abort()
      }
    } else {
      const j = this.jobs.get(id)
      if (!j || (j.state !== 'queued' && j.state !== 'active')) return
      const wasActive = j.state === 'active'
      j.state = 'paused'
      if (wasActive) this.running.get(id)?.abort()
    }
    this.changed()
  }

  resume(id?: string): void {
    if (id === undefined) this.globalPause = false
    for (const j of this.jobs.values()) {
      if ((id === undefined || j.id === id) && (j.state === 'paused' || j.state === 'failed')) {
        j.state = 'queued'
        j.bytes = 0
        this.attempts.delete(j.id)
        delete j.error
      }
    }
    this.changed()
  }

  /** Removes a job (aborting it when it is running). */
  cancel(id: string): void {
    if (!this.jobs.has(id)) return
    this.running.get(id)?.abort()
    this.running.delete(id)
    this.jobs.delete(id)
    this.order = this.order.filter((x) => x !== id)
    this.changed()
  }

  cancelAll(): void {
    for (const ctl of this.running.values()) ctl.abort()
    this.running.clear()
    this.jobs.clear()
    this.order = []
    this.changed()
  }

  /** Forgets finished jobs. */
  clearDone(): void {
    for (const j of [...this.jobs.values()]) if (j.state === 'done') this.cancel(j.id)
  }

  private changed(): void {
    this.pump()
    this.deps.persist?.(
      this.order.map((id) => this.jobs.get(id)!).filter((j) => j.state !== 'done').map((j) => ({ id: j.id, paused: j.state === 'paused' }))
    )
    for (const fn of [...this.listeners]) fn()
  }

  private notify(): void {
    for (const fn of [...this.listeners]) fn()
  }

  private pump(): void {
    if (this.globalPause) return
    for (const id of this.order) {
      if (this.running.size >= this.concurrency) return
      const j = this.jobs.get(id)
      if (!j || j.state !== 'queued' || this.running.has(id)) continue
      this.start(j)
    }
  }

  private start(job: Job): void {
    const ctl = new AbortController()
    this.running.set(job.id, ctl)
    job.state = 'active'
    job.bytes = 0
    const progress = (bytes: number, total: number): void => {
      if (ctl.signal.aborted) return
      job.bytes = bytes
      job.total = total
      this.notify()
    }
    let result: Promise<void>
    try {
      result = this.deps.run(job.id, { signal: ctl.signal, progress })
    } catch (e) {
      result = Promise.reject(e)
    }
    result.then(
      () => this.finish(job.id, ctl, null),
      (err: unknown) => this.finish(job.id, ctl, err)
    )
  }

  private finish(id: string, ctl: AbortController, err: unknown): void {
    if (this.running.get(id) === ctl) this.running.delete(id)
    const j = this.jobs.get(id)
    if (!j) return this.changed() // cancelled while running
    if (ctl.signal.aborted) {
      // Paused (state already 'paused'): keep it; anything else that aborted without a state change is dropped.
      return this.changed()
    }
    if (err === null) {
      j.state = 'done'
      if (j.total === 0) j.total = j.bytes
    } else {
      const n = (this.attempts.get(id) ?? 0) + 1
      this.attempts.set(id, n)
      if (n <= this.retries) {
        j.state = 'queued'
        j.bytes = 0
      } else {
        j.state = 'failed'
        j.error = err instanceof Error ? err.message : String(err)
      }
    }
    this.changed()
  }
}
