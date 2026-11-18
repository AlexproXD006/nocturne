import { describe, expect, it } from 'vitest'
import { setLanguagePref } from '@/i18n'
import { detectSource, formatBytes, generatePassword, relativeTime, usageFraction } from '@/pages/admin/format'

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [-5, '0 B'],
    [Number.NaN, '0 B'],
    [undefined, '0 B'],
    [512, '512 B'],
    [1023, '1023 B'],
    [1024, '1 KB'],
    [1536, '1.5 KB'],
    [10 * 1024, '10 KB'],
    [1024 ** 2, '1 MB'],
    [123.4 * 1024 ** 2, '123 MB'],
    [5 * 1024 ** 3, '5 GB'],
    [2.25 * 1024 ** 4, '2.25 TB'],
    [1024 * 1024 - 1, '1 MB'],
    [1024 ** 6 * 3, '3072 PB']
  ])('%s -> %s', (n, expected) => {
    expect(formatBytes(n as number)).toBe(expected)
  })
})

describe('usageFraction', () => {
  it('computes used / (used + free)', () => expect(usageFraction(25, 75)).toBe(0.25))
  it('is null when free is unknown or invalid', () => {
    expect(usageFraction(10, undefined)).toBeNull()
    expect(usageFraction(10, -1)).toBeNull()
    expect(usageFraction(0, 0)).toBeNull()
  })
})

describe('relativeTime', () => {
  const now = Date.parse('2026-01-10T12:00:00Z')
  const rtf = (unit: Intl.RelativeTimeFormatUnit, n: number): string =>
    new Intl.RelativeTimeFormat('en', { numeric: 'always', style: 'short' }).format(-n, unit)
  it('says "just now" under 5 seconds', () => {
    expect(relativeTime('2026-01-10T11:59:58Z', now)).toBe('just now')
    expect(relativeTime('2026-01-10T12:00:30Z', now)).toBe('just now')
  })
  it('uses Intl.RelativeTimeFormat units', () => {
    expect(relativeTime('2026-01-10T11:59:00Z', now)).toBe(rtf('minute', 1))
    expect(relativeTime('2026-01-10T11:59:30Z', now)).toBe(rtf('second', 30))
    expect(relativeTime('2026-01-10T11:55:00Z', now)).toBe(rtf('minute', 5))
    expect(relativeTime('2026-01-10T09:00:00Z', now)).toBe(rtf('hour', 3))
    expect(relativeTime('2026-01-08T12:00:00Z', now)).toBe(rtf('day', 2))
  })
  it('follows the active language', () => {
    setLanguagePref('es')
    expect(relativeTime('2026-01-10T11:55:00Z', now)).toMatch(/^hace 5 min/)
    expect(relativeTime('2026-01-10T11:59:58Z', now)).toBe('ahora mismo')
  })
  it('handles missing and invalid input', () => {
    expect(relativeTime(undefined, now)).toBe('')
    expect(relativeTime('nope', now)).toBe('')
    expect(relativeTime('2020-01-01T00:00:00Z', now)).not.toBe('')
  })
})

describe('detectSource', () => {
  it('detects Spotify', () => {
    expect(detectSource('https://open.spotify.com/track/abc?si=1')).toEqual({ source: 'spotify', url: 'https://open.spotify.com/track/abc?si=1' })
    expect(detectSource('open.spotify.com/playlist/xyz')?.source).toBe('spotify')
  })
  it('detects YouTube variants', () => {
    for (const u of ['https://www.youtube.com/watch?v=1', 'https://youtu.be/abc', 'https://music.youtube.com/playlist?list=PL1', 'youtube.com/watch?v=1']) {
      expect(detectSource(u)?.source).toBe('youtube')
    }
  })
  it('rejects everything else', () => {
    for (const u of ['', '  ', 'hello world', 'https://example.com/track', 'https://open.spotify.com/', 'https://youtube.com/', 'ftp://youtube.com/watch?v=1', 'https://evil.com/open.spotify.com/x', 'https://open.spotify.com.evil.com/track/1']) {
      expect(detectSource(u)).toBeNull()
    }
  })
})

describe('generatePassword', () => {
  it('has the requested length and every character class', () => {
    for (let i = 0; i < 50; i++) {
      const p = generatePassword(20)
      expect(p).toHaveLength(20)
      expect(p).toMatch(/[a-z]/)
      expect(p).toMatch(/[A-Z]/)
      expect(p).toMatch(/[0-9]/)
      expect(p).toMatch(/[^a-zA-Z0-9]/)
    }
  })
  it('never goes below 12 characters and defaults to a strong length', () => {
    expect(generatePassword(3)).toHaveLength(12)
    expect(generatePassword().length).toBeGreaterThanOrEqual(10)
  })
  it('uses the supplied random source and differs between calls', () => {
    let calls = 0
    const rnd = (a: Uint32Array): Uint32Array => ((calls++, crypto.getRandomValues(a)))
    const a = generatePassword(16, rnd)
    expect(calls).toBeGreaterThan(16)
    expect(a).not.toBe(generatePassword(16))
  })
})
