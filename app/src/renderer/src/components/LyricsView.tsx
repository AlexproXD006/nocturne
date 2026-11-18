import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ImagePlus, Mic2, Share2, X } from 'lucide-react'
import type { Track } from '../api/types'
import { useLyrics } from '../hooks/useLyrics'
import { useLyricsOffset } from '../hooks/useLyricsOffset'
import { readPosition, useFrame } from '../hooks/useClock'
import { findActiveLine, lineProgress, type LyricLine, type LyricWord } from '../lyrics/lrc'
import { OFFSET_STEP_MS, formatOffset, lyricsTime, seekTimeFor } from '../lyrics/offset'
import { computeGaps, findActiveWord, findGap, wordProgress } from '../lyrics/timing'
import { playback } from '../services'
import { useNowDuration, useNowPositionTick, useNowStatus } from '../hooks/useNowPlaying'
import { prefersReducedMotion, useSettings } from '../store/settings'
import { pickImage } from '../lib/url'
import { ExternalLink, Spinner, cx } from './common'
import { LyricCard } from './LyricCard'
import { useT } from '../i18n'

/** Maximum number of lyric lines that can go on a shared image. */
const MAX_SHARE_LINES = 10

/** The highlight leads the audio slightly; it feels better than lagging behind. */
const LEAD_MS = 150

interface Cursor {
  /** Index of the last line that has started (-1 before the first). */
  cursor: number
  /** Line shown as current, or -1 while an instrumental gap indicator is showing. */
  active: number
  /** Index of the gap indicator currently filling, or -1. */
  gap: number
}

const INITIAL: Cursor = { cursor: -1, active: -1, gap: -1 }

type WordRefs = Array<Array<HTMLElement | null> | undefined>

function setWordClass(el: HTMLElement | null | undefined, state: 'sung' | 'current' | 'upcoming' | null): void {
  if (!el) return
  const c = el.classList
  c.toggle('is-sung', state === 'sung')
  c.toggle('is-current', state === 'current')
  c.toggle('is-upcoming', state === 'upcoming')
  if (state !== 'current') el.style.removeProperty('--wp')
}

/**
 * Lyrics. Line-synced lyrics highlight the current line and fill it left→right; word-synced lyrics
 * (TTML / enhanced LRC) fill word by word, with backing vocals, duet alignment and an animated
 * indicator for long instrumental gaps. The active line/word are found every frame from the engine
 * clock with binary searches and applied to the DOM through classes and CSS variables, never React
 * state per frame. Clicking a line seeks there. Manual scrolling pauses auto-follow for a few seconds.
 */
export function LyricsView({ track, size = 'md' }: { track: Track | null; size?: 'md' | 'lg' }): ReactNode {
  const tr = useT()
  const enabled = useSettings((s) => s.lyrics)
  const motion = useSettings((s) => s.motion)
  const reduced = prefersReducedMotion(motion)
  const state = useLyrics(track, enabled)
  const seek = playback.seek
  const nowStatus = useNowStatus()
  const playing = nowStatus === 'playing' || nowStatus === 'buffering'
  const duration = useNowDuration()
  const containerRef = useRef<HTMLDivElement>(null)
  const lineRefs = useRef<Array<HTMLElement | null>>([])
  const gapRefs = useRef<Array<HTMLElement | null>>([])
  const wordRefs = useRef<WordRefs>([])
  const bgWordRefs = useRef<WordRefs>([])
  const [cur, setCur] = useState<Cursor>(INITIAL)
  const curRef = useRef<Cursor>(INITIAL)
  /** Which line/word the DOM classes currently reflect. */
  const dom = useRef({ line: -1, k: -2, bk: -2 })
  const userScrollUntil = useRef(0)

  // --- "Share lyrics as image" selection mode ---------------------------------
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<number[]>([])
  const [cardOpen, setCardOpen] = useState(false)
  /** Lets the per-frame tick skip auto-scroll while the user is picking lines. */
  const selectingRef = useRef(false)
  selectingRef.current = selecting

  const lyrics = state.status === 'ready' ? state.lyrics : null
  const synced = lyrics?.kind === 'synced' ? lyrics.parsed.lines : null
  const lines = useMemo(() => (lyrics && (lyrics.kind === 'synced' || lyrics.kind === 'plain') ? lyrics.parsed.lines : []), [lyrics])
  const { offsetMs, nudge, reset } = useLyricsOffset(track?.id, lyrics && lyrics.kind !== 'none' ? lyrics.offsetMs : undefined)
  const wordSynced = lyrics?.kind === 'synced' && lyrics.parsed.wordSynced === true
  const gaps = useMemo(() => (synced ? computeGaps(synced) : []), [synced])
  const gapBefore = useMemo(() => {
    const m = new Map<number, number>()
    gaps.forEach((g, gi) => m.set(g.before, gi))
    return m
  }, [gaps])

  useEffect(() => {
    curRef.current = INITIAL
    dom.current = { line: -1, k: -2, bk: -2 }
    setCur(INITIAL)
    containerRef.current?.scrollTo({ top: 0 })
  }, [track?.id, lyrics])

  // Leave selection mode whenever the track changes.
  useEffect(() => {
    setSelecting(false)
    setSelected([])
    setCardOpen(false)
  }, [track?.id])

  const scrollToEl = (el: HTMLElement | null | undefined, smooth: boolean): void => {
    const box = containerRef.current
    if (!el || !box || selectingRef.current || Date.now() < userScrollUntil.current) return
    box.scrollTo({ top: el.offsetTop - box.clientHeight * 0.38, behavior: smooth ? 'smooth' : 'auto' })
  }

  const applyWords = (refs: WordRefs, line: number, words: LyricWord[], k: number): void => {
    const els = refs[line]
    if (!els) return
    for (let j = 0; j < words.length; j++) setWordClass(els[j], j < k ? 'sung' : j === k ? 'current' : 'upcoming')
  }

  const clearWords = (line: number): void => {
    for (const refs of [wordRefs.current, bgWordRefs.current]) refs[line]?.forEach((el) => setWordClass(el, null))
  }

  const tick = (): void => {
    if (!synced) return
    const ms = lyricsTime(readPosition() * 1000 + LEAD_MS, offsetMs)
    const i = findActiveLine(synced, ms)
    const gi = gaps.length ? findGap(gaps, ms) : -1
    const next: Cursor = { cursor: i, active: gi >= 0 ? -1 : i, gap: gi }
    const prev = curRef.current
    if (next.cursor !== prev.cursor || next.active !== prev.active || next.gap !== prev.gap) {
      curRef.current = next
      setCur(next)
      if (next.gap >= 0) scrollToEl(gapRefs.current[next.gap], true)
      else scrollToEl(lineRefs.current[Math.max(0, i)], true)
    }

    if (gi >= 0) {
      const g = gaps[gi]!
      gapRefs.current[gi]?.style.setProperty('--gp', String(Math.min(1, Math.max(0, (ms - g.start) / Math.max(1, g.end - g.start)))))
    }

    if (!wordSynced) {
      const el = lineRefs.current[i]
      if (el) el.style.setProperty('--p', `${Math.round(lineProgress(synced, i, ms, duration * 1000) * 100)}%`)
      return
    }

    // Word mode: reset the line we left, then update words of the active line.
    const d = dom.current
    if (d.line !== next.active) {
      if (d.line >= 0) clearWords(d.line)
      d.line = next.active
      d.k = -2
      d.bk = -2
    }
    const line = next.active >= 0 ? synced[next.active] : undefined
    if (!line) return
    if (line.words?.length) {
      const k = findActiveWord(line.words, ms)
      if (k !== d.k) {
        d.k = k
        applyWords(wordRefs.current, next.active, line.words, k)
      }
      const w = line.words[k]
      if (w) wordRefs.current[next.active]?.[k]?.style.setProperty('--wp', `${(wordProgress(w, ms) * 100).toFixed(1)}%`)
    } else {
      const el = lineRefs.current[i]
      if (el) el.style.setProperty('--p', `${Math.round(lineProgress(synced, i, ms, duration * 1000) * 100)}%`)
    }
    const bg = line.background
    if (bg?.words.length) {
      const k = findActiveWord(bg.words, ms)
      if (k !== d.bk) {
        d.bk = k
        applyWords(bgWordRefs.current, next.active, bg.words, k)
      }
      const w = bg.words[k]
      if (w) bgWordRefs.current[next.active]?.[k]?.style.setProperty('--wp', `${(wordProgress(w, ms) * 100).toFixed(1)}%`)
    }
  }
  useFrame(tick, Boolean(synced) && playing)
  // Also update after seeks while paused.
  useNowPositionTick()
  useEffect(() => {
    if (!playing) tick()
  })

  const big = size === 'lg'

  const toggleShareLine = (i: number): void => {
    setSelected((prev) => {
      if (prev.includes(i)) return prev.filter((x) => x !== i)
      if (prev.length >= MAX_SHARE_LINES) return prev
      return [...prev, i].sort((a, b) => a - b)
    })
  }
  const startSelecting = (): void => {
    // Pre-select the current line when there is one, so the user starts with 1.
    const start = cur.active >= 0 && lines[cur.active]?.text ? [cur.active] : []
    setSelected(start)
    setSelecting(true)
  }
  const stopSelecting = (): void => {
    setSelecting(false)
    setSelected([])
    setCardOpen(false)
  }

  const shareTitle = track?.title ?? ''
  const shareArtist = track?.artists.map((a) => a.name).join(', ') ?? ''
  const shareCover = pickImage(track?.artwork, 256)
  const shareLines = selected.map((i) => lines[i]?.text ?? '').filter(Boolean)

  if (!enabled) return <LyricsMessage big={big}>{tr('lyr.off')}</LyricsMessage>
  if (!track) return <LyricsMessage big={big}>{tr('lyr.idle')}</LyricsMessage>
  if (state.status === 'loading' || state.status === 'idle') {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    )
  }
  if (state.status === 'error') return <LyricsMessage big={big}>{tr('lyr.error')}</LyricsMessage>
  if (lyrics?.kind === 'instrumental') return <LyricsMessage big={big}>{tr('lyr.instrumental')}</LyricsMessage>
  if (!lyrics || lyrics.kind === 'none' || lines.length === 0) {
    return <LyricsMessage big={big}>{tr('lyr.none')}</LyricsMessage>
  }

  const renderLine = (line: LyricLine, i: number): ReactNode => {
    const isActive = synced !== null && i === cur.active
    const isPast = synced !== null && (i < cur.cursor || (i === cur.cursor && cur.active !== i))
    const empty = !line.text
    const hasWords = wordSynced && Boolean(line.words?.length)
    const end = line.align === 'end'
    const picked = selecting && selected.includes(i)
    const selectable = selecting && !empty
    return (
      <p
        key={`${i}:${line.time}`}
        ref={(el) => {
          lineRefs.current[i] = el
        }}
        onClick={selecting ? (selectable ? () => toggleShareLine(i) : undefined) : synced ? () => seek(seekTimeFor(line.time, offsetMs)) : undefined}
        data-line={i}
        data-active={isActive || undefined}
        role={selectable ? 'button' : undefined}
        aria-pressed={selectable ? picked : undefined}
        className={cx(
          'lyric-line font-bold tracking-tight',
          big ? 'my-5 text-[clamp(1.6rem,3.2vw,2.6rem)] leading-tight' : 'my-3.5 text-[1.35rem] leading-snug',
          end && 'lyric-line-end text-right',
          // Selection mode: uniform, tappable styling with a highlighted pick.
          // The negative margin must not exceed the scroller's own padding (px-2 / px-5), or the
          // highlight and its ring get clipped by the scroller's edges.
          selectable && cx('cursor-pointer rounded-xl py-1 transition-colors', big ? '-mx-2 px-2' : '-mx-3 px-3'),
          selecting && picked && 'lyric-pick bg-accent/15 text-fg ring-1 ring-accent/60 ring-inset',
          selecting && !picked && !empty && 'text-fg/55 hover:bg-white/5 hover:text-fg/90',
          selecting && empty && 'text-fg/20',
          // Normal mode (unchanged): only applies when not selecting.
          !selecting && synced && 'cursor-pointer',
          !selecting && !synced && 'text-fg/85',
          !selecting && isActive && !hasWords && 'lyric-active-fill scale-[1.02]',
          !selecting && isActive && hasWords && 'lyric-live scale-[1.02]',
          !selecting && synced && !isActive && (isPast ? 'text-fg/35 hover:text-fg/70' : 'text-fg/45 hover:text-fg/80'),
          !selecting && synced && !isActive && big && 'blur-[0.6px]'
        )}
      >
        {empty ? (
          <span className="text-fg/30">♪</span>
        ) : hasWords ? (
          <Words words={line.words!} refs={(j, el) => setRef(wordRefs.current, i, j, el)} />
        ) : (
          line.text
        )}
        {hasWords && line.background && line.background.text && (
          <span className={cx('lyric-bg', end && 'text-right')} data-testid="lyric-bg">
            {line.background.words.length ? (
              <Words words={line.background.words} refs={(j, el) => setRef(bgWordRefs.current, i, j, el)} />
            ) : (
              line.background.text
            )}
          </span>
        )}
        {!hasWords && wordSynced && line.background?.text && <span className="lyric-bg">{line.background.text}</span>}
      </p>
    )
  }

  return (
    <div className={cx('relative flex h-full flex-col', reduced && 'lyrics-reduced')}>
    {/* Reserved strip for the overlay controls (offset pill, share): lines never scroll under it. */}
    <div className="h-14 shrink-0" aria-hidden data-testid="lyrics-controls-strip" />
    <div
      ref={containerRef}
      onWheel={() => (userScrollUntil.current = Date.now() + 3500)}
      onTouchMove={() => (userScrollUntil.current = Date.now() + 3500)}
      className="hide-scrollbar relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
      style={{ maskImage: 'linear-gradient(transparent, #000 10%, #000 80%, transparent)', WebkitMaskImage: 'linear-gradient(transparent, #000 10%, #000 80%, transparent)' }}
    >
      <div className={cx('py-[35vh]', big ? 'px-2' : 'px-5')}>
        {lines.map((line, i) => {
          const gi = synced ? gapBefore.get(i) : undefined
          return (
            <FragmentWith key={`${i}:${line.time}`}>
              {gi !== undefined && (
                <div
                  ref={(el) => {
                    gapRefs.current[gi] = el
                  }}
                  className={cx('lyric-gap', cur.gap === gi && 'is-active')}
                  data-testid="lyric-gap"
                  aria-hidden
                >
                  {[0, 1, 2].map((k) => (
                    <span key={k} className="lyric-gap-dot" style={{ '--i': k } as CSSProperties} />
                  ))}
                </div>
              )}
              {renderLine(line, i)}
            </FragmentWith>
          )
        })}
        {lyrics.source === 'lrclib' && (
          <p className="mt-10 text-xs font-normal text-fg-subtle">
            {tr('lyr.from', { source: '\u0000' }).split('\u0000').flatMap((part, i) => (i === 0 ? [part] : [<ExternalLink key="l" href="https://lrclib.net">LRCLIB</ExternalLink>, part]))}
            {!synced && ` · ${tr('lyr.notSynced')}`}
          </p>
        )}
        {lyrics.source === 'ttml' && <p className="mt-10 text-xs font-normal text-fg-subtle">{tr('lyr.fromLibrary')}</p>}
      </div>
    </div>

      {/* Timing offset (synced lyrics only): shared per track on the server. */}
      {synced && !selecting && (
        <div
          role="group"
          aria-label={tr('lyr.offsetGroup')}
          className="no-drag absolute left-3 top-3 z-20 inline-flex items-center gap-0.5 rounded-full bg-ink-800/95 px-1 py-1 text-xs text-fg-muted shadow-lg shadow-black/30 backdrop-blur"
        >
          <button
            type="button"
            aria-label={tr('lyr.earlierLabel')}
            title={tr('lyr.earlier')}
            onClick={() => nudge(-OFFSET_STEP_MS)}
            className="h-7 rounded-full px-2 font-semibold tabular-nums transition-colors hover:bg-white/10 hover:text-fg active:scale-95"
          >
            {formatOffset(-OFFSET_STEP_MS)}
          </button>
          <span data-testid="lyrics-offset" aria-live="polite" className="min-w-[3.2rem] text-center font-semibold tabular-nums text-fg">
            {formatOffset(offsetMs)}
          </span>
          <button
            type="button"
            aria-label={tr('lyr.laterLabel')}
            title={tr('lyr.later')}
            onClick={() => nudge(OFFSET_STEP_MS)}
            className="h-7 rounded-full px-2 font-semibold tabular-nums transition-colors hover:bg-white/10 hover:text-fg active:scale-95"
          >
            {formatOffset(OFFSET_STEP_MS)}
          </button>
          <button
            type="button"
            aria-label={tr('lyr.resetLabel')}
            title={tr('lyr.resetTitle')}
            disabled={offsetMs === 0}
            onClick={reset}
            className="h-7 rounded-full px-2 font-semibold text-fg/85 transition-colors hover:bg-white/10 hover:text-fg disabled:text-fg-muted disabled:opacity-80 disabled:hover:bg-transparent"
          >
            {tr('lyr.reset')}
          </button>
        </div>
      )}

      {/* Share-as-image controls (overlay, do not scroll with lyrics). */}
      {!selecting && (
        <button
          type="button"
          aria-label={tr('lyr.shareLabel')}
          title={tr('lyr.share')}
          onClick={startSelecting}
          className="no-drag absolute right-3 top-3 z-20 inline-flex h-10 w-10 items-center justify-center rounded-full bg-ink-800/95 text-fg-muted shadow-lg shadow-black/30 backdrop-blur transition-colors hover:bg-ink-700/80 hover:text-fg active:scale-95"
        >
          <Share2 className="h-5 w-5" />
        </button>
      )}

      {selecting && (
        <div
          className={cx(
            'pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center justify-between gap-3 bg-gradient-to-b to-transparent px-3 pb-8 pt-3',
            // Over the fullscreen player's translucent backdrop a solid surface colour reads as a hard-edged box.
            big ? 'from-black/45' : 'from-ink-900/95'
          )}
        >
          <button
            type="button"
            aria-label={tr('lyr.exitSelect')}
            onClick={stopSelecting}
            className="no-drag pointer-events-auto inline-flex h-9 w-9 items-center justify-center rounded-full bg-ink-800/80 text-fg-muted backdrop-blur hover:text-fg active:scale-95"
          >
            <X className="h-5 w-5" />
          </button>
          <span className="pointer-events-auto text-sm font-medium text-fg-muted" aria-live="polite">
            {tr('lyr.tapLines')} · <span className="text-fg">{selected.length}/{MAX_SHARE_LINES}</span>
          </span>
          <span className="h-9 w-9" aria-hidden />
        </div>
      )}

      {selecting && selected.length >= 1 && (
        <div
          className={cx(
            'pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center bg-gradient-to-t to-transparent px-4 pb-5 pt-10',
            big ? 'from-black/45' : 'from-ink-900/95'
          )}
        >
          <button
            type="button"
            aria-label={tr('lyr.createLabel', { count: selected.length })}
            onClick={() => setCardOpen(true)}
            className="no-drag pointer-events-auto inline-flex items-center gap-2 rounded-full bg-accent px-5 py-3 text-sm font-semibold text-ink-950 shadow-lg shadow-black/40 transition-transform active:scale-95"
          >
            <ImagePlus className="h-4 w-4" /> {tr('lyr.create')}
          </button>
        </div>
      )}

      {cardOpen && shareLines.length >= 1 && (
        <LyricCard title={shareTitle} artist={shareArtist} coverUrl={shareCover} lines={shareLines} onClose={() => setCardOpen(false)} />
      )}
    </div>
  )
}

function FragmentWith({ children }: { children: ReactNode }): ReactNode {
  return <>{children}</>
}

function setRef(refs: WordRefs, line: number, j: number, el: HTMLElement | null): void {
  const arr = (refs[line] ??= [])
  arr[j] = el
}

/** Words grouped into syllable runs so a line can only wrap between real words. */
function Words({ words, refs }: { words: LyricWord[]; refs: (index: number, el: HTMLElement | null) => void }): ReactNode {
  const groups: Array<Array<{ w: LyricWord; j: number }>> = []
  let open = false
  words.forEach((w, j) => {
    if (!open) groups.push([])
    groups[groups.length - 1]!.push({ w, j })
    open = !/\s$/.test(w.text)
  })
  return (
    <>
      {groups.map((g, gi) => {
        const trailing = /\s$/.test(g[g.length - 1]!.w.text)
        return (
          <span key={gi}>
            <span className="lyric-wordgroup">
              {g.map(({ w, j }) => (
                <span key={j} ref={(el) => refs(j, el)} className="lyric-word">
                  {w.text.trimEnd()}
                </span>
              ))}
            </span>
            {trailing ? ' ' : null}
          </span>
        )
      })}
    </>
  )
}

function LyricsMessage({ children, big }: { children: ReactNode; big: boolean }): ReactNode {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-fg-muted">
      <Mic2 className={big ? 'h-10 w-10' : 'h-7 w-7'} strokeWidth={1.4} />
      <p className={big ? 'text-lg' : 'text-sm'}>{children}</p>
    </div>
  )
}
