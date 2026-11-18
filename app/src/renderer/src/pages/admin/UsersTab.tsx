import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { Dices, Eye, EyeOff, Pencil, Plus, Trash2 } from 'lucide-react'
import type { AdminUser, UserRole } from '../../api/types'
import { describeError } from '../../api/errors'
import { api, useSession } from '../../services'
import { useUi } from '../../store/ui'
import { useResource } from '../../hooks/useResource'
import { resources } from '../../lib/resource'
import { EmptyState, ErrorState, IconButton, Spinner } from '../../components/common'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Modal } from '../../components/Modal'
import { generatePassword, relativeTime } from './format'
import { Button, Card, Chip, Field, InlineError, Segmented, inputClass, useTick } from './ui'
import { useT } from '../../i18n'

const MIN_PASSWORD = 10
const KEY = 'admin:users'

function Avatar({ user }: { user: AdminUser }): ReactNode {
  return (
    <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-bold text-ink-950">
      {(user.displayName || user.username).slice(0, 1).toUpperCase()}
    </span>
  )
}

function PasswordField({ id, value, onChange, label }: { id: string; value: string; onChange: (v: string) => void; label: string }): ReactNode {
  const tr = useT()
  const [show, setShow] = useState(false)
  const short = value.length > 0 && value.length < MIN_PASSWORD
  return (
    <Field label={label} htmlFor={id} hint={<span className={short ? 'text-[#ff9b9b]' : undefined}>{tr('usr.atLeast', { count: MIN_PASSWORD })}</span>}>
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <input
            id={id}
            type={show ? 'text' : 'password'}
            className={`${inputClass} pr-11 font-mono`}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            autoComplete="new-password"
            spellCheck={false}
            aria-invalid={short || undefined}
          />
          <button
            type="button"
            aria-label={show ? tr('usr.hide') : tr('usr.show')}
            onClick={() => setShow((v) => !v)}
            className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-full p-1.5 text-fg-subtle hover:text-fg"
          >
            {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        <Button
          icon={<Dices />}
          aria-label={tr('usr.generate')} title={tr('usr.generate')}
          onClick={() => {
            onChange(generatePassword())
            setShow(true)
          }}
        >
          <span className="max-sm:sr-only">{tr('usr.generateShort')}</span>
        </Button>
      </div>
    </Field>
  )
}

function RoleField({ value, onChange }: { value: UserRole; onChange: (r: UserRole) => void }): ReactNode {
  const tr = useT()
  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold text-fg-muted">{tr('usr.role')}</p>
      <Segmented label={tr('usr.role')} value={value} onChange={onChange} options={[{ id: 'user', label: tr('usr.roleUser') }, { id: 'admin', label: tr('usr.roleAdmin') }]} />
    </div>
  )
}

function CreateUserDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }): ReactNode {
  const tr = useT()
  const ids = useId()
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<UserRole>('user')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const valid = username.trim().length > 0 && password.length >= MIN_PASSWORD

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    try {
      const u = await api.adminCreateUser({ username: username.trim(), displayName: displayName.trim() || undefined, password, role })
      useUi.getState().toast(tr('usr.created', { username: u.username }))
      onCreated()
      onClose()
    } catch (err) {
      setError(describeError(err))
      setBusy(false)
    }
  }

  return (
    <Modal
      title={tr('usr.createTitle')}
      size="md"
      dismissible={!busy}
      onClose={onClose}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>{tr('common.cancel')}</Button>
          <Button type="submit" form={`${ids}-create`} variant="primary" busy={busy} disabled={!valid}>{tr('usr.createTitle')}</Button>
        </>
      }
    >
      <form id={`${ids}-create`} onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
        <Field label={tr('usr.username')} htmlFor={`${ids}-u`}>
          <input id={`${ids}-u`} data-autofocus className={inputClass} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} required />
        </Field>
        <Field label={tr('usr.displayOptional')} htmlFor={`${ids}-d`}>
          <input id={`${ids}-d`} className={inputClass} value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="off" />
        </Field>
        <PasswordField id={`${ids}-p`} label={tr('usr.password')} value={password} onChange={setPassword} />
        <RoleField value={role} onChange={setRole} />
        <InlineError message={error} />
      </form>
    </Modal>
  )
}

function EditUserDialog({ user, self, onClose, onSaved }: { user: AdminUser; self: boolean; onClose: () => void; onSaved: () => void }): ReactNode {
  const tr = useT()
  const ids = useId()
  const [displayName, setDisplayName] = useState(user.displayName)
  const [role, setRole] = useState<UserRole>(user.role)
  const [disabled, setDisabled] = useState(Boolean(user.disabled))
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const passwordOk = password.length === 0 || password.length >= MIN_PASSWORD

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!passwordOk || busy) return
    const patch: Parameters<typeof api.adminUpdateUser>[1] = {}
    if (displayName.trim() !== user.displayName) patch.displayName = displayName.trim()
    if (role !== user.role) patch.role = role
    if (disabled !== Boolean(user.disabled)) patch.disabled = disabled
    if (password) patch.password = password
    if (Object.keys(patch).length === 0) {
      onClose()
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.adminUpdateUser(user.id, patch)
      useUi.getState().toast(patch.password ? tr('usr.savedSignedOut', { username: user.username }) : tr('usr.saved', { username: user.username }))
      onSaved()
      onClose()
    } catch (err) {
      setError(describeError(err))
      setBusy(false)
    }
  }

  const selfNote = tr('usr.selfNote')
  return (
    <Modal
      title={tr('usr.editTitle', { username: user.username })}
      size="md"
      dismissible={!busy}
      onClose={onClose}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>{tr('common.cancel')}</Button>
          <Button type="submit" form={`${ids}-edit`} variant="primary" busy={busy} disabled={!passwordOk}>{tr('usr.saveChanges')}</Button>
        </>
      }
    >
      <form id={`${ids}-edit`} onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
        <Field label={tr('usr.display')} htmlFor={`${ids}-d`}>
          <input id={`${ids}-d`} data-autofocus className={inputClass} value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="off" />
        </Field>
        <div title={self ? selfNote : undefined} className={self ? 'pointer-events-none opacity-50' : undefined} aria-disabled={self || undefined}>
          <RoleField value={role} onChange={self ? () => undefined : setRole} />
        </div>
        <div className="flex items-center justify-between gap-4" title={self ? selfNote : undefined}>
          <div>
            <label htmlFor={`${ids}-dis`} className="block text-sm font-medium">{tr('usr.disable')}</label>
            <p className="text-xs text-fg-muted">{tr('usr.disableHint')}</p>
          </div>
          <input
            id={`${ids}-dis`}
            type="checkbox"
            role="switch"
            checked={disabled}
            disabled={self}
            onChange={(e) => setDisabled(e.target.checked)}
            className="h-5 w-5 shrink-0 accent-[var(--color-accent)] disabled:opacity-40"
          />
        </div>
        {self && <p className="text-xs text-fg-subtle">{selfNote}</p>}
        <PasswordField id={`${ids}-p`} label={tr('usr.reset')} value={password} onChange={setPassword} />
        <InlineError message={error} />
      </form>
    </Modal>
  )
}

export function UsersTab(): ReactNode {
  const tr = useT()
  const me = useSession((s) => s.session?.user.id)
  const users = useResource<AdminUser[]>(KEY, async (signal) => (await api.adminUsers(signal)).users)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<AdminUser | null>(null)
  const [deleting, setDeleting] = useState<AdminUser | null>(null)
  const now = useTick()

  const refresh = (): void => {
    resources.invalidate(KEY)
    users.reload()
  }

  if (users.loading) return <div className="flex justify-center py-20"><Spinner /></div>
  if (users.error && !users.data) return <ErrorState message={users.error} onRetry={users.reload} />
  const list = users.data ?? []

  return (
    <Card id="users-title" title={tr('usr.title')} action={<Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>{tr('usr.createTitle')}</Button>}>
      {list.length === 0 ? (
        <EmptyState icon={<Plus className="h-8 w-8" strokeWidth={1.5} />} title={tr('usr.none')} />
      ) : (
        <ul className="space-y-2">
          {list.map((u) => {
            const self = u.id === me
            return (
              <li key={u.id} className="flex items-center gap-3 rounded-xl bg-white/[0.03] p-3">
                <Avatar user={u} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p className="min-w-0 truncate text-sm font-semibold">{u.displayName || u.username}</p>
                    <Chip tone={u.role === 'admin' ? 'accent' : 'neutral'}>{u.role === 'admin' ? tr('usr.roleAdmin') : tr('usr.roleUser')}</Chip>
                    {u.disabled && <Chip tone="bad">{tr('usr.disabled')}</Chip>}
                    {self && <Chip tone="good">{tr('usr.you')}</Chip>}
                  </div>
                  <p className="truncate text-[13px] text-fg-muted">
                    @{u.username}
                    <span className="text-fg-subtle"> · {u.lastLoginAt ? tr('usr.lastLogin', { when: relativeTime(u.lastLoginAt, now) }) : tr('usr.never')}</span>
                  </p>
                </div>
                <IconButton label={tr('usr.edit', { username: u.username })} size="sm" onClick={() => setEditing(u)}>
                  <Pencil className="h-4 w-4" />
                </IconButton>
                <span title={self ? tr('usr.noDeleteSelf') : undefined}>
                  <IconButton label={self ? tr('usr.noDeleteSelf') : tr('usr.delete', { username: u.username })} size="sm" disabled={self} onClick={() => setDeleting(u)} className="hover:text-[#ff8f93]">
                    <Trash2 className="h-4 w-4" />
                  </IconButton>
                </span>
              </li>
            )
          })}
        </ul>
      )}

      {creating && <CreateUserDialog onClose={() => setCreating(false)} onCreated={refresh} />}
      {editing && <EditUserDialog user={editing} self={editing.id === me} onClose={() => setEditing(null)} onSaved={refresh} />}
      {deleting && (
        <ConfirmDialog
          title={tr('usr.deleteQ', { username: deleting.username })}
          tone="danger"
          confirmLabel={tr('usr.deleteConfirm')}
          message={tr('usr.deleteMsg')}
          onConfirm={async () => {
            await api.adminDeleteUser(deleting.id)
            useUi.getState().toast(tr('usr.deleted', { username: deleting.username }))
            refresh()
          }}
          onClose={() => setDeleting(null)}
        />
      )}
    </Card>
  )
}
