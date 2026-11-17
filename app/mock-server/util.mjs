// Small deterministic helpers shared by the mock server modules.

/** FNV-1a 32-bit hash of a string. */
export function hash32(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32 PRNG: returns a function producing floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed | 0
  return function next() {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** PRNG seeded from an arbitrary string. */
export function rngFor(seed) {
  return mulberry32(hash32(String(seed)))
}

/** Integer in [min, max] (inclusive) from a PRNG. */
export function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1))
}

/** Picks one element of an array. */
export function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)]
}

/** Fisher-Yates shuffle returning a new array. */
export function shuffled(rng, arr) {
  const out = arr.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** Lowercases and strips diacritics so searches are accent-insensitive. */
export function fold(s) {
  return String(s).normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase()
}

export function slugify(s) {
  return fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

export function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c])
}

export function capitalize(s) {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s
}
