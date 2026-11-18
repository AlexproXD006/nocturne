import { parseLrc, parsePlain } from '../../../lyrics/lrc'
import { t } from '../../../i18n'

/** Server limit for admin LRC / plain-text lyrics. */
export const EDIT_MAX_BYTES = 200 * 1024
const STAMP = /\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/

export type EditFormat = 'lrc' | 'plain'

/** "lrc" when the text carries [mm:ss.xx] timestamps, else "plain". */
export function detectEditFormat(text: string): EditFormat {
  return STAMP.test(text) ? 'lrc' : 'plain'
}

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

export interface EditCheck {
  ok: boolean
  error?: string
  lines: number
  bytes: number
  /** First lines for the preview (timestamps shown as m:ss for LRC). */
  preview: string[]
}

/** Client-side mirror of the server's rules for PUT /v1/admin/tracks/{id}/lyrics. */
export function checkEditLyrics(format: EditFormat, text: string): EditCheck {
  const bytes = utf8Bytes(text)
  const empty: EditCheck = { ok: false, lines: 0, bytes, preview: [] }
  if (text.trim() === '') return { ...empty, error: t('edit.empty') }
  if (bytes > EDIT_MAX_BYTES) return { ...empty, error: t('edit.tooBig') }
  if (format === 'lrc') {
    if (!STAMP.test(text)) return { ...empty, error: t('edit.noStamps') }
    const parsed = parseLrc(text)
    const lines = parsed.lines.filter((l) => l.text)
    const preview = parsed.lines.slice(0, 8).map((l) => `${Math.floor(l.time / 60000)}:${String(Math.floor((l.time % 60000) / 1000)).padStart(2, '0')}  ${l.text || '♪'}`)
    return { ok: lines.length > 0, error: lines.length ? undefined : t('edit.noTimed'), lines: lines.length, bytes, preview }
  }
  const lines = parsePlain(text).lines.filter((l) => l.text)
  return { ok: lines.length > 0, error: lines.length ? undefined : t('edit.noLines'), lines: lines.length, bytes, preview: lines.slice(0, 8).map((l) => l.text) }
}

/** Accepted file types for the "choose a file" button. */
export const EDIT_FILE_ACCEPT = '.lrc,.txt,text/plain'
