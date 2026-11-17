// Optional static hosting of the hosted web build (dist-hosted) for local testing.
// GET/HEAD only, SPA fallback to index.html, no path traversal, security headers on HTML.

import { createReadStream, realpathSync, statSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream'
import { HttpError } from './auth.mjs'
import { SECURITY_HEADERS } from './http.mjs'

export const HTML_CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' https://lrclib.net",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'"
].join('; ')

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav'
}

export const mimeFor = (file) => MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'

/** Resolves and validates the directory once at startup; returns its real absolute path. */
export function resolveStaticDir(dir) {
  const abs = resolve(String(dir))
  let real
  try {
    real = realpathSync(abs)
    if (!statSync(real).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new Error(`staticDir "${dir}" does not exist or is not a directory`)
  }
  return real
}

/** True for paths owned by the API (never served from disk and never SPA-fallbacked). */
export const isApiPath = (pathname) => /^\/(v1|media|art)(\/|$)/.test(pathname)

async function fileInfo(root, file) {
  try {
    const real = await realpath(file)
    if (real !== root && !real.startsWith(root + sep)) return 'escape'
    const st = await stat(real)
    return st.isFile() ? { real, st } : null
  } catch {
    return null
  }
}

function send(req, res, info, { fallback }) {
  const type = mimeFor(info.real)
  const isHtml = type.startsWith('text/html')
  const etag = `W/"${info.st.size.toString(16)}-${Math.floor(info.st.mtimeMs).toString(16)}"`
  const headers = {
    ...SECURITY_HEADERS,
    'Content-Type': type,
    ETag: etag,
    'Cache-Control': isHtml || fallback ? 'no-cache' : /(^|\/)assets\//.test(info.real.replaceAll(sep, '/')) ? 'public, max-age=31536000, immutable' : 'no-cache'
  }
  if (isHtml) {
    headers['Content-Security-Policy'] = HTML_CSP
    headers['X-Frame-Options'] = 'DENY'
    headers['Referrer-Policy'] = 'no-referrer'
  }
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers)
    res.end()
    return
  }
  res.writeHead(200, { ...headers, 'Content-Length': info.st.size })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  pipeline(createReadStream(info.real), res, () => {
    if (!res.writableEnded) res.destroy()
  })
}

/**
 * Serves `pathname` from `root`. Throws HttpError for traversal (403), unknown assets (404)
 * and wrong methods (405).
 */
export async function serveStatic(root, req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.', { Allow: 'GET, HEAD, OPTIONS' })
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    throw new HttpError(400, 'Malformed URL encoding.')
  }
  if (decoded.includes('\0') || decoded.includes('\\')) throw new HttpError(403, 'Forbidden.')
  const segments = decoded.split('/').filter((s) => s !== '')
  if (segments.some((s) => s === '..' || s === '.')) throw new HttpError(403, 'Forbidden.')
  let target = join(root, ...segments)
  if (target !== root && !target.startsWith(root + sep)) throw new HttpError(403, 'Forbidden.')

  let info = await fileInfo(root, target)
  if (info === null && (decoded.endsWith('/') || (await isDir(target)))) info = await fileInfo(root, join(target, 'index.html'))
  if (info === 'escape') throw new HttpError(403, 'Forbidden.')
  if (info) return send(req, res, info, { fallback: false })

  const last = segments[segments.length - 1] ?? ''
  const wantsHtml = String(req.headers.accept ?? '').includes('text/html')
  if (!last.includes('.') || wantsHtml) {
    target = join(root, 'index.html')
    const index = await fileInfo(root, target)
    if (index && index !== 'escape') return send(req, res, index, { fallback: true })
  }
  throw new HttpError(404, 'Not found.')
}

async function isDir(p) {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}
