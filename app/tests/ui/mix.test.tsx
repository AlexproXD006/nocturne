import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Playlist, PlaylistDetail } from '@/api/types'
import { useSession } from '@/services'
import { resources } from '@/lib/resource'
import { useUi } from '@/store/ui'
import { useNav } from '@/store/nav'
import { MixPage } from '@/pages/Mix'
import { MediaCard } from '@/components/cards'
import { tracks } from '../helpers/fixtures'

const h = vi.hoisted(() => ({
  api: { mix: vi.fn(), createPlaylist: vi.fn(), playlist: vi.fn(), libraryPlaylists: vi.fn(), setLiked: vi.fn() },
  played: vi.fn(),
  queued: vi.fn()
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
    playTracks: h.played,
    addNext: () => undefined,
    addToQueue: h.queued
  }))
  const { connectMocks } = await import('../helpers/services-mock')
  return { api: h.api, platform: {}, getEngine: () => null, useSession, usePlayer, ...connectMocks(usePlayer) }
})

const mix = (over: Partial<PlaylistDetail> = {}): PlaylistDetail => ({
  id: 'daily-1',
  name: 'Mix diario 1',
  description: 'Con A, B y C',
  artwork: [],
  mix: true,
  trackCount: 3,
  tracks: tracks(3),
  ...over
})

beforeEach(() => {
  Element.prototype.scrollTo = function scrollTo(): void {} as never
  Object.values(h.api).forEach((f) => f.mockReset())
  h.played.mockReset()
  h.queued.mockReset()
  resources.clear()
  useUi.setState({ toasts: [] })
  useNav.getState().reset()
  useSession.setState({ server: { name: 'x', version: '1', apiVersion: 1, capabilities: { playlists: true } } } as never)
  globalThis.IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] {
      return []
    }
  } as never
})

describe('Mix page', () => {
  it('shows the mix read-only and plays it with a mix context', async () => {
    h.api.mix.mockResolvedValue(mix())
    render(<MixPage id="daily-1" />)
    expect(await screen.findByRole('heading', { name: 'Mix diario 1' })).toBeInTheDocument()
    expect(screen.getByText('Con A, B y C')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(h.played).toHaveBeenCalled()
    expect(h.played.mock.calls[0]![2]).toMatchObject({ type: 'tracks', id: 'mix:daily-1', name: 'Mix diario 1' })
  })

  it('adds every song to the queue', async () => {
    h.api.mix.mockResolvedValue(mix())
    render(<MixPage id="daily-1" />)
    await screen.findByRole('heading', { name: 'Mix diario 1' })
    await userEvent.click(screen.getByRole('button', { name: 'Add all to queue' }))
    expect(h.queued).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: 't0' })]))
  })

  it('saves the mix as a normal playlist and opens it', async () => {
    h.api.mix.mockResolvedValue(mix())
    h.api.createPlaylist.mockResolvedValue({ ...mix(), id: 'new1', mix: undefined, editable: true })
    render(<MixPage id="daily-1" />)
    await screen.findByRole('heading', { name: 'Mix diario 1' })
    await userEvent.click(screen.getByRole('button', { name: 'Save as playlist' }))
    await waitFor(() => expect(h.api.createPlaylist).toHaveBeenCalledWith({ name: 'Mix diario 1', description: 'Con A, B y C', trackIds: ['t0', 't1', 't2'] }))
    await waitFor(() => expect(useNav.getState().route).toEqual({ name: 'playlist', id: 'new1' }))
    expect(useUi.getState().toasts.map((t) => t.message)).toContain('Saved “Mix diario 1” as a playlist')
  })

  it('hides "Save as playlist" when the server has no playlists', async () => {
    useSession.setState({ server: { name: 'x', version: '1', apiVersion: 1, capabilities: { lyrics: true } } } as never)
    h.api.mix.mockResolvedValue(mix())
    render(<MixPage id="daily-1" />)
    await screen.findByRole('heading', { name: 'Mix diario 1' })
    expect(screen.queryByRole('button', { name: 'Save as playlist' })).toBeNull()
  })

  it('shows an error when the mix cannot be loaded', async () => {
    h.api.mix.mockRejectedValue(new Error('Mix not found.'))
    render(<MixPage id="gone" />)
    expect(await screen.findByText(/not found/i)).toBeInTheDocument()
  })
})

describe('Mix card on Home', () => {
  const card: Playlist = { id: 'daily-2', name: 'Mix diario 2', description: 'Con X y Y', artwork: [], mix: true, trackCount: 40 }

  it('opens the mix route and shows the "Con ..." subtitle', async () => {
    render(<MediaCard card={{ kind: 'playlist', item: card }} />)
    expect(screen.getByText('Con X y Y')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('link'))
    expect(useNav.getState().route).toEqual({ name: 'mix', id: 'daily-2' })
  })

  it('plays through api.mix, not api.playlist', async () => {
    h.api.mix.mockResolvedValue(mix({ id: 'daily-2', name: 'Mix diario 2' }))
    render(<MediaCard card={{ kind: 'playlist', item: card }} />)
    await userEvent.click(screen.getByRole('button', { name: /Mix diario 2/ }))
    await waitFor(() => expect(h.played).toHaveBeenCalled())
    expect(h.api.mix).toHaveBeenCalledWith('daily-2')
    expect(h.api.playlist).not.toHaveBeenCalled()
    expect(h.played.mock.calls[0]![2]).toMatchObject({ type: 'tracks', id: 'mix:daily-2' })
  })

  it('regular playlists still open the playlist route', async () => {
    render(<MediaCard card={{ kind: 'playlist', item: { id: 'p1', name: 'Mine', artwork: [] } }} />)
    await userEvent.click(screen.getByRole('link'))
    expect(useNav.getState().route).toEqual({ name: 'playlist', id: 'p1' })
  })
})
