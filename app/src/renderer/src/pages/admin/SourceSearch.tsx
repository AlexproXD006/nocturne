import { useEffect, useState, type ReactNode } from 'react'
import { Check, Download, Search, X } from 'lucide-react'
import type { AdminSource, SourceResult } from '../../api/types'
import { describeError, isAbort } from '../../api/errors'
import { api } from '../../services'
import { useUi } from '../../store/ui'
import { Artwork, EmptyState, Spinner } from '../../components/common'
import { formatTime } from '../../lib/format'
import { useJobs } from './useJobs'
import { Button, Card, Chip, InlineError, Segmented, inputClass, useDebounced } from './ui'
import { useT, type MessageKey } from '../../i18n'

export const SOURCE_LABEL: Record<AdminSource, string> = { spotify: 'Spotify', youtube: 'YouTube' }

type DlState = 'starting' | 'queued'
const keyOf = (r: SourceResult): string => `${r.source}:${r.id}`

function ResultRow({ r, state, onDownload }: { r: SourceResult; state: DlState | undefined; onDownload: () => void }): ReactNode {
  const tr = useT()
  const queued = state === 'queued'
  return (
    <li className="flex items-center gap-3 rounded-xl p-2 hover:bg-white/[0.04]">
      <Artwork images={r.artworkUrl ? [{ url: r.artworkUrl }] : undefined} size={48} className="h-12 w-12 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <p className="min-w-0 truncate text-sm font-semibold" title={r.title}>{r.title}</p>
          <Chip>{tr(`src.kind.${r.kind}` as MessageKey)}</Chip>
          {r.inLibrary && <Chip tone="good">{tr('src.inLibrary')}</Chip>}
        </div>
        <p className="truncate text-[13px] text-fg-muted">
          {r.artist}
          {r.album && r.kind === 'track' ? ` · ${r.album}` : ''}
        </p>
      </div>
      {r.duration !== undefined && r.duration > 0 && (
        <span className="hidden w-12 shrink-0 text-right text-[13px] text-fg-muted tabular-nums sm:block">{formatTime(r.duration)}</span>
      )}
      <Button
        size="sm"
        variant={queued ? 'ghost' : 'secondary'}
        busy={state === 'starting'}
        disabled={queued}
        aria-label={queued ? tr('src.queuedLabel', { title: r.title }) : tr('src.downloadLabel', { title: r.title })}
        icon={queued ? <Check /> : <Download />}
        onClick={onDownload}
      >
        <span className="max-sm:sr-only">{queued ? tr('src.queued') : tr('src.download')}</span>
      </Button>
    </li>
  )
}

export function SourceSearch({ sources }: { sources: AdminSource[] }): ReactNode {
  const tr = useT()
  const [source, setSource] = useState<AdminSource>(sources[0]!)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SourceResult[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dl, setDl] = useState<Record<string, DlState>>({})
  const debounced = useDebounced(query.trim(), 300)
  const { upsert } = useJobs()

  useEffect(() => {
    if (!debounced) {
      setResults(null)
      setError(null)
      setLoading(false)
      return
    }
    const ctrl = new AbortController()
    setLoading(true)
    setError(null)
    api
      .adminSearchSource(source, debounced, ctrl.signal)
      .then((r) => {
        if (!ctrl.signal.aborted) setResults(r.results)
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted || isAbort(err)) return
        setResults(null)
        setError(describeError(err))
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false)
      })
    return () => ctrl.abort()
  }, [debounced, source])

  const download = (r: SourceResult): void => {
    const k = keyOf(r)
    setDl((d) => ({ ...d, [k]: 'starting' }))
    api
      .adminStartDownload({ source: r.source, id: r.id })
      .then((job) => {
        upsert(job)
        setDl((d) => ({ ...d, [k]: 'queued' }))
        useUi.getState().toast(tr('src.queuedToast', { title: r.title }))
      })
      .catch((err: unknown) => {
        setDl((d) => {
          const { [k]: _gone, ...rest } = d
          return rest
        })
        useUi.getState().toast(describeError(err), 'error')
      })
  }

  return (
    <Card
      id="source-search-title"
      title={tr('src.title')}
      action={
        sources.length > 1 ? (
          <Segmented
            label={tr('src.source')}
            value={source}
            onChange={(s) => {
              setSource(s)
              setResults(null)
            }}
            options={sources.map((s) => ({ id: s, label: SOURCE_LABEL[s] }))}
          />
        ) : (
          <Chip>{SOURCE_LABEL[sources[0]!]}</Chip>
        )
      }
    >
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-4 h-4 w-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
        <input
          type="search"
          role="searchbox"
          aria-label={tr('src.searchLabel', { source: SOURCE_LABEL[source] })}
          className={`${inputClass} pl-11`}
          placeholder={tr('src.searchPlaceholder', { source: SOURCE_LABEL[source] })}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        {query && (
          <button
            type="button"
            aria-label={tr('src.clear')}
            onClick={() => setQuery('')}
            className="absolute top-1/2 right-3 -translate-y-1/2 rounded-full p-1.5 text-fg-subtle hover:text-fg"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className="mt-3 min-h-16" aria-live="polite">
        <InlineError message={error} />
        {loading && !results && <div className="flex justify-center py-8"><Spinner /></div>}
        {!debounced && !error && <p className="py-4 text-center text-sm text-fg-muted">{tr('src.type', { source: SOURCE_LABEL[source] })}</p>}
        {results && results.length === 0 && !loading && (
          <EmptyState icon={<Search className="h-7 w-7" strokeWidth={1.5} />} title={tr('src.noResults')} hint={tr('src.nothingOn', { source: SOURCE_LABEL[source], q: debounced })} />
        )}
        {results && results.length > 0 && (
          <ul className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
            {results.map((r) => (
              <ResultRow key={keyOf(r)} r={r} state={dl[keyOf(r)]} onDownload={() => download(r)} />
            ))}
          </ul>
        )}
      </div>
    </Card>
  )
}
