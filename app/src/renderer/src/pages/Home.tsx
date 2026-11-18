import type { ReactNode } from 'react'
import { Heart, Play } from 'lucide-react'
import { api, playback, useSession } from '../services'
import { useResource } from '../hooks/useResource'
import { greeting } from '../lib/format'
import type { HomeSection, Track } from '../api/types'
import { Shelf, type CardItem } from '../components/cards'
import { Artwork, ErrorState } from '../components/common'
import { TrackList } from '../components/TrackList'
import { useNav } from '../store/nav'
import { Page } from './Page'
import { useT, type MessageKey } from '../i18n'

function toCards(section: HomeSection): CardItem[] {
  switch (section.kind) {
    case 'albums': return section.items.map((item) => ({ kind: 'album' as const, item }))
    case 'artists': return section.items.map((item) => ({ kind: 'artist' as const, item }))
    case 'playlists': return section.items.map((item) => ({ kind: 'playlist' as const, item }))
    default: return []
  }
}

function QuickTile({ title, images, onOpen, onPlay, icon }: { title: string; images?: Track['artwork']; onOpen: () => void; onPlay?: () => void; icon?: ReactNode }): ReactNode {
  const tr = useT()
  return (
    <div
      role="link"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      className="group flex h-14 cursor-pointer items-center gap-3 overflow-hidden rounded-lg bg-white/[0.07] pr-3 transition-colors hover:bg-white/[0.12] md:h-16"
    >
      {icon ?? <Artwork images={images} size={64} className="h-14 w-14 shrink-0 md:h-16 md:w-16" rounded="rounded-none" />}
      <span className="line-clamp-2 min-w-0 flex-1 text-[13px] leading-snug font-semibold [overflow-wrap:anywhere] md:text-sm">{title}</span>
      {onPlay && (
        <button
          aria-label={tr('card.play', { title })}
          onClick={(e) => {
            e.stopPropagation()
            onPlay()
          }}
          className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-ink-950 opacity-0 shadow-lg transition group-hover:opacity-100 md:flex"
        >
          <Play className="ml-0.5 h-4 w-4" fill="currentColor" />
        </button>
      )}
    </div>
  )
}

/** Shelves the API documents by id: translate their stock English titles, keep any custom server title. */
const STOCK_SECTIONS: Record<string, [string, MessageKey]> = {
  recent: ['Recently played', 'home.s.recent'],
  albums: ['Your albums', 'home.s.albums'],
  artists: ['Artists you love', 'home.s.artists'],
  'made-for-you': ['Made for you', 'home.s.madeForYou'],
  'new-releases': ['New releases', 'home.s.newReleases'],
  'new-tracks': ['Recently Added', 'home.s.newTracks'],
  'top-tracks': ['Most Played', 'home.s.topTracks'],
  unplayed: ['Never Played', 'home.s.unplayed'],
  'recently-played': ['Recently Played', 'home.s.recentlyPlayed'],
  playlists: ['Playlists', 'home.s.playlists']
}

export function HomePage(): ReactNode {
  const tr = useT()
  const name = useSession((s) => s.session?.user.displayName || s.session?.user.username)
  const home = useResource('home', (signal) => api.home(signal))
  const go = useNav((s) => s.go)
  const playTracks = playback.playTracks
  const hour = new Date().getHours()

  const sections = (home.data?.sections ?? []).map((s) => {
    const stock = STOCK_SECTIONS[s.id]
    return stock && s.title.toLowerCase() === stock[0].toLowerCase() ? { ...s, title: tr(stock[1]) } : s
  })
  const quick = sections.find((s) => s.kind === 'albums' || s.kind === 'playlists')
  const quickCards = quick ? toCards(quick).slice(0, 5) : []

  return (
    <Page tint="rgb(var(--accent-rgb) / 0.22)">
      <h1 className="fade-up mb-5 text-2xl font-extrabold tracking-tight md:text-3xl">
        {greeting(hour)}
        {name ? `, ${name}` : ''}
      </h1>

      {home.loading && (
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="skeleton h-14 rounded-lg md:h-16" />
          ))}
        </div>
      )}
      {home.error && !home.data && <ErrorState message={home.error} onRetry={home.reload} />}

      {home.data && (
        <>
          <div className="fade-up mb-9 grid grid-cols-2 gap-2 lg:grid-cols-3">
            <QuickTile
              title={tr('nav.likedSongs')}
              onOpen={() => go({ name: 'liked' })}
              icon={
                <span className="flex h-14 w-14 shrink-0 items-center justify-center bg-gradient-to-br from-accent to-[#7b5cff] md:h-16 md:w-16">
                  <Heart className="h-5 w-5 text-white" fill="currentColor" />
                </span>
              }
            />
            {quickCards.map((c) => (
              <QuickTile
                key={`${c.kind}:${c.item.id}`}
                title={c.kind === 'playlist' ? c.item.name : c.kind === 'album' ? c.item.title : c.item.name}
                images={c.item.artwork}
                onOpen={() => go(c.kind === 'playlist' && c.item.mix ? { name: 'mix', id: c.item.id } : { name: c.kind, id: c.item.id })}
              />
            ))}
          </div>

          {sections.map((section) =>
            section.kind === 'tracks' ? (
              section.items.length > 0 && (
                <section key={section.id} className="fade-up mb-8">
                  <div className="mb-2 flex items-end justify-between">
                    <h2 className="text-xl font-bold tracking-tight">{section.title}</h2>
                    <button
                      className="text-sm font-semibold text-fg-muted hover:text-fg"
                      onClick={() => void playTracks(section.items, 0, { type: 'home', id: section.id, name: section.title })}
                    >
                      {tr('home.playAll')}
                    </button>
                  </div>
                  <TrackList tracks={section.items.slice(0, 6)} context={{ type: 'home', id: section.id, name: section.title }} header={false} />
                </section>
              )
            ) : (
              <Shelf key={section.id} title={section.title} cards={toCards(section)} />
            )
          )}
          {sections.length === 0 && <p className="py-10 text-center text-fg-muted">{tr('home.empty')}</p>}
        </>
      )}
    </Page>
  )
}
