import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Playlist, PlaylistDetail, PlaylistTrack } from '@/api/types'
import { useSession } from '@/services'
import { resources } from '@/lib/resource'
import { useUi } from '@/store/ui'
import { useNav } from '@/store/nav'
import { usePlaylistUi } from '@/store/playlists'
import { AddToPlaylistDialog, PlaylistPickerHost } from '@/components/Playlists'
import { TrackList } from '@/components/TrackList'
import { Toasts } from '@/components/Shell'
import { PlaylistPage } from '@/pages/Playlist'
import { LibraryPage } from '@/pages/Library'
import { track, tracks } from '../helpers/fixtures'

const h = vi.hoisted(() => ({
  api: {
    libraryPlaylists: vi.fn(),
    playlist: vi.fn(),
    createPlaylist: vi.fn(),
    updatePlaylist: vi.fn(),
    deletePlaylist: vi.fn(),
    addToPlaylist: vi.fn(),
    removeFromPlaylist: vi.fn(),
    removePlaylistEntry: vi.fn(),
    reorderPlaylist: vi.fn(),
    setLiked: vi.fn()
  }
}))

vi.mock('@/services', async () => {
  const { create } = await import('zustand')
  const useSession = create(() => ({
    status: 'signedIn',
    session: { user: { id: 'u1', username: 'demo', displayName: 'Demo' } },
    server: { name: 'x', version: '1', apiVersion: 1, capabilities: { playlists: true } } as unknown,
    logout: async () => undefined
  }))
  const usePlayer = create(() => ({
    queue: { items: [], index: -1, shuffle: false, repeat: 'off', context: null },
    status: 'idle',
    toggle: () => undefined,
    playTracks: async () => undefined,
    addNext: () => undefined,
    addToQueue: () => undefined
  }))
  const { connectMocks } = await import('../helpers/services-mock')
  return { api: h.api, platform: {}, getEngine: () => null, useSession, usePlayer, ...connectMocks(usePlayer) }
})

const pl = (id: string, editable?: boolean, over: Partial<Playlist> = {}): Playlist => ({ id, name: `List ${id}`, artwork: [], editable, trackCount: 2, ...over })
const page = <T,>(items: T[]) => ({ items, offset: 0, limit: 50, total: items.length })
const detail = (over: Partial<PlaylistDetail> = {}): PlaylistDetail => ({ ...pl('pl1', true), name: 'Road trip', tracks: tracks(3), ...over })

function setCapable(on: boolean): void {
  useSession.setState({ server: { name: 'x', version: '1', apiVersion: 1, capabilities: on ? { playlists: true } : { lyrics: true } } } as never)
}

const titles = (): string[] =>
  screen
    .getAllByRole('row')
    .map((r) => r.textContent ?? '')
    .filter((t) => /Title t\d/.test(t))
    .map((t) => /Title t\d/.exec(t)![0])

beforeEach(() => {
  Element.prototype.scrollTo = function scrollTo(): void {} as never
  Object.values(h.api).forEach((f) => f.mockReset())
  resources.clear()
  setCapable(true)
  useUi.setState({ toasts: [] })
  useNav.getState().reset()
  usePlaylistUi.setState({ picker: null })
  globalThis.IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] {
      return []
    }
  } as never
})

const toastText = (): string[] => useUi.getState().toasts.map((t) => t.message)

type Order = Array<string | Pick<PlaylistTrack, 'id' | 'entryId'>>
/** Song ids of what the page passed to `reorderPlaylist`. */
const orderIds = (order: Order): string[] => order.map((x) => (typeof x === 'string' ? x : x.id))
const entryOrder = (order: Order): Array<string | undefined> => order.map((x) => (typeof x === 'string' ? undefined : x.entryId))
const reorderEcho = async (_id: string, order: Order): Promise<PlaylistDetail> =>
  detail({ tracks: order.map((x) => (typeof x === 'string' ? track(x) : { ...track(x.id), ...(x.entryId ? { entryId: x.entryId } : {}) })) })

describe('Add to playlist picker', () => {
  beforeEach(() => {
    h.api.libraryPlaylists.mockResolvedValue(page([pl('mine', true), pl('shared', false), pl('legacy'), pl('other', true, { name: 'Gym' })]))
  })

  it('lists only editable playlists and adds the song to the chosen one', async () => {
    h.api.addToPlaylist.mockResolvedValue({ added: 1, skipped: [], playlist: pl('mine', true) })
    const onClose = vi.fn()
    render(<AddToPlaylistDialog tracks={[track('t1')]} label="Title t1" onClose={onClose} />)
    const dialog = screen.getByRole('dialog', { name: 'Add to playlist' })
    expect(await within(dialog).findByRole('button', { name: /List mine/ })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: /Gym/ })).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /List shared/ })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: /List legacy/ })).toBeNull()

    await userEvent.click(within(dialog).getByRole('button', { name: /List mine/ }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(h.api.addToPlaylist).toHaveBeenCalledWith('mine', ['t1'])
    expect(toastText()).toContain('Added to List mine')
  })

  it('says when the song is already in the playlist', async () => {
    h.api.addToPlaylist.mockResolvedValue({ added: 0, skipped: ['t1'], playlist: pl('mine', true) })
    render(<AddToPlaylistDialog tracks={[track('t1')]} label="Title t1" onClose={() => undefined} />)
    await userEvent.click(await screen.findByRole('button', { name: /List mine/ }))
    await waitFor(() => expect(toastText()).toContain('Already in List mine'))
  })

  it('offers "Add again" when the song is already there and adds it a second time', async () => {
    h.api.addToPlaylist
      .mockResolvedValueOnce({ added: 0, skipped: ['t1'], playlist: pl('mine', true) })
      .mockResolvedValueOnce({ added: 1, skipped: [], playlist: pl('mine', true) })
    const onClose = vi.fn()
    render(
      <>
        <AddToPlaylistDialog tracks={[track('t1')]} label="Title t1" onClose={onClose} />
        <Toasts />
      </>
    )
    await userEvent.click(await screen.findByRole('button', { name: /List mine/ }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(screen.getByText('Already in List mine')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Add again' }))
    await waitFor(() => expect(toastText()).toContain('Added to List mine'))
    expect(h.api.addToPlaylist).toHaveBeenNthCalledWith(1, 'mine', ['t1'])
    expect(h.api.addToPlaylist).toHaveBeenNthCalledWith(2, 'mine', ['t1'], { allowDuplicates: true })
    expect(toastText()).not.toContain('Already in List mine')
    expect(screen.queryByRole('button', { name: 'Add again' })).toBeNull()
  })

  it('offers "Add them again" for the skipped songs of a multi-song add', async () => {
    h.api.addToPlaylist
      .mockResolvedValueOnce({ added: 1, skipped: ['t1', 't2'], playlist: pl('mine', true) })
      .mockResolvedValueOnce({ added: 2, skipped: [], playlist: pl('mine', true) })
    render(
      <>
        <AddToPlaylistDialog tracks={tracks(3)} label="3 songs" onClose={() => undefined} />
        <Toasts />
      </>
    )
    await userEvent.click(await screen.findByRole('button', { name: /List mine/ }))
    expect(await screen.findByText('Added 1 song to List mine, 2 already there')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Add them again' }))
    await waitFor(() => expect(toastText()).toContain('Added 2 songs to List mine'))
    expect(h.api.addToPlaylist).toHaveBeenLastCalledWith('mine', ['t1', 't2'], { allowDuplicates: true })
  })

  it('does not offer "Add again" when everything was added', async () => {
    h.api.addToPlaylist.mockResolvedValue({ added: 1, skipped: [], playlist: pl('mine', true) })
    render(
      <>
        <AddToPlaylistDialog tracks={[track('t1')]} label="Title t1" onClose={() => undefined} />
        <Toasts />
      </>
    )
    await userEvent.click(await screen.findByRole('button', { name: /List mine/ }))
    expect(await screen.findByText('Added to List mine')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Add (them )?again/ })).toBeNull()
  })

  it('explains when a server without duplicate support skips the song again', async () => {
    h.api.addToPlaylist.mockResolvedValue({ added: 0, skipped: ['t1'], playlist: pl('mine', true) })
    render(
      <>
        <AddToPlaylistDialog tracks={[track('t1')]} label="Title t1" onClose={() => undefined} />
        <Toasts />
      </>
    )
    await userEvent.click(await screen.findByRole('button', { name: /List mine/ }))
    await userEvent.click(await screen.findByRole('button', { name: 'Add again' }))
    await waitFor(() => expect(toastText().some((m) => /doesn't allow the same song twice/.test(m))).toBe(true))
    expect(screen.queryByRole('button', { name: 'Add again' })).toBeNull()
  })

  it('shows an error toast when "Add again" fails', async () => {
    h.api.addToPlaylist.mockResolvedValueOnce({ added: 0, skipped: ['t1'], playlist: pl('mine', true) }).mockRejectedValueOnce(new Error('Offline'))
    render(
      <>
        <AddToPlaylistDialog tracks={[track('t1')]} label="Title t1" onClose={() => undefined} />
        <Toasts />
      </>
    )
    await userEvent.click(await screen.findByRole('button', { name: /List mine/ }))
    await userEvent.click(await screen.findByRole('button', { name: 'Add again' }))
    await waitFor(() => expect(useUi.getState().toasts).toContainEqual(expect.objectContaining({ message: 'Offline', tone: 'error' })))
  })

  it('filters with the search box', async () => {
    render(<AddToPlaylistDialog tracks={[track('t1')]} label="Title t1" onClose={() => undefined} />)
    await screen.findByRole('button', { name: /List mine/ })
    await userEvent.type(screen.getByLabelText('Search your playlists'), 'gy')
    expect(screen.queryByRole('button', { name: /List mine/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Gym/ })).toBeInTheDocument()
  })

  it('creates a new playlist containing the song', async () => {
    h.api.createPlaylist.mockResolvedValue({ ...pl('new', true), name: 'Fresh', tracks: [track('t1')] })
    const onClose = vi.fn()
    render(<AddToPlaylistDialog tracks={[track('t1')]} label="Title t1" onClose={onClose} />)
    await userEvent.click(screen.getByRole('button', { name: 'New playlist…' }))
    const dialog = screen.getByRole('dialog', { name: 'New playlist' })
    const name = within(dialog).getByLabelText('Name')
    expect(name).toHaveFocus()
    expect(within(dialog).getByRole('button', { name: 'Create and add' })).toBeDisabled()
    await userEvent.type(name, 'Fresh')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create and add' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(h.api.createPlaylist).toHaveBeenCalledWith({ name: 'Fresh', trackIds: ['t1'] })
    expect(toastText()).toContain('Added to Fresh')
  })

  it('keeps the dialog open and shows the error when adding fails', async () => {
    h.api.addToPlaylist.mockRejectedValue(new Error('Nope'))
    const onClose = vi.fn()
    render(<AddToPlaylistDialog tracks={[track('t1')]} label="Title t1" onClose={onClose} />)
    await userEvent.click(await screen.findByRole('button', { name: /List mine/ }))
    expect(await screen.findByText('Nope')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('opens from a track row menu through the global host', async () => {
    render(
      <>
        <TrackList tracks={[track('t1')]} context={{ type: 'search', id: 'q', name: 'q' }} />
        <PlaylistPickerHost />
      </>
    )
    await userEvent.click(screen.getByRole('button', { name: 'More options for Title t1' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Add to playlist…' }))
    expect(await screen.findByRole('dialog', { name: 'Add to playlist' })).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('Playlist page editing', () => {
  beforeEach(() => {
    h.api.playlist.mockResolvedValue(detail())
  })

  it('removes a song from the row menu', async () => {
    h.api.removeFromPlaylist.mockResolvedValue(undefined)
    render(<PlaylistPage id="pl1" />)
    await screen.findByRole('heading', { name: 'Road trip' })
    await userEvent.click(screen.getByRole('button', { name: 'More options for Title t1' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Remove from this playlist' }))
    expect(titles()).toEqual(['Title t0', 'Title t2'])
    expect(h.api.removeFromPlaylist).toHaveBeenCalledWith('pl1', 't1')
    await waitFor(() => expect(toastText()).toContain('Removed “Title t1”'))
  })

  it('rolls back and shows an error toast when removing fails', async () => {
    h.api.removeFromPlaylist.mockRejectedValue(new Error('Server says no'))
    render(<PlaylistPage id="pl1" />)
    await screen.findByRole('heading', { name: 'Road trip' })
    await userEvent.click(screen.getByRole('button', { name: 'More options for Title t1' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Remove from this playlist' }))
    await waitFor(() => expect(toastText()).toContain('Server says no'))
    expect(titles()).toEqual(['Title t0', 'Title t1', 'Title t2'])
  })

  it('reorders with the touch-friendly edit mode', async () => {
    h.api.reorderPlaylist.mockImplementation(reorderEcho)
    render(<PlaylistPage id="pl1" />)
    await screen.findByRole('heading', { name: 'Road trip' })
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const list = screen.getByRole('list', { name: 'Edit playlist songs' })
    expect(within(list).getByRole('button', { name: 'Move Title t0 up' })).toBeDisabled()
    await userEvent.click(within(list).getByRole('button', { name: 'Move Title t0 down' }))
    expect(h.api.reorderPlaylist).toHaveBeenCalledWith('pl1', expect.any(Array))
    expect(orderIds(h.api.reorderPlaylist.mock.calls[0]![1])).toEqual(['t1', 't0', 't2'])
    expect(within(list).getAllByRole('listitem').map((li) => /Title t\d/.exec(li.textContent ?? '')![0])).toEqual(['Title t1', 'Title t0', 'Title t2'])
    expect(within(list).getByRole('button', { name: 'Move Title t0 down' })).toHaveFocus()
    await userEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(titles()).toEqual(['Title t1', 'Title t0', 'Title t2'])
  })

  it('reorders with drag and drop on desktop', async () => {
    h.api.reorderPlaylist.mockImplementation(reorderEcho)
    render(<PlaylistPage id="pl1" />)
    await screen.findByRole('heading', { name: 'Road trip' })
    const rows = screen.getAllByRole('row').filter((r) => /Title t\d/.test(r.textContent ?? ''))
    fireEvent.dragStart(rows[0]!, { dataTransfer: { setData: () => undefined } })
    fireEvent.dragOver(rows[2]!, { dataTransfer: {} })
    fireEvent.drop(rows[2]!, { dataTransfer: {} })
    expect(titles()).toEqual(['Title t1', 'Title t2', 'Title t0'])
    await waitFor(() => expect(h.api.reorderPlaylist).toHaveBeenCalledTimes(1))
    expect(orderIds(h.api.reorderPlaylist.mock.calls[0]![1])).toEqual(['t1', 't2', 't0'])
  })

  it('renames through the details dialog', async () => {
    h.api.updatePlaylist.mockResolvedValue({ ...pl('pl1', true), name: 'Night drive', description: 'Late' })
    render(<PlaylistPage id="pl1" />)
    await screen.findByRole('heading', { name: 'Road trip' })
    await userEvent.click(screen.getByRole('button', { name: 'Playlist options' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Edit details' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit details' })
    const name = within(dialog).getByLabelText('Name')
    await userEvent.clear(name)
    await userEvent.type(name, 'Night drive')
    await userEvent.type(within(dialog).getByLabelText('Description (optional)'), 'Late')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('heading', { name: 'Night drive' })).toBeInTheDocument()
    expect(h.api.updatePlaylist).toHaveBeenCalledWith('pl1', { name: 'Night drive', description: 'Late' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('deletes after confirming and goes back to the Library', async () => {
    h.api.deletePlaylist.mockResolvedValue(undefined)
    useNav.getState().go({ name: 'playlist', id: 'pl1' })
    render(<PlaylistPage id="pl1" />)
    await screen.findByRole('heading', { name: 'Road trip' })
    await userEvent.click(screen.getByRole('button', { name: 'Playlist options' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete playlist' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete playlist?' })
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    expect(h.api.deletePlaylist).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(useNav.getState().route).toEqual({ name: 'library', tab: 'playlists' }))
    expect(h.api.deletePlaylist).toHaveBeenCalledWith('pl1')
  })

  it('shows no edit controls for a shared (non-editable) playlist', async () => {
    h.api.playlist.mockResolvedValue(detail({ editable: false }))
    render(<PlaylistPage id="pl1" />)
    await screen.findByRole('heading', { name: 'Road trip' })
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Playlist options' })).toBeNull()
    // Copying its songs into one of your own playlists is still possible.
    expect(screen.getByRole('button', { name: 'Add to playlist' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'More options for Title t1' }))
    expect(screen.queryByRole('menuitem', { name: 'Remove from this playlist' })).toBeNull()
  })
})

describe('Playlist page with the same song more than once', () => {
  // t0 appears twice (entries e1 and e3).
  const dupTracks = (): PlaylistTrack[] => [
    { ...track('t0'), entryId: 'e1' },
    { ...track('t1'), entryId: 'e2' },
    { ...track('t0'), entryId: 'e3' }
  ]
  beforeEach(() => {
    h.api.playlist.mockResolvedValue(detail({ tracks: dupTracks() }))
  })

  it('renders both rows', async () => {
    render(<PlaylistPage id="pl1" />)
    await screen.findByRole('heading', { name: 'Road trip' })
    expect(titles()).toEqual(['Title t0', 'Title t1', 'Title t0'])
    expect(screen.getByText('3 songs')).toBeInTheDocument()
  })

  it('removes only the chosen occurrence by entry id', async () => {
    h.api.removePlaylistEntry.mockResolvedValue(undefined)
    render(<PlaylistPage id="pl1" />)
    await screen.findByRole('heading', { name: 'Road trip' })
    await userEvent.click(screen.getAllByRole('button', { name: 'More options for Title t0' })[1]!)
    await userEvent.click(screen.getByRole('menuitem', { name: 'Remove from this playlist' }))
    expect(titles()).toEqual(['Title t0', 'Title t1'])
    expect(h.api.removePlaylistEntry).toHaveBeenCalledWith('pl1', 'e3')
    expect(h.api.removeFromPlaylist).not.toHaveBeenCalled()
    await waitFor(() => expect(toastText()).toContain('Removed “Title t0”'))
    expect((resources.peek('playlist:pl1') as PlaylistDetail).tracks.map((t) => t.entryId)).toEqual(['e1', 'e2'])
  })

  it('removes the first occurrence from edit mode and keeps the other', async () => {
    h.api.removePlaylistEntry.mockResolvedValue(undefined)
    render(<PlaylistPage id="pl1" />)
    await screen.findByRole('heading', { name: 'Road trip' })
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const list = screen.getByRole('list', { name: 'Edit playlist songs' })
    await userEvent.click(within(list).getAllByRole('button', { name: 'Remove Title t0 from playlist' })[0]!)
    expect(h.api.removePlaylistEntry).toHaveBeenCalledWith('pl1', 'e1')
    expect(within(list).getAllByRole('listitem').map((li) => /Title t\d/.exec(li.textContent ?? '')![0])).toEqual(['Title t1', 'Title t0'])
  })

  it('rolls back just that row when removing the occurrence fails', async () => {
    h.api.removePlaylistEntry.mockRejectedValue(new Error('Server says no'))
    render(<PlaylistPage id="pl1" />)
    await screen.findByRole('heading', { name: 'Road trip' })
    await userEvent.click(screen.getAllByRole('button', { name: 'More options for Title t0' })[0]!)
    await userEvent.click(screen.getByRole('menuitem', { name: 'Remove from this playlist' }))
    await waitFor(() => expect(toastText()).toContain('Server says no'))
    expect(titles()).toEqual(['Title t0', 'Title t1', 'Title t0'])
    expect((resources.peek('playlist:pl1') as PlaylistDetail).tracks.map((t) => t.entryId)).toEqual(['e1', 'e2', 'e3'])
  })

  it('moves one occurrence with the up / down buttons and sends entry ids', async () => {
    h.api.reorderPlaylist.mockImplementation(reorderEcho)
    render(<PlaylistPage id="pl1" />)
    await screen.findByRole('heading', { name: 'Road trip' })
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const list = screen.getByRole('list', { name: 'Edit playlist songs' })
    // The second copy of t0 moves up past t1; the first copy stays on top.
    await userEvent.click(within(list).getAllByRole('button', { name: 'Move Title t0 up' })[1]!)
    expect(entryOrder(h.api.reorderPlaylist.mock.calls[0]![1])).toEqual(['e1', 'e3', 'e2'])
    expect(within(list).getAllByRole('listitem').map((li) => /Title t\d/.exec(li.textContent ?? '')![0])).toEqual(['Title t0', 'Title t0', 'Title t1'])
    // Focus followed the moved occurrence (now the second row), not the first copy.
    const rows = within(list).getAllByRole('listitem')
    expect(within(rows[1]!).getByRole('button', { name: 'Move Title t0 up' })).toHaveFocus()
    await waitFor(() => expect((resources.peek('playlist:pl1') as PlaylistDetail).tracks.map((t) => t.entryId)).toEqual(['e1', 'e3', 'e2']))
  })

  it('reorders duplicates with drag and drop', async () => {
    h.api.reorderPlaylist.mockImplementation(reorderEcho)
    render(<PlaylistPage id="pl1" />)
    await screen.findByRole('heading', { name: 'Road trip' })
    const rows = screen.getAllByRole('row').filter((r) => /Title t\d/.test(r.textContent ?? ''))
    fireEvent.dragStart(rows[0]!, { dataTransfer: { setData: () => undefined } })
    fireEvent.dragOver(rows[2]!, { dataTransfer: {} })
    fireEvent.drop(rows[2]!, { dataTransfer: {} })
    expect(titles()).toEqual(['Title t1', 'Title t0', 'Title t0'])
    await waitFor(() => expect(h.api.reorderPlaylist).toHaveBeenCalledTimes(1))
    expect(entryOrder(h.api.reorderPlaylist.mock.calls[0]![1])).toEqual(['e2', 'e3', 'e1'])
  })

  it('rolls back a failed reorder', async () => {
    h.api.reorderPlaylist.mockRejectedValue(new Error('Nope'))
    render(<PlaylistPage id="pl1" />)
    await screen.findByRole('heading', { name: 'Road trip' })
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await userEvent.click(screen.getAllByRole('button', { name: 'Move Title t0 down' })[0]!)
    await waitFor(() => expect(toastText()).toContain('Nope'))
    expect((resources.peek('playlist:pl1') as PlaylistDetail).tracks.map((t) => t.entryId)).toEqual(['e1', 'e2', 'e3'])
  })

  it('plays the chosen occurrence by its index', async () => {
    const { usePlayer } = await import('@/services')
    const playTracks = vi.fn(async () => undefined)
    usePlayer.setState({ playTracks } as never)
    render(<PlaylistPage id="pl1" />)
    await screen.findByRole('heading', { name: 'Road trip' })
    await userEvent.click(screen.getAllByRole('button', { name: 'Play Title t0' })[1]!)
    expect(playTracks).toHaveBeenCalledWith(expect.any(Array), 2, expect.objectContaining({ type: 'playlist', id: 'pl1' }))
    expect((playTracks.mock.calls[0] as unknown[])[0]).toHaveLength(3)
  })
})

describe('Playlist page on a server without entry ids (legacy)', () => {
  beforeEach(() => {
    h.api.playlist.mockResolvedValue(detail({ tracks: [track('t0'), track('t1'), track('t0')] }))
  })

  it('removes every copy of the song with the legacy endpoint', async () => {
    h.api.removeFromPlaylist.mockResolvedValue(undefined)
    render(<PlaylistPage id="pl1" />)
    await screen.findByRole('heading', { name: 'Road trip' })
    await userEvent.click(screen.getAllByRole('button', { name: 'More options for Title t0' })[1]!)
    await userEvent.click(screen.getByRole('menuitem', { name: 'Remove from this playlist' }))
    expect(h.api.removeFromPlaylist).toHaveBeenCalledWith('pl1', 't0')
    expect(h.api.removePlaylistEntry).not.toHaveBeenCalled()
    expect(titles()).toEqual(['Title t1'])
  })

  it('reorders with song ids only (no entry ids to send)', async () => {
    h.api.reorderPlaylist.mockImplementation(reorderEcho)
    render(<PlaylistPage id="pl1" />)
    await screen.findByRole('heading', { name: 'Road trip' })
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const list = screen.getByRole('list', { name: 'Edit playlist songs' })
    await userEvent.click(within(list).getAllByRole('button', { name: 'Move Title t0 up' })[1]!)
    const order = h.api.reorderPlaylist.mock.calls[0]![1] as Order
    expect(orderIds(order)).toEqual(['t0', 't0', 't1'])
    expect(entryOrder(order).every((e) => e === undefined)).toBe(true)
    expect(within(list).getAllByRole('listitem').map((li) => /Title t\d/.exec(li.textContent ?? '')![0])).toEqual(['Title t0', 'Title t0', 'Title t1'])
  })
})

describe('Library create', () => {
  it('offers a New playlist tile that creates and opens the playlist', async () => {
    h.api.libraryPlaylists.mockResolvedValue(page([pl('a', true)]))
    h.api.createPlaylist.mockResolvedValue({ ...pl('n1', true), name: 'Mine', tracks: [] })
    render(<LibraryPage tab="playlists" />)
    await userEvent.click(await screen.findByRole('button', { name: /New playlist/ }))
    const dialog = screen.getByRole('dialog', { name: 'New playlist' })
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Mine')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(useNav.getState().route).toEqual({ name: 'playlist', id: 'n1' }))
    expect(h.api.createPlaylist).toHaveBeenCalledWith({ name: 'Mine' })
    expect(resources.peek('playlist:n1')).toMatchObject({ id: 'n1' })
  })

  it('validates the name length limit', async () => {
    h.api.libraryPlaylists.mockResolvedValue(page([]))
    render(<LibraryPage tab="playlists" />)
    await userEvent.click(await screen.findByRole('button', { name: 'New playlist' }))
    const input = within(screen.getByRole('dialog')).getByLabelText('Name')
    expect(input).toHaveAttribute('maxLength', '100')
    await userEvent.type(input, '   ')
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create' })).toBeDisabled()
  })
})

describe('capability gating (server without capabilities.playlists)', () => {
  beforeEach(() => setCapable(false))

  it('hides the Library create tile and empty-state CTA', async () => {
    h.api.libraryPlaylists.mockResolvedValue(page([pl('a', true)]))
    const { unmount } = render(<LibraryPage tab="playlists" />)
    await screen.findByText('List a')
    expect(screen.queryByRole('button', { name: /New playlist/ })).toBeNull()
    unmount()
    h.api.libraryPlaylists.mockResolvedValue(page([]))
    render(<LibraryPage tab="playlists" />)
    await screen.findByText('No playlists yet')
    expect(screen.queryByRole('button', { name: /New playlist/ })).toBeNull()
  })

  it('hides every edit action on an editable playlist and the row menu entries', async () => {
    h.api.playlist.mockResolvedValue(detail())
    render(<PlaylistPage id="pl1" />)
    await screen.findByRole('heading', { name: 'Road trip' })
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Playlist options' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add to playlist' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'More options for Title t1' }))
    expect(screen.queryByRole('menuitem', { name: 'Add to playlist…' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Remove from this playlist' })).toBeNull()
  })

  it('never renders the picker', () => {
    act(() => usePlaylistUi.getState().openPicker([track('t1')]))
    render(<PlaylistPickerHost />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
