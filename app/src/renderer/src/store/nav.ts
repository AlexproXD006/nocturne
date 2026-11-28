import { create } from 'zustand'

export type Route =
  | { name: 'home' }
  | { name: 'search'; q?: string }
  | { name: 'library'; tab?: LibraryTab }
  | { name: 'album'; id: string }
  | { name: 'artist'; id: string }
  | { name: 'playlist'; id: string }
  | { name: 'mix'; id: string }
  | { name: 'liked' }
  | { name: 'downloads' }
  | { name: 'settings' }
  | { name: 'equalizer' }
  | { name: 'stats' }
  | { name: 'admin'; tab?: AdminTab }

export type LibraryTab = 'playlists' | 'albums' | 'artists' | 'songs'
export type AdminTab = 'overview' | 'add' | 'jobs' | 'library' | 'lyrics' | 'users' | 'backups' | 'diagnostics'

interface NavState {
  stack: Route[]
  index: number
  route: Route
  go(route: Route): void
  replace(route: Route): void
  back(): void
  forward(): void
  canBack: boolean
  canForward: boolean
  reset(): void
}

const MAX = 50
const HOME: Route = { name: 'home' }

function sameRoute(a: Route, b: Route): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function derive(stack: Route[], index: number): Pick<NavState, 'stack' | 'index' | 'route' | 'canBack' | 'canForward'> {
  return { stack, index, route: stack[index]!, canBack: index > 0, canForward: index < stack.length - 1 }
}

export const useNav = create<NavState>((set, get) => ({
  ...derive([HOME], 0),
  go(route) {
    const { stack, index } = get()
    if (sameRoute(stack[index]!, route)) return
    const next = [...stack.slice(0, index + 1), route].slice(-MAX)
    set(derive(next, next.length - 1))
  },
  replace(route) {
    const { stack, index } = get()
    const next = [...stack]
    next[index] = route
    set(derive(next, index))
  },
  back() {
    const { stack, index } = get()
    if (index > 0) set(derive(stack, index - 1))
  },
  forward() {
    const { stack, index } = get()
    if (index < stack.length - 1) set(derive(stack, index + 1))
  },
  reset() {
    set(derive([HOME], 0))
  }
}))
