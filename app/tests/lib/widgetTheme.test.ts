import { describe, expect, it } from 'vitest'
import { ACCENTS } from '../../src/renderer/src/store/settings'
import { appThemePayload, rgbToHex, sameAppTheme } from '../../src/renderer/src/lib/widgetTheme'

describe('rgbToHex', () => {
  it('converts the accent presets', () => {
    expect(rgbToHex('255 122 92')).toBe('#ff7a5c')
    expect(rgbToHex(' 0 0 0 ')).toBe('#000000')
  })
  it('rejects malformed input', () => {
    expect(rgbToHex('')).toBeNull()
    expect(rgbToHex('1 2')).toBeNull()
    expect(rgbToHex('1 2 3 4')).toBeNull()
    expect(rgbToHex('a b c')).toBeNull()
  })
})

describe('appThemePayload', () => {
  it('sends a preset accent as hex', () => {
    expect(appThemePayload('nord', 'teal')).toEqual({ theme: 'nord', accent: '#88c0d0' })
    for (const id of Object.keys(ACCENTS) as (keyof typeof ACCENTS)[]) expect(appThemePayload('glass', id).accent).toMatch(/^#[0-9a-f]{6}$/)
  })
  it('leaves the accent null when it follows the cover', () => {
    expect(appThemePayload('glass', 'adaptive')).toEqual({ theme: 'glass', accent: null })
    // the Adaptive theme always takes the cover colour, whatever accent is stored
    expect(appThemePayload('adaptive', 'coral')).toEqual({ theme: 'adaptive', accent: null })
  })
  it('falls back to Midnight Glass for an unknown theme', () => {
    expect(appThemePayload('nope' as never, 'coral').theme).toBe('glass')
  })
  it('detects an unchanged payload', () => {
    const p = appThemePayload('dark', 'coral')
    expect(sameAppTheme(null, p)).toBe(false)
    expect(sameAppTheme(p, appThemePayload('dark', 'coral'))).toBe(true)
    expect(sameAppTheme(p, appThemePayload('dark', 'blue'))).toBe(false)
  })
})
