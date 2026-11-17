import type { LyricLine, LyricWord, ParsedLyrics } from './lrc'

/** Largest TTML / LRC document accepted (matches the server limit). */
export const MAX_LYRICS_BYTES = 1024 * 1024

const EMPTY: ParsedLyrics = { lines: [], synced: false }

export interface TtmlMetadata {
  title?: string
  artist?: string
  album?: string
  durationMs?: number
}

export type ValidationResult = { ok: true } | { ok: false; message: string }

export interface TtmlInspection {
  /** Set when the document is rejected. */
  error?: string
  lyrics: ParsedLyrics
  metadata: TtmlMetadata
  /** Number of `<p>` elements carrying a valid `begin` (the server's acceptance rule). */
  timedParagraphs: number
}

// ---------------------------------------------------------------------------------------------
// Safety: the document is checked as a raw string before it ever reaches the XML parser.

const DOCTYPE_OR_ENTITY = /<!\s*(DOCTYPE|ENTITY)/i

function utf8Length(s: string): number {
  if (s.length > MAX_LYRICS_BYTES) return s.length // already over: UTF-8 is never shorter than UTF-16 length
  if (s.length * 3 <= MAX_LYRICS_BYTES) return s.length * 3 // cannot be over, skip the encode
  return new TextEncoder().encode(s).length
}

/** Returns a rejection reason, or null when the raw document is acceptable to parse. */
function precheck(xml: unknown): string | null {
  if (typeof xml !== 'string' || xml.trim() === '') return 'The file is empty.'
  if (utf8Length(xml) > MAX_LYRICS_BYTES) return 'The file is larger than 1 MiB.'
  if (DOCTYPE_OR_ENTITY.test(xml)) return 'DOCTYPE and ENTITY declarations are not allowed.'
  return null
}

function loadDocument(xml: string): { doc: Document } | { error: string } {
  const bad = precheck(xml)
  if (bad) return { error: bad }
  if (typeof DOMParser === 'undefined') return { error: 'XML parsing is not available here.' }
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(xml, 'application/xml')
  } catch {
    return { error: 'The file is not well-formed XML.' }
  }
  const root = doc.documentElement
  if (!root || root.localName === 'parsererror' || doc.getElementsByTagName('parsererror').length > 0) {
    return { error: 'The file is not well-formed XML.' }
  }
  if (root.localName !== 'tt') return { error: 'The root element must be <tt>.' }
  return { doc }
}

// ---------------------------------------------------------------------------------------------
// Namespace-agnostic DOM helpers

function attr(el: Element, local: string): string | undefined {
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes[i]!
    if (a.localName === local) return a.value
  }
  return undefined
}

function childElements(el: Element): Element[] {
  const out: Element[] = []
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) out.push(n as Element)
  return out
}

function findAll(root: Element, local: string): Element[] {
  const out: Element[] = []
  const walk = (el: Element): void => {
    for (const c of childElements(el)) {
      if (c.localName === local) out.push(c)
      walk(c)
    }
  }
  walk(root)
  return out
}

function clean(s: string | null | undefined): string | undefined {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t || undefined
}

// ---------------------------------------------------------------------------------------------
// Time expressions

export interface TimeContext {
  /** Frames per second for `f` offsets and hh:mm:ss:ff clock times. Default 30. */
  frameRate: number
  /** Ticks per second for `t` offsets. */
  tickRate: number
}

export const DEFAULT_TIME_CONTEXT: TimeContext = { frameRate: 30, tickRate: 1 }

const OFFSET_TIME = /^(\d+(?:\.\d+)?|\.\d+)(ms|h|m|s|f|t)$/
const NUM = /^\d+$/
const SECS = /^(\d+)(?:\.(\d+))?$/

function fracMs(frac: string | undefined): number {
  return frac ? Math.round(Number(`0.${frac}`) * 1000) : 0
}

/**
 * Parses a TTML time expression into milliseconds, or null when invalid.
 * Clock times: `hh:mm:ss.fff`, `hh:mm:ss:ff` (frames), `mm:ss.fff`, `ss.fff` (the last two are what
 * Apple Music writes). Offset times: `1.5s`, `250ms`, `2m`, `1h`, `45f`, `9000000t`.
 */
export function parseTtmlTime(value: string | null | undefined, ctx: TimeContext = DEFAULT_TIME_CONTEXT): number | null {
  if (value === null || value === undefined) return null
  const v = value.trim()
  if (!v) return null
  const off = OFFSET_TIME.exec(v)
  if (off) {
    const n = Number(off[1])
    switch (off[2]) {
      case 'h': return Math.round(n * 3_600_000)
      case 'm': return Math.round(n * 60_000)
      case 's': return Math.round(n * 1000)
      case 'ms': return Math.round(n)
      case 'f': return Math.round((n / ctx.frameRate) * 1000)
      default: return Math.round((n / ctx.tickRate) * 1000)
    }
  }
  const parts = v.split(':')
  if (parts.length > 4) return null
  if (parts.length === 1) {
    const m = SECS.exec(parts[0]!)
    return m ? Number(m[1]) * 1000 + fracMs(m[2]) : null
  }
  // Every part except the last seconds/frames part must be whole digits.
  const last = parts[parts.length - 1]!
  const head = parts.slice(0, -1)
  if (!head.every((p) => NUM.test(p))) return null
  if (parts.length === 4) {
    // hh:mm:ss:ff[.sub]
    const m = SECS.exec(last)
    if (!m) return null
    const [h, mi, s] = head.map(Number) as [number, number, number]
    return h * 3_600_000 + mi * 60_000 + s * 1000 + Math.round(((Number(m[1]) + (m[2] ? Number(`0.${m[2]}`) : 0)) / ctx.frameRate) * 1000)
  }
  const m = SECS.exec(last)
  if (!m) return null
  const sec = Number(m[1]) * 1000 + fracMs(m[2])
  if (parts.length === 2) return Number(head[0]) * 60_000 + sec
  return Number(head[0]) * 3_600_000 + Number(head[1]) * 60_000 + sec
}

function readTimeContext(root: Element): TimeContext {
  const fr = Number(attr(root, 'frameRate'))
  const frameRate = Number.isFinite(fr) && fr > 0 ? fr : DEFAULT_TIME_CONTEXT.frameRate
  let rate = frameRate
  const mult = (attr(root, 'frameRateMultiplier') ?? '').trim().split(/\s+/).map(Number)
  if (mult.length === 2 && mult.every((n) => Number.isFinite(n) && n > 0)) rate = (frameRate * mult[0]!) / mult[1]!
  const sub = Number(attr(root, 'subFrameRate'))
  const tr = Number(attr(root, 'tickRate'))
  const hasFrameRate = attr(root, 'frameRate') !== undefined
  const tickRate = Number.isFinite(tr) && tr > 0 ? tr : hasFrameRate ? rate * (Number.isFinite(sub) && sub > 0 ? sub : 1) : 1
  return { frameRate: rate, tickRate }
}

interface Timing {
  /** Absolute start, when the element has its own `begin`. */
  begin?: number
  /** Absolute end, when `end` and/or `dur` is present. */
  end?: number
  /** True when any of begin/end/dur is present on the element. */
  own: boolean
}

function readTiming(el: Element, base: number, ctx: TimeContext): Timing {
  const b = parseTtmlTime(attr(el, 'begin'), ctx)
  const e = parseTtmlTime(attr(el, 'end'), ctx)
  const d = parseTtmlTime(attr(el, 'dur'), ctx)
  const begin = b === null ? undefined : base + b
  const ends: number[] = []
  if (e !== null) ends.push(base + e)
  if (d !== null) ends.push((begin ?? base) + d)
  return { begin, end: ends.length ? Math.min(...ends) : undefined, own: b !== null || e !== null || d !== null }
}

// ---------------------------------------------------------------------------------------------
// Paragraph parsing

type TimingMode = 'word' | 'line' | 'none'

interface Segment {
  text: string
  /** True when the segment comes from a span with its own (or inherited) timing. */
  timed: boolean
  begin?: number
  end?: number
}

interface RawWord {
  time: number
  end?: number
  text: string
}

interface RawLine {
  time?: number
  end?: number
  text: string
  words: RawWord[]
  bg?: { words: RawWord[]; text: string; end?: number }
  agent?: string
  order: number
}

/** How far outside its parent a child may stray and still count as "inside" (rounding in authoring tools). */
const FIT_TOLERANCE_MS = 500
const TIMED_CHILDREN = new Set(['div', 'p', 'span'])

/**
 * Base for the timed children of `parent`, which starts at `start` and ends at `end`. W3C containment
 * makes children relative to the parent's start, but many tools write absolute times everywhere (Apple
 * flags this with itunes:timing, handled by the caller). When the children cannot fit inside the parent
 * as relative offsets yet fit exactly as absolute times, they are absolute. Ambiguous cases stay relative.
 */
function resolveBase(parent: Element, start: number, end: number | undefined, info: DocInfo): number {
  if (info.absolute) return 0
  if (start === 0 || end === undefined) return start
  let any = false
  let relFit = true
  let absFit = true
  for (const c of childElements(parent)) {
    if (!TIMED_CHILDREN.has(c.localName)) continue
    const b = parseTtmlTime(attr(c, 'begin'), info.ctx)
    const e = parseTtmlTime(attr(c, 'end'), info.ctx)
    const d = parseTtmlTime(attr(c, 'dur'), info.ctx)
    if (b === null && e === null) continue
    any = true
    const lo = b ?? 0
    const hi = e ?? (b !== null && d !== null ? b + d : lo)
    if (!(start + hi <= end + FIT_TOLERANCE_MS)) relFit = false
    if (!(lo >= start - FIT_TOLERANCE_MS && hi <= end + FIT_TOLERANCE_MS)) absFit = false
  }
  return any && !relFit && absFit ? 0 : start
}

const SKIP_ROLES = new Set(['x-translation', 'x-roman', 'x-transliteration'])
const SKIP_ELEMENTS = new Set(['metadata', 'style', 'styling', 'layout', 'set', 'animate'])

/** Gathers text and timed spans of an element, descending through nested spans and <br/>. */
function collect(node: Element, base: number, info: DocInfo, out: Segment[], bg: Segment[] | null, inherit?: Timing): void {
  const childBase = (el: Element, t: Timing): number => resolveBase(el, t.begin ?? base, t.end, info)
  for (let n = node.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 3 || n.nodeType === 4) {
      out.push({ text: n.nodeValue ?? '', timed: false })
      continue
    }
    if (n.nodeType !== 1) continue
    const el = n as Element
    const name = el.localName
    if (name === 'br') {
      out.push({ text: ' ', timed: false })
      continue
    }
    if (SKIP_ELEMENTS.has(name)) continue
    if (name !== 'span') {
      collect(el, base, info, out, bg, inherit)
      continue
    }
    const role = (attr(el, 'role') ?? '').trim().toLowerCase()
    if (SKIP_ROLES.has(role)) continue
    const t = readTiming(el, base, info.ctx)
    const leaf = !childElements(el).some((c) => c.localName !== 'br')
    const effective: Timing | undefined = t.own ? t : inherit
    const isBg = role === 'x-bg' && bg !== null
    const target = isBg ? bg! : out
    if (!leaf) {
      // Backing vocals gather separately; nested spans keep the nearest enclosing timing as a fallback.
      collect(el, childBase(el, t), info, target, isBg ? null : bg, effective)
      continue
    }
    let text = ''
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3 || c.nodeType === 4) text += c.nodeValue ?? ''
      else if (c.nodeType === 1 && (c as Element).localName === 'br') text += ' '
    }
    target.push({ text, timed: Boolean(effective?.own), begin: effective?.begin, end: effective?.end })
  }
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ')
}

/** Joins segments into plain text (used for line-only / untimed lyrics). */
function plainText(segs: Segment[]): string {
  return collapse(segs.map((s) => s.text).join('')).trim()
}

/**
 * Turns segments into words. Whitespace between spans separates words; spans with no whitespace between
 * them are syllables of one word (they keep separate timing, only the trailing space tells them apart).
 */
function buildWords(segs: Segment[], lineStart: number | undefined): RawWord[] {
  const words: RawWord[] = []
  const markSpace = (): void => {
    const prev = words[words.length - 1]
    if (prev && !prev.text.endsWith(' ')) prev.text += ' '
  }
  for (const seg of segs) {
    const raw = collapse(seg.text)
    const core = raw.trim()
    if (core === '') {
      if (raw) markSpace()
      continue
    }
    if (raw.startsWith(' ')) markSpace()
    const prev = words[words.length - 1]
    const time = seg.begin ?? prev?.end ?? prev?.time ?? lineStart ?? 0
    // Untimed text between timed spans is a zero-length word at the neighbouring time.
    const end = seg.timed ? seg.end : time
    words.push({ time, end, text: core + (raw.endsWith(' ') ? ' ' : '') })
  }
  const last = words[words.length - 1]
  if (last) last.text = last.text.replace(/ $/, '')
  return words
}

function finalizeWords(words: RawWord[], fallbackEnd: number): LyricWord[] {
  return words.map((w, i) => {
    const next = words[i + 1]
    let end = w.end ?? (next ? next.time : fallbackEnd)
    if (!(end >= w.time)) end = w.time
    return { time: w.time, end, text: w.text }
  })
}

function stripParens(words: RawWord[]): RawWord[] {
  const out = words.map((w) => ({ ...w }))
  const first = out[0]
  if (first) first.text = first.text.replace(/^\(\s*/, '')
  const last = out[out.length - 1]
  if (last) last.text = last.text.replace(/\s*\)\s*$/, '')
  return out.filter((w) => w.text.trim() !== '')
}

function joinWords(words: ReadonlyArray<{ text: string }>): string {
  return words.map((w) => w.text).join('').replace(/\s+/g, ' ').trim()
}

interface DocInfo {
  mode: TimingMode
  absolute: boolean
  ctx: TimeContext
  /** Agent id → type from <ttm:agent> declarations. */
  agentTypes: Map<string, string>
}

const NO_TIMING: Timing = { own: false }

function parseParagraph(p: Element, base: number, agent: string | undefined, info: DocInfo, order: number): RawLine {
  const timing = info.mode === 'none' ? NO_TIMING : readTiming(p, base, info.ctx)
  const main: Segment[] = []
  const bg: Segment[] = []
  collect(p, resolveBase(p, timing.begin ?? base, timing.end, info), info, main, bg)

  const wordTimed = info.mode === 'word' && main.some((s) => s.timed && s.begin !== undefined)
  const bgTimed = info.mode === 'word' && bg.some((s) => s.timed && s.begin !== undefined)

  let words: RawWord[] = wordTimed ? buildWords(main, timing.begin) : []
  let text = wordTimed ? joinWords(words) : plainText(main)

  let background: RawLine['bg']
  if (bg.length) {
    const bgWords = bgTimed ? stripParens(buildWords(bg, timing.begin)) : []
    const bgText = bgTimed ? joinWords(bgWords) : plainText(bg).replace(/^\(\s*/, '').replace(/\s*\)$/, '')
    if (bgText) background = { words: bgWords, text: bgText }
  }

  // A paragraph that is only backing vocals is shown as a normal line.
  if (!text && background) {
    text = background.text
    words = background.words
    background = undefined
  }

  let time = timing.begin
  if (time === undefined && words.length) time = Math.min(...words.map((w) => w.time))
  return { time, end: timing.end, text, words, bg: background, agent: clean(attr(p, 'agent')) ?? agent, order }
}

function walkBlock(el: Element, start: number, end: number | undefined, agent: string | undefined, info: DocInfo, out: RawLine[]): void {
  const base = resolveBase(el, start, end, info)
  for (const child of childElements(el)) {
    const name = child.localName
    if (name === 'div' || name === 'body') {
      const t = info.mode === 'none' ? NO_TIMING : readTiming(child, base, info.ctx)
      walkBlock(child, t.begin ?? base, t.end, clean(attr(child, 'agent')) ?? agent, info, out)
    } else if (name === 'p') {
      out.push(parseParagraph(child, base, agent, info, out.length))
    }
  }
}

function readAgentTypes(root: Element): Map<string, string> {
  const map = new Map<string, string>()
  for (const a of findAll(root, 'agent')) {
    const id = attr(a, 'id')
    if (id) map.set(id, (attr(a, 'type') ?? 'person').toLowerCase())
  }
  return map
}

/** Group / "both singers" voices: declared type group, or Apple's v1000+ ids. */
function isGroupAgent(id: string, types: Map<string, string>): boolean {
  const t = types.get(id)
  if (t === 'group' || t === 'other') return true
  const m = /^v(\d+)$/i.exec(id)
  return Boolean(m && Number(m[1]) >= 1000)
}

function readMode(root: Element): TimingMode {
  const v = (attr(root, 'timing') ?? '').trim().toLowerCase()
  return v === 'line' ? 'line' : v === 'none' ? 'none' : 'word'
}

function buildLyrics(root: Element): ParsedLyrics {
  const body = childElements(root).find((c) => c.localName === 'body')
  if (!body) return EMPTY
  const ctx = readTimeContext(root)
  const mode = readMode(root)
  // Apple Music writes absolute times on every element, even inside <div begin>; the itunes:timing
  // attribute identifies those files. Plain TTML uses W3C time containment (children relative to parent).
  const info: DocInfo = { mode, absolute: attr(root, 'timing') !== undefined, ctx, agentTypes: readAgentTypes(root) }

  const raw: RawLine[] = []
  const bodyT = mode === 'none' ? NO_TIMING : readTiming(body, 0, ctx)
  walkBlock(body, bodyT.begin ?? 0, bodyT.end, clean(attr(body, 'agent')), info, raw)

  if (mode === 'none' || !raw.some((l) => l.time !== undefined)) {
    const lines: LyricLine[] = raw.map((l) => ({ time: 0, text: l.text }))
    while (lines.length && !lines[0]!.text) lines.shift()
    while (lines.length && !lines[lines.length - 1]!.text) lines.pop()
    return { lines, synced: false }
  }

  // Lines without a time inherit the previous line's end.
  let carry = 0
  for (const l of raw) {
    if (l.time === undefined) l.time = carry
    carry = l.end !== undefined && l.end > l.time ? l.end : l.time
  }

  // Agents: first distinct singer → start, second → end; groups and any further singers → start.
  const sides = new Map<string, 'start' | 'end'>()
  let singers = 0
  for (const l of raw) {
    if (!l.agent || sides.has(l.agent)) continue
    if (isGroupAgent(l.agent, info.agentTypes)) sides.set(l.agent, 'start')
    else sides.set(l.agent, singers++ === 1 ? 'end' : 'start')
  }

  const sorted = raw
    .map((l, i) => ({ l, i }))
    .sort((a, b) => a.l.time! - b.l.time! || a.i - b.i)
    .map((x) => x.l)

  // Collapse runs of empty (instrumental) lines and drop them at the end.
  const kept: RawLine[] = []
  for (const l of sorted) {
    const prev = kept[kept.length - 1]
    if (!l.text && prev && !prev.text) continue
    kept.push(l)
  }
  while (kept.length && !kept[kept.length - 1]!.text) kept.pop()

  let wordSynced = false
  const lines: LyricLine[] = kept.map((l, i) => {
    const time = l.time!
    const next = kept[i + 1]
    const nextBegin = next && next.time! > time ? next.time! : undefined
    const ownEnd = l.end !== undefined && l.end > time ? l.end : undefined
    const lastTime = l.words.length ? l.words[l.words.length - 1]!.time : time
    const fallback = ownEnd ?? nextBegin ?? lastTime + 1000
    const line: LyricLine = { time, text: l.text, end: ownEnd ?? nextBegin ?? time + 4000 }
    if (l.words.length) {
      line.words = finalizeWords(l.words, fallback)
      const lastEnd = line.words[line.words.length - 1]!.end
      line.end = ownEnd !== undefined ? Math.max(ownEnd, lastEnd) : lastEnd
      wordSynced = true
    }
    if (l.bg) {
      line.background = { words: finalizeWords(l.bg.words, fallback), text: l.bg.text }
      const bgLast = line.background.words[line.background.words.length - 1]
      if (bgLast) {
        wordSynced = true
        if (ownEnd === undefined) line.end = Math.max(line.end!, bgLast.end)
      }
    }
    if (l.agent) {
      line.agent = l.agent
      line.align = sides.get(l.agent) ?? 'start'
    }
    return line
  })

  return wordSynced ? { lines, synced: true, wordSynced } : { lines, synced: true }
}

// ---------------------------------------------------------------------------------------------
// Metadata

function metadataOf(root: Element): TtmlMetadata {
  const meta: TtmlMetadata = {}
  const head = childElements(root).find((c) => c.localName === 'head')
  const scope = head ?? root

  let title = clean(findAll(scope, 'title').find((e) => e.parentNode && (e.parentNode as Element).localName === 'metadata')?.textContent) ?? clean(attr(root, 'title'))
  let artist = clean(attr(root, 'artist'))
  let album = clean(attr(root, 'album'))

  for (const it of findAll(root, 'iTunesMetadata')) {
    title ??= clean(attr(it, 'title'))
    artist ??= clean(attr(it, 'artist'))
    album ??= clean(attr(it, 'album'))
    for (const c of childElements(it)) {
      if (c.localName === 'title') title ??= clean(c.textContent)
      else if (c.localName === 'artist') artist ??= clean(c.textContent)
      else if (c.localName === 'album') album ??= clean(c.textContent)
    }
  }

  // "Artist - Title" description when there is no explicit title.
  const desc = clean(findAll(scope, 'desc')[0]?.textContent)
  if (!title && desc && desc.length <= 160) {
    const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(desc)
    if (m) {
      artist ??= m[1]!.trim()
      title = m[2]!.trim()
    }
  }

  // The first named person agent is the best remaining guess for the artist.
  if (!artist) {
    for (const a of findAll(scope, 'agent')) {
      if ((attr(a, 'type') ?? 'person').toLowerCase() !== 'person') continue
      const name = clean(childElements(a).find((c) => c.localName === 'name')?.textContent)
      if (name) {
        artist = name
        break
      }
    }
  }

  if (title) meta.title = title
  if (artist) meta.artist = artist
  if (album) meta.album = album

  const body = childElements(root).find((c) => c.localName === 'body')
  if (body) {
    const ctx = readTimeContext(root)
    const dur = parseTtmlTime(attr(body, 'dur'), ctx)
    const end = parseTtmlTime(attr(body, 'end'), ctx)
    const divEnds = childElements(body)
      .filter((c) => c.localName === 'div')
      .map((d) => parseTtmlTime(attr(d, 'end'), ctx))
      .filter((n): n is number => n !== null)
    const ms = dur ?? end ?? (divEnds.length ? Math.max(...divEnds) : null)
    if (ms !== null && ms > 0) meta.durationMs = ms
  }
  return meta
}

// ---------------------------------------------------------------------------------------------
// Public API

/** Parses once and returns lyrics, metadata and the acceptance facts. Never throws. */
export function inspectTtml(xml: string): TtmlInspection {
  const loaded = loadDocument(xml)
  if ('error' in loaded) return { error: loaded.error, lyrics: EMPTY, metadata: {}, timedParagraphs: 0 }
  const root = loaded.doc.documentElement
  const ctx = readTimeContext(root)
  const timedParagraphs = findAll(root, 'p').filter((p) => parseTtmlTime(attr(p, 'begin'), ctx) !== null).length
  let lyrics = EMPTY
  let metadata: TtmlMetadata = {}
  try {
    lyrics = buildLyrics(root)
    metadata = metadataOf(root)
  } catch {
    return { error: 'The TTML could not be read.', lyrics: EMPTY, metadata: {}, timedParagraphs }
  }
  return { lyrics, metadata, timedParagraphs }
}

/**
 * Parses a TTML document (W3C Timed Text, Apple Music style) into lyric lines, with word timing
 * when spans carry it. Returns empty lyrics for anything unsafe or malformed.
 */
export function parseTtml(xml: string): ParsedLyrics {
  const r = inspectTtml(xml)
  return r.error ? EMPTY : r.lyrics
}

/** Title / artist / album / duration declared by the document. Empty object when rejected. */
export function readTtmlMetadata(xml: string): TtmlMetadata {
  const r = inspectTtml(xml)
  return r.error ? {} : r.metadata
}

/** Same acceptance rules as the server (§6): XML with a <tt> root and at least one <p begin>. */
export function validateTtml(xml: string): ValidationResult {
  const r = inspectTtml(xml)
  if (r.error) return { ok: false, message: r.error }
  if (r.timedParagraphs === 0) return { ok: false, message: 'The TTML needs at least one <p> with a begin time.' }
  return { ok: true }
}

const LRC_STAMP = /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/

/** Same acceptance rules as the server (§6): at least one [mm:ss.xx] timestamp, at most 1 MiB. */
export function validateLrc(text: string): ValidationResult {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, message: 'The file is empty.' }
  if (utf8Length(text) > MAX_LYRICS_BYTES) return { ok: false, message: 'The file is larger than 1 MiB.' }
  if (!LRC_STAMP.test(text)) return { ok: false, message: 'No [mm:ss.xx] timestamps found in the LRC file.' }
  return { ok: true }
}
