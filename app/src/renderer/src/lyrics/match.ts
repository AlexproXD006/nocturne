import type { LyricsFormat, Track } from '../api/types'
import { inspectTtml, validateLrc } from './ttml'
import { parseLrc } from './lrc'
import { t } from '../i18n'

/** Scores at or above this are applied without review. */
export const AUTO_THRESHOLD = 0.75
/** Scores in [REVIEW_THRESHOLD, AUTO_THRESHOLD) need a human look; below is "no match". */
export const REVIEW_THRESHOLD = 0.5

export interface LyricsFileDescription {
  format: LyricsFormat
  title?: string
  artist?: string
  durationMs?: number
  valid: boolean
  error?: string
  /** True for TTML whose lines carry word-level timing. */
  wordSynced?: boolean
}

export type MatchConfidence = 'auto' | 'review' | 'none'

export function confidenceOf(score: number): MatchConfidence {
  return score >= AUTO_THRESHOLD ? 'auto' : score >= REVIEW_THRESHOLD ? 'review' : 'none'
}

// ---------------------------------------------------------------------------------------------
// Text normalisation

/** Lower-case, diacritic-free, bracketed asides ("(feat. X)", "[Remastered]") removed, punctuation → spaces. */
export function normalizeText(s: string | undefined | null): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]!
}

function editSimilarity(a: string, b: string): number {
  if (!a || !b) return 0
  const x = a.slice(0, 120)
  const y = b.slice(0, 120)
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length)
}

function tokenSimilarity(a: string, b: string): number {
  const ta = new Set(a.split(' ').filter(Boolean))
  const tb = new Set(b.split(' ').filter(Boolean))
  if (!ta.size || !tb.size) return 0
  let common = 0
  for (const t of ta) if (tb.has(t)) common++
  return (2 * common) / (ta.size + tb.size)
}

/** 0..1 similarity of two titles, diacritic- and punctuation-insensitive. */
export function titleSimilarity(a: string | undefined, b: string | undefined): number {
  const x = normalizeText(a)
  const y = normalizeText(b)
  if (!x || !y) return 0
  if (x === y) return 1
  return Math.max(editSimilarity(x, y), tokenSimilarity(x, y))
}

/** True when every word of the shorter name appears in the longer one ("Adele" ⊂ "Adele feat. X"). */
function artistScore(desc: string, names: string[]): number {
  const d = normalizeText(desc)
  if (!d) return 0
  let best = 0
  const dTokens = d.split(' ')
  for (const raw of names) {
    const n = normalizeText(raw)
    if (!n) continue
    if (n === d) return 1
    const nTokens = n.split(' ')
    const [short, long] = dTokens.length <= nTokens.length ? [dTokens, new Set(nTokens)] : [nTokens, new Set(dTokens)]
    if (short.every((t) => long.has(t)) || n.includes(d) || d.includes(n)) best = Math.max(best, 0.95)
    else {
      // Partial overlap ("Mira Hart" vs "Mira Vale") and typos count for a little; unrelated names for nothing.
      const es = editSimilarity(d, n)
      best = Math.max(best, Math.min(0.9, tokenSimilarity(d, n)), es >= 0.8 ? es * 0.9 : 0)
    }
  }
  // "A, B" / "A & B" credits in the file name: any single artist matching counts.
  if (best < 0.95) {
    for (const part of desc.split(/\s*(?:,|&|\band\b|\bfeat\.?|\bft\.?|;|\/)\s*/i)) {
      const p = normalizeText(part)
      if (p && names.some((n) => normalizeText(n) === p)) best = Math.max(best, 0.9)
    }
  }
  return best
}

// ---------------------------------------------------------------------------------------------
// Describing a file

const TTML_EXT = /\.(ttml|xml|dfxp|itt)$/i
const LRC_EXT = /\.(lrc|txt)$/i

function guessFormat(name: string, content: string): LyricsFormat {
  if (TTML_EXT.test(name)) return 'ttml'
  if (LRC_EXT.test(name)) return 'lrc'
  return content.trimStart().startsWith('<') ? 'ttml' : 'lrc'
}

/** "Artist - Title.ext", "Title.ext", "01 Title.ext", "01 - Artist - Title.ext". */
export function parseLyricsFilename(name: string): { title?: string; artist?: string } {
  const base = name.replace(/^.*[\\/]/, '').replace(/\.[A-Za-z0-9]{1,5}$/, '')
  let stem = base.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim()
  // Leading track number: "01 ", "01. ", "01 - ", "1-02 ".
  const num = /^(?:\d{1,2}[-.])?\d{1,3}(?:\s*[-.]\s*|\s+)(?=\S)/.exec(stem)
  if (num && stem.length > num[0].length) stem = stem.slice(num[0].length)
  const parts = stem.split(/\s+[-–—]\s+/).map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0) return {}
  if (parts.length === 1) return { title: parts[0] }
  return { artist: parts[0], title: parts[parts.length - 1] }
}

function lrcTag(content: string, tag: string): string | undefined {
  const m = new RegExp(`^\\s*\\[${tag}:([^\\]]*)\\]`, 'im').exec(content)
  const v = m?.[1]?.trim()
  return v || undefined
}

function parseLength(v: string | undefined): number | undefined {
  if (!v) return undefined
  const m = /^(\d+):(\d{1,2})(?:[.:](\d{1,3}))?$/.exec(v)
  if (m) return Number(m[1]) * 60_000 + Number(m[2]) * 1000 + (m[3] ? Math.round(Number(`0.${m[3]}`) * 1000) : 0)
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : undefined
}

/** Works out what a lyrics file is, whether the server will accept it, and which song it belongs to. */
export function describeLyricsFile(name: string, content: string): LyricsFileDescription {
  const format = guessFormat(name, content)
  const fromName = parseLyricsFilename(name)
  if (format === 'ttml') {
    const r = inspectTtml(content)
    const meta = r.metadata
    if (r.error || r.timedParagraphs === 0) {
      return {
        format,
        title: meta.title ?? fromName.title,
        artist: meta.artist ?? fromName.artist,
        valid: false,
        error: r.error ?? t('lfile.ttmlNeedsP')
      }
    }
    return {
      format,
      title: meta.title ?? fromName.title,
      artist: meta.artist ?? fromName.artist,
      durationMs: meta.durationMs,
      valid: true,
      wordSynced: r.lyrics.wordSynced === true
    }
  }
  const v = validateLrc(content)
  const title = lrcTag(content, 'ti') ?? fromName.title
  const artist = lrcTag(content, 'ar') ?? fromName.artist
  const base = { format, title, artist, durationMs: parseLength(lrcTag(content, 'length')) }
  if (!v.ok) return { ...base, valid: false, error: v.message }
  return { ...base, valid: true, wordSynced: parseLrc(content).wordSynced === true }
}

// ---------------------------------------------------------------------------------------------
// Matching

type Describe = Pick<LyricsFileDescription, 'title' | 'artist' | 'durationMs'>

/**
 * 0..1 likelihood that the file belongs to `track`. Title similarity dominates; a known artist contributes
 * 30% of the core (so a same-titled song by someone else lands in "review"); without an artist the core is
 * the title alone at 90%. The core is scaled to 0.9 so that a duration within 3 s can add a 0.1 bonus and
 * tell apart otherwise identical candidates (album vs live version). A file with no title can't be matched.
 */
export function scoreTrackMatch(desc: Describe, track: Track): number {
  const t = titleSimilarity(desc.title, track.title)
  if (t === 0) return 0
  let core: number
  if (desc.artist) {
    const names = track.artists.map((a) => a.name)
    if (names.length > 1) names.push(names.join(' '))
    core = 0.7 * t + 0.3 * artistScore(desc.artist, names)
  } else {
    core = 0.9 * t
  }
  let score = 0.9 * core
  if (desc.durationMs && track.duration > 0 && Math.abs(desc.durationMs - track.duration * 1000) <= 3000) score += 0.1
  return Math.min(1, Math.max(0, score))
}

export interface TrackMatch {
  track: Track
  score: number
}

/**
 * Best candidate with score >= 0.5, or null. When the runner-up is within 0.03 (e.g. the same song on two
 * albums with nothing to tell them apart) the score is capped just below the auto threshold so a person
 * confirms which one is meant.
 */
export function pickBestMatch(desc: Describe, candidates: readonly Track[]): TrackMatch | null {
  const scored = candidates
    .map((track) => ({ track, score: scoreTrackMatch(desc, track) }))
    .sort((a, b) => b.score - a.score)
  const best = scored[0]
  if (!best || best.score < REVIEW_THRESHOLD) return null
  const second = scored[1]
  if (second && second.score >= REVIEW_THRESHOLD && best.score - second.score < 0.03 && best.score >= AUTO_THRESHOLD) {
    return { track: best.track, score: AUTO_THRESHOLD - 0.01 }
  }
  return best
}
