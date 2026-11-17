import { isSafeExternalUrl } from './security'

/** A validated "update available" notification request from the renderer. */
export interface UpdateNotice {
  version: string
  url: string
  title: string
  body: string
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
  return { version: v, url, title: `Nocturne ${v} available`, body: 'Click to download the update' }
}
