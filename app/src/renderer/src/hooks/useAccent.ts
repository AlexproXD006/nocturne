import { useEffect, useState } from 'react'
import { extractAccent, FALLBACK_ACCENT, type Rgb } from '../lib/color'

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
