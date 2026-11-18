import { t } from '../i18n'

const PRIVATE_HOST = /^(localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|\[::1\]|[a-z0-9-]+\.local)$/i

/**
 * Normalizes what the user typed as their server address.
 * - adds https:// when no scheme is given
 * - allows plain http:// only for localhost / LAN addresses
 * - strips trailing slashes, query and hash
 */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) throw new Error(t('url.empty'))
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error(t('url.invalid'))
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(t('url.https'))
  if (url.username || url.password) throw new Error(t('url.credentials'))
  if (url.protocol === 'http:' && !PRIVATE_HOST.test(url.hostname)) {
    throw new Error(t('url.plainHttp'))
  }
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.protocol}//${url.host}${path}`
}

/** Joins a base URL and an API path, encoding query params. Skips undefined values. */
export function buildUrl(base: string, path: string, query?: Record<string, string | number | boolean | undefined>): string {
  const url = new URL(`${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`)
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v))
    }
  }
  return url.toString()
}

/** Picks the smallest artwork at least `size` px wide, or the largest available. */
export function pickImage(images: { url: string; width?: number }[] | undefined, size: number): string | undefined {
  if (!images || images.length === 0) return undefined
  const sorted = [...images].sort((a, b) => (a.width ?? 0) - (b.width ?? 0))
  return (sorted.find((i) => (i.width ?? 0) >= size) ?? sorted[sorted.length - 1])!.url
}

const ART_BUCKETS = [64, 96, 128, 192, 256, 384, 512, 1024]
const ART_PATH = /\/media\/art\//

/**
 * Nocturne artwork URLs take an `s=` size (the server snaps it to the buckets above and caches the thumbnail on
 * disk). Asks for the smallest bucket that still covers `px` device pixels instead of the 300/640 px defaults.
 * Foreign URLs, URLs without `s=` and sizes that would be upscaled are returned untouched; the signature only
 * covers the path, so rewriting `s` keeps the URL valid (and stable, hence browser-cacheable).
 */
export function thumbUrl(url: string, px: number): string {
  if (!ART_PATH.test(url)) return url
  const m = /([?&])s=(\d+)/.exec(url)
  if (!m) return url
  const want = ART_BUCKETS.find((b) => b >= px) ?? ART_BUCKETS[ART_BUCKETS.length - 1]!
  return want < Number(m[2]) ? url.replace(m[0], `${m[1]}s=${want}`) : url
}
