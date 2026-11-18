import { useEffect, useRef, type ReactNode } from 'react'
import { ListMusic, Maximize2, Mic2, MonitorSpeaker, Pause, Play } from 'lucide-react'
import { playback, useConnect } from '../services'
import { useUi } from '../store/ui'
import { useHasNowPlaying, useIsRemote, useNowDuration, useNowStatus, useNowTrack } from '../hooks/useNowPlaying'
import { useNav } from '../store/nav'
import { readPosition, useFrame } from '../hooks/useClock'
import { Artwork, IconButton, LikeButton, cx } from './common'
import { SeekBar, TransportControls, VolumeControl } from './controls'
import { DevicesButton, ListeningBar, RemoteSuggestion, openDevices } from './Devices'
import { AddToPlaylistButton } from './Playlists'
import { SleepTimerButton } from './SleepTimer'
import { useT } from '../i18n'

function NowPlayingInfo(): ReactNode {
  const tr = useT()
  const t = useNowTrack()
  const go = useNav((s) => s.go)
  const setFullscreen = useUi((s) => s.setFullscreen)
  if (!t) return <div className="min-w-0 flex-1" />
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <button type="button" aria-label={tr('player.openNowPlaying')} onClick={() => setFullscreen(true)} className="group relative shrink-0">
        <Artwork images={t.artwork} size={56} className="h-14 w-14 shadow-md shadow-black/40" rounded="rounded-md" />
        <span className="absolute inset-0 hidden items-center justify-center rounded-md bg-black/50 group-hover:flex">
          <Maximize2 className="h-4 w-4" />
        </span>
      </button>
      <div className="min-w-0">
        <button
          type="button"
          onClick={() => t.album && go({ name: 'album', id: t.album.id })}
          className="block max-w-full truncate text-sm font-semibold hover:underline"
        >
          {t.title}
        </button>
        <p className="truncate text-xs text-fg-muted">
          {t.artists.map((a, i) => (
            <span key={a.id}>
              {i > 0 && ', '}
              <button type="button" onClick={() => go({ name: 'artist', id: a.id })} className="hover:text-fg hover:underline">
                {a.name}
              </button>
            </span>
          ))}
        </p>
      </div>
      <LikeButton trackId={t.id} serverValue={t.liked} />
      <AddToPlaylistButton tracks={[t]} size="sm" className="-ml-1" />
    </div>
  )
}

/** Desktop bottom bar. */
export function PlayerBar(): ReactNode {
  const tr = useT()
  const panel = useUi((s) => s.panel)
  const togglePanel = useUi((s) => s.togglePanel)
  const setFullscreen = useUi((s) => s.setFullscreen)
  const hasItem = useHasNowPlaying()

  return (
    <div className="app-chrome hidden shrink-0 flex-col md:flex">
    <footer className="g-chrome flex h-[84px] shrink-0 items-center gap-6 border-t border-line bg-ink-950 px-4" aria-label={tr('player.bar')}>
      <NowPlayingInfo />
      <div className="flex w-[min(42vw,640px)] flex-col items-center gap-1">
        <TransportControls />
        <SeekBar />
      </div>
      <div className="flex flex-1 items-center justify-end gap-1">
        <IconButton label={tr('player.lyricsHint')} active={panel === 'lyrics'} onClick={() => togglePanel('lyrics')} disabled={!hasItem}>
          <Mic2 className="h-4 w-4" />
        </IconButton>
        <IconButton label={tr('player.queueHint')} active={panel === 'queue'} onClick={() => togglePanel('queue')}>
          <ListMusic className="h-[18px] w-[18px]" />
        </IconButton>
        <SleepTimerButton />
        <DevicesButton />
        <VolumeControl className="ml-1 hidden lg:flex" />
        <IconButton label={tr('player.fullscreenHint')} onClick={() => setFullscreen(true)} disabled={!hasItem}>
          <Maximize2 className="h-4 w-4" />
        </IconButton>
      </div>
    </footer>
    <ListeningBar className="h-6 justify-end" />
    </div>
  )
}

/** Mobile mini player that sits above the tab bar. Tap to open fullscreen. */
export function MiniPlayer(): ReactNode {
  const tr = useT()
  const t = useNowTrack()
  const status = useNowStatus()
  const duration = useNowDuration()
  const remote = useIsRemote()
  const connectActive = useConnect((s) => s.active)
  const toggle = playback.toggle
  const setFullscreen = useUi((s) => s.setFullscreen)
  const barRef = useRef<HTMLDivElement>(null)
  const playing = status === 'playing' || status === 'buffering' || status === 'loading'

  const paint = (): void => {
    if (barRef.current) barRef.current.style.transform = `scaleX(${duration > 0 ? Math.min(1, readPosition() / duration) : 0})`
  }
  useFrame(paint, status === 'playing')
  useEffect(paint)

  if (!t) {
    // Controlling a device that has nothing loaded: still show where we are listening.
    if (remote) return <div className="px-2 md:hidden"><ListeningBar className="h-9 rounded-xl" /></div>
    return connectActive ? <div className="px-2 md:hidden"><RemoteSuggestion /></div> : null
  }
  return (
    <div className="px-2 md:hidden">
      <div className={cx('g-float overflow-hidden rounded-xl shadow-xl shadow-black/40', remote && 'ring-1 ring-accent/40')}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setFullscreen(true)}
        onKeyDown={(e) => e.key === 'Enter' && setFullscreen(true)}
        className={cx('relative flex items-center gap-3 overflow-hidden bg-ink-700/90 p-2 pr-3 backdrop-blur-xl', !remote && 'rounded-xl')}
      >
        <Artwork images={t.artwork} size={44} className="h-11 w-11 shrink-0" rounded="rounded-md" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{t.title}</p>
          <p className="truncate text-xs text-fg-muted">{t.artists.map((a) => a.name).join(', ')}</p>
        </div>
        {connectActive && (
          <button
            type="button"
            aria-label={tr('player.devices')}
            onClick={(e) => {
              e.stopPropagation()
              openDevices()
            }}
            className={cx('flex h-9 w-9 items-center justify-center rounded-full active:scale-90', remote ? 'text-accent' : 'text-fg-muted')}
          >
            <MonitorSpeaker className="h-5 w-5" />
          </button>
        )}
        <LikeButton trackId={t.id} serverValue={t.liked} />
        <button
          type="button"
          aria-label={playing ? tr('ctl.pause') : tr('ctl.play')}
          onClick={(e) => {
            e.stopPropagation()
            toggle()
          }}
          className="flex h-10 w-10 items-center justify-center rounded-full text-fg active:scale-90"
        >
          {playing ? <Pause className="h-6 w-6" fill="currentColor" /> : <Play className="h-6 w-6" fill="currentColor" />}
        </button>
        <div className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-white/15">
          <div ref={barRef} className="h-full origin-left rounded-full bg-fg" style={{ transform: 'scaleX(0)' }} />
        </div>
      </div>
      <ListeningBar className="h-7" />
      </div>
    </div>
  )
}
