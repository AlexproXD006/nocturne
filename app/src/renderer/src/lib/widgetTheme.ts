import { ACCENTS, THEMES, type AccentId, type ThemeId } from '../store/settings'

/**
 * What the Android home-screen widgets need to follow the app ("Like the app"): the theme id and the
 * accent as "#rrggbb". `accent` is null when the app derives it from the cover (Adaptive accent / theme),
 * in which case the widget derives it from the cover too.
 */
export interface AppThemePayload {
  theme: ThemeId
  accent: string | null
}

const hex = (n: number): string => Math.min(255, Math.max(0, Math.round(n))).toString(16).padStart(2, '0')

/** "255 122 92" -> "#ff7a5c"; anything malformed gives null. */
export function rgbToHex(rgb: string): string | null {
  const [r, g, b, ...rest] = rgb.trim().split(/\s+/).map(Number)
  if (r === undefined || g === undefined || b === undefined || rest.length > 0 || ![r, g, b].every(Number.isFinite)) return null
  return `#${hex(r)}${hex(g)}${hex(b)}`
}

export function appThemePayload(theme: ThemeId, accent: AccentId): AppThemePayload {
  const known = THEMES.some((t) => t.id === theme)
  const id: ThemeId = known ? theme : 'glass'
  // The Adaptive theme always takes the cover colour; 'adaptive' accent does too.
  if (id === 'adaptive' || accent === 'adaptive') return { theme: id, accent: null }
  const preset = ACCENTS[accent]
  return { theme: id, accent: preset ? rgbToHex(preset.rgb) : null }
}

/** Compares two payloads (used to avoid re-sending an unchanged theme). */
export function sameAppTheme(a: AppThemePayload | null, b: AppThemePayload): boolean {
  return a !== null && a.theme === b.theme && a.accent === b.accent
}
