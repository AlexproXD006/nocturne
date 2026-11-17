/** Friendly Connect device names ("PC (Windows)", "Android phone", "Web browser (Chrome on macOS)"). */

export type DeviceKind = 'desktop' | 'android' | 'web' | string

function osOf(ua: string): string {
  return /Windows/.test(ua) ? 'Windows'
    : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Android/.test(ua) ? 'Android'
    : /CrOS/.test(ua) ? 'ChromeOS'
    : /Linux/.test(ua) ? 'Linux'
    : ''
}

function browserOf(ua: string): string {
  return /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : ''
}

/** The default name this device registers with. */
export function defaultDeviceName(kind: DeviceKind, ua: string): string {
  const os = osOf(ua)
  if (kind === 'desktop') return os === 'macOS' ? 'Mac' : `PC (${os || 'Desktop'})`
  if (kind === 'android') return /Tablet|SM-T|Pad/.test(ua) ? 'Android tablet' : 'Android phone'
  const browser = browserOf(ua)
  const detail = [browser, os].filter(Boolean).join(' on ')
  if (os === 'Android' || os === 'iOS') return detail ? `Phone browser (${detail})` : 'Phone browser'
  return detail ? `Web browser (${detail})` : 'Web browser'
}

const LEGACY_BROWSER = /^(Edge|Opera|Firefox|Chrome|Safari|Browser)( on (.+))?$/

/** Display name for a session, upgrading names registered by older app versions. */
export function sessionDisplayName(s: { name: string; platform: string }): string {
  const name = (s.name ?? '').trim()
  if (name === 'Nocturne Desktop') return 'PC'
  if (name === 'Nocturne Android') return 'Android phone'
  const m = LEGACY_BROWSER.exec(name)
  if (m && s.platform === 'web') return `Web browser (${name})`
  if (name) return name
  return s.platform === 'desktop' ? 'PC' : s.platform === 'android' ? 'Android phone' : 'Web browser'
}

/** Short platform caption shown under a device name. */
export function platformLabel(platform: string): string {
  const p = platform.toLowerCase()
  if (p === 'desktop') return 'Desktop app'
  if (p === 'android') return 'Android app'
  if (p === 'web') return 'Web player'
  return platform
}
