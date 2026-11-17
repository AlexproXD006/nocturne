// Streaming multipart/form-data reader that keeps only the "file" part in memory and enforces
// size limits while the body is still being received.

import { HttpError } from './auth.mjs'

const OVERHEAD = 1024 * 1024 // allowance for boundaries, headers and the other (ignored) fields
const MAX_HEADER = 16 * 1024

function parseHeaders(text) {
  const headers = {}
  for (const line of text.split('\r\n')) {
    const i = line.indexOf(':')
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  const disp = headers['content-disposition'] ?? ''
  const name = /(?:^|;)\s*name="([^"]*)"/i.exec(disp)?.[1]
  const filename = /;\s*filename="([^"]*)"/i.exec(disp)?.[1]
  return { name, filename, type: headers['content-type'] }
}

/**
 * Reads the first part named "file" of a multipart/form-data request.
 * @param {import('node:http').IncomingMessage} req
 * @param {{maxFileBytes:number}} opts
 * @returns {Promise<{filename:string, data:Buffer, type?:string}>}
 * @throws {HttpError} 400 malformed/missing file, 413 too large
 */
export async function readMultipartFile(req, { maxFileBytes }) {
  const ct = req.headers['content-type'] ?? ''
  const bm = /^multipart\/form-data\s*;(?:.*;)?\s*boundary=(?:"([^"]{1,200})"|([^\s;"]{1,200}))/i.exec(ct)
  if (!bm) throw new HttpError(400, 'Expected a multipart/form-data request with a "file" field.')
  const boundary = bm[1] ?? bm[2]
  const maxTotal = maxFileBytes + OVERHEAD
  const declared = req.headers['content-length']
  if (declared !== undefined && Number(declared) > maxTotal) {
    throw new HttpError(413, `The file is too large (limit ${maxFileBytes} bytes).`, { Connection: 'close' })
  }

  const delim = Buffer.from(`\r\n--${boundary}`)
  let state = 'preamble' // preamble | afterDelim | headers | body | done
  let buf = Buffer.from('\r\n') // virtual CRLF so the first delimiter matches like the others
  let part = null
  let fileTaken = false
  let tooLarge = false
  let result = null
  let total = 0

  const emit = (slice) => {
    if (!part || !part.capture) return
    part.size += slice.length
    if (part.size > maxFileBytes) {
      tooLarge = true
      part.chunks = null
      part.capture = false
      return
    }
    part.chunks.push(Buffer.from(slice))
  }
  const finish = () => {
    if (part?.capture && part.chunks) result = { filename: part.filename, data: Buffer.concat(part.chunks), type: part.type }
    part = null
  }

  for await (const chunk of req) {
    total += chunk.length
    if (total > maxTotal) throw new HttpError(413, `The file is too large (limit ${maxFileBytes} bytes).`, { Connection: 'close' })
    if (state === 'done') continue
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
    for (;;) {
      if (state === 'preamble') {
        const idx = buf.indexOf(delim)
        if (idx < 0) {
          buf = buf.subarray(Math.max(0, buf.length - delim.length + 1))
          break
        }
        buf = buf.subarray(idx + delim.length)
        state = 'afterDelim'
      }
      if (state === 'afterDelim') {
        if (buf.length < 2) break
        if (buf[0] === 0x2d && buf[1] === 0x2d) {
          state = 'done'
          buf = Buffer.alloc(0)
          break
        }
        const eol = buf.indexOf('\r\n')
        if (eol < 0) {
          if (buf.length > 1024) throw new HttpError(400, 'Malformed multipart body.')
          break
        }
        buf = buf.subarray(eol + 2)
        state = 'headers'
      }
      if (state === 'headers') {
        const end = buf.indexOf('\r\n\r\n')
        if (end < 0) {
          if (buf.length > MAX_HEADER) throw new HttpError(400, 'Malformed multipart body.')
          break
        }
        const h = parseHeaders(buf.subarray(0, end).toString('utf8'))
        const capture = !fileTaken && h.name === 'file' && h.filename !== undefined
        if (capture) fileTaken = true
        part = { ...h, capture, size: 0, chunks: capture ? [] : null }
        buf = buf.subarray(end + 4)
        state = 'body'
      }
      if (state === 'body') {
        const idx = buf.indexOf(delim)
        if (idx >= 0) {
          emit(buf.subarray(0, idx))
          finish()
          buf = buf.subarray(idx + delim.length)
          state = 'afterDelim'
          continue
        }
        const keep = delim.length - 1
        if (buf.length > keep) {
          emit(buf.subarray(0, buf.length - keep))
          buf = buf.subarray(buf.length - keep)
        }
        break
      }
    }
  }
  if (tooLarge) throw new HttpError(413, `The file is too large (limit ${maxFileBytes} bytes).`)
  if (state !== 'done') throw new HttpError(400, 'Malformed or truncated multipart body.')
  if (!result) throw new HttpError(400, 'The multipart field "file" is required.')
  return result
}
