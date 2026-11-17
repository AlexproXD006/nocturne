import type { LyricsFormat } from '../../../api/types'
import { invalidateLyrics } from '../../../hooks/useLyrics'
import { resources } from '../../../lib/resource'
import { describeLyricsFile, type LyricsFileDescription } from '../../../lyrics/match'
import { MAX_LYRICS_BYTES } from '../../../lyrics/ttml'
import { api } from '../../../services'

export const LYRICS_ACCEPT = '.ttml,.lrc,.xml,.dfxp,application/ttml+xml,text/xml,application/xml'
const LYRICS_EXT = /\.(ttml|xml|dfxp|lrc)$/i

/** True for file names the importer accepts (.ttml, .xml, .dfxp, .lrc). */
export function isLyricsFileName(name: string): boolean {
  return LYRICS_EXT.test(name)
}

/** Reads a text file (File.text where available, FileReader otherwise). Rejects files over 1 MiB before reading. */
export function readLyricsFile(file: Blob): Promise<string> {
  if (file.size > MAX_LYRICS_BYTES) return Promise.reject(new Error('The file is larger than 1 MiB.'))
  if (file.size === 0) return Promise.reject(new Error('The file is empty.'))
  if (typeof file.text === 'function') return file.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'))
    reader.readAsText(file)
  })
}

export interface LoadedLyricsFile {
  name: string
  content: string
  desc: LyricsFileDescription
}

/** Reads and describes a lyrics file. Never rejects: unreadable files come back invalid with `desc.error`. */
export async function loadLyricsFile(file: { name: string } & Blob): Promise<LoadedLyricsFile> {
  if (!isLyricsFileName(file.name)) {
    return { name: file.name, content: '', desc: { format: 'lrc', valid: false, error: 'Not a lyrics file (.ttml, .xml or .lrc).' } }
  }
  try {
    const content = await readLyricsFile(file)
    return { name: file.name, content, desc: describeLyricsFile(file.name, content) }
  } catch (err) {
    const error = err instanceof Error && err.message ? err.message : 'Could not read the file.'
    return { name: file.name, content: '', desc: { format: file.name.toLowerCase().endsWith('.lrc') ? 'lrc' : 'ttml', valid: false, error } }
  }
}

/** Stores lyrics on the server and refreshes everything that may have cached the old ones. */
export async function saveLyrics(trackId: string, format: LyricsFormat, content: string, opts: { skipResources?: boolean } = {}): Promise<void> {
  await api.adminSetLyrics(trackId, { format, content })
  invalidateLyrics(trackId)
  if (!opts.skipResources) resources.invalidate('')
}

/** Removes stored lyrics and refreshes caches. */
export async function removeLyrics(trackId: string): Promise<void> {
  await api.adminDeleteLyrics(trackId)
  invalidateLyrics(trackId)
  resources.invalidate('')
}

/** Validates a chosen file client-side (same rules as the server) and stores it. Throws a readable Error. */
export async function uploadLyricsFile(trackId: string, file: { name: string } & Blob): Promise<LyricsFormat> {
  const loaded = await loadLyricsFile(file)
  if (!loaded.desc.valid) throw new Error(loaded.desc.error ?? 'Not a valid lyrics file.')
  await saveLyrics(trackId, loaded.desc.format, loaded.content)
  return loaded.desc.format
}
