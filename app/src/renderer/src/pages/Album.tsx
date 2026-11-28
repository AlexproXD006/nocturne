import { useMemo, type ReactNode } from 'react'
import { api, collectionWithOffline } from '../services'
import { useResource } from '../hooks/useResource'
import { useNav } from '../store/nav'
import type { AlbumDetail } from '../api/types'
import { ErrorState } from '../components/common'
import { TrackList } from '../components/TrackList'
import { formatTotal, plural } from '../lib/format'
import { HeroHeader, Page, PlayButtons, useTint } from './Page'
import { AddToPlaylistButton } from '../components/Playlists'
import { DownloadButton } from '../components/DownloadButton'
import { useT, type MessageKey } from '../i18n'

const KIND_LABEL: Record<NonNullable<AlbumDetail['type']>, MessageKey> = {
  album: 'album.album',
  single: 'album.single',
  ep: 'album.ep',
  compilation: 'album.compilation'
}

export function PageSkeleton({ round = false }: { round?: boolean }): ReactNode {
  const tr = useT()
  return (
    <div aria-busy="true" aria-label={tr('ui.loading')}>
      <div className="flex flex-col items-center gap-6 pt-2 md:flex-row md:items-end">
        <div className={`skeleton h-48 w-48 shrink-0 md:h-56 md:w-56 ${round ? 'rounded-full' : 'rounded-lg'}`} />
        <div className="w-full max-w-md space-y-3">
          <div className="skeleton mx-auto h-3 w-16 rounded md:mx-0" />
          <div className="skeleton mx-auto h-10 w-3/4 rounded md:mx-0" />
          <div className="skeleton mx-auto h-4 w-1/2 rounded md:mx-0" />
        </div>
      </div>
      <div className="mt-10 space-y-2">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="skeleton h-12 rounded-lg" />
        ))}
      </div>
    </div>
  )
}

export function AlbumPage({ id }: { id: string }): ReactNode {
  const tr = useT()
  const res = useResource<AlbumDetail>(`album:${id}`, (s) => collectionWithOffline('album', id, () => api.album(id, s)))
  const go = useNav((s) => s.go)
  const album = res.data
  const tint = useTint(album?.artwork)
  const context = useMemo(() => ({ type: 'album' as const, id, name: album?.title ?? '' }), [id, album?.title])

  if (!album) {
    return (
      <Page>
        {res.error ? <ErrorState message={res.error} onRetry={res.reload} /> : <PageSkeleton />}
      </Page>
    )
  }

  const total = album.totalDuration ?? album.tracks.reduce((s, t) => s + t.duration, 0)
  const count = album.tracks.length || album.trackCount || 0

  const meta = (
    <p className="flex flex-wrap items-center justify-center gap-x-1.5 md:justify-start">
      {album.artists.map((a, i) => (
        <span key={a.id}>
          {i > 0 && ', '}
          <button type="button" onClick={() => go({ name: 'artist', id: a.id })} className="font-semibold text-fg hover:underline">
            {a.name}
          </button>
        </span>
      ))}
      {album.year ? <span aria-hidden>•</span> : null}
      {album.year ? <span>{album.year}</span> : null}
      <span aria-hidden>•</span>
      <span>
        {plural(count)}
        {total > 0 && <span className="text-fg-muted">, {formatTotal(total)}</span>}
      </span>
    </p>
  )

  return (
    <Page tint={tint}>
      <HeroHeader images={album.artwork} kind={tr(KIND_LABEL[album.type ?? 'album'])} title={album.title} meta={meta} />
      <PlayButtons tracks={album.tracks} context={context}>
        <AddToPlaylistButton tracks={album.tracks} label={album.title} size="lg" />
        <DownloadButton tracks={album.tracks} collection={{ kind: 'album', id, name: album.title }} />
      </PlayButtons>
      {res.error && <ErrorState message={res.error} onRetry={res.reload} />}
      <TrackList tracks={album.tracks} context={context} showArt={false} showAlbum={false} searchable />
    </Page>
  )
}
