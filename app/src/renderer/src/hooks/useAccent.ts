import { useEffect, useState } from 'react'
import { cachedPalette, extractAccent, extractPalette, FALLBACK_ACCENT, type ImagePalette, type Rgb } from '../lib/color'

/** Accent color extracted from artwork, with the app default as fallback. */
export function useAccent(url: string | undefined): Rgb {
  const [accent, setAccent] = useState<Rgb>(FALLBACK_ACCENT)
  useEffect(() => {
    if (!url) {
      setAccent(FALLBACK_ACCENT)
      return
    }
    let alive = true
    void extractAccent(url).then((c) => {
      if (alive) setAccent(c ?? FALLBACK_ACCENT)
    })
    return () => {
      alive = false
    }
  }, [url])
  return accent
}

/**
 * Palette (dominant / vibrant / muted) + luminance of an artwork, sampled once
 * per URL (shared cache with useAccent). Null until loaded or when unreadable.
 */
/** Wait before sampling a cover that is not cached yet (rapid skipping samples only the track you stop on). */
export const PALETTE_DEBOUNCE_MS = 120

export function usePalette(url: string | undefined): ImagePalette | null {
  const [state, setState] = useState<{ url: string | undefined; palette: ImagePalette | null }>(() => ({
    url,
    palette: url ? (cachedPalette(url) ?? null) : null
  }))
  useEffect(() => {
    if (!url) {
      setState((s) => (s.palette === null && s.url === url ? s : { url, palette: null }))
      return
    }
    const hit = cachedPalette(url)
    if (hit) {
      setState((s) => (s.palette === hit && s.url === url ? s : { url, palette: hit }))
      return
    }
    let alive = true
    const id = setTimeout(() => {
      void extractPalette(url).then((palette) => {
        // Unreadable / failed cover: keep the last good palette (no flash to the fallback colours).
        if (alive && palette) setState({ url, palette })
      })
    }, PALETTE_DEBOUNCE_MS)
    return () => {
      alive = false
      clearTimeout(id)
    }
  }, [url])
  // Keep showing the previous cover's palette until the new one is ready (no flash to fallback).
  return state.palette
}
