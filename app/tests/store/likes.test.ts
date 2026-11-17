import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLikes } from '@/store/likes'

const s = (): ReturnType<typeof useLikes.getState> => useLikes.getState()

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  s().reset()
})

describe('isLiked', () => {
  it('falls back to the server value', () => {
    expect(s().isLiked('t1', true)).toBe(true)
    expect(s().isLiked('t1', false)).toBe(false)
    expect(s().isLiked('t1')).toBe(false)
    expect(s().isLiked('t1', undefined)).toBe(false)
  })

  it('local overrides win over the server value', () => {
    useLikes.setState({ overrides: { t1: false, t2: true } })
    expect(s().isLiked('t1', true)).toBe(false)
    expect(s().isLiked('t2', false)).toBe(true)
  })
})

describe('toggle', () => {
  it('optimistically flips before the request completes, then keeps the new state', async () => {
    const d = deferred()
    const send = vi.fn(() => d.promise)
    const p = s().toggle('t1', false, send)
    expect(s().isLiked('t1', false)).toBe(true) // optimistic
    expect(s().pending.t1).toBe(true)
    expect(send).toHaveBeenCalledWith('t1', true)
    d.resolve()
    await expect(p).resolves.toBe(true)
    expect(s().isLiked('t1', false)).toBe(true)
    expect(s().pending.t1).toBeUndefined()
  })

  it('unlikes', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    await expect(s().toggle('t1', true, send)).resolves.toBe(false)
    expect(send).toHaveBeenCalledWith('t1', false)
    expect(s().isLiked('t1', true)).toBe(false)
  })

  it('reverts to the previous value and rethrows when the request fails', async () => {
    const err = new Error('network')
    const d = deferred()
    const p = s().toggle('t1', false, () => d.promise)
    expect(s().isLiked('t1', false)).toBe(true)
    d.reject(err)
    await expect(p).rejects.toBe(err)
    expect(s().isLiked('t1', false)).toBe(false)
    expect(s().overrides.t1).toBe(false)
    expect(s().pending.t1).toBeUndefined()
  })

  it('reverts an unlike to liked on failure', async () => {
    await expect(s().toggle('t1', true, () => Promise.reject(new Error('x')))).rejects.toThrow('x')
    expect(s().isLiked('t1', true)).toBe(true)
  })

  it('ignores a second toggle while one is pending (returns the current value, sends nothing)', async () => {
    const d = deferred()
    const send = vi.fn(() => d.promise)
    const first = s().toggle('t1', false, send)
    const second = await s().toggle('t1', true, send)
    expect(second).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
    expect(s().isLiked('t1', false)).toBe(true)
    d.resolve()
    await first
  })

  it('allows another toggle once the previous settled', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    await s().toggle('t1', false, send)
    await s().toggle('t1', true, send)
    expect(send.mock.calls).toEqual([['t1', true], ['t1', false]])
    expect(s().isLiked('t1', false)).toBe(false)
  })

  it('tracks tracks independently', async () => {
    const d = deferred()
    const a = s().toggle('a', false, () => d.promise)
    await s().toggle('b', false, vi.fn().mockResolvedValue(undefined))
    expect(s().pending.a).toBe(true)
    expect(s().pending.b).toBeUndefined()
    expect(s().isLiked('a', false)).toBe(true)
    expect(s().isLiked('b', false)).toBe(true)
    d.resolve()
    await a
  })

  it('a failure on one track does not touch another', async () => {
    await s().toggle('a', false, vi.fn().mockResolvedValue(undefined))
    await expect(s().toggle('b', false, () => Promise.reject(new Error('x')))).rejects.toThrow()
    expect(s().isLiked('a', false)).toBe(true)
  })
})

describe('reset', () => {
  it('clears overrides and pending flags', async () => {
    await s().toggle('a', false, vi.fn().mockResolvedValue(undefined))
    useLikes.setState({ pending: { z: true } })
    s().reset()
    expect(s().overrides).toEqual({})
    expect(s().pending).toEqual({})
    expect(s().isLiked('a', false)).toBe(false)
  })
})
