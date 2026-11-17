import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
  label: string
  icon?: ReactNode
  onSelect: () => void
  disabled?: boolean
}

/** Lightweight anchored menu (context menu / "more" button). Keyboard accessible. */
export function Menu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - height - 8))
    })
    el.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus()
  }, [x, y])

  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = e.key === 'ArrowDown' ? (i + 1) % buttons.length : (i - 1 + buttons.length) % buttons.length
        buttons[next]?.focus()
      }
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{ left: pos.left, top: pos.top }}
      className="fade-up fixed z-[100] min-w-52 rounded-xl border border-line bg-ink-800/95 p-1.5 shadow-2xl shadow-black/60 backdrop-blur-xl"
    >
      {items.map((it) => (
        <button
          key={it.label}
          role="menuitem"
          disabled={it.disabled}
          onClick={() => {
            onClose()
            it.onSelect()
          }}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-fg/90 hover:bg-white/8 focus:bg-white/8 focus:outline-none disabled:opacity-40"
        >
          <span className="text-fg-muted [&>svg]:h-4 [&>svg]:w-4">{it.icon}</span>
          {it.label}
        </button>
      ))}
    </div>,
    document.body
  )
}

export function useMenu(): {
  menu: { x: number; y: number } | null
  open: (x: number, y: number) => void
  close: () => void
} {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const open = useCallback((x: number, y: number) => setMenu({ x, y }), [])
  const close = useCallback(() => setMenu(null), [])
  return { menu, open, close }
}
