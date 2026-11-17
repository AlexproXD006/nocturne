import { describe, expect, it } from 'vitest'
import { compareVersions, isNewerVersion, isPrerelease } from '../../src/renderer/src/lib/version'

describe('compareVersions (SemVer precedence)', () => {
  it('orders plain releases numerically', () => {
    expect(isNewerVersion('1.0.3', '1.0.2')).toBe(true)
    expect(isNewerVersion('1.0.10', '1.0.9')).toBe(true)
    expect(isNewerVersion('1.1.0', '1.0.99')).toBe(true)
    expect(isNewerVersion('1.0.2', '1.0.2')).toBe(false)
    expect(isNewerVersion('1.0.1', '1.0.2')).toBe(false)
  })

  it('treats missing segments as zero', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
    expect(isNewerVersion('1.0.1', '1.0')).toBe(true)
  })

  it('ranks a release above its own pre-releases', () => {
    expect(isNewerVersion('1.0.4', '1.0.4-beta.1')).toBe(true)
    expect(isNewerVersion('1.0.4-beta.1', '1.0.4')).toBe(false)
  })

  it('ranks a pre-release of a higher version above an older release', () => {
    expect(isNewerVersion('1.0.4-beta.1', '1.0.3')).toBe(true)
    expect(isNewerVersion('1.0.3', '1.0.4-beta.1')).toBe(false)
  })

  it('orders pre-releases by identifiers', () => {
    expect(isNewerVersion('1.0.4-beta.2', '1.0.4-beta.1')).toBe(true)
    expect(isNewerVersion('1.0.4-beta.10', '1.0.4-beta.9')).toBe(true)
    expect(isNewerVersion('1.0.4-beta.1', '1.0.4-alpha.3')).toBe(true)
    expect(isNewerVersion('1.0.4-rc.1', '1.0.4-beta.5')).toBe(true)
    expect(isNewerVersion('1.0.4-beta.1', '1.0.4-beta')).toBe(true)
    expect(compareVersions('1.0.4-beta.1', '1.0.4-beta.1')).toBe(0)
  })

  it('ignores a leading v and build metadata', () => {
    expect(compareVersions('v1.0.4', '1.0.4')).toBe(0)
    expect(compareVersions('1.0.4+build.7', '1.0.4')).toBe(0)
  })

  it('never throws on junk input', () => {
    expect(() => compareVersions('', 'nonsense')).not.toThrow()
    expect(isNewerVersion('', '1.0.0')).toBe(false)
  })
})

describe('isPrerelease', () => {
  it('detects pre-release versions', () => {
    expect(isPrerelease('1.0.4-beta.1')).toBe(true)
    expect(isPrerelease('1.0.5-alpha')).toBe(true)
    expect(isPrerelease('1.0.3')).toBe(false)
  })
})
