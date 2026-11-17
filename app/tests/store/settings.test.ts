import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, prefersReducedMotion, sanitizeSettings, useSettings } from '@/store/settings'

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
    const valid = { crossfade: 5, visualizer: 'spectrum', motion: 'reduced', lyrics: false, volume: 0.25, muted: true, theme: 'nord', accent: 'blue' }
    expect(sanitizeSettings(valid)).toEqual(valid)
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
