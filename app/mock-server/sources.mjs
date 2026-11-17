// Invented "Spotify" and "YouTube" sources for the admin API. Nothing here ever touches the
// network: search results, links and downloadable items are all generated locally and
// deterministically from the query / id / link.

import { HttpError } from './auth.mjs'
import { getCatalog, trackTitle } from './catalog.mjs'
import { capitalize, fold, pick, randInt, rngFor, slugify } from './util.mjs'

export const SOURCES = ['spotify', 'youtube']
export const KINDS = ['track', 'album', 'playlist']

const ARTISTS = [
  'Marlow Quay', 'The Velvet Ordinance', 'Ines Calloway', 'Pale Harbor Radio', 'Juniper Wake', 'Tomo Ishikari',
  'Echo Parade', 'Silk & Cinder', 'Wren Alder', 'North Fork Choir', 'Mira Solenne', 'Cobalt Orchard',
  'Dusk Cartel', 'Halcyon Drift', 'Rook & Rain', 'Sable Meridian', 'Odalys Fen', 'The Lantern Index',
  'Pier Nine', 'Quiet Colony', 'Aurelio Brandt', 'Fable Season', 'Teal Antenna', 'Nova Mercer'
]
const CURATORS = ['Nocturne Editors', 'Night Shift Radio', 'Late Lamp Collective', 'Signal Garden', 'The Slow Hour']
const ALBUM_WORDS = ['Almanac', 'Letters', 'Weather', 'Rooms', 'Atlas', 'Currents', 'Reveries', 'Tapes', 'Postcards', 'Daybreak']
const PLAYLIST_WORDS = ['Essentials', 'Mix', 'Radio', 'Sessions', 'Rotation', 'Deep Cuts']

const ID_RE = /^(spotify|youtube):(track|album|playlist):(\d{1,3}):([a-z0-9-]{0,40})$/

const titleCase = (s) => s.split(/\s+/).filter(Boolean).map(capitalize).join(' ')
const alnum = (rng, n, alphabet) => Array.from({ length: n }, () => alphabet[Math.floor(rng() * alphabet.length)]).join('')
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const B64URL = `${B62}_-`

/** Builds the public page URL of an item (a plausible-looking but invented link, never fetched). */
function pageUrl(source, kind, ext) {
  if (source === 'spotify') return `https://open.spotify.com/${kind}/${ext}`
  if (kind === 'track') return `https://www.youtube.com/watch?v=${ext}`
  return `https://www.youtube.com/playlist?list=${ext}`
}

function externalId(rng, source, kind) {
  if (source === 'spotify') return alnum(rng, 22, B62)
  if (kind === 'track') return alnum(rng, 11, B64URL)
  return `${kind === 'album' ? 'OLAK5uy_' : 'PL'}${alnum(rng, 24, B64URL)}`
}

/**
 * Describes an item deterministically.
 * @param {{source:string, kind:string, seed:string, words?:string, slot?:number, ext?:string}} p
 *   `words` is the (slug-derived) query used to flavour titles; `slot` selects catalog matches.
 * @returns {{source, kind, title, artist, album?, duration?, ext, url, tracks: {title:string, artist:string, duration:number}[], fail: boolean}}
 */
export function describeItem({ source, kind, seed, words = '', slot = -1, ext }) {
  const rng = rngFor(`item:${seed}`)
  const base = getCatalog()
  const q = fold(words).trim()
  const externalKey = ext ?? externalId(rng, source, kind)
  const item = { source, kind, ext: externalKey, url: pageUrl(source, kind, externalKey), fail: /fail/i.test(externalKey) || /fail/.test(q) }

  // Every third item of a kind mirrors something that already exists in the demo catalog
  // (when the query matches it) so "inLibrary" results exist.
  if (slot >= 0 && slot % 3 === 0 && q) {
    const n = slot / 3
    if (kind === 'track') {
      const hit = base.tracks.filter((t) => t.search.includes(q))[n]
      if (hit) {
        const album = base.albumById.get(hit.albumId)
        const artist = base.artistById.get(hit.artistIds[0])
        return { ...item, title: hit.title, artist: artist.name, album: album.title, duration: hit.duration, tracks: [{ title: hit.title, artist: artist.name, duration: hit.duration }] }
      }
    } else if (kind === 'album') {
      const hit = base.albums.filter((a) => a.search.includes(q))[n]
      if (hit) {
        const artist = base.artistById.get(hit.artistId)
        const tracks = hit.trackIds.map((id) => base.trackById.get(id)).map((t) => ({ title: t.title, artist: artist.name, duration: t.duration }))
        return { ...item, title: hit.title, artist: artist.name, album: hit.title, tracks }
      }
    } else {
      const hit = base.playlists.filter((p) => p.search.includes(q))[n]
      if (hit) {
        const tracks = hit.trackIds.map((id) => base.trackById.get(id)).map((t) => ({ title: t.title, artist: base.artistById.get(t.artistIds[0]).name, duration: t.duration }))
        return { ...item, title: hit.name, artist: pick(rng, CURATORS), tracks }
      }
    }
  }

  const Q = titleCase(q)
  const flavour = (fallback) => {
    if (!Q) return fallback
    switch (Math.floor(rng() * 4)) {
      case 0: return Q
      case 1: return `${Q} ${pick(rng, ['Hours', 'Signals', 'Glass', 'Season', 'Lights'])}`
      case 2: return `${pick(rng, ['Paper', 'Distant', 'Midnight', 'Amber', 'Soft'])} ${Q}`
      default: return fallback
    }
  }
  const usedTitles = new Set()
  const freshTitle = () => {
    let t = trackTitle(rng)
    for (let g = 0; usedTitles.has(fold(t)) && g < 30; g++) t = trackTitle(rng)
    usedTitles.add(fold(t))
    return t
  }
  const dur = () => randInt(rng, 90, 150)

  if (kind === 'track') {
    const title = flavour(freshTitle())
    const artist = pick(rng, ARTISTS)
    const duration = dur()
    return { ...item, title, artist, album: rng() < 0.7 ? `${pick(rng, ['Soft', 'Late', 'Open', 'Blue'])} ${pick(rng, ALBUM_WORDS)}` : undefined, duration, tracks: [{ title, artist, duration }] }
  }
  if (kind === 'album') {
    const artist = pick(rng, ARTISTS)
    const title = Q && rng() < 0.6 ? `${Q} ${pick(rng, ALBUM_WORDS)}` : `${pick(rng, ['Quiet', 'Golden', 'Distant', 'Neon'])} ${pick(rng, ALBUM_WORDS)}`
    const count = randInt(rng, 4, 8)
    const tracks = Array.from({ length: count }, () => ({ title: freshTitle(), artist, duration: dur() }))
    return { ...item, title, artist, album: title, tracks }
  }
  const curator = pick(rng, CURATORS)
  const title = Q ? `${Q} ${pick(rng, PLAYLIST_WORDS)}` : `${pick(rng, ['Evening', 'Slow', 'Window', 'Rooftop'])} ${pick(rng, PLAYLIST_WORDS)}`
  const count = randInt(rng, 6, 10)
  const tracks = Array.from({ length: count }, () => ({ title: freshTitle(), artist: pick(rng, ARTISTS), duration: dur() }))
  return { ...item, title, artist: curator, tracks }
}

/** Parses a result id produced by search (`spotify:album:3:glass-meridian`). */
export function parseResultId(id) {
  const m = typeof id === 'string' ? ID_RE.exec(id) : null
  if (!m) return null
  return { source: m[1], kind: m[2], slot: Number(m[3]), words: m[4].replace(/-/g, ' ') }
}

export function itemFromResultId(id) {
  const p = parseResultId(id)
  if (!p) throw new HttpError(400, 'Unknown result id.')
  return describeItem({ source: p.source, kind: p.kind, seed: id, words: p.words, slot: p.slot })
}

/** Deterministic search results (8-15) for a source and query. `libraryHas(kind, title)` marks inLibrary. */
export function searchSource(source, query, { origin, libraryHas }) {
  const q = fold(query).trim()
  if (!q) return []
  const qslug = slugify(q).slice(0, 40).replace(/-+$/, '')
  const rng = rngFor(`search:${source}:${qslug}`)
  const count = randInt(rng, 8, 15)
  const kinds = []
  for (let i = 0; i < count; i++) {
    if (i === 0) kinds.push('track')
    else if (i === 1) kinds.push('album')
    else if (i === 2) kinds.push('playlist')
    else {
      const r = rng()
      kinds.push(r < 0.6 ? 'track' : r < 0.82 ? 'album' : 'playlist')
    }
  }
  const nextSlot = { track: 0, album: 0, playlist: 0 }
  return kinds.map((kind) => {
    const slot = nextSlot[kind]++
    const id = `${source}:${kind}:${slot}:${qslug}`
    const item = itemFromResultId(id)
    return {
      id,
      source,
      kind,
      title: item.title,
      artist: item.artist,
      ...(item.album ? { album: item.album } : {}),
      ...(item.duration ? { duration: item.duration } : {}),
      artworkUrl: `${origin}/art/source/${encodeURIComponent(id)}.svg?s=300`,
      url: item.url,
      inLibrary: libraryHas(kind, item.title)
    }
  })
}

/** Parses a pasted Spotify / YouTube link. Returns null when it is not a supported link. */
export function parseSourceUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return null
  let u
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  if (host === 'open.spotify.com') {
    const m = /^\/(?:intl-[a-z-]+\/)?(track|album|playlist)\/([A-Za-z0-9]{10,32})\/?$/.exec(u.pathname)
    return m ? { source: 'spotify', kind: m[1], ext: m[2] } : null
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    if (u.pathname === '/watch') {
      const v = u.searchParams.get('v') ?? ''
      return /^[A-Za-z0-9_-]{11}$/.test(v) ? { source: 'youtube', kind: 'track', ext: v } : null
    }
    if (u.pathname === '/playlist') {
      const list = u.searchParams.get('list') ?? ''
      if (!/^[A-Za-z0-9_-]{10,64}$/.test(list)) return null
      return { source: 'youtube', kind: list.startsWith('OLAK5uy') ? 'album' : 'playlist', ext: list }
    }
    return null
  }
  if (host === 'youtu.be') {
    const m = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(u.pathname)
    return m ? { source: 'youtube', kind: 'track', ext: m[1] } : null
  }
  return null
}

export function itemFromUrl(parsed) {
  return describeItem({ source: parsed.source, kind: parsed.kind, seed: `url:${parsed.source}:${parsed.kind}:${parsed.ext}`, ext: parsed.ext })
}
