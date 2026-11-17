import { describe, expect, it } from 'vitest'
import {
  MAX_LYRICS_BYTES,
  inspectTtml,
  parseTtml,
  parseTtmlTime,
  readTtmlMetadata,
  validateLrc,
  validateTtml
} from '@/lyrics/ttml'

const NS = 'xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" xmlns:itunes="http://music.apple.com/lyric-ttml-internal"'

/** Document with absolute times everywhere (Apple style). */
function ttAbs(body: string, attrs = '', head = ''): string {
  return tt(body, `itunes:timing="Word" ${attrs}`, head)
}

function tt(body: string, attrs = '', head = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?><tt ${NS} ${attrs}>${head}<body>${body}</body></tt>`
}

const texts = (xml: string): string[] => parseTtml(xml).lines.map((l) => l.text)

describe('parseTtmlTime', () => {
  it.each([
    ['00:00:12.345', 12_345],
    ['01:02:03.5', 3_723_500],
    ['00:00:01', 1000],
    ['01:02.250', 62_250],
    ['75:00.000', 4_500_000],
    ['12.5', 12_500],
    ['0', 0],
    ['7', 7000],
    ['1.5s', 1500],
    ['250ms', 250],
    ['2m', 120_000],
    ['0.5h', 1_800_000],
    ['.5s', 500],
    [' 3s ', 3000]
  ])('%s -> %i ms', (input, ms) => {
    expect(parseTtmlTime(input)).toBe(ms)
  })

  it('supports frames with the default 30 fps and a custom rate', () => {
    expect(parseTtmlTime('15f')).toBe(500)
    expect(parseTtmlTime('25f', { frameRate: 25, tickRate: 1 })).toBe(1000)
    expect(parseTtmlTime('00:00:01:15')).toBe(1500)
  })

  it('supports ticks', () => {
    expect(parseTtmlTime('10000000t', { frameRate: 30, tickRate: 10_000_000 })).toBe(1000)
    expect(parseTtmlTime('5000t', { frameRate: 30, tickRate: 10_000 })).toBe(500)
  })

  it.each([null, undefined, '', '   ', 'abc', '1:2:3:4:5', '-1s', '1x', '00:aa:01', '1..5', '12:', ':12'])('rejects %p', (input) => {
    expect(parseTtmlTime(input)).toBeNull()
  })
})

describe('parseTtml: time formats in documents', () => {
  it('reads clock, offset, frame and tick times from the document parameters', () => {
    const xml = tt(
      `<div>
        <p begin="00:00:01.000" end="2s">clock</p>
        <p begin="3000ms" end="4s">ms</p>
        <p begin="60f" end="75f">frames</p>
        <p begin="50000t" end="60000t">ticks</p>
      </div>`,
      'ttp:frameRate="30" ttp:tickRate="10000"'
    )
    const r = parseTtml(xml)
    expect(r.synced).toBe(true)
    expect(r.lines.map((l) => [l.text, l.time, l.end])).toEqual([
      ['clock', 1000, 2000],
      ['frames', 2000, 2500],
      ['ms', 3000, 4000],
      ['ticks', 5000, 6000]
    ])
  })

  it('honours ttp:frameRateMultiplier and a default tickRate derived from frameRate', () => {
    const xml = tt('<div><p begin="30f" end="60f">x</p></div>', 'ttp:frameRate="30" ttp:frameRateMultiplier="1000 1001"')
    const [l] = parseTtml(xml).lines
    expect(l!.time).toBe(Math.round((30 / (30 * (1000 / 1001))) * 1000))
    const xml2 = tt('<div><p begin="60t">x</p></div>', 'ttp:frameRate="30" ttp:subFrameRate="2"')
    expect(parseTtml(xml2).lines[0]!.time).toBe(1000)
  })

  it('uses dur when end is missing, and the earlier of end and dur otherwise', () => {
    const xml = tt('<div><p begin="1s" dur="2s">a</p><p begin="10s" end="20s" dur="3s">b</p></div>')
    const lines = parseTtml(xml).lines
    expect(lines[0]).toMatchObject({ time: 1000, end: 3000 })
    expect(lines[1]).toMatchObject({ time: 10_000, end: 13_000 })
  })
})

describe('parseTtml: time containment', () => {
  it('offsets p by div begin and spans by p begin (W3C par semantics)', () => {
    const xml = tt(
      `<div begin="10s"><p begin="1s" end="3s"><span begin="0s" end="1s">Hi</span> <span begin="1s" end="2s">there</span></p></div>`
    )
    const [l] = parseTtml(xml).lines
    expect(l).toMatchObject({ time: 11_000, end: 13_000, text: 'Hi there' })
    expect(l!.words).toEqual([
      { time: 11_000, end: 12_000, text: 'Hi ' },
      { time: 12_000, end: 13_000, text: 'there' }
    ])
  })

  it('offsets by body begin and nested divs', () => {
    const xml = tt(`<div begin="5s"><div begin="5s"><p begin="1s">deep</p></div></div>`).replace('<body>', '<body begin="100s">')
    expect(parseTtml(xml).lines[0]!.time).toBe(111_000)
  })

  it('treats files with itunes:timing as absolute (Apple writes absolute times inside <div begin>)', () => {
    const xml = tt(
      `<div begin="12.000" end="20.000"><p begin="12.000" end="15.000"><span begin="12.000" end="13.000">Hey</span> <span begin="13.000" end="15.000">you</span></p></div>`,
      'itunes:timing="Word"'
    )
    const [l] = parseTtml(xml).lines
    expect(l!.time).toBe(12_000)
    expect(l!.words!.map((w) => w.time)).toEqual([12_000, 13_000])
  })

  it('detects absolute times without itunes:timing when relative offsets could not fit the parent', () => {
    const xml = tt(
      '<div begin="100s" end="120s"><p begin="100s" end="104s"><span begin="100s" end="102s">Far</span> <span begin="102s" end="104s">in</span></p><p begin="110s" end="114s">time</p></div>'
    )
    const r = parseTtml(xml)
    expect(r.lines.map((l) => l.time)).toEqual([100_000, 110_000])
    expect(r.lines[0]!.words!.map((w) => w.time)).toEqual([100_000, 102_000])
  })

  it('stays relative when both readings would fit (W3C default)', () => {
    const xml = tt('<div begin="10s" end="40s"><p begin="2s" end="6s">x</p></div>')
    expect(parseTtml(xml).lines[0]!.time).toBe(12_000)
  })

  it('sorts lines by time and keeps document order for ties', () => {
    const xml = tt('<div><p begin="5s">c</p><p begin="1s">a</p><p begin="1s">b</p></div>')
    expect(texts(xml)).toEqual(['a', 'b', 'c'])
  })

  it('gives each line an end: its own, or the next line begin', () => {
    const xml = tt('<div><p begin="1s" end="2s">a</p><p begin="5s">b</p><p begin="9s">c</p></div>')
    const ends = parseTtml(xml).lines.map((l) => l.end)
    expect(ends).toEqual([2000, 9000, 13_000])
  })

  it('ignores an own end that is not after the begin', () => {
    const xml = tt('<div><p begin="5s" end="2s">a</p><p begin="8s">b</p></div>')
    expect(parseTtml(xml).lines[0]!.end).toBe(8000)
  })

  it('lets a line without begin inherit the previous end', () => {
    const xml = tt('<div><p begin="1s" end="3s">a</p><p>orphan</p><p begin="9s">b</p></div>')
    expect(parseTtml(xml).lines.map((l) => [l.text, l.time])).toEqual([['a', 1000], ['orphan', 3000], ['b', 9000]])
  })
})

describe('parseTtml: words, whitespace and syllables', () => {
  it('splits spans into words; whitespace between spans separates words', () => {
    const xml = tt(
      '<div><p begin="1s" end="4s"><span begin="1s" end="2s">Hello</span> <span begin="2s" end="3s">brave</span> <span begin="3s" end="4s">world</span></p></div>'
    )
    const r = parseTtml(xml)
    expect(r.wordSynced).toBe(true)
    const l = r.lines[0]!
    expect(l.text).toBe('Hello brave world')
    expect(l.words!.map((w) => w.text).join('')).toBe(l.text)
    expect(l.words!.map((w) => w.text)).toEqual(['Hello ', 'brave ', 'world'])
  })

  it('keeps syllables of one word separate for timing but without a space between them', () => {
    const xml = ttAbs(
      '<div><p begin="1s" end="3s"><span begin="1s" end="1.5s">Won</span><span begin="1.5s" end="2s">der</span><span begin="2s" end="3s">ful</span> <span begin="3s" end="4s">day</span></p></div>'
    )
    const l = parseTtml(xml).lines[0]!
    expect(l.text).toBe('Wonderful day')
    expect(l.words!.map((w) => w.text)).toEqual(['Won', 'der', 'ful ', 'day'])
    expect(l.words!.map((w) => w.time)).toEqual([1000, 1500, 2000, 3000])
  })

  it('accepts trailing and leading spaces inside spans and collapses runs of whitespace', () => {
    const xml = tt(
      '<div><p begin="1s" end="4s"><span begin="1s" end="2s">Hello  </span><span begin="2s" end="3s">\n   there</span><span begin="3s" end="4s"> you </span></p></div>'
    )
    const l = parseTtml(xml).lines[0]!
    expect(l.text).toBe('Hello there you')
    expect(l.words!.map((w) => w.text)).toEqual(['Hello ', 'there ', 'you'])
  })

  it('handles pretty-printed XML with newlines between spans', () => {
    const xml = tt(`<div><p begin="1s" end="3s">
      <span begin="1s" end="2s">one</span>
      <span begin="2s" end="3s">two</span>
    </p></div>`)
    expect(parseTtml(xml).lines[0]!.text).toBe('one two')
  })

  it('flattens nested spans and inherits the outer timing for untimed inner spans', () => {
    const xml = ttAbs(
      '<div><p begin="1s" end="5s"><span begin="1s" end="2s"><span>nested</span></span> <span><span begin="2s" end="3s">deep</span><span begin="3s" end="4s">er</span></span></p></div>'
    )
    const l = parseTtml(xml).lines[0]!
    expect(l.text).toBe('nested deeper')
    expect(l.words).toEqual([
      { time: 1000, end: 2000, text: 'nested ' },
      { time: 2000, end: 3000, text: 'deep' },
      { time: 3000, end: 4000, text: 'er' }
    ])
  })

  it('turns <br/> into a space', () => {
    const xml = tt('<div><p begin="1s" end="3s">first<br/>second</p><p begin="4s" end="6s"><span begin="4s" end="5s">a</span><br/><span begin="5s" end="6s">b</span></p></div>')
    const r = parseTtml(xml)
    expect(r.lines[0]!.text).toBe('first second')
    expect(r.lines[1]!.text).toBe('a b')
    expect(r.lines[1]!.words!.map((w) => w.text)).toEqual(['a ', 'b'])
  })

  it('fills a missing word end from the next word, and the last from the line end', () => {
    const xml = ttAbs('<div><p begin="1s" end="4s"><span begin="1s">a</span> <span begin="2s">b</span> <span begin="3s">c</span></p></div>')
    const w = parseTtml(xml).lines[0]!.words!
    expect(w.map((x) => [x.time, x.end])).toEqual([[1000, 2000], [2000, 3000], [3000, 4000]])
  })

  it('uses the next line begin as the last word end when the line has no end', () => {
    const xml = ttAbs('<div><p begin="1s"><span begin="1s">a</span></p><p begin="4s">b</p></div>')
    expect(parseTtml(xml).lines[0]!.words![0]).toEqual({ time: 1000, end: 4000, text: 'a' })
  })

  it('never produces a word that ends before it starts', () => {
    const xml = tt('<div><p begin="1s" end="5s"><span begin="3s" end="2s">x</span></p></div>')
    const [w] = parseTtml(xml).lines[0]!.words!
    expect(w!.end).toBeGreaterThanOrEqual(w!.time)
  })

  it('derives the line start from the first span when p has no begin', () => {
    const xml = tt('<div><p><span begin="7s" end="8s">late</span> <span begin="8s" end="9s">start</span></p></div>')
    const l = parseTtml(xml).lines[0]!
    expect(l.time).toBe(7000)
    expect(l.text).toBe('late start')
  })

  it('treats untimed text next to timed spans as a zero-length word', () => {
    const xml = tt('<div><p begin="1s" end="4s">Oh <span begin="2s" end="3s">yeah</span></p></div>')
    const l = parseTtml(xml).lines[0]!
    expect(l.words!.map((w) => w.text)).toEqual(['Oh ', 'yeah'])
    expect(l.words![0]).toMatchObject({ time: 1000, end: 1000 })
  })

  it('ignores translation and transliteration spans', () => {
    const xml = tt(
      '<div><p begin="1s" end="3s"><span begin="1s" end="2s">hola</span> <span begin="2s" end="3s">mundo</span><span ttm:role="x-translation" xml:lang="en">hello world</span><span ttm:role="x-roman">hola mundo</span></p></div>'
    )
    expect(texts(xml)).toEqual(['hola mundo'])
  })

  it('does not treat metadata or style children of a paragraph as text', () => {
    const xml = tt('<div><p begin="1s">text<metadata><ttm:desc>nope</ttm:desc></metadata></p></div>')
    expect(texts(xml)).toEqual(['text'])
  })
})

describe('parseTtml: line-only, untimed and timing modes', () => {
  it('returns synced lines without words for line-only TTML', () => {
    const xml = tt('<div><p begin="1s" end="3s">First line</p><p begin="4s" end="6s">Second line</p></div>')
    const r = parseTtml(xml)
    expect(r.synced).toBe(true)
    expect(r.wordSynced).toBeUndefined()
    expect(r.lines).toEqual([
      { time: 1000, end: 3000, text: 'First line' },
      { time: 4000, end: 6000, text: 'Second line' }
    ])
  })

  it('ignores untimed spans inside a timed line (styling spans)', () => {
    const xml = tt('<div><p begin="1s" end="3s">Hello <span tts:fontStyle="italic" xmlns:tts="http://www.w3.org/ns/ttml#styling">world</span></p></div>')
    const l = parseTtml(xml).lines[0]!
    expect(l.text).toBe('Hello world')
    expect(l.words).toBeUndefined()
  })

  it('returns plain lines for untimed TTML', () => {
    const xml = tt('<div><p>One</p><p>Two</p><p></p><p>Three</p></div>')
    const r = parseTtml(xml)
    expect(r.synced).toBe(false)
    expect(r.lines.map((l) => l.text)).toEqual(['One', 'Two', '', 'Three'])
    expect(r.lines.every((l) => l.time === 0)).toBe(true)
  })

  it('trims blank lines at the edges of untimed TTML', () => {
    expect(texts(tt('<div><p></p><p>a</p><p> </p></div>'))).toEqual(['a'])
  })

  it('itunes:timing="Line" drops word timing even if spans carry it', () => {
    const xml = tt('<div><p begin="1s" end="3s"><span begin="1s" end="2s">a</span> <span begin="2s" end="3s">b</span></p></div>', 'itunes:timing="Line"')
    const r = parseTtml(xml)
    expect(r.wordSynced).toBeUndefined()
    expect(r.lines[0]).toMatchObject({ text: 'a b', time: 1000 })
    expect(r.lines[0]!.words).toBeUndefined()
  })

  it('itunes:timing="None" produces plain lines', () => {
    const xml = tt('<div><p begin="1s">a</p><p begin="2s">b</p></div>', 'itunes:timing="None"')
    const r = parseTtml(xml)
    expect(r.synced).toBe(false)
    expect(r.lines.map((l) => l.text)).toEqual(['a', 'b'])
  })

  it('itunes:timing="Word" keeps words', () => {
    const xml = tt('<div><p begin="1s" end="3s"><span begin="1s" end="2s">a</span> <span begin="2s" end="3s">b</span></p></div>', 'itunes:timing="Word"')
    expect(parseTtml(xml).wordSynced).toBe(true)
  })

  it('returns empty lyrics when there is no body', () => {
    expect(parseTtml(`<tt ${NS}><head/></tt>`)).toEqual({ lines: [], synced: false })
  })

  it('collapses runs of empty timed lines and drops trailing ones', () => {
    const xml = tt('<div><p begin="1s">a</p><p begin="2s"></p><p begin="3s"></p><p begin="4s">b</p><p begin="5s"></p></div>')
    expect(texts(xml)).toEqual(['a', '', 'b'])
  })
})

describe('parseTtml: agents and duets', () => {
  const head = `<head><metadata><ttm:agent type="person" xml:id="v1"><ttm:name type="full">Alice Example</ttm:name></ttm:agent><ttm:agent type="person" xml:id="v2"/><ttm:agent type="group" xml:id="v1000"/></metadata></head>`

  it('aligns the first singer to start and the second to end', () => {
    const xml = tt(
      '<div><p begin="1s" end="2s" ttm:agent="v1">a</p><p begin="3s" end="4s" ttm:agent="v2">b</p><p begin="5s" end="6s" ttm:agent="v1">c</p></div>',
      '',
      head
    )
    expect(parseTtml(xml).lines.map((l) => [l.agent, l.align])).toEqual([['v1', 'start'], ['v2', 'end'], ['v1', 'start']])
  })

  it('puts groups (declared group type or v1000+/v2000 ids) at start without using up the second slot', () => {
    const xml = tt(
      '<div><p begin="1s" ttm:agent="v1000">all</p><p begin="3s" ttm:agent="v1">one</p><p begin="5s" ttm:agent="v2">two</p><p begin="7s" ttm:agent="v2000">crowd</p></div>',
      '',
      head
    )
    const align = parseTtml(xml).lines.map((l) => l.align)
    expect(align).toEqual(['start', 'start', 'end', 'start'])
  })

  it('numbers singers in order of first appearance, and sends a third singer to start', () => {
    const xml = tt('<div><p begin="1s" ttm:agent="v2">x</p><p begin="3s" ttm:agent="v1">y</p><p begin="5s" ttm:agent="v3">z</p></div>')
    expect(parseTtml(xml).lines.map((l) => l.align)).toEqual(['start', 'end', 'start'])
  })

  it('inherits the agent from the div and lets p override it', () => {
    const xml = tt(
      '<div ttm:agent="v1"><p begin="1s">a</p><p begin="2s" ttm:agent="v2">b</p></div><div ttm:agent="v2"><p begin="3s">c</p></div>'
    )
    expect(parseTtml(xml).lines.map((l) => [l.agent, l.align])).toEqual([['v1', 'start'], ['v2', 'end'], ['v2', 'end']])
  })

  it('leaves agent and align unset when the document has no agents', () => {
    const l = parseTtml(tt('<div><p begin="1s">a</p></div>')).lines[0]!
    expect(l.agent).toBeUndefined()
    expect(l.align).toBeUndefined()
  })
})

describe('parseTtml: background vocals (x-bg)', () => {
  const xml = ttAbs(
    `<div><p begin="1s" end="6s" ttm:agent="v1">
      <span begin="1s" end="2s">Main</span> <span begin="2s" end="3s">voice</span>
      <span ttm:role="x-bg"><span begin="2.5s" end="3.5s">(ooh</span> <span begin="3.5s" end="4s">aah)</span></span>
    </p></div>`
  )

  it('collects backing words separately with their own timing and strips the parentheses', () => {
    const l = parseTtml(xml).lines[0]!
    expect(l.text).toBe('Main voice')
    expect(l.words!.map((w) => w.text)).toEqual(['Main ', 'voice'])
    expect(l.background).toEqual({
      text: 'ooh aah',
      words: [
        { time: 2500, end: 3500, text: 'ooh ' },
        { time: 3500, end: 4000, text: 'aah' }
      ]
    })
  })

  it('reports wordSynced', () => {
    expect(parseTtml(xml).wordSynced).toBe(true)
  })

  it('handles a single-span background with its own timing', () => {
    const x = ttAbs('<div><p begin="1s" end="5s"><span begin="1s" end="2s">Lead</span> <span ttm:role="x-bg" begin="2s" end="4s"><span begin="2s" end="4s">(echo)</span></span></p></div>')
    expect(parseTtml(x).lines[0]!.background).toEqual({ text: 'echo', words: [{ time: 2000, end: 4000, text: 'echo' }] })
  })

  it('uses the x-bg span timing for untimed inner text', () => {
    const x = ttAbs('<div><p begin="1s" end="5s"><span begin="1s" end="2s">Lead</span> <span ttm:role="x-bg" begin="2s" end="4s">(echo)</span></p></div>')
    expect(parseTtml(x).lines[0]!.background!.words).toEqual([{ time: 2000, end: 4000, text: 'echo' }])
  })

  it('keeps backing text for line-timed lyrics without word timing', () => {
    const x = tt('<div><p begin="1s" end="5s">Lead <span ttm:role="x-bg">(echo)</span></p></div>')
    const l = parseTtml(x).lines[0]!
    expect(l.text).toBe('Lead')
    expect(l.background).toEqual({ text: 'echo', words: [] })
  })

  it('promotes a backing-only paragraph to a normal line', () => {
    const x = ttAbs('<div><p begin="1s" end="3s"><span ttm:role="x-bg"><span begin="1s" end="2s">(la</span> <span begin="2s" end="3s">la)</span></span></p></div>')
    const l = parseTtml(x).lines[0]!
    expect(l.text).toBe('la la')
    expect(l.background).toBeUndefined()
    expect(l.words).toHaveLength(2)
  })

  it('does not strip inner parentheses', () => {
    const x = tt('<div><p begin="1s" end="5s"><span begin="1s" end="2s">Lead</span> <span ttm:role="x-bg"><span begin="2s" end="3s">(a (b) c)</span></span></p></div>')
    expect(parseTtml(x).lines[0]!.background!.text).toBe('a (b) c')
  })

  it('extends the line end over backing vocals when the line has no end of its own', () => {
    const x = ttAbs('<div><p begin="1s"><span begin="1s" end="2s">Lead</span> <span ttm:role="x-bg"><span begin="2s" end="6s">(tail)</span></span></p></div>')
    expect(parseTtml(x).lines[0]!.end).toBe(6000)
  })
})

describe('parseTtml: namespaces and structure', () => {
  it('matches elements by local name regardless of prefixes', () => {
    const xml = `<?xml version="1.0"?><ns:tt xmlns:ns="http://www.w3.org/ns/ttml"><ns:body><ns:div><ns:p begin="1s" end="2s"><ns:span begin="1s" end="2s">prefixed</ns:span></ns:p></ns:div></ns:body></ns:tt>`
    const r = parseTtml(xml)
    expect(r.lines[0]).toMatchObject({ text: 'prefixed', time: 1000 })
  })

  it('works without any namespace declaration', () => {
    const r = parseTtml('<tt><body><div><p begin="1s" end="2s">bare</p></div></body></tt>')
    expect(r.lines[0]!.text).toBe('bare')
  })

  it('handles paragraphs directly under body and CDATA text', () => {
    const r = parseTtml('<tt><body><p begin="1s"><![CDATA[a < b & c]]></p></body></tt>')
    expect(r.lines[0]!.text).toBe('a < b & c')
  })

  it('decodes predefined entities and numeric character references', () => {
    const r = parseTtml('<tt><body><p begin="1s">Tom &amp; Jerry &#8217;s &lt;3 caf&#233;</p></body></tt>')
    expect(r.lines[0]!.text).toBe('Tom & Jerry ’s <3 café')
  })

  it('never produces HTML: markup in text stays literal text', () => {
    const r = parseTtml('<tt><body><p begin="1s">&lt;script&gt;alert(1)&lt;/script&gt;</p></body></tt>')
    expect(r.lines[0]!.text).toBe('<script>alert(1)</script>')
  })
})

describe('readTtmlMetadata', () => {
  it('reads ttm:title and the first named person agent as artist', () => {
    const xml = tt(
      '<div><p begin="1s">x</p></div>',
      '',
      '<head><metadata><ttm:title>Midnight Drive</ttm:title><ttm:agent type="person" xml:id="v1"><ttm:name type="full">The Example Band</ttm:name></ttm:agent></metadata></head>'
    )
    expect(readTtmlMetadata(xml)).toEqual({ title: 'Midnight Drive', artist: 'The Example Band' })
  })

  it('reads "Artist - Title" from ttm:desc when there is no title', () => {
    const xml = tt('<div><p begin="1s">x</p></div>', '', '<head><metadata><ttm:desc>Some Artist - Some Song</ttm:desc></metadata></head>')
    expect(readTtmlMetadata(xml)).toEqual({ title: 'Some Song', artist: 'Some Artist' })
  })

  it('ignores a ttm:desc that is not shaped like "Artist - Title"', () => {
    const xml = tt('<div><p begin="1s">x</p></div>', '', '<head><metadata><ttm:desc>Lyrics for a song</ttm:desc></metadata></head>')
    expect(readTtmlMetadata(xml)).toEqual({})
  })

  it('reads attributes on <tt> and on Apple iTunesMetadata, and ignores songwriters', () => {
    const a = tt('<div><p begin="1s">x</p></div>', 'title="T1" artist="A1" album="Al1"')
    expect(readTtmlMetadata(a)).toEqual({ title: 'T1', artist: 'A1', album: 'Al1' })
    const b = tt(
      '<div><p begin="1s">x</p></div>',
      '',
      '<head><metadata><iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal" title="T2" artist="A2"><songwriters><songwriter>Not Me</songwriter></songwriters></iTunesMetadata></metadata></head>'
    )
    expect(readTtmlMetadata(b)).toEqual({ title: 'T2', artist: 'A2' })
    const c = tt(
      '<div><p begin="1s">x</p></div>',
      '',
      '<head><metadata><iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal"><title>T3</title><artist>A3</artist><album>Al3</album><songwriters><songwriter>Nope</songwriter></songwriters></iTunesMetadata></metadata></head>'
    )
    expect(readTtmlMetadata(c)).toEqual({ title: 'T3', artist: 'A3', album: 'Al3' })
  })

  it('prefers ttm:title over attributes', () => {
    const xml = tt('<div><p begin="1s">x</p></div>', 'title="Attr"', '<head><metadata><ttm:title>Elem</ttm:title></metadata></head>')
    expect(readTtmlMetadata(xml).title).toBe('Elem')
  })

  it('reads the duration from body dur, then body end, then div ends', () => {
    expect(readTtmlMetadata(tt('<div><p begin="1s">x</p></div>').replace('<body>', '<body dur="03:24.500">')).durationMs).toBe(204_500)
    expect(readTtmlMetadata(tt('<div><p begin="1s">x</p></div>').replace('<body>', '<body end="200s">')).durationMs).toBe(200_000)
    expect(readTtmlMetadata(tt('<div end="10s"><p begin="1s">x</p></div><div end="30s"><p begin="12s">y</p></div>')).durationMs).toBe(30_000)
    expect(readTtmlMetadata(tt('<div><p begin="1s">x</p></div>')).durationMs).toBeUndefined()
  })

  it('returns {} for rejected documents', () => {
    expect(readTtmlMetadata('<tt><body')).toEqual({})
    expect(readTtmlMetadata('')).toEqual({})
  })
})

describe('rejection: malformed and unsafe input', () => {
  it.each([
    ['empty string', ''],
    ['whitespace', '  \n '],
    ['not XML', 'just some text'],
    ['unclosed tag', '<tt><body><p begin="1s">x</body></tt>'],
    ['mismatched tags', '<tt><body><p begin="1s">x</div></body></tt>'],
    ['undefined entity', '<tt><body><p begin="1s">&nope;</p></body></tt>'],
    ['wrong root', '<html><body><p begin="1s">x</p></body></html>'],
    ['LRC text', '[00:01.00] hi']
  ])('%s -> empty lyrics', (_n, xml) => {
    expect(parseTtml(xml)).toEqual({ lines: [], synced: false })
    expect(inspectTtml(xml).error).toBeTruthy()
  })

  it('rejects non-string input without throwing', () => {
    expect(parseTtml(undefined as unknown as string)).toEqual({ lines: [], synced: false })
    expect(parseTtml(null as unknown as string)).toEqual({ lines: [], synced: false })
  })

  it('rejects DOCTYPE declarations before parsing', () => {
    const xml = '<?xml version="1.0"?><!DOCTYPE tt SYSTEM "http://example.invalid/x.dtd"><tt><body><p begin="1s">x</p></body></tt>'
    expect(parseTtml(xml)).toEqual({ lines: [], synced: false })
    expect(validateTtml(xml)).toEqual({ ok: false, message: expect.stringContaining('DOCTYPE') })
  })

  it('rejects ENTITY declarations (XXE and billion laughs), in any case and spacing', () => {
    const xxe = '<!DOCTYPE tt [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><tt><body><p begin="1s">&xxe;</p></body></tt>'
    const lol = '<!doctype tt [<!entity a "aaaa"><!entity b "&a;&a;&a;&a;">]><tt><body><p begin="1s">&b;</p></body></tt>'
    const sneaky = '<tt><body><p begin="1s">x</p></body></tt><!  ENTITY x "y">'
    for (const xml of [xxe, lol, sneaky]) {
      expect(parseTtml(xml)).toEqual({ lines: [], synced: false })
      expect(readTtmlMetadata(xml)).toEqual({})
      expect(validateTtml(xml).ok).toBe(false)
    }
  })

  it('rejects documents larger than 1 MiB without parsing them', () => {
    const big = tt(`<div><p begin="1s">${'a'.repeat(MAX_LYRICS_BYTES)}</p></div>`)
    expect(parseTtml(big)).toEqual({ lines: [], synced: false })
    expect(validateTtml(big)).toEqual({ ok: false, message: expect.stringContaining('1 MiB') })
  })

  it('counts UTF-8 bytes, not characters, against the limit', () => {
    // 400k three-byte characters are 1.2 MB of UTF-8 but only 400k UTF-16 code units.
    const s = tt(`<div><p begin="1s">${'€'.repeat(400_000)}</p></div>`)
    expect(s.length).toBeLessThan(MAX_LYRICS_BYTES)
    expect(validateTtml(s).ok).toBe(false)
  })

  it('accepts a document just under the limit', () => {
    const ok = tt(`<div><p begin="1s">${'a'.repeat(MAX_LYRICS_BYTES - 1000)}</p></div>`)
    expect(validateTtml(ok)).toEqual({ ok: true })
  })
})

describe('validateTtml', () => {
  it('accepts line-timed, word-timed and offset-timed documents', () => {
    expect(validateTtml(tt('<div><p begin="1s">x</p></div>'))).toEqual({ ok: true })
    expect(validateTtml(tt('<div><p begin="00:01.000"><span begin="1s">x</span></p></div>'))).toEqual({ ok: true })
  })

  it('needs at least one <p> with a valid begin', () => {
    expect(validateTtml(tt('<div><p>x</p></div>'))).toMatchObject({ ok: false })
    expect(validateTtml(tt('<div><p begin="soon">x</p></div>'))).toMatchObject({ ok: false })
    expect(validateTtml(tt('<div></div>'))).toMatchObject({ ok: false })
  })

  it('reports XML and root problems', () => {
    expect(validateTtml('<tt>')).toMatchObject({ ok: false, message: expect.stringContaining('XML') })
    expect(validateTtml('<root/>')).toMatchObject({ ok: false, message: expect.stringContaining('<tt>') })
    expect(validateTtml('')).toMatchObject({ ok: false })
  })
})

describe('validateLrc', () => {
  it('accepts text with at least one [mm:ss.xx] timestamp', () => {
    expect(validateLrc('[00:01.00] hello')).toEqual({ ok: true })
    expect(validateLrc('[ti:Song]\n[1:02]x')).toEqual({ ok: true })
    expect(validateLrc('[123:45.678] x')).toEqual({ ok: true })
  })

  it.each([['plain lyrics'], ['[ti:Only a tag]'], ['[ab:cd.ef] x'], ['']])('rejects %p', (t) => {
    expect(validateLrc(t).ok).toBe(false)
  })

  it('rejects oversized text', () => {
    expect(validateLrc('[00:01.00]' + 'a'.repeat(MAX_LYRICS_BYTES))).toMatchObject({ ok: false, message: expect.stringContaining('1 MiB') })
    expect(validateLrc(undefined as unknown as string).ok).toBe(false)
  })
})

describe('realistic Apple Music style document', () => {
  // Invented lyrics. Mirrors the structure of Apple's word-synced TTML: absolute times, itunes:* attributes,
  // song parts, a duet with a group chorus and backing vocals.
  const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" itunes:timing="Word" xml:lang="en">
  <head>
    <metadata>
      <ttm:title>Paper Lanterns</ttm:title>
      <ttm:agent type="person" xml:id="v1"><ttm:name type="full">Mira Vale</ttm:name></ttm:agent>
      <ttm:agent type="person" xml:id="v2"/>
      <ttm:agent type="other" xml:id="v1000"/>
      <iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal">
        <songwriters><songwriter>Somebody Else</songwriter></songwriters>
      </iTunesMetadata>
    </metadata>
  </head>
  <body dur="00:03:12.480">
    <div begin="00:00:08.100" end="00:00:19.400" itunes:song-part="Verse">
      <p begin="00:00:08.100" end="00:00:12.000" ttm:agent="v1" itunes:key="L1"><span begin="00:00:08.100" end="00:00:08.650">Lan</span><span begin="00:00:08.650" end="00:00:09.200">terns</span> <span begin="00:00:09.200" end="00:00:09.900">on</span> <span begin="00:00:09.900" end="00:00:10.300">the</span> <span begin="00:00:10.300" end="00:00:12.000">water</span></p>
      <p begin="00:00:12.600" end="00:00:19.400" ttm:agent="v2" itunes:key="L2"><span begin="00:00:12.600" end="00:00:13.100">drift</span> <span begin="00:00:13.100" end="00:00:13.800">toward</span> <span begin="00:00:13.800" end="00:00:14.400">the</span> <span begin="00:00:14.400" end="00:00:16.000">shore</span><span ttm:role="x-bg"><span begin="00:00:15.000" end="00:00:15.700">(far</span> <span begin="00:00:15.700" end="00:00:17.200">away)</span></span></p>
    </div>
    <div begin="00:00:34.000" end="00:00:42.000" itunes:song-part="Chorus">
      <p begin="00:00:34.000" end="00:00:38.000" ttm:agent="v1000" itunes:key="L3"><span begin="00:00:34.000" end="00:00:35.000">Hold</span> <span begin="00:00:35.000" end="00:00:36.000">the</span> <span begin="00:00:36.000" end="00:00:38.000">light</span></p>
      <p begin="00:00:38.500" end="00:00:42.000" ttm:agent="v1" itunes:key="L4"><span begin="00:00:38.500" end="00:00:39.500">Never</span> <span begin="00:00:39.500" end="00:00:42.000">let go</span></p>
    </div>
  </body>
</tt>`

  const r = parseTtml(SAMPLE)

  it('parses four word-synced lines in order', () => {
    expect(r.synced).toBe(true)
    expect(r.wordSynced).toBe(true)
    expect(r.lines.map((l) => l.text)).toEqual(['Lanterns on the water', 'drift toward the shore', 'Hold the light', 'Never let go'])
    expect(r.lines.map((l) => l.time)).toEqual([8100, 12_600, 34_000, 38_500])
  })

  it('merges syllables into words but keeps their timing', () => {
    const w = r.lines[0]!.words!
    expect(w.map((x) => x.text)).toEqual(['Lan', 'terns ', 'on ', 'the ', 'water'])
    expect(w[0]).toEqual({ time: 8100, end: 8650, text: 'Lan' })
    expect(w.map((x) => x.text).join('')).toBe(r.lines[0]!.text)
  })

  it('assigns duet sides (v1 start, v2 end, v1000 group start)', () => {
    expect(r.lines.map((l) => l.align)).toEqual(['start', 'end', 'start', 'start'])
    expect(r.lines.map((l) => l.agent)).toEqual(['v1', 'v2', 'v1000', 'v1'])
  })

  it('extracts backing vocals without their parentheses', () => {
    expect(r.lines[1]!.background).toEqual({
      text: 'far away',
      words: [
        { time: 15_000, end: 15_700, text: 'far ' },
        { time: 15_700, end: 17_200, text: 'away' }
      ]
    })
  })

  it('keeps the instrumental gap between line 2 (ends 19.4s) and line 3 (starts 34s)', () => {
    expect(r.lines[1]!.end).toBe(19_400)
    expect(r.lines[2]!.time - r.lines[1]!.end!).toBeGreaterThan(6000)
  })

  it('treats a span with internal spaces as one timed word text', () => {
    const w = r.lines[3]!.words!
    expect(w.map((x) => x.text)).toEqual(['Never ', 'let go'])
    expect(r.lines[3]!.text).toBe('Never let go')
  })

  it('exposes metadata: title from ttm:title, artist from the first named agent, duration from body dur', () => {
    expect(readTtmlMetadata(SAMPLE)).toEqual({ title: 'Paper Lanterns', artist: 'Mira Vale', durationMs: 192_480 })
  })

  it('passes server validation', () => {
    expect(validateTtml(SAMPLE)).toEqual({ ok: true })
  })
})
