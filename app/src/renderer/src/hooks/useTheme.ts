import { useEffect } from 'react'
import { prefersReducedMotion, useSettings, type ThemeId } from '../store/settings'

/** Base (ink-950) colour per theme, used for <meta name="theme-color">. */
const THEME_CHROME: Partial<Record<ThemeId, string>> = { glass: '#070a12', midnight: '#0a0e1a', dim: '#15202b', oled: '#000000' }

/**
 * Applies the selected interface theme to the document root as `data-theme`
 * on <html>; the per-theme override blocks in styles.css read it to re-colour
 * every surface/text/line variable.
 *
 * The accent (`--accent-rgb`) is owned by a single writer, useGlobalAccent in
 * App.tsx, which picks either the fixed preset or the artwork color ('adaptive'),
 * so the two never fight over the variable.
 */
export function useTheme(): void {
  const theme = useSettings((s) => s.theme)
  const motion = useSettings((s) => s.motion)
  useEffect(() => {
    // Lets CSS stop ambient motion (Midnight Glass orbs) for the in-app "Motion: Reduced" option too.
    document.documentElement.setAttribute('data-motion', prefersReducedMotion(motion) ? 'reduced' : 'full')
  }, [motion])
  useEffect(() => {
    const root = document.documentElement
    root.setAttribute('data-theme', theme)
    // Keep the browser / PWA chrome colour in step with the theme's base surface.
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', THEME_CHROME[theme] ?? '#08080b')
  }, [theme])
}
