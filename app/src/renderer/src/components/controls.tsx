import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume, Volume1, Volume2, VolumeX } from 'lucide-react'
import { playback } from '../services'
import { readPosition, useFrame } from '../hooks/useClock'
import { useHasNowPlaying, useNowDuration, useNowPositionTick, useNowRepeat, useNowShuffle, useNowStatus, useNowVolume } from '../hooks/useNowPlaying'
import { formatTime } from '../lib/format'
import { IconButton, cx } from './common'

/** Seek bar that animates smoothly from the engine clock; dragging previews without seeking. */
export function SeekBar({ compact = false, className }: { compact?: boolean; className?: string }): ReactNode {
  const duration = useNowDuration()
  const seek = playback.seek
  const playing = useNowStatus() === 'playing'
  const inputRef = useRef<HTMLInputElement>(null)
  const elapsedRef = useRef<HTMLSpanElement>(null)
  const [drag, setDrag] = useState<number | null>(null)
  const dragRef = useRef<number | null>(null)
  dragRef.current = drag

  const paint = (pos: number): void => {
    const el = inputRef.current
    if (!el) return
    const pct = duration > 0 ? Math.min(100, (pos / duration) * 100) : 0
    el.style.setProperty('--fill', `${pct}%`)
    if (dragRef.current === null) el.value = String(pos)
    if (elapsedRef.current) elapsedRef.current.textContent = formatTime(pos)
  }

  useFrame(() => paint(dragRef.current ?? readPosition()), playing || drag !== null)
  // Paint once when paused/duration changes.
  useNowPositionTick() // subscribe so we re-render on discrete seeks
  useEffect(() => {
    paint(dragRef.current ?? readPosition())
  })

  const commit = (): void => {
    if (dragRef.current !== null) seek(dragRef.current)
    setDrag(null)
  }

  return (
    <div className={cx('flex w-full items-center gap-2 text-[11px] text-fg-muted tabular-nums', className)}>
      {!compact && <span ref={elapsedRef} className="w-10 text-right">0:00</span>}
      <input
        ref={inputRef}
        type="range"
        className="range flex-1"
        aria-label="Seek"
        min={0}
        max={duration || 0}
        step={0.1}
        defaultValue={0}
        disabled={duration <= 0}
        onPointerDown={() => setDrag(Number(inputRef.current?.value ?? 0))}
        onChange={(e) => {
          const v = Number(e.currentTarget.value)
          if (dragRef.current !== null) setDrag(v)
          else seek(v) // keyboard
        }}
        onPointerUp={commit}
        onPointerCancel={() => setDrag(null)}
        onKeyUp={commit}
        aria-valuetext={`${formatTime(drag ?? readPosition())} of ${formatTime(duration)}`}
      />
      {!compact && <span className="w-10">{formatTime(duration)}</span>}
    </div>
  )
}

export function TransportControls({ size = 'md' }: { size?: 'md' | 'lg' }): ReactNode {
  const status = useNowStatus()
  const shuffle = useNowShuffle()
  const repeat = useNowRepeat()
  const hasQueue = useHasNowPlaying()
  const p = (): typeof playback => playback
  const playing = status === 'playing' || status === 'buffering' || status === 'loading'
  const big = size === 'lg'

  return (
    <div className={cx('flex items-center', big ? 'gap-5' : 'gap-2')}>
      <IconButton label={shuffle ? 'Disable shuffle' : 'Enable shuffle'} active={shuffle} onClick={() => p().setShuffle(!shuffle)} size={big ? 'lg' : 'md'}>
        <Shuffle className={big ? 'h-5 w-5' : 'h-4 w-4'} />
      </IconButton>
      <IconButton label="Previous" disabled={!hasQueue} onClick={() => void p().previous()} size={big ? 'lg' : 'md'}>
        <SkipBack className={big ? 'h-6 w-6' : 'h-[18px] w-[18px]'} fill="currentColor" />
      </IconButton>
      <button
        type="button"
        aria-label={playing ? 'Pause' : 'Play'}
        disabled={!hasQueue}
        onClick={() => p().toggle()}
        className={cx(
          'g-play no-drag flex items-center justify-center rounded-full bg-fg text-ink-950 transition hover:scale-[1.04] active:scale-95 disabled:opacity-40',
          big ? 'h-16 w-16' : 'h-9 w-9'
        )}
      >
        {status === 'loading' || status === 'buffering' ? (
          <span className={cx('animate-spin rounded-full border-2 border-ink-950/25 border-t-ink-950', big ? 'h-6 w-6' : 'h-4 w-4')} />
        ) : playing ? (
          <Pause className={big ? 'h-7 w-7' : 'h-4 w-4'} fill="currentColor" />
        ) : (
          <Play className={cx(big ? 'ml-1 h-7 w-7' : 'ml-0.5 h-4 w-4')} fill="currentColor" />
        )}
      </button>
      <IconButton label="Next" disabled={!hasQueue} onClick={() => void p().next()} size={big ? 'lg' : 'md'}>
        <SkipForward className={big ? 'h-6 w-6' : 'h-[18px] w-[18px]'} fill="currentColor" />
      </IconButton>
      <IconButton
        label={repeat === 'off' ? 'Enable repeat' : repeat === 'all' ? 'Repeat one' : 'Disable repeat'}
        active={repeat !== 'off'}
        onClick={() => p().cycleRepeat()}
        size={big ? 'lg' : 'md'}
      >
        {repeat === 'one' ? <Repeat1 className={big ? 'h-5 w-5' : 'h-4 w-4'} /> : <Repeat className={big ? 'h-5 w-5' : 'h-4 w-4'} />}
      </IconButton>
    </div>
  )
}

/** Volume of whatever is playing: the local player, or the controlled Connect device. */
export function VolumeControl({ className, width = 'w-24' }: { className?: string; width?: string }): ReactNode {
  const { volume, muted } = useNowVolume()
  const setVolume = playback.setVolume
  const toggleMute = playback.toggleMute
  const v = muted ? 0 : volume
  const Icon = v === 0 ? VolumeX : v < 0.34 ? Volume : v < 0.67 ? Volume1 : Volume2
  return (
    <div className={cx('flex items-center gap-1', className)}>
      <IconButton label={muted ? 'Unmute' : 'Mute'} onClick={toggleMute} size="sm">
        <Icon className="h-[18px] w-[18px]" />
      </IconButton>
      <input
        type="range"
        className={cx('range', width)}
        aria-label="Volume"
        min={0}
        max={1}
        step={0.01}
        value={v}
        style={{ ['--fill' as string]: `${v * 100}%` }}
        onChange={(e) => setVolume(Number(e.currentTarget.value))}
        onWheel={(e) => setVolume(volume + (e.deltaY < 0 ? 0.05 : -0.05))}
      />
    </div>
  )
}
