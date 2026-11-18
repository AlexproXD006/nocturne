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
    <div className="flex items-center justify-between gap-3 border-b border-line bg-ink-900 px-4 py-2.5 text-sm">
      <p className="min-w-0 truncate">
        <span className="font-semibold">Nocturne {latest.version}</span>
        <span className="text-fg-muted"> {t('update.available')}</span>
      </p>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => void platform.openExternal(downloadUrl)}
          className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-1.5 font-semibold text-ink-950 hover:opacity-90"
        >
          <Download className="h-4 w-4" /> {t('update.now')}
        </button>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t('update.dismiss')}
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 font-medium text-fg-muted hover:text-fg"
        >
          <X className="h-4 w-4" /> {t('update.later')}
        </button>
      </div>
    </div>
  )
}
