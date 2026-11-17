import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createJobsStore } from '@/pages/admin/jobsStore'
import type { AdminJob } from '@/api/types'

const job = (id: string, status: AdminJob['status'], extra: Partial<AdminJob> = {}): AdminJob => ({
  id, kind: 'download', title: id, status, createdAt: '2026-01-01T00:00:00Z', ...extra
})

describe('createJobsStore', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('polls fast while jobs are active and slow otherwise, and stops when unsubscribed', async () => {
    let jobs = [job('a', 'running')]
    const fetchJobs = vi.fn(async () => jobs)
    const store = createJobsStore({ fetchJobs, isHidden: () => false })
    const off = store.subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchJobs).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1500)
    expect(fetchJobs).toHaveBeenCalledTimes(2)
    jobs = [job('a', 'done')]
    await vi.advanceTimersByTimeAsync(1500)
    expect(fetchJobs).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1500)
    expect(fetchJobs).toHaveBeenCalledTimes(3) // now idle: 10 s
    await vi.advanceTimersByTimeAsync(8500)
    expect(fetchJobs).toHaveBeenCalledTimes(4)
    off()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchJobs).toHaveBeenCalledTimes(4)
  })

  it('pauses while hidden and resumes on visibilitychange', async () => {
    let hidden = true
    const fetchJobs = vi.fn(async () => [job('a', 'running')])
    const store = createJobsStore({ fetchJobs, isHidden: () => hidden })
    const off = store.subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchJobs).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetchJobs).toHaveBeenCalledTimes(1)
    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchJobs).toHaveBeenCalledTimes(2)
    off()
  })

  it('reports a job once when it finishes after being seen active', async () => {
    let jobs = [job('a', 'queued'), job('old', 'done')]
    const onJobFinished = vi.fn()
    const store = createJobsStore({ fetchJobs: async () => jobs, onJobFinished, isHidden: () => false })
    const off = store.subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(onJobFinished).not.toHaveBeenCalled()
    jobs = [job('a', 'done'), job('old', 'done')]
    await vi.advanceTimersByTimeAsync(1500)
    expect(onJobFinished).toHaveBeenCalledTimes(1)
    expect(onJobFinished.mock.calls[0]![0].id).toBe('a')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(onJobFinished).toHaveBeenCalledTimes(1)
    off()
  })

  it('keeps jobs and exposes the error when a poll fails', async () => {
    let fail = false
    const store = createJobsStore({
      fetchJobs: async () => {
        if (fail) throw new Error('boom')
        return [job('a', 'done')]
      },
      isHidden: () => false
    })
    const off = store.subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    fail = true
    await store.refresh()
    expect(store.getSnapshot().jobs).toHaveLength(1)
    expect(store.getSnapshot().error).toBe('boom')
    fail = false
    await store.refresh()
    expect(store.getSnapshot().error).toBeNull()
    off()
  })

  it('upsert adds/replaces a job immediately; reset clears', async () => {
    const store = createJobsStore({ fetchJobs: async () => [], isHidden: () => false })
    store.upsert(job('x', 'queued'))
    store.upsert(job('x', 'running'))
    expect(store.getSnapshot().jobs).toHaveLength(1)
    expect(store.getSnapshot().jobs[0]!.status).toBe('running')
    store.reset()
    expect(store.getSnapshot().jobs).toHaveLength(0)
    expect(store.getSnapshot().loaded).toBe(false)
  })
})
