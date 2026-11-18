import { Component, useEffect, type ErrorInfo, type ReactNode } from 'react'
import { RotateCw, X } from 'lucide-react'
import { t, useT } from './i18n'
import { useSession } from './services'
import { useNav, type Route } from './store/nav'
import { useUi } from './store/ui'
import { useLikes } from './store/likes'
import { accentRgb, useSettings } from './store/settings'
import { resources } from './lib/resource'
import { pickImage } from './lib/url'
import { usePalette } from './hooks/useAccent'
import { useAdaptiveRoot } from './hooks/useAdaptive'
import { FALLBACK_ACCENT, paletteAccent, type Rgb } from './lib/color'
import { useMediaSession } from './hooks/useMediaSession'
import { useShortcuts } from './hooks/useShortcuts'
import { useTheme } from './hooks/useTheme'
import { ErrorState, IconButton, Spinner } from './components/common'
import { FullscreenPlayer } from './components/FullscreenPlayer'
import { LyricsView } from './components/LyricsView'
import { MiniPlayer, PlayerBar } from './components/PlayerBar'
import { DevicesSheet } from './components/Devices'
import { useNowTrack } from './hooks/useNowPlaying'
import { PlaylistPickerHost } from './components/Playlists'
import { SpotifyImportsHost } from './components/Spotify'
import { usePlaylistUi } from './store/playlists'
import { QueuePanel } from './components/QueuePanel'
import { UpdateBanner } from './components/UpdateBanner'
import { AdaptiveBackdrop } from './components/AdaptiveBackdrop'
import { Logo, MobileNav, Sidebar, TitleBar, Toasts } from './components/Shell'
import { AdminPage } from './pages/admin/AdminPage'
import { AlbumPage } from './pages/Album'
import { ArtistPage } from './pages/Artist'
import { HomePage } from './pages/Home'
import { LibraryPage, LikedPage } from './pages/Library'
import { Login } from './pages/Login'
import { PlaylistPage } from './pages/Playlist'
import { SearchPage } from './pages/Search'
import { SettingsPage } from './pages/Settings'
import { StatsPage } from './pages/Stats'

/** Ice blue: Midnight Glass's idle accent before a cover colour is known. */
const GLASS_ACCENT: Rgb = { r: 143, g: 180, b: 255 }

class RouteBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Page crashed', error, info.componentStack)
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <ErrorState message={t('err.pageCrashed')} />
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="-mt-12 inline-flex items-center gap-2 rounded-full bg-white/8 px-4 py-2 text-sm font-medium hover:bg-white/12"
        >
          <RotateCw className="h-4 w-4" /> {t('app.reload')}
        </button>
      </div>
    )
  }
}

function RouteView({ route, index }: { route: Route; index: number }): ReactNode {
  switch (route.name) {
    case 'home':
      return <HomePage />
    case 'search':
      // Keyed by history entry: the page rewrites its own `q` while typing, which must not remount it.
      return <SearchPage key={index} initial={route.q} />
    case 'library':
      return <LibraryPage tab={route.tab} />
    case 'album':
      return <AlbumPage key={route.id} id={route.id} />
    case 'artist':
      return <ArtistPage key={route.id} id={route.id} />
    case 'playlist':
      return <PlaylistPage key={route.id} id={route.id} />
    case 'liked':
      return <LikedPage />
    case 'stats':
      return <StatsPage />
    case 'settings':
      return <SettingsPage />
    case 'admin':
      return <AdminPage />
  }
}

function SidePanel(): ReactNode {
  const t = useT()
  const panel = useUi((s) => s.panel)
  const closePanel = useUi((s) => s.closePanel)
  const track = useNowTrack()
  if (!panel) return null
  return (
    <aside
      aria-label={panel === 'queue' ? t('app.queue') : t('app.lyrics')}
      className="app-main g-side fade-up m-2 ml-0 hidden w-[340px] shrink-0 flex-col overflow-hidden rounded-2xl bg-ink-900 md:flex"
    >
      <div className="flex h-14 shrink-0 items-center justify-between pr-2 pl-5">
        <h2 className="text-base font-bold tracking-tight">{panel === 'queue' ? t('app.queue') : t('app.lyrics')}</h2>
        <IconButton label={t('app.closePanel')} onClick={closePanel} size="sm">
          <X className="h-4 w-4" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1">{panel === 'queue' ? <QueuePanel /> : <LyricsView track={track} />}</div>
    </aside>
  )
}

/**
 * Sole writer of the global accent: the user's fixed preset, or — when the
 * preference is 'adaptive' (default) or the theme is Adaptive — a colour from
 * the current track's artwork. Which one (dominant / vibrant / muted) follows
 * Settings → Adaptive background → Accent source (default: dominant, the
 * original behaviour).
 */
function useGlobalAccent(): void {
  const artwork = useNowTrack()?.artwork
  const palette = usePalette(pickImage(artwork, 120))
  const source = useSettings((s) => s.adaptive.accentSource)
  const glass = useSettings((s) => s.theme === 'glass')
  // Midnight Glass idles on the ice-blue accent until a cover colour is available.
  const accent = paletteAccent(palette, source) ?? (glass ? GLASS_ACCENT : FALLBACK_ACCENT)
  // The Adaptive theme always derives its accent from the cover.
  const fixed = useSettings((s) => (s.theme === 'adaptive' ? null : accentRgb(s.accent)))
  const value = fixed ?? `${accent.r} ${accent.g} ${accent.b}`
  useEffect(() => {
    document.documentElement.style.setProperty('--accent-rgb', value)
  }, [value])
  useEffect(
    () => () => {
      document.documentElement.style.removeProperty('--accent-rgb')
    },
    []
  )
}

function SignedInShell(): ReactNode {
  const route = useNav((s) => s.route)
  const index = useNav((s) => s.index)
  const fullscreen = useUi((s) => s.fullscreen)
  useMediaSession()
  useShortcuts()
  useGlobalAccent()

  return (
    <div className="app-shell relative isolate flex h-full flex-col bg-ink-950">
      <AdaptiveBackdrop />
      <TitleBar />
      <div className="relative z-[1] flex min-h-0 flex-1">
        <Sidebar />
        <main className="app-main m-2 min-w-0 flex-1 overflow-hidden rounded-2xl bg-ink-900 max-md:m-0 max-md:rounded-none">
          <RouteBoundary key={index}>
            <RouteView route={route} index={index} />
          </RouteBoundary>
        </main>
        <SidePanel />
      </div>
      <PlayerBar />
      <div className="md:hidden">
        <MiniPlayer />
        <MobileNav />
      </div>
      {fullscreen && <FullscreenPlayer />}
      <DevicesSheet />
      <PlaylistPickerHost />
      <SpotifyImportsHost />
    </div>
  )
}

function Splash(): ReactNode {
  const t = useT()
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 bg-ink-950" role="status" aria-label={t('app.loading')}>
      <Logo className="h-16 w-16" />
      <Spinner />
    </div>
  )
}

export function App(): ReactNode {
  useT() // re-render the whole tree on language change
  const status = useSession((s) => s.status)

  useTheme()
  useAdaptiveRoot()

  useEffect(() => {
    void useSession.getState().restore()
  }, [])

  // Forget everything that belongs to the previous account.
  useEffect(() => {
    if (status !== 'signedOut') return
    useNav.getState().reset()
    useLikes.getState().reset()
    resources.clear()
    useUi.getState().closePanel()
    useUi.getState().setFullscreen(false)
    usePlaylistUi.getState().closePicker()
  }, [status])

  return (
    <>
      {status === 'restoring' && <Splash />}
      {status === 'signedOut' && <Login />}
      {status === 'signedIn' && (
        <div className="flex h-full flex-col">
          <UpdateBanner />
          <div className="min-h-0 flex-1">
            <SignedInShell />
          </div>
        </div>
      )}
      <Toasts />
    </>
  )
}
