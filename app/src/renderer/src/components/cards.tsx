import { useRef, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, Play } from 'lucide-react'
import type { Album, Artist, Playlist } from '../api/types'
import { Artwork, cx } from './common'
import { artistNames } from '../lib/format'
import { useNav } from '../store/nav'
import { api, playback } from '../services'
import { useUi } from '../store/ui'
import { describeError } from '../api/errors'
import { t, useT } from '../i18n'

export type CardItem =
  | { kind: 'album'; item: Album }
  | { kind: 'playlist'; item: Playlist }
  | { kind: 'artist'; item: Artist }

async function playCollection(card: CardItem): Promise<void> {
  try {
    if (card.kind === 'album') {
      const a = await api.album(card.item.id)
      await playback.playTracks(a.tracks, 0, { type: 'album', id: a.id, name: a.title })
    } else if (card.kind === 'playlist' && card.item.mix) {
      const p = await api.mix(card.item.id)
      await playback.playTracks(p.tracks, 0, { type: 'tracks', id: `mix:${p.id}`, name: p.name })
    } else if (card.kind === 'playlist') {
      const p = await api.playlist(card.item.id)
      await playback.playTracks(p.tracks, 0, { type: 'playlist', id: p.id, name: p.name })
    } else {
      const ar = await api.artist(card.item.id)
      await playback.playTracks(ar.topTracks, 0, { type: 'artist', id: ar.id, name: ar.name })
    }
  } catch (err) {
    useUi.getState().toast(describeError(err), 'error')
  }
}

function subtitle(card: CardItem): string {
  switch (card.kind) {
    case 'album': {
      const kind = card.item.type && card.item.type !== 'album' ? card.item.type.toUpperCase() : null
      return [card.item.year, kind ?? artistNames(card.item.artists)].filter(Boolean).join(' • ')
    }
    case 'playlist':
      if (card.item.mix && card.item.description) return card.item.description
      return card.item.owner?.name ? t('card.by', { name: card.item.owner.name }) : card.item.trackCount ? t('common.song', { count: Number(card.item.trackCount) }) : t('nav.playlist')
    case 'artist':
      return t('card.artist')
  }
}

export function MediaCard({ card }: { card: CardItem }): ReactNode {
  const t = useT()
  const go = useNav((s) => s.go)
  const title = card.kind === 'playlist' ? card.item.name : card.kind === 'album' ? card.item.title : card.item.name
  const round = card.kind === 'artist'
  const open = (): void => go(card.kind === 'playlist' && card.item.mix ? { name: 'mix', id: card.item.id } : { name: card.kind, id: card.item.id })
  return (
    <div
      role="link"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => e.key === 'Enter' && open()}
      className="group w-full cursor-pointer rounded-[var(--radius-card)] p-2.5 transition-colors duration-200 hover:bg-white/[0.045] focus-visible:bg-white/[0.045]"
    >
      <div className="relative mb-3 aspect-square w-full">
        <Artwork images={card.item.artwork} size={200} round={round} alt="" className="h-full w-full shadow-lg shadow-black/40" />
        <button
          type="button"
          aria-label={t('card.play', { title })}
          onClick={(e) => {
            e.stopPropagation()
            void playCollection(card)
          }}
          className={cx(
            'absolute right-2 bottom-2 flex h-11 w-11 items-center justify-center rounded-full bg-accent text-ink-950 shadow-xl shadow-black/40',
            'translate-y-2 opacity-0 transition-all duration-200 ease-[var(--ease-out-soft)] group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100 hover:scale-105'
          )}
        >
          <Play className="ml-0.5 h-5 w-5" fill="currentColor" />
        </button>
      </div>
      <p className={cx('truncate text-[15px] font-semibold', round && 'text-center')}>{title}</p>
      <p className={cx('mt-0.5 truncate text-[13px] text-fg-muted', round && 'text-center')}>{subtitle(card)}</p>
    </div>
  )
}

export function CardGrid({ cards, leading }: { cards: CardItem[]; leading?: ReactNode }): ReactNode {
  return (
    <div className="-mx-2.5 grid grid-cols-2 gap-x-1 gap-y-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
      {leading}
      {cards.map((c) => (
        <MediaCard key={`${c.kind}:${c.item.id}`} card={c} />
      ))}
    </div>
  )
}

/** Horizontally scrolling shelf with arrow buttons on desktop. */
export function Shelf({ title, cards }: { title: string; cards: CardItem[] }): ReactNode {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const scroll = (dir: 1 | -1): void => {
    const el = ref.current
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: 'smooth' })
  }
  if (cards.length === 0) return null
  return (
    <section className="mb-8 fade-up">
      <div className="mb-2 flex items-end justify-between">
        <h2 className="text-xl font-bold tracking-tight">{title}</h2>
        <div className="hidden gap-1 md:flex">
          <button aria-label={t('ui.scrollLeft')} onClick={() => scroll(-1)} className="rounded-full p-1.5 text-fg-muted hover:bg-white/6 hover:text-fg">
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button aria-label={t('ui.scrollRight')} onClick={() => scroll(1)} className="rounded-full p-1.5 text-fg-muted hover:bg-white/6 hover:text-fg">
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>
      </div>
      <div ref={ref} className="hide-scrollbar -mx-2.5 flex snap-x snap-mandatory gap-1 overflow-x-auto scroll-smooth">
        {cards.map((c) => (
          <div key={`${c.kind}:${c.item.id}`} className="w-[44%] shrink-0 snap-start sm:w-[30%] md:w-[190px]">
            <MediaCard card={c} />
          </div>
        ))}
      </div>
    </section>
  )
}

export function CardSkeletonGrid({ count = 12 }: { count?: number }): ReactNode {
  return (
    <div className="-mx-2.5 grid grid-cols-2 gap-x-1 gap-y-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="p-2.5">
          <div className="skeleton mb-3 aspect-square rounded-lg" />
          <div className="skeleton mb-2 h-3.5 w-3/4 rounded" />
          <div className="skeleton h-3 w-1/2 rounded" />
        </div>
      ))}
    </div>
  )
}
