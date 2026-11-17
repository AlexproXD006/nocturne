export interface Throttled<A extends unknown[]> {
  (...args: A): void
  /** Runs a pending trailing call now. */
  flush(): void
  /** Drops a pending trailing call. */
  cancel(): void
}

/**
 * Leading + trailing throttle: the first call runs immediately, further calls within `ms`
 * collapse into one trailing call with the latest arguments (so the final value always lands).
 */
export function throttle<A extends unknown[]>(fn: (...args: A) => void, ms: number): Throttled<A> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: A | null = null

  const tick = (): void => {
    if (pending) {
      const args = pending
      pending = null
      fn(...args)
      timer = setTimeout(tick, ms)
    } else {
      timer = null
    }
  }

  const throttled = ((...args: A): void => {
    if (timer === null) {
      fn(...args)
      timer = setTimeout(tick, ms)
    } else {
      pending = args
    }
  }) as Throttled<A>

  throttled.flush = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    if (pending) {
      const args = pending
      pending = null
      fn(...args)
    }
  }
  throttled.cancel = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    pending = null
  }
  return throttled
}
