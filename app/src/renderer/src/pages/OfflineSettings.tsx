import { type ReactNode } from 'react'
import { ArrowDownToLine, Trash2 } from 'lucide-react'
import { useT } from '../i18n'
import { useOffline, useSession } from '../services'
import { useNav } from '../store/nav'
import { useUi } from '../store/ui'
import { formatBytes } from '../hooks/useAvailability'
import { CACHE_GB_CHOICES, CACHE_TRACK_CHOICES } from '../lib/offline/policy'
import { LIMIT_GB_CHOICES } from '../store/offline'
import { Row, Segmented, Toggle } from './SettingsControls'

/** Settings → Offline & downloads (rendered inside the Settings page's Section card). */
export function OfflineSettingsRows(): ReactNode {
  const tr = useT()
  const s = useOffline((x) => x.settings)
  const usage = useOffline((x) => x.usage)
  const update = useOffline((x) => x.update)
  const go = useNav((x) => x.go)
  const transcode = useSession((x) => x.server?.capabilities?.transcode === true)
  const platformIos = typeof navigator !== 'undefined' && /iPhone|iPad|iPod/i.test(navigator.userAgent)

  return (
    <>
      <Row label={tr('set.cache')} hint={tr('set.cacheHint')}>
        <Segmented
          label={tr('set.cacheBy')}
          value={s.cache.mode}
          options={[
            { id: 'tracks', label: tr('set.cacheBySongs') },
            { id: 'bytes', label: tr('set.cacheBySize') }
          ]}
          onChange={(mode) => update({ cache: { ...s.cache, mode } })}
        />
      </Row>
      {s.cache.mode === 'tracks' ? (
        <Row label={tr('set.cacheBySongs')}>
          <Segmented
            label={tr('set.cacheBySongs')}
            value={String(s.cache.tracks)}
            options={CACHE_TRACK_CHOICES.map((n) => ({ id: String(n), label: String(n) }))}
            onChange={(v) => update({ cache: { ...s.cache, tracks: Number(v) } })}
          />
        </Row>
      ) : (
        <Row label={tr('set.cacheBySize')}>
          <Segmented
            label={tr('set.cacheBySize')}
            value={String(s.cache.gb)}
            options={CACHE_GB_CHOICES.map((n) => ({ id: String(n), label: tr('set.cacheSize', { gb: n }) }))}
            onChange={(v) => update({ cache: { ...s.cache, gb: Number(v) } })}
          />
        </Row>
      )}
      <Row label={tr('set.prefetchWifi')} hint={tr('set.prefetchWifiHint')}>
        <Toggle label={tr('set.prefetchWifi')} checked={s.prefetchWifiOnly} onChange={(v) => update({ prefetchWifiOnly: v })} />
      </Row>
      <Row
        label={tr('set.clearCache')}
        hint={
          <>
            {tr('set.clearCacheHint')} <span className="tabular-nums">{tr('set.cacheUsage', { count: usage.autoTracks, size: formatBytes(usage.autoBytes) })}</span>
          </>
        }
      >
        <button
          type="button"
          onClick={() => void useOffline.getState().clearCache().then(() => useUi.getState().toast(tr('set.cacheCleared')))}
          className="no-drag inline-flex h-10 items-center gap-2 rounded-full bg-white/[0.08] px-5 text-sm font-semibold transition hover:bg-white/[0.14]"
        >
          <Trash2 className="h-4 w-4" /> {tr('set.clearCache')}
        </button>
      </Row>
      <Row label={tr('set.downloadsWifi')} hint={tr('set.downloadsWifiHint')}>
        <Toggle label={tr('set.downloadsWifi')} checked={s.downloadsWifiOnly} onChange={(v) => update({ downloadsWifiOnly: v })} />
      </Row>
      <Row label={tr('set.quality')} hint={transcode ? undefined : tr('set.qualityOnlyOriginal')}>
        <Segmented
          label={tr('set.quality')}
          value={transcode ? s.quality : 'original'}
          options={[
            { id: 'original', label: tr('set.qualityOriginal') },
            ...(transcode ? [{ id: 'compressed' as const, label: tr('set.qualityCompressed') }] : [])
          ]}
          onChange={(quality) => update({ quality })}
        />
      </Row>
      <Row label={tr('set.dlLimit')}>
        <Segmented
          label={tr('set.dlLimit')}
          value={String(s.limitGb)}
          options={LIMIT_GB_CHOICES.map((n) => ({ id: String(n), label: n === 0 ? tr('set.limitNone') : tr('set.limitGb', { gb: n }) }))}
          onChange={(v) => update({ limitGb: Number(v) })}
        />
      </Row>
      <Row label={tr('set.manageDownloads')} hint={platformIos ? tr('set.offlineIos') : undefined}>
        <button
          type="button"
          onClick={() => go({ name: 'downloads' })}
          className="no-drag inline-flex h-10 items-center gap-2 rounded-full bg-white/[0.08] px-5 text-sm font-semibold transition hover:bg-white/[0.14]"
        >
          <ArrowDownToLine className="h-4 w-4" /> {tr('dl.nav')}
        </button>
      </Row>
    </>
  )
}
