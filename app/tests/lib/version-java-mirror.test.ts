import { describe, expect, it } from 'vitest'
import { compareVersions, isNewerVersion } from '../../src/renderer/src/lib/version'

// Same table as android/app/src/test/java/es/alexcloudweb/nocturne/updates/VersionCompareTest.java:
// the native background check (VersionCompare.java) must order versions exactly like the JS check.
const ORDER = [
  '1.0.3', '1.0.4-alpha', '1.0.4-alpha.1', '1.0.4-alpha.beta', '1.0.4-beta', '1.0.4-beta.2',
  '1.0.4-beta.11', '1.0.4-rc.1', '1.0.4', '1.0.5-beta.1', '1.1.0', '2.0.0'
]

describe('version ordering shared with the Android worker', () => {
  it('orders the chain pairwise', () => {
    for (let i = 0; i < ORDER.length; i++) {
      for (let j = 0; j < ORDER.length; j++) {
        expect(Math.sign(compareVersions(ORDER[i]!, ORDER[j]!)), `${ORDER[i]} vs ${ORDER[j]}`).toBe(Math.sign(i - j))
      }
    }
  })

  it('equalities and isNewer cases', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('1.2.3+build.5', '1.2.3')).toBe(0)
    expect(compareVersions(' 1.2.3 ', '1.2.3')).toBe(0)
    expect(isNewerVersion('1.0.6', '1.0.5')).toBe(true)
    expect(isNewerVersion('1.0.10', '1.0.9')).toBe(true)
    expect(isNewerVersion('1.0.5', '1.0.5-beta.3')).toBe(true)
    expect(isNewerVersion('1.0.5-beta.3', '1.0.5')).toBe(false)
    expect(isNewerVersion('1.0.5', '1.0.5')).toBe(false)
    expect(isNewerVersion('garbage', '1.0.5')).toBe(false)
  })
})
