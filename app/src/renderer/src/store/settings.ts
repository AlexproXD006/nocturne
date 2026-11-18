import { create } from 'zustand'
import { readJson, writeJson } from '../lib/storage'
import { isLanguagePref, setLanguagePref, type LanguagePref, type MessageKey } from '../i18n'
import { applyAdaptivePatch, DEFAULT_ADAPTIVE, sanitizeAdaptive, type AdaptiveSettings } from '../lib/adaptive'

export type { AdaptiveSettings } from '../lib/adaptive'

export type VisualizerStyle = 'aurora' | 'spectrum' | 'minimal'
export type MotionPref = 'system' | 'reduced' | 'full'
export type ThemeId =
  | 'glass'
  | 'dark'
  | 'adaptive'
  | 'oled'
  | 'dim'
  | 'midnight'
  | 'dracula'
  | 'nord'
  | 'tokyonight'
  | 'catppuccin'
  | 'rosepine'
  | 'gruvbox'
export type AccentPresetId = 'coral' | 'purple' | 'blue' | 'green' | 'pink' | 'amber' | 'teal' | 'iris'
/** 'adaptive' follows the dominant color of the current track's artwork (the original behavior). */
export type AccentId = 'adaptive' | AccentPresetId

/** Selectable interface themes, in display order. */
export const THEMES: { id: ThemeId; labelKey: MessageKey }[] = [
  { id: 'glass', labelKey: 'theme.glass' },
  { id: 'dark', labelKey: 'theme.dark' },
  { id: 'adaptive', labelKey: 'theme.adaptive' },
  { id: 'oled', labelKey: 'theme.oled' },
  { id: 'dim', labelKey: 'theme.dim' },
  { id: 'midnight', labelKey: 'theme.midnight' },
  { id: 'dracula', labelKey: 'theme.dracula' },
  { id: 'nord', labelKey: 'theme.nord' },
  { id: 'tokyonight', labelKey: 'theme.tokyonight' },
  { id: 'catppuccin', labelKey: 'theme.catppuccin' },
  { id: 'rosepine', labelKey: 'theme.rosepine' },
  { id: 'gruvbox', labelKey: 'theme.gruvbox' }
]

/** Accent presets. `rgb` is a space-separated "R G B" string for --accent-rgb. */
export const ACCENTS: Record<AccentPresetId, { labelKey: MessageKey; rgb: string }> = {
  coral: { labelKey: 'accent.coral', rgb: '255 122 92' },
  purple: { labelKey: 'accent.purple', rgb: '189 147 249' },
  blue: { labelKey: 'accent.blue', rgb: '122 162 247' },
  green: { labelKey: 'accent.green', rgb: '74 222 128' },
  pink: { labelKey: 'accent.pink', rgb: '255 121 198' },
  amber: { labelKey: 'accent.amber', rgb: '250 189 47' },
  teal: { labelKey: 'accent.teal', rgb: '136 192 208' },
  iris: { labelKey: 'accent.iris', rgb: '196 167 231' }
}

/** The fixed "R G B" for a preset accent, or null for 'adaptive' (artwork-driven). */
export function accentRgb(id: AccentId): string | null {
  return id === 'adaptive' ? null : ACCENTS[id].rgb
}

export interface Settings {
  /** Seconds of crossfade between tracks. 0 = gapless. */
  crossfade: number
  visualizer: VisualizerStyle
  motion: MotionPref
  lyrics: boolean
  volume: number
  muted: boolean
  theme: ThemeId
  accent: AccentId
  /** Adaptive theme background options (see lib/adaptive.ts). */
  adaptive: AdaptiveSettings
  /** UI language: 'system' follows the browser/OS language list. */
  language: LanguagePref
  /** Custom Nocturne Connect name for this device ('' = automatic, e.g. "PC (Windows)"). */
  deviceName: string
}

export const DEFAULT_SETTINGS: Settings = {
  crossfade: 0,
  visualizer: 'aurora',
  motion: 'system',
  lyrics: true,
  volume: 0.8,
  muted: false,
  theme: 'glass',
  accent: 'adaptive',
  adaptive: DEFAULT_ADAPTIVE,
  language: 'system',
  deviceName: ''
}

const KEY = 'nocturne.settings.v1'
/** Set once the 1.1.0 default-theme migration has run (so a later explicit "Dark" choice sticks). */
const THEME_MIGRATION_KEY = 'nocturne.theme-migrated.v110'

/**
 * 1.1.0 made "Midnight Glass" the default theme. A saved 'dark' (or missing) theme could only have been
 * the old default or an explicit pick we cannot tell apart, so it moves to 'glass' exactly once; every
 * other saved theme (Adaptive, OLED, Nord, …) is left alone. After the marker is written, choosing
 * Dark again is respected.
 */
export function migrateTheme(s: Settings, alreadyMigrated: boolean): Settings {
  return !alreadyMigrated && s.theme === 'dark' ? { ...s, theme: 'glass' } : s
}

function loadInitial(): Settings {
  const loaded = sanitizeSettings(readJson<unknown>(KEY, {}))
  const done = readJson<unknown>(THEME_MIGRATION_KEY, false) === true
  if (done) return loaded
  const next = migrateTheme(loaded, false)
  writeJson(THEME_MIGRATION_KEY, true)
  if (next !== loaded) writeJson(KEY, next)
  return next
}

export function sanitizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof Settings, unknown>>
  const num = (v: unknown, min: number, max: number, d: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d
  return {
    crossfade: Math.round(num(r.crossfade, 0, 12, DEFAULT_SETTINGS.crossfade)),
    visualizer: r.visualizer === 'spectrum' || r.visualizer === 'minimal' || r.visualizer === 'aurora' ? r.visualizer : DEFAULT_SETTINGS.visualizer,
    motion: r.motion === 'reduced' || r.motion === 'full' || r.motion === 'system' ? r.motion : DEFAULT_SETTINGS.motion,
    lyrics: typeof r.lyrics === 'boolean' ? r.lyrics : DEFAULT_SETTINGS.lyrics,
    volume: num(r.volume, 0, 1, DEFAULT_SETTINGS.volume),
    muted: typeof r.muted === 'boolean' ? r.muted : DEFAULT_SETTINGS.muted,
    theme: THEMES.some((t) => t.id === r.theme) ? (r.theme as ThemeId) : DEFAULT_SETTINGS.theme,
    accent:
      r.accent === 'adaptive' || (typeof r.accent === 'string' && r.accent in ACCENTS) ? (r.accent as AccentId) : DEFAULT_SETTINGS.accent,
    adaptive: sanitizeAdaptive(r.adaptive),
    // Migration: settings saved before i18n have no language and default to following the system.
    language: isLanguagePref(r.language) ? r.language : DEFAULT_SETTINGS.language,
    deviceName: typeof r.deviceName === 'string' ? r.deviceName.trim().slice(0, 80) : DEFAULT_SETTINGS.deviceName
  }
}

interface SettingsStore extends Settings {
  update(patch: Partial<Settings>): void
  /** Edits the Adaptive background options; see applyAdaptivePatch for preset handling. */
  updateAdaptive(patch: Partial<AdaptiveSettings>): void
  reset(): void
}

export const useSettings = create<SettingsStore>((set, get) => ({
  ...loadInitial(),
  update(patch) {
    const next = sanitizeSettings({ ...pick(get()), ...patch })
    set(next)
    writeJson(KEY, next)
    setLanguagePref(next.language)
  },
  updateAdaptive(patch) {
    get().update({ adaptive: applyAdaptivePatch(get().adaptive, patch) })
  },
  reset() {
    set(DEFAULT_SETTINGS)
    writeJson(KEY, DEFAULT_SETTINGS)
    setLanguagePref(DEFAULT_SETTINGS.language)
  }
}))

// Apply the saved language (and <html lang>) as soon as the store exists.
setLanguagePref(useSettings.getState().language)

function pick(s: Settings): Settings {
  return {
    crossfade: s.crossfade,
    visualizer: s.visualizer,
    motion: s.motion,
    lyrics: s.lyrics,
    volume: s.volume,
    muted: s.muted,
    theme: s.theme,
    accent: s.accent,
    adaptive: s.adaptive,
    language: s.language,
    deviceName: s.deviceName
  }
}

/** Resolves the motion preference against the OS setting. */
export function prefersReducedMotion(pref: MotionPref): boolean {
  if (pref === 'reduced') return true
  if (pref === 'full') return false
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}
