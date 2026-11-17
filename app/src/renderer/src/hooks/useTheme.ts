import { useEffect } from 'react'
import { useSettings } from '../store/settings'

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
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])
}
