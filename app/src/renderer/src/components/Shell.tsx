import { useEffect, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, Copy, Heart, Home, Library, LogOut, Minus, Search, Settings, ShieldCheck, Square, X } from 'lucide-react'
import { api, platform, useSession } from '../services'
import { isAdmin } from '../store/session'
import { useNav, type Route } from '../store/nav'
import { useUi } from '../store/ui'
import { useResource } from '../hooks/useResource'
import type { WindowState } from '../platform'
import { Artwork, IconButton, cx } from './common'
import { Menu, useMenu } from './Menu'

export function Logo({ className }: { className?: string }): ReactNode {
  return <img src="./icon.svg" alt="" className={cx('h-7 w-7', className)} draggable={false} />
}

/** Custom frameless title bar (desktop only). */
export function TitleBar(): ReactNode {
  const win = platform.window
  const [state, setState] = useState<WindowState>({ maximized: false, fullscreen: false, focused: true })
  useEffect(() => win?.onState(setState), [win])
  if (!win || state.fullscreen) return null
  return (
    <div className={cx('app-chrome drag flex h-9 shrink-0 items-center justify-between bg-ink-950 pl-4 text-xs', !state.focused && 'opacity-70')}>
      <div className="flex items-center gap-2 text-fg-subtle">
        <Logo className="h-4 w-4" />
        <span className="font-semibold tracking-wide">Nocturne</span>
      </div>
      <div className="no-drag flex h-full">
        <button aria-label="Minimize" onClick={() => void win.minimize()} className="flex h-full w-12 items-center justify-center text-fg-muted hover:bg-white/8 hover:text-fg">
          <Minus className="h-4 w-4" />
        </button>
        <button aria-label={state.maximized ? 'Restore' : 'Maximize'} onClick={() => void win.toggleMaximize()} className="flex h-full w-12 items-center justify-center text-fg-muted hover:bg-white/8 hover:text-fg">
          {state.maximized ? <Copy className="h-3.5 w-3.5 -scale-x-100" /> : <Square className="h-3.5 w-3.5" />}
        </button>
        <button aria-label="Close" onClick={() => void win.close()} className="flex h-full w-12 items-center justify-center text-fg-muted hover:bg-[#e81123] hover:text-white">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

const NAV: { route: Route; label: string; icon: typeof Home }[] = [
  { route: { name: 'home' }, label: 'Home', icon: Home },
  { route: { name: 'search' }, label: 'Search', icon: Search },
  { route: { name: 'library' }, label: 'Your Library', icon: Library }
]

const ADMIN_NAV: { route: Route; label: string; icon: typeof Home } = { route: { name: 'admin' }, label: 'Admin', icon: ShieldCheck }

function isActive(current: Route, target: Route): boolean {
  if (target.name === 'library') return ['library', 'liked'].includes(current.name)
  return current.name === target.name
}

export function Sidebar(): ReactNode {
  const route = useNav((s) => s.route)
  const go = useNav((s) => s.go)
  const admin = useSession(isAdmin)
  const items = admin ? [...NAV, ADMIN_NAV] : NAV
  const playlists = useResource('library:playlists:sidebar', (signal) => api.libraryPlaylists(0, 50, signal))
  return (
    <aside className="hidden w-[248px] shrink-0 flex-col gap-2 p-2 pr-0 md:flex" aria-label="Main navigation">
      <nav className="rounded-2xl bg-ink-900 p-3">
        <div className="mb-3 flex items-center gap-2.5 px-2 pt-1">
          <Logo />
          <span className="text-lg font-bold tracking-tight">Nocturne</span>
        </div>
        {items.map(({ route: r, label, icon: Icon }) => {
          const active = isActive(route, r)
          return (
            <button
              key={label}
              onClick={() => go(r)}
              aria-current={active ? 'page' : undefined}
              className={cx(
                'flex w-full items-center gap-4 rounded-lg px-3 py-2.5 text-[15px] font-semibold transition-colors',
                active ? 'text-fg' : 'text-fg-muted hover:text-fg'
              )}
            >
              <Icon className="h-[22px] w-[22px]" strokeWidth={active ? 2.4 : 1.9} />
              {label}
            </button>
          )
        })}
      </nav>
      <div className="flex min-h-0 flex-1 flex-col rounded-2xl bg-ink-900 py-3">
        <p className="px-5 pb-2 text-xs font-semibold tracking-wide text-fg-subtle uppercase">Playlists</p>
        <div className="min-h-0 flex-1 overflow-y-auto px-2">
          <button
            onClick={() => go({ name: 'liked' })}
            className={cx('flex w-full items-center gap-3 rounded-lg p-2 text-left hover:bg-white/[0.05]', route.name === 'liked' && 'bg-white/[0.07]')}
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-accent to-[#7b5cff]">
              <Heart className="h-4 w-4 text-white" fill="currentColor" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">Liked Songs</span>
              <span className="block truncate text-xs text-fg-muted">Playlist</span>
            </span>
          </button>
          {playlists.data?.items.map((p) => (
            <button
              key={p.id}
              onClick={() => go({ name: 'playlist', id: p.id })}
              className={cx(
                'flex w-full items-center gap-3 rounded-lg p-2 text-left hover:bg-white/[0.05]',
                route.name === 'playlist' && route.id === p.id && 'bg-white/[0.07]'
              )}
            >
              <Artwork images={p.artwork} size={40} className="h-10 w-10 shrink-0" rounded="rounded-md" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{p.name}</span>
                <span className="block truncate text-xs text-fg-muted">{p.owner?.name ?? 'Playlist'}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </aside>
  )
}

/** Sticky header inside the content column: history arrows + account menu. */
export function TopBar({ children, solid }: { children?: ReactNode; solid?: boolean }): ReactNode {
  const { canBack, canForward, back, forward, go } = useNav()
  const user = useSession((s) => s.session?.user)
  const logout = useSession((s) => s.logout)
  const admin = useSession(isAdmin)
  const { menu, open, close } = useMenu()
  return (
    <div className={cx('safe-top sticky top-0 z-20 flex min-h-16 items-center gap-3 px-4 transition-colors md:px-6', solid ? 'bg-ink-900/90 backdrop-blur-xl' : 'bg-transparent')}>
      <div className="hidden gap-2 md:flex">
        <IconButton label="Go back" onClick={back} disabled={!canBack} className="bg-black/40">
          <ChevronLeft className="h-5 w-5" />
        </IconButton>
        <IconButton label="Go forward" onClick={forward} disabled={!canForward} className="bg-black/40">
          <ChevronRight className="h-5 w-5" />
        </IconButton>
      </div>
      <div className="min-w-0 flex-1">{children}</div>
      <button
        aria-label="Account"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          open(r.right - 210, r.bottom + 6)
        }}
        className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full bg-black/40 p-0.5 hover:scale-105"
      >
        {user?.avatar?.length ? (
          <Artwork images={user.avatar} size={32} round className="h-8 w-8" />
        ) : (
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-sm font-bold text-ink-950">
            {(user?.displayName || user?.username || '?').slice(0, 1).toUpperCase()}
          </span>
        )}
      </button>
      {menu && (
        <Menu
          x={menu.x}
          y={menu.y}
          onClose={close}
          items={[
            ...(admin ? [{ label: 'Admin', icon: <ShieldCheck />, onSelect: () => go({ name: 'admin' }) }] : []),
            { label: 'Settings', icon: <Settings />, onSelect: () => go({ name: 'settings' }) },
            { label: 'Sign out', icon: <LogOut />, onSelect: () => void logout() }
          ]}
        />
      )}
    </div>
  )
}

/** Bottom tab bar on phones. */
export function MobileNav(): ReactNode {
  const route = useNav((s) => s.route)
  const go = useNav((s) => s.go)
  return (
    <nav className="app-chrome-fade safe-bottom flex shrink-0 justify-around bg-gradient-to-t from-ink-950 via-ink-950/95 to-ink-950/80 pt-1 md:hidden" aria-label="Main navigation">
      {NAV.map(({ route: r, label, icon: Icon }) => {
        const active = isActive(route, r)
        return (
          <button
            key={label}
            onClick={() => go(r)}
            aria-current={active ? 'page' : undefined}
            className={cx('flex flex-1 flex-col items-center gap-1 py-2 text-[11px] font-medium', active ? 'text-fg' : 'text-fg-subtle')}
          >
            <Icon className="h-6 w-6" strokeWidth={active ? 2.4 : 1.8} />
            {label === 'Your Library' ? 'Library' : label}
          </button>
        )
      })}
    </nav>
  )
}

export function Toasts(): ReactNode {
  const toasts = useUi((s) => s.toasts)
  const dismiss = useUi((s) => s.dismissToast)
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-28 z-[90] flex flex-col items-center gap-2 px-4 md:bottom-24" aria-live="polite">
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={cx(
            'fade-up pointer-events-auto max-w-md rounded-lg px-4 py-2.5 text-sm font-medium shadow-2xl shadow-black/50',
            t.tone === 'error' ? 'bg-[#3a1d22] text-[#ffd5d5]' : 'bg-fg text-ink-950'
          )}
        >
          {t.message}
        </button>
      ))}
    </div>
  )
}
