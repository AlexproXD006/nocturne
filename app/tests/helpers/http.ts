import { vi } from 'vitest'

export interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
  rawBody: string | undefined
  signal: AbortSignal | undefined
  init: RequestInit
}

export type Handler = (call: Call, index: number) => Response | Promise<Response> | never

export interface FakeFetch {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>
  calls: Call[]
  mock: ReturnType<typeof vi.fn>['mock']
}

export function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...init.headers }
  })
}

export function textResponse(body: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(body, { status: init.status ?? 200, headers: { 'Content-Type': 'text/html', ...init.headers } })
}

export function emptyResponse(status = 204, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers })
}

/** A promise that never settles on its own but rejects with an AbortError when the signal aborts. */
export function hangUntilAbort(signal: AbortSignal | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    const fail = (): void => reject(new DOMException('aborted', 'AbortError'))
    if (signal?.aborted) fail()
    else signal?.addEventListener('abort', fail, { once: true })
  })
}

/**
 * Builds a fetch double. `handler` receives a normalized view of each call and may return a
 * Response, a promise, or throw/reject to simulate network failure.
 */
export function fakeFetch(handler: Handler): FakeFetch {
  const calls: Call[] = []
  const impl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const rawBody = typeof init.body === 'string' ? init.body : undefined
    let body: unknown = undefined
    if (rawBody !== undefined) {
      try {
        body = JSON.parse(rawBody)
      } catch {
        body = rawBody
      }
    }
    const call: Call = {
      url: String(input),
      method: (init.method ?? 'GET').toUpperCase(),
      headers: { ...(init.headers as Record<string, string> | undefined) },
      body,
      rawBody,
      signal: init.signal ?? undefined,
      init
    }
    calls.push(call)
    return handler(call, calls.length - 1)
  })
  const f = impl as unknown as FakeFetch
  f.calls = calls
  return f
}

/** Queue-style fetch: each call consumes the next scripted step. */
export function scriptedFetch(steps: Array<Response | Error | ((call: Call) => Response | Promise<Response>)>): FakeFetch {
  return fakeFetch((call, i) => {
    const step = steps[i]
    if (step === undefined) throw new Error(`Unexpected fetch #${i + 1}: ${call.method} ${call.url}`)
    if (step instanceof Error) throw step
    if (typeof step === 'function') return step(call)
    return step
  })
}

/** Lets pending microtasks / resolved promises run. */
export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}
