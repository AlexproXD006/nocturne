import { describe, expect, it, vi } from 'vitest'
import { createListenBrainzStore, type ListenBrainzApi } from '@/store/listenbrainz'
import { ApiError } from '@/api/errors'
import type { ListenBrainzStatus } from '@/api/types'

const st = (over: Partial<ListenBrainzStatus> = {}): ListenBrainzStatus => ({
  connected: true, enabled: true, nowPlaying: false, userName: 'alice', pending: 0, lastError: null, ...over
})

function setup() {
  const api = {
    listenBrainzStatus: vi.fn(async () => st({ connected: false })),
    listenBrainzTest: vi.fn(async (_t?: string) => ({ valid: true, userName: 'alice' as string | null })),
    listenBrainzConnect: vi.fn(async (_t: string) => st()),
    listenBrainzSettings: vi.fn(async (p: { enabled?: boolean; nowPlaying?: boolean }) => st(p)),
    listenBrainzDisconnect: vi.fn(async () => undefined)
  } satisfies ListenBrainzApi
  return { api, store: createListenBrainzStore(api) }
}

describe('listenbrainz store', () => {
  it('loads status and reports errors', async () => {
    const { api, store } = setup()
    await store.getState().load()
    expect(store.getState().status?.connected).toBe(false)
    api.listenBrainzStatus.mockRejectedValueOnce(new ApiError('network', 'down'))
    await store.getState().load()
    expect(store.getState().error).toBeTruthy()
  })
  it('tests tokens: name when valid, null when rejected', async () => {
    const { api, store } = setup()
    expect(await store.getState().test('tok')).toBe('alice')
    api.listenBrainzTest.mockResolvedValueOnce({ valid: false, userName: null })
    expect(await store.getState().test('bad')).toBeNull()
    expect(api.listenBrainzTest).toHaveBeenLastCalledWith('bad')
  })
  it('connects (trimmed), toggles and disconnects', async () => {
    const { api, store } = setup()
    await store.getState().connect('  tok-123  ')
    expect(api.listenBrainzConnect).toHaveBeenCalledWith('tok-123')
    expect(store.getState().status?.connected).toBe(true)
    await store.getState().setEnabled(false)
    expect(store.getState().status?.enabled).toBe(false)
    await store.getState().setNowPlaying(true)
    expect(api.listenBrainzSettings).toHaveBeenLastCalledWith({ nowPlaying: true })
    await store.getState().disconnect()
    expect(store.getState().status?.connected).toBe(false)
    store.getState().reset()
    expect(store.getState().status).toBeNull()
  })
})
