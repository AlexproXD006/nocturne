import type { ReactNode } from 'react'
import { Heart, Library as LibraryIcon } from 'lucide-react'
import { api } from '../services'
import { usePaged } from '../hooks/usePaged'
import { useNav, type LibraryTab } from '../store/nav'
import { CardGrid, CardSkeletonGrid, type CardItem } from '../components/cards'
import { EmptyState, ErrorState, Spinner, cx } from '../components/common'
import { TrackList } from '../components/TrackList'
import { formatTotal, plural } from '../lib/format'
import { prefersReducedMotion, useSettings } from '../store/settings'
import { HeroHeader, Page, PlayButtons } from './Page'

/** Loading placeholder for a list of songs (matches the TrackList row height). */
function SongsSkeleton(): ReactNode {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="skeleton mb-4 h-7 w-32 rounded" />
      <div className="skeleton my-6 h-14 w-14 rounded-full" />
      <div className="-mx-3 space-y-1">
        {Array.from({ length: 10 }, (_, i) => (
          <div key={i} className="skeleton mx-3 h-14 rounded-lg" />
        ))}
      </div>
    </div>
  )
}

const TABS: { id: LibraryTab; label: string }[] = [
  { id: 'playlists', label: 'Playlists' },
  { id: 'albums', label: 'Albums' },
  { id: 'artists', label: 'Artists' },
  { id: 'songs', label: 'Songs' }
]

function LibraryGrid({ tab }: { tab: LibraryTab }): ReactNode {
  const paged = usePaged<CardItem>(`library:${tab}`, async (offset, limit, signal) => {
    if (tab === 'albums') {
      const p = await api.libraryAlbums(offset, limit, signal)
      return { ...p, items: p.items.map((item) => ({ kind: 'album' as const, item })) }
    }
    if (tab === 'artists') {
      const p = await api.libraryArtists(offset, limit, signal)
      return { ...p, items: p.items.map((item) => ({ kind: 'artist' as const, item })) }
    }
    const p = await api.libraryPlaylists(offset, limit, signal)
    return { ...p, items: p.items.map((item) => ({ kind: 'playlist' as const, item })) }
  })

  if (paged.error && paged.items.length === 0) return <ErrorState message={paged.error} onRetry={paged.reload} />
  if (paged.loading && paged.items.length === 0) return <CardSkeletonGrid />
  if (paged.done && paged.items.length === 0) {
    return <EmptyState icon={<LibraryIcon className="h-9 w-9" strokeWidth={1.4} />} title={`No ${tab} yet`} hint="Things you add on your server will show up here." />
  }
  return (
    <>
      <CardGrid cards={paged.items} />
      {!paged.done && (
        <div ref={paged.sentinel} className="flex justify-center py-8">
          {paged.loading && <Spinner />}
        </div>
      )}
    </>
  )
}

function LibrarySongs(): ReactNode {
  const paged = usePaged('library:songs', (offset, limit, signal) => api.librarySongs(offset, limit, signal), 100)
  const ctx = { type: 'library' as const, id: 'all', name: 'All Songs' }

  if (paged.error && paged.items.length === 0) return <ErrorState message={paged.error} onRetry={paged.reload} />
  if (paged.loading && paged.items.length === 0) return <SongsSkeleton />
  if (paged.done && paged.items.length === 0) {
    return <EmptyState icon={<LibraryIcon className="h-9 w-9" strokeWidth={1.4} />} title="No songs yet" hint="Things you add on your server will show up here." />
  }
  return (
    <>
      <div className="mb-4 flex items-baseline gap-3">
        <h2 className="text-xl font-bold tracking-tight">Songs</h2>
        {paged.total > 0 && <span className="text-sm text-fg-muted">{plural(paged.total, 'song')}</span>}
      </div>
      <PlayButtons tracks={paged.items} context={ctx} />
      <TrackList tracks={paged.items} context={ctx} />
      {!paged.done && (
        <div ref={paged.sentinel} className="flex justify-center py-8">
          {paged.loading && <Spinner />}
        </div>
      )}
    </>
  )
}

export function LibraryPage({ tab = 'playlists' }: { tab?: LibraryTab }): ReactNode {
  const replace = useNav((s) => s.replace)
  const go = useNav((s) => s.go)
  const reduced = prefersReducedMotion(useSettings((s) => s.motion))
  return (
    <Page>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">Your Library</h1>
        <button onClick={() => go({ name: 'liked' })} className="inline-flex items-center gap-2 rounded-full bg-white/[0.07] px-4 py-2 text-sm font-medium hover:bg-white/[0.12]">
          <Heart className="h-4 w-4 text-accent" fill="currentColor" /> Liked Songs
        </button>
      </div>
      <div className="hide-scrollbar -mx-4 mb-6 flex gap-2 overflow-x-auto px-4 md:mx-0 md:px-0" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => replace({ name: 'library', tab: t.id })}
            className={cx('shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition', tab === t.id ? 'bg-fg text-ink-950' : 'bg-white/[0.07] hover:bg-white/[0.12]')}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div key={tab} className={cx(!reduced && 'fade-up')}>
        {tab === 'songs' ? <LibrarySongs /> : <LibraryGrid tab={tab} />}
      </div>
    </Page>
  )
}

export function LikedPage(): ReactNode {
  const paged = usePaged('library:tracks', (offset, limit, signal) => api.libraryTracks(offset, limit, signal), 100)
  const ctx = { type: 'library' as const, id: 'liked', name: 'Liked Songs' }
  const total = paged.items.reduce((s, t) => s + t.duration, 0)
  return (
    <Page tint="rgb(123 92 255 / 0.35)">
      <HeroHeader
        images={undefined}
        kind="Playlist"
        title="Liked Songs"
        fallback={
          <div className="flex h-48 w-48 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-[#7b5cff] shadow-2xl shadow-black/60 md:h-56 md:w-56">
            <Heart className="h-20 w-20 text-white" fill="currentColor" />
          </div>
        }
        meta={paged.total ? `${plural(paged.total, 'song')}${paged.done ? ` • ${formatTotal(total)}` : ''}` : null}
      />
      <PlayButtons tracks={paged.items} context={ctx} />
      {paged.error && paged.items.length === 0 && <ErrorState message={paged.error} onRetry={paged.reload} />}
      {paged.done && paged.items.length === 0 && (
        <EmptyState icon={<Heart className="h-9 w-9" strokeWidth={1.4} />} title="Songs you like will appear here" hint="Tap the heart on any song to save it." />
      )}
      {paged.items.length > 0 && <TrackList tracks={paged.items} context={ctx} />}
      {!paged.done && (
        <div ref={paged.sentinel} className="flex justify-center py-8">
          {paged.loading && <Spinner />}
        </div>
      )}
    </Page>
  )
}
