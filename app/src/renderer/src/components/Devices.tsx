import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Cast, Laptop, Monitor, MonitorSpeaker, Pause, Play, Radio,
  SkipBack, SkipForward, Smartphone, Speaker
} from 'lucide-react'
import { useConnect } from '../services'
import type { ConnectSession } from '../api/types'
import { IconButton, cx } from './common'

function platformIcon(platform: string): ReactNode {
  const p = platform.toLowerCase()
  if (p.includes('android') || p.includes('ios')) return <Smartphone className="h-4 w-4" />
  if (p.includes('desktop')) return <Monitor className="h-4 w-4" />
  if (p === 'web') return <Laptop className="h-4 w-4" />
  return <Speaker className="h-4 w-4" />
}

function statusLabel(s: ConnectSession): string {
  if (!s.online) return 'Offline'
  const st = s.state.status
  if (st === 'playing' || st === 'buffering' || st === 'loading') {
    const t = s.state.track
    return t ? `Playing · ${t.title}` : 'Playing'
  }
  if (st === 'paused') {
    const t = s.state.track
    return t ? `Paused · ${t.title}` : 'Paused'
  }
  return 'Idle'
}

function RemoteControls({ session }: { session: ConnectSession }): ReactNode {
  const command = useConnect((s) => s.command)
  const playHereFrom = useConnect((s) => s.playHereFrom)
  const st = session.state
  const playing = st.status === 'playing' || st.status === 'buffering' || st.status === 'loading'
  const canControl = session.controllable && session.online

  return (
    <div className="mt-2 flex items-center gap-1">
      <IconButton label="Previous" size="sm" disabled={!canControl} onClick={() => void command(session.id, 'previous')}>
        <SkipBack className="h-4 w-4" />
      </IconButton>
      <IconButton label={playing ? 'Pause' : 'Play'} size="sm" disabled={!canControl}
        onClick={() => void command(session.id, playing ? 'pause' : 'play')}>
        {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </IconButton>
      <IconButton label="Next" size="sm" disabled={!canControl} onClick={() => void command(session.id, 'next')}>
        <SkipForward className="h-4 w-4" />
      </IconButton>
      <button
        type="button"
        disabled={!st.track}
        onClick={() => void playHereFrom(session.id)}
        className="ml-auto rounded-full bg-accent/15 px-3 py-1 text-xs font-semibold text-accent hover:bg-accent/25 disabled:opacity-35"
      >
        Play here
      </button>
    </div>
  )
}

function Popover({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: 0, top: 0 })
  const sessions = useConnect((s) => s.sessions)

  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect()
    const width = 320
    const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8))
    setPos({ left, top: r.top - 8 })
  }, [anchor])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [anchor, onClose])

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="Devices"
      style={{ left: pos.left, top: pos.top, width: 320, transform: 'translateY(-100%)' }}
      className="fade-up fixed z-[100] rounded-xl border border-line bg-ink-800/95 p-3 shadow-2xl shadow-black/60 backdrop-blur-xl"
    >
      <div className="mb-2 flex items-center gap-2 px-1">
        <Cast className="h-4 w-4 text-accent" />
        <h3 className="text-sm font-semibold">Devices</h3>
      </div>
      {sessions.length === 0 ? (
        <p className="px-1 py-6 text-center text-xs text-fg-muted">
          No other devices are signed in.<br />Open Nocturne on another device to control it here.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {sessions.map((s) => (
            <li key={s.id} className="rounded-lg border border-line/60 bg-white/[0.02] p-2.5">
              <div className="flex items-center gap-2.5">
                <span className={cx('flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
                  s.online ? 'bg-accent/15 text-accent' : 'bg-white/5 text-fg-subtle')}>
                  {platformIcon(s.platform)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{s.name}</p>
                  <p className="truncate text-xs text-fg-muted">{statusLabel(s)}</p>
                </div>
                {s.online && <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" aria-label="Online" />}
              </div>
              {s.online && <RemoteControls session={s} />}
            </li>
          ))}
        </ul>
      )}
    </div>,
    document.body
  )
}

/** Devices button + popover for the player bar. Renders nothing when Connect is inactive. */
export function DevicesButton(): ReactNode {
  const active = useConnect((s) => s.active)
  const sessions = useConnect((s) => s.sessions)
  const openPanel = useConnect((s) => s.openPanel)
  const closePanel = useConnect((s) => s.closePanel)
  const btnRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (open) openPanel()
    else closePanel()
    return () => closePanel()
  }, [open, openPanel, closePanel])

  if (!active) return null
  const onlineCount = sessions.filter((s) => s.online).length

  return (
    <div ref={btnRef} className="relative inline-flex">
      <IconButton label="Devices" active={open} onClick={() => setOpen((v) => !v)}>
        <span className="relative">
          {onlineCount > 0 ? <MonitorSpeaker className="h-[18px] w-[18px]" /> : <Radio className="h-[18px] w-[18px]" />}
          {onlineCount > 0 && (
            <span className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-0.5 text-[9px] font-bold text-ink-950">
              {onlineCount}
            </span>
          )}
        </span>
      </IconButton>
      {open && btnRef.current && <Popover anchor={btnRef.current} onClose={() => setOpen(false)} />}
    </div>
  )
}
