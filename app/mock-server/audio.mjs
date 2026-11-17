// Procedural audio: a deterministic 16-bit PCM mono WAV per track.
// Layers: soft detuned sine pad on a 4-chord progression, a bass line,
// a kick on every beat (so the visualizer reacts), offbeat hats, and a
// pentatonic pluck melody with an echo. The melody phrases are two bars
// long and lyrics.mjs places one lyric line on each phrase.

import { rngFor } from './util.mjs'

export const SAMPLE_RATE = 22050
const TAU = Math.PI * 2

const TABLE_SIZE = 8192
const MASK = TABLE_SIZE - 1
const SINE = new Float32Array(TABLE_SIZE)
for (let i = 0; i < TABLE_SIZE; i++) SINE[i] = Math.sin((TAU * i) / TABLE_SIZE)

const CHORDS = { M: [0, 4, 7], M7: [0, 4, 7, 11], m: [0, 3, 7], m7: [0, 3, 7, 10] }
const PROGRESSIONS = {
  minor: [
    [[0, 'm7'], [8, 'M7'], [3, 'M'], [10, 'M']],
    [[0, 'm7'], [5, 'm7'], [10, 'M'], [3, 'M7']],
    [[0, 'm'], [3, 'M'], [10, 'M'], [8, 'M7']]
  ],
  major: [
    [[0, 'M7'], [7, 'M'], [9, 'm7'], [5, 'M7']],
    [[9, 'm7'], [5, 'M7'], [0, 'M'], [7, 'M']],
    [[0, 'M'], [9, 'm7'], [5, 'M7'], [7, 'M']]
  ]
}
const SCALES = { minor: [0, 3, 5, 7, 10], major: [0, 2, 4, 7, 9] }
const RHYTHMS = [
  [2, 1, 1, 2, 2, 1, 1, 2, 2, 2],
  [3, 1, 2, 2, 3, 1, 2, 2],
  [1, 1, 2, 2, 2, 1, 1, 2, 2, 2],
  [4, 2, 2, 4, 2, 2],
  [2, 2, 1, 1, 2, 2, 2, 1, 1, 2]
]
// Which of the three melody variants each successive lyric line uses (A B A C).
const PHRASE_ORDER = [0, 1, 0, 2]

const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12)
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x))

/**
 * Musical timeline of a track. One lyric line = one two-bar phrase; lyrics
 * start after a two-bar intro. Used by both the audio and lyrics generators.
 */
export function timeline(music, duration) {
  const beat = 60 / music.bpm
  const bar = beat * 4
  const line = bar * 2
  const intro = bar * 2
  const lines = Math.max(0, Math.floor((duration - intro - 2) / line))
  return { beat, bar, line, intro, lines }
}

function melodyVariants(music) {
  const rng = rngFor(`melody:${music.seed}`)
  const scale = SCALES[music.mode]
  const variants = []
  for (let v = 0; v < 3; v++) {
    const rhythm = RHYTHMS[Math.floor(rng() * RHYTHMS.length)]
    let degree = 4
    let step = 0
    const notes = []
    for (const len of rhythm) {
      const moves = [-2, -1, -1, 0, 1, 1, 2]
      degree = Math.max(1, Math.min(7, degree + moves[Math.floor(rng() * moves.length)]))
      if (rng() >= 0.12) {
        const midi = 57 + music.root + 12 * Math.floor(degree / 5) + scale[degree % 5]
        notes.push({ step, len, midi })
      }
      step += len
    }
    variants.push(notes)
  }
  return variants
}

function addPad(buf, start, length, freqs, amp) {
  const end = Math.min(buf.length, start + length)
  const att = 0.4 * SAMPLE_RATE
  const rel = 0.6 * SAMPLE_RATE
  for (const f of freqs) {
    const incA = (f * TABLE_SIZE) / SAMPLE_RATE
    const incB = incA * 1.003
    let pa = 0
    let pb = 0
    for (let i = start, k = 0; i < end; i++, k++) {
      const env = k < att ? smooth(k / att) : k > length - rel ? smooth((length - k) / rel) : 1
      buf[i] += amp * env * (SINE[pa & MASK] + 0.7 * SINE[pb & MASK])
      pa += incA
      pb += incB
    }
  }
}

function addBass(buf, start, length, freq, amp) {
  const end = Math.min(buf.length, start + length)
  const inc = (freq * TABLE_SIZE) / SAMPLE_RATE
  const tau = 0.55 * SAMPLE_RATE
  const attack = 0.006 * SAMPLE_RATE
  const rel = 0.03 * SAMPLE_RATE
  let p = 0
  for (let i = start, k = 0; i < end; i++, k++) {
    const env = (1 - Math.exp(-k / attack)) * Math.exp(-k / tau) * (k > length - rel ? smooth((length - k) / rel) : 1)
    buf[i] += amp * env * (SINE[p & MASK] + 0.35 * SINE[(p * 2) & MASK])
    p += inc
  }
}

function addPluck(buf, start, noteSeconds, freq, amp) {
  const length = Math.ceil((noteSeconds + 0.25) * SAMPLE_RATE)
  const end = Math.min(buf.length, start + length)
  const inc = (freq * TABLE_SIZE) / SAMPLE_RATE
  const tau = Math.max(0.18, noteSeconds * 0.6) * SAMPLE_RATE
  const attack = 0.008 * SAMPLE_RATE
  const rel = 0.05 * SAMPLE_RATE
  let p = 0
  for (let i = start, k = 0; i < end; i++, k++) {
    const env = (1 - Math.exp(-k / attack)) * Math.exp(-k / tau) * (k > length - rel ? smooth((length - k) / rel) : 1)
    buf[i] += amp * env * (SINE[p & MASK] + 0.4 * SINE[(p * 2) & MASK] + 0.15 * SINE[(p * 3) & MASK])
    p += inc
  }
}

function addKick(buf, duck, start, amp) {
  const length = Math.floor(0.32 * SAMPLE_RATE)
  const end = Math.min(buf.length, start + length)
  let phase = 0
  for (let i = start, k = 0; i < end; i++, k++) {
    const t = k / SAMPLE_RATE
    const freq = 46 + 95 * Math.exp(-t / 0.035)
    phase += (TAU * freq) / SAMPLE_RATE
    buf[i] += amp * Math.exp(-t / 0.11) * Math.sin(phase)
    const d = 1 - 0.4 * Math.exp(-t / 0.09)
    if (d < duck[i]) duck[i] = d
  }
}

function addHat(buf, start, amp, rng) {
  const length = Math.floor(0.05 * SAMPLE_RATE)
  const end = Math.min(buf.length, start + length)
  let prev = 0
  for (let i = start, k = 0; i < end; i++, k++) {
    const n = rng() * 2 - 1
    buf[i] += amp * Math.exp(-k / (0.011 * SAMPLE_RATE)) * (n - prev)
    prev = n
  }
}

/**
 * Renders the track to a complete WAV file (RIFF header + 16-bit PCM mono
 * samples at 22050 Hz). The audio length is exactly `duration` seconds.
 * @param {{seed:string,bpm:number,mode:'minor'|'major',root:number,prog:number}} music
 * @param {number} duration seconds
 * @returns {Buffer}
 */
export function renderWav(music, duration) {
  const n = Math.round(duration * SAMPLE_RATE)
  const tl = timeline(music, duration)
  const prog = PROGRESSIONS[music.mode][music.prog % 3]
  const bed = new Float32Array(n)
  const lead = new Float32Array(n)
  const drums = new Float32Array(n)
  const duck = new Float32Array(n).fill(1)
  const hatRng = rngFor(`hat:${music.seed}`)
  const at = (t) => Math.round(t * SAMPLE_RATE)

  const bars = Math.ceil(duration / tl.bar)
  for (let b = 0; b < bars; b++) {
    const t0 = b * tl.bar
    const [offset, quality] = prog[b % 4]
    const chordPc = (music.root + offset) % 12
    const base = 48 + chordPc
    addPad(bed, at(t0), at(tl.bar + 0.5), CHORDS[quality].map((iv) => midiToHz(base + iv)), 0.085)
    const bassHz = midiToHz(36 + chordPc)
    addBass(bed, at(t0), at(tl.beat * 1.5), bassHz, 0.3)
    addBass(bed, at(t0 + tl.beat * 2), at(tl.beat * 1.0), bassHz, 0.24)
    addBass(bed, at(t0 + tl.beat * 3.5), at(tl.beat * 0.5), bassHz * 1.5, 0.12)
    if (b >= 1) {
      for (let k = 0; k < 4; k++) {
        addKick(drums, duck, at(t0 + k * tl.beat), 0.55)
        addHat(drums, at(t0 + (k + 0.5) * tl.beat), 0.05, hatRng)
      }
    }
  }

  const variants = melodyVariants(music)
  for (let i = 0; ; i++) {
    const lineStart = tl.intro + i * tl.line
    if (lineStart >= duration - 1.5) break
    const notes = variants[PHRASE_ORDER[i % 4]]
    for (const note of notes) {
      const t = lineStart + (note.step * tl.beat) / 2
      const len = (note.len * tl.beat) / 2
      if (t >= duration - 1) continue
      const hz = midiToHz(note.midi)
      addPluck(lead, at(t), len, hz, 0.16)
      addPluck(lead, at(t + tl.beat * 0.75), len, hz, 0.045)
    }
  }

  // Mix: duck pad/bass under the kick, soft-saturate, normalize, fade.
  const mix = new Float32Array(n)
  let peak = 0
  for (let i = 0; i < n; i++) {
    const x = bed[i] * duck[i] + lead[i] + drums[i]
    const y = Math.tanh(x * 1.6)
    mix[i] = y
    const a = Math.abs(y)
    if (a > peak) peak = a
  }
  const gain = peak > 0 ? 0.9 / peak : 1
  const fadeIn = Math.min(n, Math.round(0.3 * SAMPLE_RATE))
  const fadeOut = Math.min(n, Math.round(1.8 * SAMPLE_RATE))

  const dataBytes = n * 2
  const wav = Buffer.alloc(44 + dataBytes)
  wav.write('RIFF', 0, 'ascii')
  wav.writeUInt32LE(36 + dataBytes, 4)
  wav.write('WAVE', 8, 'ascii')
  wav.write('fmt ', 12, 'ascii')
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20) // PCM
  wav.writeUInt16LE(1, 22) // mono
  wav.writeUInt32LE(SAMPLE_RATE, 24)
  wav.writeUInt32LE(SAMPLE_RATE * 2, 28) // byte rate
  wav.writeUInt16LE(2, 32) // block align
  wav.writeUInt16LE(16, 34) // bits per sample
  wav.write('data', 36, 'ascii')
  wav.writeUInt32LE(dataBytes, 40)
  for (let i = 0; i < n; i++) {
    let s = mix[i] * gain
    if (i < fadeIn) s *= smooth(i / fadeIn)
    const fromEnd = n - 1 - i
    if (fromEnd < fadeOut) s *= smooth(fromEnd / fadeOut)
    const v = Math.max(-32768, Math.min(32767, Math.round(s * 32767)))
    wav.writeInt16LE(v, 44 + i * 2)
  }
  return wav
}

/** Small LRU cache of rendered WAV buffers keyed by track id. */
export class AudioCache {
  constructor(max = 12) {
    this.max = Math.max(1, max)
    this.map = new Map()
  }

  get(track) {
    const key = `${track.id}|${track.music.seed}|${track.duration}`
    const hit = this.map.get(key)
    if (hit) {
      this.map.delete(key)
      this.map.set(key, hit)
      return hit
    }
    const wav = renderWav(track.music, track.duration)
    this.map.set(key, wav)
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value)
    return wav
  }

  get size() {
    return this.map.size
  }
}
