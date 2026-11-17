import { create } from 'zustand'
import { readJson, writeJson } from '../lib/storage'
import { applyAdaptivePatch, DEFAULT_ADAPTIVE, sanitizeAdaptive, type AdaptiveSettings } from '../lib/adaptive'

export type { AdaptiveSettings } from '../lib/adaptive'

export type VisualizerStyle = 'aurora' | 'spectrum' | 'minimal'
export type MotionPref = 'system' | 'reduced' | 'full'
export type ThemeId =
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
export const THEMES: { id: ThemeId; label: string }[] = [
  { id: 'dark', label: 'Dark' },
  { id: 'adaptive', label: 'Adaptive' },
  { id: 'oled', label: 'OLED' },
  { id: 'dim', label: 'Dim' },
  { id: 'midnight', label: 'Midnight' },
  { id: 'dracula', label: 'Dracula' },
  { id: 'nord', label: 'Nord' },
  { id: 'tokyonight', label: 'Tokyo Night' },
  { id: 'catppuccin', label: 'Catppuccin' },
  { id: 'rosepine', label: 'Rosé Pine' },
  { id: 'gruvbox', label: 'Gruvbox' }
]

/** Accent presets. `rgb` is a space-separated "R G B" string for --accent-rgb. */
export const ACCENTS: Record<AccentPresetId, { label: string; rgb: string }> = {
  coral: { label: 'Coral', rgb: '255 122 92' },
  purple: { label: 'Purple', rgb: '189 147 249' },
  blue: { label: 'Blue', rgb: '122 162 247' },
  green: { label: 'Green', rgb: '74 222 128' },
  pink: { label: 'Pink', rgb: '255 121 198' },
  amber: { label: 'Amber', rgb: '250 189 47' },
  teal: { label: 'Teal', rgb: '136 192 208' },
  iris: { label: 'Iris', rgb: '196 167 231' }
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
  theme: 'dark',
  accent: 'adaptive',
  adaptive: DEFAULT_ADAPTIVE,
  deviceName: ''
}

const KEY = 'nocturne.settings.v1'

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
  ...sanitizeSettings(readJson<unknown>(KEY, {})),
  update(patch) {
    const next = sanitizeSettings({ ...pick(get()), ...patch })
    set(next)
    writeJson(KEY, next)
  },
  updateAdaptive(patch) {
    get().update({ adaptive: applyAdaptivePatch(get().adaptive, patch) })
  },
  reset() {
    set(DEFAULT_SETTINGS)
    writeJson(KEY, DEFAULT_SETTINGS)
  }
}))

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
    deviceName: s.deviceName
  }
}

/** Resolves the motion preference against the OS setting. */
export function prefersReducedMotion(pref: MotionPref): boolean {
  if (pref === 'reduced') return true
  if (pref === 'full') return false
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}
