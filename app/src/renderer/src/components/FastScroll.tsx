import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../i18n'
import { formatNumber } from '../i18n/format'
import { bubbleLabel, fractionToIndex, fractionToScrollTop, isLongList, scrollTopToFraction } from '../lib/fastScroll'
import { cx } from './common'

const IDLE_MS = 1500
const THUMB_H = 56
const INSET_TOP = 72
const INSET_BOTTOM = 20

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY
    if (oy === 'auto' || oy === 'scroll') return p
  }
  return null
}

interface Geo {
  top: number
  right: number
  height: number
}

/**
 * Draggable fast-scroll handle for long lists. It drives the page's own scroll container (found from `anchorRef`),
 * so it works with whatever the list renders. Only the handle captures pointers: swiping the list is untouched.
 */
export function FastScroll({
  anchorRef,
  count,
  total,
  letterAt
}: {
  anchorRef: RefObject<HTMLElement | null>
  /** Items rendered so far. */
  count: number
  /** Items on the server when the list is paged (defaults to `count`). */
  total?: number
  /** Given when the list is sorted alphabetically: the letter for an item index. */
  letterAt?: (index: number) => string
}): ReactNode {
  const tr = useT()
  const scroller = useRef<HTMLElement | null>(null)
  const [long, setLong] = useState(false)
  const [geo, setGeo] = useState<Geo>({ top: 0, right: 0, height: 0 })
  const [fraction, setFraction] = useState(0)
  const [shown, setShown] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [focused, setFocused] = useState(false)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const grab = useRef(0)
  const all = Math.max(total ?? 0, count)

  const measure = useCallback(() => {
    const el = scroller.current
    const anchor = anchorRef.current
    if (!el || !anchor) return
    const r = el.getBoundingClientRect()
    setGeo((g) => (g.top === r.top && g.right === r.right && g.height === r.height ? g : { top: r.top, right: r.right, height: r.height }))
    setFraction(scrollTopToFraction(el.scrollTop, el.scrollHeight, el.clientHeight))
    setLong(isLongList(count, anchor.offsetHeight, el.clientHeight))
  }, [anchorRef, count])

  const poke = useCallback(() => {
    setShown(true)
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setShown(false), IDLE_MS)
  }, [])

  // The anchor ref is attached after this component's own effects run, so look the scroller up in a passive effect.
  const [host, setHost] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const el = scrollParent(anchorRef.current)
    scroller.current = el
    setHost(el)
    measure()
  }, [anchorRef, measure, count])

  useEffect(() => {
    const el = host
    if (!el) return
    const onScroll = (): void => {
      measure()
      poke()
    }
    const onMove = (e: PointerEvent): void => {
      if (e.pointerType !== 'mouse') return
      if (e.clientX > el.getBoundingClientRect().right - 48) poke()
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('pointermove', onMove)
    window.addEventListener('resize', measure)
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    ro?.observe(el)
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('pointermove', onMove)
      window.removeEventListener('resize', measure)
      ro?.disconnect()
      clearTimeout(hideTimer.current)
    }
  }, [host, measure, poke])

  const trackTop = geo.top + INSET_TOP
  const trackH = Math.max(THUMB_H, geo.height - INSET_TOP - INSET_BOTTOM)
  const travel = trackH - THUMB_H
  const index = fractionToIndex(fraction, all)
  const label = bubbleLabel(index, all, letterAt, (n) => formatNumber(n, { useGrouping: 'always' }))

  const scrollToFraction = (f: number): void => {
    const el = scroller.current
    if (!el) return
    el.scrollTop = fractionToScrollTop(f, el.scrollHeight, el.clientHeight)
    measure()
  }

  const onDown = (e: RPointerEvent<HTMLDivElement>): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    grab.current = e.clientY - (trackTop + fraction * travel)
    setDragging(true)
    clearTimeout(hideTimer.current)
    setShown(true)
    e.preventDefault()
  }
  const onMove = (e: RPointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    scrollToFraction(travel > 0 ? (e.clientY - grab.current - trackTop) / travel : 0)
  }
  const onUp = (): void => {
    if (!dragging) return
    setDragging(false)
    poke()
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const el = scroller.current
    if (!el) return
    const page = el.clientHeight * 0.9
    const by: Record<string, number> = { ArrowDown: 56, ArrowUp: -56, PageDown: page, PageUp: -page }
    if (e.key === 'Home') el.scrollTop = 0
    else if (e.key === 'End') el.scrollTop = el.scrollHeight
    else if (e.key in by) el.scrollTop += by[e.key]!
    else return
    e.preventDefault()
    measure()
    poke()
  }

  if (!long || typeof document === 'undefined') return null
  const visible = shown || dragging || focused
  const thumbTop = trackTop + fraction * travel
  const letterMode = Boolean(letterAt)

  return createPortal(
    <div
      className="pointer-events-none fixed z-40"
      style={{ top: thumbTop, left: geo.right - 44, width: 44, height: THUMB_H }}
      data-fast-scroll=""
    >
      <div
        role="scrollbar"
        aria-label={tr('fs.label')}
        aria-orientation="vertical"
        aria-valuemin={1}
        aria-valuemax={all}
        aria-valuenow={index + 1}
        aria-valuetext={label}
        tabIndex={0}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={onKey}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className={cx(
          'fs-handle absolute inset-0 flex cursor-grab touch-none items-center justify-end pr-1 outline-none select-none',
          'transition-opacity duration-200 focus-visible:[&>span]:ring-2 focus-visible:[&>span]:ring-accent',
          visible ? 'pointer-events-auto opacity-100' : 'opacity-0',
          dragging && 'cursor-grabbing'
        )}
      >
        <span
          className={cx(
            'block rounded-full border border-white/25 bg-[rgb(170_210_255_/_0.85)] shadow-[0_2px_10px_rgb(0_0_0_/_0.45)] transition-[width] duration-150',
            dragging ? 'h-12 w-2.5' : 'h-12 w-1.5'
          )}
        />
        {dragging && (
          <span
            aria-hidden
            className={cx(
              'pointer-events-none absolute top-1/2 right-7 flex h-14 -translate-y-1/2 items-center justify-center rounded-2xl border border-white/20 px-4 whitespace-nowrap text-fg shadow-xl shadow-black/50',
              'bg-[rgb(18_26_44_/_0.62)] backdrop-blur-xl backdrop-saturate-150',
              letterMode ? 'min-w-14 text-3xl font-bold text-[rgb(170_210_255)]' : 'text-base font-semibold tabular-nums'
            )}
          >
            {label}
          </span>
        )}
      </div>
    </div>,
    document.body
  )
}
