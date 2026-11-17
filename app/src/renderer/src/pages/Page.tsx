import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Play, Shuffle } from 'lucide-react'
import type { Image, Track } from '../api/types'
import type { QueueContext } from '../player/queue'
import { usePlayer } from '../services'
import { useAccent } from '../hooks/useAccent'
import { pickImage } from '../lib/url'
import { rgbString } from '../lib/color'
import { Artwork, IconButton, cx } from '../components/common'
import { TopBar } from '../components/Shell'
import { useNav } from '../store/nav'

/** Scrollable page with a top bar that turns solid once content scrolls under it. */
export function Page({ children, header, tint }: { children: ReactNode; header?: ReactNode; tint?: string }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const [solid, setSolid] = useState(false)
  const route = useNav((s) => s.route)
  useEffect(() => {
    ref.current?.scrollTo({ top: 0 })
  }, [route])
  return (
    <div
      ref={ref}
      onScroll={(e) => setSolid(e.currentTarget.scrollTop > 40)}
      className="relative h-full overflow-y-auto"
    >
      {tint && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-[420px] transition-colors duration-700"
          style={{ background: `linear-gradient(180deg, ${tint}, transparent)` }}
        />
      )}
      <TopBar solid={solid}>{header}</TopBar>
      <div className="relative px-4 pb-10 md:px-6">{children}</div>
    </div>
  )
}

export function PlayButtons({ tracks, context, children }: { tracks: Track[]; context: QueueContext; children?: ReactNode }): ReactNode {
  const playTracks = usePlayer((s) => s.playTracks)
  const disabled = tracks.length === 0
  return (
    <div className="my-6 flex items-center gap-3">
      <button
        type="button"
        aria-label="Play"
        disabled={disabled}
        onClick={() => void playTracks(tracks, 0, context, { shuffle: false })}
        className="flex h-14 w-14 items-center justify-center rounded-full bg-accent text-ink-950 shadow-lg shadow-black/40 transition hover:scale-105 active:scale-95 disabled:opacity-40"
      >
        <Play className="ml-1 h-6 w-6" fill="currentColor" />
      </button>
      <IconButton label="Shuffle play" size="lg" disabled={disabled} onClick={() => void playTracks(tracks, Math.floor(Math.random() * tracks.length), context, { shuffle: true })}>
        <Shuffle className="h-6 w-6" />
      </IconButton>
      {children}
    </div>
  )
}

/** Big header shared by album / playlist / artist pages. */
export function HeroHeader({
  images,
  kind,
  title,
  meta,
  round,
  fallback
}: {
  images: Image[] | undefined
  kind: string
  title: string
  meta: ReactNode
  round?: boolean
  fallback?: ReactNode
}): ReactNode {
  return (
    <header className="fade-up flex flex-col items-center gap-6 pt-2 text-center md:flex-row md:items-end md:text-left">
      {fallback ?? (
        <Artwork images={images} size={260} round={round} alt={`${title} artwork`} className="h-48 w-48 shrink-0 shadow-2xl shadow-black/60 md:h-56 md:w-56" />
      )}
      <div className="min-w-0 max-w-full">
        <p className="text-xs font-semibold tracking-wide uppercase">{kind}</p>
        <h1
          className={cx(
            // break-words (not "anywhere") so words only split when a single word cannot fit.
            'mt-2 font-extrabold tracking-tight break-words',
            // Imported titles can run to 100+ characters, and next to the cover on a tablet the text
            // column is narrow: step the size down so they stay a few lines without mid-word breaks.
            title.length > 64
              ? 'text-2xl md:text-3xl lg:text-4xl'
              : title.length > 32
                ? 'text-3xl md:text-4xl lg:text-5xl'
                : 'text-4xl md:text-5xl lg:text-7xl'
          )}
        >
          {title}
        </h1>
        <div className="mt-4 text-sm text-fg/80">{meta}</div>
      </div>
    </header>
  )
}

export function useTint(images: Image[] | undefined): string {
  const accent = useAccent(pickImage(images, 120))
  return rgbString(accent, 0.32)
}
