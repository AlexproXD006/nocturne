// Deterministic SVG cover art generated from the entity id.

import { escapeXml, hash32, rngFor } from './util.mjs'

function wrap(text, maxChars, maxLines) {
  const words = String(text).split(/\s+/).filter(Boolean)
  const lines = []
  let cur = ''
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > maxChars) {
      lines.push(cur)
      cur = w
    } else {
      cur = cur ? `${cur} ${w}` : w
    }
  }
  if (cur) lines.push(cur)
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines)
    kept[maxLines - 1] = kept[maxLines - 1].replace(/\s*\S{0,3}$/, '') + '...'
    return kept
  }
  return lines
}

function initials(name) {
  const parts = String(name).split(/\s+/).filter(Boolean)
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : String(name).slice(0, 2)).toUpperCase()
}

/**
 * @param {'album'|'artist'|'playlist'|'user'} kind
 * @param {string} id
 * @param {{title:string, subtitle?:string}} label
 * @param {number} size rendered pixel size
 */
export function renderArt(kind, id, label, size = 640) {
  const rng = rngFor(`art:${kind}:${id}`)
  const h1 = hash32(id) % 360
  const h2 = (h1 + 40 + Math.floor(rng() * 90)) % 360
  const angle = Math.floor(rng() * 360)
  const c1 = `hsl(${h1} 62% 42%)`
  const c2 = `hsl(${h2} 70% 20%)`
  const accent = `hsl(${(h1 + 180) % 360} 80% 70%)`

  let shapes = ''
  const count = 4 + Math.floor(rng() * 3)
  for (let i = 0; i < count; i++) {
    const cx = Math.round(rng() * 640)
    const cy = Math.round(rng() * 640)
    const r = Math.round(90 + rng() * 240)
    const opacity = (0.08 + rng() * 0.16).toFixed(2)
    if (rng() < 0.5) shapes += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff" fill-opacity="${opacity}"/>`
    else shapes += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#fff" stroke-opacity="${opacity}" stroke-width="${Math.round(4 + rng() * 14)}"/>`
  }
  const sunX = Math.round(380 + rng() * 200)
  const sunY = Math.round(110 + rng() * 150)
  shapes += `<circle cx="${sunX}" cy="${sunY}" r="${Math.round(44 + rng() * 40)}" fill="${accent}" fill-opacity="0.85"/>`
  shapes += `<path d="M0 ${Math.round(470 + rng() * 60)} Q 320 ${Math.round(380 + rng() * 80)} 640 ${Math.round(470 + rng() * 80)} V640 H0 Z" fill="#000" fill-opacity="0.28"/>`

  let text = ''
  if (kind === 'artist' || kind === 'user') {
    text = `<text x="320" y="368" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="220" fill="#fff" fill-opacity="0.95">${escapeXml(initials(label.title))}</text>`
  } else {
    const lines = wrap(label.title, kind === 'album' ? 14 : 13, 4)
    const fs = lines.length > 3 ? 52 : 62
    const startY = 640 - 56 - (lines.length - 1) * (fs + 6)
    text += lines
      .map((l, i) => `<text x="44" y="${startY + i * (fs + 6)}" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="${fs}" fill="#fff">${escapeXml(l)}</text>`)
      .join('')
    const sub = kind === 'playlist' ? 'PLAYLIST' : (label.subtitle || '').toUpperCase()
    if (sub) text += `<text x="44" y="78" font-family="Helvetica, Arial, sans-serif" font-weight="600" font-size="26" letter-spacing="3" fill="#fff" fill-opacity="0.8">${escapeXml(sub.length > 26 ? sub.slice(0, 25) + '...' : sub)}</text>`
  }

  const gx = (50 + 50 * Math.cos((angle * Math.PI) / 180)).toFixed(1)
  const gy = (50 + 50 * Math.sin((angle * Math.PI) / 180)).toFixed(1)
  const gx2 = (100 - gx).toFixed(1)
  const gy2 = (100 - gy).toFixed(1)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 640 640" role="img">` +
    `<title>${escapeXml(label.title)}</title>` +
    `<defs><linearGradient id="g" x1="${gx}%" y1="${gy}%" x2="${gx2}%" y2="${gy2}%"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>` +
    `<clipPath id="c"><rect width="640" height="640" rx="${kind === 'artist' || kind === 'user' ? 320 : 0}"/></clipPath></defs>` +
    `<g clip-path="url(#c)"><rect width="640" height="640" fill="url(#g)"/>${shapes}${text}</g></svg>`
  )
}
