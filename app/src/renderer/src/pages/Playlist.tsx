import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp, ListMusic, ListPlus, MoreHorizontal, Pencil, Trash2, X } from 'lucide-react'
import { api, collectionWithOffline } from '../services'
import { useResource } from '../hooks/useResource'
import type { PlaylistDetail, PlaylistTrack } from '../api/types'
import { describeError } from '../api/errors'
import { resources } from '../lib/resource'
import { useNav } from '../store/nav'
import { useUi } from '../store/ui'
import { addTracks, invalidatePlaylists, moveItem, playlistKey, usePlaylistUi } from '../store/playlists'
import { mapLimit } from '../lib/bulk'
import { Artwork, EmptyState, ErrorState, IconButton, cx } from '../components/common'
import { TrackList } from '../components/TrackList'
import { Menu, useMenu } from '../components/Menu'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { AddToPlaylistButton, PlaylistFormDialog, usePlaylistsEnabled } from '../components/Playlists'
import { DownloadButton } from '../components/DownloadButton'
import { artistNames, formatTotal, plural } from '../lib/format'
import { HeroHeader, Page, PlayButtons, useTint } from './Page'
import { PageSkeleton } from './Album'
import { useT } from '../i18n'

/**
 * Stable React keys, one per playlist row. A playlist may contain the same song more than once:
 * servers that support that give every occurrence an `entryId`; for older ones (whose imported
 * playlists can still contain repeats) the key is the song id plus its occurrence number.
 */
function rowKeys(tracks: readonly PlaylistTrack[]): string[] {
  const seen = new Map<string, number>()
  const used = new Set<string>()
  return tracks.map((t, i) => {
    if (t.entryId && !used.has(`e:${t.entryId}`)) {
      used.add(`e:${t.entryId}`)
      return `e:${t.entryId}`
    }
    const n = seen.get(t.id) ?? 0
    seen.set(t.id, n + 1)
    const key = n === 0 ? `t:${t.id}` : `t:${t.id}#${n}`
    return used.has(key) ? `i:${i}` : (used.add(key), key)
  })
}

/**
 * Touch-friendly edit mode: every row gets 44px "move up", "move down" and "remove" buttons.
 * Also the keyboard alternative to drag-and-drop on desktop.
 */
function PlaylistEditList({
  tracks,
  onMove,
  onRemove
}: {
  tracks: PlaylistTrack[]
  onMove: (from: number, to: number) => void
  onRemove: (index: number) => void
}): ReactNode {
  const tr = useT()
  const keys = useMemo(() => rowKeys(tracks), [tracks])
  const listRef = useRef<HTMLOListElement>(null)
  const pendingFocus = useRef<{ key: string; dir: 'up' | 'down' } | null>(null)
  const [announce, setAnnounce] = useState('')

  // Keep focus on the moved song's button; when it hits the top / bottom, use the other arrow.
  useEffect(() => {
    const want = pendingFocus.current
    if (!want) return
    pendingFocus.current = null
    const row = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-key]') ?? []).find((el) => el.dataset.key === want.key)
    const btn = row?.querySelector<HTMLButtonElement>(`[data-dir="${want.dir}"]`)
    const other = row?.querySelector<HTMLButtonElement>(`[data-dir="${want.dir === 'up' ? 'down' : 'up'}"]`)
    ;(btn && !btn.disabled ? btn : other && !other.disabled ? other : btn)?.focus()
  })

  const move = (i: number, dir: 'up' | 'down'): void => {
    const to = dir === 'up' ? i - 1 : i + 1
    if (to < 0 || to >= tracks.length) return
    pendingFocus.current = { key: keys[i]!, dir }
    setAnnounce(tr('pp.moved', { title: tracks[i]!.title, pos: to + 1, total: tracks.length }))
    onMove(i, to)
  }

  return (
    <>
      <ol ref={listRef} aria-label={tr('pp.editList')} className="-mx-3">
        {tracks.map((t, i) => (
          <li key={keys[i]} data-key={keys[i]} className="flex min-h-14 items-center gap-2 rounded-lg px-3 py-1 hover:bg-white/[0.04]">
            <span className="w-6 shrink-0 text-center text-sm text-fg-muted tabular-nums">{i + 1}</span>
            <Artwork images={t.artwork} size={40} className="h-10 w-10 shrink-0" rounded="rounded-md" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{t.title}</p>
              <p className="truncate text-[13px] text-fg-muted">{artistNames(t.artists)}</p>
            </div>
            <button
              type="button"
              data-dir="up"
              aria-label={tr('pp.moveUp', { title: t.title })}
              disabled={i === 0}
              onClick={() => move(i, 'up')}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg-muted hover:bg-white/8 hover:text-fg active:scale-95 disabled:opacity-30"
            >
              <ChevronUp className="h-5 w-5" />
            </button>
            <button
              type="button"
              data-dir="down"
              aria-label={tr('pp.moveDown', { title: t.title })}
              disabled={i === tracks.length - 1}
              onClick={() => move(i, 'down')}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg-muted hover:bg-white/8 hover:text-fg active:scale-95 disabled:opacity-30"
            >
              <ChevronDown className="h-5 w-5" />
            </button>
            <button
              type="button"
              aria-label={tr('pp.removeLabel', { title: t.title })}
              onClick={() => {
                setAnnounce(tr('pp.removedAnnounce', { title: t.title }))
                // Move focus to the next row (or the previous one when removing the last).
                const sibling = keys[i + 1] ?? keys[i - 1]
                if (sibling) pendingFocus.current = { key: sibling, dir: 'up' }
                onRemove(i)
              }}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg-muted hover:bg-white/8 hover:text-[#ff8f93] active:scale-95"
            >
              <X className="h-5 w-5" />
            </button>
          </li>
        ))}
      </ol>
      <p aria-live="polite" className="sr-only">
        {announce}
      </p>
    </>
  )
}

export function PlaylistPage({ id }: { id: string }): ReactNode {
  const tr = useT()
  const key = playlistKey(id)
  const res = useResource<PlaylistDetail>(key, (s) => collectionWithOffline('playlist', id, () => api.playlist(id, s)))
  const pl = res.data
  const tint = useTint(pl?.artwork)
  const context = useMemo(() => ({ type: 'playlist' as const, id, name: pl?.name ?? '' }), [id, pl?.name])
  const enabled = usePlaylistsEnabled()
  const canEdit = enabled && pl?.editable === true
  const replace = useNav((s) => s.replace)
  const { menu, open, close } = useMenu()
  const [dialog, setDialog] = useState<'details' | 'delete' | null>(null)
  const [editing, setEditing] = useState(false)
  const opSeq = useRef(0)
  const optionsRef = useRef<HTMLSpanElement>(null)

  /**
   * Optimistically shows `next`, then runs `send`. On failure the previous list comes back (or, if a
   * newer edit was made meanwhile, the page reloads from the server) and an error toast is shown.
   */
  const applyTracks = useCallback(
    async (
      compute: (tracks: PlaylistTrack[]) => PlaylistTrack[] | null,
      send: (next: PlaylistTrack[]) => Promise<PlaylistDetail | void>,
      done?: string
    ): Promise<void> => {
      const before = resources.peek<PlaylistDetail>(key)
      if (!before) return
      const next = compute(before.tracks)
      if (!next) return
      const op = ++opSeq.current
      resources.mutate<PlaylistDetail>(key, (p) => ({ ...p, tracks: next, trackCount: next.length }))
      try {
        const result = await send(next)
        if (op === opSeq.current && result && Array.isArray(result.tracks)) resources.set(key, result)
        invalidatePlaylists()
        if (done) useUi.getState().toast(done)
      } catch (err) {
        if (op === opSeq.current) resources.set(key, before)
        else resources.invalidate(key)
        useUi.getState().toast(describeError(err), 'error')
      }
    },
    [key]
  )

  /** Removes the row at `index`: just that occurrence when the server gave it an entry id, else every copy of the song. */
  const remove = useCallback(
    (index: number) => {
      const t = resources.peek<PlaylistDetail>(key)?.tracks[index]
      if (!t) return
      const entryId = t.entryId
      if (entryId) {
        void applyTracks(
          (tracks) => tracks.filter((x) => x.entryId !== entryId),
          () => api.removePlaylistEntry(id, entryId),
          tr('pp.removed', { title: t.title })
        )
        return
      }
      void applyTracks(
        (tracks) => tracks.filter((x) => x.id !== t.id),
        () => api.removeFromPlaylist(id, t.id),
        tr('pp.removed', { title: t.title })
      )
    },
    [applyTracks, id, key]
  )

  /** Removes several rows at once (bulk action): optimistic, concurrent requests, Undo re-adds the songs at the end. */
  const removeMany = useCallback(
    async (items: { index: number; track: PlaylistTrack }[]): Promise<void> => {
      const before = resources.peek<PlaylistDetail>(key)
      if (!before || items.length === 0) return
      const drop = new Set(items.map((i) => i.index))
      const picked = items.map((i) => before.tracks[i.index]).filter((t): t is PlaylistTrack => Boolean(t))
      const op = ++opSeq.current
      resources.mutate<PlaylistDetail>(key, (p) => ({ ...p, tracks: p.tracks.filter((_, i) => !drop.has(i)), trackCount: p.tracks.length - drop.size }))
      const toast = useUi.getState().toast
      try {
        // Without entry ids the server removes every copy of a song, so each song id is sent once.
        const jobs = picked.every((t) => t.entryId) ? picked : [...new Map(picked.map((t) => [t.id, t])).values()]
        await mapLimit(jobs, 6, (t) => (t.entryId ? api.removePlaylistEntry(id, t.entryId) : api.removeFromPlaylist(id, t.id)))
        invalidatePlaylists()
        toast(tr('bk.removed', { count: picked.length }), 'info', {
          action: {
            label: tr('tl.undo'),
            run: () => {
              void addTracks(api, { id, name: before.name }, picked, undefined, { allowDuplicates: true })
                .then(() => {
                  resources.invalidate(key)
                  toast(tr('bk.restored', { count: picked.length }))
                })
                .catch((err: unknown) => toast(describeError(err), 'error'))
            }
          }
        })
      } catch (err) {
        void op
        resources.invalidate(key)
        toast(describeError(err), 'error')
      }
    },
    [id, key, tr]
  )

  // `reorderPlaylist` sends entry ids when every row has one (duplicates stay distinct), else song ids.
  const move = useCallback(
    (from: number, to: number) => {
      void applyTracks(
        (tracks) => (from === to || !tracks[from] || !tracks[to] ? null : moveItem(tracks, from, to)),
        (next) => api.reorderPlaylist(id, next)
      )
    },
    [applyTracks, id]
  )

  const keys = useMemo(() => rowKeys(pl?.tracks ?? []), [pl?.tracks])

  // Leaving edit mode when the playlist turns out not to be editable (e.g. after a reload).
  useEffect(() => {
    if (!canEdit) setEditing(false)
  }, [canEdit])

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
      {pl.description && <p className="line-clamp-2 max-w-xl break-words text-fg-muted">{pl.description}</p>}
      <p className="flex flex-wrap items-center justify-center gap-x-1.5 md:justify-start">
        {pl.owner && <span className="font-semibold text-fg">{pl.owner.name}</span>}
        {pl.owner && <span aria-hidden>•</span>}
        <span>
          {plural(pl.tracks.length)}
          {total > 0 && <span className="text-fg-muted">, {formatTotal(total)}</span>}
        </span>
      </p>
    </div>
  )

  return (
    <Page tint={tint}>
      <HeroHeader images={pl.artwork} kind={tr('nav.playlist')} title={pl.name} meta={meta} />
      <PlayButtons tracks={pl.tracks} context={context}>
        <AddToPlaylistButton tracks={pl.tracks} label={pl.name} size="lg" />
        <DownloadButton tracks={pl.tracks} collection={{ kind: 'playlist', id, name: pl.name }} />
        {canEdit && (
          <div className="ml-auto flex min-w-0 items-center gap-1">
            {pl.tracks.length > 0 && (
              <button
                type="button"
                aria-pressed={editing}
                onClick={() => setEditing((v) => !v)}
                className={cx(
                  'inline-flex h-11 shrink-0 items-center gap-2 rounded-full px-4 text-sm font-semibold transition active:scale-[0.97]',
                  editing ? 'bg-fg text-ink-950' : 'bg-white/[0.08] text-fg hover:bg-white/[0.14]'
                )}
              >
                {editing ? tr('pp.done') : tr('pp.edit')}
              </button>
            )}
            <span ref={optionsRef} className="inline-flex">
              <IconButton
                label={tr('pp.options')}
                size="lg"
                onClick={() => {
                  const r = optionsRef.current?.getBoundingClientRect()
                  open(r ? r.right - 210 : 16, r ? r.bottom + 6 : 16)
                }}
              >
                <MoreHorizontal className="h-6 w-6" />
              </IconButton>
            </span>
          </div>
        )}
      </PlayButtons>
      {res.error && <ErrorState message={res.error} onRetry={res.reload} />}
      {pl.tracks.length === 0 ? (
        <EmptyState
          icon={<ListMusic className="h-9 w-9" strokeWidth={1.4} />}
          title={tr('pp.emptyTitle')}
          hint={canEdit ? tr('pp.emptyEdit') : tr('pp.emptyView')}
        />
      ) : canEdit && editing ? (
        <PlaylistEditList tracks={pl.tracks} onMove={move} onRemove={remove} />
      ) : (
        <TrackList
          tracks={pl.tracks}
          rowKeys={keys}
          context={context}
          searchable
          onRemove={canEdit ? remove : undefined}
          onMove={canEdit ? move : undefined}
          onRemoveMany={canEdit ? removeMany : undefined}
        />
      )}

      {menu && (
        <Menu
          x={menu.x}
          y={menu.y}
          onClose={close}
          items={[
            { label: tr('bk.addAllOther'), icon: <ListPlus />, onSelect: () => usePlaylistUi.getState().openPicker(pl.tracks, pl.name) },
            { label: tr('pp.editDetails'), icon: <Pencil />, onSelect: () => setDialog('details') },
            { label: tr('pp.delete'), icon: <Trash2 />, onSelect: () => setDialog('delete') }
          ]}
        />
      )}
      {dialog === 'details' && (
        <PlaylistFormDialog
          title={tr('pp.editDetails')}
          submitLabel={tr('common.save')}
          initial={{ name: pl.name, description: pl.description ?? '' }}
          onClose={() => setDialog(null)}
          onSubmit={async (v) => {
            const updated = await api.updatePlaylist(id, { name: v.name, description: v.description })
            resources.mutate<PlaylistDetail>(key, (p) => ({
              ...p,
              name: updated?.name ?? v.name,
              description: updated ? updated.description : v.description || undefined,
              artwork: Array.isArray(updated?.artwork) ? updated.artwork : p.artwork
            }))
            invalidatePlaylists()
            useUi.getState().toast(tr('pp.updated'))
          }}
        />
      )}
      {dialog === 'delete' && (
        <ConfirmDialog
          title={tr('pp.deleteQ')}
          message={
            <>
              {tr('pp.deleteMsg', { name: '\u0000' }).split('\u0000').flatMap((part, i) => (i === 0 ? [part] : [<span key="n" className="font-semibold break-words text-fg">{pl.name}</span>, part]))}
            </>
          }
          confirmLabel={tr('common.delete')}
          tone="danger"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await api.deletePlaylist(id)
            invalidatePlaylists()
            useUi.getState().toast(tr('pp.deleted', { name: pl.name }))
            replace({ name: 'library', tab: 'playlists' })
          }}
        />
      )}
    </Page>
  )
}
