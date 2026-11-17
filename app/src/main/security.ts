import { posix } from 'node:path'

/** Custom privileged scheme the production renderer is served from (avoids file://). */
export const APP_SCHEME = 'app'
export const APP_HOST = 'nocturne'
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`

/**
 * Content-Security-Policy for the renderer. Scripts only from the bundle; network
 * access is open to http(s) because the music server URL is chosen by the user.
 */
export function buildCsp(opts: { dev?: boolean; devServer?: string } = {}): string {
  const dev = opts.dev === true
  const devSrc = dev && opts.devServer ? ` ${new URL(opts.devServer).origin}` : ''
  const devWs = dev && opts.devServer ? ` ws://${new URL(opts.devServer).host}` : ''
  return [
    `default-src 'self'${devSrc}`,
    `script-src 'self'${devSrc}${dev ? " 'unsafe-inline'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' https: http: data: blob:",
    "media-src 'self' https: http: blob:",
    `connect-src 'self' https: http:${devWs}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join('; ')
}

/** Only plain web links may be handed to the OS browser. */
export function isSafeExternalUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 2048) return false
  try {
    const url = new URL(raw)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.length > 0 && !url.username && !url.password
  } catch {
    return false
  }
}

/** Whether a frame URL belongs to our own renderer (prod scheme or the dev server). */
export function isTrustedRendererUrl(raw: string | undefined | null, devServer?: string): boolean {
  if (!raw) return false
  try {
    const url = new URL(raw)
    if (url.protocol === `${APP_SCHEME}:` && url.host === APP_HOST) return true
    if (devServer) return url.origin === new URL(devServer).origin
    return false
  } catch {
    return false
  }
}

/**
 * Maps an app:// request path to a file inside the renderer directory.
 * Returns null for anything that would escape the root. Unknown routes fall back
 * to index.html (single-page app).
 */
export function resolveAppAsset(requestUrl: string, root: string): string | null {
  let pathname: string
  try {
    const url = new URL(requestUrl)
    if (url.host !== APP_HOST) return null
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  if (pathname.includes('\0')) return null
  const normalized = posix.normalize(`/${pathname}`)
  if (normalized.split('/').includes('..')) return null
  const relative = normalized === '/' ? '/index.html' : normalized
  const hasExtension = /\.[a-z0-9]+$/i.test(relative)
  const file = hasExtension ? relative : '/index.html'
  const base = root.replace(/[\\/]+$/, '')
  return `${base}${file}`
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm'
}

export function mimeFor(file: string): string {
  const match = /\.[a-z0-9]+$/i.exec(file)
  return (match && MIME[match[0].toLowerCase()]) || 'application/octet-stream'
}

/** Permissions the renderer may use. Everything else (camera, mic, geolocation…) is denied. */
const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write', 'media-key-system'])

export function isPermissionAllowed(permission: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission)
}
