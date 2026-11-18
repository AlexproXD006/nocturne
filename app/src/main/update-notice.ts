import { isSafeExternalUrl } from './security'

/** A validated "update available" notification request from the renderer. */
export interface UpdateNotice {
  version: string
  url: string
  title: string
  body: string
}

/** Notification text per UI language (the renderer sends its active language as `locale`; unknown values fall back to English). */
const NOTICE_TEXT = {
  en: { title: (v: string) => `Nocturne ${v} available`, body: 'Click to download the update' },
  es: { title: (v: string) => `Nocturne ${v} disponible`, body: 'Haz clic para descargar la actualización' }
} as const

function localeOf(raw: unknown): keyof typeof NOTICE_TEXT {
  const base = typeof raw === 'string' ? raw.toLowerCase().split(/[-_]/)[0] : ''
  return base === 'es' ? 'es' : 'en'
}

const VERSION_RE = /^v?[0-9A-Za-z.+-]{1,64}$/

/**
 * Validates the renderer's payload for IPC.notifyUpdate (untrusted input): a short version label
 * and an http(s) download URL. Returns null for anything else.
 */
export function parseUpdateNotice(raw: unknown): UpdateNotice | null {
  if (!raw || typeof raw !== 'object') return null
  const { version, url } = raw as { version?: unknown; url?: unknown }
  if (typeof version !== 'string' || !VERSION_RE.test(version.trim())) return null
  if (!isSafeExternalUrl(url)) return null
  const v = version.trim()
  const text = NOTICE_TEXT[localeOf((raw as { locale?: unknown }).locale)]
  return { version: v, url, title: text.title(v), body: text.body }
}
