import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Clock, Play, Search as SearchIcon, X } from 'lucide-react'
import { api, usePlayer } from '../services'
import type { SearchResults } from '../api/types'
import { describeError, isAbort } from '../api/errors'
import { readJson, writeJson } from '../lib/storage'
import { useNav } from '../store/nav'
import { CardGrid, Shelf } from '../components/cards'
import { Artwork, EmptyState, ErrorState, Spinner, cx } from '../components/common'
import { TrackList } from '../components/TrackList'
import { artistNames } from '../lib/format'
import { Page } from './Page'

type Filter = 'all' | 'tracks' | 'albums' | 'artists' | 'playlists'
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'tracks', label: 'Songs' },
  { id: 'albums', label: 'Albums' },
  { id: 'artists', label: 'Artists' },
  { id: 'playlists', label: 'Playlists' }
]
const RECENT_KEY = 'nocturne.recentSearches'

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return v
}

export function SearchPage({ initial }: { initial?: string }): ReactNode {
  const [query, setQuery] = useState(initial ?? '')
  const [filter, setFilter] = useState<Filter>('all')
  const [results, setResults] = useState<SearchResults | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [recent, setRecent] = useState<string[]>(() => readJson<string[]>(RECENT_KEY, [], (v): v is string[] => Array.isArray(v)))
  const debounced = useDebounced(query.trim(), 250)
  const replace = useNav((s) => s.replace)

  useEffect(() => {
    if (!debounced) {
      setResults(null)
      setError(null)
      return
    }
    const ctrl = new AbortController()
    setLoading(true)
    setError(null)
    api
      .search(debounced, { limit: 30, signal: ctrl.signal })
      .then((r) => {
        setResults(r)
        replace({ name: 'search', q: debounced })
        const next = [debounced, ...recent.filter((x) => x.toLowerCase() !== debounced.toLowerCase())].slice(0, 8)
        setRecent(next)
        writeJson(RECENT_KEY, next)
      })
      .catch((err: unknown) => {
        if (!isAbort(err) && !ctrl.signal.aborted) setError(describeError(err))
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false)
      })
    return () => ctrl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced])

  const header = (
    <div className="relative max-w-md">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-3.5 h-[18px] w-[18px] -translate-y-1/2 text-fg-muted" />
      <input
        id="search-input"
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="What do you want to listen to?"
        aria-label="Search"
        type="search"
        spellCheck={false}
        className="h-11 w-full rounded-full border border-transparent bg-ink-800 pr-10 pl-11 text-sm outline-none transition placeholder:text-fg-subtle focus:border-white/20 focus:bg-ink-700 [&::-webkit-search-cancel-button]:hidden"
      />
      {query && (
        <button aria-label="Clear search" onClick={() => setQuery('')} className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-1.5 text-fg-muted hover:text-fg">
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  )

  return (
    <Page header={header}>
      {!debounced && (
        <section className="fade-up">
          {recent.length > 0 ? (
            <>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-xl font-bold tracking-tight">Recent searches</h2>
                <button
                  className="text-sm text-fg-muted hover:text-fg"
                  onClick={() => {
                    setRecent([])
                    writeJson(RECENT_KEY, [])
                  }}
                >
                  Clear
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {recent.map((r) => (
                  <button key={r} onClick={() => setQuery(r)} className="inline-flex items-center gap-2 rounded-full bg-white/[0.07] px-4 py-2 text-sm hover:bg-white/[0.12]">
                    <Clock className="h-3.5 w-3.5 text-fg-muted" /> {r}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <EmptyState icon={<SearchIcon className="h-9 w-9" strokeWidth={1.4} />} title="Search your music" hint="Find songs, albums, artists and playlists. Tip: press Ctrl+K anywhere." />
          )}
        </section>
      )}

      {debounced && (
        <>
          <div className="hide-scrollbar -mx-4 mt-1 mb-6 flex gap-2 overflow-x-auto px-4 md:mx-0 md:px-0" role="tablist">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                role="tab"
                aria-selected={filter === f.id}
                onClick={() => setFilter(f.id)}
                className={cx('shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition', filter === f.id ? 'bg-fg text-ink-950' : 'bg-white/[0.07] text-fg hover:bg-white/[0.12]')}
              >
                {f.label}
              </button>
            ))}
            {loading && <Spinner className="ml-2 h-5 w-5 self-center" />}
          </div>
          {error && <ErrorState message={error} />}
          {results && <Results results={results} filter={filter} query={debounced} />}
        </>
      )}
    </Page>
  )
}

function Results({ results, filter, query }: { results: SearchResults; filter: Filter; query: string }): ReactNode {
  const go = useNav((s) => s.go)
  const playTracks = usePlayer((s) => s.playTracks)
  const ctx = useMemo(() => ({ type: 'search' as const, id: query, name: `“${query}”` }), [query])
  const albums = results.albums.map((item) => ({ kind: 'album' as const, item }))
  const artists = results.artists.map((item) => ({ kind: 'artist' as const, item }))
  const playlists = results.playlists.map((item) => ({ kind: 'playlist' as const, item }))
  const empty = !results.tracks.length && !albums.length && !artists.length && !playlists.length

  if (empty) return <EmptyState icon={<SearchIcon className="h-9 w-9" strokeWidth={1.4} />} title={`No results for “${query}”`} hint="Check the spelling or try fewer words." />

  if (filter === 'tracks') return <TrackList tracks={results.tracks} context={ctx} />
  if (filter === 'albums') return <CardGrid cards={albums} />
  if (filter === 'artists') return <CardGrid cards={artists} />
  if (filter === 'playlists') return <CardGrid cards={playlists} />

  const top = results.artists[0] ?? null
  const topTrack = results.tracks[0] ?? null
  return (
    <div className="fade-up">
      <div className="mb-8 grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        {(top || topTrack) && (
          <section>
            <h2 className="mb-3 text-xl font-bold tracking-tight">Top result</h2>
            <div
              role="link"
              tabIndex={0}
              onClick={() => (top ? go({ name: 'artist', id: top.id }) : topTrack?.album && go({ name: 'album', id: topTrack.album.id }))}
              className="group relative cursor-pointer rounded-2xl bg-white/[0.05] p-5 transition hover:bg-white/[0.09]"
            >
              <Artwork images={top ? top.artwork : topTrack!.artwork} size={120} round={Boolean(top)} className="mb-4 h-24 w-24 shadow-xl shadow-black/40" />
              <p className="truncate text-3xl font-extrabold tracking-tight">{top ? top.name : topTrack!.title}</p>
              <p className="mt-1 text-sm text-fg-muted">{top ? 'Artist' : `Song • ${artistNames(topTrack!.artists)}`}</p>
              {!top && topTrack && (
                <button
                  aria-label={`Play ${topTrack.title}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    void playTracks(results.tracks, 0, ctx)
                  }}
                  className="absolute right-5 bottom-5 flex h-12 w-12 items-center justify-center rounded-full bg-accent text-ink-950 opacity-0 shadow-xl transition group-hover:opacity-100"
                >
                  <Play className="ml-0.5 h-5 w-5" fill="currentColor" />
                </button>
              )}
            </div>
          </section>
        )}
        {results.tracks.length > 0 && (
          <section className="min-w-0">
            <h2 className="mb-3 text-xl font-bold tracking-tight">Songs</h2>
            <TrackList tracks={results.tracks.slice(0, 5)} context={ctx} header={false} showAlbum={false} />
          </section>
        )}
      </div>
      <Shelf title="Artists" cards={artists} />
      <Shelf title="Albums" cards={albums} />
      <Shelf title="Playlists" cards={playlists} />
    </div>
  )
}
