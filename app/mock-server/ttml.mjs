// TTML (W3C Timed Text, Apple Music style) generation for the demo catalog and the minimal,
// dependency-free validation used by PUT /v1/admin/tracks/:id/lyrics. No XML library is used:
// the checker is a small well-formedness scanner that also refuses DOCTYPE / ENTITY declarations.

import { HttpError } from './auth.mjs'
import { timeline } from './audio.mjs'
import { lyricLines } from './lyrics.mjs'
import { escapeXml } from './util.mjs'

export const LYRICS_MAX_BYTES = 1024 * 1024
/** LRC / plain-text lyrics (the real server's limit). */
export const PLAIN_LRC_MAX_BYTES = 200 * 1024

// ---- Generation ----------------------------------------------------------------------

function clock(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000))
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  const f = String(ms % 1000).padStart(3, '0')
  return m === 0 ? `${s}.${f}` : `${m}:${String(s).padStart(2, '0')}.${f}`
}

/** Splits [start, end] across words proportionally to their length. */
function wordTimes(words, start, end) {
  const weights = words.map((w) => w.length + 1)
  const total = weights.reduce((a, b) => a + b, 0)
  let t = start
  return words.map((w, i) => {
    const b = t
    t += ((end - start) * weights[i]) / total
    return { w, b, e: i === words.length - 1 ? end : t }
  })
}

const BG_ECHO = ['(oh, oh)', '(ooh)', '(take me back)', '(again, again)']

/**
 * TTML document for a track with word-level timing, aligned to the generated audio phrases.
 * Two agents (v1, v2) alternate on verse lines (a duet); choruses are sung by v1 with
 * background vocals (`ttm:role="x-bg"`) on their last line.
 * @returns {string|null} null when the track has no lyrics
 */
export function buildTtml(track, artistName) {
  const lines = lyricLines(track)
  if (lines.length === 0) return null
  const tl = timeline(track.music, track.duration)
  const sections = []
  lines.forEach((l, i) => {
    if (i === 0 || l.blankBefore) sections.push([])
    sections[sections.length - 1].push({ ...l, index: i })
  })
  const bodyEnd = Math.min(track.duration, lines[lines.length - 1].time + tl.line)
  let out = '<?xml version="1.0" encoding="UTF-8"?>\n'
  out += '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" itunes:timing="Word" xml:lang="en">\n'
  out += '<head><metadata>'
  out += `<ttm:title>${escapeXml(track.title)}</ttm:title>`
  out += `<ttm:agent type="person" xml:id="v1"><ttm:name type="full">${escapeXml(artistName)}</ttm:name></ttm:agent>`
  out += '<ttm:agent type="person" xml:id="v2"><ttm:name type="full">Guest Voice</ttm:name></ttm:agent>'
  out += `<iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal"><songwriters><songwriter>${escapeXml(artistName)}</songwriter></songwriters></iTunesMetadata>`
  out += '</metadata></head>\n'
  out += `<body dur="${clock(bodyEnd)}">\n`
  sections.forEach((section, si) => {
    const chorus = si % 2 === 1
    const first = section[0]
    const last = section[section.length - 1]
    out += `<div begin="${clock(first.time)}" end="${clock(Math.min(track.duration, last.time + tl.line * 0.9))}" itunes:songPart="${chorus ? 'Chorus' : 'Verse'}">\n`
    section.forEach((l, k) => {
      const start = l.time
      const end = Math.min(track.duration, l.time + tl.line * 0.8)
      const agent = chorus ? 'v1' : l.index % 2 === 0 ? 'v1' : 'v2'
      const words = wordTimes(l.text.split(/\s+/).filter(Boolean), start, end)
      let body = words.map((x) => `<span begin="${clock(x.b)}" end="${clock(x.e)}">${escapeXml(x.w)}</span>`).join(' ')
      let pEnd = end
      if (chorus && k === section.length - 1) {
        const echo = BG_ECHO[si % BG_ECHO.length].split(/\s+/)
        const bgStart = end + 0.05
        const bgEnd = Math.min(track.duration, bgStart + tl.beat * 2)
        const bg = wordTimes(echo, bgStart, bgEnd)
        body += ` <span ttm:role="x-bg" begin="${clock(bgStart)}" end="${clock(bgEnd)}">${bg.map((x) => `<span begin="${clock(x.b)}" end="${clock(x.e)}">${escapeXml(x.w)}</span>`).join(' ')}</span>`
        pEnd = bgEnd
      }
      out += `<p begin="${clock(start)}" end="${clock(pEnd)}" ttm:agent="${agent}" itunes:key="L${l.index + 1}">${body}</p>\n`
    })
    out += '</div>\n'
  })
  out += '</body>\n</tt>\n'
  return out
}

// ---- Validation ----------------------------------------------------------------------

const BAD_ENTITY = /&(?!(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});)/
const NAME = /[A-Za-z_][\w.:-]*/y
const local = (name) => name.slice(name.indexOf(':') + 1)

/** Throws an HttpError(400) unless `doc` is a well-formed TTML document with a <tt> root and a timed <p>. */
function validateTtml(doc) {
  const fail = (why) => {
    throw new HttpError(400, `Invalid TTML: ${why}.`)
  }
  if (/<!\s*(DOCTYPE|ENTITY)/i.test(doc)) fail('DOCTYPE and ENTITY declarations are not allowed')
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(doc)) fail('control characters are not allowed')
  const stack = []
  let roots = 0
  let timedParagraphs = 0
  let i = 0
  const n = doc.length
  const checkText = (text) => {
    if (BAD_ENTITY.test(text)) fail('unsupported entity reference')
    if (stack.length === 0 && text.trim() !== '') fail('text outside the root element')
  }
  while (i < n) {
    const lt = doc.indexOf('<', i)
    if (lt === -1) {
      checkText(doc.slice(i))
      break
    }
    checkText(doc.slice(i, lt))
    if (doc.startsWith('<!--', lt)) {
      const end = doc.indexOf('-->', lt + 4)
      if (end === -1) fail('unterminated comment')
      i = end + 3
    } else if (doc.startsWith('<![CDATA[', lt)) {
      if (stack.length === 0) fail('CDATA outside the root element')
      const end = doc.indexOf(']]>', lt)
      if (end === -1) fail('unterminated CDATA section')
      i = end + 3
    } else if (doc.startsWith('<?', lt)) {
      const end = doc.indexOf('?>', lt)
      if (end === -1) fail('unterminated processing instruction')
      if (lt !== 0 && roots === 0 && doc.slice(0, lt).trim() !== '' ) fail('misplaced processing instruction')
      i = end + 2
    } else if (doc.startsWith('<!', lt)) {
      fail('declarations are not allowed')
    } else if (doc.startsWith('</', lt)) {
      const end = doc.indexOf('>', lt)
      if (end === -1) fail('unterminated end tag')
      const name = doc.slice(lt + 2, end).trim()
      if (stack.length === 0 || stack[stack.length - 1] !== name) fail(`unexpected end tag </${name}>`)
      stack.pop()
      i = end + 1
    } else {
      NAME.lastIndex = lt + 1
      const m = NAME.exec(doc)
      if (!m) fail('malformed tag')
      const name = m[0]
      let p = NAME.lastIndex
      const attrs = new Map()
      for (;;) {
        const ws = /^\s*/.exec(doc.slice(p, p + 64))[0].length
        const c = doc[p + ws]
        if (c === '>' || (c === '/' && doc[p + ws + 1] === '>')) {
          p += ws
          break
        }
        if (ws === 0) fail('malformed tag')
        p += ws
        NAME.lastIndex = p
        const am = NAME.exec(doc)
        if (!am) fail('malformed attribute')
        p = NAME.lastIndex
        const eq = /^\s*=\s*/.exec(doc.slice(p, p + 64))
        if (!eq) fail('attribute without a value')
        p += eq[0].length
        const q = doc[p]
        if (q !== '"' && q !== "'") fail('unquoted attribute value')
        const close = doc.indexOf(q, p + 1)
        if (close === -1) fail('unterminated attribute value')
        const value = doc.slice(p + 1, close)
        if (value.includes('<')) fail('"<" is not allowed in attribute values')
        if (BAD_ENTITY.test(value)) fail('unsupported entity reference')
        if (attrs.has(am[0])) fail(`duplicate attribute "${am[0]}"`)
        attrs.set(am[0], value)
        p = close + 1
      }
      const selfClosing = doc[p] === '/'
      if (stack.length === 0) {
        roots++
        if (roots > 1) fail('more than one root element')
        if (local(name) !== 'tt') fail('the root element must be <tt>')
      }
      if (local(name) === 'p') {
        for (const [k, v] of attrs) if (local(k) === 'begin' && v.trim() !== '') timedParagraphs++
      }
      if (!selfClosing) {
        stack.push(name)
        if (stack.length > 64) fail('elements are nested too deeply')
      }
      i = p + (selfClosing ? 2 : 1)
    }
  }
  if (roots === 0) fail('the root element must be <tt>')
  if (stack.length > 0) fail(`unclosed element <${stack[stack.length - 1]}>`)
  if (timedParagraphs === 0) fail('at least one <p> with a "begin" time is required')
}

const LRC_STAMP = /\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/

/**
 * Validates a lyrics upload. Returns the normalized content (BOM removed).
 * @throws {HttpError} 400 when the format/content is not acceptable.
 */
export function validateLyrics(format, content) {
  if (format !== 'ttml' && format !== 'lrc' && format !== 'plain') throw new HttpError(400, 'format must be "ttml", "lrc" or "plain".')
  if (typeof content !== 'string' || content.trim() === '') throw new HttpError(400, 'content must be a non-empty string.')
  if (format === 'ttml' && Buffer.byteLength(content, 'utf8') > LYRICS_MAX_BYTES) throw new HttpError(400, 'Lyrics are limited to 1 MiB.')
  if (format !== 'ttml' && Buffer.byteLength(content, 'utf8') > PLAIN_LRC_MAX_BYTES) throw new HttpError(413, 'Lyrics are limited to 200 KB.')
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
  if (format === 'ttml') validateTtml(text)
  else if (format === 'lrc' && !LRC_STAMP.test(text)) throw new HttpError(400, 'Invalid LRC: at least one [mm:ss.xx] timestamp is required.')
  return text
}

// ---- Plain text extraction -----------------------------------------------------------

const decodeEntities = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(Math.min(0x10ffff, parseInt(h, 16))))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Math.min(0x10ffff, Number(d))))
    .replace(/&amp;/g, '&')

/** Plain text (one line per <p>) of a validated TTML document. */
export function plainFromTtml(ttml) {
  const lines = []
  for (const m of ttml.matchAll(/<(?:\w+:)?p\b[^>]*>([\s\S]*?)<\/(?:\w+:)?p>/g)) {
    const text = decodeEntities((m[1] ?? '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
    if (text) lines.push(text)
  }
  return lines.length ? lines.join('\n') : null
}

export function plainFromLrc(lrc) {
  const lines = lrc
    .split(/\r?\n/)
    .map((l) => l.replace(/\[[^\]]*\]/g, '').trim())
    .filter(Boolean)
  return lines.length ? lines.join('\n') : null
}
