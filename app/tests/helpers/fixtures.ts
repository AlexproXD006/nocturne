import type { Album, Session, Track } from '@/api/types'
import type { StoredSession } from '@/api/client'

export function track(id: string, over: Partial<Track> = {}): Track {
  return {
    id,
    title: `Title ${id}`,
    artists: [{ id: `ar-${id}`, name: `Artist ${id}` }],
    album: { id: `al-${id}`, title: `Album ${id}` },
    duration: 200,
    artwork: [],
    ...over
  }
}

export function tracks(n: number, prefix = 't'): Track[] {
  return Array.from({ length: n }, (_, i) => track(`${prefix}${i}`))
}

export function album(id: string): Album {
  return { id, title: `Album ${id}`, artists: [], artwork: [] }
}

export function wireSession(over: Partial<Session> = {}): Session {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresIn: 3600,
    user: { id: 'u1', username: 'demo', displayName: 'Demo' },
    ...over
  }
}

export function storedSession(over: Partial<StoredSession> = {}): StoredSession {
  return {
    ...wireSession(),
    serverUrl: 'https://music.example.com',
    expiresAt: 10_000_000,
    ...over
  }
}

/** Deterministic rng returning the given values in a loop. */
export function seq(values: number[]): () => number {
  let i = 0
  return () => values[i++ % values.length]!
}

export function counter(prefix = 'u'): () => string {
  let n = 0
  return () => `${prefix}${n++}`
}
