import type { LyricLine, LyricWord } from './lrc'

/** Instrumental gaps at least this long get a "• • •" indicator. */
export const GAP_MIN_MS = 6000

/** Index of the last word that has started at `timeMs` (binary search), -1 before the first. */
export function findActiveWord(words: readonly LyricWord[], timeMs: number): number {
  let lo = 0
  let hi = words.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (words[mid]!.time <= timeMs) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}

/** 0..1 progress through a word. Zero-length words are complete as soon as they start. */
export function wordProgress(word: LyricWord, timeMs: number): number {
  if (timeMs <= word.time) return 0
  const span = word.end - word.time
  if (span <= 0) return 1
  return Math.min(1, (timeMs - word.time) / span)
}

export interface LyricGap {
  /** Index of the line that follows the gap. */
  before: number
  start: number
  end: number
}

/**
 * Instrumental gaps (>= `minMs`) between a line's end and the next line's start, plus an intro gap.
 * Only lines that know their end can open a gap, so plain LRC (no ends) never produces any.
 */
export function computeGaps(lines: readonly LyricLine[], minMs = GAP_MIN_MS): LyricGap[] {
  const gaps: LyricGap[] = []
  if (!lines.some((l) => l.end !== undefined)) return gaps
  const first = lines[0]
  if (first && first.time >= minMs) gaps.push({ before: 0, start: 0, end: first.time })
  let reach = first?.end ?? first?.time ?? 0
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.time - reach >= minMs && lines[i - 1]!.end !== undefined) gaps.push({ before: i, start: reach, end: line.time })
    reach = Math.max(reach, line.end ?? line.time)
  }
  return gaps
}

/** Index into `gaps` of the gap containing `timeMs`, or -1. Gaps are sorted and disjoint. */
export function findGap(gaps: readonly LyricGap[], timeMs: number): number {
  let lo = 0
  let hi = gaps.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const g = gaps[mid]!
    if (timeMs < g.start) hi = mid - 1
    else if (timeMs >= g.end) lo = mid + 1
    else return mid
  }
  return -1
}
