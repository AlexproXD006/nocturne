import type { ReactNode } from 'react'
import { useSession } from '../../services'
import { JobRow } from './JobRow'
import { LinkImport } from './LinkImport'
import { SourceSearch } from './SourceSearch'
import { UploadZone } from './UploadZone'
import { useJobs } from './useJobs'
import { Card, useTick } from './ui'

export function AddMusicTab(): ReactNode {
  const caps = useSession((s) => s.server?.capabilities)
  const sources = caps?.sources ?? []
  const { active, upsert } = useJobs()
  const now = useTick()
  const uploadsEnabled = caps?.uploadMaxBytes !== 0

  return (
    <div className="space-y-4">
      {active.length > 0 && (
        <Card id="add-active-title" title="In progress">
          <ul className="space-y-2" aria-live="polite">
            {active.slice(0, 4).map((j) => (
              <JobRow key={j.id} job={j} now={now} compact />
            ))}
          </ul>
        </Card>
      )}
      {sources.length > 0 && (
        <>
          <SourceSearch sources={sources} />
          <LinkImport sources={sources} upsert={upsert} />
        </>
      )}
      {uploadsEnabled && <UploadZone maxBytes={caps?.uploadMaxBytes} />}
      {sources.length === 0 && !uploadsEnabled && (
        <Card>
          <p className="text-sm text-fg-muted">This server doesn’t offer any way to add music from the app.</p>
        </Card>
      )}
    </div>
  )
}
