// Fake listening stats for the mock server: a deterministic play history generated from the catalog
// (~400 days back from `now`), aggregated like the real GET /v1/stats/* endpoints. Weeks start on Monday;
// dates are UTC here (the real server uses Europe/Madrid).

import { rngFor, randInt } from './util.mjs'
import { albumJson, artistJson, trackJson } from './catalog.mjs'

const DAY = 86_400_000

const iso = (d) => d.toISOString().slice(0, 10)
const startOfDay = (ms) => new Date(Math.floor(ms / DAY) * DAY)

export function periodStart(kind, today, offset) {
  if (kind === 'week') return new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * DAY - offset * 7 * DAY)
  if (kind === 'month') return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - offset, 1))
  return new Date(Date.UTC(today.getUTCFullYear() - offset, 0, 1))
}

export function periodEnd(kind, start) {
  if (kind === 'week') return new Date(start.getTime() + 7 * DAY)
  if (kind === 'month') return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))
  return new Date(Date.UTC(start.getUTCFullYear() + 1, 0, 1))
}

export function periodLabel(kind, start) {
  if (kind === 'all') return 'All time'
  if (kind === 'year') return String(start.getUTCFullYear())
  const f = (d, o) => d.toLocaleDateString('en-US', { ...o, timeZone: 'UTC' })
  if (kind === 'month') return f(start, { month: 'long', year: 'numeric' })
  const end = new Date(start.getTime() + 6 * DAY)
  return `${f(start, { month: 'short', day: 'numeric' })} – ${f(end, { month: 'short', day: 'numeric' })}, ${end.getUTCFullYear()}`
}

/** [{trackId, at(ms), seconds}] — stable for a given user and `now` day. */
export function fakePlays(catalog, userId, nowMs) {
  const rng = rngFor(`stats:${userId}`)
  const tracks = catalog.tracks
  if (tracks.length === 0) return []
  const favourites = tracks.slice(0, Math.min(tracks.length, 40))
  const today = startOfDay(nowMs).getTime()
  const plays = []
  for (let d = 0; d < 400; d++) {
    const n = rng() < 0.18 ? 0 : randInt(rng, 1, 9)
    for (let i = 0; i < n; i++) {
      const t = rng() < 0.6 ? favourites[Math.floor(rng() * rng() * favourites.length)] : tracks[Math.floor(rng() * tracks.length)]
      const at = today - d * DAY + randInt(rng, 7, 23) * 3_600_000 + randInt(rng, 0, 59) * 60_000
      if (at > nowMs) continue
      plays.push({ trackId: t.id, at, seconds: Math.round(t.duration * (0.6 + rng() * 0.4)) })
    }
  }
  return plays
}

const mins = (s) => Math.round((s / 60) * 10) / 10

function totalsOf(plays, catalog) {
  const tracks = new Set(plays.map((p) => p.trackId))
  const artists = new Set()
  for (const id of tracks) for (const a of catalog.trackById.get(id).artistIds) artists.add(a)
  return { minutes: mins(plays.reduce((s, p) => s + p.seconds, 0)), plays: plays.length, distinctTracks: tracks.size, distinctArtists: artists.size }
}

function top(plays, keysOf) {
  const agg = new Map()
  for (const p of plays) for (const k of keysOf(p.trackId)) {
    const a = agg.get(k) ?? { plays: 0, seconds: 0 }
    a.plays++
    a.seconds += p.seconds
    agg.set(k, a)
  }
  return [...agg].map(([id, a]) => ({ id, plays: a.plays, minutes: mins(a.seconds), seconds: a.seconds })).sort((x, y) => y.plays - x.plays || y.seconds - x.seconds || (x.id < y.id ? -1 : 1))
}

export function statsSummary(ctx, userId, nowMs, range, offset, limit) {
  const { catalog } = ctx
  const all = fakePlays(catalog, userId, nowMs)
  const today = startOfDay(nowMs)
  const within = (kind, off) => {
    const s = periodStart(kind, today, off)
    const e = periodEnd(kind, s)
    return { s, e, plays: all.filter((p) => p.at >= s.getTime() && p.at < e.getTime()) }
  }
  let start = null
  let end = null
  let plays = all
  let previous = null
  if (range !== 'all') {
    const cur = within(range, offset)
    start = cur.s
    end = cur.e
    plays = cur.plays
    previous = totalsOf(within(range, offset + 1).plays, catalog)
  }
  const totals = totalsOf(plays, catalog)
  const delta = previous
    ? {
        minutes: Math.round((totals.minutes - previous.minutes) * 10) / 10,
        minutesPct: previous.minutes > 0 ? Math.round(((totals.minutes - previous.minutes) / previous.minutes) * 1000) / 10 : null,
        plays: totals.plays - previous.plays
      }
    : null
  const t = (id) => catalog.trackById.get(id)
  return {
    range,
    offset: range === 'all' ? 0 : offset,
    start: start ? iso(start) : null,
    end: end ? iso(end) : null,
    label: periodLabel(range, start),
    totals,
    previous,
    delta,
    topTracks: top(plays, (id) => [id]).slice(0, limit).map((x) => ({ track: trackJson(ctx, t(x.id)), plays: x.plays, minutes: x.minutes })),
    topArtists: top(plays, (id) => t(id).artistIds).slice(0, limit).map((x) => ({ artist: artistJson(ctx, catalog.artistById.get(x.id)), plays: x.plays, minutes: x.minutes })),
    topAlbums: top(plays, (id) => [t(id).albumId]).slice(0, limit).map((x) => ({ album: albumJson(ctx, catalog.albumById.get(x.id)), plays: x.plays, minutes: x.minutes }))
  }
}

export function statsHistory(catalog, userId, nowMs, period, count) {
  const all = fakePlays(catalog, userId, nowMs)
  const today = startOfDay(nowMs)
  const items = []
  for (let o = count - 1; o >= 0; o--) {
    const s = periodStart(period, today, o)
    const e = periodEnd(period, s)
    const plays = all.filter((p) => p.at >= s.getTime() && p.at < e.getTime())
    items.push({ start: iso(s), minutes: totalsOf(plays, catalog).minutes, plays: plays.length })
  }
  return { period, items }
}
