import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@aparajita/capacitor-secure-storage', () => ({
  SecureStorage: { setKeyPrefix: vi.fn(async () => undefined), get: vi.fn(), set: vi.fn(), remove: vi.fn() }
}))

afterEach(() => {
  delete (globalThis as { Capacitor?: unknown }).Capacitor
  vi.resetModules()
})

describe('detectPlatform: ios', () => {
  it('detects Capacitor ios: Media Session based, no native now-playing/updates', async () => {
    ;(globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' }
    const { detectPlatform } = await import('../../src/renderer/src/platform')
    const p = detectPlatform()
    expect(p.kind).toBe('ios')
    expect(p.hostedOrigin).toBeNull()
    expect(p.nativeNowPlaying).toBeNull()
    expect(p.nativeUpdates).toBeNull()
    await expect(p.secureAtRest()).resolves.toBe(true)
  })

  it('names the device and points updates at the release page', async () => {
    const { defaultDeviceName, platformLabel } = await import('../../src/renderer/src/lib/deviceName')
    expect(defaultDeviceName('ios', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('iPhone')
    expect(defaultDeviceName('ios', 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe('iPad')
    expect(platformLabel('ios')).toBe('iOS app')
    const { iosUpdateUrl } = await import('../../src/renderer/src/platform/iosUpdates')
    expect(iosUpdateUrl(false)).toMatch(/releases\/latest$/)
    expect(iosUpdateUrl(true)).toMatch(/releases$/)
  })
})
