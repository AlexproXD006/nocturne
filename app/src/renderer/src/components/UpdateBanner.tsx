import { useEffect, useState, type ReactNode } from 'react'
import { Download, X } from 'lucide-react'
import { useT } from '../i18n'
import { platform, useSession } from '../services'
import { useUpdates } from '../store/updates'
import { useUpdateReveal } from '../store/updateNotifications'
import { readJson, writeJson } from '../lib/storage'

const DISMISS_KEY = 'nocturne.update.dismissed'

/** The version the user last tapped "Later" on, so we don't nag for the same build. */
function readDismissed(): string {
  return readJson<string>(DISMISS_KEY, '', (v): v is string => typeof v === 'string')
}

/**
 * Top-of-app banner shown only on native builds (Android / desktop) when the update feed
 * advertises a newer version. "Update now" opens the download URL externally; the OS
 * download manager / installer takes over. Never shown on web (the browser app self-updates).
 */
export function UpdateBanner(): ReactNode {
  const t = useT()
  const status = useSession((s) => s.status)
  const available = useUpdates((s) => s.available)
  const latest = useUpdates((s) => s.latest)
  const downloadUrl = useUpdates((s) => s.downloadUrl)
  const autoCheck = useUpdates((s) => s.autoCheck)
  const [dismissed, setDismissed] = useState<string>(() => readDismissed())
  // Set when the user tapped the "update available" system notification: show even if dismissed.
  const revealed = useUpdateReveal((s) => s.version)

  // Check once after sign-in, on native builds only.
  useEffect(() => {
    if (status === 'signedIn' && !platform.hostedOrigin && platform.kind !== 'web') autoCheck()
  }, [status, autoCheck])

  if (platform.hostedOrigin || platform.kind === 'web') return null
  if (!available || !latest || !downloadUrl) return null
  if (dismissed === latest.version && revealed !== latest.version) return null

  const dismiss = (): void => {
    try {
      writeJson(DISMISS_KEY, latest.version)
    } catch {
      /* ignore */
    }
    setDismissed(latest.version)
    useUpdateReveal.getState().reveal(null)
  }

  return (
    <div className="update-banner shrink-0 px-3 pb-2 pt-2" role="status" data-testid="update-banner">
      <BannerFlag />
      <div className="update-pill flex min-h-12 items-center gap-2 rounded-full border border-line bg-ink-900/90 py-1.5 pl-4 pr-1.5 text-sm shadow-lg">
        <p className="min-w-0 flex-1 text-[13px] leading-tight">
          <span className="font-semibold">{t('update.banner', { version: latest.version })}</span>
        </p>
        <button
          type="button"
          onClick={() => void platform.openExternal(downloadUrl)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-accent px-3.5 py-2 font-semibold text-ink-950 hover:opacity-90"
        >
          <Download className="h-4 w-4" /> {t('update.install')}
        </button>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t('update.dismiss')}
          title={t('update.later')}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-fg-muted hover:text-fg"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

/** Marks <html> while the banner is mounted so the shell header stops re-applying the status-bar inset. */
function BannerFlag(): null {
  useEffect(() => {
    const el = document.documentElement
    el.setAttribute('data-update-banner', '')
    return () => el.removeAttribute('data-update-banner')
  }, [])
  return null
}
