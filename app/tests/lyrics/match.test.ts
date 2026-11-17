import { describe, expect, it } from 'vitest'
import {
  AUTO_THRESHOLD,
  REVIEW_THRESHOLD,
  confidenceOf,
  describeLyricsFile,
  normalizeText,
  parseLyricsFilename,
  pickBestMatch,
  scoreTrackMatch,
  titleSimilarity
} from '@/lyrics/match'
import { track } from '../helpers/fixtures'

const TTML = (extra = '', head = '') =>
  `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" ${extra}>${head}<body><div><p begin="1s" end="2s"><span begin="1s" end="2s">hi</span></p></div></body></tt>`

const song = (id: string, title: string, artist: string, duration = 200) =>
  track(id, { title, artists: [{ id: `a-${id}`, name: artist }], duration })

describe('normalizeText', () => {
  it('lowercases, removes diacritics, bracketed asides and punctuation', () => {
    expect(normalizeText('  Café Déjà-Vu (feat. Someone) [Remastered 2011]!! ')).toBe('cafe deja vu')
    expect(normalizeText('Rock & Roll')).toBe('rock and roll')
    expect(normalizeText('Beyoncé — Halo')).toBe('beyonce halo')
    expect(normalizeText(undefined)).toBe('')
  })
  it('keeps non-latin letters', () => {
    expect(normalizeText('夜に駆ける')).toBe('夜に駆ける')
  })
})

describe('titleSimilarity', () => {
  it('is 1 for equal normalized titles and 0 for empty input', () => {
    expect(titleSimilarity('Halo', 'HALO (Live)')).toBe(1)
    expect(titleSimilarity('Déjà Vu', 'deja vu')).toBe(1)
    expect(titleSimilarity('', 'x')).toBe(0)
    expect(titleSimilarity(undefined, undefined)).toBe(0)
  })
  it('degrades gracefully for typos and unrelated titles', () => {
    expect(titleSimilarity('Paper Lanterns', 'Paper Lantern')).toBeGreaterThan(0.9)
    expect(titleSimilarity('Paper Lanterns', 'Midnight Drive')).toBeLessThan(0.4)
    expect(titleSimilarity('x'.repeat(500), 'x'.repeat(499) + 'y')).toBeGreaterThan(0.9)
  })
})

describe('parseLyricsFilename', () => {
  it.each([
    ['Mira Vale - Paper Lanterns.ttml', { artist: 'Mira Vale', title: 'Paper Lanterns' }],
    ['Paper Lanterns.lrc', { title: 'Paper Lanterns' }],
    ['01 Paper Lanterns.ttml', { title: 'Paper Lanterns' }],
    ['01. Paper Lanterns.ttml', { title: 'Paper Lanterns' }],
    ['01 - Paper Lanterns.lrc', { title: 'Paper Lanterns' }],
    ['02 - Mira Vale - Paper Lanterns.lrc', { artist: 'Mira Vale', title: 'Paper Lanterns' }],
    ['Mira Vale – Paper Lanterns.xml', { artist: 'Mira Vale', title: 'Paper Lanterns' }],
    ['Mira_Vale_-_Paper_Lanterns.ttml', { artist: 'Mira Vale', title: 'Paper Lanterns' }],
    ['Artist - Album - Title.lrc', { artist: 'Artist', title: 'Title' }],
    ['C:\\music\\lyrics\\Song.lrc', { title: 'Song' }],
    ['1979.lrc', { title: '1979' }],
    ['.lrc', {}]
  ])('%s', (name, expected) => {
    expect(parseLyricsFilename(name)).toEqual(expected)
  })
})

describe('describeLyricsFile', () => {
  it('describes TTML using metadata, with the filename filling gaps', () => {
    const d = describeLyricsFile(
      'whatever.ttml',
      TTML('', '<head><metadata><ttm:title>Paper Lanterns</ttm:title><ttm:agent type="person" xml:id="v1"><ttm:name>Mira Vale</ttm:name></ttm:agent></metadata></head>').replace('<body>', '<body dur="3:12.5">')
    )
    expect(d).toEqual({ format: 'ttml', title: 'Paper Lanterns', artist: 'Mira Vale', durationMs: 192_500, valid: true, wordSynced: true })
    const only = describeLyricsFile('Mira Vale - Paper Lanterns.ttml', TTML())
    expect(only).toMatchObject({ title: 'Paper Lanterns', artist: 'Mira Vale', valid: true })
  })

  it('flags line-only TTML as not word-synced', () => {
    const xml = '<tt><body><div><p begin="1s" end="2s">plain line</p></div></body></tt>'
    expect(describeLyricsFile('a.ttml', xml)).toMatchObject({ valid: true, wordSynced: false })
  })

  it('reports invalid TTML with a reason but still names the song from the filename', () => {
    const bad = describeLyricsFile('Mira Vale - Paper Lanterns.ttml', '<tt><body><p>nope</p></body></tt>')
    expect(bad).toMatchObject({ format: 'ttml', valid: false, title: 'Paper Lanterns', artist: 'Mira Vale' })
    expect(bad.error).toMatch(/begin/)
    expect(describeLyricsFile('x.ttml', '<tt>').valid).toBe(false)
    expect(describeLyricsFile('x.ttml', '<!DOCTYPE tt []><tt/>')).toMatchObject({ valid: false, error: expect.stringContaining('DOCTYPE') })
  })

  it('describes LRC using [ti:], [ar:] and [length:] tags', () => {
    const d = describeLyricsFile('01 file.lrc', '[ti:Paper Lanterns]\n[ar:Mira Vale]\n[length:03:12]\n[00:01.00]hello')
    expect(d).toEqual({ format: 'lrc', title: 'Paper Lanterns', artist: 'Mira Vale', durationMs: 192_000, valid: true, wordSynced: false })
  })

  it('falls back to the filename for LRC without tags, and reads fractional lengths', () => {
    expect(describeLyricsFile('Mira Vale - Paper Lanterns.lrc', '[length: 3:12.5]\n[00:01.00]hi')).toMatchObject({
      title: 'Paper Lanterns',
      artist: 'Mira Vale',
      durationMs: 192_500
    })
    expect(describeLyricsFile('a.lrc', '[length:200]\n[00:01.00]hi').durationMs).toBe(200_000)
    expect(describeLyricsFile('a.lrc', '[length:oops]\n[00:01.00]hi').durationMs).toBeUndefined()
  })

  it('detects enhanced LRC as word-synced and rejects LRC without timestamps', () => {
    expect(describeLyricsFile('a.lrc', '[00:01.00]<00:01.00>a <00:02.00>b').wordSynced).toBe(true)
    expect(describeLyricsFile('a.lrc', 'no stamps')).toMatchObject({ valid: false, format: 'lrc' })
  })

  it('sniffs the format of files with other extensions', () => {
    expect(describeLyricsFile('lyrics.bin', TTML()).format).toBe('ttml')
    expect(describeLyricsFile('lyrics.bin', '[00:01.00]hi').format).toBe('lrc')
    expect(describeLyricsFile('lyrics.XML', TTML()).format).toBe('ttml')
    expect(describeLyricsFile('lyrics.txt', '[00:01.00]hi').format).toBe('lrc')
  })
})

describe('scoreTrackMatch', () => {
  const t = song('1', 'Paper Lanterns', 'Mira Vale', 192)

  it('is 1 for title + artist + duration', () => {
    expect(scoreTrackMatch({ title: 'Paper Lanterns', artist: 'Mira Vale', durationMs: 192_000 }, t)).toBe(1)
  })

  it('is insensitive to case, punctuation and diacritics', () => {
    expect(scoreTrackMatch({ title: 'PAPER  lanterns!', artist: 'míra vale' }, t)).toBeCloseTo(0.9)
  })

  it('without an artist a title-only match is good (0.81) but not certain', () => {
    expect(scoreTrackMatch({ title: 'Paper Lanterns' }, t)).toBeCloseTo(0.81)
  })

  it('a duration within 3 s adds a bonus, further away adds nothing', () => {
    const base = scoreTrackMatch({ title: 'Paper Lanterns' }, t)
    expect(scoreTrackMatch({ title: 'Paper Lanterns', durationMs: 194_900 }, t)).toBeCloseTo(Math.min(1, base + 0.1))
    expect(scoreTrackMatch({ title: 'Paper Lanterns', durationMs: 196_000 }, t)).toBeCloseTo(base)
  })

  it('same title by a different artist is only "review" territory', () => {
    const s = scoreTrackMatch({ title: 'Paper Lanterns', artist: 'Someone Else' }, t)
    expect(s).toBeGreaterThanOrEqual(REVIEW_THRESHOLD)
    expect(s).toBeLessThan(AUTO_THRESHOLD)
  })

  it('matches an artist contained in a longer credit and any of several artists', () => {
    const multi = track('2', { title: 'Duet', artists: [{ id: 'a', name: 'Mira Vale' }, { id: 'b', name: 'Tom Hart' }] })
    expect(scoreTrackMatch({ title: 'Duet', artist: 'Tom Hart' }, multi)).toBeGreaterThanOrEqual(0.85)
    expect(scoreTrackMatch({ title: 'Duet', artist: 'Mira Vale feat. Tom Hart' }, multi)).toBeGreaterThanOrEqual(0.85)
    expect(scoreTrackMatch({ title: 'Duet', artist: 'Mira Vale, Tom Hart' }, multi)).toBeGreaterThanOrEqual(0.85)
    const long = song('3', 'Duet', 'Mira Vale feat. Tom Hart')
    expect(scoreTrackMatch({ title: 'Duet', artist: 'Mira Vale' }, long)).toBeGreaterThanOrEqual(0.85)
    expect(scoreTrackMatch({ title: 'Duet', artist: 'Mira & Tom' }, multi)).toBeGreaterThan(0.6)
  })

  it('is 0 without a title or for a completely different title', () => {
    expect(scoreTrackMatch({}, t)).toBe(0)
    expect(scoreTrackMatch({ artist: 'Mira Vale' }, t)).toBe(0)
    expect(scoreTrackMatch({ title: 'Zzzz' }, t)).toBeLessThan(0.3)
  })

  it('handles tracks with no artists or no duration', () => {
    const bare = track('4', { title: 'Paper Lanterns', artists: [], duration: 0 })
    expect(scoreTrackMatch({ title: 'Paper Lanterns', artist: 'Mira Vale', durationMs: 192_000 }, bare)).toBeCloseTo(0.63)
  })

  it('stays within 0..1', () => {
    for (const d of [{ title: 'Paper Lanterns', artist: 'Mira Vale', durationMs: 192_000 }, { title: 'a' }, { title: 'Paper', artist: 'x' }]) {
      const s = scoreTrackMatch(d, t)
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThanOrEqual(1)
    }
  })
})

describe('pickBestMatch', () => {
  const a = song('a', 'Paper Lanterns', 'Mira Vale', 192)
  const b = song('b', 'Paper Lanterns (Live)', 'Mira Vale', 240)
  const c = song('c', 'Midnight Drive', 'The Example Band', 210)

  it('picks the best candidate with an automatic-level score', () => {
    const m = pickBestMatch({ title: 'Paper Lanterns', artist: 'Mira Vale', durationMs: 192_000 }, [c, a, b])
    // a and b normalise to the same title, so the duration bonus is what separates them.
    expect(m?.track.id).toBe('a')
    expect(m!.score).toBeGreaterThanOrEqual(AUTO_THRESHOLD)
  })

  it('returns null below the review threshold or with no candidates', () => {
    expect(pickBestMatch({ title: 'Something Else Entirely' }, [a, c])).toBeNull()
    expect(pickBestMatch({ title: 'Paper Lanterns' }, [])).toBeNull()
    expect(pickBestMatch({}, [a])).toBeNull()
  })

  it('returns review-level matches', () => {
    const m = pickBestMatch({ title: 'Paper Lanterns', artist: 'Nobody' }, [a])
    expect(m?.track.id).toBe('a')
    expect(confidenceOf(m!.score)).toBe('review')
  })

  it('caps the score just under auto when two candidates are indistinguishable', () => {
    const twin = song('twin', 'Paper Lanterns', 'Mira Vale', 192)
    const m = pickBestMatch({ title: 'Paper Lanterns', artist: 'Mira Vale' }, [a, twin])
    expect(m!.score).toBeLessThan(AUTO_THRESHOLD)
    expect(confidenceOf(m!.score)).toBe('review')
  })

  it('does not cap when the runner-up is clearly worse', () => {
    const m = pickBestMatch({ title: 'Paper Lanterns', artist: 'Mira Vale' }, [a, c])
    expect(m!.score).toBeCloseTo(0.9)
    expect(confidenceOf(m!.score)).toBe('auto')
  })
})

describe('confidenceOf', () => {
  it.each([
    [1, 'auto'],
    [0.75, 'auto'],
    [0.749, 'review'],
    [0.5, 'review'],
    [0.49, 'none'],
    [0, 'none']
  ])('%s -> %s', (score, expected) => expect(confidenceOf(score)).toBe(expected))
})
