import { useMemo, useState, type ReactNode } from 'react'
import { ListEnd, ListMusic, Save } from 'lucide-react'
import { api, playback } from '../services'
import { useResource } from '../hooks/useResource'
import type { PlaylistDetail } from '../api/types'
import { describeError } from '../api/errors'
import { useNav } from '../store/nav'
import { useUi } from '../store/ui'
import { invalidatePlaylists } from '../store/playlists'
import { EmptyState, ErrorState, IconButton } from '../components/common'
import { TrackList } from '../components/TrackList'
import { AddToPlaylistButton, usePlaylistsEnabled } from '../components/Playlists'
import { formatTotal, plural } from '../lib/format'
import { HeroHeader, Page, PlayButtons, useTint } from './Page'
import { PageSkeleton } from './Album'
import { useT } from '../i18n'

/**
 * A generated "Hecho para ti" mix: the Playlist page layout, read-only (no editing, no per-row removal),
 * with a "Save as playlist" button that makes a normal, editable copy. Playback goes through the usual
 * playback router, so it follows Connect when controlling another device.
 */
export function MixPage({ id }: { id: string }): ReactNode {
  const tr = useT()
  const res = useResource<PlaylistDetail>(`mix:${id}`, (s) => api.mix(id, s))
  const mix = res.data
  const tint = useTint(mix?.artwork)
  const context = useMemo(() => ({ type: 'tracks' as const, id: `mix:${id}`, name: mix?.name ?? '' }), [id, mix?.name])
  const enabled = usePlaylistsEnabled()
  const go = useNav((s) => s.go)
  const [saving, setSaving] = useState(false)

  if (!mix) {
    return <Page>{res.error ? <ErrorState message={res.error} onRetry={res.reload} /> : <PageSkeleton />}</Page>
  }

  const total = mix.tracks.reduce((s, t) => s + t.duration, 0)

  const save = async (): Promise<void> => {
    if (saving || mix.tracks.length === 0) return
    setSaving(true)
    try {
      const created = await api.createPlaylist({
        name: mix.name,
        description: mix.description || undefined,
        trackIds: mix.tracks.map((t) => t.id)
      })
      invalidatePlaylists()
      useUi.getState().toast(tr('mix.saved', { name: mix.name }))
      if (created?.id) go({ name: 'playlist', id: created.id })
    } catch (err) {
      useUi.getState().toast(describeError(err), 'error')
    } finally {
      setSaving(false)
    }
  }

  const meta = (
    <div className="flex flex-col items-center gap-2 md:items-start">
      {mix.description && <p className="line-clamp-2 max-w-xl break-words text-fg-muted">{mix.description}</p>}
      <p>
        {plural(mix.tracks.length)}
        {total > 0 && <span className="text-fg-muted">, {formatTotal(total)}</span>}
      </p>
    </div>
  )

  return (
    <Page tint={tint}>
      <HeroHeader images={mix.artwork} kind={tr('mix.kind')} title={mix.name} meta={meta} />
      <PlayButtons tracks={mix.tracks} context={context}>
        <IconButton
          label={tr('mix.addAll')}
          size="lg"
          disabled={mix.tracks.length === 0}
          onClick={() => {
            playback.addToQueue(mix.tracks)
            useUi.getState().toast(tr('mix.addedAll'))
          }}
        >
          <ListEnd className="h-5 w-5" />
        </IconButton>
        <AddToPlaylistButton tracks={mix.tracks} label={mix.name} size="lg" />
        {enabled && (
          <button
            type="button"
            disabled={saving || mix.tracks.length === 0}
            onClick={() => void save()}
            className="ml-auto inline-flex h-11 shrink-0 items-center gap-2 rounded-full bg-white/[0.08] px-4 text-sm font-semibold text-fg transition hover:bg-white/[0.14] active:scale-[0.97] disabled:opacity-40"
          >
            <Save className="h-4 w-4" />
            {saving ? tr('mix.saving') : tr('mix.saveAs')}
          </button>
        )}
      </PlayButtons>
      {res.error && <ErrorState message={res.error} onRetry={res.reload} />}
      {mix.tracks.length === 0 ? (
        <EmptyState icon={<ListMusic className="h-9 w-9" strokeWidth={1.4} />} title={tr('mix.kind')} hint={tr('mix.empty')} />
      ) : (
        <TrackList tracks={mix.tracks} context={context} />
      )}
    </Page>
  )
}
