import { describe, expect, it } from 'vitest'
import { findActiveLine, lineProgress, parseLrc, parsePlain, type LyricLine } from '@/lyrics/lrc'

describe('parseLrc', () => {
  it.each([null, undefined, '', '   \n  '])('returns empty unsynced for %p', (input) => {
    expect(parseLrc(input)).toEqual({ lines: [], synced: false })
  })

  it('parses basic timestamped lines', () => {
    const r = parseLrc('[00:12.50] Hello\n[01:02.00] World')
    expect(r.synced).toBe(true)
    expect(r.lines).toEqual([
      { time: 12_500, text: 'Hello' },
      { time: 62_000, text: 'World' }
    ])
  })

  it('handles 1, 2 and 3 digit fractions and none', () => {
    const r = parseLrc('[00:01.5] a\n[00:02.50] b\n[00:03.500] c\n[00:04.05] d\n[00:05] e\n[00:06.005] f')
    expect(r.lines.map((l) => l.time)).toEqual([1500, 2500, 3500, 4050, 5000, 6005])
  })

  it('accepts a colon as the fraction separator', () => {
    expect(parseLrc('[00:05:25] x').lines[0]!.time).toBe(5250)
  })

  it('accepts minutes beyond 59 and 3-digit minutes', () => {
    expect(parseLrc('[75:00.00] long').lines[0]!.time).toBe(75 * 60_000)
    expect(parseLrc('[123:00.00] longer').lines[0]!.time).toBe(123 * 60_000)
  })

  it('expands multiple timestamps per line', () => {
    const r = parseLrc('[00:10.00][00:20.00][01:00.00]Chorus')
    expect(r.lines).toEqual([
      { time: 10_000, text: 'Chorus' },
      { time: 20_000, text: 'Chorus' },
      { time: 60_000, text: 'Chorus' }
    ])
  })

  it('sorts unsorted input (including repeated stamps)', () => {
    const r = parseLrc('[00:30.00]c\n[00:10.00]a\n[00:20.00]b\n[00:05.00][00:40.00]x')
    expect(r.lines.map((l) => l.text)).toEqual(['x', 'a', 'b', 'c', 'x'])
    expect(r.lines.map((l) => l.time)).toEqual([5000, 10000, 20000, 30000, 40000])
  })

  it('keeps the original order of equal timestamps (stable sort)', () => {
    const r = parseLrc('[00:10.00]first\n[00:10.00]second')
    expect(r.lines.map((l) => l.text)).toEqual(['first', 'second'])
  })

  describe('offset tag', () => {
    it('subtracts a positive offset (lyrics appear earlier)', () => {
      const r = parseLrc('[offset:+500]\n[00:10.00]a')
      expect(r.lines[0]!.time).toBe(9500)
    })

    it('adds time for a negative offset', () => {
      expect(parseLrc('[offset:-500]\n[00:10.00]a').lines[0]!.time).toBe(10_500)
    })

    it('accepts an unsigned offset, any case, and surrounding spaces', () => {
      expect(parseLrc('[Offset: 250 ]\n[00:10.00]a').lines[0]!.time).toBe(9750)
    })

    it('applies the offset regardless of its position in the file', () => {
      expect(parseLrc('[00:10.00]a\n[offset:+1000]').lines[0]!.time).toBe(9000)
    })

    it('clamps negative resulting times to 0', () => {
      expect(parseLrc('[offset:+5000]\n[00:01.00]a').lines[0]!.time).toBe(0)
    })

    it('ignores a non-numeric offset', () => {
      expect(parseLrc('[offset:abc]\n[00:10.00]a').lines[0]!.time).toBe(10_000)
    })
  })

  it('ignores metadata tags', () => {
    const r = parseLrc('[ar:Artist]\n[ti:Title]\n[al:Album]\n[by:me]\n[length: 03:20]\n[00:01.00]line')
    expect(r.lines).toEqual([{ time: 1000, text: 'line' }])
  })

  it('does not mistake a timestamp for a metadata tag', () => {
    expect(parseLrc('[00:01.00]').synced).toBe(true)
  })

  it('strips enhanced (word-level) tags', () => {
    const r = parseLrc('[00:10.00]<00:10.00>Hel<00:10.50>lo <00:11.00>world')
    expect(r.lines[0]!.text).toBe('Hello world')
  })

  describe('enhanced LRC words', () => {
    it('keeps the line text identical and exposes timed words', () => {
      const r = parseLrc('[00:10.00]<00:10.00>Hel<00:10.50>lo <00:11.00>world<00:12.00>\n[00:13.00]next')
      expect(r.wordSynced).toBe(true)
      expect(r.lines[0]!.text).toBe('Hello world')
      expect(r.lines[0]!.words).toEqual([
        { time: 10_000, end: 10_500, text: 'Hel' },
        { time: 10_500, end: 11_000, text: 'lo ' },
        { time: 11_000, end: 12_000, text: 'world' }
      ])
      expect(r.lines[0]!.words!.map((w) => w.text).join('')).toBe(r.lines[0]!.text)
      expect(r.lines[0]!.end).toBe(12_000)
      expect(r.lines[1]).toEqual({ time: 13_000, text: 'next' })
    })

    it('ends the last word at the next line when there is no closing tag, capped at 6 s', () => {
      const r = parseLrc('[00:10.00]<00:10.00>a <00:11.00>b\n[00:14.00]<00:14.00>c\n[00:30.00]<00:30.00>d')
      expect(r.lines[0]!.words![1]).toEqual({ time: 11_000, end: 14_000, text: 'b' })
      expect(r.lines[1]!.words![0]!.end).toBe(20_000)
      expect(r.lines[2]!.words![0]!.end).toBe(31_500)
    })

    it('handles spaces around tags and collapses whitespace', () => {
      const r = parseLrc('[00:01.00] <00:01.00> one  <00:02.00>  two <00:03.00>three')
      expect(r.lines[0]!.text).toBe('one two three')
      expect(r.lines[0]!.words!.map((w) => w.text)).toEqual(['one ', 'two ', 'three'])
    })

    it('applies the offset tag and multiple stamps to word times', () => {
      const r = parseLrc('[offset:500]\n[00:10.00][00:20.00]<00:10.00>a <00:11.00>b<00:12.00>')
      expect(r.lines.map((l) => l.time)).toEqual([9500, 19_500])
      expect(r.lines[1]!.words!.map((w) => [w.time, w.end])).toEqual([[19_500, 20_500], [20_500, 21_500]])
    })

    it('drops word timing when untimed text precedes the first tag but keeps the text', () => {
      const r = parseLrc('[00:01.00]intro <00:02.00>word')
      expect(r.lines[0]!.text).toBe('intro word')
      expect(r.lines[0]!.words).toBeUndefined()
      expect(r.wordSynced).toBeUndefined()
    })

    it('ignores lines whose tags carry no text and leaves plain LRC without words', () => {
      const r = parseLrc('[00:01.00]<00:01.00>\n[00:02.00]plain')
      expect(r.lines.map((l) => l.words)).toEqual([undefined, undefined])
      expect(r.wordSynced).toBeUndefined()
    })
  })

  it('only honours leading timestamps', () => {
    const r = parseLrc('[00:10.00]text [00:20.00] more')
    expect(r.lines).toEqual([{ time: 10_000, text: 'text [00:20.00] more' }])
  })

  it('skips lines without a leading timestamp', () => {
    const r = parseLrc('plain intro\n[00:10.00]a\nrandom [00:20.00]b')
    expect(r.lines).toEqual([{ time: 10_000, text: 'a' }])
  })

  it('handles CRLF and lone CR line endings', () => {
    expect(parseLrc('[00:01.00]a\r\n[00:02.00]b\r\n').lines.map((l) => l.text)).toEqual(['a', 'b'])
    expect(parseLrc('[00:01.00]a\r[00:02.00]b').lines.map((l) => l.text)).toEqual(['a', 'b'])
  })

  it('trims whitespace and collapses internal runs', () => {
    expect(parseLrc('   [00:01.00]   spaced    out   text   ').lines[0]!.text).toBe('spaced out text')
  })

  it('keeps empty timed lines as instrumental gaps but collapses consecutive ones', () => {
    const r = parseLrc('[00:01.00]a\n[00:05.00]\n[00:06.00]\n[00:07.00]   \n[00:10.00]b')
    expect(r.lines).toEqual([
      { time: 1000, text: 'a' },
      { time: 5000, text: '' },
      { time: 10_000, text: 'b' }
    ])
  })

  it('collapses empty gaps created by multi-timestamp lines too', () => {
    const r = parseLrc('[00:05.00][00:06.00]\n[00:01.00]a')
    expect(r.lines).toEqual([{ time: 1000, text: 'a' }]) // collapsed, then trailing gap dropped
  })

  it('removes trailing empty lines', () => {
    const r = parseLrc('[00:01.00]a\n[00:05.00]\n[00:09.00]')
    expect(r.lines).toEqual([{ time: 1000, text: 'a' }])
  })

  it('keeps a leading empty line (intro gap)', () => {
    const r = parseLrc('[00:00.00]\n[00:05.00]a')
    expect(r.lines[0]).toEqual({ time: 0, text: '' })
  })

  it('reports synced=true with zero lines when only empty stamps exist', () => {
    expect(parseLrc('[00:01.00]\n[00:02.00]')).toEqual({ lines: [], synced: true })
  })

  it('treats text without any timestamps as unsynced', () => {
    expect(parseLrc('just\nsome\nwords')).toEqual({ lines: [], synced: false })
    expect(parseLrc('[ar:x]\n[ti:y]')).toEqual({ lines: [], synced: false })
  })

  it('rejects malformed timestamps', () => {
    expect(parseLrc('[0:xx.00] a').synced).toBe(false)
    expect(parseLrc('[00:1234] a').synced).toBe(false)
  })

  it('supports unicode text', () => {
    expect(parseLrc('[00:01.00]こんにちは 🎵').lines[0]!.text).toBe('こんにちは 🎵')
  })

  it('is safe to call repeatedly (regex state does not leak between calls)', () => {
    const input = '[00:01.00][00:02.00]a'
    expect(parseLrc(input).lines).toHaveLength(2)
    expect(parseLrc(input).lines).toHaveLength(2)
  })
})

describe('lineProgress with line.end', () => {
  it('uses the line end when known', () => {
    const lines: LyricLine[] = [{ time: 0, end: 2000, text: 'a' }, { time: 10_000, text: 'b' }]
    expect(lineProgress(lines, 0, 1000)).toBe(0.5)
    expect(lineProgress(lines, 0, 5000)).toBe(1)
  })
})

describe('parsePlain', () => {
  it.each([null, undefined, ''])('returns empty for %p', (input) => {
    expect(parsePlain(input)).toEqual({ lines: [], synced: false })
  })

  it('splits lines, trims, and keeps interior blank lines as stanza breaks', () => {
    const r = parsePlain('  one  \n two\n\n three ')
    expect(r.synced).toBe(false)
    expect(r.lines).toEqual([
      { time: 0, text: 'one' },
      { time: 0, text: 'two' },
      { time: 0, text: '' },
      { time: 0, text: 'three' }
    ])
  })

  it('removes leading and trailing blank lines', () => {
    expect(parsePlain('\n\n  \nhello\n\n\n').lines).toEqual([{ time: 0, text: 'hello' }])
  })

  it('handles CRLF and CR', () => {
    expect(parsePlain('a\r\nb\rc').lines.map((l) => l.text)).toEqual(['a', 'b', 'c'])
  })

  it('returns no lines for whitespace-only input', () => {
    expect(parsePlain('  \n \n').lines).toEqual([])
  })
})

describe('findActiveLine', () => {
  const lines: LyricLine[] = [
    { time: 1000, text: 'a' },
    { time: 2000, text: 'b' },
    { time: 3000, text: 'c' }
  ]

  it('returns -1 for no lines', () => {
    expect(findActiveLine([], 5000)).toBe(-1)
  })

  it('returns -1 before the first line', () => {
    expect(findActiveLine(lines, 0)).toBe(-1)
    expect(findActiveLine(lines, 999)).toBe(-1)
    expect(findActiveLine(lines, -50)).toBe(-1)
  })

  it('activates a line exactly at its start time', () => {
    expect(findActiveLine(lines, 1000)).toBe(0)
    expect(findActiveLine(lines, 2000)).toBe(1)
    expect(findActiveLine(lines, 3000)).toBe(2)
  })

  it('stays on the previous line until the next boundary', () => {
    expect(findActiveLine(lines, 1999)).toBe(0)
    expect(findActiveLine(lines, 2999)).toBe(1)
  })

  it('stays on the last line after it', () => {
    expect(findActiveLine(lines, 3001)).toBe(2)
    expect(findActiveLine(lines, 10_000_000)).toBe(2)
  })

  it('works with a single line', () => {
    expect(findActiveLine([{ time: 500, text: 'x' }], 499)).toBe(-1)
    expect(findActiveLine([{ time: 500, text: 'x' }], 500)).toBe(0)
  })

  it('picks the last of several identical timestamps', () => {
    const dup: LyricLine[] = [{ time: 10, text: 'a' }, { time: 10, text: 'b' }, { time: 20, text: 'c' }]
    expect(findActiveLine(dup, 10)).toBe(1)
  })

  it('agrees with a linear scan on a large list', () => {
    const big = Array.from({ length: 1000 }, (_, i) => ({ time: i * 137, text: String(i) }))
    for (const t of [0, 1, 136, 137, 5000, 136_000, 136_863, 136_864, 999_999]) {
      let expected = -1
      for (let i = 0; i < big.length; i++) if (big[i]!.time <= t) expected = i
      expect(findActiveLine(big, t)).toBe(expected)
    }
  })
})

describe('lineProgress', () => {
  const lines: LyricLine[] = [
    { time: 1000, text: 'a' },
    { time: 3000, text: 'b' }
  ]

  it('returns 0 for an invalid index', () => {
    expect(lineProgress(lines, -1, 1500)).toBe(0)
    expect(lineProgress(lines, 5, 1500)).toBe(0)
    expect(lineProgress([], 0, 0)).toBe(0)
  })

  it('is linear between a line and the next one', () => {
    expect(lineProgress(lines, 0, 1000)).toBe(0)
    expect(lineProgress(lines, 0, 2000)).toBeCloseTo(0.5)
    expect(lineProgress(lines, 0, 3000)).toBe(1)
  })

  it('clamps to 0..1', () => {
    expect(lineProgress(lines, 0, 500)).toBe(0)
    expect(lineProgress(lines, 0, 9000)).toBe(1)
  })

  it('uses +4s for the last line when the track end is unknown', () => {
    expect(lineProgress(lines, 1, 5000)).toBeCloseTo(0.5)
    expect(lineProgress(lines, 1, 7000)).toBe(1)
  })

  it('uses the track end for the last line, capped at +6s', () => {
    expect(lineProgress(lines, 1, 4000, 5000)).toBeCloseTo(0.5) // span 2000
    expect(lineProgress(lines, 1, 6000, 60_000)).toBeCloseTo(0.5) // capped to 6000 span
  })

  it('never divides by zero', () => {
    const same: LyricLine[] = [{ time: 1000, text: 'a' }, { time: 1000, text: 'b' }]
    expect(lineProgress(same, 0, 1000)).toBe(0)
    expect(lineProgress(same, 0, 1001)).toBe(1)
    expect(lineProgress([{ time: 1000, text: 'x' }], 0, 1000, 1000)).toBe(0)
  })
})
