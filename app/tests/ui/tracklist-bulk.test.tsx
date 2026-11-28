import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TrackList } from '@/components/TrackList'
import { useUi } from '@/store/ui'
import { track } from '../helpers/fixtures'

const h = vi.hoisted(() => ({ played: vi.fn(), queued: vi.fn(() => null), next: vi.fn() }))

vi.mock('@/services', async () => {
  const { create } = await import('zustand')
  const useSession = create(() => ({ status: 'signedIn', session: { user: { id: 'u1' } }, server: { capabilities: { playlists: true } } as unknown }))
  const usePlayer = create(() => ({ queue: { items: [], index: -1, context: null }, status: 'idle' }))
  return {
    api: { setLiked: vi.fn(async () => undefined) },
    platform: {},
    getEngine: () => null,
    useSession,
    usePlayer,
    playback: { toggle: vi.fn(), playTracks: h.played, addToQueue: h.queued, addNext: h.next },
    ...(await import('../helpers/services-mock')).offlineMocks()
  }
})
vi.mock('@/hooks/useNowPlaying', () => ({ useNowTrack: () => null, useNowContext: () => null, useNowPlaying: () => false }))

const list = [
  track('1', { title: 'Árbol', artists: [{ id: 'a1', name: 'Zeta' }] }),
  track('2', { title: 'Bruma', artists: [{ id: 'a2', name: 'Yota' }] }),
  track('3', { title: 'Arena', artists: [{ id: 'a3', name: 'Xi' }] })
]
const ctx = { type: 'playlist', id: 'p', name: 'P' } as const

beforeEach(() => {
  h.played.mockClear()
  h.queued.mockClear()
  useUi.setState({ toasts: [] })
})

describe('TrackList search + bulk', () => {
  it('filters accent/case-insensitively, shows "n de total" and plays the filtered list', async () => {
    const user = userEvent.setup()
    render(<TrackList tracks={list} context={ctx} searchable />)
    await user.click(screen.getByRole('button', { name: 'Search in list' }))
    await user.type(screen.getByRole('searchbox'), 'AR')
    expect(screen.getByText('2 of 3')).toBeTruthy()
    expect(screen.getAllByRole('row').filter((r) => r.getAttribute('tabindex') === '0')).toHaveLength(2)
    fireEvent.doubleClick(screen.getByText('Arena').closest('[role=row]')!)
    expect(h.played).toHaveBeenCalledTimes(1)
    const [played, idx] = h.played.mock.calls[0] as unknown as [{ title: string }[], number]
    expect(played.map((t) => t.title)).toEqual(['Árbol', 'Arena'])
    expect(idx).toBe(1)
  })

  it('"Select all" only selects the filtered rows and the queue action receives them', async () => {
    const user = userEvent.setup()
    render(<TrackList tracks={list} context={ctx} searchable />)
    await user.click(screen.getByRole('button', { name: 'Search in list' }))
    await user.type(screen.getByRole('searchbox'), 'ar')
    await user.click(screen.getByRole('button', { name: 'Select' }))
    await user.click(screen.getByRole('button', { name: 'Select all' }))
    const bar = screen.getByRole('toolbar')
    await user.click(within(bar).getByRole('button', { name: 'Add to queue' }))
    const queued = h.queued.mock.calls[0] as unknown as [{ title: string }[]]
    expect(queued[0].map((t) => t.title)).toEqual(['Árbol', 'Arena'])
    expect(screen.queryByRole('toolbar')).toBeNull()
  })

  it('shift-click selects a range and remove asks for confirmation', async () => {
    const user = userEvent.setup()
    const onRemoveMany = vi.fn(async () => undefined)
    render(<TrackList tracks={list} context={ctx} onRemoveMany={onRemoveMany} />)
    await user.click(screen.getByRole('button', { name: 'Select' }))
    await user.click(screen.getByText('Árbol'))
    await user.keyboard('{Shift>}')
    await user.click(screen.getByText('Arena'))
    await user.keyboard('{/Shift}')
    expect(screen.getAllByRole('checkbox', { checked: true })).toHaveLength(3)
    await user.click(within(screen.getByRole('toolbar')).getByRole('button', { name: 'Remove from this playlist' }))
    await user.click(await screen.findByRole('button', { name: 'Delete' }))
    expect(onRemoveMany).toHaveBeenCalledTimes(1)
    const items = (onRemoveMany.mock.calls[0] as unknown as [{ index: number }[]])[0]
    expect(items.map((i) => i.index)).toEqual([0, 1, 2])
  })

  it('Escape leaves selection mode', async () => {
    const user = userEvent.setup()
    render(<TrackList tracks={list} context={ctx} />)
    await user.click(screen.getByRole('button', { name: 'Select' }))
    await user.click(screen.getByText('Bruma'))
    expect(screen.getByRole('toolbar')).toBeTruthy()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('toolbar')).toBeNull()
  })
})
