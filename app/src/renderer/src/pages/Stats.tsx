import { useMemo, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, Share2, TrendingDown, TrendingUp } from 'lucide-react'
import { api } from '../services'
import { useResource } from '../hooks/useResource'
import type { Image, StatsHistory, StatsRange, StatsSummary } from '../api/types'
import { Artwork, EmptyState, ErrorState, IconButton, SectionHeader, cx } from '../components/common'
import { RecapCard } from '../components/RecapCard'
import { useNav } from '../store/nav'
import { artistNames } from '../lib/format'
import { RANGE_TABS, barRatios, buildRecapData, canGoForward, describeDelta, formatBigMinutes, formatMinutes, shortDate } from '../lib/stats'
import { Page } from './Page'

function historyFor(range: StatsRange): { period: 'week' | 'month'; count: number } {
  return range === 'week' ? { period: 'week', count: 26 } : { period: 'month', count: range === 'month' ? 12 : 24 }
}

function HistoryChart({ data, summary }: { data: StatsHistory; summary: StatsSummary | undefined }): ReactNode {
  const bars = useMemo(() => barRatios(data.items), [data.items])
  if (bars.length === 0) return null
  const H = 120
  const step = 12
  const inPeriod = (start: string): boolean =>
    !!summary && (summary.start == null || (start >= summary.start && (summary.end == null || start < summary.end)))
  const label = data.period === 'week' ? 'Minutes per week' : 'Minutes per month'
  return (
    <figure className="mt-2">
      <svg viewBox={`0 0 ${bars.length * step} ${H}`} preserveAspectRatio="none" className="h-36 w-full" role="img" aria-label={label}>
        {bars.map((b, i) => {
          const h = Math.max(b.ratio * (H - 4), b.ratio > 0 ? 2 : 0)
          return (
            <g key={b.start}>
              <rect x={i * step + 1} y={0} width={step - 2} height={H} rx={2} className="fill-white/[0.04]" />
              {h > 0 && (
                <rect x={i * step + 1} y={H - h} width={step - 2} height={h} rx={2} className={inPeriod(b.start) ? 'fill-accent' : 'fill-white/30'}>
                  <title>{`${shortDate(b.start)}: ${formatMinutes(b.minutes)}`}</title>
                </rect>
              )}
            </g>
          )
        })}
      </svg>
      <figcaption className="mt-1 flex justify-between text-xs text-fg-subtle">
        <span>{shortDate(bars[0]!.start)}</span>
        <span>{label}</span>
        <span>{shortDate(bars[bars.length - 1]!.start)}</span>
      </figcaption>
    </figure>
  )
}

function Row({ rank, images, round, title, subtitle, plays, minutes, onOpen }: {
  rank: number
  images: Image[] | undefined
  round?: boolean
  title: string
  subtitle?: string
  plays: number
  minutes: number
  onOpen?: () => void
}): ReactNode {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        disabled={!onOpen}
        className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors enabled:hover:bg-white/[0.07]"
      >
        <span className="w-6 shrink-0 text-center text-sm font-semibold text-fg-subtle tabular-nums">{rank}</span>
        <Artwork images={images} size={48} round={round} className="h-12 w-12 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold">{title}</span>
          {subtitle && <span className="block truncate text-sm text-fg-muted">{subtitle}</span>}
        </span>
        <span className="shrink-0 text-right text-sm text-fg-muted tabular-nums">
          <span className="block">{formatMinutes(minutes)}</span>
          <span className="block text-xs text-fg-subtle">{plays} {plays === 1 ? 'play' : 'plays'}</span>
        </span>
      </button>
    </li>
  )
}

export function StatsPage(): ReactNode {
  const [range, setRange] = useState<StatsRange>('week')
  const [offset, setOffset] = useState(0)
  const [sharing, setSharing] = useState(false)
  const go = useNav((s) => s.go)

  const summary = useResource<StatsSummary>(`stats:${range}:${offset}`, (s) => api.statsSummary(range, offset, 10, s))
  const hp = historyFor(range)
  const history = useResource<StatsHistory>(`stats:history:${hp.period}:${hp.count}`, (s) => api.statsHistory(hp.period, hp.count, s))
  const data = summary.data
  const delta = data ? describeDelta(data.delta, data.range) : null
  const empty = !!data && data.totals.plays === 0
  const recap = useMemo(() => (data && data.totals.plays > 0 ? buildRecapData(data) : null), [data])

  const pick = (r: StatsRange): void => {
    setRange(r)
    setOffset(0)
  }

  return (
    <Page>
      <div className="fade-up flex flex-wrap items-center justify-between gap-3 pt-2">
        <h1 className="text-3xl font-extrabold tracking-tight">Stats</h1>
        <div role="tablist" aria-label="Period" className="g-seg inline-flex rounded-full bg-ink-900 p-1">
          {RANGE_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={range === t.id}
              onClick={() => pick(t.id)}
              className={cx(
                'rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
                range === t.id ? 'bg-accent text-ink-950' : 'text-fg-muted hover:text-fg'
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-6 flex items-center gap-2">
        {range !== 'all' && (
          <IconButton label="Previous period" onClick={() => setOffset((o) => o + 1)}>
            <ChevronLeft className="h-5 w-5" />
          </IconButton>
        )}
        <p className="min-w-0 flex-1 truncate text-lg font-semibold" aria-live="polite">{data?.label ?? ' '}</p>
        {range !== 'all' && (
          <IconButton label="Next period" onClick={() => setOffset((o) => Math.max(0, o - 1))} disabled={!canGoForward(range, offset)}>
            <ChevronRight className="h-5 w-5" />
          </IconButton>
        )}
        {recap && range !== 'all' && (
          <button
            type="button"
            onClick={() => setSharing(true)}
            className="ml-1 inline-flex items-center gap-2 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-ink-950 transition-transform active:scale-95"
          >
            <Share2 className="h-4 w-4" /> Share recap
          </button>
        )}
      </div>

      {summary.error && !data && <ErrorState message={summary.error} onRetry={summary.reload} />}

      {data && (
        <section className="fade-up mt-4 mb-8" aria-label="Totals">
          <p className="text-6xl leading-none font-extrabold tracking-tight tabular-nums md:text-7xl">{formatBigMinutes(data.totals.minutes)}</p>
          <p className="mt-2 text-fg-muted">minutes listened</p>
          {delta && (
            <p
              className={cx(
                'mt-3 inline-flex items-center gap-1.5 rounded-full bg-white/[0.07] px-3 py-1 text-sm font-semibold',
                delta.direction === 'up' && 'text-accent',
                delta.direction === 'down' && 'text-fg-muted'
              )}
            >
              {delta.direction === 'up' && <TrendingUp className="h-4 w-4" />}
              {delta.direction === 'down' && <TrendingDown className="h-4 w-4" />}
              {delta.text}
            </p>
          )}
          <dl className="mt-5 grid max-w-md grid-cols-3 gap-4 text-sm">
            <div><dt className="text-fg-subtle">Plays</dt><dd className="text-lg font-bold tabular-nums">{data.totals.plays.toLocaleString()}</dd></div>
            <div><dt className="text-fg-subtle">Tracks</dt><dd className="text-lg font-bold tabular-nums">{data.totals.distinctTracks.toLocaleString()}</dd></div>
            <div><dt className="text-fg-subtle">Artists</dt><dd className="text-lg font-bold tabular-nums">{data.totals.distinctArtists.toLocaleString()}</dd></div>
          </dl>
        </section>
      )}

      {history.data && <HistoryChart data={history.data} summary={data} />}

      {empty && (
        <div className="mt-8">
          <EmptyState icon={<TrendingUp className="h-8 w-8" />} title="Nothing played in this period" hint="Listen to some music and your stats will show up here." />
        </div>
      )}

      {data && !empty && (
        <div className="mt-10 grid gap-10 lg:grid-cols-2">
          <section aria-label="Top tracks">
            <SectionHeader title="Top tracks" />
            <ol>
              {data.topTracks.map((t, i) => (
                <Row
                  key={t.track.id}
                  rank={i + 1}
                  images={t.track.artwork}
                  title={t.track.title}
                  subtitle={artistNames(t.track.artists)}
                  plays={t.plays}
                  minutes={t.minutes}
                  onOpen={t.track.album ? () => go({ name: 'album', id: t.track.album!.id }) : undefined}
                />
              ))}
            </ol>
          </section>
          <section aria-label="Top artists">
            <SectionHeader title="Top artists" />
            <ol>
              {data.topArtists.map((a, i) => (
                <Row
                  key={a.artist.id}
                  rank={i + 1}
                  images={a.artist.image ? [{ url: a.artist.image, width: 1000 }] : a.artist.artwork}
                  round
                  title={a.artist.name}
                  plays={a.plays}
                  minutes={a.minutes}
                  onOpen={() => go({ name: 'artist', id: a.artist.id })}
                />
              ))}
            </ol>
          </section>
          {data.topAlbums.length > 0 && (
            <section aria-label="Top albums">
              <SectionHeader title="Top albums" />
              <ol>
                {data.topAlbums.map((a, i) => (
                  <Row
                    key={a.album.id}
                    rank={i + 1}
                    images={a.album.artwork}
                    title={a.album.title}
                    subtitle={artistNames(a.album.artists)}
                    plays={a.plays}
                    minutes={a.minutes}
                    onOpen={() => go({ name: 'album', id: a.album.id })}
                  />
                ))}
              </ol>
            </section>
          )}
        </div>
      )}

      {sharing && recap && <RecapCard data={recap} onClose={() => setSharing(false)} />}
    </Page>
  )
}
