import { useState, type ReactNode } from 'react'
import { AudioLines, Heart, Library as LibraryIcon, Plus } from 'lucide-react'
import { api } from '../services'
import { usePaged } from '../hooks/usePaged'
import { useNav, type LibraryTab } from '../store/nav'
import { CardGrid, CardSkeletonGrid, type CardItem } from '../components/cards'
import { EmptyState, ErrorState, Spinner, cx } from '../components/common'
import { TrackList } from '../components/TrackList'
import { formatTotal, plural } from '../lib/format'
import { prefersReducedMotion, useSettings } from '../store/settings'
import { HeroHeader, Page, PlayButtons } from './Page'
import { CreatePlaylistDialog, NewPlaylistTile, usePlaylistsEnabled } from '../components/Playlists'
import { ImportSpotifyTile, SpotifyImportDialog, SpotifyImports, useSpotifyImportEnabled } from '../components/Spotify'
import { useT, type MessageKey } from '../i18n'

/** Loading placeholder for a list of songs (matches the TrackList row height). */
function SongsSkeleton(): ReactNode {
  const tr = useT()
  return (
    <div aria-busy="true" aria-label={tr('ui.loading')}>
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

const TABS: { id: LibraryTab; label: MessageKey }[] = [
  { id: 'playlists', label: 'lib.playlists' },
  { id: 'albums', label: 'lib.albums' },
  { id: 'artists', label: 'lib.artists' },
  { id: 'songs', label: 'lib.songs' }
]

function LibraryGrid({ tab }: { tab: LibraryTab }): ReactNode {
  const tr = useT()
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

  const canCreate = usePlaylistsEnabled() && tab === 'playlists'
  const canImport = useSpotifyImportEnabled() && tab === 'playlists'
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState(false)
  const dialog = (
    <>
      {creating && <CreatePlaylistDialog onClose={() => setCreating(false)} />}
      {importing && <SpotifyImportDialog onClose={() => setImporting(false)} />}
    </>
  )

  if (paged.error && paged.items.length === 0) return <ErrorState message={paged.error} onRetry={paged.reload} />
  if (paged.loading && paged.items.length === 0) return <CardSkeletonGrid />
  if (paged.done && paged.items.length === 0) {
    return (
      <>
        <EmptyState
          icon={<LibraryIcon className="h-9 w-9" strokeWidth={1.4} />}
          title={tr(`lib.no${tab[0]!.toUpperCase()}${tab.slice(1)}` as MessageKey)}
          hint={
            canCreate
              ? tr('lib.emptyCreate')
              : canImport
                ? tr('lib.emptyImport')
                : tr('lib.emptyServer')
          }
          action={
            (canCreate || canImport) && (
              <div className="flex flex-wrap justify-center gap-2">
                {canCreate && (
                  <button
                    type="button"
                    onClick={() => setCreating(true)}
                    className="inline-flex h-11 items-center gap-2 rounded-full bg-accent px-5 text-sm font-bold text-ink-950 transition hover:brightness-110 active:scale-[0.98]"
                  >
                    <Plus className="h-4 w-4" aria-hidden /> {tr('lib.newPlaylist')}
                  </button>
                )}
                {canImport && (
                  <button
                    type="button"
                    onClick={() => setImporting(true)}
                    className="inline-flex h-11 items-center gap-2 rounded-full bg-white/[0.08] px-5 text-sm font-bold transition hover:bg-white/[0.14] active:scale-[0.98]"
                  >
                    <AudioLines className="h-4 w-4 text-[#1ed760]" aria-hidden /> {tr('sp.import')}
                  </button>
                )}
              </div>
            )
          }
        />
        {dialog}
      </>
    )
  }
  return (
    <>
      <CardGrid
        cards={paged.items}
        leading={
          canCreate || canImport ? (
            <>
              {canCreate && <NewPlaylistTile onClick={() => setCreating(true)} />}
              {canImport && <ImportSpotifyTile onClick={() => setImporting(true)} />}
            </>
          ) : undefined
        }
      />
      {dialog}
      {!paged.done && (
        <div ref={paged.sentinel} className="flex justify-center py-8">
          {paged.loading && <Spinner />}
        </div>
      )}
    </>
  )
}

function LibrarySongs(): ReactNode {
  const tr = useT()
  const paged = usePaged('library:songs', (offset, limit, signal) => api.librarySongs(offset, limit, signal), 100)
  const ctx = { type: 'library' as const, id: 'all', name: tr('lib.allSongs') }

  if (paged.error && paged.items.length === 0) return <ErrorState message={paged.error} onRetry={paged.reload} />
  if (paged.loading && paged.items.length === 0) return <SongsSkeleton />
  if (paged.done && paged.items.length === 0) {
    return <EmptyState icon={<LibraryIcon className="h-9 w-9" strokeWidth={1.4} />} title={tr('lib.noSongs')} hint={tr('lib.emptyServer')} />
  }
  return (
    <>
      <div className="mb-4 flex items-baseline gap-3">
        <h2 className="text-xl font-bold tracking-tight">{tr('lib.songs')}</h2>
        {paged.total > 0 && <span className="text-sm text-fg-muted">{plural(paged.total)}</span>}
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
  const tr = useT()
  const replace = useNav((s) => s.replace)
  const go = useNav((s) => s.go)
  const reduced = prefersReducedMotion(useSettings((s) => s.motion))
  return (
    <Page>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">{tr('lib.title')}</h1>
        <button onClick={() => go({ name: 'liked' })} className="inline-flex items-center gap-2 rounded-full bg-white/[0.07] px-4 py-2 text-sm font-medium hover:bg-white/[0.12]">
          <Heart className="h-4 w-4 text-accent" fill="currentColor" /> {tr('nav.likedSongs')}
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
            {tr(t.label)}
          </button>
        ))}
      </div>
      <div key={tab} className={cx(!reduced && 'fade-up')}>
        {tab === 'playlists' && <SpotifyImports />}
        {tab === 'songs' ? <LibrarySongs /> : <LibraryGrid tab={tab} />}
      </div>
    </Page>
  )
}

export function LikedPage(): ReactNode {
  const tr = useT()
  const paged = usePaged('library:tracks', (offset, limit, signal) => api.libraryTracks(offset, limit, signal), 100)
  const ctx = { type: 'library' as const, id: 'liked', name: tr('nav.likedSongs') }
  const total = paged.items.reduce((s, t) => s + t.duration, 0)
  return (
    <Page tint="rgb(123 92 255 / 0.35)">
      <HeroHeader
        images={undefined}
        kind={tr('nav.playlist')}
        title={tr('nav.likedSongs')}
        fallback={
          <div className="flex h-48 w-48 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-[#7b5cff] shadow-2xl shadow-black/60 md:h-56 md:w-56">
            <Heart className="h-20 w-20 text-white" fill="currentColor" />
          </div>
        }
        meta={paged.total ? `${plural(paged.total)}${paged.done ? ` • ${formatTotal(total)}` : ''}` : null}
      />
      <PlayButtons tracks={paged.items} context={ctx} />
      {paged.error && paged.items.length === 0 && <ErrorState message={paged.error} onRetry={paged.reload} />}
      {paged.done && paged.items.length === 0 && (
        <EmptyState icon={<Heart className="h-9 w-9" strokeWidth={1.4} />} title={tr('lib.likedEmpty')} hint={tr('lib.likedEmptyHint')} />
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
