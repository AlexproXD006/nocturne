import { create } from 'zustand'

interface LikesState {
  /** Overrides on top of the `liked` flag the server sends with each track. */
  overrides: Record<string, boolean>
  pending: Record<string, true>
  isLiked(id: string, serverValue?: boolean): boolean
  toggle(id: string, current: boolean, send: (id: string, liked: boolean) => Promise<void>): Promise<boolean>
  reset(): void
}

export const useLikes = create<LikesState>((set, get) => ({
  overrides: {},
  pending: {},
  isLiked(id, serverValue) {
    const o = get().overrides[id]
    return o ?? serverValue === true
  },
  async toggle(id, current, send) {
    if (get().pending[id]) return current
    const next = !current
    set((s) => ({ overrides: { ...s.overrides, [id]: next }, pending: { ...s.pending, [id]: true } }))
    try {
      await send(id, next)
      return next
    } catch (err) {
      set((s) => ({ overrides: { ...s.overrides, [id]: current } }))
      throw err
    } finally {
      set((s) => {
        const pending = { ...s.pending }
        delete pending[id]
        return { pending }
      })
    }
  },
  reset() {
    set({ overrides: {}, pending: {} })
  }
}))
