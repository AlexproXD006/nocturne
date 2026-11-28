import { describe, expect, it, vi } from 'vitest'
import { DownloadQueue, type JobControl } from '@/lib/offline/queue'

interface Pending {
  id: string
  ctl: JobControl
  resolve: () => void
  reject: (e: unknown) => void
}

function harness(opts: { concurrency?: number; retries?: number } = {}) {
  const started: Pending[] = []
  const persisted: { id: string; paused: boolean }[][] = []
  const q = new DownloadQueue({
    concurrency: opts.concurrency,
    retries: opts.retries ?? 0,
    persist: (p) => persisted.push(p),
    run: (id, ctl) =>
      new Promise<void>((resolve, reject) => {
        const p: Pending = { id, ctl, resolve, reject }
        started.push(p)
        ctl.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
  })
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
  return { q, started, persisted, flush }
}

describe('download queue', () => {
  it('runs at most two downloads at a time and starts the next when one finishes', async () => {
    const { q, started, flush } = harness()
    q.add(['a', 'b', 'c', 'd'])
    expect(started.map((s) => s.id)).toEqual(['a', 'b'])
    started[0]!.resolve()
    await flush()
    expect(started.map((s) => s.id)).toEqual(['a', 'b', 'c'])
    expect(q.get('a')?.state).toBe('done')
    expect(q.get('c')?.state).toBe('active')
    expect(q.get('d')?.state).toBe('queued')
  })

  it('reports progress per job', () => {
    const { q, started } = harness()
    q.add(['a'])
    started[0]!.ctl.progress(50, 200)
    expect(q.get('a')).toMatchObject({ state: 'active', bytes: 50, total: 200 })
  })

  it('pauses one job (aborting it) and resumes it from the start', async () => {
    const { q, started, flush } = harness()
    q.add(['a', 'b'])
    q.pause('a')
    await flush()
    expect(q.get('a')?.state).toBe('paused')
    expect(started[0]!.ctl.signal.aborted).toBe(true)
    expect(q.get('b')?.state).toBe('active')
    q.resume('a')
    expect(q.get('a')?.state).toBe('active')
    expect(started.filter((s) => s.id === 'a')).toHaveLength(2)
  })

  it('pause-all stops everything and keeps queued jobs waiting until resume-all', async () => {
    const { q, started, flush } = harness()
    q.add(['a', 'b', 'c'])
    q.pause()
    await flush()
    expect(q.list().map((j) => j.state)).toEqual(['paused', 'paused', 'paused'])
    expect(q.paused).toBe(true)
    q.resume()
    expect(q.list().map((j) => j.state)).toEqual(['active', 'active', 'queued'])
    expect(started).toHaveLength(4)
  })

  it('cancel aborts a running job and removes it, then the next one starts', async () => {
    const { q, started, flush } = harness({ concurrency: 1 })
    q.add(['a', 'b'])
    q.cancel('a')
    await flush()
    expect(q.get('a')).toBeUndefined()
    expect(started.map((s) => s.id)).toEqual(['a', 'b'])
    expect(q.get('b')?.state).toBe('active')
  })

  it('retries once then marks the job failed; resume retries a failed job', async () => {
    const { q, started, flush } = harness({ concurrency: 1, retries: 1 })
    q.add(['a'])
    started[0]!.reject(new Error('boom'))
    await flush()
    expect(started).toHaveLength(2) // retried
    started[1]!.reject(new Error('boom again'))
    await flush()
    expect(q.get('a')).toMatchObject({ state: 'failed', error: 'boom again' })
    q.resume('a')
    expect(q.get('a')?.state).toBe('active')
  })

  it('ignores ids that are already queued or done, persists what is left', async () => {
    const { q, started, persisted, flush } = harness()
    q.add(['a', 'b'])
    q.add(['a'])
    expect(q.list()).toHaveLength(2)
    started[0]!.resolve()
    await flush()
    expect(persisted.at(-1)).toEqual([{ id: 'b', paused: false }])
    q.pause('b')
    await flush()
    expect(persisted.at(-1)).toEqual([{ id: 'b', paused: true }])
  })

  it('restores paused ids as paused', () => {
    const { q, started } = harness()
    q.add(['a'], { paused: true })
    expect(q.get('a')?.state).toBe('paused')
    expect(started).toHaveLength(0)
  })

  it('notifies subscribers', async () => {
    const { q } = harness()
    const fn = vi.fn()
    const off = q.subscribe(fn)
    q.add(['a'])
    expect(fn).toHaveBeenCalled()
    off()
    fn.mockClear()
    q.cancelAll()
    expect(fn).not.toHaveBeenCalled()
  })
})
