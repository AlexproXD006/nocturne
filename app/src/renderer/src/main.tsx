import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { App } from './App'
import { platform, useSession } from './services'
import { useNav } from './store/nav'
import { useUi } from './store/ui'
import { targetPlatform, useUpdates } from './store/updates'
import { createUpdateNotifications } from './store/updateNotifications'

async function setupAndroid(): Promise<void> {
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar')
    await StatusBar.setStyle({ style: Style.Dark })
    await StatusBar.setOverlaysWebView({ overlay: true })
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
  } catch {
    /* app plugin unavailable */
  }
}

if (platform.kind === 'android') void setupAndroid()

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
