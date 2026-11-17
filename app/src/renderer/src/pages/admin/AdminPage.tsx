import type { ReactNode } from 'react'
import { Archive, Database, FileText, LayoutDashboard, ListChecks, Plus, Users } from 'lucide-react'
import { useSession } from '../../services'
import { isAdmin } from '../../store/session'
import { useNav, type AdminTab } from '../../store/nav'
import { ErrorState } from '../../components/common'
import { Tabs, panelDomId, tabDomId, type TabDef } from '../../components/Tabs'
import { Page } from '../Page'
import { AddMusicTab } from './AddMusicTab'
import { BackupsTab } from './BackupsTab'
import { JobsTab } from './JobsTab'
import { LibraryTab } from './LibraryTab'
import { LyricsTab } from './LyricsTab'
import { OverviewTab } from './OverviewTab'
import { UsersTab } from './UsersTab'
import { useJobs } from './useJobs'

const TABS: TabDef<AdminTab>[] = [
  { id: 'overview', label: 'Overview', icon: <LayoutDashboard /> },
  { id: 'add', label: 'Add music', icon: <Plus /> },
  { id: 'jobs', label: 'Jobs', icon: <ListChecks /> },
  { id: 'library', label: 'Library', icon: <Database /> },
  { id: 'lyrics', label: 'Lyrics', icon: <FileText /> },
  { id: 'users', label: 'Users', icon: <Users /> },
  { id: 'backups', label: 'Backups', icon: <Archive /> }
]
const PREFIX = 'admin'

function isTab(v: unknown): v is AdminTab {
  return TABS.some((t) => t.id === v)
}

function JobsBadge(): ReactNode {
  const { active } = useJobs()
  if (active.length === 0) return null
  return (
    <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-bold text-ink-950 tabular-nums" aria-label={`${active.length} active jobs`}>
      {active.length}
    </span>
  )
}

export function AdminPage(): ReactNode {
  const allowed = useSession(isAdmin)
  const server = useSession((s) => s.server)
  const route = useNav((s) => s.route)
  const replace = useNav((s) => s.replace)

  if (!allowed) {
    return (
      <Page>
        <ErrorState message="You don't have access to this section." />
      </Page>
    )
  }

  const requested = route.name === 'admin' ? route.tab : undefined
  const tab: AdminTab = isTab(requested) ? requested : 'overview'
  const select = (t: AdminTab): void => replace({ name: 'admin', tab: t })

  return (
    <Page>
      <header className="fade-up mb-4 flex flex-wrap items-end gap-x-4 gap-y-1">
        <h1 className="text-3xl font-extrabold tracking-tight">Admin</h1>
        {server && (
          <p className="pb-1 text-sm text-fg-muted">
            {server.name} <span className="text-fg-subtle tabular-nums">v{server.version}</span>
          </p>
        )}
      </header>
      <div className="mb-5 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <Tabs tabs={TABS} value={tab} onChange={select} label="Admin sections" idPrefix={PREFIX} />
        </div>
        <JobsBadge />
      </div>
      <div role="tabpanel" id={panelDomId(PREFIX)} aria-labelledby={tabDomId(PREFIX, tab)} tabIndex={-1} className="max-w-5xl outline-none">
        {tab === 'overview' && <OverviewTab onNavigate={select} />}
        {tab === 'add' && <AddMusicTab />}
        {tab === 'jobs' && <JobsTab />}
        {tab === 'library' && <LibraryTab />}
        {tab === 'lyrics' && <LyricsTab />}
        {tab === 'users' && <UsersTab />}
        {tab === 'backups' && <BackupsTab />}
      </div>
    </Page>
  )
}
