import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SpotifyImport, SpotifyPlaylist } from '@/api/types'
import { ApiError } from '@/api/errors'
import { useSession } from '@/services'
import { resources } from '@/lib/resource'
import { useUi } from '@/store/ui'
import { useNav } from '@/store/nav'
import { SpotifyImportDialog, SpotifyImports, SpotifyImportsHost, SpotifySettings, useSpotify } from '@/components/Spotify'
import { LibraryPage } from '@/pages/Library'
import { SettingsPage } from '@/pages/Settings'

const h = vi.hoisted(() => ({
  api: {
    libraryPlaylists: vi.fn(),
    spotifyStatus: vi.fn(),
    spotifyAuthorize: vi.fn(),
    spotifyDisconnect: vi.fn(),
    spotifyPlaylists: vi.fn(),
    spotifyStartImport: vi.fn(),
    spotifyImports: vi.fn(),
    spotifyImport: vi.fn(),
    spotifyCancelImport: vi.fn()
  },
  openExternal: vi.fn()
}))

vi.mock('@/services', async () => {
  const { create } = await import('zustand')
  const useSession = create(() => ({
    status: 'signedIn',
    session: { serverUrl: 'https://music.example.com', user: { id: 'u1', username: 'demo', displayName: 'Demo' } },
    server: { name: 'x', version: '1', apiVersion: 1, capabilities: { playlists: true, spotifyImport: true } } as unknown,
    lastServerUrl: '',
    logout: async () => undefined
  }))
  const usePlayer = create(() => ({
    queue: { items: [], index: -1, shuffle: false, repeat: 'off', context: null },
    status: 'idle',
    toggle: () => undefined,
    playTracks: async () => undefined
  }))
  const { connectMocks } = await import('../helpers/services-mock')
  return {
    api: h.api,
    platform: { kind: 'web', hostedOrigin: null, openExternal: h.openExternal, secureAtRest: async () => false, window: null },
    getEngine: () => null,
    useSession,
    usePlayer,
    ...connectMocks(usePlayer)
  }
})

const ID = '37i9dQZF1DXcBWIGoYBM5M'
const sp = (id: string, name: string, trackCount = 10, over: Partial<SpotifyPlaylist> = {}): SpotifyPlaylist => ({ id, name, trackCount, ...over })
const PLAYLISTS = [sp('a'.repeat(22), 'Favs 2.0', 230, { owner: 'Alex' }), sp('b'.repeat(22), 'Gym Rotation', 25)]
const imp = (over: Partial<SpotifyImport> = {}): SpotifyImport => ({
  id: 'i1',
  status: 'matching',
  spotifyPlaylist: { id: ID, name: 'Favs 2.0' },
  total: 100,
  matched: 40,
  downloaded: 10,
  failed: 2,
  pending: 48,
  failures: [
    { title: 'Lost Song', artists: 'Nobody', reason: 'Not found' },
    { title: 'Other Song', artists: 'Someone', reason: 'Not found' }
  ],
  createdAt: '2026-01-01T00:00:00Z',
  ...over
})

function setCaps(caps: Record<string, unknown>): void {
  useSession.setState({ server: { name: 'x', version: '1', apiVersion: 1, capabilities: caps } } as never)
}

const toastText = (): string[] => useUi.getState().toasts.map((t) => t.message)
const connected = { configured: true, connected: true, account: { id: 'alex', displayName: 'Alex' }, expiresAt: new Date(Date.now() + 100 * 86_400_000).toISOString() }

beforeEach(() => {
  Element.prototype.scrollTo = function scrollTo(): void {} as never
  Object.values(h.api).forEach((f) => f.mockReset())
  h.openExternal.mockReset().mockResolvedValue(undefined)
  h.api.libraryPlaylists.mockResolvedValue({ items: [], offset: 0, limit: 50, total: 0 })
  h.api.spotifyImports.mockResolvedValue([])
  resources.clear()
  setCaps({ playlists: true, spotifyImport: true })
  useSpotify.getState().reset()
  useUi.setState({ toasts: [] })
  useNav.getState().reset()
  globalThis.IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] {
      return []
    }
  } as never
})

describe('capability gating', () => {
  it('shows the Library entry points only when the server advertises spotifyImport', async () => {
    h.api.libraryPlaylists.mockResolvedValue({ items: [{ id: 'p1', name: 'Mine', artwork: [] }], offset: 0, limit: 50, total: 1 })
    const { unmount } = render(<LibraryPage tab="playlists" />)
    expect(await screen.findByRole('button', { name: /Import from Spotify/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /New playlist/ })).toBeInTheDocument()
    unmount()

    setCaps({ playlists: true })
    render(<LibraryPage tab="playlists" />)
    expect(await screen.findByRole('button', { name: /New playlist/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Import from Spotify/ })).toBeNull()
  })

  it('offers the import in the empty Library state', async () => {
    setCaps({ spotifyImport: true })
    render(<LibraryPage tab="playlists" />)
    await userEvent.click(await screen.findByRole('button', { name: /Import from Spotify/ }))
    expect(screen.getByRole('dialog', { name: 'Import from Spotify' })).toBeInTheDocument()
  })

  it('shows the Settings section only when supported', async () => {
    h.api.spotifyStatus.mockResolvedValue({ configured: true, connected: false })
    const { unmount } = render(<SettingsPage />)
    expect(screen.getByRole('heading', { name: 'Spotify' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Connect Spotify' })).toBeInTheDocument()
    unmount()
    setCaps({})
    render(<SettingsPage />)
    expect(screen.queryByRole('heading', { name: 'Spotify' })).toBeNull()
  })

  it('the host does nothing without the capability', async () => {
    setCaps({})
    render(<SpotifyImportsHost />)
    await act(async () => undefined)
    expect(h.api.spotifyImports).not.toHaveBeenCalled()
  })
})

describe('import dialog', () => {
  it('explains, connects externally and re-checks on focus and via "I\'ve connected"', async () => {
    h.api.spotifyStatus.mockResolvedValue({ configured: true, connected: false })
    h.api.spotifyAuthorize.mockResolvedValue({ url: 'https://accounts.spotify.com/authorize?state=1' })
    render(<SpotifyImportDialog onClose={() => undefined} />)
    const dialog = screen.getByRole('dialog', { name: 'Import from Spotify' })
    expect(await within(dialog).findByText('Connect your Spotify account')).toBeInTheDocument()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Connect Spotify' }))
    await waitFor(() => expect(h.openExternal).toHaveBeenCalledWith('https://accounts.spotify.com/authorize?state=1'))
    expect(within(dialog).getByRole('link', { name: 'Open the Spotify sign-in page' })).toBeInTheDocument()

    const before = h.api.spotifyStatus.mock.calls.length
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(h.api.spotifyStatus.mock.calls.length).toBe(before + 1))

    h.api.spotifyPlaylists.mockResolvedValue(PLAYLISTS)
    h.api.spotifyStatus.mockResolvedValue(connected)
    await userEvent.click(within(dialog).getByRole('button', { name: "I've connected" }))
    const picker = await screen.findByRole('dialog', { name: 'Import from Spotify' })
    expect(await within(picker).findByRole('radio', { name: /Favs 2.0/ })).toBeInTheDocument()
    expect(within(picker).getByText('Connected as Alex')).toBeInTheDocument()
  })

  it('shows the authorize error', async () => {
    h.api.spotifyStatus.mockResolvedValue({ configured: true, connected: false })
    h.api.spotifyAuthorize.mockRejectedValue(new ApiError('server', 'Spotify is unavailable'))
    render(<SpotifyImportDialog onClose={() => undefined} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Connect Spotify' }))
    expect(await screen.findByText('Spotify is unavailable')).toBeInTheDocument()
    expect(h.openExternal).not.toHaveBeenCalled()
  })

  it('says when the server is not configured for Spotify', async () => {
    h.api.spotifyStatus.mockResolvedValue({ configured: false, connected: false })
    render(<SpotifyImportDialog onClose={() => undefined} />)
    expect(await screen.findByText(/isn't set up on this server/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Connect Spotify' })).toBeNull()
  })

  it('lists, searches and imports a chosen playlist (download on by default)', async () => {
    h.api.spotifyStatus.mockResolvedValue(connected)
    h.api.spotifyPlaylists.mockResolvedValue(PLAYLISTS)
    h.api.spotifyStartImport.mockResolvedValue(imp({ status: 'queued', total: 0, matched: 0, downloaded: 0, failed: 0, pending: 0, failures: [] }))
    const onClose = vi.fn()
    const onStarted = vi.fn()
    render(<SpotifyImportDialog onClose={onClose} onStarted={onStarted} />)
    const favs = await screen.findByRole('radio', { name: /Favs 2.0/ })
    expect(within(favs).getByText(/230 songs • Alex/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start import' })).toBeDisabled()

    await userEvent.type(screen.getByLabelText('Search your Spotify playlists'), 'gym')
    expect(screen.queryByRole('radio', { name: /Favs 2.0/ })).toBeNull()
    await userEvent.click(screen.getByRole('radio', { name: /Gym Rotation/ }))
    expect(screen.getByRole('radio', { name: /Gym Rotation/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('switch', { name: /Download missing songs/ })).toHaveAttribute('aria-checked', 'true')

    await userEvent.click(screen.getByRole('button', { name: 'Start import' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(h.api.spotifyStartImport).toHaveBeenCalledWith({ playlist: 'b'.repeat(22), download: true })
    expect(onStarted).toHaveBeenCalled()
    expect(toastText()).toContain("Importing 'Favs 2.0'…")
    expect(useSpotify.getState().imports).toHaveLength(1)
  })

  it('imports a pasted link with downloads turned off', async () => {
    h.api.spotifyStatus.mockResolvedValue(connected)
    h.api.spotifyPlaylists.mockResolvedValue(PLAYLISTS)
    h.api.spotifyStartImport.mockResolvedValue(imp({ status: 'queued' }))
    render(<SpotifyImportDialog onClose={() => undefined} />)
    await screen.findByRole('radio', { name: /Favs 2.0/ })
    const field = screen.getByLabelText('Paste a Spotify playlist link')

    await userEvent.type(field, 'https://example.com/nope')
    fireEvent.blur(field)
    expect(screen.getByText("That doesn't look like a Spotify playlist link.")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start import' })).toBeDisabled()

    await userEvent.clear(field)
    await userEvent.type(field, `https://open.spotify.com/playlist/${ID}?si=1`)
    await userEvent.click(screen.getByRole('switch', { name: /Download missing songs/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Start import' }))
    await waitFor(() => expect(h.api.spotifyStartImport).toHaveBeenCalledWith({ playlist: ID, download: false }))
  })

  it('shows the server error (e.g. 409) and stays open', async () => {
    h.api.spotifyStatus.mockResolvedValue(connected)
    h.api.spotifyPlaylists.mockResolvedValue(PLAYLISTS)
    h.api.spotifyStartImport.mockRejectedValue(ApiError.fromStatus(409, 'That playlist is already being imported.'))
    const onClose = vi.fn()
    render(<SpotifyImportDialog onClose={onClose} />)
    await userEvent.click(await screen.findByRole('radio', { name: /Favs 2.0/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Start import' }))
    expect(await screen.findByText('That playlist is already being imported.')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('progress', () => {
  it('renders progress, counts, cancel and failures for an active import', async () => {
    useSpotify.setState({ imports: [imp({ playlistId: 'pl1' })] })
    render(<SpotifyImports />)
    const section = screen.getByRole('region', { name: /Spotify imports/ })
    expect(within(section).getByText('1 running')).toBeInTheDocument()
    expect(within(section).getByRole('progressbar', { name: 'Favs 2.0 import progress' })).toHaveAttribute('aria-valuenow', '50')
    expect(within(section).getByText(/50 of 100 songs • 40 already in library • 10 downloaded • 2 not found • 48 to go/)).toBeInTheDocument()
    expect(within(section).getByText('Matching songs')).toBeInTheDocument()

    await userEvent.click(within(section).getByRole('button', { name: 'Open playlist' }))
    expect(useNav.getState().route).toEqual({ name: 'playlist', id: 'pl1' })

    const toggle = within(section).getByRole('button', { name: 'Show 2 not found' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(toggle)
    expect(within(section).getByRole('list', { name: 'Songs not imported from Favs 2.0' })).toHaveTextContent('Lost Song')

    h.api.spotifyCancelImport.mockResolvedValue(undefined)
    h.api.spotifyImport.mockResolvedValue(imp({ status: 'cancelled', playlistId: 'pl1' }))
    await userEvent.click(within(section).getByRole('button', { name: 'Cancel' }))
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Cancel import?' })).getByRole('button', { name: 'Cancel import' }))
    await waitFor(() => expect(h.api.spotifyCancelImport).toHaveBeenCalledWith('i1'))
    await waitFor(() => expect(within(section).getByText('Cancelled')).toBeInTheDocument())
    expect(within(section).queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  it('shows an indeterminate bar while the playlist is being read and hides when there are no imports', () => {
    const { rerender } = render(<SpotifyImports />)
    expect(screen.queryByRole('region')).toBeNull()
    useSpotify.setState({ imports: [imp({ status: 'reading', total: 0, matched: 0, downloaded: 0, failed: 0, pending: 0, failures: [] })] })
    rerender(<SpotifyImports />)
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
    expect(screen.getByText('Counting songs…')).toBeInTheDocument()
  })

  it('collapses old finished imports and expands on demand', async () => {
    useSpotify.setState({
      imports: [1, 2, 3, 4].map((n) => imp({ id: `i${n}`, status: 'done', pending: 0, finishedAt: '2020-01-01T00:00:00Z', spotifyPlaylist: { id: `s${n}`, name: `List ${n}` } }))
    })
    render(<SpotifyImports />)
    const header = screen.getByRole('button', { name: /Spotify imports/ })
    expect(header).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(header)
    expect(screen.getAllByRole('progressbar')).toHaveLength(3)
    await userEvent.click(screen.getByRole('button', { name: 'Show all 4' }))
    expect(screen.getAllByRole('progressbar')).toHaveLength(4)
  })

  it('the host loads imports and toasts when a watched import finishes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      h.api.spotifyImports.mockResolvedValue([imp()])
      h.api.spotifyImport.mockResolvedValue(imp({ status: 'done', matched: 218, downloaded: 12, failed: 12, total: 242, pending: 0 }))
      render(<SpotifyImportsHost />)
      await waitFor(() => expect(useSpotify.getState().imports).toHaveLength(1))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100)
      })
      await waitFor(() => expect(toastText()).toContain("Imported 'Favs 2.0': 230 songs, 12 not found"))
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('settings', () => {
  it('shows the account, expiry and disconnects after confirming', async () => {
    h.api.spotifyStatus.mockResolvedValue({ ...connected, expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString() })
    h.api.spotifyDisconnect.mockResolvedValue(undefined)
    render(<SpotifySettings />)
    expect(await screen.findByText('Connected as Alex')).toBeInTheDocument()
    expect(screen.getByText(/expires on .* \(3 days left\)/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Disconnect Spotify?' })).getByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(h.api.spotifyDisconnect).toHaveBeenCalled())
    expect(await screen.findByRole('button', { name: 'Connect Spotify' })).toBeInTheDocument()
    expect(toastText()).toContain('Spotify disconnected')
  })

  it('shows how long a fresh connection lasts', async () => {
    h.api.spotifyStatus.mockResolvedValue(connected)
    render(<SpotifySettings />)
    expect(await screen.findByText(/connections last about 6 months/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull()
  })
})
