import { useCallback, useEffect, useRef, useState } from 'react'
import type { Page } from '../api/types'
import { resources } from '../lib/resource'
import { describeError, isAbort } from '../api/errors'

export interface PagedState<T> {
  items: T[]
  total: number
  loading: boolean
  error: string | null
  done: boolean
  loadMore(): void
  reload(): void
  /** Attach to an element at the end of the list for infinite scroll. */
  sentinel: (el: HTMLElement | null) => void
}

export function usePaged<T>(key: string, fetchPage: (offset: number, limit: number, signal: AbortSignal) => Promise<Page<T>>, limit = 50): PagedState<T> {
  const [items, setItems] = useState<T[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [nonce, setNonce] = useState(0)
  const busy = useRef(false)
  const offsetRef = useRef(0)
  const ctrlRef = useRef<AbortController | null>(null)
  const fetchRef = useRef(fetchPage)
  fetchRef.current = fetchPage

  const load = useCallback(() => {
    if (busy.current) return
    busy.current = true
    setLoading(true)
    const ctrl = (ctrlRef.current ??= new AbortController())
    fetchRef
      .current(offsetRef.current, limit, ctrl.signal)
      .then((page) => {
        if (ctrl.signal.aborted) return
        offsetRef.current += page.items.length
        setItems((prev) => [...prev, ...page.items])
        setTotal(page.total)
        setDone(page.items.length < limit || offsetRef.current >= page.total)
        setError(null)
      })
      .catch((err: unknown) => {
        if (!ctrl.signal.aborted && !isAbort(err)) setError(describeError(err))
      })
      .finally(() => {
        // An aborted request must not release the lock held by its replacement.
        if (ctrlRef.current === ctrl) busy.current = false
        if (!ctrl.signal.aborted) setLoading(false)
      })
  }, [limit])

  useEffect(() => {
    ctrlRef.current?.abort()
    ctrlRef.current = new AbortController()
    busy.current = false
    offsetRef.current = 0
    setItems([])
    setTotal(0)
    setDone(false)
    setError(null)
    load()
    return () => ctrlRef.current?.abort()
  }, [key, nonce, load])

  // Paged lists are not stored in the resource cache, but share its key space so that
  // `resources.invalidate('library:playlists')` (after creating / deleting a playlist…) reloads them.
  useEffect(() => resources.subscribe(key, () => setNonce((n) => n + 1)), [key])

  const observer = useRef<IntersectionObserver | null>(null)
  const sentinel = useCallback(
    (el: HTMLElement | null) => {
      observer.current?.disconnect()
      if (!el) return
      observer.current = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) load()
      }, { rootMargin: '600px' })
      observer.current.observe(el)
    },
    [load]
  )

  return {
    items,
    total,
    loading,
    error,
    done,
    loadMore: load,
    reload: () => setNonce((n) => n + 1),
    sentinel
  }
}
