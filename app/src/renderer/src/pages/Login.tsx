import { useState, type FormEvent, type ReactNode } from 'react'
import { Eye, EyeOff, Lock, Server } from 'lucide-react'
import { platform, useSession } from '../services'
import { describeError } from '../api/errors'
import { Spinner, cx } from '../components/common'
import { Logo, TitleBar } from '../components/Shell'
import { LanguageSelect } from '../components/LanguageSelect'
import { useT } from '../i18n'

export function Login(): ReactNode {
  const tr = useT()
  const lastServer = useSession((s) => s.lastServerUrl)
  const login = useSession((s) => s.login)
  const restoreError = useSession((s) => s.restoreError)
  const hosted = platform.hostedOrigin
  const [server, setServer] = useState(lastServer)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await login(hosted ?? server, username, password)
    } catch (err) {
      setError(describeError(err))
      setPassword('')
    } finally {
      setBusy(false)
    }
  }

  const field = 'w-full rounded-xl border border-line bg-ink-850 py-3 pr-4 pl-11 text-[15px] outline-none transition placeholder:text-fg-subtle focus:border-accent/70 focus:bg-ink-800'

  return (
    <div className="flex h-full flex-col bg-ink-950">
      <TitleBar />
      <div className="absolute top-3 right-3 z-10 md:top-12">
        <LanguageSelect className="rounded-full border border-line bg-ink-850 px-3 py-1.5 text-xs text-fg-muted outline-none focus:border-accent/70" />
      </div>
      <div className="relative flex flex-1 items-center justify-center overflow-y-auto px-5 py-10">
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute -top-40 left-1/2 h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-accent/20 blur-[120px]" />
          <div className="absolute -bottom-40 left-1/4 h-[420px] w-[420px] rounded-full bg-[#7b5cff]/15 blur-[120px]" />
        </div>
        <form onSubmit={(e) => void submit(e)} className="fade-up relative w-full max-w-sm" noValidate>
          <div className="mb-8 flex flex-col items-center text-center">
            <Logo className="mb-5 h-14 w-14" />
            <h1 className="text-3xl font-extrabold tracking-tight">{tr('login.welcome')}</h1>
            <p className="mt-2 text-sm text-fg-muted">{tr('login.subtitle')}</p>
          </div>

          {hosted ? (
            <p className="-mt-4 mb-6 flex items-center justify-center gap-1.5 text-center text-xs text-fg-subtle">
              <Server className="h-3.5 w-3.5" aria-hidden /> {new URL(hosted).host}
            </p>
          ) : (
            <>
          <label className="mb-1.5 block text-xs font-semibold text-fg-muted" htmlFor="server">{tr('login.server')}</label>
          <div className="relative mb-4">
            <Server className="pointer-events-none absolute top-1/2 left-4 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
            <input
              id="server"
              className={field}
              value={server}
              onChange={(e) => setServer(e.target.value)}
              placeholder="music.example.com"
              autoComplete="url"
              inputMode="url"
              spellCheck={false}
              autoCapitalize="none"
              required
            />
          </div>

            </>
          )}

          <label className="mb-1.5 block text-xs font-semibold text-fg-muted" htmlFor="username">{tr('login.username')}</label>
          <div className="relative mb-4">
            <span className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-sm text-fg-subtle">@</span>
            <input
              id="username"
              className={field}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              spellCheck={false}
              autoCapitalize="none"
              required
            />
          </div>

          <label className="mb-1.5 block text-xs font-semibold text-fg-muted" htmlFor="password">{tr('login.password')}</label>
          <div className="relative mb-2">
            <Lock className="pointer-events-none absolute top-1/2 left-4 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
            <input
              id="password"
              type={show ? 'text' : 'password'}
              className={cx(field, 'pr-12')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
            <button
              type="button"
              aria-label={show ? tr('login.hide') : tr('login.show')}
              onClick={() => setShow((v) => !v)}
              className="absolute top-1/2 right-3 -translate-y-1/2 rounded-full p-1.5 text-fg-subtle hover:text-fg"
            >
              {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>

          <p role="alert" className={cx('min-h-6 text-sm text-[#ff9b9b]', !(error ?? restoreError) && 'invisible')}>{error ?? restoreError ?? '.'}</p>

          <button
            type="submit"
            disabled={busy}
            className="mt-2 flex h-12 w-full items-center justify-center rounded-full bg-accent text-[15px] font-bold text-ink-950 transition hover:brightness-110 active:scale-[0.99] disabled:opacity-60"
          >
            {busy ? <Spinner className="h-5 w-5 text-ink-950" /> : tr('login.submit')}
          </button>
          <p className="mt-6 text-center text-xs text-fg-subtle">{tr('login.privacy')}</p>
        </form>
      </div>
    </div>
  )
}
