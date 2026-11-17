// Invented lyrics aligned to the generated audio's two-bar phrases.

import { timeline } from './audio.mjs'
import { capitalize, pick, rngFor } from './util.mjs'

const SUBJECT = ['the lanterns', 'your shadow', 'the harbor lights', 'a paper moon', 'the midnight train', 'our footsteps', 'the quiet rain', 'a thousand windows', 'the sleeping city', 'your voice', 'the satellites', 'every streetlight']
const VERB = ['drifted', 'wandered', 'faded', 'hummed', 'glowed', 'shimmered', 'trembled', 'lingered', 'spun', 'breathed', 'waited', 'rose']
const PLACE = ['beyond the harbor', 'over the water', 'into the static', 'across the glass', 'through the amber haze', 'down the empty avenue', 'under neon skies', 'along the shoreline', 'behind the curtain', 'above the rooftops', 'where the signal ends', 'out past the lighthouse']
const ING = ['chasing the daylight', 'counting the echoes', 'folding up the map', 'rewinding the evening', 'borrowing your silence', 'painting the ceiling blue', 'holding the last train', 'following the tide']
const FEEL = ['soft', 'golden', 'restless', 'weightless', 'unfinished', 'half-remembered', 'electric', 'borrowed']
const TIME = ['tonight', 'till morning', 'one more time', 'for a while', 'before it ends', 'when the lights go low']

function verseLine(rng) {
  switch (Math.floor(rng() * 6)) {
    case 0: return `${capitalize(pick(rng, SUBJECT))} ${pick(rng, VERB)} ${pick(rng, PLACE)}`
    case 1: return `And I keep ${pick(rng, ING)} ${pick(rng, TIME)}`
    case 2: return `Everything feels ${pick(rng, FEEL)} ${pick(rng, TIME)}`
    case 3: return `${capitalize(pick(rng, SUBJECT))} and ${pick(rng, SUBJECT)} ${pick(rng, VERB)}`
    case 4: return `We were ${pick(rng, ING)} ${pick(rng, PLACE)}`
    default: return `Say it is ${pick(rng, FEEL)}, say it is ${pick(rng, FEEL)}`
  }
}

function chorus(rng, title) {
  const hook = title.toLowerCase()
  return [
    `Take me back to ${hook}`,
    `${capitalize(pick(rng, SUBJECT))} ${pick(rng, VERB)} ${pick(rng, PLACE)}`,
    `Oh, ${hook}, ${pick(rng, TIME)}`,
    `We will never be this ${pick(rng, FEEL)} again`
  ]
}

/** The lyric lines of a track (empty for instrumentals), each with its start time in seconds. */
export function lyricLines(track) {
  if (track.lyricsMode === 'none') return []
  const tl = timeline(track.music, track.duration)
  const rng = rngFor(`lyrics:${track.id}`)
  const hookLines = chorus(rng, track.title)
  const lines = []
  for (let i = 0; i < tl.lines; i++) {
    const section = Math.floor(i / 4)
    const text = section % 2 === 1 ? hookLines[i % 4] : verseLine(rng)
    lines.push({ time: tl.intro + i * tl.line, text, blankBefore: i > 0 && i % 4 === 0 })
  }
  return lines
}

function stamp(seconds) {
  const cs = Math.round(seconds * 100)
  const mm = Math.floor(cs / 6000)
  const ss = Math.floor((cs % 6000) / 100)
  const xx = cs % 100
  return `[${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(xx).padStart(2, '0')}]`
}

/** Returns the ServerLyrics wire object for a track. */
export function lyricsFor(track) {
  const lines = lyricLines(track)
  if (lines.length === 0) return { synced: null, plain: null }
  const plain = lines.map((l) => (l.blankBefore ? `\n${l.text}` : l.text)).join('\n')
  if (track.lyricsMode === 'plain') return { synced: null, plain }
  const tl = timeline(track.music, track.duration)
  const last = lines[lines.length - 1]
  const synced = [...lines.map((l) => `${stamp(l.time)}${l.text}`), `${stamp(Math.min(track.duration, last.time + tl.line))}`].join('\n')
  return { synced, plain }
}
