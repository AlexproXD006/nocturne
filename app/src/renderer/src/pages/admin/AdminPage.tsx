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
import { useT, type MessageKey } from '../../i18n'

const TABS: (Omit<TabDef<AdminTab>, 'label'> & { label: MessageKey })[] = [
  { id: 'overview', label: 'adm.tab.overview', icon: <LayoutDashboard /> },
  { id: 'add', label: 'adm.tab.add', icon: <Plus /> },
  { id: 'jobs', label: 'adm.tab.jobs', icon: <ListChecks /> },
  { id: 'library', label: 'adm.tab.library', icon: <Database /> },
  { id: 'lyrics', label: 'adm.tab.lyrics', icon: <FileText /> },
  { id: 'users', label: 'adm.tab.users', icon: <Users /> },
  { id: 'backups', label: 'adm.tab.backups', icon: <Archive /> }
]
const PREFIX = 'admin'

function isTab(v: unknown): v is AdminTab {
  return TABS.some((t) => t.id === v)
}

function JobsBadge(): ReactNode {
  const tr = useT()
  const { active } = useJobs()
  if (active.length === 0) return null
  return (
    <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-bold text-ink-950 tabular-nums" aria-label={tr('adm.activeJobs', { count: active.length })}>
      {active.length}
    </span>
  )
}

export function AdminPage(): ReactNode {
  const tr = useT()
  const allowed = useSession(isAdmin)
  const server = useSession((s) => s.server)
  const route = useNav((s) => s.route)
  const replace = useNav((s) => s.replace)

  if (!allowed) {
    return (
      <Page>
        <ErrorState message={tr('adm.noAccess')} />
      </Page>
    )
  }

  const requested = route.name === 'admin' ? route.tab : undefined
  const tab: AdminTab = isTab(requested) ? requested : 'overview'
  const select = (t: AdminTab): void => replace({ name: 'admin', tab: t })

  return (
    <Page>
      <header className="fade-up mb-4 flex flex-wrap items-end gap-x-4 gap-y-1">
        <h1 className="text-3xl font-extrabold tracking-tight">{tr('adm.title')}</h1>
        {server && (
          <p className="pb-1 text-sm text-fg-muted">
            {server.name} <span className="text-fg-subtle tabular-nums">v{server.version}</span>
          </p>
        )}
      </header>
      <div className="mb-5 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <Tabs tabs={TABS.map((x) => ({ ...x, label: tr(x.label) }))} value={tab} onChange={select} label={tr('adm.sections')} idPrefix={PREFIX} />
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
