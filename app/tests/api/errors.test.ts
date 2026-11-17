import { describe, expect, it } from 'vitest'
import { ApiError, describeError, isAbort, type ApiErrorCode } from '@/api/errors'

describe('ApiError', () => {
  it('carries code, message, status and retryAfter', () => {
    const e = new ApiError('rate_limited', 'slow down', 429, 12)
    expect(e).toBeInstanceOf(Error)
    expect(e).toBeInstanceOf(ApiError)
    expect(e.name).toBe('ApiError')
    expect(e.code).toBe('rate_limited')
    expect(e.message).toBe('slow down')
    expect(e.status).toBe(429)
    expect(e.retryAfter).toBe(12)
  })

  it('defaults status to 0 and retryAfter to undefined', () => {
    const e = new ApiError('network', 'x')
    expect(e.status).toBe(0)
    expect(e.retryAfter).toBeUndefined()
  })

  describe('fromStatus', () => {
    it.each<[number, ApiErrorCode]>([
      [400, 'bad_request'],
      [401, 'unauthorized'],
      [402, 'bad_request'],
      [403, 'forbidden'],
      [404, 'not_found'],
      [409, 'bad_request'],
      [422, 'bad_request'],
      [429, 'rate_limited'],
      [500, 'server'],
      [502, 'server'],
      [503, 'server'],
      [599, 'server']
    ])('maps %i to %s', (status, code) => {
      const e = ApiError.fromStatus(status)
      expect(e.code).toBe(code)
      expect(e.status).toBe(status)
      expect(e.message.length).toBeGreaterThan(0)
    })

    it('prefers a server-provided message over the default', () => {
      expect(ApiError.fromStatus(404, 'Album gone').message).toBe('Album gone')
    })

    it('falls back to the default message when the given one is empty', () => {
      expect(ApiError.fromStatus(404, '').message).toBe("We couldn't find that.")
      expect(ApiError.fromStatus(404, undefined).message).toBe("We couldn't find that.")
    })

    it('has a friendly default for every code', () => {
      const msgs = [401, 403, 404, 429, 500, 400].map((s) => ApiError.fromStatus(s).message)
      expect(new Set(msgs).size).toBe(6)
      expect(ApiError.fromStatus(401).message).toMatch(/sign in again/i)
      expect(ApiError.fromStatus(403).message).toMatch(/access/i)
      expect(ApiError.fromStatus(429).message).toMatch(/too many/i)
      expect(ApiError.fromStatus(500).message).toMatch(/server/i)
      expect(ApiError.fromStatus(400).message).toBe('Something went wrong.')
    })

    it('passes retryAfter through', () => {
      expect(ApiError.fromStatus(429, undefined, 7).retryAfter).toBe(7)
    })
  })
})

describe('isAbort', () => {
  it('recognizes ApiError aborted', () => {
    expect(isAbort(new ApiError('aborted', 'cancelled'))).toBe(true)
  })

  it('does not treat other ApiErrors as aborts', () => {
    expect(isAbort(new ApiError('timeout', 'slow'))).toBe(false)
    expect(isAbort(new ApiError('network', 'down'))).toBe(false)
  })

  it('recognizes DOM AbortError', () => {
    expect(isAbort(new DOMException('x', 'AbortError'))).toBe(true)
  })

  it('rejects other DOMExceptions and unrelated values', () => {
    expect(isAbort(new DOMException('x', 'NotFoundError'))).toBe(false)
    expect(isAbort(new Error('AbortError'))).toBe(false)
    expect(isAbort(null)).toBe(false)
    expect(isAbort(undefined)).toBe(false)
    expect(isAbort('aborted')).toBe(false)
  })
})

describe('describeError', () => {
  it('uses ApiError messages', () => {
    expect(describeError(new ApiError('server', 'boom'))).toBe('boom')
  })

  it('uses plain Error messages', () => {
    expect(describeError(new Error('nope'))).toBe('nope')
  })

  it('falls back for empty messages and non-errors', () => {
    expect(describeError(new Error(''))).toBe('Something went wrong.')
    expect(describeError('str')).toBe('Something went wrong.')
    expect(describeError(null)).toBe('Something went wrong.')
    expect(describeError({ message: 'obj' })).toBe('Something went wrong.')
  })
})
