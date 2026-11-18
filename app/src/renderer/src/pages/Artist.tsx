import { useMemo, useState, type ReactNode } from 'react'
import { api } from '../services'
import { useResource } from '../hooks/useResource'
import type { ArtistDetail } from '../api/types'
import { Shelf, type CardItem } from '../components/cards'
import { ErrorState, SectionHeader, cx } from '../components/common'
import { TrackList } from '../components/TrackList'
import { HeroHeader, Page, PlayButtons, useTint } from './Page'
import { PageSkeleton } from './Album'

export function ArtistPage({ id }: { id: string }): ReactNode {
  const res = useResource<ArtistDetail>(`artist:${id}`, (s) => api.artist(id, s))
  const artist = res.data
  const heroImages = useMemo(
    () => (artist?.artwork.length ? artist.artwork : artist?.image ? [{ url: artist.image, width: 1000 }] : []),
    [artist?.artwork, artist?.image]
  )
  const tint = useTint(heroImages)
  const [expanded, setExpanded] = useState(false)
  const [bioOpen, setBioOpen] = useState(false)
  const context = useMemo(() => ({ type: 'artist' as const, id, name: artist?.name ?? '' }), [id, artist?.name])
  const albums = useMemo<CardItem[]>(() => (artist?.albums ?? []).map((item) => ({ kind: 'album' as const, item })), [artist?.albums])

  if (!artist) {
    return (
      <Page>
        {res.error ? <ErrorState message={res.error} onRetry={res.reload} /> : <PageSkeleton round />}
      </Page>
    )
  }

  const popular = artist.topTracks.slice(0, expanded ? 10 : 5)
  const bio = artist.bio?.trim()
  const longBio = (bio?.length ?? 0) > 280

  return (
    <Page tint={tint}>
      <HeroHeader
        images={heroImages}
        round
        kind="Artist"
        title={artist.name}
        meta={artist.followers != null ? <p>{artist.followers.toLocaleString()} followers</p> : null}
      />
      <PlayButtons tracks={artist.topTracks} context={context} />
      {res.error && <ErrorState message={res.error} onRetry={res.reload} />}

      {artist.topTracks.length > 0 && (
        <section className="mb-10 fade-up">
          <SectionHeader title="Popular" />
          <TrackList tracks={popular} context={context} header={false} />
          {artist.topTracks.length > 5 && (
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
              className="mt-2 rounded-full px-3 py-1.5 text-sm font-semibold text-fg-muted hover:text-fg"
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </section>
      )}

      <Shelf title="Discography" cards={albums} />

      {bio && (
        <section className="mb-6 max-w-2xl fade-up">
          <SectionHeader title="About" />
          <p className={cx('text-sm leading-relaxed whitespace-pre-line text-fg-muted', !bioOpen && 'line-clamp-4')}>{bio}</p>
          {longBio && (
            <button
              type="button"
              aria-expanded={bioOpen}
              onClick={() => setBioOpen((v) => !v)}
              className="mt-2 text-sm font-semibold text-fg hover:underline"
            >
              {bioOpen ? 'Show less' : 'Read more'}
            </button>
          )}
        </section>
      )}
    </Page>
  )
}
