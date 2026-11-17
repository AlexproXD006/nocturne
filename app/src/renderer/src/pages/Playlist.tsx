import { useMemo, type ReactNode } from 'react'
import { ListMusic } from 'lucide-react'
import { api } from '../services'
import { useResource } from '../hooks/useResource'
import type { PlaylistDetail } from '../api/types'
import { EmptyState, ErrorState } from '../components/common'
import { TrackList } from '../components/TrackList'
import { formatTotal, plural } from '../lib/format'
import { HeroHeader, Page, PlayButtons, useTint } from './Page'
import { PageSkeleton } from './Album'

export function PlaylistPage({ id }: { id: string }): ReactNode {
  const res = useResource<PlaylistDetail>(`playlist:${id}`, (s) => api.playlist(id, s))
  const pl = res.data
  const tint = useTint(pl?.artwork)
  const context = useMemo(() => ({ type: 'playlist' as const, id, name: pl?.name ?? '' }), [id, pl?.name])

  if (!pl) {
    return (
      <Page>
        {res.error ? <ErrorState message={res.error} onRetry={res.reload} /> : <PageSkeleton />}
      </Page>
    )
  }

  const total = pl.tracks.reduce((s, t) => s + t.duration, 0)

  const meta = (
    <div className="flex flex-col items-center gap-2 md:items-start">
      {pl.description && <p className="line-clamp-2 max-w-xl text-fg-muted">{pl.description}</p>}
      <p className="flex flex-wrap items-center justify-center gap-x-1.5 md:justify-start">
        {pl.owner && <span className="font-semibold text-fg">{pl.owner.name}</span>}
        {pl.owner && <span aria-hidden>•</span>}
        <span>
          {plural(pl.tracks.length, 'song')}
          {total > 0 && <span className="text-fg-muted">, {formatTotal(total)}</span>}
        </span>
      </p>
    </div>
  )

  return (
    <Page tint={tint}>
      <HeroHeader images={pl.artwork} kind="Playlist" title={pl.name} meta={meta} />
      <PlayButtons tracks={pl.tracks} context={context} />
      {res.error && <ErrorState message={res.error} onRetry={res.reload} />}
      {pl.tracks.length === 0 ? (
        <EmptyState icon={<ListMusic className="h-9 w-9" strokeWidth={1.4} />} title="This playlist is empty" hint="Songs added to it on your server will appear here." />
      ) : (
        <TrackList tracks={pl.tracks} context={context} />
      )}
    </Page>
  )
}
