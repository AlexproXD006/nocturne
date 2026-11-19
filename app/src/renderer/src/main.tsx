import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { App } from './App'
import { platform, usePlayer, useSession } from './services'
import { currentItem } from './player/queue'
import { useNav } from './store/nav'
import { useUi } from './store/ui'
import { parseWidgetLink } from './lib/widgetLink'
import { targetPlatform, useUpdates } from './store/updates'
import { installJsErrorHooks } from './platform/diagnostics'
import { createUpdateNotifications } from './store/updateNotifications'

async function setupAndroid(): Promise<void> {
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar')
    await StatusBar.setStyle({ style: Style.Dark })
    await StatusBar.setOverlaysWebView({ overlay: true })
    // Transparent overlay over the navy backdrop (matches theme-color / capacitor.config.ts).
    await StatusBar.setBackgroundColor({ color: '#070a12' })
  } catch {
    /* status bar plugin unavailable */
  }
  try {
    const { App: CapApp } = await import('@capacitor/app')
    await CapApp.addListener('backButton', () => {
      const ui = useUi.getState()
      const nav = useNav.getState()
      if (ui.fullscreen) ui.setFullscreen(false)
      else if (ui.panel) ui.closePanel()
      else if (nav.canBack) nav.back()
      else void CapApp.minimizeApp()
    })
    // Home-screen widget taps: the cover opens the fullscreen player.
    // On a cold start the queue is adopted from native a moment later: wait for a song (max 10 s) first.
    const handleLink = (url: string | null | undefined): void => {
      if (parseWidgetLink(url) !== 'player') return
      if (currentItem(usePlayer.getState().queue)) {
        useUi.getState().setFullscreen(true)
        return
      }
      const stop = usePlayer.subscribe((st) => {
        if (!currentItem(st.queue)) return
        stop()
        clearTimeout(timer)
        useUi.getState().setFullscreen(true)
      })
      const timer = setTimeout(stop, 10_000)
    }
    await CapApp.addListener('appUrlOpen', (e) => handleLink(e.url))
    handleLink((await CapApp.getLaunchUrl())?.url)
  } catch {
    /* app plugin unavailable */
  }
}

async function setupIos(): Promise<void> {
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar')
    await StatusBar.setStyle({ style: Style.Dark })
  } catch {
    /* status bar plugin unavailable */
  }
}

if (platform.diagnostics) installJsErrorHooks(platform.diagnostics)
if (platform.kind === 'android') void setupAndroid()
else if (platform.kind === 'ios') void setupIos()

// "New version available" system notifications (Android background check + desktop). No-op on web.
try {
  createUpdateNotifications({ platform, session: useSession, updates: useUpdates, channel: () => targetPlatform() })
} catch {
  /* best-effort */
}

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
