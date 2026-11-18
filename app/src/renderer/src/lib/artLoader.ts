/**
 * Viewport-driven cover loading for long lists.
 *
 * - An IntersectionObserver (root = the list's scroll container, ~1 screen of margin) tells which covers are near.
 * - Near covers queue for a slot; at most MAX_ACTIVE downloads run at once, and the queue serves the covers that
 *   are really on screen first (newest first), so jumping to the bottom of a 1,800-row playlist loads what you see.
 * - Covers that scroll away before they finished are cancelled (their `src` is dropped and the slot is freed).
 */
export const MAX_ACTIVE = 6
const STALL_MS = 12_000

export interface ArtJob {
  el: Element
  /** Called when the cover may start downloading. */
  grant: () => void
  /** Called when a not-yet-finished download is abandoned (scrolled away). */
  cancel: () => void
  seq: number
  state: 'idle' | 'queued' | 'active' | 'done'
  timer?: ReturnType<typeof setTimeout>
}

let seq = 0
let active = 0
const pending = new Set<ArtJob>()
const observers = new Map<Element | null, IntersectionObserver>()
const jobs = new WeakMap<Element, ArtJob>()

export const hasObserver = (): boolean => typeof IntersectionObserver !== 'undefined'

/** Nearest vertically scrolling ancestor (skips horizontal carousels, which would clip the margin away). */
export function scrollRoot(el: Element): Element | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const cs = getComputedStyle(p)
    const y = cs.overflowY === 'auto' || cs.overflowY === 'scroll'
    const x = cs.overflowX === 'auto' || cs.overflowX === 'scroll'
    if (y && !(x && p.scrollWidth > p.clientWidth + 1)) return p
  }
  return null
}

/** Distance (px) from the element to the root's visible area; 0 when on screen. */
function distance(el: Element, root: Element | null): number {
  const r = el.getBoundingClientRect()
  const b = root ? root.getBoundingClientRect() : { top: 0, bottom: innerHeight, left: 0, right: innerWidth }
  const dy = Math.max(b.top - r.bottom, r.top - b.bottom, 0)
  const dx = Math.max(b.left - r.right, r.left - b.right, 0)
  return dy + dx
}

/** Next job: what is on screen first (top to bottom), then the nearest margin covers (newest first on ties). */
function pickNext(): ArtJob | null {
  let best: ArtJob | null = null
  let bestD = Infinity
  let bestTop = Infinity
  for (const j of pending) {
    const root = rootOf.get(j.el) ?? null
    const d = distance(j.el, root)
    const top = j.el.getBoundingClientRect().top
    const better = !best || d < bestD || (d === bestD && (d === 0 ? top < bestTop : j.seq > best.seq))
    if (better) {
      best = j
      bestD = d
      bestTop = top
    }
  }
  return best
}

function pump(): void {
  while (active < MAX_ACTIVE && pending.size) {
    const job = pickNext()
    if (!job) return
    pending.delete(job)
    job.state = 'active'
    active++
    job.timer = setTimeout(() => finish(job), STALL_MS)
    job.grant()
  }
}

const rootOf = new WeakMap<Element, Element | null>()

/** Mark a job's download as finished (load or error) and free its slot. */
export function finish(job: ArtJob): void {
  if (job.state === 'active') active--
  if (job.timer) clearTimeout(job.timer)
  job.state = 'done'
  pump()
}

function enter(job: ArtJob): void {
  if (job.state !== 'idle') return
  job.state = 'queued'
  job.seq = ++seq
  pending.add(job)
}

function leave(job: ArtJob): void {
  if (job.state === 'queued') {
    pending.delete(job)
    job.state = 'idle'
  } else if (job.state === 'active') {
    active--
    if (job.timer) clearTimeout(job.timer)
    job.state = 'idle'
    job.cancel()
    pump()
  }
}

function observerFor(root: Element | null): IntersectionObserver {
  let io = observers.get(root)
  if (!io) {
    io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const job = jobs.get(e.target)
          if (!job) continue
          if (e.isIntersecting) enter(job)
          else leave(job)
        }
        pump() // after the whole batch is queued, so the priority order sees every candidate
      },
      { root, rootMargin: '100% 100% 100% 100%' }
    )
    observers.set(root, io)
  }
  return io
}

/** Start tracking an element; returns the job and a stop function. Call finish(job) when its image loaded/failed. */
export function track(el: Element, grant: () => void, cancel: () => void): { job: ArtJob; stop: () => void } {
  const job: ArtJob = { el, grant, cancel, seq: 0, state: 'idle' }
  const root = scrollRoot(el)
  rootOf.set(el, root)
  jobs.set(el, job)
  const io = observerFor(root)
  io.observe(el)
  return {
    job,
    stop: () => {
      io.unobserve(el)
      jobs.delete(el)
      rootOf.delete(el)
      if (job.state === 'queued') pending.delete(job)
      if (job.state === 'active') {
        active--
        if (job.timer) clearTimeout(job.timer)
        pump()
      }
      job.state = 'idle'
    }
  }
}

/** Test helper. */
export function _stats(): { active: number; pending: number } {
  return { active, pending: pending.size }
}
