import { useState, type ReactNode } from 'react'
import { Bug, Copy, Trash2 } from 'lucide-react'
import type { DiagnosticReport } from '../../api/types'
import { api } from '../../services'
import { useUi } from '../../store/ui'
import { useResource } from '../../hooks/useResource'
import { resources } from '../../lib/resource'
import { EmptyState, ErrorState, Spinner } from '../../components/common'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { formatDateTime } from './format'
import { Button, Card, Chip } from './ui'
import { useT } from '../../i18n'

const KEY = 'admin:diagnostics'

/** First lines of a trace, for the collapsed row. */
export function headLines(body: string, n = 3): string {
  return body.split('\n').filter((l) => l.trim()).slice(0, n).join('\n')
}

function Row({ r, onDelete }: { r: DiagnosticReport; onDelete: () => void }): ReactNode {
  const tr = useT()
  const [open, setOpen] = useState(false)
  const copy = (): void => {
    const text = `${r.version} | ${r.device} | ${r.os} | ${r.occurredAt ?? r.createdAt}\n\n${r.body}`
    void navigator.clipboard?.writeText(text).then(
      () => useUi.getState().toast(tr('dg.copied')),
      () => undefined
    )
  }
  return (
    <li className="rounded-xl bg-white/[0.03] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={r.source === 'manual' ? 'neutral' : 'bad'}>{r.source === 'manual' ? tr('dg.manual') : tr('dg.crash')}</Chip>
        <Chip>{r.kind}</Chip>
        <span className="text-sm font-semibold tabular-nums">v{r.version || '?'}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-fg-muted">
          {r.device} {r.os && `· ${r.os}`} · {r.username ?? '?'} · {formatDateTime(r.occurredAt ?? r.createdAt)}
        </span>
        <Button size="sm" variant="ghost" icon={<Copy />} onClick={copy} aria-label={tr('dg.copy')} />
        <Button size="sm" variant="ghost" icon={<Trash2 />} onClick={onDelete} aria-label={tr('dg.delete')} />
      </div>
      <pre className="mt-2 max-h-[28rem] overflow-auto rounded-lg bg-black/30 p-2 text-[12px] leading-snug whitespace-pre-wrap break-all text-fg-muted">
        {open ? r.body : headLines(r.body)}
      </pre>
      <button type="button" className="mt-1 text-[13px] font-semibold text-accent" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? tr('dg.collapse') : tr('dg.expand')}
      </button>
    </li>
  )
}

export function DiagnosticsTab(): ReactNode {
  const tr = useT()
  const list = useResource<DiagnosticReport[]>(KEY, async (signal) => (await api.adminDiagnostics(signal)).reports)
  const [clearing, setClearing] = useState(false)

  if (list.loading) return <div className="flex justify-center py-20"><Spinner /></div>
  if (list.error && !list.data) return <ErrorState message={list.error} onRetry={list.reload} />
  const rows = list.data ?? []
  const refresh = (): void => {
    resources.invalidate(KEY)
    list.reload()
  }

  return (
    <Card
      id="dg-title"
      title={tr('dg.title')}
      action={
        rows.length > 0 ? (
          <Button variant="danger" icon={<Trash2 />} onClick={() => setClearing(true)}>
            {tr('dg.clear')}
          </Button>
        ) : undefined
      }
    >
      {rows.length === 0 ? (
        <EmptyState icon={<Bug className="h-8 w-8" strokeWidth={1.5} />} title={tr('dg.none')} hint={tr('dg.noneHint')} />
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <Row
              key={r.id}
              r={r}
              onDelete={() => {
                void api.adminDeleteDiagnostic(r.id).then(refresh)
              }}
            />
          ))}
        </ul>
      )}
      {clearing && (
        <ConfirmDialog
          title={tr('dg.clearQ')}
          tone="danger"
          message={tr('dg.clearMsg')}
          confirmLabel={tr('dg.clear')}
          onConfirm={async () => {
            await api.adminDeleteDiagnostic()
            refresh()
          }}
          onClose={() => setClearing(false)}
        />
      )}
    </Card>
  )
}
