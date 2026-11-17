import { describe, expect, it } from 'vitest'
import { buildUrl, normalizeServerUrl, pickImage } from '@/lib/url'

describe('normalizeServerUrl', () => {
  it('adds https:// when no scheme is given', () => {
    expect(normalizeServerUrl('music.example.com')).toBe('https://music.example.com')
    expect(normalizeServerUrl('music.example.com:8443')).toBe('https://music.example.com:8443')
  })

  it('trims whitespace', () => {
    expect(normalizeServerUrl('  https://music.example.com  ')).toBe('https://music.example.com')
  })

  it('strips trailing slashes, query and hash but keeps a sub-path', () => {
    expect(normalizeServerUrl('https://example.com/')).toBe('https://example.com')
    expect(normalizeServerUrl('https://example.com///')).toBe('https://example.com')
    expect(normalizeServerUrl('https://example.com/music/')).toBe('https://example.com/music')
    expect(normalizeServerUrl('https://example.com/music?x=1#frag')).toBe('https://example.com/music')
    expect(normalizeServerUrl('https://example.com?x=1')).toBe('https://example.com')
  })

  it('lowercases scheme and host, and drops default ports', () => {
    expect(normalizeServerUrl('HTTPS://Example.COM:443/')).toBe('https://example.com')
  })

  it.each([
    'http://localhost:4000',
    'http://127.0.0.1:8080',
    'http://127.1.2.3',
    'http://192.168.1.20:3000',
    'http://10.0.0.5',
    'http://172.16.0.1',
    'http://172.31.255.254',
    'http://nas.local',
    'http://my-nas.LOCAL:8080',
    'http://[::1]:3000',
    'localhost:3000'
  ])('allows plain http on private hosts: %s', (input) => {
    const out = normalizeServerUrl(input.startsWith('localhost') ? `http://${input}` : input)
    expect(out.startsWith('http://')).toBe(true)
  })

  it.each([
    'http://example.com',
    'http://music.example.com:8080',
    'http://8.8.8.8',
    'http://172.15.0.1',
    'http://172.32.0.1',
    'http://192.169.1.1',
    'http://11.0.0.1',
    'http://localhost.evil.com',
    'http://evil.com/localhost',
    'http://192.168.1.1.evil.com'
  ])('rejects plain http on public hosts: %s', (input) => {
    expect(() => normalizeServerUrl(input)).toThrow(/only allowed on your local network/)
  })

  it('treats a bare localhost as https (no scheme means https)', () => {
    expect(normalizeServerUrl('localhost:3000')).toBe('https://localhost:3000')
  })

  it.each(['', '   ', '\n'])('rejects empty input %j', (input) => {
    expect(() => normalizeServerUrl(input)).toThrow('Enter your server address.')
  })

  it.each(['ftp://example.com', 'file:///etc/passwd', 'javascript://example.com/%0aalert(1)', 'ws://example.com'])(
    'rejects non-http schemes: %s',
    (input) => {
      expect(() => normalizeServerUrl(input)).toThrow('Use an https:// address.')
    }
  )

  it.each(['https://user:pass@example.com', 'https://user@example.com', 'https://:pw@example.com'])('rejects credentials: %s', (input) => {
    expect(() => normalizeServerUrl(input)).toThrow(/credentials/)
  })

  it.each(['https://', 'https://exa mple.com', 'http://[::1', 'https://bad host/'])('rejects invalid urls: %s', (input) => {
    expect(() => normalizeServerUrl(input)).toThrow(/valid address/)
  })
})

describe('buildUrl', () => {
  it('joins base and path regardless of slashes', () => {
    expect(buildUrl('https://a.com', '/v1/x')).toBe('https://a.com/v1/x')
    expect(buildUrl('https://a.com/', 'v1/x')).toBe('https://a.com/v1/x')
    expect(buildUrl('https://a.com//', '//v1/x')).toBe('https://a.com/v1/x')
    expect(buildUrl('https://a.com/sub', '/v1/x')).toBe('https://a.com/sub/v1/x')
  })

  it('adds and encodes query params, skipping undefined', () => {
    const url = buildUrl('https://a.com', '/s', { q: 'a b&c', n: 3, t: true, f: false, z: 0, skip: undefined })
    expect(url).toBe('https://a.com/s?q=a+b%26c&n=3&t=true&f=false&z=0')
  })

  it('produces no query string for an empty query', () => {
    expect(buildUrl('https://a.com', '/s', {})).toBe('https://a.com/s')
    expect(buildUrl('https://a.com', '/s', { a: undefined })).toBe('https://a.com/s')
  })

  it('throws for an invalid base', () => {
    expect(() => buildUrl('nonsense', '/x')).toThrow()
  })
})

describe('pickImage', () => {
  const imgs = [
    { url: 'big', width: 640 },
    { url: 'small', width: 64 },
    { url: 'med', width: 300 }
  ]

  it('returns undefined for no images', () => {
    expect(pickImage(undefined, 100)).toBeUndefined()
    expect(pickImage([], 100)).toBeUndefined()
  })

  it('picks the smallest image that is at least the requested size', () => {
    expect(pickImage(imgs, 100)).toBe('med')
    expect(pickImage(imgs, 300)).toBe('med')
    expect(pickImage(imgs, 301)).toBe('big')
    expect(pickImage(imgs, 1)).toBe('small')
  })

  it('falls back to the largest when none is big enough', () => {
    expect(pickImage(imgs, 2000)).toBe('big')
  })

  it('treats missing widths as 0 and does not mutate the input', () => {
    const list = [{ url: 'b', width: 100 }, { url: 'a' }]
    expect(pickImage(list, 50)).toBe('b')
    expect(pickImage(list, 0)).toBe('a')
    expect(list.map((i) => i.url)).toEqual(['b', 'a'])
    expect(pickImage([{ url: 'only' }], 500)).toBe('only')
  })
})
