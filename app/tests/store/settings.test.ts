import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, prefersReducedMotion, sanitizeSettings, useSettings } from '@/store/settings'
import { DEFAULT_ADAPTIVE } from '@/lib/adaptive'

const KEY = 'nocturne.settings.v1'

beforeEach(() => {
  useSettings.getState().reset()
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('sanitizeSettings', () => {
  it('returns the defaults for garbage input', () => {
    for (const input of [undefined, null, 5, 'x', [], true]) expect(sanitizeSettings(input)).toEqual(DEFAULT_SETTINGS)
  })

  it('keeps valid values', () => {
    const valid = { crossfade: 5, visualizer: 'spectrum', motion: 'reduced', lyrics: false, volume: 0.25, muted: true, theme: 'nord', accent: 'blue', deviceName: 'Living room' }
    expect(sanitizeSettings(valid)).toEqual({ ...valid, adaptive: DEFAULT_SETTINGS.adaptive, language: 'system', autoplay: true, lyricsInCar: false })
  })

  it('defaults language to "system" (migration for settings saved before i18n) and rejects unknown codes', () => {
    expect(DEFAULT_SETTINGS.language).toBe('system')
    expect(sanitizeSettings({}).language).toBe('system')
    expect(sanitizeSettings({ language: 'es' }).language).toBe('es')
    expect(sanitizeSettings({ language: 'en' }).language).toBe('en')
    expect(sanitizeSettings({ language: 'klingon' }).language).toBe('system')
    expect(sanitizeSettings({ language: 7 }).language).toBe('system')
  })

  it('clamps and rounds crossfade into 0..12', () => {
    expect(sanitizeSettings({ crossfade: -3 }).crossfade).toBe(0)
    expect(sanitizeSettings({ crossfade: 99 }).crossfade).toBe(12)
    expect(sanitizeSettings({ crossfade: 3.6 }).crossfade).toBe(4)
    expect(sanitizeSettings({ crossfade: 3.4 }).crossfade).toBe(3)
    expect(sanitizeSettings({ crossfade: 12 }).crossfade).toBe(12)
  })

  it('clamps volume into 0..1', () => {
    expect(sanitizeSettings({ volume: -1 }).volume).toBe(0)
    expect(sanitizeSettings({ volume: 7 }).volume).toBe(1)
    expect(sanitizeSettings({ volume: 0.33 }).volume).toBe(0.33)
  })

  it.each([NaN, Infinity, -Infinity, '5', null, undefined, {}])('falls back to defaults for non-finite/non-number %p', (bad) => {
    const r = sanitizeSettings({ crossfade: bad, volume: bad })
    expect(r.crossfade).toBe(DEFAULT_SETTINGS.crossfade)
    expect(r.volume).toBe(DEFAULT_SETTINGS.volume)
  })

  it.each(['aurora', 'spectrum', 'minimal'])('accepts visualizer %s', (v) => {
    expect(sanitizeSettings({ visualizer: v }).visualizer).toBe(v)
  })

  it('rejects unknown visualizers and motion prefs', () => {
    expect(sanitizeSettings({ visualizer: 'disco' }).visualizer).toBe('aurora')
    expect(sanitizeSettings({ visualizer: 5 }).visualizer).toBe('aurora')
    expect(sanitizeSettings({ motion: 'turbo' }).motion).toBe('system')
  })

  it.each(['system', 'reduced', 'full'])('accepts motion %s', (m) => {
    expect(sanitizeSettings({ motion: m }).motion).toBe(m)
  })

  it('requires real booleans for flags', () => {
    expect(sanitizeSettings({ lyrics: 'false', muted: 1 })).toMatchObject({ lyrics: true, muted: false })
    expect(sanitizeSettings({ lyrics: false, muted: true })).toMatchObject({ lyrics: false, muted: true })
  })

  it('drops unknown keys', () => {
    expect(Object.keys(sanitizeSettings({ evil: true, __proto__: { x: 1 } })).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort())
  })

  it('does not mutate its input', () => {
    const input = { crossfade: 99 }
    sanitizeSettings(input)
    expect(input).toEqual({ crossfade: 99 })
  })
})

describe('useSettings', () => {
  it('has the defaults after reset', () => {
    expect(useSettings.getState()).toMatchObject(DEFAULT_SETTINGS)
  })

  it('update merges a patch, sanitizes it and persists the result', () => {
    useSettings.getState().update({ crossfade: 20, visualizer: 'minimal' })
    expect(useSettings.getState()).toMatchObject({ crossfade: 12, visualizer: 'minimal', lyrics: true })
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ ...DEFAULT_SETTINGS, crossfade: 12, visualizer: 'minimal' })
  })

  it('successive updates accumulate', () => {
    useSettings.getState().update({ volume: 0.2 })
    useSettings.getState().update({ muted: true })
    expect(useSettings.getState()).toMatchObject({ volume: 0.2, muted: true })
  })

  it('rejects invalid patches by falling back to defaults per field', () => {
    useSettings.getState().update({ visualizer: 'nope' as never, crossfade: Number.NaN })
    expect(useSettings.getState()).toMatchObject({ visualizer: 'aurora', crossfade: 0 })
  })

  it('persists only settings, not actions', () => {
    useSettings.getState().update({ lyrics: false })
    expect(Object.keys(JSON.parse(localStorage.getItem(KEY)!)).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort())
  })

  it('reset restores defaults and persists them', () => {
    useSettings.getState().update({ crossfade: 8, muted: true })
    useSettings.getState().reset()
    expect(useSettings.getState()).toMatchObject(DEFAULT_SETTINGS)
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(DEFAULT_SETTINGS)
  })

  it('notifies subscribers', () => {
    const fn = vi.fn()
    const off = useSettings.subscribe(fn)
    useSettings.getState().update({ crossfade: 2 })
    expect(fn).toHaveBeenCalledTimes(1)
    off()
  })

  it('keeps working when storage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    expect(() => useSettings.getState().update({ crossfade: 3 })).not.toThrow()
    expect(useSettings.getState().crossfade).toBe(3)
  })

  describe('loading from storage at startup', () => {
    afterEach(() => {
      vi.resetModules()
    })

    it('hydrates and sanitizes persisted settings', async () => {
      localStorage.setItem(KEY, JSON.stringify({ crossfade: 7, visualizer: 'spectrum', volume: 9, muted: true, junk: 1 }))
      vi.resetModules()
      const mod = await import('@/store/settings')
      expect(mod.useSettings.getState()).toMatchObject({ crossfade: 7, visualizer: 'spectrum', volume: 1, muted: true, lyrics: true })
    })

    it('falls back to defaults for corrupted storage', async () => {
      localStorage.setItem(KEY, '{{{')
      vi.resetModules()
      const mod = await import('@/store/settings')
      expect(mod.useSettings.getState()).toMatchObject(mod.DEFAULT_SETTINGS)
    })
  })
})

describe('adaptive settings', () => {
  it('defaults are nested under `adaptive` and persisted with the rest', () => {
    expect(DEFAULT_SETTINGS.adaptive).toEqual(DEFAULT_ADAPTIVE)
    useSettings.getState().updateAdaptive({ blur: 20 })
    const saved = JSON.parse(localStorage.getItem(KEY)!)
    expect(saved.adaptive).toMatchObject({ blur: 20, preset: 'custom' })
    expect(useSettings.getState().adaptive.blur).toBe(20)
  })

  it('sanitizes the nested object (garbage → defaults, values clamped)', () => {
    expect(sanitizeSettings({ adaptive: 'nope' }).adaptive).toEqual(DEFAULT_ADAPTIVE)
    expect(sanitizeSettings({ adaptive: { blur: 999, motion: 'spin' } }).adaptive).toMatchObject({ blur: 80, motion: 'spin', style: 'cover' })
  })

  it('updateAdaptive applies presets and marks hand edits as custom', () => {
    useSettings.getState().updateAdaptive({ preset: 'concert' })
    expect(useSettings.getState().adaptive).toMatchObject({ preset: 'concert', motion: 'pulse', style: 'aurora' })
    useSettings.getState().updateAdaptive({ glow: 10 })
    expect(useSettings.getState().adaptive).toMatchObject({ preset: 'custom', glow: 10, motion: 'pulse' })
  })

  it('reset restores the default adaptive options', () => {
    useSettings.getState().updateAdaptive({ preset: 'vinyl' })
    useSettings.getState().reset()
    expect(useSettings.getState().adaptive).toEqual(DEFAULT_ADAPTIVE)
  })

  it('hydrates adaptive options from older saves without them', async () => {
    localStorage.setItem(KEY, JSON.stringify({ theme: 'adaptive' }))
    vi.resetModules()
    const mod = await import('@/store/settings')
    expect(mod.useSettings.getState().adaptive).toEqual(DEFAULT_ADAPTIVE)
    vi.resetModules()
  })
})

describe('Midnight Glass default theme (1.1.0)', () => {
  const MIG = 'nocturne.theme-migrated.v110'
  const load = async () => {
    vi.resetModules()
    const mod = await import('@/store/settings')
    return mod
  }

  it('is the default for new installs', async () => {
    expect(DEFAULT_SETTINGS.theme).toBe('glass')
    const mod = await load()
    expect(mod.useSettings.getState().theme).toBe('glass')
    vi.resetModules()
  })

  it('moves an old saved Dark (the previous default) to Midnight Glass once and persists it', async () => {
    localStorage.setItem(KEY, JSON.stringify({ theme: 'dark', volume: 0.3 }))
    const mod = await load()
    expect(mod.useSettings.getState().theme).toBe('glass')
    expect(mod.useSettings.getState().volume).toBe(0.3)
    expect(JSON.parse(localStorage.getItem(KEY)!).theme).toBe('glass')
    expect(localStorage.getItem(MIG)).toBe('true')
    vi.resetModules()
  })

  it('keeps explicit non-default themes untouched', async () => {
    for (const theme of ['adaptive', 'nord', 'oled']) {
      localStorage.clear()
      localStorage.setItem(KEY, JSON.stringify({ theme }))
      const mod = await load()
      expect(mod.useSettings.getState().theme).toBe(theme)
    }
    vi.resetModules()
  })

  it('respects choosing Dark again after the migration ran', async () => {
    localStorage.setItem(MIG, 'true')
    localStorage.setItem(KEY, JSON.stringify({ theme: 'dark' }))
    const mod = await load()
    expect(mod.useSettings.getState().theme).toBe('dark')
    vi.resetModules()
  })

  it('keeps every legacy theme selectable', async () => {
    const { THEMES } = await load()
    expect(THEMES.map((t) => t.id)).toEqual(expect.arrayContaining(['glass', 'dark', 'adaptive', 'oled', 'dim', 'midnight', 'gruvbox']))
    vi.resetModules()
  })
})

describe('prefersReducedMotion', () => {
  it('"reduced" and "full" ignore the OS setting', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    expect(prefersReducedMotion('reduced')).toBe(true)
    expect(prefersReducedMotion('full')).toBe(false)
    expect(matchMedia).not.toHaveBeenCalled()
  })

  it('"system" follows the media query', () => {
    const mm = vi.fn((q: string) => ({ matches: true, media: q }))
    vi.stubGlobal('matchMedia', mm)
    expect(prefersReducedMotion('system')).toBe(true)
    expect(mm).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)')
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    expect(prefersReducedMotion('system')).toBe(false)
  })

  it('"system" is false when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(prefersReducedMotion('system')).toBe(false)
  })
})
