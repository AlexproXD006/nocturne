/** One word (or syllable) with its own timing. */
export interface LyricWord {
  /** Start in ms. */
  time: number
  /** End in ms (>= time). */
  end: number
  /**
   * Display text. Includes its trailing space when the next word is separate, so
   * joining `words.map(w => w.text)` reproduces the line. A word without a trailing
   * space is a syllable of the following word.
   */
  text: string
}

export interface LyricLine {
  /** Start time in ms. */
  time: number
  text: string
  /** End in ms, when the source knows it (TTML, enhanced LRC). */
  end?: number
  /** Word-level timing, when the source carries it. */
  words?: LyricWord[]
  /** Backing vocals sung alongside this line, shown smaller under it. */
  background?: { words: LyricWord[]; text: string }
  /** Singer id (TTML `ttm:agent`). */
  agent?: string
  /** Duet side: 'end' lines are right-aligned. */
  align?: 'start' | 'end'
}

export interface ParsedLyrics {
  lines: LyricLine[]
  /** True when lines carry timestamps. */
  synced: boolean
  /** True when at least one line carries word-level timing. Omitted otherwise. */
  wordSynced?: boolean
}

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
const WORD_TAG = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g
const META_TAG = /^\[([a-z#]+):(.*)\]$/i

function fractionToMs(frac: string | undefined): number {
  if (!frac) return 0
  if (frac.length === 1) return Number(frac) * 100
  if (frac.length === 2) return Number(frac) * 10
  return Number(frac)
}

/**
 * Parses LRC text. Supports multiple timestamps per line, 1–3 digit fractions,
 * the [offset:+/-ms] tag, and ignores metadata tags ([ar:], [ti:] …).
 * Lines are returned sorted by time; empty timed lines are kept as instrumental gaps.
 */
export function parseLrc(input: string | null | undefined): ParsedLyrics {
  if (!input) return { lines: [], synced: false }
  let offset = 0
  const lines: LyricLine[] = []
  let sawTimestamp = false

  for (const rawLine of input.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const meta = META_TAG.exec(line)
    if (meta && !/^\d/.test(meta[1]!)) {
      if (meta[1]!.toLowerCase() === 'offset') {
        const n = Number.parseInt(meta[2]!.trim(), 10)
        if (Number.isFinite(n)) offset = n
      }
      continue
    }
    TIME_TAG.lastIndex = 0
    const times: number[] = []
    let match: RegExpExecArray | null
    let lastEnd = 0
    while ((match = TIME_TAG.exec(line)) !== null) {
      if (match.index !== lastEnd) break // only leading timestamps count
      const min = Number(match[1])
      const sec = Number(match[2])
      times.push(min * 60_000 + sec * 1000 + fractionToMs(match[3]))
      lastEnd = TIME_TAG.lastIndex
    }
    if (times.length === 0) continue
    sawTimestamp = true
    // Enhanced LRC carries word-level tags like <00:12.34>; they become `words`.
    const body = line.slice(lastEnd)
    const enhanced = parseEnhanced(body)
    const text = enhanced ? enhanced.text : body.replace(/\s+/g, ' ').trim()
    for (const time of times) {
      if (enhanced && enhanced.words.length) {
        const shift = time - times[0]!
        lines.push({ time, text, words: enhanced.words.map((w) => ({ ...w, time: w.time + shift, end: w.end < 0 ? w.end : w.end + shift })) })
      } else lines.push({ time, text })
    }
  }

  if (!sawTimestamp) return { lines: [], synced: false }
  // The offset tag may appear after the lines it applies to, so apply it last.
  if (offset !== 0) {
    for (const l of lines) {
      l.time = Math.max(0, l.time - offset)
      if (l.words) {
        for (const w of l.words) {
          w.time = Math.max(0, w.time - offset)
          w.end = w.end < 0 ? w.end : Math.max(0, w.end - offset)
        }
      }
    }
  }
  lines.sort((a, b) => a.time - b.time)
  // Drop trailing empty lines; collapse consecutive empty lines.
  const cleaned: LyricLine[] = []
  for (const l of lines) {
    const prev = cleaned[cleaned.length - 1]
    if (!l.text && prev && !prev.text) continue
    cleaned.push(l)
  }
  while (cleaned.length && !cleaned[cleaned.length - 1]!.text) cleaned.pop()
  // Enhanced lines know where they end: the last word ends at its closing tag, or at the next line.
  let wordSynced = false
  cleaned.forEach((l, i) => {
    if (!l.words?.length) {
      delete l.words
      return
    }
    wordSynced = true
    const next = cleaned[i + 1]
    const last = l.words[l.words.length - 1]!
    if (last.end < 0) last.end = next && next.time > last.time ? Math.min(next.time, last.time + 6000) : last.time + 1500
    l.end = last.end
  })
  return wordSynced ? { lines: cleaned, synced: true, wordSynced } : { lines: cleaned, synced: true }
}

/**
 * Splits the body of an enhanced LRC line at its `<mm:ss.xx>` tags. A closing tag with no text
 * after it only sets the end of the previous word. Returns null when the line has no tags.
 * The last word's end is -1 when unknown (resolved by the caller).
 */
function parseEnhanced(body: string): { text: string; words: LyricWord[] } | null {
  WORD_TAG.lastIndex = 0
  const tags: Array<{ at: number; to: number; time: number }> = []
  let m: RegExpExecArray | null
  while ((m = WORD_TAG.exec(body)) !== null) {
    tags.push({ at: m.index, to: WORD_TAG.lastIndex, time: Number(m[1]) * 60_000 + Number(m[2]) * 1000 + fractionToMs(m[3]) })
  }
  if (tags.length === 0) return null
  const words: LyricWord[] = []
  const space = (): void => {
    const prev = words[words.length - 1]
    if (prev && !prev.text.endsWith(' ')) prev.text += ' '
  }
  const prefix = body.slice(0, tags[0]!.at).replace(/\s+/g, ' ')
  let text = prefix
  tags.forEach((tag, i) => {
    const raw = body.slice(tag.to, tags[i + 1]?.at ?? body.length).replace(/\s+/g, ' ')
    text += raw
    if (raw.trim() === '') {
      if (raw) space()
      return
    }
    if (raw.startsWith(' ')) space()
    const nextTime = tags[i + 1]?.time
    words.push({ time: tag.time, end: nextTime !== undefined ? Math.max(tag.time, nextTime) : -1, text: raw.replace(/^ /, '') })
  })
  const last = words[words.length - 1]
  if (last) last.text = last.text.replace(/ $/, '')
  const clean = text.replace(/\s+/g, ' ').trim()
  // Words must reproduce the line, so drop word timing when untimed text precedes the first tag.
  return { text: clean, words: prefix.trim() === '' ? words : [] }
}

/** Plain lyrics → untimed lines. */
export function parsePlain(input: string | null | undefined): ParsedLyrics {
  if (!input) return { lines: [], synced: false }
  const lines = input
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((t) => ({ time: 0, text: t.trim() }))
  while (lines.length && !lines[0]!.text) lines.shift()
  while (lines.length && !lines[lines.length - 1]!.text) lines.pop()
  return { lines, synced: false }
}

/** Index of the line active at `timeMs` (binary search). -1 before the first line. */
export function findActiveLine(lines: LyricLine[], timeMs: number): number {
  let lo = 0
  let hi = lines.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid]!.time <= timeMs) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/** 0..1 progress through line `index`, using its own end when known, else the next line's start (or +4s). */
export function lineProgress(lines: LyricLine[], index: number, timeMs: number, trackEndMs?: number): number {
  const line = lines[index]
  if (!line) return 0
  const next = lines[index + 1]
  const end =
    line.end !== undefined && line.end > line.time
      ? line.end
      : next
        ? next.time
        : Math.min(trackEndMs ?? line.time + 4000, line.time + 6000)
  const span = Math.max(1, end - line.time)
  return Math.min(1, Math.max(0, (timeMs - line.time) / span))
}
