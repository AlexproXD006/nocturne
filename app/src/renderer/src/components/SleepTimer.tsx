import { useEffect, useId, useState, type ReactNode } from 'react'
import { Moon, MoonStar, Timer, TimerOff } from 'lucide-react'
import { useSleepTimer, usePlayer } from '../services'
import { formatRemaining, parseCustomMinutes, SLEEP_PRESETS, MAX_CUSTOM_MINUTES } from '../lib/sleepTimer'
import { useUi } from '../store/ui'
import { useIsRemote } from '../hooks/useNowPlaying'
import { useT } from '../i18n'
import { Button, Field, inputClass } from '../pages/admin/ui'
import { cx } from './common'
import { Menu, useMenu, type MenuItem } from './Menu'
import { Modal } from './Modal'

/** Time left on the timer, as text ("12:34"), or null when it is off. Re-renders every second. */
export function useSleepRemaining(): string | null {
  const mode = useSleepTimer((s) => s.mode)
  const deadline = useSleepTimer((s) => s.deadline)
  const trackLeft = usePlayer((s) => (mode === 'track' ? Math.max(0, s.duration - s.position) : 0))
  const [, setNow] = useState(0)
  useEffect(() => {
    if (mode !== 'time') return
    const id = setInterval(() => setNow((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [mode])
  if (mode === 'time' && deadline) return formatRemaining(deadline - Date.now())
  if (mode === 'track') return formatRemaining(trackLeft * 1000)
  return null
}

function CustomDialog({ onClose }: { onClose: () => void }): ReactNode {
  const tr = useT()
  const [value, setValue] = useState('')
  const id = useId()
  const minutes = parseCustomMinutes(value)
  const submit = (): void => {
    if (minutes === null) return
    useSleepTimer.getState().start(minutes)
    useUi.getState().toast(tr('sleep.set', { count: minutes }))
    onClose()
  }
  return (
    <Modal
      title={tr('sleep.customTitle')}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tr('common.cancel')}
          </Button>
          <Button variant="primary" disabled={minutes === null} onClick={submit}>
            {tr('sleep.start')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <Field label={tr('sleep.minutes')} htmlFor={id} hint={tr('sleep.customHint', { max: MAX_CUSTOM_MINUTES })}>
          <input
            id={id}
            data-autofocus
            className={inputClass}
            inputMode="numeric"
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
          />
        </Field>
      </form>
    </Modal>
  )
}

/** Moon button that opens the sleep timer menu (5/15/30/45/60 min, end of track, custom, cancel). */
export function SleepTimerButton({ className }: { className?: string }): ReactNode {
  const tr = useT()
  const remote = useIsRemote()
  const mode = useSleepTimer((s) => s.mode)
  const remaining = useSleepRemaining()
  const { menu, open, close } = useMenu()
  const [custom, setCustom] = useState(false)
  if (remote) return null // the timer controls this device only

  const toast = useUi.getState().toast
  const items: MenuItem[] = []
  if (mode !== 'off') {
    items.push({
      label: tr('sleep.cancel', { time: remaining ?? '' }),
      icon: <TimerOff />,
      onSelect: () => {
        useSleepTimer.getState().cancel()
        toast(tr('sleep.cancelled'))
      }
    })
  }
  for (const m of SLEEP_PRESETS) {
    items.push({
      label: tr('sleep.minutesOption', { count: m }),
      icon: <Timer />,
      onSelect: () => {
        useSleepTimer.getState().start(m)
        toast(tr('sleep.set', { count: m }))
      }
    })
  }
  items.push({
    label: tr('sleep.endOfTrack'),
    icon: <MoonStar />,
    onSelect: () => {
      useSleepTimer.getState().startEndOfTrack()
      toast(tr('sleep.setEndOfTrack'))
    }
  })
  items.push({ label: tr('sleep.custom'), icon: <Timer />, onSelect: () => setCustom(true) })

  return (
    <>
      <button
        type="button"
        aria-label={tr('sleep.title')}
        title={remaining ? tr('sleep.remaining', { time: remaining }) : tr('sleep.title')}
        aria-pressed={mode !== 'off'}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          open(r.left, r.bottom + 6)
        }}
        className={cx(
          'no-drag inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full px-2.5 text-sm tabular-nums transition-colors duration-150 hover:bg-white/6 active:scale-95',
          mode !== 'off' ? 'text-accent' : 'text-fg-muted hover:text-fg',
          className
        )}
      >
        <Moon className="h-4 w-4" />
        {remaining && <span className="text-xs font-semibold">{remaining}</span>}
      </button>
      {menu && <Menu x={menu.x} y={menu.y} items={items} onClose={close} />}
      {custom && <CustomDialog onClose={() => setCustom(false)} />}
    </>
  )
}

