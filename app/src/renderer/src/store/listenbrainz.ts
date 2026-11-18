import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { ListenBrainzStatus } from '../api/types'
import { describeError } from '../api/errors'

/** The slice of ApiClient this store uses. */
export interface ListenBrainzApi {
  listenBrainzStatus(signal?: AbortSignal): Promise<ListenBrainzStatus>
  listenBrainzTest(token?: string): Promise<{ valid: boolean; userName: string | null }>
  listenBrainzConnect(token: string): Promise<ListenBrainzStatus>
  listenBrainzSettings(patch: { enabled?: boolean; nowPlaying?: boolean }): Promise<ListenBrainzStatus>
  listenBrainzDisconnect(): Promise<void>
}

export interface ListenBrainzState {
  status: ListenBrainzStatus | null
  loading: boolean
  error: string | null
  load(): Promise<void>
  /** Resolves with the account name when the token is valid, null when ListenBrainz rejects it. */
  test(token?: string): Promise<string | null>
  /** Saves a token (validated server-side). Throws on failure. */
  connect(token: string): Promise<void>
  setEnabled(enabled: boolean): Promise<void>
  setNowPlaying(nowPlaying: boolean): Promise<void>
  disconnect(): Promise<void>
  reset(): void
}

export function createListenBrainzStore(api: ListenBrainzApi): UseBoundStore<StoreApi<ListenBrainzState>> {
  return create<ListenBrainzState>((set) => ({
    status: null,
    loading: false,
    error: null,
    async load() {
      set({ loading: true, error: null })
      try {
        set({ status: await api.listenBrainzStatus(), loading: false })
      } catch (err) {
        set({ loading: false, error: describeError(err) })
      }
    },
    async test(token) {
      const r = await api.listenBrainzTest(token)
      return r.valid ? (r.userName ?? '') : null
    },
    async connect(token) {
      set({ status: await api.listenBrainzConnect(token.trim()), error: null })
    },
    async setEnabled(enabled) {
      set({ status: await api.listenBrainzSettings({ enabled }) })
    },
    async setNowPlaying(nowPlaying) {
      set({ status: await api.listenBrainzSettings({ nowPlaying }) })
    },
    async disconnect() {
      await api.listenBrainzDisconnect()
      set({ status: { connected: false, enabled: false, nowPlaying: false, userName: null, pending: 0, lastError: null } })
    },
    reset() {
      set({ status: null, loading: false, error: null })
    }
  }))
}
