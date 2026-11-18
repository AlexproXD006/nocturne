import { useEffect, useId, useState, type ReactNode } from 'react'
import { Check, Download, LogOut, RotateCw, ShieldAlert, ShieldCheck, Smartphone } from 'lucide-react'
import { platform, useSession } from '../services'
import { isAdmin } from '../store/session'
import { useNav } from '../store/nav'
import { ACCENTS, THEMES, accentRgb, useSettings, type AccentId, type AccentPresetId, type MotionPref, type ThemeId, type VisualizerStyle } from '../store/settings'
import { useUpdates } from '../store/updates'
import { ExternalLink, cx } from '../components/common'
import { Logo } from '../components/Shell'
import { LanguageSelect } from '../components/LanguageSelect'
import { Page } from './Page'
import { SpotifySettings, useSpotifyImportEnabled } from '../components/Spotify'
import { isPrerelease } from '../lib/version'
import { Row, Segmented, Toggle } from './SettingsControls'
import { AdaptiveSettingsPanel } from './AdaptiveSettings'
import { useT, type MessageKey } from '../i18n'

function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <section className="g-card mb-6 rounded-2xl bg-white/[0.035] p-5 fade-up">
      <h2 className="mb-4 text-lg font-bold tracking-tight">{title}</h2>
      <div className="space-y-5">{children}</div>
    </section>
  )
}

const VISUALIZERS: { id: VisualizerStyle; label: MessageKey }[] = [
  { id: 'aurora', label: 'set.vis.aurora' },
  { id: 'spectrum', label: 'set.vis.spectrum' },
  { id: 'minimal', label: 'set.vis.minimal' }
]

const MOTION: { id: MotionPref; label: MessageKey }[] = [
  { id: 'system', label: 'set.motion.system' },
  { id: 'reduced', label: 'set.motion.reduced' },
  { id: 'full', label: 'set.motion.full' }
]

// Preview-only swatch colours (background = ink-950, bars = fg) per theme,
// mirroring the override blocks in styles.css. The accent dot uses the live
// accent, so it is not duplicated here.
const THEME_PREVIEW: Record<ThemeId, { bg: string; fg: string }> = {
  glass: {
    bg: 'radial-gradient(90% 90% at 15% 0%, rgb(143 180 255 / 0.55) 0%, transparent 60%), radial-gradient(80% 80% at 100% 100%, rgb(86 70 200 / 0.5) 0%, transparent 60%), #070a12',
    fg: '#eef2fa'
  },
  dark: { bg: '#08080b', fg: '#f3f3f6' },
  adaptive: {
    bg: 'radial-gradient(120% 90% at 20% 10%, #ff7a5c 0%, transparent 55%), radial-gradient(100% 80% at 100% 100%, #7b5cff 0%, transparent 60%), #07070a',
    fg: '#f3f3f6'
  },
  oled: { bg: '#000000', fg: '#f3f3f6' },
  dim: { bg: '#15202b', fg: '#f0f3f5' },
  midnight: { bg: '#0a0e1a', fg: '#eef1f8' },
  dracula: { bg: '#282a36', fg: '#f8f8f2' },
  nord: { bg: '#2e3440', fg: '#eceff4' },
  tokyonight: { bg: '#1a1b26', fg: '#c0caf5' },
  catppuccin: { bg: '#1e1e2e', fg: '#cdd6f4' },
  rosepine: { bg: '#191724', fg: '#e0def4' },
  gruvbox: { bg: '#1d2021', fg: '#ebdbb2' }
}

function ThemePicker({ value, accentRgb, onChange }: { value: ThemeId; accentRgb: string; onChange: (id: ThemeId) => void }): ReactNode {
  const tr = useT()
  return (
    <div role="radiogroup" aria-label={tr('set.theme')} className="grid grid-cols-[repeat(auto-fill,minmax(5rem,1fr))] gap-3 sm:w-[22rem]">
      {THEMES.map((t) => {
        const preview = THEME_PREVIEW[t.id]
        const selected = value === t.id
        return (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={tr(t.labelKey)} title={tr(t.labelKey)}
            onClick={() => onChange(t.id)}
            className={cx(
              'group flex flex-col items-center gap-1.5 rounded-xl p-1.5 transition-colors',
              selected ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]'
            )}
          >
            <span
              aria-hidden
              className={cx(
                'relative flex h-12 w-full flex-col justify-end gap-1 overflow-hidden rounded-lg p-2 ring-1 ring-inset ring-white/10 transition-shadow',
                selected && 'ring-2 ring-accent'
              )}
              style={{ background: preview.bg }}
            >
              <span className="h-1.5 w-8 rounded-full" style={{ background: preview.fg }} />
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-5 rounded-full opacity-60" style={{ background: preview.fg }} />
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: `rgb(${accentRgb})` }} />
              </span>
              {selected && (
                <span className="absolute top-1 right-1 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-ink-950">
                  <Check className="h-3 w-3" strokeWidth={3} />
                </span>
              )}
            </span>
            <span className={cx('text-[12px] font-medium', selected ? 'text-fg' : 'text-fg-muted')}>{tr(t.labelKey)}</span>
          </button>
        )
      })}
    </div>
  )
}

function AccentPicker({ value, onChange }: { value: AccentId; onChange: (id: AccentId) => void }): ReactNode {
  const tr = useT()
  return (
    <div role="radiogroup" aria-label={tr('set.accent')} className="flex flex-wrap items-center gap-2.5">
      <button
        type="button"
        role="radio"
        aria-checked={value === 'adaptive'}
        aria-label={tr('set.accentAdaptiveLabel')} title={tr('set.accentAdaptiveTitle')}
        onClick={() => onChange('adaptive')}
        className={cx(
          'flex h-8 items-center gap-2 rounded-full bg-white/[0.06] pl-1 pr-3 text-[13px] font-semibold ring-offset-2 ring-offset-ink-900 transition-shadow',
          value === 'adaptive' ? 'ring-2 ring-accent' : 'ring-1 ring-inset ring-white/15 hover:ring-white/30'
        )}
      >
        <span
          aria-hidden
          className="flex h-6 w-6 items-center justify-center rounded-full"
          style={{ background: 'conic-gradient(from 0deg, #ff7a5c, #fabd2f, #4ade80, #7aa2f7, #bd93f9, #ff79c6, #ff7a5c)' }}
        >
          {value === 'adaptive' && <Check className="h-3.5 w-3.5 text-ink-950" strokeWidth={3} />}
        </span>
        {tr('accent.adaptive')}
      </button>
      {(Object.keys(ACCENTS) as AccentPresetId[]).map((id) => {
        const { labelKey, rgb } = ACCENTS[id]
        const label = tr(labelKey)
        const selected = value === id
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={label}
            title={label}
            onClick={() => onChange(id)}
            className={cx(
              'flex h-8 w-8 items-center justify-center rounded-full ring-offset-2 ring-offset-ink-900 transition-shadow',
              selected ? 'ring-2 ring-accent' : 'ring-1 ring-inset ring-white/15 hover:ring-white/30'
            )}
            style={{ background: `rgb(${rgb})` }}
          >
            {selected && <Check className="h-4 w-4 text-ink-950" strokeWidth={3} />}
          </button>
        )
      })}
    </div>
  )
}

const SHORTCUTS: [MessageKey | string, MessageKey][] = [
  ['sc.space', 'sc.playPause'],
  ['← / →', 'sc.seek'],
  ['Shift + ← / →', 'sc.prevNext'],
  ['↑ / ↓', 'sc.volume'],
  ['M', 'sc.mute'],
  ['L', 'sc.lyrics'],
  ['Q', 'sc.queue'],
  ['F', 'sc.fullscreen'],
  ['S', 'sc.shuffle'],
  ['R', 'sc.repeat'],
  ['sc.searchKeys', 'sc.search'],
  ['Esc', 'sc.esc']
]

function Kbd({ children }: { children: string }): ReactNode {
  return <kbd className="rounded-md border border-line bg-white/[0.06] px-2 py-0.5 font-mono text-xs text-fg">{children}</kbd>
}

function SecurityStatus(): ReactNode {
  const tr = useT()
  const [state, setState] = useState<'checking' | 'secure' | 'weak'>('checking')
  useEffect(() => {
    let alive = true
    platform
      .secureAtRest()
      .then((ok) => alive && setState(ok ? 'secure' : 'weak'))
      .catch(() => alive && setState('weak'))
    return () => {
      alive = false
    }
  }, [])
  if (state === 'checking') return <p className="text-sm text-fg-muted">{tr('set.checkingStorage')}</p>
  const secure = state === 'secure'
  const Icon = secure ? ShieldCheck : ShieldAlert
  return (
    <div className={cx('flex items-start gap-3 rounded-xl p-3.5 text-sm', secure ? 'bg-white/[0.04]' : 'bg-[#3a2a1d] text-[#ffe2c2]')}>
      <Icon className={cx('mt-0.5 h-5 w-5 shrink-0', secure ? 'text-accent' : 'text-[#ffb870]')} />
      <p>
        {secure
          ? tr('set.secure') : tr('set.weak')}
      </p>
    </div>
  )
}

function UpdatesSection(): ReactNode {
  const tr = useT()
  const available = useUpdates((s) => s.available)
  const latest = useUpdates((s) => s.latest)
  const downloadUrl = useUpdates((s) => s.downloadUrl)
  const checking = useUpdates((s) => s.checking)
  const checked = useUpdates((s) => s.checked)
  const check = useUpdates((s) => s.check)

  return (
    <Section title={tr('set.updates')}>
      <Row
        label={tr('set.appVersion')}
        hint={
          isPrerelease(__APP_VERSION__)
            ? tr('set.runningBeta', { version: __APP_VERSION__ })
            : tr('set.running', { version: __APP_VERSION__ })
        }
      >
        {available && downloadUrl ? (
          <button
            type="button"
            onClick={() => void platform.openExternal(downloadUrl)}
            className="inline-flex items-center gap-2 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-ink-950 hover:opacity-90"
          >
            <Download className="h-4 w-4" /> {tr('set.updateNow')}
          </button>
        ) : (
          <button
            type="button"
            disabled={checking}
            onClick={() => void check()}
            className="inline-flex items-center gap-2 rounded-full bg-white/[0.08] px-4 py-2 text-sm font-semibold hover:bg-white/[0.14] disabled:opacity-50"
          >
            <RotateCw className={cx('h-4 w-4', checking && 'animate-spin')} /> {checking ? tr('set.checking') : tr('set.checkUpdates')}
          </button>
        )}
      </Row>
      {checked && !checking && (
        <p className="text-sm text-fg-muted">
          {available && latest ? tr('set.updateAvailable', { version: latest.version }) : tr('set.upToDate')}
        </p>
      )}
    </Section>
  )
}

export function SettingsPage(): ReactNode {
  const tr = useT()
  const { crossfade, visualizer, motion, lyrics, theme, accent, update } = useSettings()
  const session = useSession((s) => s.session)
  const server = useSession((s) => s.server)
  const lastServerUrl = useSession((s) => s.lastServerUrl)
  const logout = useSession((s) => s.logout)
  const admin = useSession(isAdmin)
  const spotify = useSpotifyImportEnabled()
  const go = useNav((s) => s.go)
  const [signingOut, setSigningOut] = useState(false)
  const fadeId = useId()
  const langId = useId()
  const serverUrl = session?.serverUrl || lastServerUrl

  return (
    <Page>
      <h1 className="mb-6 text-3xl font-extrabold tracking-tight">{tr('set.title')}</h1>
      <div className="max-w-3xl">
        <Section title={tr('set.playback')}>
          <Row
            label={tr('set.crossfade')}
            htmlFor={fadeId}
            hint={crossfade === 0 ? tr('set.gapless') : tr('set.overlap', { count: crossfade })}
          >
            <div className="flex items-center gap-3">
              <input
                id={fadeId}
                type="range"
                className="range w-44 sm:w-52"
                min={0}
                max={12}
                step={1}
                value={crossfade}
                aria-valuetext={crossfade === 0 ? tr('set.gaplessShort') : tr('set.seconds', { count: crossfade })}
                style={{ ['--fill' as string]: `${(crossfade / 12) * 100}%` }}
                onChange={(e) => update({ crossfade: Number(e.currentTarget.value) })}
              />
              <span className="min-w-16 shrink-0 text-right text-sm whitespace-nowrap text-fg-muted tabular-nums">{crossfade === 0 ? tr('set.gaplessShort') : `${crossfade} s`}</span>
            </div>
          </Row>
        </Section>

        <Section title={tr('set.language')}>
          <Row label={tr('set.languageRow')} hint={tr('set.languageHint')} htmlFor={langId}>
            <LanguageSelect id={langId} className="min-h-10 rounded-full border border-line bg-ink-800 px-4 text-sm font-medium text-fg outline-none focus:border-accent/70" />
          </Row>
        </Section>

        <Section title={tr('set.visuals')}>
          <Row label={tr('set.theme')} hint={tr('set.themeHint')}>
            <ThemePicker
              value={theme}
              accentRgb={accentRgb(accent) ?? ACCENTS.coral.rgb}
              onChange={(id) => update({ theme: id })}
            />
          </Row>
          {theme === 'adaptive' ? (
            <>
              <Row
                label={tr('set.accent')} hint={tr('set.accentAdaptiveHint')}
              />
              <AdaptiveSettingsPanel />
            </>
          ) : (
            <Row label={tr('set.accent')} hint={tr('set.accentHint')}>
              <AccentPicker value={accent} onChange={(id) => update({ accent: id })} />
            </Row>
          )}
          <Row label={tr('set.visualizer')} hint={tr('set.visualizerHint')}>
            <Segmented label={tr('set.visualizer')} value={visualizer} options={VISUALIZERS.map((o) => ({ id: o.id, label: tr(o.label) }))} onChange={(v) => update({ visualizer: v })} />
          </Row>
          <Row label={tr('set.motion')} hint={tr('set.motionHint')}>
            <Segmented label={tr('set.motion')} value={motion} options={MOTION.map((o) => ({ id: o.id, label: tr(o.label) }))} onChange={(v) => update({ motion: v })} />
          </Row>
        </Section>

        <Section title={tr('set.lyrics')}>
          <Row label={tr('set.showLyrics')} hint={tr('set.showLyricsHint')}>
            <Toggle label={tr('set.showLyrics')} checked={lyrics} onChange={(v) => update({ lyrics: v })} />
          </Row>
        </Section>

        <Section title={tr('set.account')}>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
            <dt className="text-fg-muted">{tr('set.signedInAs')}</dt>
            <dd className="truncate font-medium">{session?.user.displayName || session?.user.username || '—'}</dd>
            <dt className="text-fg-muted">{tr('set.server')}</dt>
            <dd className="truncate font-medium">{serverUrl || '—'}</dd>
            {server && (
              <>
                <dt className="text-fg-muted">{tr('set.serverSoftware')}</dt>
                <dd className="truncate font-medium">
                  {server.name} <span className="text-fg-muted">v{server.version}</span>
                </dd>
              </>
            )}
          </dl>
          <button
            type="button"
            disabled={signingOut}
            onClick={() => {
              setSigningOut(true)
              void logout().finally(() => setSigningOut(false))
            }}
            className="inline-flex items-center gap-2 rounded-full bg-white/[0.08] px-4 py-2 text-sm font-semibold hover:bg-white/[0.14] disabled:opacity-50"
          >
            <LogOut className="h-4 w-4" /> {tr('set.signOut')}
          </button>
        </Section>

        {spotify && (
          <Section title="Spotify">
            <SpotifySettings />
          </Section>
        )}

        {platform.hostedOrigin && (
          <Section title={tr('set.apps')}> <Row label={tr('set.appsRow')} hint={tr('set.appsHint')}>
              <a
                href="/descargar"
                className="inline-flex items-center gap-2 rounded-full bg-white/[0.08] px-4 py-2 text-sm font-semibold hover:bg-white/[0.14]"
              >
                <Smartphone className="h-4 w-4" /> {tr('set.getApps')}
              </a>
            </Row>
          </Section>
        )}

        {admin && (
          <Section title={tr('set.admin')}> <Row label={tr('set.adminRow')} hint={tr('set.adminHint')}>
              <button
                type="button"
                onClick={() => go({ name: 'admin' })}
                className="inline-flex items-center gap-2 rounded-full bg-white/[0.08] px-4 py-2 text-sm font-semibold hover:bg-white/[0.14]"
              >
                <ShieldCheck className="h-4 w-4" /> {tr('set.openAdmin')}
              </button>
            </Row>
          </Section>
        )}

        <Section title={tr('set.security')}>
          <SecurityStatus />
        </Section>

        <Section title={tr('set.shortcuts')}>
          <dl className="grid grid-cols-1 gap-x-10 gap-y-2.5 sm:grid-cols-2">
            {SHORTCUTS.map(([keys, action]) => (
              <div key={keys} className="flex items-center justify-between gap-4 text-sm">
                <dt className="text-fg-muted">{tr(action)}</dt>
                <dd className="shrink-0">
                  <Kbd>{keys.startsWith('sc.') ? tr(keys as MessageKey) : keys}</Kbd>
                </dd>
              </div>
            ))}
          </dl>
        </Section>

        {!platform.hostedOrigin && <UpdatesSection />}

        <Section title={tr('set.about')}>
          <div className="flex items-center gap-4">
            <Logo className="h-12 w-12" />
            <div className="text-sm">
              <p className="font-semibold">Nocturne</p>
              <p className="flex items-center gap-2 text-fg-muted tabular-nums">
                {tr('set.version', { version: __APP_VERSION__ })}
                {isPrerelease(__APP_VERSION__) && (
                  <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-bold tracking-wider text-accent">{tr('set.beta')}</span>
                )}
              </p>
            </div>
          </div>
          <p className="text-sm text-fg-muted">
            {tr('set.lyricsBy', { source: '\u0000' }).split('\u0000').flatMap((part, i) => (i === 0 ? [part] : [<ExternalLink key="l" href="https://lrclib.net">LRCLIB</ExternalLink>, part]))}
          </p>
        </Section>
      </div>
    </Page>
  )
}
