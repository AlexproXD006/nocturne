import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OfflineBanner } from '@/components/OfflineBanner'
import { DownloadButton, statusOf } from '@/components/DownloadButton'
import { TrackList } from '@/components/TrackList'
import { useConnectivity, useOffline } from '@/services'
import { useUi } from '@/store/ui'
import { track } from '../helpers/fixtures'

const h = vi.hoisted(() => ({ played: vi.fn(), download: vi.fn(async () => undefined), downloadCollection: vi.fn(async () => undefined), removeCollection: vi.fn(async () => undefined) }))

vi.mock('@/services', async () => {
  const { create } = await import('zustand')
  const { offlineMocks } = await import('../helpers/services-mock')
  const base = offlineMocks()
  const useSession = create(() => ({ status: 'signedIn', session: { user: { id: 'u1' } }, server: { capabilities: { playlists: true } } as unknown }))
  const usePlayer = create(() => ({ queue: { items: [], index: -1, context: null }, status: 'idle' }))
  return {
    ...base,
    api: {},
    platform: {},
    getEngine: () => null,
    useSession,
    usePlayer,
    playback: { toggle: vi.fn(), playTracks: h.played, addToQueue: vi.fn(() => null), addNext: vi.fn() }
  }
})
vi.mock('@/hooks/useNowPlaying', () => ({ useNowTrack: () => null, useNowContext: () => null, useNowPlaying: () => false }))

const list = [track('a', { title: 'Alfa' }), track('b', { title: 'Beta' }), track('c', { title: 'Gamma' })]
const ctx = { type: 'playlist', id: 'p', name: 'P' } as const
const row = (title: string): HTMLElement => screen.getByText(title).closest('[role=row]') as HTMLElement

beforeEach(() => {
  h.played.mockClear()
  useUi.setState({ toasts: [] })
  act(() => {
    useConnectivity.setState({ online: true })
    useOffline.setState({ available: {}, transfers: {}, collections: {}, downloadTracks: h.download, downloadCollection: h.downloadCollection, removeCollection: h.removeCollection } as never)
  })
})

describe('offline banner', () => {
  it('appears only while offline, with the Spanish-ready copy key', () => {
    const { rerender } = render(<OfflineBanner />)
    expect(screen.queryByTestId('offline-banner')).toBeNull()
    act(() => useConnectivity.setState({ online: false }))
    rerender(<OfflineBanner />)
    expect(screen.getByTestId('offline-banner').textContent).toContain('No connection · Showing what is available')
  })
})

describe('track rows offline', () => {
  it('badges stored tracks and greys out the rest when offline; unavailable rows do not play', async () => {
    act(() => {
      useConnectivity.setState({ online: false })
      useOffline.setState({ available: { b: 'pinned' } } as never)
    })
    render(<TrackList tracks={list} context={ctx} />)
    expect(within(row('Beta')).getByRole('img', { name: 'Available offline' })).toBeTruthy()
    expect(row('Alfa').className).toContain('opacity-40')
    expect(row('Beta').className).not.toContain('opacity-40')
    fireEvent.doubleClick(row('Alfa'))
    expect(h.played).not.toHaveBeenCalled()
    expect(useUi.getState().toasts[0]?.message).toBe('"Alfa" is not available offline')
    fireEvent.doubleClick(row('Beta'))
    expect(h.played).toHaveBeenCalledTimes(1)
  })

  it('online: nothing is greyed, stored tracks still show the badge', () => {
    act(() => useOffline.setState({ available: { c: 'auto' } } as never))
    render(<TrackList tracks={list} context={ctx} />)
    expect(row('Alfa').className).not.toContain('opacity-40')
    expect(within(row('Gamma')).getByRole('img', { name: 'Available offline' })).toBeTruthy()
  })

  it('the "Available offline" filter shows only stored tracks', async () => {
    const user = userEvent.setup()
    act(() => useOffline.setState({ available: { a: 'pinned', c: 'auto' } } as never))
    render(<TrackList tracks={list} context={ctx} searchable />)
    await user.click(screen.getByRole('button', { name: /Available offline/ }))
    const rows = screen.getAllByRole('row').filter((r) => r.getAttribute('tabindex') === '0')
    expect(rows.map((r) => within(r).getByText(/Alfa|Gamma|Beta/).textContent)).toEqual(['Alfa', 'Gamma'])
    await user.click(screen.getByRole('button', { name: /Available offline/ }))
    expect(screen.getAllByRole('row').filter((r) => r.getAttribute('tabindex') === '0')).toHaveLength(3)
  })

  it('the row menu offers Download', async () => {
    const user = userEvent.setup()
    render(<TrackList tracks={list} context={ctx} />)
    await user.click(screen.getAllByRole('button', { name: /More options|More/i })[0]!)
    await user.click(screen.getByRole('menuitem', { name: 'Download' }))
    expect(h.download).toHaveBeenCalledWith([list[0]])
  })
})

describe('download button', () => {
  it('statusOf: none -> downloading (n/total) -> downloaded', () => {
    expect(statusOf(['a', 'b'], {}, {}).state).toBe('none')
    expect(statusOf(['a', 'b'], { a: 'pinned' }, { b: { percent: 50, state: 'active' } })).toEqual({ state: 'downloading', done: 1, total: 2, percent: 75 })
    expect(statusOf(['a', 'b'], { a: 'pinned', b: 'pinned' }, {})).toMatchObject({ state: 'downloaded', percent: 100 })
    expect(statusOf([], {}, {}).state).toBe('none')
  })

  it('downloads a collection on tap, shows progress, and asks before removing', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<DownloadButton tracks={list} collection={{ kind: 'playlist', id: 'p', name: 'Mi lista' }} />)
    await user.click(screen.getByRole('button', { name: 'Download' }))
    expect(h.downloadCollection).toHaveBeenCalledWith('playlist', 'p', 'Mi lista', list)
    act(() =>
      useOffline.setState({
        available: { a: 'pinned' },
        transfers: { b: { state: 'active', bytes: 1, total: 2, percent: 50 } },
        collections: { 'playlist:p': { key: 'playlist:p', kind: 'playlist', id: 'p', name: 'Mi lista', trackIds: ['a', 'b', 'c'], syncedAt: 0 } }
      } as never)
    )
    rerender(<DownloadButton tracks={list} collection={{ kind: 'playlist', id: 'p', name: 'Mi lista' }} />)
    expect(screen.getByRole('button', { name: 'Downloading 1/3' })).toBeTruthy()
    act(() =>
      useOffline.setState({ available: { a: 'pinned', b: 'pinned', c: 'pinned' }, transfers: {} } as never)
    )
    rerender(<DownloadButton tracks={list} collection={{ kind: 'playlist', id: 'p', name: 'Mi lista' }} />)
    await user.click(screen.getByRole('button', { name: 'Downloaded' }))
    await user.click(screen.getByRole('button', { name: 'Remove download' }))
    expect(h.removeCollection).toHaveBeenCalledWith('playlist:p')
  })
})
