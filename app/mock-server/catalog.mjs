// Deterministic fictional demo catalog and the JSON serializers matching
// src/renderer/src/api/types.ts. All names are invented.

import { capitalize, fold, pick, randInt, rngFor, shuffled, slugify } from './util.mjs'

const ARTIST_DEFS = [
  { name: 'Lumen Harbor', genre: 'dreamy synth-pop', origin: 'a fog-wrapped port town' },
  { name: 'Vesper Static', genre: 'downtempo electronica', origin: 'a converted radio tower' },
  { name: 'Orla Quennell', genre: 'bedroom folktronica', origin: 'a rented attic above a bakery' },
  { name: 'Midnight Cartographers', genre: 'nocturnal indie rock', origin: 'a night-bus depot' },
  { name: 'Saffron Tides', genre: 'warm ambient soul', origin: 'a lighthouse keeper cottage' },
  { name: 'Kiro Valeen', genre: 'minimal club music', origin: 'an empty parking garage' },
  { name: 'Paper Lantern Choir', genre: 'chamber pop', origin: 'a lantern festival that never ended' },
  { name: 'Nadia Brightwater', genre: 'cinematic piano pop', origin: 'a quiet observatory' }
]

// artist index, mode, base bpm, track count; 14 albums, 110 tracks in total.
const ALBUM_DEFS = [
  { title: 'Glass Meridian', artist: 0, year: 2024, type: 'album', tracks: 10, mode: 'minor', bpm: 96 },
  { title: 'Slow Tide Almanac', artist: 0, year: 2022, type: 'album', tracks: 9, mode: 'major', bpm: 88 },
  { title: 'Neon Cartography', artist: 1, year: 2025, type: 'album', tracks: 8, mode: 'minor', bpm: 112 },
  { title: 'Paper Constellations', artist: 1, year: 2021, type: 'album', tracks: 9, mode: 'major', bpm: 100 },
  { title: 'Afterglow Protocol', artist: 2, year: 2026, type: 'album', tracks: 7, mode: 'minor', bpm: 92 },
  { title: 'Quiet Machinery', artist: 2, year: 2023, type: 'album', tracks: 10, mode: 'major', bpm: 90 },
  { title: 'Saltwater Telegrams', artist: 3, year: 2022, type: 'album', tracks: 8, mode: 'minor', bpm: 108 },
  { title: 'Hollow Sunday', artist: 3, year: 2025, type: 'album', tracks: 9, mode: 'major', bpm: 104 },
  { title: 'Orchard of Static', artist: 4, year: 2020, type: 'ep', tracks: 6, mode: 'major', bpm: 86 },
  { title: 'Velvet Hours', artist: 4, year: 2024, type: 'compilation', tracks: 8, mode: 'minor', bpm: 90 },
  { title: 'Small Hours', artist: 5, year: 2026, type: 'ep', tracks: 5, mode: 'minor', bpm: 118 },
  { title: 'The Long Dusk', artist: 6, year: 2023, type: 'album', tracks: 10, mode: 'major', bpm: 94 },
  { title: 'Lanterns in Transit', artist: 6, year: 2021, type: 'album', tracks: 7, mode: 'minor', bpm: 98 },
  { title: 'Fieldnotes from Nowhere', artist: 7, year: 2025, type: 'ep', tracks: 4, mode: 'major', bpm: 86 }
]

const PLAYLIST_DEFS = [
  { name: 'Night Drive', description: 'Low lights, long roads and steady pulses.' },
  { name: 'Focus Flow', description: 'Keep your head down. Nothing here will interrupt you.' },
  { name: 'Morning Light', description: 'Gentle starts for slow mornings.' },
  { name: 'Rainy Window', description: 'Soft pads and a cup of something warm.' },
  { name: 'Deep Pulse', description: 'Kick-forward cuts for when you need momentum.' },
  { name: 'Daily Mix 1', description: 'A rotating blend picked from across your library.' }
]

const ADJ = ['Velvet', 'Hollow', 'Electric', 'Silver', 'Quiet', 'Golden', 'Distant', 'Neon', 'Fading', 'Amber', 'Midnight', 'Paper', 'Crystal', 'Slow', 'Restless', 'Gentle', 'Borrowed', 'Wild', 'Pale', 'Endless']
const NOUN = ['Lanterns', 'Harbor', 'Static', 'Daylight', 'Echoes', 'Signals', 'Meridian', 'Orchard', 'Skyline', 'Tides', 'Constellation', 'Horizon', 'Embers', 'Postcards', 'Mirrors', 'Compass', 'Afterglow', 'Thunder', 'Windows', 'Satellites']
const NOUN2 = ['Amber', 'Motion', 'Glass', 'Rain', 'Neon', 'Dust', 'Silence', 'Salt', 'Winter', 'Smoke', 'Gravity', 'Velvet', 'Tomorrow', 'Echo', 'Moonlight']
const PREP = ['in', 'after', 'beyond', 'under', 'through', 'before', 'inside', 'above']
const VERB3 = ['Sleeps', 'Remembers', 'Wanders', 'Glows', 'Returns', 'Drifts', 'Breathes', 'Listens', 'Waits', 'Falls']
const VERBING = ['Chasing', 'Holding', 'Following', 'Counting', 'Painting', 'Borrowing', 'Rewinding', 'Crossing', 'Folding', 'Lighting']

export function trackTitle(rng) {
  switch (Math.floor(rng() * 6)) {
    case 0: return `${pick(rng, ADJ)} ${pick(rng, NOUN)}`
    case 1: return `${pick(rng, NOUN)} ${pick(rng, PREP)} ${pick(rng, NOUN2)}`
    case 2: return `The ${pick(rng, NOUN).replace(/s$/, '')} ${pick(rng, VERB3)}`
    case 3: return `${pick(rng, VERBING)} ${pick(rng, NOUN2)}`
    case 4: return `${pick(rng, NOUN2)} Hours`
    default: return `${pick(rng, ADJ)} ${pick(rng, NOUN2)}`
  }
}

let cached = null

/** Builds (once) the immutable demo catalog. */
export function getCatalog() {
  if (cached) return cached

  const artists = ARTIST_DEFS.map((d) => {
    const rng = rngFor(`artist:${d.name}`)
    return {
      id: `ar-${slugify(d.name)}`,
      name: d.name,
      bio: `${d.name} is a fictional ${d.genre} project from ${d.origin}. Every sound you hear is synthesized on the fly by the Nocturne mock server; no real recordings are involved.`,
      followers: randInt(rng, 12_000, 2_400_000),
      albumIds: [],
      trackIds: []
    }
  })

  const albums = []
  const tracks = []
  const usedTitles = new Set()

  ALBUM_DEFS.forEach((d, albumIndex) => {
    const artist = artists[d.artist]
    const album = {
      id: `al-${slugify(d.title)}`,
      title: d.title,
      artistId: artist.id,
      year: d.year,
      type: d.type,
      trackIds: []
    }
    const rng = rngFor(`album:${album.id}`)
    for (let n = 1; n <= d.tracks; n++) {
      let title = trackTitle(rng)
      for (let guard = 0; usedTitles.has(fold(title)) && guard < 50; guard++) title = trackTitle(rng)
      usedTitles.add(fold(title))
      const id = `tr-${album.id.slice(3)}-${String(n).padStart(2, '0')}`
      const artistIds = [artist.id]
      if (rng() < 0.12) {
        const others = artists.filter((a) => a.id !== artist.id)
        artistIds.push(pick(rng, others).id)
      }
      const lr = rng()
      const mode = rng() < 0.15 ? (d.mode === 'minor' ? 'major' : 'minor') : d.mode
      const track = {
        id,
        title,
        artistIds,
        albumId: album.id,
        duration: randInt(rng, 60, 150),
        trackNumber: n,
        explicit: rng() < 0.07,
        popularity: rng(),
        lyricsMode: lr < 0.16 ? 'none' : lr < 0.24 ? 'plain' : 'synced',
        music: {
          seed: `${id}:${albumIndex}`,
          bpm: Math.max(84, Math.min(120, d.bpm + randInt(rng, -8, 8))),
          mode,
          root: randInt(rng, 0, 11),
          prog: randInt(rng, 0, 2)
        }
      }
      tracks.push(track)
      album.trackIds.push(id)
      for (const aid of artistIds) artists.find((a) => a.id === aid).trackIds.push(id)
    }
    artist.albumIds.push(album.id)
    albums.push(album)
  })

  const playlists = PLAYLIST_DEFS.map((d) => {
    const rng = rngFor(`playlist:${d.name}`)
    const count = randInt(rng, 16, 26)
    return {
      id: `pl-${slugify(d.name)}`,
      name: d.name,
      description: d.description,
      trackIds: shuffled(rng, tracks).slice(0, count).map((t) => t.id)
    }
  })

  const rng = rngFor('defaults')
  const defaults = {
    likedTrackIds: shuffled(rng, tracks).slice(0, 14).map((t) => t.id),
    libraryAlbumIds: shuffled(rng, albums).slice(0, 8).map((a) => a.id),
    libraryArtistIds: shuffled(rng, artists).slice(0, 5).map((a) => a.id),
    libraryPlaylistIds: playlists.map((p) => p.id),
    recentTrackIds: shuffled(rng, tracks).slice(0, 12).map((t) => t.id)
  }

  for (const t of tracks) t.search = fold(`${t.title} ${t.artistIds.map((id) => artists.find((a) => a.id === id).name).join(' ')} ${albums.find((a) => a.id === t.albumId).title}`)

  cached = {
    artists,
    albums,
    tracks,
    playlists,
    defaults,
    artistById: new Map(artists.map((a) => [a.id, a])),
    albumById: new Map(albums.map((a) => [a.id, a])),
    trackById: new Map(tracks.map((t) => [t.id, t])),
    playlistById: new Map(playlists.map((p) => [p.id, p]))
  }
  for (const a of artists) a.search = fold(a.name)
  for (const a of albums) a.search = fold(`${a.title} ${cached.artistById.get(a.artistId).name}`)
  for (const p of playlists) p.search = fold(`${p.name} ${p.description}`)
  return cached
}

// ---- Serializers (shape = src/renderer/src/api/types.ts) -------------------

export const PLAYLIST_OWNER = { id: 'nocturne', name: 'Nocturne' }

export function artwork(origin, kind, id) {
  return [300, 640].map((size) => ({ url: `${origin}/art/${kind}/${encodeURIComponent(id)}.svg?s=${size}`, width: size, height: size }))
}

/** ctx = { catalog, origin, liked: Set<string> } */
export function trackJson(ctx, t) {
  const album = ctx.catalog.albumById.get(t.albumId)
  return {
    id: t.id,
    title: t.title,
    artists: t.artistIds.map((id) => ({ id, name: ctx.catalog.artistById.get(id).name })),
    album: { id: album.id, title: album.title },
    duration: t.duration,
    artwork: artwork(ctx.origin, 'album', album.id),
    explicit: t.explicit,
    trackNumber: t.trackNumber,
    discNumber: 1,
    liked: ctx.liked.has(t.id)
  }
}

export function albumJson(ctx, a) {
  const artist = ctx.catalog.artistById.get(a.artistId)
  return {
    id: a.id,
    title: a.title,
    artists: [{ id: artist.id, name: artist.name }],
    year: a.year,
    artwork: artwork(ctx.origin, 'album', a.id),
    trackCount: a.trackIds.length,
    type: a.type
  }
}

export function albumDetailJson(ctx, a) {
  const list = a.trackIds.map((id) => ctx.catalog.trackById.get(id))
  return {
    ...albumJson(ctx, a),
    tracks: list.map((t) => trackJson(ctx, t)),
    totalDuration: list.reduce((sum, t) => sum + t.duration, 0)
  }
}

export function artistJson(ctx, a) {
  return { id: a.id, name: a.name, artwork: artwork(ctx.origin, 'artist', a.id), followers: a.followers }
}

export function artistDetailJson(ctx, a) {
  const top = a.trackIds
    .map((id) => ctx.catalog.trackById.get(id))
    .sort((x, y) => y.popularity - x.popularity || (x.id < y.id ? -1 : 1))
    .slice(0, 10)
  return {
    ...artistJson(ctx, a),
    bio: a.bio,
    topTracks: top.map((t) => trackJson(ctx, t)),
    albums: [...a.albumIds].map((id) => ctx.catalog.albumById.get(id)).sort((x, y) => y.year - x.year).map((al) => albumJson(ctx, al))
  }
}

export function playlistJson(ctx, p) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    owner: PLAYLIST_OWNER,
    artwork: artwork(ctx.origin, 'playlist', p.id),
    trackCount: p.trackIds.length
  }
}

export function playlistDetailJson(ctx, p) {
  return { ...playlistJson(ctx, p), tracks: p.trackIds.map((id) => trackJson(ctx, ctx.catalog.trackById.get(id))) }
}

export function displayName(username) {
  return capitalize(username)
}
