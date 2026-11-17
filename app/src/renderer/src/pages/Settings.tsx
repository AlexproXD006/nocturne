import { useEffect, useId, useState, type ReactNode } from 'react'
import { Check, Download, LogOut, RotateCw, ShieldAlert, ShieldCheck, Smartphone } from 'lucide-react'
import { platform, useSession } from '../services'
import { isAdmin } from '../store/session'
import { useNav } from '../store/nav'
import { ACCENTS, THEMES, accentRgb, useSettings, type AccentId, type AccentPresetId, type MotionPref, type ThemeId, type VisualizerStyle } from '../store/settings'
import { useUpdates } from '../store/updates'
import { ExternalLink, cx } from '../components/common'
import { Logo } from '../components/Shell'
import { Page } from './Page'
import { SpotifySettings, useSpotifyImportEnabled } from '../components/Spotify'
import { isPrerelease } from '../lib/version'

function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <section className="mb-6 rounded-2xl bg-white/[0.035] p-5 fade-up">
      <h2 className="mb-4 text-lg font-bold tracking-tight">{title}</h2>
      <div className="space-y-5">{children}</div>
    </section>
  )
}

function Row({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children?: ReactNode; htmlFor?: string }): ReactNode {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="block text-[15px] font-medium">
          {label}
        </label>
        {hint && <div className="mt-0.5 text-[13px] text-fg-muted">{hint}</div>}
      </div>
      {children && <div className="shrink-0">{children}</div>}
    </div>
  )
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx('relative h-7 w-12 rounded-full transition-colors duration-200', checked ? 'bg-accent' : 'bg-white/15')}
    >
      <span
        aria-hidden
        className={cx(
          'absolute top-1 left-1 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ease-[var(--ease-out-soft)]',
          checked && 'translate-x-5'
        )}
      />
    </button>
  )
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label
}: {
  value: T
  options: { id: T; label: string }[]
  onChange: (v: T) => void
  label: string
}): ReactNode {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-full bg-white/[0.07] p-1">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={cx(
            'rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors',
            value === o.id ? 'bg-fg text-ink-950' : 'text-fg-muted hover:text-fg'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

const VISUALIZERS: { id: VisualizerStyle; label: string }[] = [
  { id: 'aurora', label: 'Aurora' },
  { id: 'spectrum', label: 'Spectrum' },
  { id: 'minimal', label: 'Minimal' }
]

const MOTION: { id: MotionPref; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'reduced', label: 'Reduced' },
  { id: 'full', label: 'Full' }
]

// Preview-only swatch colours (background = ink-950, bars = fg) per theme,
// mirroring the override blocks in styles.css. The accent dot uses the live
// accent, so it is not duplicated here.
const THEME_PREVIEW: Record<ThemeId, { bg: string; fg: string }> = {
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
  return (
    <div role="radiogroup" aria-label="Theme" className="grid grid-cols-[repeat(auto-fill,minmax(5rem,1fr))] gap-3 sm:w-[22rem]">
      {THEMES.map((t) => {
        const preview = THEME_PREVIEW[t.id]
        const selected = value === t.id
        return (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={t.label}
            title={t.label}
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
            <span className={cx('text-[12px] font-medium', selected ? 'text-fg' : 'text-fg-muted')}>{t.label}</span>
          </button>
        )
      })}
    </div>
  )
}

function AccentPicker({ value, onChange }: { value: AccentId; onChange: (id: AccentId) => void }): ReactNode {
  return (
    <div role="radiogroup" aria-label="Accent" className="flex flex-wrap items-center gap-2.5">
      <button
        type="button"
        role="radio"
        aria-checked={value === 'adaptive'}
        aria-label="Adaptive: follows the dominant color of the current cover"
        title="Adaptive — follows the current cover"
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
        Adaptive
      </button>
      {(Object.keys(ACCENTS) as AccentPresetId[]).map((id) => {
        const { label, rgb } = ACCENTS[id]
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

const SHORTCUTS: [string, string][] = [
  ['Space', 'Play / pause'],
  ['← / →', 'Seek 5 seconds'],
  ['Shift + ← / →', 'Previous / next track'],
  ['↑ / ↓', 'Volume up / down'],
  ['M', 'Mute'],
  ['L', 'Toggle lyrics'],
  ['Q', 'Toggle queue'],
  ['F', 'Fullscreen player'],
  ['S', 'Shuffle'],
  ['R', 'Cycle repeat'],
  ['Ctrl + K  or  /', 'Search'],
  ['Esc', 'Exit fullscreen']
]

function Kbd({ children }: { children: string }): ReactNode {
  return <kbd className="rounded-md border border-line bg-white/[0.06] px-2 py-0.5 font-mono text-xs text-fg">{children}</kbd>
}

function SecurityStatus(): ReactNode {
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
  if (state === 'checking') return <p className="text-sm text-fg-muted">Checking secure storage…</p>
  const secure = state === 'secure'
  const Icon = secure ? ShieldCheck : ShieldAlert
  return (
    <div className={cx('flex items-start gap-3 rounded-xl p-3.5 text-sm', secure ? 'bg-white/[0.04]' : 'bg-[#3a2a1d] text-[#ffe2c2]')}>
      <Icon className={cx('mt-0.5 h-5 w-5 shrink-0', secure ? 'text-accent' : 'text-[#ffb870]')} />
      <p>
        {secure
          ? 'Session encrypted with your OS keychain.'
          : 'Secure storage is unavailable on this device. Your session is only kept for this browser session or stored without OS encryption.'}
      </p>
    </div>
  )
}

function UpdatesSection(): ReactNode {
  const available = useUpdates((s) => s.available)
  const latest = useUpdates((s) => s.latest)
  const downloadUrl = useUpdates((s) => s.downloadUrl)
  const checking = useUpdates((s) => s.checking)
  const checked = useUpdates((s) => s.checked)
  const check = useUpdates((s) => s.check)

  return (
    <Section title="Updates">
      <Row
        label="App version"
        hint={
          isPrerelease(__APP_VERSION__)
            ? `You're running Nocturne ${__APP_VERSION__} (beta channel): you'll get new betas and the next stable release.`
            : `You're running Nocturne ${__APP_VERSION__}.`
        }
      >
        {available && downloadUrl ? (
          <button
            type="button"
            onClick={() => void platform.openExternal(downloadUrl)}
            className="inline-flex items-center gap-2 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-ink-950 hover:opacity-90"
          >
            <Download className="h-4 w-4" /> Update now
          </button>
        ) : (
          <button
            type="button"
            disabled={checking}
            onClick={() => void check()}
            className="inline-flex items-center gap-2 rounded-full bg-white/[0.08] px-4 py-2 text-sm font-semibold hover:bg-white/[0.14] disabled:opacity-50"
          >
            <RotateCw className={cx('h-4 w-4', checking && 'animate-spin')} /> {checking ? 'Checking…' : 'Check for updates'}
          </button>
        )}
      </Row>
      {checked && !checking && (
        <p className="text-sm text-fg-muted">
          {available && latest ? `Nocturne ${latest.version} is available → Update now.` : "You're up to date."}
        </p>
      )}
    </Section>
  )
}

export function SettingsPage(): ReactNode {
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
  const serverUrl = session?.serverUrl || lastServerUrl

  return (
    <Page>
      <h1 className="mb-6 text-3xl font-extrabold tracking-tight">Settings</h1>
      <div className="max-w-3xl">
        <Section title="Playback">
          <Row
            label="Crossfade"
            htmlFor={fadeId}
            hint={crossfade === 0 ? 'Gapless: tracks play back-to-back with no overlap.' : `Tracks overlap by ${crossfade} seconds.`}
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
                aria-valuetext={crossfade === 0 ? 'Gapless' : `${crossfade} seconds`}
                style={{ ['--fill' as string]: `${(crossfade / 12) * 100}%` }}
                onChange={(e) => update({ crossfade: Number(e.currentTarget.value) })}
              />
              <span className="w-16 text-right text-sm text-fg-muted tabular-nums">{crossfade === 0 ? 'Gapless' : `${crossfade}s`}</span>
            </div>
          </Row>
        </Section>

        <Section title="Visuals">
          <Row label="Theme" hint="Recolours the whole interface.">
            <ThemePicker
              value={theme}
              accentRgb={accentRgb(accent) ?? ACCENTS.coral.rgb}
              onChange={(id) => update({ theme: id })}
            />
          </Row>
          {theme === 'adaptive' ? (
            <Row
              label="Accent"
              hint="Adaptive picks the dominant colour of the current cover and builds the background around it."
            />
          ) : (
            <Row label="Accent" hint="Highlight colour for controls and emphasis. Adaptive follows the current cover.">
              <AccentPicker value={accent} onChange={(id) => update({ accent: id })} />
            </Row>
          )}
          <Row label="Visualizer style" hint="Shown behind the artwork in the fullscreen player.">
            <Segmented label="Visualizer style" value={visualizer} options={VISUALIZERS} onChange={(v) => update({ visualizer: v })} />
          </Row>
          <Row label="Motion" hint="System follows your device's reduce-motion setting.">
            <Segmented label="Motion" value={motion} options={MOTION} onChange={(v) => update({ motion: v })} />
          </Row>
        </Section>

        <Section title="Lyrics">
          <Row label="Show lyrics" hint="Synced lyrics from LRCLIB">
            <Toggle label="Show lyrics" checked={lyrics} onChange={(v) => update({ lyrics: v })} />
          </Row>
        </Section>

        <Section title="Account">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
            <dt className="text-fg-muted">Signed in as</dt>
            <dd className="truncate font-medium">{session?.user.displayName || session?.user.username || '—'}</dd>
            <dt className="text-fg-muted">Server</dt>
            <dd className="truncate font-medium">{serverUrl || '—'}</dd>
            {server && (
              <>
                <dt className="text-fg-muted">Server software</dt>
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
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </Section>

        {spotify && (
          <Section title="Spotify">
            <SpotifySettings />
          </Section>
        )}

        {platform.hostedOrigin && (
          <Section title="Apps">
            <Row label="Android & Windows apps" hint="Install Nocturne on your phone or PC to control playback across your devices.">
              <a
                href="/descargar"
                className="inline-flex items-center gap-2 rounded-full bg-white/[0.08] px-4 py-2 text-sm font-semibold hover:bg-white/[0.14]"
              >
                <Smartphone className="h-4 w-4" /> Get the apps
              </a>
            </Row>
          </Section>
        )}

        {admin && (
          <Section title="Administration">
            <Row label="Admin dashboard" hint="Add music, manage users, jobs, library and backups.">
              <button
                type="button"
                onClick={() => go({ name: 'admin' })}
                className="inline-flex items-center gap-2 rounded-full bg-white/[0.08] px-4 py-2 text-sm font-semibold hover:bg-white/[0.14]"
              >
                <ShieldCheck className="h-4 w-4" /> Open Admin
              </button>
            </Row>
          </Section>
        )}

        <Section title="Security">
          <SecurityStatus />
        </Section>

        <Section title="Keyboard shortcuts">
          <dl className="grid grid-cols-1 gap-x-10 gap-y-2.5 sm:grid-cols-2">
            {SHORTCUTS.map(([keys, action]) => (
              <div key={keys} className="flex items-center justify-between gap-4 text-sm">
                <dt className="text-fg-muted">{action}</dt>
                <dd className="shrink-0">
                  <Kbd>{keys}</Kbd>
                </dd>
              </div>
            ))}
          </dl>
        </Section>

        {!platform.hostedOrigin && <UpdatesSection />}

        <Section title="About">
          <div className="flex items-center gap-4">
            <Logo className="h-12 w-12" />
            <div className="text-sm">
              <p className="font-semibold">Nocturne</p>
              <p className="flex items-center gap-2 text-fg-muted tabular-nums">
                Version {__APP_VERSION__}
                {isPrerelease(__APP_VERSION__) && (
                  <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-bold tracking-wider text-accent">BETA</span>
                )}
              </p>
            </div>
          </div>
          <p className="text-sm text-fg-muted">
            Lyrics are provided by <ExternalLink href="https://lrclib.net">LRCLIB</ExternalLink>, a free and open lyrics database.
          </p>
        </Section>
      </div>
    </Page>
  )
}
