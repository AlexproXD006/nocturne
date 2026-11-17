// The mutable, per-server library. It starts as a deep copy of the immutable demo catalog
// (catalog.mjs) and has the same shape, so the JSON serializers work on it unchanged.
// Admin operations (downloads, uploads, deletes, restores) mutate it in place.

import { fold, hash32, randInt, rngFor, slugify } from './util.mjs'
import { SAMPLE_RATE } from './audio.mjs'
import { buildTtml } from './ttml.mjs'

const wavSize = (duration) => 44 + Math.round(duration * SAMPLE_RATE) * 2

/** Rebuilds the id maps and search strings after any structural change. */
export function reindex(lib) {
  lib.artistById = new Map(lib.artists.map((a) => [a.id, a]))
  lib.albumById = new Map(lib.albums.map((a) => [a.id, a]))
  lib.trackById = new Map(lib.tracks.map((t) => [t.id, t]))
  lib.playlistById = new Map(lib.playlists.map((p) => [p.id, p]))
  for (const a of lib.artists) a.search = fold(a.name)
  for (const a of lib.albums) a.search = fold(`${a.title} ${lib.artistById.get(a.artistId)?.name ?? ''}`)
  for (const p of lib.playlists) p.search = fold(`${p.name} ${p.description}`)
  for (const t of lib.tracks) {
    t.search = fold(`${t.title} ${t.artistIds.map((id) => lib.artistById.get(id)?.name ?? '').join(' ')} ${lib.albumById.get(t.albumId)?.title ?? ''}`)
  }
}

/**
 * Deep-copies the base catalog into a mutable library and decorates every track with the
 * admin metadata (addedAt, plays, format, sizeBytes). Fully deterministic.
 */
export function createLibrary(base) {
  const data = structuredClone({ artists: base.artists, albums: base.albums, tracks: base.tracks, playlists: base.playlists, defaults: base.defaults })
  const lib = { ...data, uploads: new Map(), counter: 0 }
  const albumById = new Map(lib.albums.map((a) => [a.id, a]))
  for (const t of lib.tracks) {
    const year = albumById.get(t.albumId)?.year ?? 2024
    const h = hash32(t.id)
    t.addedAt = new Date(Date.UTC(year, h % 12, 1 + ((h >>> 4) % 27), 8 + ((h >>> 9) % 12), (h >>> 14) % 60)).toISOString()
    t.plays = Math.floor(t.popularity * 240)
    t.format = 'wav'
    t.mime = 'audio/wav'
    t.sizeBytes = wavSize(t.duration)
  }
  reindex(lib)
  // ~10 seeded tracks carry a stored TTML (word timing, duet, background vocals).
  const synced = lib.tracks.filter((t) => t.lyricsMode === 'synced' && t.duration >= 90).sort((a, b) => (a.id < b.id ? -1 : 1))
  const step = Math.max(1, Math.floor(synced.length / 10))
  for (let i = 0, n = 0; i < synced.length && n < 10; i += step, n++) {
    const t = synced[i]
    const content = buildTtml(t, lib.artistById.get(t.artistIds[0]).name)
    if (content) t.lyricsStored = { format: 'ttml', content, updatedAt: t.addedAt }
  }
  return lib
}

function uniqueId(map, base) {
  let id = base
  for (let n = 2; map.has(id); n++) id = `${base}-${n}`
  return id
}

export function ensureArtist(lib, name) {
  const key = fold(name)
  const found = lib.artists.find((a) => fold(a.name) === key)
  if (found) return found
  const rng = rngFor(`artist:${name}`)
  const artist = {
    id: uniqueId(lib.artistById, `ar-${slugify(name) || 'artist'}`),
    name,
    bio: `${name} was added through the Nocturne admin tools. This mock server has no real biography for this artist.`,
    followers: randInt(rng, 800, 900_000),
    albumIds: [],
    trackIds: [],
    search: key
  }
  lib.artists.push(artist)
  lib.artistById.set(artist.id, artist)
  lib.defaults.libraryArtistIds.unshift(artist.id)
  return artist
}

export function ensureAlbum(lib, { title, artistId, year, type }) {
  const key = fold(title)
  const found = lib.albums.find((a) => a.artistId === artistId && fold(a.title) === key)
  if (found) return found
  const album = {
    id: uniqueId(lib.albumById, `al-${slugify(title) || 'album'}`),
    title,
    artistId,
    year,
    type,
    trackIds: [],
    search: ''
  }
  lib.albums.push(album)
  lib.albumById.set(album.id, album)
  lib.artistById.get(artistId).albumIds.push(album.id)
  lib.defaults.libraryAlbumIds.unshift(album.id)
  return album
}

/**
 * Adds one track (creating its artist and album when needed).
 * @param {object} spec title, artistName, albumTitle, albumType, year, duration, now (ISO string),
 *   format, mime, sizeBytes, lyricsMode, explicit, upload ({data}) for stored audio; without upload
 *   the audio is synthesized from `music`.
 */
export function addTrack(lib, spec) {
  const artist = ensureArtist(lib, spec.artistName)
  const album = ensureAlbum(lib, { title: spec.albumTitle, artistId: artist.id, year: spec.year, type: spec.albumType })
  const number = album.trackIds.length + 1
  const id = uniqueId(lib.trackById, `tr-${album.id.slice(3)}-${String(number).padStart(2, '0')}`)
  const rng = rngFor(`newtrack:${id}`)
  const duration = Math.max(1, Math.round(spec.duration))
  const track = {
    id,
    title: spec.title,
    artistIds: [artist.id],
    albumId: album.id,
    duration,
    trackNumber: number,
    explicit: spec.explicit ?? false,
    popularity: rng(),
    lyricsMode: spec.lyricsMode ?? 'none',
    music: {
      seed: `${id}:new`,
      bpm: randInt(rng, 84, 120),
      mode: rng() < 0.5 ? 'minor' : 'major',
      root: randInt(rng, 0, 11),
      prog: randInt(rng, 0, 2)
    },
    addedAt: spec.now,
    plays: 0,
    format: spec.format ?? 'wav',
    mime: spec.mime ?? 'audio/wav',
    sizeBytes: spec.upload ? spec.upload.data.length : (spec.sizeBytes ?? wavSize(duration)),
    search: fold(`${spec.title} ${artist.name} ${album.title}`)
  }
  lib.tracks.push(track)
  lib.trackById.set(id, track)
  album.trackIds.push(id)
  artist.trackIds.push(id)
  album.search = fold(`${album.title} ${artist.name}`)
  if (spec.upload) lib.uploads.set(id, spec.upload)
  return track
}

/** Removes a track from the library, its album/artist (when they become empty), playlists and defaults. */
export function removeTrack(lib, id) {
  const track = lib.trackById.get(id)
  if (!track) return false
  lib.tracks.splice(lib.tracks.indexOf(track), 1)
  lib.uploads.delete(id)
  const album = lib.albumById.get(track.albumId)
  if (album) {
    album.trackIds = album.trackIds.filter((t) => t !== id)
    if (album.trackIds.length === 0) {
      lib.albums.splice(lib.albums.indexOf(album), 1)
      lib.defaults.libraryAlbumIds = lib.defaults.libraryAlbumIds.filter((a) => a !== album.id)
      const owner = lib.artistById.get(album.artistId)
      if (owner) owner.albumIds = owner.albumIds.filter((a) => a !== album.id)
    }
  }
  for (const aid of track.artistIds) {
    const artist = lib.artistById.get(aid)
    if (!artist) continue
    artist.trackIds = artist.trackIds.filter((t) => t !== id)
    if (artist.trackIds.length === 0 && artist.albumIds.length === 0) {
      lib.artists.splice(lib.artists.indexOf(artist), 1)
      lib.defaults.libraryArtistIds = lib.defaults.libraryArtistIds.filter((a) => a !== artist.id)
    }
  }
  for (const p of lib.playlists) p.trackIds = p.trackIds.filter((t) => t !== id)
  lib.defaults.likedTrackIds = lib.defaults.likedTrackIds.filter((t) => t !== id)
  lib.defaults.recentTrackIds = lib.defaults.recentTrackIds.filter((t) => t !== id)
  reindex(lib)
  return true
}

export function addPlaylist(lib, { name, description, trackIds }) {
  const playlist = {
    id: uniqueId(lib.playlistById, `pl-${slugify(name) || 'playlist'}`),
    name,
    description,
    trackIds: [...new Set(trackIds)],
    search: fold(`${name} ${description}`)
  }
  lib.playlists.push(playlist)
  lib.playlistById.set(playlist.id, playlist)
  lib.defaults.libraryPlaylistIds.push(playlist.id)
  return playlist
}

export function storageBytes(lib) {
  let sum = 0
  for (const t of lib.tracks) sum += t.sizeBytes
  return sum
}

export function uploadedBytes(lib) {
  let sum = 0
  for (const u of lib.uploads.values()) sum += u.data.length
  return sum
}

// ---- Snapshots (backups) ---------------------------------------------------------

const DATA_KEYS = ['artists', 'albums', 'tracks', 'playlists', 'defaults']

/** Snapshot of the catalog ids/metadata. Uploaded audio buffers are shared by reference, not copied. */
export function snapshotLibrary(lib) {
  const data = structuredClone(Object.fromEntries(DATA_KEYS.map((k) => [k, lib[k]])))
  return { data, uploads: new Map(lib.uploads) }
}

export function restoreLibrary(lib, snap) {
  const data = structuredClone(snap.data)
  for (const k of DATA_KEYS) lib[k] = data[k]
  lib.uploads = new Map(snap.uploads)
  reindex(lib)
}

export function snapshotSize(snap) {
  let size = Buffer.byteLength(JSON.stringify(snap.data))
  for (const u of snap.uploads.values()) size += u.data.length
  return size
}

