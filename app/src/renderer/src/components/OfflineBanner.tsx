import { WifiOff } from 'lucide-react'
import type { ReactNode } from 'react'
import { useT } from '../i18n'
import { useConnectivity } from '../services'

/** "Sin conexión · Mostrando lo disponible": shown while the app cannot reach the server. */
export function OfflineBanner(): ReactNode {
  const t = useT()
  const online = useConnectivity((s) => s.online)
  if (online) return null
  return (
    <div className="offline-banner relative z-20 shrink-0 px-3 pt-2 pb-1" role="status" data-testid="offline-banner">
      <div className="flex min-h-10 items-center gap-2 rounded-full border border-line bg-ink-900/90 py-1 pr-1.5 pl-4 text-[13px] shadow-lg backdrop-blur-xl">
        <WifiOff className="h-4 w-4 shrink-0 text-accent" aria-hidden />
        <p className="min-w-0 flex-1 truncate font-medium">{t('offline.banner')}</p>
        <button
          type="button"
          onClick={() => void useConnectivity.getState().probe()}
          className="shrink-0 rounded-full bg-white/[0.08] px-3 py-1.5 text-xs font-semibold hover:bg-white/[0.14]"
        >
          {t('offline.retry')}
        </button>
      </div>
    </div>
  )
}
