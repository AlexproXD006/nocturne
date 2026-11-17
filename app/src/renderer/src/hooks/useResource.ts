import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { resources } from '../lib/resource'
import { describeError, isAbort } from '../api/errors'

export interface ResourceState<T> {
  data: T | undefined
  error: string | null
  loading: boolean
  reload(): void
}

/** Fetches (and caches) data for a key. `key === null` skips loading. */
export function useResource<T>(key: string | null, fetcher: (signal: AbortSignal) => Promise<T>): ResourceState<T> {
  const subscribe = useCallback((fn: () => void) => (key ? resources.subscribe(key, fn) : () => undefined), [key])
  const data = useSyncExternalStore(subscribe, () => (key ? resources.peek<T>(key) : undefined))
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!key) return
    const ctrl = new AbortController()
    const force = nonce > 0
    if (!force && resources.isFresh(key)) {
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    const run = (): Promise<unknown> => resources.load(key, () => fetcher(ctrl.signal), force)
    // A request started by a previous (now unmounted / StrictMode-cleaned-up) consumer may be shared
    // with us and then aborted under us. If we are still alive, start our own request once.
    run()
      .catch((err: unknown) => {
        if (isAbort(err) && !ctrl.signal.aborted) return run()
        throw err
      })
      .catch((err: unknown) => {
        if (!ctrl.signal.aborted && !isAbort(err)) setError(describeError(err))
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false)
      })
    return () => ctrl.abort()
    // fetcher is intentionally excluded: callers pass inline closures keyed by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce])

  // `resources.invalidate()` marks the cached value stale and notifies subscribers: refetch while
  // mounted so edits made elsewhere (e.g. a renamed playlist) show up without a manual reload.
  // A cleared cache (sign-out) has no value to refresh and is left alone.
  useEffect(() => {
    if (!key) return
    return resources.subscribe(key, () => {
      if (resources.peek(key) !== undefined && !resources.isFresh(key)) setNonce((n) => n + 1)
    })
  }, [key])

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  return { data, error, loading: loading && data === undefined, reload }
}
