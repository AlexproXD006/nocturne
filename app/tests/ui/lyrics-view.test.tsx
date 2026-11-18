import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Lyrics } from '@/lyrics/service'
import { parseLrc, parsePlain } from '@/lyrics/lrc'
import { parseTtml } from '@/lyrics/ttml'
import { LyricsView } from '@/components/LyricsView'
import { useSettings } from '@/store/settings'
import { track } from '../helpers/fixtures'

const h = vi.hoisted(() => ({
  pos: 0,
  seek: vi.fn(),
  setLyricsOffset: vi.fn(),
  lyricsState: { status: 'idle' } as unknown
}))

vi.mock('@/hooks/useLyrics', () => ({ useLyrics: () => h.lyricsState, patchCachedOffset: () => undefined }))
vi.mock('@/hooks/useClock', () => ({ readPosition: () => h.pos, useFrame: vi.fn() }))
vi.mock('@/services', async () => {
  const state = { seek: h.seek, status: 'paused', duration: 200, position: 0 }
  const usePlayer = Object.assign((sel: (s: typeof state) => unknown) => sel(state), { getState: () => state })
  const { connectMocks } = await import('../helpers/services-mock')
  return { usePlayer, getEngine: () => null, api: { setLyricsOffset: h.setLyricsOffset }, ...connectMocks(usePlayer) }
})

const NS = 'xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" itunes:timing="Word"'
const TTML_WORDS = `<tt ${NS}><head><metadata><ttm:agent type="person" xml:id="v1"/><ttm:agent type="person" xml:id="v2"/></metadata></head><body><div>
  <p begin="1s" end="4s" ttm:agent="v1"><span begin="1s" end="2s">Hel</span><span begin="2s" end="3s">lo</span> <span begin="3s" end="4s">there</span><span ttm:role="x-bg"><span begin="3s" end="4s">(echo)</span></span></p>
  <p begin="5s" end="8s" ttm:agent="v2"><span begin="5s" end="6s">Second</span> <span begin="6s" end="8s">voice</span></p>
  <p begin="30s" end="33s" ttm:agent="v1"><span begin="30s" end="33s">After</span></p>
</div></body></tt>`

function setLyrics(lyrics: Lyrics): void {
  h.lyricsState = { status: 'ready', lyrics }
}
const ttmlLyrics = (): Lyrics => ({ kind: 'synced', parsed: parseTtml(TTML_WORDS), source: 'ttml' })
const lrcLyrics = (): Lyrics => ({ kind: 'synced', parsed: parseLrc('[00:01.00] first line\n[00:05.00] second line\n[00:09.00] third line'), source: 'lrclib' })
const T = track('t1')

beforeEach(() => {
  h.pos = 0
  h.seek.mockClear()
  h.lyricsState = { status: 'idle' }
  Element.prototype.scrollTo = vi.fn() as never
  useSettings.setState({ lyrics: true, motion: 'full' })
})

describe('LyricsView states', () => {
  it('shows a message when lyrics are disabled or there is no track', () => {
    useSettings.setState({ lyrics: false })
    const { unmount } = render(<LyricsView track={T} />)
    expect(screen.getByText(/turned off/i)).toBeInTheDocument()
    unmount()
    useSettings.setState({ lyrics: true })
    render(<LyricsView track={null} />)
    expect(screen.getByText(/play something/i)).toBeInTheDocument()
  })

  it.each([
    [{ status: 'loading' }, null],
    [{ status: 'idle' }, null],
    [{ status: 'error' }, /couldn't load/i],
    [{ status: 'ready', lyrics: { kind: 'instrumental', source: 'lrclib' } }, /instrumental/i],
    [{ status: 'ready', lyrics: { kind: 'none' } }, /no lyrics found/i]
  ])('renders %o', (state, text) => {
    h.lyricsState = state
    render(<LyricsView track={T} />)
    if (text) expect(screen.getByText(text)).toBeInTheDocument()
    else expect(screen.getByLabelText('Loading')).toBeInTheDocument()
  })
})

describe('line mode (non-word lyrics)', () => {
  it('renders plain lines without word spans and fills the active line', () => {
    setLyrics(lrcLyrics())
    h.pos = 5.2
    const { container } = render(<LyricsView track={T} />)
    expect(container.querySelectorAll('.lyric-word')).toHaveLength(0)
    expect(container.querySelector('.lyric-gap')).toBeNull()
    const active = container.querySelector('[data-active]') as HTMLElement
    expect(active).toHaveTextContent('second line')
    expect(active).toHaveClass('lyric-active-fill')
    expect(active.style.getPropertyValue('--p')).toMatch(/^\d+%$/)
    expect(container.querySelector('[data-line="0"]')).toHaveClass('text-fg/35')
    expect(container.querySelector('[data-line="2"]')).toHaveClass('text-fg/45')
  })

  it('seeks when a line is clicked', async () => {
    setLyrics(lrcLyrics())
    render(<LyricsView track={T} />)
    await userEvent.click(screen.getByText('third line'))
    expect(h.seek).toHaveBeenCalledWith(9)
  })

  it('shows unsynced plain lyrics without highlighting or seeking', async () => {
    h.lyricsState = { status: 'ready', lyrics: { kind: 'plain', parsed: { lines: [{ time: 0, text: 'a plain line' }], synced: false }, source: 'lrclib' } }
    const { container } = render(<LyricsView track={T} />)
    await userEvent.click(screen.getByText('a plain line'))
    expect(h.seek).not.toHaveBeenCalled()
    expect(container.querySelector('[data-active]')).toBeNull()
    expect(screen.getByText(/not time-synced/i)).toBeInTheDocument()
  })

  it('credits LRCLIB, and TTML from your library', () => {
    setLyrics(lrcLyrics())
    const { unmount } = render(<LyricsView track={T} />)
    expect(screen.getByRole('link', { name: /lrclib/i })).toBeInTheDocument()
    expect(screen.queryByText(/your library/i)).toBeNull()
    unmount()
    setLyrics(ttmlLyrics())
    render(<LyricsView track={T} />)
    expect(screen.getByText('Lyrics from your library (TTML)')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /lrclib/i })).toBeNull()
  })

  it('renders line-only TTML without word spans, filling by the line end', () => {
    setLyrics({ kind: 'synced', source: 'ttml', parsed: parseTtml('<tt><body><div><p begin="1s" end="3s">only a line</p><p begin="4s" end="6s">next</p></div></body></tt>') })
    h.pos = 1.85
    const { container } = render(<LyricsView track={T} />)
    expect(container.querySelectorAll('.lyric-word')).toHaveLength(0)
    const active = container.querySelector('[data-active]') as HTMLElement
    expect(active).toHaveTextContent('only a line')
    expect(active.style.getPropertyValue('--p')).toBe('50%')
  })
})

describe('word mode', () => {
  const words = (c: HTMLElement): HTMLElement[] => [...c.querySelectorAll<HTMLElement>('[data-line="0"] .lyric-word')].filter((w) => !w.closest('.lyric-bg'))

  it('renders every word (and syllable) as its own span, keeping the text intact', () => {
    setLyrics(ttmlLyrics())
    const { container } = render(<LyricsView track={T} />)
    expect(words(container).map((w) => w.textContent)).toEqual(['Hel', 'lo', 'there'])
    expect(container.querySelector('[data-line="0"]')!.textContent).toContain('Hello there')
    // Syllables of one word share a nowrap group; real words don't.
    const groups = container.querySelectorAll('[data-line="0"] > span > span > .lyric-wordgroup, [data-line="0"] > span > .lyric-wordgroup')
    expect(groups.length).toBeGreaterThanOrEqual(2)
    expect(groups[0]!.children).toHaveLength(2)
  })

  it('marks sung, current and upcoming words and fills the current one with its own progress', () => {
    setLyrics(ttmlLyrics())
    h.pos = 2.35 // + 150 ms lead = 2.5 s: halfway through "lo"
    const { container } = render(<LyricsView track={T} />)
    const w = words(container)
    expect(container.querySelector('[data-line="0"]')).toHaveClass('lyric-live')
    expect(w[0]).toHaveClass('is-sung')
    expect(w[1]).toHaveClass('is-current')
    expect(w[1]!.style.getPropertyValue('--wp')).toBe('50.0%')
    expect(w[2]).toHaveClass('is-upcoming')
  })

  it('updates classes as time advances and clears the line when it is left', () => {
    setLyrics(ttmlLyrics())
    h.pos = 0.9
    const { container, rerender } = render(<LyricsView track={T} />)
    expect(words(container)[0]).toHaveClass('is-current')
    h.pos = 3.9
    rerender(<LyricsView track={T} />)
    expect(words(container).map((w) => w.className.replace('lyric-word', '').trim())).toEqual(['is-sung', 'is-sung', 'is-current'])
    h.pos = 5.5
    rerender(<LyricsView track={T} />)
    expect(words(container).every((w) => !/is-(sung|current|upcoming)/.test(w.className))).toBe(true)
    expect(container.querySelector('[data-line="1"]')).toHaveClass('lyric-live')
  })

  it('renders backing vocals as a separate smaller line with their own timing', () => {
    setLyrics(ttmlLyrics())
    h.pos = 3.35
    const { container } = render(<LyricsView track={T} />)
    const bg = screen.getByTestId('lyric-bg')
    expect(bg).toHaveTextContent('echo')
    expect(bg).toHaveClass('lyric-bg')
    const bgWord = bg.querySelector('.lyric-word') as HTMLElement
    expect(bgWord).toHaveClass('is-current')
    expect(bgWord.style.getPropertyValue('--wp')).toBe('50.0%')
    expect(container.querySelectorAll('[data-testid="lyric-bg"]')).toHaveLength(1)
  })

  it('right-aligns duet lines of the second singer', () => {
    setLyrics(ttmlLyrics())
    const { container } = render(<LyricsView track={T} />)
    expect(container.querySelector('[data-line="0"]')).not.toHaveClass('lyric-line-end')
    expect(container.querySelector('[data-line="1"]')).toHaveClass('lyric-line-end', 'text-right')
  })

  it('shows a breathing indicator for long instrumental gaps and fills it during the gap', () => {
    setLyrics(ttmlLyrics())
    h.pos = 17 // gap is 8 s .. 30 s
    const { container } = render(<LyricsView track={T} />)
    const gaps = screen.getAllByTestId('lyric-gap')
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toHaveClass('is-active')
    expect(gaps[0]!.querySelectorAll('.lyric-gap-dot')).toHaveLength(3)
    const p = Number(gaps[0]!.style.getPropertyValue('--gp'))
    expect(p).toBeGreaterThan(0.4)
    expect(p).toBeLessThan(0.5)
    // No line is "current" while the indicator is showing; earlier lines are past.
    expect(container.querySelector('[data-active]')).toBeNull()
    expect(container.querySelector('[data-line="1"]')).toHaveClass('text-fg/35')
  })

  it('keeps the indicator idle outside the gap', () => {
    setLyrics(ttmlLyrics())
    h.pos = 5.5
    render(<LyricsView track={T} />)
    expect(screen.getByTestId('lyric-gap')).not.toHaveClass('is-active')
  })

  it('shows an intro indicator when the first line starts after 6 s', () => {
    setLyrics({ kind: 'synced', source: 'ttml', parsed: parseTtml('<tt><body><div><p begin="12s" end="14s">late</p></div></body></tt>') })
    h.pos = 3
    render(<LyricsView track={T} />)
    expect(screen.getByTestId('lyric-gap')).toHaveClass('is-active')
  })

  it('does not draw gap indicators for plain LRC with long pauses', () => {
    setLyrics({ kind: 'synced', source: 'lrclib', parsed: parseLrc('[00:01.00] a\n[01:30.00] b') })
    render(<LyricsView track={T} />)
    expect(screen.queryByTestId('lyric-gap')).toBeNull()
  })

  it('seeks to the start of a word-synced line on click', async () => {
    setLyrics(ttmlLyrics())
    render(<LyricsView track={T} />)
    await userEvent.click(screen.getByText('Second'))
    expect(h.seek).toHaveBeenCalledWith(5)
  })

  it('reduced motion adds the lyrics-reduced class (CSS then disables lift and glow)', () => {
    setLyrics(ttmlLyrics())
    useSettings.setState({ motion: 'reduced' })
    const { container } = render(<LyricsView track={T} />)
    expect(container.firstElementChild).toHaveClass('lyrics-reduced')
  })

  it('full motion does not', () => {
    setLyrics(ttmlLyrics())
    const { container } = render(<LyricsView track={T} />)
    expect(container.firstElementChild).not.toHaveClass('lyrics-reduced')
  })

  it('handles a seek backwards (rewinding re-opens words)', () => {
    setLyrics(ttmlLyrics())
    h.pos = 3.9
    const { container, rerender } = render(<LyricsView track={T} />)
    h.pos = 0.5
    rerender(<LyricsView track={T} />)
    expect(container.querySelector('[data-active]')).toBeNull()
    h.pos = 1.2
    act(() => rerender(<LyricsView track={T} />))
    expect(words(container)[0]).toHaveClass('is-current')
    expect(words(container)[2]).toHaveClass('is-upcoming')
  })

  it('lines without words in a word-synced song fall back to the line fill', () => {
    setLyrics({
      kind: 'synced',
      source: 'ttml',
      parsed: parseTtml(
        `<tt ${NS}><body><div><p begin="1s" end="3s"><span begin="1s" end="3s">words</span></p><p begin="4s" end="6s">just a line</p></div></body></tt>`
      )
    })
    h.pos = 4.85
    const { container } = render(<LyricsView track={T} />)
    const line = container.querySelector('[data-line="1"]') as HTMLElement
    expect(line).toHaveClass('lyric-active-fill')
    expect(line.style.getPropertyValue('--p')).toBe('50%')
  })
})

describe('LyricsView offset controls', () => {
  const lrcWithOffset = (offsetMs: number): Lyrics => ({ ...lrcLyrics(), offsetMs }) as Lyrics

  it('shows the server offset and adjusts it in 0.5 s steps with reset', async () => {
    h.setLyricsOffset.mockReset().mockResolvedValue({ offsetMs: 0 })
    setLyrics(lrcWithOffset(1000))
    render(<LyricsView track={T} />)
    const value = screen.getByTestId('lyrics-offset')
    expect(value).toHaveTextContent('+1.0s')
    await userEvent.click(screen.getByRole('button', { name: /0\.5 seconds earlier/i }))
    await userEvent.click(screen.getByRole('button', { name: /0\.5 seconds earlier/i }))
    expect(value).toHaveTextContent('0.0s')
    await userEvent.click(screen.getByRole('button', { name: /0\.5 seconds earlier/i }))
    expect(value).toHaveTextContent('\u22120.5s')
    await userEvent.click(screen.getByRole('button', { name: /reset lyrics offset/i }))
    expect(value).toHaveTextContent('0.0s')
    expect(screen.getByRole('button', { name: /reset lyrics offset/i })).toBeDisabled()
  })

  it('offset shifts which line is highlighted', () => {
    setLyrics(lrcWithOffset(2000))
    h.pos = 5.5 // line 2 starts at 5 s but is delayed by 2 s
    const { container } = render(<LyricsView track={T} />)
    expect(container.querySelector('[data-active]')?.textContent).toBe('first line')
  })

  it('clicking a line seeks to its shifted time', async () => {
    setLyrics(lrcWithOffset(1000))
    render(<LyricsView track={T} />)
    await userEvent.click(screen.getByText('second line'))
    expect(h.seek).toHaveBeenCalledWith(6)
  })

  it('has no offset controls for plain lyrics', () => {
    setLyrics({ kind: 'plain', parsed: parsePlainForTest(), source: 'server' })
    render(<LyricsView track={T} />)
    expect(screen.queryByTestId('lyrics-offset')).toBeNull()
  })
})

const parsePlainForTest = () => parsePlain('one\ntwo')
