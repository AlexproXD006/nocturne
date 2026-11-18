import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ListMusic, Mic2, Sparkles, Waves, CircleDot, SlidersHorizontal } from 'lucide-react'
import { platform } from '../services'
import { useIsRemote, useNowContext, useNowStatus, useNowTrack } from '../hooks/useNowPlaying'
import { DevicesButton, ListeningBar, useDevicesUi } from './Devices'
import { useUi } from '../store/ui'
import { prefersReducedMotion, useSettings, type VisualizerStyle } from '../store/settings'
import { usePalette } from '../hooks/useAccent'
import { pickImage } from '../lib/url'
import { FALLBACK_ACCENT, paletteAccent, rgbString } from '../lib/color'
import { showFullscreenBackdrop } from '../lib/adaptive'
import { AdaptiveBackdrop } from './AdaptiveBackdrop'
import { useNav } from '../store/nav'
import { Artwork, IconButton, LikeButton, cx } from './common'
import { SeekBar, TransportControls, VolumeControl } from './controls'
import { LyricsView } from './LyricsView'
import { QueuePanel } from './QueuePanel'
import { Visualizer } from './Visualizer'
import { AddToPlaylistButton } from './Playlists'
import { SleepTimerButton } from './SleepTimer'
import { useT, type MessageKey } from '../i18n'

const STYLES: { id: VisualizerStyle; label: MessageKey; icon: ReactNode }[] = [
  { id: 'aurora', label: 'vis.aurora', icon: <Sparkles className="h-4 w-4" /> },
  { id: 'spectrum', label: 'vis.spectrum', icon: <Waves className="h-4 w-4" /> },
  { id: 'minimal', label: 'vis.minimal', icon: <CircleDot className="h-4 w-4" /> }
]

type MobileTab = 'player' | 'lyrics' | 'queue'

export function FullscreenPlayer(): ReactNode {
  const tr = useT()
  const track = useNowTrack()
  const remote = useIsRemote()
  const setFullscreen = useUi((s) => s.setFullscreen)
  const visualizer = useSettings((s) => s.visualizer)
  const motion = useSettings((s) => s.motion)
  const lyricsOn = useSettings((s) => s.lyrics)
  const update = useSettings((s) => s.update)
  const status = useNowStatus()
  const contextName = useNowContext()?.name
  const go = useNav((s) => s.go)
  const theme = useSettings((s) => s.theme)
  const accentSource = useSettings((s) => s.adaptive.accentSource)
  const adaptive = showFullscreenBackdrop(theme)
  // Always the artwork colour here; the Adaptive theme's accent source picks which one.
  const accent = paletteAccent(usePalette(pickImage(track?.artwork, 120)), adaptive ? accentSource : 'dominant') ?? FALLBACK_ACCENT
  const reduced = prefersReducedMotion(motion)
  const [idle, setIdle] = useState(false)
  const [tab, setTab] = useState<MobileTab>('player')
  const [sidePane, setSidePane] = useState<'lyrics' | 'queue'>(lyricsOn ? 'lyrics' : 'queue')
  const coverRef = useRef<HTMLDivElement>(null)
  const idleTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    void platform.window?.setFullscreen(true)
    return () => void platform.window?.setFullscreen(false)
  }, [])

  useEffect(() => {
    if (!track) setFullscreen(false)
  }, [track, setFullscreen])

  const wake = (): void => {
    setIdle(false)
    clearTimeout(idleTimer.current)
    idleTimer.current = setTimeout(() => setIdle(true), 3500)
  }
  useEffect(() => {
    wake()
    return () => clearTimeout(idleTimer.current)
  }, [])

  if (!track) return null
  const artist = track.artists[0]

  const close = (): void => setFullscreen(false)

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={tr('fs.nowPlaying')}
      onPointerMove={wake}
      onPointerDown={wake}
      className={cx('fs-open fixed inset-0 z-50 flex flex-col overflow-hidden bg-ink-950 text-fg fade-up', idle && 'cursor-none')}
      style={{ ['--accent-rgb' as string]: `${accent.r} ${accent.g} ${accent.b}` }}
    >
      {/* Backdrop: blurred cover + reactive visuals */}
      <div className="absolute inset-0">
        {adaptive ? (
          <AdaptiveBackdrop variant="embedded" />
        ) : (
          <>
            <Artwork images={track.artwork} size={160} className="absolute inset-0 h-full w-full scale-125 opacity-30 blur-3xl" rounded="" />
            <div className="absolute inset-0" style={{ background: `radial-gradient(ellipse at 30% 20%, ${rgbString(accent, 0.18)}, transparent 60%)` }} />
          </>
        )}
        <Visualizer accent={accent} style={visualizer} reduced={reduced} anchor={coverRef} />
        <div className="absolute inset-0 bg-gradient-to-b from-black/30 via-black/10 to-black/60" />
      </div>

      {/* Top bar */}
      <header
        className={cx(
          'safe-top fs-safe drag relative z-10 flex items-center justify-between px-4 py-3 transition-opacity duration-500 md:px-8',
          idle && 'opacity-0'
        )}
      >
        <IconButton label={tr('fs.close')} onClick={close}>
          <ChevronDown className="h-6 w-6" />
        </IconButton>
        <p className="truncate px-4 text-center text-xs font-semibold tracking-widest text-fg/70 uppercase">
          {contextName ?? tr('fs.nowPlaying')}
        </p>
        <div className="no-drag flex items-center gap-1">
          <IconButton
            label={tr('eq.open')}
            size="sm"
            onClick={() => {
              close()
              go({ name: 'equalizer' })
            }}
          >
            <SlidersHorizontal className="h-4 w-4" />
          </IconButton>
          <SleepTimerButton />
          <DevicesButton onClick={() => useDevicesUi.getState().show('sheet')} />
          {STYLES.map((s) => (
            <IconButton key={s.id} label={tr('fs.visualizer', { name: tr(s.label) })} active={visualizer === s.id} onClick={() => update({ visualizer: s.id })} size="sm">
              {s.icon}
            </IconButton>
          ))}
        </div>
      </header>

      {/* Mobile tabs */}
      <nav className="g-seg relative z-10 mx-auto mb-2 flex gap-1 rounded-full bg-white/8 p-1 lg:hidden" aria-label={tr('fs.views')}>
        {(['player', 'lyrics', 'queue'] as MobileTab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cx('rounded-full px-4 py-1.5 text-sm font-medium capitalize transition', tab === t ? 'bg-white/15 text-fg' : 'text-fg-muted')}
          >
            {t === 'player' ? tr('fs.song') : tr(t === 'lyrics' ? 'app.lyrics' : 'app.queue')}
          </button>
        ))}
      </nav>

      <main className="relative z-10 flex min-h-0 flex-1 gap-10 px-4 pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-6 md:px-12 lg:px-16">
        {/* Player column */}
        <section className={cx('flex min-h-0 flex-col items-center justify-center lg:flex lg:w-[min(46%,560px)] lg:shrink-0', tab === 'player' ? 'flex w-full' : 'hidden')}>
          <div
            ref={coverRef}
            className={cx(
              'aspect-square w-full max-w-[min(72vw,460px)] transition-transform duration-700 ease-[var(--ease-out-soft)] lg:max-w-[min(38vw,520px)]',
              status === 'playing' ? 'scale-100' : 'scale-[0.94]'
            )}
          >
            <Artwork images={track.artwork} size={640} eager alt={`${track.title} cover`} className="h-full w-full shadow-[0_30px_90px_-20px_rgba(0,0,0,0.75)]" rounded="rounded-2xl" />
          </div>
          <div className="mt-8 flex w-full max-w-[520px] items-center justify-between gap-4">
            <div className="min-w-0">
              <h1 className="truncate text-2xl font-bold tracking-tight md:text-3xl">{track.title}</h1>
              {artist && (
                <button
                  onClick={() => {
                    close()
                    go({ name: 'artist', id: artist.id })
                  }}
                  className="mt-1 truncate text-base text-fg/70 hover:text-fg hover:underline md:text-lg"
                >
                  {track.artists.map((a) => a.name).join(', ')}
                </button>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <AddToPlaylistButton tracks={[track]} size="lg" />
              <LikeButton trackId={track.id} serverValue={track.liked} size="md" />
            </div>
          </div>
          <div className={cx('g-ctl mt-5 w-full max-w-[520px] transition-opacity duration-500', idle && 'lg:opacity-60')}>
            <SeekBar />
            <div className="mt-3 flex justify-center">
              <TransportControls size="lg" />
            </div>
            {/* Phones only get a slider while controlling another device (hardware keys set the local volume). */}
            <div className={cx('mt-4 justify-center', remote ? 'flex' : 'hidden md:flex')}>
              <VolumeControl width={remote ? 'w-40' : 'w-24'} />
            </div>
            {remote && <ListeningBar className="mx-auto mt-4 h-8 max-w-xs" rounded="rounded-full" />}
          </div>
        </section>

        {/* Lyrics / queue column (desktop) and mobile tabs */}
        {/* min-w-0: as a flex item this column would otherwise grow to its content's max-content
            width (long queue titles), pushing the queue off-screen instead of truncating it. */}
        <section className={cx('min-h-0 min-w-0 flex-1 flex-col lg:flex', tab === 'player' ? 'hidden' : 'flex')}>
          <div className={cx('mb-2 hidden gap-1 self-end transition-opacity duration-500 lg:flex', idle && 'opacity-0')}>
            <IconButton label={tr('app.lyrics')} active={sidePane === 'lyrics'} onClick={() => setSidePane('lyrics')} size="sm">
              <Mic2 className="h-4 w-4" />
            </IconButton>
            <IconButton label={tr('app.queue')} active={sidePane === 'queue'} onClick={() => setSidePane('queue')} size="sm">
              <ListMusic className="h-4 w-4" />
            </IconButton>
          </div>
          <div className="min-h-0 min-w-0 flex-1">
            {(tab === 'lyrics' || (tab === 'player' && sidePane === 'lyrics')) && <LyricsView track={track} size="lg" />}
            {(tab === 'queue' || (tab === 'player' && sidePane === 'queue')) && (
              <div className="g-fs-panel h-full rounded-2xl bg-black/20 pt-2 backdrop-blur-md">
                <QueuePanel />
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  )
}
