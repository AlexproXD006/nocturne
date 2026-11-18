import { useEffect, useId, useState, type ReactNode } from 'react'
import { CheckCircle2, RotateCw, Unplug } from 'lucide-react'
import { useListenBrainz, useSession } from '../services'
import { describeError } from '../api/errors'
import { useUi } from '../store/ui'
import { useT } from '../i18n'
import { Button, Field, InlineError, inputClass } from '../pages/admin/ui'
import { Row, Toggle } from '../pages/SettingsControls'
import { ExternalLink, Spinner } from './common'

/** True when the connected server implements /v1/listenbrainz/*. */
export function useListenBrainzEnabled(): boolean {
  return useSession((s) => s.server?.capabilities?.listenbrainz === true)
}

/** Body of the Settings → Integrations → ListenBrainz block. */
export function ListenBrainzSettings(): ReactNode {
  const tr = useT()
  const status = useListenBrainz((s) => s.status)
  const loading = useListenBrainz((s) => s.loading)
  const loadError = useListenBrainz((s) => s.error)
  const toast = useUi((s) => s.toast)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState<'test' | 'save' | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const id = useId()

  useEffect(() => {
    void useListenBrainz.getState().load()
  }, [])

  const run = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      toast(describeError(err), 'error')
    }
  }

  if (!status) {
    if (loadError) {
      return (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 text-sm text-fg-muted">{loadError}</p>
          <Button size="sm" icon={<RotateCw />} className="min-h-11" onClick={() => void useListenBrainz.getState().load()}>
            {tr('common.retry')}
          </Button>
        </div>
      )
    }
    return (
      <div className="flex py-2" aria-busy={loading || undefined}>
        <Spinner />
      </div>
    )
  }

  const test = async (): Promise<void> => {
    setBusy('test')
    setMessage(null)
    try {
      const name = await useListenBrainz.getState().test(token.trim() || undefined)
      setMessage(name === null ? { ok: false, text: tr('lb.invalid') } : { ok: true, text: name ? tr('lb.validAs', { name }) : tr('lb.valid') })
    } catch (err) {
      setMessage({ ok: false, text: describeError(err) })
    } finally {
      setBusy(null)
    }
  }

  const save = async (): Promise<void> => {
    setBusy('save')
    setMessage(null)
    try {
      await useListenBrainz.getState().connect(token)
      setToken('')
      toast(tr('lb.connected'))
    } catch (err) {
      setMessage({ ok: false, text: describeError(err) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-fg-muted">
        {tr('lb.intro', { link: '\u0000' })
          .split('\u0000')
          .flatMap((part, i) => (i === 0 ? [part] : [<ExternalLink key="l" href="https://listenbrainz.org/settings/">listenbrainz.org/settings</ExternalLink>, part]))}
      </p>

      {status.connected && (
        <>
          <Row label={tr('lb.scrobble')} hint={status.userName ? tr('lb.connectedAs', { name: status.userName }) : tr('lb.connected')}>
            <Toggle label={tr('lb.scrobble')} checked={status.enabled} onChange={(v) => void run(() => useListenBrainz.getState().setEnabled(v))} />
          </Row>
          <Row label={tr('lb.nowPlaying')} hint={tr('lb.nowPlayingHint')}>
            <Toggle label={tr('lb.nowPlaying')} checked={status.nowPlaying} onChange={(v) => void run(() => useListenBrainz.getState().setNowPlaying(v))} />
          </Row>
          {status.pending > 0 && <p className="text-[13px] text-fg-muted">{tr('lb.pending', { count: status.pending })}</p>}
          {status.lastError && <p className="text-[13px] text-[#ffc15e]">{tr('lb.lastError', { error: status.lastError })}</p>}
        </>
      )}

      <Field label={status.connected ? tr('lb.replaceToken') : tr('lb.token')} htmlFor={id} hint={tr('lb.tokenHint')}>
        <input
          id={id}
          type="password"
          className={inputClass}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={token}
          placeholder={status.connected ? '••••••••-••••-••••' : ''}
          onChange={(e) => setToken(e.currentTarget.value)}
        />
      </Field>
      <InlineError message={message && !message.ok ? message.text : null} />
      {message?.ok && (
        <p className="flex items-center gap-2 text-sm text-accent">
          <CheckCircle2 className="h-4 w-4" aria-hidden /> {message.text}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button className="min-h-11" busy={busy === 'test'} disabled={busy !== null || (!token.trim() && !status.connected)} onClick={() => void test()}>
          {tr('lb.test')}
        </Button>
        <Button variant="primary" className="min-h-11" busy={busy === 'save'} disabled={busy !== null || !token.trim()} onClick={() => void save()}>
          {tr('lb.save')}
        </Button>
        {status.connected && (
          <Button variant="danger" icon={<Unplug />} className="min-h-11" disabled={busy !== null} onClick={() => void run(async () => { await useListenBrainz.getState().disconnect(); toast(tr('lb.disconnected')) })}>
            {tr('lb.disconnect')}
          </Button>
        )}
      </div>
    </div>
  )
}
