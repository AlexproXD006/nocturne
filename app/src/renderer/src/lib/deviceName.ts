/** Friendly Connect device names ("PC (Windows)", "Android phone", "Web browser (Chrome on macOS)"). */

import { t } from '../i18n'

export type DeviceKind = 'desktop' | 'android' | 'ios' | 'web' | string

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
  if (kind === 'desktop') return os === 'macOS' ? t('device.mac') : t('device.pcOs', { os: os || 'Desktop' })
  if (kind === 'android') return /Tablet|SM-T|Pad/.test(ua) ? t('device.androidTablet') : t('device.androidPhone')
  if (kind === 'ios') return /iPad/.test(ua) ? 'iPad' : 'iPhone'
  const browser = browserOf(ua)
  const detail = browser && os ? t('device.on', { browser, os }) : browser || os
  if (os === 'Android' || os === 'iOS') return detail ? t('device.phoneBrowserDetail', { detail }) : t('device.phoneBrowser')
  return detail ? t('device.webBrowserDetail', { detail }) : t('device.webBrowser')
}

const LEGACY_BROWSER = /^(Edge|Opera|Firefox|Chrome|Safari|Browser)( on (.+))?$/

/** Display name for a session, upgrading names registered by older app versions. */
export function sessionDisplayName(s: { name: string; platform: string }): string {
  const name = (s.name ?? '').trim()
  if (name === 'Nocturne Desktop') return t('device.pc')
  if (name === 'Nocturne Android') return t('device.androidPhone')
  const m = LEGACY_BROWSER.exec(name)
  if (m && s.platform === 'web') return t('device.webBrowserDetail', { detail: name })
  if (name) return name
  return s.platform === 'desktop' ? t('device.pc') : s.platform === 'android' ? t('device.androidPhone') : t('device.webBrowser')
}

/** Short platform caption shown under a device name. */
export function platformLabel(platform: string): string {
  const p = platform.toLowerCase()
  if (p === 'desktop') return t('device.platform.desktop')
  if (p === 'android') return t('device.platform.android')
  if (p === 'ios') return t('device.platform.ios')
  if (p === 'web') return t('device.platform.web')
  return platform
}
