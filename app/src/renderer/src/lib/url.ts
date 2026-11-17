const PRIVATE_HOST = /^(localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|\[::1\]|[a-z0-9-]+\.local)$/i

/**
 * Normalizes what the user typed as their server address.
 * - adds https:// when no scheme is given
 * - allows plain http:// only for localhost / LAN addresses
 * - strips trailing slashes, query and hash
 */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('Enter your server address.')
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error("That doesn't look like a valid address.")
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Use an https:// address.')
  if (url.username || url.password) throw new Error("Don't put credentials in the address.")
  if (url.protocol === 'http:' && !PRIVATE_HOST.test(url.hostname)) {
    throw new Error('Plain http is only allowed on your local network. Use https://.')
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
