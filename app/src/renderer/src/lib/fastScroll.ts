/** Pure helpers for the fast-scroll handle (see components/FastScroll.tsx). */

export type SortKey = 'title' | 'artist' | 'album'

/** The list is long enough to deserve a handle: many items, or taller than three screens. */
export function isLongList(count: number, listHeight: number, viewportHeight: number): boolean {
  if (count > 60) return true
  return viewportHeight > 0 && listHeight > viewportHeight * 3
}

export const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0)

/** Handle position (0..1 along its track) to scroll offset. */
export function fractionToScrollTop(fraction: number, scrollHeight: number, clientHeight: number): number {
  return clamp01(fraction) * Math.max(0, scrollHeight - clientHeight)
}

/** Scroll offset to handle position (0..1). */
export function scrollTopToFraction(scrollTop: number, scrollHeight: number, clientHeight: number): number {
  const range = scrollHeight - clientHeight
  return range > 0 ? clamp01(scrollTop / range) : 0
}

/** Handle position (0..1) to the item index it points at (proportional, last position = last item). */
export function fractionToIndex(fraction: number, count: number): number {
  if (count <= 0) return 0
  return Math.min(count - 1, Math.round(clamp01(fraction) * (count - 1)))
}

/** A–Z bucket for a string ("#" for digits, symbols and anything not starting with a letter). */
export function letterFor(text: string | undefined | null): string {
  const first = (text ?? '').trim().normalize('NFD').replace(/[̀-ͯ]/g, '').charAt(0).toUpperCase()
  return first >= 'A' && first <= 'Z' ? first : '#'
}

/** Text of the sort field for an item, used to pick its letter. */
export function sortText(item: { title?: string; artists?: { name: string }[]; album?: { title: string } | null }, key: SortKey): string {
  if (key === 'artist') return item.artists?.[0]?.name ?? ''
  if (key === 'album') return item.album?.title ?? ''
  return item.title ?? ''
}

/**
 * Bubble text while dragging: the letter when the list is sorted alphabetically (`letterAt` given),
 * otherwise the position "845 / 1.795" (`fmt` formats numbers for the active locale).
 */
export function bubbleLabel(index: number, total: number, letterAt: ((i: number) => string) | undefined, fmt: (n: number) => string = String): string {
  if (letterAt) return letterAt(index)
  return `${fmt(index + 1)} / ${fmt(total)}`
}
