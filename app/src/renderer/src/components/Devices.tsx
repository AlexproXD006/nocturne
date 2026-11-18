import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import {
  Cast, Check, Laptop, Monitor, MonitorSpeaker, Pause, Pencil, Play, Radio,
  SkipBack, SkipForward, Smartphone, Speaker, X
} from 'lucide-react'
import { autoDeviceName, platform, playback, useConnect } from '../services'
import type { ConnectSession } from '../api/types'
import { useSettings } from '../store/settings'
import { platformLabel, sessionDisplayName } from '../lib/deviceName'
import { IconButton, cx } from './common'
import { VolumeControl } from './controls'
import { t, useT } from '../i18n'

/** Where the devices panel is showing: anchored popover (desktop) or bottom sheet (phone). */
export const useDevicesUi = create<{ open: 'popover' | 'sheet' | null; show(mode: 'popover' | 'sheet'): void; hide(): void }>((set) => ({
  open: null,
  show: (mode) => set({ open: mode }),
  hide: () => set({ open: null })
}))

/** Opens the panel in the form that fits the screen. */
export function openDevices(): void {
  const wide = typeof matchMedia === 'function' && matchMedia('(min-width: 768px)').matches
  useDevicesUi.getState().show(wide && document.querySelector('[data-devices-anchor]') ? 'popover' : 'sheet')
}

function platformIcon(p: string, cls = 'h-4 w-4'): ReactNode {
  const k = p.toLowerCase()
  if (k.includes('android') || k.includes('ios')) return <Smartphone className={cls} />
  if (k.includes('desktop')) return <Monitor className={cls} />
  if (k === 'web') return <Laptop className={cls} />
  return <Speaker className={cls} />
}

const ACTIVE = new Set(['playing', 'buffering', 'loading'])

function statusLabel(s: ConnectSession): string {
  if (!s.online) return t('dev.offline')
  const st = s.state.status ?? 'idle'
  const track = s.state.track
  const what = track ? `${track.title} · ${track.artists.map((a) => a.name).join(', ')}` : ''
  if (ACTIVE.has(st)) return what ? t('dev.playingWhat', { what }) : t('dev.playing')
  if (st === 'paused') return what ? t('dev.pausedWhat', { what }) : t('dev.paused')
  return t('dev.idle')
}

function SelfRow(): ReactNode {
  const tr = useT()
  const selfName = useConnect((s) => s.selfName)
  const controlling = useConnect((s) => s.controlling)
  const playHereFrom = useConnect((s) => s.playHereFrom)
  const update = useSettings((s) => s.update)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(selfName)

  const save = (): void => {
    const name = draft.trim()
    update({ deviceName: name && name !== autoDeviceName() ? name : '' })
    setEditing(false)
  }

  return (
    <li className={cx('rounded-lg border p-2.5', controlling ? 'border-line/60 bg-white/[0.02]' : 'border-accent/40 bg-accent/10')}>
      <div className="flex items-center gap-2.5">
        <span className={cx('flex h-8 w-8 shrink-0 items-center justify-center rounded-full', controlling ? 'bg-white/5 text-fg-muted' : 'bg-accent/20 text-accent')}>
          {platformIcon(platform.kind)}
        </span>
        <div className="min-w-0 flex-1">
          {editing ? (
            <form onSubmit={(e) => { e.preventDefault(); save() }} className="flex items-center gap-1">
              <input
                autoFocus
                aria-label={tr('dev.name')}
                maxLength={80}
                value={draft}
                onChange={(e) => setDraft(e.currentTarget.value)}
                onKeyDown={(e) => { e.nativeEvent.stopPropagation(); if (e.key === 'Escape') setEditing(false) }}
                className="min-w-0 flex-1 rounded-md border border-line bg-ink-900 px-2 py-1 text-sm outline-none focus:border-accent"
              />
              <IconButton label={tr('dev.saveName')} size="sm" onClick={save}><Check className="h-4 w-4" /></IconButton>
            </form>
          ) : (
            <p className="flex items-center gap-1 truncate text-sm font-medium">
              <span className="truncate">{selfName}</span>
              <span className="shrink-0 text-xs font-normal text-fg-muted">· {tr('dev.thisDevice')}</span>
              <button type="button" aria-label={tr('dev.rename')} onClick={() => { setDraft(selfName); setEditing(true) }}
                className="ml-0.5 shrink-0 rounded p-0.5 text-fg-subtle hover:text-fg">
                <Pencil className="h-3 w-3" />
              </button>
            </p>
          )}
          <p className={cx('truncate text-xs', controlling ? 'text-fg-muted' : 'text-accent')}>
            {controlling ? tr('dev.notHere') : tr('dev.listeningHere')}
          </p>
        </div>
      </div>
      {controlling && (
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={() => void playHereFrom(controlling)}
            className="rounded-full bg-accent px-3 py-1 text-xs font-semibold whitespace-nowrap text-ink-950 hover:brightness-110"
          >
            {tr('dev.playHere')}
          </button>
        </div>
      )}
    </li>
  )
}

function SessionRow({ session }: { session: ConnectSession }): ReactNode {
  const tr = useT()
  const controlling = useConnect((s) => s.controlling)
  const remoteStatus = useConnect((s) => (s.remote?.id === session.id ? s.remote.state.status : undefined))
  const control = useConnect((s) => s.control)
  const release = useConnect((s) => s.release)
  const command = useConnect((s) => s.command)
  const playHereFrom = useConnect((s) => s.playHereFrom)
  const isControlled = controlling === session.id
  const st = session.state
  const playing = ACTIVE.has((isControlled ? remoteStatus : st.status) ?? '')
  const canControl = session.controllable && session.online
  const name = sessionDisplayName(session)

  // While controlled, transport goes through the router (optimistic remote state).
  const send = (kind: 'previous' | 'next' | 'toggle'): void => {
    if (isControlled) {
      if (kind === 'toggle') playback.toggle()
      else if (kind === 'next') playback.next()
      else playback.previous()
      return
    }
    void command(session.id, kind === 'toggle' ? (playing ? 'pause' : 'play') : kind).catch(() => undefined)
  }

  return (
    <li className={cx('rounded-lg border p-2.5', isControlled ? 'border-accent/50 bg-accent/10' : 'border-line/60 bg-white/[0.02]')}>
      <div className="flex items-center gap-2.5">
        <span className={cx('flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
          isControlled ? 'bg-accent/25 text-accent' : session.online ? 'bg-accent/15 text-accent' : 'bg-white/5 text-fg-subtle')}>
          {platformIcon(session.platform)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{name}</p>
          <p className="truncate text-xs text-fg-muted">
            {platformLabel(session.platform)} · {statusLabel(session)}
          </p>
        </div>
        {session.online && <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" aria-label={tr('dev.online')} />}
      </div>
      {session.online && (
        <>
          <div className="mt-2 flex items-center gap-1">
            <IconButton label={tr('ctl.previous')} size="sm" disabled={!canControl} onClick={() => send('previous')}>
              <SkipBack className="h-4 w-4" />
            </IconButton>
            <IconButton label={playing ? tr('ctl.pause') : tr('ctl.play')} size="sm" disabled={!canControl} onClick={() => send('toggle')}>
              {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </IconButton>
            <IconButton label={tr('ctl.next')} size="sm" disabled={!canControl} onClick={() => send('next')}>
              <SkipForward className="h-4 w-4" />
            </IconButton>
            <div className="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                disabled={!st.track}
                onClick={() => void playHereFrom(session.id)}
                className="rounded-full bg-white/8 px-3 py-1 text-xs font-semibold whitespace-nowrap text-fg hover:bg-white/15 disabled:opacity-35"
              >
                {tr('dev.playHere')}
              </button>
              {isControlled ? (
                <button
                  type="button"
                  onClick={release}
                  className="rounded-full bg-accent px-3 py-1 text-xs font-semibold whitespace-nowrap text-ink-950 hover:brightness-110"
                >
                  {tr('dev.disconnect')}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={!canControl}
                  onClick={() => control(session.id)}
                  className="rounded-full bg-accent/15 px-3 py-1 text-xs font-semibold whitespace-nowrap text-accent hover:bg-accent/25 disabled:opacity-35"
                >
                  {tr('dev.control')}
                </button>
              )}
            </div>
          </div>
          {isControlled && <VolumeControl className="mt-1.5" width="flex-1" />}
        </>
      )}
    </li>
  )
}

function PanelBody(): ReactNode {
  const tr = useT()
  const sessions = useConnect((s) => s.sessions)
  return (
    <>
      <div className="mb-2 flex items-center gap-2 px-1">
        <Cast className="h-4 w-4 text-accent" />
        <h3 className="text-sm font-semibold">{tr('player.devices')}</h3>
      </div>
      <ul className="flex flex-col gap-1.5">
        <SelfRow />
        {sessions.map((s) => <SessionRow key={s.id} session={s} />)}
      </ul>
      {sessions.length === 0 && (
        <p className="px-1 pb-2 pt-4 text-center text-xs text-fg-muted">
          {tr('dev.none')}<br />{tr('dev.noneHint')}
        </p>
      )}
    </>
  )
}

function Popover({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }): ReactNode {
  const tr = useT()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: 0, bottom: 0 })

  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect()
    const width = 340
    const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8))
    setPos({ left, bottom: Math.max(8, window.innerHeight - r.top + 8) })
  }, [anchor])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (ref.current && !ref.current.contains(t) && !anchor.contains(t) && !(t instanceof Element && t.closest('[data-listening-bar]'))) onClose()
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
      aria-label={tr('player.devices')}
      style={{ left: pos.left, bottom: pos.bottom, width: 340 }}
      className="fade-up g-pop fixed z-[100] max-h-[70vh] overflow-y-auto rounded-xl border border-line bg-ink-800/95 p-3 shadow-2xl shadow-black/60 backdrop-blur-xl"
    >
      <PanelBody />
    </div>,
    document.body
  )
}

/** Phone: the devices panel as a bottom sheet. Mounted once at the app root. */
export function DevicesSheet(): ReactNode {
  const tr = useT()
  const open = useDevicesUi((s) => s.open === 'sheet')
  const hide = useDevicesUi((s) => s.hide)
  const openPanel = useConnect((s) => s.openPanel)
  const closePanel = useConnect((s) => s.closePanel)

  useEffect(() => {
    if (!open) return
    openPanel()
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') hide() }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      closePanel()
    }
  }, [open, openPanel, closePanel, hide])

  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-end justify-center" role="presentation">
      <div className="g-scrim absolute inset-0 bg-black/60" onClick={hide} aria-hidden />
      <div
        role="dialog"
        aria-label={tr('player.devices')}
        className="fade-up g-pop g-sheet relative max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-t-2xl border-t border-line bg-ink-800 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl"
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-white/20" aria-hidden />
        <IconButton label={tr('dev.closeSheet')} size="sm" onClick={hide} className="absolute! right-2 top-2">
          <X className="h-4 w-4" />
        </IconButton>
        <PanelBody />
      </div>
    </div>,
    document.body
  )
}

/** Devices button + popover for the player bar. Renders nothing when Connect is inactive. */
export function DevicesButton({ onClick }: { onClick?: () => void } = {}): ReactNode {
  const tr = useT()
  const active = useConnect((s) => s.active)
  const sessions = useConnect((s) => s.sessions)
  const controlling = useConnect((s) => s.controlling)
  const openPanel = useConnect((s) => s.openPanel)
  const closePanel = useConnect((s) => s.closePanel)
  const open = useDevicesUi((s) => s.open === 'popover')
  const show = useDevicesUi((s) => s.show)
  const hide = useDevicesUi((s) => s.hide)
  const btnRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open || onClick) return
    openPanel()
    return () => closePanel()
  }, [open, onClick, openPanel, closePanel])

  if (!active) return null
  const onlineCount = sessions.filter((s) => s.online).length

  return (
    <div ref={btnRef} className="relative inline-flex" data-devices-anchor={onClick ? undefined : ''}>
      <IconButton
        label={controlling ? tr('dev.controlling') : tr('player.devices')}
        active={open || controlling !== null}
        onClick={onClick ?? (() => (open ? hide() : show('popover')))}
      >
        <span className={cx('relative', controlling && 'text-accent')}>
          {onlineCount > 0 || controlling ? <MonitorSpeaker className="h-[18px] w-[18px]" /> : <Radio className="h-[18px] w-[18px]" />}
          {onlineCount > 0 && !controlling && (
            <span className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-0.5 text-[9px] font-bold text-ink-950">
              {onlineCount}
            </span>
          )}
        </span>
      </IconButton>
      {open && !onClick && btnRef.current && <Popover anchor={btnRef.current} onClose={hide} />}
    </div>
  )
}

/**
 * The accent "Listening on <device>" bar shown while controlling another device. Tap opens the
 * devices panel; the × goes back to playing on this device.
 */
export function ListeningBar({ className, rounded = '' }: { className?: string; rounded?: string }): ReactNode {
  const tr = useT()
  const remote = useConnect((s) => s.remote)
  const release = useConnect((s) => s.release)
  if (!remote) return null
  return (
    <div
      data-listening-bar=""
      className={cx('flex items-center gap-2 bg-accent px-3 text-ink-950', rounded, className)}
    >
      <button
        type="button"
        onClick={openDevices}
        className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left text-xs font-semibold"
        aria-label={tr('dev.listeningOnOpen', { name: remote.name })}
      >
        {platformIcon(remote.platform, 'h-3.5 w-3.5 shrink-0')}
        <span className="truncate">{tr('dev.listeningOn', { name: remote.name })}</span>
      </button>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); release() }}
        aria-label={tr('dev.stopControlling')}
        title={tr('dev.disconnect')}
        className="-mr-1 flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold hover:bg-black/10"
      >
        <X className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">{tr('dev.disconnect')}</span>
      </button>
    </div>
  )
}

/**
 * Phone, nothing playing here: another device is playing, offer to control it.
 * Keeps the remote reachable from the phone without opening a menu first.
 */
export function RemoteSuggestion(): ReactNode {
  const tr = useT()
  const candidate = useConnect((s) => s.controlling ? undefined : s.sessions.find((x) => x.online && x.controllable && ACTIVE.has(x.state.status ?? '') && x.state.track))
  const control = useConnect((s) => s.control)
  if (!candidate) return null
  const t = candidate.state.track!
  return (
    <div className="g-float flex items-center gap-2 rounded-xl bg-ink-700/90 p-2 pl-3 shadow-xl shadow-black/40 backdrop-blur-xl">
      <MonitorSpeaker className="h-4 w-4 shrink-0 text-accent" />
      <button type="button" onClick={openDevices} className="min-w-0 flex-1 text-left">
        <p className="truncate text-sm font-semibold">{t.title}</p>
        <p className="truncate text-xs text-accent">{tr('dev.playingOn', { name: sessionDisplayName(candidate) })}</p>
      </button>
      <button
        type="button"
        onClick={() => control(candidate.id)}
        className="shrink-0 rounded-full bg-accent px-3 py-1.5 text-xs font-semibold text-ink-950"
      >
        {tr('dev.control')}
      </button>
    </div>
  )
}
