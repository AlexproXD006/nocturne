// Validation of uploaded audio: extension + magic bytes (no decoding), plus a best-effort duration.

import { HttpError } from './auth.mjs'

const EXT = {
  mp3: { format: 'mp3', mime: 'audio/mpeg', kinds: ['mp3'] },
  aac: { format: 'aac', mime: 'audio/aac', kinds: ['mp3', 'aac'] },
  m4a: { format: 'm4a', mime: 'audio/mp4', kinds: ['m4a'] },
  flac: { format: 'flac', mime: 'audio/flac', kinds: ['flac'] },
  ogg: { format: 'ogg', mime: 'audio/ogg', kinds: ['ogg'] },
  oga: { format: 'ogg', mime: 'audio/ogg', kinds: ['ogg'] },
  opus: { format: 'opus', mime: 'audio/ogg', kinds: ['ogg'] },
  wav: { format: 'wav', mime: 'audio/wav', kinds: ['wav'] }
}

export const AUDIO_EXTENSIONS = Object.keys(EXT)

/** Detects the container from the first bytes. Returns 'mp3' | 'aac' | 'm4a' | 'flac' | 'ogg' | 'wav' | null. */
export function sniff(data) {
  if (data.length < 4) return null
  const head = data.subarray(0, 4).toString('latin1')
  if (head === 'fLaC') return 'flac'
  if (head === 'OggS') return 'ogg'
  if (head === 'RIFF' && data.length >= 12 && data.subarray(8, 12).toString('latin1') === 'WAVE') return 'wav'
  if (data.length >= 8 && data.subarray(4, 8).toString('latin1') === 'ftyp') return 'm4a'
  if (head.startsWith('ID3')) return 'mp3'
  if (data[0] === 0xff && (data[1] & 0xe0) === 0xe0) {
    // ADTS (AAC) has layer bits 00; MPEG audio frames use layer 01..11.
    return (data[1] & 0x06) === 0 ? 'aac' : 'mp3'
  }
  return null
}

export function extensionOf(filename) {
  const m = /\.([A-Za-z0-9]{2,5})$/.exec(filename)
  return m ? m[1].toLowerCase() : ''
}

function estimateDuration(kind, data) {
  try {
    if (kind === 'wav') {
      let p = 12
      let byteRate = 0
      while (p + 8 <= data.length) {
        const id = data.subarray(p, p + 4).toString('latin1')
        const size = data.readUInt32LE(p + 4)
        if (id === 'fmt ' && p + 20 <= data.length) byteRate = data.readUInt32LE(p + 16)
        if (id === 'data') return byteRate > 0 ? Math.max(1, Math.round(Math.min(size, data.length - p - 8) / byteRate)) : 0
        p += 8 + size + (size & 1)
      }
    } else if (kind === 'flac' && data.length >= 26) {
      const rate = (data[18] << 12) | (data[19] << 4) | (data[20] >> 4)
      const samples = (data[21] & 0x0f) * 2 ** 32 + data.readUInt32BE(22)
      if (rate > 0 && samples > 0) return Math.max(1, Math.round(samples / rate))
    }
  } catch {
    /* fall through to the estimate */
  }
  return Math.max(1, Math.round((data.length * 8) / 192_000)) // assume ~192 kbps
}

/**
 * @returns {{format:string, mime:string, duration:number}}
 * @throws {HttpError} 400 for empty files, 415 for unsupported extension or content
 */
export function inspectAudio(filename, data) {
  const ext = extensionOf(filename)
  const spec = EXT[ext]
  if (!spec) throw new HttpError(415, `Unsupported file type. Allowed: ${AUDIO_EXTENSIONS.join(', ')}.`)
  if (data.length === 0) throw new HttpError(400, 'The file is empty.')
  const kind = sniff(data)
  if (!kind || !spec.kinds.includes(kind)) throw new HttpError(415, 'The file content is not valid audio for its extension.')
  return { format: spec.format, mime: spec.mime, duration: estimateDuration(kind, data) }
}

/** "Artist - Title.ext" -> { artist, title }. */
export function parseUploadName(filename) {
  const base = filename.replace(/\\/g, '/').split('/').pop() ?? ''
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/\.[A-Za-z0-9]{2,5}$/, '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim()
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(clean)
  const artist = (m ? m[1] : 'Unknown Artist').trim().slice(0, 120) || 'Unknown Artist'
  const title = (m ? m[2] : clean).trim().slice(0, 160) || 'Untitled'
  return { artist, title }
}
