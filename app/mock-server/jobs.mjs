// In-memory background jobs for the admin API. A job is a list of steps; every tick runs one
// step of every active job (queued -> running -> done), so progress is visible over time.
// The timer is unref'ed and cleared on stop(), and `tickMs: 0` disables it so tests can drive
// the engine manually with tick().

import { HttpError } from './auth.mjs'

const MAX_JOBS = 200
const FINISHED = new Set(['done', 'failed', 'cancelled'])

export class JobEngine {
  /** @param {{now:()=>number, tickMs:number}} opts */
  constructor({ now, tickMs }) {
    this.now = now
    this.tickMs = tickMs
    this.jobs = new Map() // id -> { pub, steps, cursor, onCancel }
    this.counter = 0
    this.timer = null
    this.stopped = false
  }

  /**
   * @param {{kind:string, source?:string, title:string, trackIds?:string[], steps:{message:string, progress:number, run?:()=>void}[], onCancel?:()=>void}} spec
   *   Each step runs on its own tick; `progress` (0..1) is reported after it ran. A step may throw to fail the job.
   */
  create(spec) {
    const id = `job-${String(++this.counter).padStart(4, '0')}`
    const pub = {
      id,
      kind: spec.kind,
      ...(spec.source ? { source: spec.source } : {}),
      title: spec.title,
      status: 'queued',
      progress: 0,
      message: 'Queued',
      ...(spec.trackIds ? { trackIds: spec.trackIds } : {}),
      createdAt: new Date(this.now()).toISOString()
    }
    this.jobs.set(id, { pub, steps: spec.steps, cursor: 0, onCancel: spec.onCancel })
    this.#trim()
    this.#ensureTimer()
    return pub
  }

  #trim() {
    if (this.jobs.size <= MAX_JOBS) return
    for (const [id, j] of this.jobs) {
      if (this.jobs.size <= MAX_JOBS) break
      if (FINISHED.has(j.pub.status)) this.jobs.delete(id)
    }
  }

  get(id) {
    return this.jobs.get(id)?.pub ?? null
  }

  /** Newest first, at most `limit`. */
  list(limit = 100) {
    return [...this.jobs.values()].map((j) => j.pub).reverse().slice(0, limit)
  }

  activeCount() {
    let n = 0
    for (const j of this.jobs.values()) if (!FINISHED.has(j.pub.status)) n++
    return n
  }

  hasActive(kind) {
    for (const j of this.jobs.values()) if (j.pub.kind === kind && !FINISHED.has(j.pub.status)) return true
    return false
  }

  cancel(id) {
    const j = this.jobs.get(id)
    if (!j) throw new HttpError(404, 'Job not found.')
    if (FINISHED.has(j.pub.status)) throw new HttpError(409, 'The job has already finished.')
    j.pub.status = 'cancelled'
    j.pub.message = 'Cancelled'
    j.pub.finishedAt = new Date(this.now()).toISOString()
    j.steps = []
    try {
      j.onCancel?.()
    } catch {
      /* best effort */
    }
  }

  /** Runs one step of every active job. */
  tick() {
    for (const j of this.jobs.values()) {
      const { pub } = j
      if (FINISHED.has(pub.status)) continue
      if (pub.status === 'queued') {
        pub.status = 'running'
        pub.message = 'Starting'
        continue
      }
      const step = j.steps[j.cursor++]
      try {
        step?.run?.()
      } catch (err) {
        pub.status = 'failed'
        pub.error = err instanceof Error ? err.message : 'The job failed.'
        pub.message = 'Failed'
        pub.finishedAt = new Date(this.now()).toISOString()
        continue
      }
      if (step) {
        pub.message = step.message
        pub.progress = step.progress
      }
      if (j.cursor >= j.steps.length) {
        pub.status = 'done'
        pub.progress = 1
        pub.finishedAt = new Date(this.now()).toISOString()
      }
    }
    if (this.activeCount() === 0) this.#clearTimer()
  }

  #ensureTimer() {
    if (this.timer || this.stopped || !(this.tickMs > 0)) return
    this.timer = setInterval(() => this.tick(), this.tickMs)
    this.timer.unref()
  }

  #clearTimer() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Stops all timers; no job advances afterwards. */
  stop() {
    this.stopped = true
    this.#clearTimer()
  }
}
