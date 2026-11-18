import { describe, expect, it } from 'vitest'
import { setLanguagePref } from '@/i18n'
import { defaultDeviceName, platformLabel, sessionDisplayName } from '@/lib/deviceName'

const WIN_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15'
const ANDROID_PHONE = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36'
const ANDROID_TABLET = 'Mozilla/5.0 (Linux; Android 14; SM-T970) AppleWebKit/537.36 Chrome/130.0 Safari/537.36'

describe('defaultDeviceName', () => {
  it('names devices in English', () => {
    expect(defaultDeviceName('desktop', WIN_CHROME)).toBe('PC (Windows)')
    expect(defaultDeviceName('desktop', MAC)).toBe('Mac')
    expect(defaultDeviceName('android', ANDROID_PHONE)).toBe('Android phone')
    expect(defaultDeviceName('android', ANDROID_TABLET)).toBe('Android tablet')
    expect(defaultDeviceName('ios', 'iPad')).toBe('iPad')
    expect(defaultDeviceName('ios', 'iPhone')).toBe('iPhone')
    expect(defaultDeviceName('web', WIN_CHROME)).toBe('Web browser (Chrome on Windows)')
    expect(defaultDeviceName('web', ANDROID_PHONE)).toBe('Phone browser (Chrome on Android)')
    expect(defaultDeviceName('web', '')).toBe('Web browser')
    expect(defaultDeviceName('web', 'Android')).toBe('Phone browser (Android)')
  })

  it('names devices in Spanish', () => {
    setLanguagePref('es')
    expect(defaultDeviceName('android', ANDROID_PHONE)).toBe('Móvil Android')
    expect(defaultDeviceName('android', ANDROID_TABLET)).toBe('Tableta Android')
    expect(defaultDeviceName('web', WIN_CHROME)).toBe('Navegador web (Chrome en Windows)')
    expect(defaultDeviceName('web', ANDROID_PHONE)).toBe('Navegador del móvil (Chrome en Android)')
    expect(defaultDeviceName('web', '')).toBe('Navegador web')
  })
})

describe('sessionDisplayName / platformLabel', () => {
  it('upgrades legacy names and falls back per platform', () => {
    expect(sessionDisplayName({ name: 'Nocturne Desktop', platform: 'desktop' })).toBe('PC')
    expect(sessionDisplayName({ name: 'Nocturne Android', platform: 'android' })).toBe('Android phone')
    expect(sessionDisplayName({ name: 'Chrome on Linux', platform: 'web' })).toBe('Web browser (Chrome on Linux)')
    expect(sessionDisplayName({ name: 'Living room', platform: 'web' })).toBe('Living room')
    expect(sessionDisplayName({ name: '', platform: 'desktop' })).toBe('PC')
    expect(sessionDisplayName({ name: '', platform: 'android' })).toBe('Android phone')
    expect(sessionDisplayName({ name: '', platform: 'web' })).toBe('Web browser')
  })

  it('labels platforms in both languages', () => {
    expect(platformLabel('desktop')).toBe('Desktop app')
    expect(platformLabel('ios')).toBe('iOS app')
    expect(platformLabel('other')).toBe('other')
    setLanguagePref('es')
    expect(platformLabel('web')).toBe('Reproductor web')
    expect(platformLabel('android')).toBe('App de Android')
  })
})
