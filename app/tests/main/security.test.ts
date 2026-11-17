// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  APP_HOST,
  APP_ORIGIN,
  buildCsp,
  isPermissionAllowed,
  isSafeExternalUrl,
  isTrustedRendererUrl,
  mimeFor,
  resolveAppAsset
} from '../../src/main/security'

const ROOT = '/opt/nocturne/out/renderer'

function directives(csp: string): Record<string, string> {
  return Object.fromEntries(csp.split('; ').map((d) => [d.split(' ')[0]!, d]))
}

describe('constants', () => {
  it('derives the origin from scheme and host', () => {
    expect(APP_ORIGIN).toBe('app://nocturne')
    expect(APP_HOST).toBe('nocturne')
  })
})

describe('buildCsp', () => {
  it('is strict in production: no inline scripts, no dev origins, no websockets', () => {
    const csp = buildCsp()
    const d = directives(csp)
    expect(d['script-src']).toBe("script-src 'self'")
    expect(csp.match(/unsafe-inline/g)).toHaveLength(1) // style-src only
    expect(d['style-src']).toContain("'unsafe-inline'")
    expect(csp).not.toContain('ws:')
    expect(csp).not.toContain('localhost')
    expect(d['default-src']).toBe("default-src 'self'")
    expect(d['object-src']).toBe("object-src 'none'")
    expect(d['base-uri']).toBe("base-uri 'none'")
    expect(d['form-action']).toBe("form-action 'none'")
    expect(d['frame-ancestors']).toBe("frame-ancestors 'none'")
    expect(d['worker-src']).toBe("worker-src 'self' blob:")
  })

  it('allows the user-chosen media/network origins over http(s)', () => {
    const d = directives(buildCsp())
    expect(d['connect-src']).toBe("connect-src 'self' https: http:")
    expect(d['media-src']).toContain('https:')
    expect(d['media-src']).toContain('blob:')
    expect(d['img-src']).toContain('data:')
  })

  it('ignores dev=false even when a dev server is provided', () => {
    const csp = buildCsp({ dev: false, devServer: 'http://localhost:5173' })
    expect(csp).not.toContain('localhost')
    expect(csp).not.toContain('ws://')
  })

  it('ignores dev=true without a dev server for the origin parts, but allows inline scripts', () => {
    const d = directives(buildCsp({ dev: true }))
    expect(d['script-src']).toBe("script-src 'self' 'unsafe-inline'")
    expect(d['connect-src']).toBe("connect-src 'self' https: http:")
  })

  it('includes the dev origin and a ws:// endpoint in dev mode', () => {
    const d = directives(buildCsp({ dev: true, devServer: 'http://localhost:5173/some/path' }))
    expect(d['default-src']).toBe("default-src 'self' http://localhost:5173")
    expect(d['script-src']).toBe("script-src 'self' http://localhost:5173 'unsafe-inline'")
    expect(d['connect-src']).toBe("connect-src 'self' https: http: ws://localhost:5173")
  })

  it('throws on an invalid dev server URL', () => {
    expect(() => buildCsp({ dev: true, devServer: 'not a url' })).toThrow()
  })
})

describe('isSafeExternalUrl', () => {
  it.each(['https://example.com', 'http://example.com/a?b=c#d', 'https://sub.example.com:8443/x'])('accepts %s', (u) => {
    expect(isSafeExternalUrl(u)).toBe(true)
  })

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<script>1</script>',
    'ftp://example.com',
    'app://nocturne/index.html',
    'vbscript:x',
    'blob:https://example.com/uuid',
    'https://user:pass@example.com',
    'https://user@example.com',
    'http://:secret@example.com',
    'not a url',
    '',
    '//example.com',
    'https://'
  ])('rejects %s', (u) => {
    expect(isSafeExternalUrl(u)).toBe(false)
  })

  it('rejects overlong urls (> 2048 chars) but accepts exactly 2048', () => {
    const base = 'https://example.com/'
    expect(isSafeExternalUrl(base + 'a'.repeat(2048 - base.length))).toBe(true)
    expect(isSafeExternalUrl(base + 'a'.repeat(2049 - base.length))).toBe(false)
  })

  it.each([undefined, null, 42, {}, [], true, Symbol('x')])('rejects non-string %p', (v) => {
    expect(isSafeExternalUrl(v)).toBe(false)
  })
})

describe('isTrustedRendererUrl', () => {
  it('trusts the production app origin', () => {
    expect(isTrustedRendererUrl('app://nocturne/index.html')).toBe(true)
    expect(isTrustedRendererUrl('app://nocturne/')).toBe(true)
    expect(isTrustedRendererUrl('app://nocturne')).toBe(true)
  })

  it('rejects other hosts on the app scheme and other schemes', () => {
    expect(isTrustedRendererUrl('app://evil/index.html')).toBe(false)
    expect(isTrustedRendererUrl('app://nocturne.evil.com/')).toBe(false)
    expect(isTrustedRendererUrl('https://nocturne/')).toBe(false)
    expect(isTrustedRendererUrl('file:///index.html')).toBe(false)
  })

  it('trusts only the exact dev server origin when given', () => {
    const dev = 'http://localhost:5173'
    expect(isTrustedRendererUrl('http://localhost:5173/index.html', dev)).toBe(true)
    expect(isTrustedRendererUrl('http://localhost:5174/', dev)).toBe(false)
    expect(isTrustedRendererUrl('https://localhost:5173/', dev)).toBe(false)
    expect(isTrustedRendererUrl('http://localhost:5173/', undefined)).toBe(false)
    // the prod origin stays trusted in dev
    expect(isTrustedRendererUrl('app://nocturne/', dev)).toBe(true)
  })

  it('rejects empty / invalid input', () => {
    expect(isTrustedRendererUrl(undefined)).toBe(false)
    expect(isTrustedRendererUrl(null)).toBe(false)
    expect(isTrustedRendererUrl('')).toBe(false)
    expect(isTrustedRendererUrl('::::')).toBe(false)
    expect(isTrustedRendererUrl('::::', 'http://localhost:5173')).toBe(false)
  })

  it('returns false rather than throwing for an invalid dev server', () => {
    expect(isTrustedRendererUrl('http://localhost:5173/', 'garbage')).toBe(false)
  })
})

describe('resolveAppAsset', () => {
  it('serves index.html for the root and for extension-less SPA routes', () => {
    expect(resolveAppAsset('app://nocturne/', ROOT)).toBe(`${ROOT}/index.html`)
    expect(resolveAppAsset('app://nocturne', ROOT)).toBe(`${ROOT}/index.html`)
    expect(resolveAppAsset('app://nocturne/index.html', ROOT)).toBe(`${ROOT}/index.html`)
    expect(resolveAppAsset('app://nocturne/album/123', ROOT)).toBe(`${ROOT}/index.html`)
    expect(resolveAppAsset('app://nocturne/library/', ROOT)).toBe(`${ROOT}/index.html`)
  })

  it('maps nested assets', () => {
    expect(resolveAppAsset('app://nocturne/assets/index-abc123.js', ROOT)).toBe(`${ROOT}/assets/index-abc123.js`)
    expect(resolveAppAsset('app://nocturne/assets/fonts/inter.woff2', ROOT)).toBe(`${ROOT}/assets/fonts/inter.woff2`)
    expect(resolveAppAsset('app://nocturne/icon.svg?v=2#x', ROOT)).toBe(`${ROOT}/icon.svg`)
  })

  it('collapses redundant segments', () => {
    expect(resolveAppAsset('app://nocturne/assets//./a.js', ROOT)).toBe(`${ROOT}/assets/a.js`)
  })

  it('strips trailing separators from the root (posix and windows)', () => {
    expect(resolveAppAsset('app://nocturne/a.js', `${ROOT}/`)).toBe(`${ROOT}/a.js`)
    expect(resolveAppAsset('app://nocturne/a.js', `${ROOT}//`)).toBe(`${ROOT}/a.js`)
    expect(resolveAppAsset('app://nocturne/a.js', 'C:\\app\\renderer\\')).toBe('C:\\app\\renderer/a.js')
  })

  it.each([
    'app://nocturne/../secret.txt',
    'app://nocturne/assets/../../secret.txt',
    'app://nocturne/%2e%2e/secret.txt',
    'app://nocturne/%2E%2E/secret.txt',
    'app://nocturne/assets/%2e%2e/%2e%2e/secret.txt',
    'app://nocturne/..%2fsecret.txt',
    'app://nocturne/%2e%2e%2fsecret.txt',
    'app://nocturne/assets/..%2f..%2fsecret.txt',
    'app://nocturne/%252e%252e/x.js'
  ])('never escapes the root: %s', (url) => {
    const out = resolveAppAsset(url, ROOT)
    // Either rejected outright or confined to the root.
    if (out !== null) {
      expect(out.startsWith(`${ROOT}/`)).toBe(true)
      expect(out.slice(ROOT.length).split('/')).not.toContain('..')
    }
  })

  it('confines traversal beyond the root to the root', () => {
    // posix.normalize("/../x") === "/x", so the result stays inside the root.
    expect(resolveAppAsset('app://nocturne/../../x.js', ROOT)).toBe(`${ROOT}/x.js`)
  })

  it('treats backslashes as plain characters and never as separators', () => {
    const out = resolveAppAsset('app://nocturne/assets/..%5C..%5Csecret.txt', ROOT)
    // `..\..\secret.txt` has an extension but is a single posix segment: stays inside the root.
    expect(out).toBe(`${ROOT}/assets/..\\..\\secret.txt`)
    expect(out!.slice(ROOT.length).split('/')).not.toContain('..')
  })

  it('rejects null bytes (raw and encoded)', () => {
    expect(resolveAppAsset('app://nocturne/a%00.js', ROOT)).toBeNull()
    expect(resolveAppAsset('app://nocturne/%00', ROOT)).toBeNull()
  })

  it('rejects the wrong host, scheme-less and malformed URLs', () => {
    expect(resolveAppAsset('app://evil/index.html', ROOT)).toBeNull()
    expect(resolveAppAsset('app://nocturne.evil.com/index.html', ROOT)).toBeNull()
    expect(resolveAppAsset('app://evil.com@nocturne/', ROOT)).not.toBeNull() // userinfo: host is still nocturne
    expect(resolveAppAsset('garbage', ROOT)).toBeNull()
    expect(resolveAppAsset('', ROOT)).toBeNull()
  })

  it('rejects malformed percent-encoding', () => {
    expect(resolveAppAsset('app://nocturne/%E0%A4%A.js', ROOT)).toBeNull()
  })

  it('does not require a particular scheme to resolve (host check only)', () => {
    expect(resolveAppAsset('app://nocturne/x.css', ROOT)).toBe(`${ROOT}/x.css`)
  })
})

describe('mimeFor', () => {
  it.each([
    ['index.html', 'text/html; charset=utf-8'],
    ['a.js', 'text/javascript; charset=utf-8'],
    ['a.mjs', 'text/javascript; charset=utf-8'],
    ['a.css', 'text/css; charset=utf-8'],
    ['a.json', 'application/json'],
    ['a.svg', 'image/svg+xml'],
    ['a.png', 'image/png'],
    ['a.jpg', 'image/jpeg'],
    ['a.webp', 'image/webp'],
    ['favicon.ico', 'image/x-icon'],
    ['a.woff2', 'font/woff2'],
    ['a.woff', 'font/woff'],
    ['a.ttf', 'font/ttf'],
    ['a.wasm', 'application/wasm']
  ])('%s -> %s', (file, mime) => {
    expect(mimeFor(file)).toBe(mime)
  })

  it('is case-insensitive on the extension', () => {
    expect(mimeFor('LOGO.PNG')).toBe('image/png')
    expect(mimeFor('/x/Y.HtMl')).toBe('text/html; charset=utf-8')
  })

  it('falls back to octet-stream for unknown or missing extensions', () => {
    expect(mimeFor('a.xyz')).toBe('application/octet-stream')
    expect(mimeFor('README')).toBe('application/octet-stream')
    expect(mimeFor('')).toBe('application/octet-stream')
    expect(mimeFor('a.')).toBe('application/octet-stream')
  })

  it('does not treat prototype keys as mime types', () => {
    expect(mimeFor('a.constructor')).toBe('application/octet-stream')
  })
})

describe('isPermissionAllowed', () => {
  it.each(['fullscreen', 'clipboard-sanitized-write', 'media-key-system'])('allows %s', (p) => {
    expect(isPermissionAllowed(p)).toBe(true)
  })

  it.each(['media', 'geolocation', 'notifications', 'midi', 'camera', 'microphone', 'openExternal', 'clipboard-read', '', 'constructor'])(
    'denies %s',
    (p) => {
      expect(isPermissionAllowed(p)).toBe(false)
    }
  )
})
