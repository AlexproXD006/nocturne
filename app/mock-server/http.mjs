// Shared HTTP helpers for the mock server modules.

import { HttpError } from './auth.mjs'

export const MAX_BODY = 64 * 1024
export const SECURITY_HEADERS = { 'X-Content-Type-Options': 'nosniff' }

export function sendJson(res, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': payload.length,
    ...headers
  })
  res.end(payload)
}

export function sendNoContent(res, headers = {}) {
  res.writeHead(204, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', ...headers })
  res.end()
}

export async function readJson(req, { required, max = MAX_BODY }) {
  const tooLarge = () => new HttpError(413, `Request body too large (limit ${max >= 1024 * 1024 ? `${max / 1024 / 1024} MB` : `${max / 1024} KB`}).`, { Connection: 'close' })
  const declared = req.headers['content-length']
  if (declared !== undefined && Number(declared) > max) throw tooLarge()
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > max) throw tooLarge()
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) {
    if (required) throw new HttpError(400, 'A JSON request body is required.')
    return {}
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new HttpError(400, 'Invalid JSON in request body.')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'The request body must be a JSON object.')
  return parsed
}

export function intParam(query, name, def, min, max) {
  const raw = query.get(name)
  if (raw === null || raw === '') return def
  if (!/^\d{1,9}$/.test(raw)) throw new HttpError(400, `"${name}" must be a non-negative integer.`)
  const n = Number(raw)
  if (n < min || n > max) throw new HttpError(400, `"${name}" must be between ${min} and ${max}.`)
  return n
}

export function page(all, query, serialize) {
  const offset = intParam(query, 'offset', 0, 0, 1_000_000)
  const limit = intParam(query, 'limit', 50, 1, 200)
  return { items: all.slice(offset, offset + limit).map(serialize), offset, limit, total: all.length }
}

/** Parses an HTTP Range header for a resource of `size` bytes. */
export function parseRange(header, size) {
  if (!header) return { kind: 'none' }
  const m = /^bytes=(.*)$/i.exec(header.trim())
  if (!m) return { kind: 'none' } // unknown range unit: ignored per RFC 9110
  const spec = m[1].trim()
  if (spec.includes(',')) return { kind: 'none' } // multi-range: serve the full body
  const r = /^(\d{0,15})-(\d{0,15})$/.exec(spec)
  if (!r || (r[1] === '' && r[2] === '')) return { kind: 'invalid' }
  if (r[1] === '') {
    const n = Number(r[2])
    if (n === 0) return { kind: 'invalid' }
    return { kind: 'range', start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(r[1])
  if (start >= size) return { kind: 'invalid' }
  const end = r[2] === '' ? size - 1 : Math.min(Number(r[2]), size - 1)
  if (end < start) return { kind: 'invalid' }
  return { kind: 'range', start, end }
}
