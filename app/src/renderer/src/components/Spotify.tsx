import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, AudioLines, ChevronDown, Import, ListMusic, RotateCw, Search, Unplug, X } from 'lucide-react'
import { api, platform, useSession } from '../services'
import { describeError } from '../api/errors'
import type { SpotifyImport, SpotifyPlaylist, SpotifyStatus } from '../api/types'
import { useNav } from '../store/nav'
import { useUi } from '../store/ui'
import {
    importStatusLabel,
  connectionExpiry,
  createSpotifyStore,
  describeFinished,
  importProgress,
  isActiveImport,
  parseSpotifyPlaylist
} from '../store/spotify'
import { prefersReducedMotion, useSettings } from '../store/settings'
import { plural } from '../lib/format'
import { formatDate as fmtDate } from '../i18n/format'
import { useT } from '../i18n'
import { Button, Chip, Field, InlineError, ProgressBar, inputClass, type ChipTone } from '../pages/admin/ui'
import { Artwork, ExternalLink, Spinner, cx } from './common'
import { ConfirmDialog } from './ConfirmDialog'
import { Modal } from './Modal'

/** Icon tint for Spotify entry points (generic icon, brand-ish green). */
const SPOTIFY_TINT = 'text-[#1ed760]'

/** True when the connected server implements /v1/spotify/*. Hide every Spotify entry point otherwise. */
export function useSpotifyImportEnabled(): boolean {
  return useSession((s) => s.server?.capabilities?.spotifyImport === true)
}

/** App-wide Spotify store; toasts when an import the app watched finishes. */
export const useSpotify = createSpotifyStore({
  api,
  onFinished: (imp) => useUi.getState().toast(describeFinished(imp), imp.status === 'failed' ? 'error' : 'info')
})

/**
 * Mounted once in the signed-in shell: loads the import list and keeps active imports polled
 * (only while the window is visible) so the finish toast shows up wherever the user is.
 */
export function SpotifyImportsHost(): ReactNode {
  const enabled = useSpotifyImportEnabled()
  useEffect(() => {
    if (!enabled) return
    const store = useSpotify.getState()
    const unwatch = store.watch()
    void store.refreshImports()
    return () => {
      unwatch()
      useSpotify.getState().reset()
    }
  }, [enabled])
  return null
}

const imagesOf = (url: string | undefined) => (url ? [{ url }] : [])

const formatDate = (d: Date): string => fmtDate(d)

// ---- Connect flow ---------------------------------------------------------------------

/**
 * Starts the Spotify login in the system browser, then re-checks the status whenever the app
 * regains focus / visibility (the user comes back from the browser) or on `check()`.
 */
function useSpotifyConnect() {
  const loadStatus = useSpotify((s) => s.loadStatus)
  const authorize = useSpotify((s) => s.authorize)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [waiting, setWaiting] = useState(false)
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [checks, setChecks] = useState(0)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    if (!waiting) return
    const recheck = (): void => {
      if (document.visibilityState !== 'hidden') void loadStatus()
    }
    window.addEventListener('focus', recheck)
    document.addEventListener('visibilitychange', recheck)
    return () => {
      window.removeEventListener('focus', recheck)
      document.removeEventListener('visibilitychange', recheck)
    }
  }, [waiting, loadStatus])

  const connect = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const url = await authorize()
      setAuthUrl(url)
      setWaiting(true)
      await platform.openExternal(url).catch(() => undefined)
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  const check = async (): Promise<void> => {
    setChecking(true)
    await loadStatus()
    setChecking(false)
    setChecks((n) => n + 1)
  }

  return { connect, check, busy, checking, error, waiting, authUrl, checks }
}

function ConnectPanel({ compact = false }: { compact?: boolean }): ReactNode {
  const tr = useT()
  const c = useSpotifyConnect()
  const status = useSpotify((s) => s.status)
  return (
    <div className="space-y-4">
      {!compact && (
        <div className="flex items-start gap-3 rounded-xl bg-white/[0.04] p-4">
          <AudioLines className={cx('mt-0.5 h-6 w-6 shrink-0', SPOTIFY_TINT)} aria-hidden />
          <div className="min-w-0 text-sm text-fg-muted">
            <p className="font-semibold text-fg">{tr('sp.connectTitle')}</p>
            <p className="mt-1">
              {tr('sp.connectBody')}
            </p>
          </div>
        </div>
      )}
      {!c.waiting ? (
        <Button variant="primary" busy={c.busy} onClick={() => void c.connect()} icon={<AudioLines />} className="min-h-11 w-full sm:w-auto">
          {tr('sp.connect')}</Button>
      ) : (
        <div className="space-y-3" role="status" aria-live="polite">
          <p className="text-sm text-fg-muted">
            {tr('sp.finishSignin')}
            {c.checks > 0 && !c.checking && status && !status.connected && ` ${tr('sp.notYet')}`}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" busy={c.checking} onClick={() => void c.check()} className="min-h-11">
              {tr('sp.connected')}</Button>
            <Button busy={c.busy} onClick={() => void c.connect()} icon={<RotateCw />} className="min-h-11">
              {tr('common.retry')}
            </Button>
          </div>
          {c.authUrl && (
            <p className="text-xs text-fg-subtle">
              {tr('sp.noBrowser')} <ExternalLink href={c.authUrl}>{tr('sp.openSignin')}</ExternalLink>
            </p>
          )}
        </div>
      )}
      <InlineError message={c.error} />
    </div>
  )
}

// ---- Import dialog --------------------------------------------------------------------

function Switch({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }): ReactNode {
  const hintId = useId()
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-describedby={hintId}
      onClick={() => onChange(!checked)}
      className="flex min-h-11 w-full min-w-0 items-center gap-3 rounded-xl px-1 text-left"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{label}</span>
        <span id={hintId} className="block text-xs text-fg-muted">
          {hint}
        </span>
      </span>
      <span aria-hidden className={cx('relative h-7 w-12 shrink-0 rounded-full transition-colors duration-200', checked ? 'bg-accent' : 'bg-white/15')}>
        <span className={cx('absolute top-1 left-1 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200', checked && 'translate-x-5')} />
      </span>
    </button>
  )
}

function matches(p: SpotifyPlaylist, q: string): boolean {
  const needle = q.trim().toLocaleLowerCase()
  if (!needle) return true
  return `${p.name} ${p.owner ?? ''}`.toLocaleLowerCase().includes(needle)
}

function PlaylistPicker({ onStarted, onClose, status }: { onStarted?: (imp: SpotifyImport) => void; onClose: () => void; status: SpotifyStatus }): ReactNode {
  const tr = useT()
  const playlists = useSpotify((s) => s.playlists)
  const loading = useSpotify((s) => s.playlistsLoading)
  const loadError = useSpotify((s) => s.playlistsError)
  const loadPlaylists = useSpotify((s) => s.loadPlaylists)
  const startImport = useSpotify((s) => s.startImport)
  const disconnect = useSpotify((s) => s.disconnect)
  const toast = useUi((s) => s.toast)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<SpotifyPlaylist | null>(null)
  const [link, setLink] = useState('')
  const [linkTouched, setLinkTouched] = useState(false)
  const [download, setDownload] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ids = useId()

  useEffect(() => {
    void loadPlaylists(true)
  }, [loadPlaylists])

  const shown = useMemo(() => (playlists ?? []).filter((p) => matches(p, query)), [playlists, query])
  const linkId = link.trim() ? parseSpotifyPlaylist(link) : null
  const linkInvalid = link.trim() !== '' && linkId === null
  const source = linkId ?? selected?.id ?? null
  const expiry = connectionExpiry(status)

  const start = async (): Promise<void> => {
    if (busy) return
    if (linkInvalid) {
      setLinkTouched(true)
      return
    }
    if (!source) {
      setError(tr('sp.chooseOrPaste'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const imp = await startImport(source, download)
      const name = imp?.spotifyPlaylist?.name || (linkId ? undefined : selected?.name)
      toast(name ? tr('sp.importing', { name }) : tr('sp.importStarted'))
      onStarted?.(imp)
      onClose()
    } catch (err) {
      setError(describeError(err))
      setBusy(false)
    }
  }

  return (
    <Modal
      title={tr('sp.import')}
      description={
        <span className="block truncate">
          {status.account?.displayName ? tr('sp.connectedAs', { name: status.account.displayName }) : tr('sp.spotifyConnected')}
        </span>
      }
      size="md"
      dismissible={!busy}
      onClose={onClose}
      footer={
        <>
          <Button disabled={busy} onClick={onClose} className="min-h-11">
            {tr('common.cancel')}
          </Button>
          <Button variant="primary" busy={busy} disabled={!source || linkInvalid} onClick={() => void start()} className="min-h-11">
            {tr('sp.startImport')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {expiry && (expiry.expired || expiry.soon) && (
          <p className="flex items-start gap-2 rounded-xl bg-[#f5a524]/10 p-3 text-xs text-[#ffc15e]">
            <AlertTriangle className="mt-px h-4 w-4 shrink-0" aria-hidden />
            <span className="min-w-0">
              {expiry.expired
                ? tr('sp.expiredSettings') : tr('sp.expiresSettings', { date: formatDate(expiry.at) })}
            </span>
          </p>
        )}

        <Field
          label={tr('sp.pasteLink')}
          htmlFor={`${ids}-link`}
          hint={linkInvalid && linkTouched ? <span className="text-[#ff9b9b]">{tr('sp.badLink')}</span> : tr('sp.linkHint')}
        >
          <input
            id={`${ids}-link`}
            type="url"
            inputMode="url"
            className={inputClass}
            value={link}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={linkInvalid && linkTouched ? true : undefined}
            placeholder="https://open.spotify.com/playlist/…"
            onBlur={() => setLinkTouched(true)}
            onChange={(e) => {
              setLink(e.target.value)
              if (e.target.value.trim()) setSelected(null)
              setError(null)
            }}
          />
        </Field>

        <div>
          <h3 className="mb-2 text-xs font-semibold text-fg-muted">{tr('sp.orChoose')}</h3>
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
            <label htmlFor={`${ids}-search`} className="sr-only">
              {tr('sp.search')}
            </label>
            <input
              id={`${ids}-search`}
              type="search"
              data-autofocus
              value={query}
              disabled={busy}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={tr('sp.search')}
              autoComplete="off"
              className={cx(inputClass, 'pl-10')}
            />
          </div>
          {loading && !playlists && (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          )}
          {loadError && !playlists && (
            <p className="py-3 text-sm text-fg-muted">
              {loadError}{' '}
              <button type="button" onClick={() => void loadPlaylists(true)} className="min-h-11 font-semibold text-fg underline-offset-2 hover:underline">
                {tr('common.retry')}
              </button>
            </p>
          )}
          {playlists && playlists.length === 0 && <p className="py-3 text-sm text-fg-muted">{tr('sp.noPlaylists')}</p>}
          {playlists && playlists.length > 0 && shown.length === 0 && <p className="py-3 text-sm text-fg-muted">{tr('sp.noMatch', { query: query.trim() })}</p>}
          {shown.length > 0 && (
            <div role="radiogroup" aria-label={tr('sp.yourPlaylists')} className="-mx-2">
              {shown.map((p) => {
                const on = !linkId && selected?.id === p.id
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={busy}
                    onClick={() => {
                      setSelected(p)
                      setLink('')
                      setLinkTouched(false)
                      setError(null)
                    }}
                    className={cx(
                      'flex min-h-14 w-full min-w-0 items-center gap-3 rounded-lg px-2 py-1.5 text-left disabled:opacity-50',
                      on ? 'bg-accent-soft' : 'hover:bg-white/[0.06] focus-visible:bg-white/[0.06]'
                    )}
                  >
                    <Artwork images={imagesOf(p.image)} size={44} className="h-11 w-11 shrink-0" rounded="rounded-md" />
                    <span className="min-w-0 flex-1">
                      <span className={cx('block truncate text-sm font-medium', on && 'text-accent')}>{p.name}</span>
                      <span className="block truncate text-xs text-fg-muted">
                        {plural(Number(p.trackCount) || 0)}
                        {p.owner ? ` • ${p.owner}` : ''}
                      </span>
                    </span>
                    <span
                      aria-hidden
                      className={cx('flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2', on ? 'border-accent' : 'border-fg-subtle')}
                    >
                      {on && <span className="h-2.5 w-2.5 rounded-full bg-accent" />}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div className="border-t border-line pt-3">
          <Switch
            checked={download}
            onChange={setDownload}
            label={tr('sp.downloadMissing')}
            hint={
              download
                ? tr('sp.downloadOn')
                : tr('sp.downloadOff')
            }
          />
        </div>
        <InlineError message={error} />
        <p className="pb-2 text-xs text-fg-subtle">
          {tr('sp.wrongAccount')}{' '}
          <button
            type="button"
            disabled={busy}
            onClick={() => void disconnect().catch((err: unknown) => setError(describeError(err)))}
            className="min-h-11 font-semibold text-fg-muted underline-offset-2 hover:text-fg hover:underline"
          >
            {tr('sp.disconnectSpotify')}
          </button>
        </p>
      </div>
    </Modal>
  )
}

/** "Import from Spotify" dialog (a bottom sheet on phones): connect first if needed, then pick a playlist. */
export function SpotifyImportDialog({ onClose, onStarted }: { onClose: () => void; onStarted?: (imp: SpotifyImport) => void }): ReactNode {
  const tr = useT()
  const status = useSpotify((s) => s.status)
  const statusLoading = useSpotify((s) => s.statusLoading)
  const statusError = useSpotify((s) => s.statusError)
  const loadStatus = useSpotify((s) => s.loadStatus)

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  if (status?.configured && status.connected) return <PlaylistPicker status={status} onClose={onClose} onStarted={onStarted} />

  let body: ReactNode
  if (!status && statusError) {
    body = (
      <div className="space-y-3 pb-2">
        <p className="text-sm text-fg-muted">{statusError}</p>
        <Button onClick={() => void loadStatus()} icon={<RotateCw />} className="min-h-11">
          {tr('common.retry')}
        </Button>
      </div>
    )
  } else if (!status) {
    body = (
      <div className="flex justify-center py-8" aria-busy={statusLoading || undefined}>
        <Spinner />
      </div>
    )
  } else if (!status.configured) {
    body = <p className="pb-2 text-sm text-fg-muted">{tr('sp.notSetUp')}</p>
  } else {
    body = <ConnectPanel />
  }

  return (
    <Modal title={tr('sp.import')} size="md" onClose={onClose}>
      {body}
    </Modal>
  )
}

/** Library grid tile next to "New playlist". Sized like a MediaCard. */
export function ImportSpotifyTile({ onClick }: { onClick: () => void }): ReactNode {
  const tr = useT()
  return (
    <button
      type="button"
      onClick={onClick}
      className="group w-full min-w-0 rounded-[var(--radius-card)] p-2.5 text-left transition-colors duration-200 hover:bg-white/[0.045] focus-visible:bg-white/[0.045]"
    >
      <span className="mb-3 flex aspect-square w-full items-center justify-center rounded-lg border-2 border-dashed border-line bg-white/[0.03] transition-colors group-hover:border-accent/60">
        <AudioLines className={cx('h-10 w-10', SPOTIFY_TINT)} strokeWidth={1.6} aria-hidden />
      </span>
      <span className="block truncate text-[15px] font-semibold">{tr('sp.import')}</span>
      <span className="mt-0.5 block truncate text-[13px] text-fg-muted">{tr('sp.bring')}</span>
    </button>
  )
}

// ---- Progress ---------------------------------------------------------------------------

const TONE: Record<SpotifyImport['status'], ChipTone> = {
  queued: 'neutral',
  reading: 'accent',
  matching: 'accent',
  downloading: 'accent',
  done: 'good',
  failed: 'bad',
  cancelled: 'neutral'
}

function ImportRow({ imp }: { imp: SpotifyImport }): ReactNode {
  const tr = useT()
  const go = useNav((s) => s.go)
  const cancelImport = useSpotify((s) => s.cancelImport)
  const [confirming, setConfirming] = useState(false)
  const [showFailures, setShowFailures] = useState(false)
  const failuresId = useId()
  const active = isActiveImport(imp)
  const { ready, total, fraction } = importProgress(imp)
  const name = imp.spotifyPlaylist?.name || tr('sp.playlistFallback')
  const label = importStatusLabel(imp.status)
  const failures = Array.isArray(imp.failures) ? imp.failures : []
  const notFound = Math.max(Number(imp.failed) || 0, failures.length)
  const counts = [
    total > 0 ? tr('sp.ofSongs', { ready, songs: plural(total) }) : active ? tr('sp.counting') : plural(ready),
    imp.matched > 0 && tr('sp.inLibrary', { n: imp.matched }),
    imp.downloaded > 0 && tr('sp.downloaded', { n: imp.downloaded }),
    notFound > 0 && tr('sp.notFound', { n: notFound }),
    active && imp.pending > 0 && tr('sp.toGo', { n: imp.pending })
  ].filter(Boolean)

  return (
    <li className="min-w-0 rounded-xl bg-white/[0.035] p-3">
      <div className="flex min-w-0 items-start gap-3">
        <Artwork images={imagesOf(imp.spotifyPlaylist?.image)} size={48} className="h-12 w-12 shrink-0" rounded="rounded-md" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <p className="min-w-0 truncate text-[15px] font-semibold">{name}</p>
            <Chip tone={TONE[imp.status] ?? 'neutral'}>{label}</Chip>
          </div>
          <p className="mt-0.5 text-xs text-fg-muted tabular-nums">{counts.join(' • ')}</p>
          {imp.status === 'failed' && imp.error && <p className="mt-0.5 text-xs text-[#ff9b9b]">{imp.error}</p>}
          <span className="sr-only" aria-live="polite">
            {active ? '' : `${name}: ${label}`}
          </span>
        </div>
      </div>
      <ProgressBar
        className="mt-3"
        label={tr('sp.progress', { name })}
        value={active && fraction === undefined ? undefined : (fraction ?? 1)}
        tone={imp.status === 'done' ? 'good' : imp.status === 'failed' ? 'bad' : imp.status === 'cancelled' ? 'warn' : 'accent'}
      />
      {(imp.playlistId || active || failures.length > 0) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {imp.playlistId && (
            <Button size="sm" icon={<ListMusic />} onClick={() => go({ name: 'playlist', id: imp.playlistId! })} className="min-h-11">
              {tr('sp.openPlaylist')}
            </Button>
          )}
          {active && (
            <Button size="sm" variant="ghost" icon={<X />} onClick={() => setConfirming(true)} className="min-h-11">
              {tr('common.cancel')}
            </Button>
          )}
          {failures.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={showFailures}
              aria-controls={failuresId}
              onClick={() => setShowFailures((v) => !v)}
              icon={<ChevronDown className={cx('transition-transform', showFailures && 'rotate-180')} />}
              className="min-h-11"
            >
              {showFailures ? tr('sp.hideFailures', { n: failures.length }) : tr('sp.showFailures', { n: failures.length })}
            </Button>
          )}
        </div>
      )}
      {failures.length > 0 && showFailures && (
        <ul id={failuresId} aria-label={tr('sp.failuresLabel', { name })} className="mt-2 max-h-64 space-y-1 overflow-y-auto rounded-lg bg-ink-900/60 p-2">
          {failures.map((f, i) => (
            <li key={`${f.title}-${i}`} className="min-w-0 px-1 py-1 text-xs">
              <span className="block truncate font-medium text-fg">{f.title}</span>
              <span className="block truncate text-fg-muted">
                {f.artists}
                {f.reason ? ` — ${f.reason}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      {confirming && (
        <ConfirmDialog
          title={tr('sp.cancelQ')} message={tr('sp.cancelMsg', { name })} confirmLabel={tr('sp.cancelImport')} cancelLabel={tr('sp.keepImporting')}
          tone="danger"
          onConfirm={() => cancelImport(imp.id)}
          onClose={() => setConfirming(false)}
        />
      )}
    </li>
  )
}

const RECENT_MS = 10 * 60_000
const COLLAPSED_COUNT = 3

/** "Imports" section at the top of Library → Playlists, shown while there are Spotify imports. */
export function SpotifyImports(): ReactNode {
  const tr = useT()
  const enabled = useSpotifyImportEnabled()
  const imports = useSpotify((s) => s.imports)
  const reduced = prefersReducedMotion(useSettings((s) => s.motion))
  const [explicitOpen, setExplicitOpen] = useState<boolean | null>(null)
  const [showAll, setShowAll] = useState(false)
  // Once shown open, stay open while mounted (an import finishing must not collapse it under the user).
  const autoOpened = useRef(false)
  const headingId = useId()
  const listId = useId()
  if (!enabled || imports.length === 0) return null

  const active = imports.filter(isActiveImport).length
  const latestFinish = Math.max(0, ...imports.map((i) => (i.finishedAt ? Date.parse(i.finishedAt) || 0 : 0)))
  if (active > 0 || Date.now() - latestFinish < RECENT_MS) autoOpened.current = true
  const open = explicitOpen ?? autoOpened.current
  const shown = showAll ? imports : imports.slice(0, COLLAPSED_COUNT)
  const summary = active > 0 ? tr('sp.running', { n: active }) : plural(imports.length, 'common.recentImport')

  return (
    <section aria-labelledby={headingId} className={cx('mb-6 min-w-0 rounded-2xl bg-white/[0.035] p-3 sm:p-4', !reduced && 'fade-up')}>
      <h2 id={headingId} className="m-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setExplicitOpen(!open)}
          className="flex min-h-11 w-full min-w-0 items-center gap-3 rounded-lg text-left"
        >
          <AudioLines className={cx('h-5 w-5 shrink-0', SPOTIFY_TINT)} aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-base font-bold tracking-tight">{tr('sp.imports')}</span>
            <span className="block truncate text-xs font-normal text-fg-muted">{summary}</span>
          </span>
          <ChevronDown className={cx('h-5 w-5 shrink-0 text-fg-muted', !reduced && 'transition-transform', open && 'rotate-180')} aria-hidden />
        </button>
      </h2>
      {open && (
        <div id={listId} className="mt-3">
          <ul className="space-y-2">
            {shown.map((imp) => (
              <ImportRow key={imp.id} imp={imp} />
            ))}
          </ul>
          {imports.length > COLLAPSED_COUNT && (
            <Button size="sm" variant="ghost" onClick={() => setShowAll((v) => !v)} className="mt-2 min-h-11">
              {showAll ? tr('sp.showFewer') : tr('sp.showAll', { n: imports.length })}
            </Button>
          )}
        </div>
      )}
    </section>
  )
}

// ---- Settings ---------------------------------------------------------------------------

/** Body of the Settings → Spotify section. */
export function SpotifySettings(): ReactNode {
  const tr = useT()
  const status = useSpotify((s) => s.status)
  const statusLoading = useSpotify((s) => s.statusLoading)
  const statusError = useSpotify((s) => s.statusError)
  const loadStatus = useSpotify((s) => s.loadStatus)
  const disconnect = useSpotify((s) => s.disconnect)
  const toast = useUi((s) => s.toast)
  const go = useNav((s) => s.go)
  const [confirming, setConfirming] = useState(false)
  const [importing, setImporting] = useState(false)
  const [reconnect, setReconnect] = useState(false)

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  if (!status) {
    if (statusError) {
      return (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 text-sm text-fg-muted">{statusError}</p>
          <Button size="sm" onClick={() => void loadStatus()} icon={<RotateCw />} className="min-h-11">
            {tr('common.retry')}
          </Button>
        </div>
      )
    }
    return (
      <div className="flex py-2" aria-busy={statusLoading || undefined}>
        <Spinner />
      </div>
    )
  }

  if (!status.configured) {
    return <p className="text-sm text-fg-muted">{tr('sp.notSetUp')}</p>
  }

  if (!status.connected) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-fg-muted">{tr('sp.connectToImport')}</p>
        <ConnectPanel compact />
      </div>
    )
  }

  const expiry = connectionExpiry(status)
  const name = status.account?.displayName || status.account?.id || tr('sp.yourAccount')
  return (
    <div className="space-y-4">
      <div className="flex min-w-0 items-center gap-3">
        <AudioLines className={cx('h-6 w-6 shrink-0', SPOTIFY_TINT)} aria-hidden />
        <div className="min-w-0">
          <p className="truncate text-[15px] font-medium">{tr('sp.connectedAs', { name })}</p>
          {expiry && (
            <p className={cx('text-[13px]', expiry.expired || expiry.soon ? 'text-[#ffc15e]' : 'text-fg-muted')}>
              {expiry.expired
                ? tr('sp.expired')
                : expiry.soon
                  ? tr('sp.expiresSoon', { date: formatDate(expiry.at), days: plural(Math.max(1, expiry.daysLeft), 'common.day') })
                  : tr('sp.validUntil', { date: formatDate(expiry.at) })}
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" icon={<Import />} onClick={() => setImporting(true)} className="min-h-11">
          {tr('sp.importPlaylist')}
        </Button>
        {(expiry?.expired || expiry?.soon) && !reconnect && (
          <Button icon={<RotateCw />} onClick={() => setReconnect(true)} className="min-h-11">
            {tr('sp.reconnect')}
          </Button>
        )}
        <Button variant="danger" icon={<Unplug />} onClick={() => setConfirming(true)} className="min-h-11">
          {tr('sp.disconnect')}
        </Button>
      </div>
      {reconnect && <ConnectPanel compact />}
      {confirming && (
        <ConfirmDialog
          title={tr('sp.disconnectQ')}
          message={tr('sp.disconnectMsg')}
          confirmLabel={tr('sp.disconnect')}
          tone="danger"
          onConfirm={async () => {
            await disconnect()
            toast(tr('sp.disconnected'))
          }}
          onClose={() => setConfirming(false)}
        />
      )}
      {importing && <SpotifyImportDialog onClose={() => setImporting(false)} onStarted={() => go({ name: 'library', tab: 'playlists' })} />}
    </div>
  )
}
