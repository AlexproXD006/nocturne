import { useT } from '../i18n'
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusables(root: HTMLElement | null): HTMLElement[] {
  if (!root) return []
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute('hidden') && el.getClientRects().length > 0)
}

export interface ModalProps {
  title: string
  description?: ReactNode
  onClose: () => void
  children?: ReactNode
  footer?: ReactNode
  /** When false, Esc / backdrop / close button do nothing (e.g. while saving). */
  dismissible?: boolean
  size?: 'sm' | 'md'
  /** Element to focus first; defaults to `[data-autofocus]`, then the first focusable. */
  initialFocus?: () => HTMLElement | null
}

/** Accessible modal: role=dialog, aria-modal, focus trap, Esc to close, focus restored on close. */
export function Modal({ title, description, onClose, children, footer, dismissible = true, size = 'sm', initialFocus }: ModalProps): ReactNode {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descId = useId()
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const initialRef = useRef(initialFocus)
  initialRef.current = initialFocus

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const root = ref.current
    const target = initialRef.current?.() ?? root?.querySelector<HTMLElement>('[data-autofocus]') ?? focusables(root)[0] ?? root
    target?.focus()
    return () => {
      if (previous && document.contains(previous)) previous.focus()
    }
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // Keep global player shortcuts (space, arrows, letters) from firing behind the dialog.
    e.nativeEvent.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      if (dismissible) closeRef.current()
      return
    }
    if (e.key !== 'Tab') return
    const items = focusables(ref.current)
    if (items.length === 0) {
      e.preventDefault()
      ref.current?.focus()
      return
    }
    const first = items[0]!
    const last = items[items.length - 1]!
    const active = document.activeElement
    if (e.shiftKey && (active === first || active === ref.current)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    } else if (!ref.current?.contains(active)) {
      e.preventDefault()
      first.focus()
    }
  }

  return createPortal(
    <div
      className="g-scrim fixed inset-0 z-[110] flex items-end justify-center bg-black/65 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && dismissible) closeRef.current()
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`fade-up g-pop g-sheet flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-line bg-ink-850 pb-[env(safe-area-inset-bottom)] shadow-2xl shadow-black/70 outline-none sm:rounded-2xl sm:pb-0 ${size === 'md' ? 'sm:max-w-lg' : 'sm:max-w-md'}`}
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-5">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-bold tracking-tight">
              {title}
            </h2>
            {description && (
              <div id={descId} className="mt-1.5 text-sm text-fg-muted">
                {description}
              </div>
            )}
          </div>
          {dismissible && (
            <button
              type="button"
              aria-label={t('ui.closeDialog')}
              onClick={onClose}
              className="-mt-1 -mr-2 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-fg-muted hover:bg-white/8 hover:text-fg"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        {children && <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-1">{children}</div>}
        {footer && <div className="flex flex-col-reverse gap-2 px-5 pt-4 pb-5 sm:flex-row sm:justify-end">{footer}</div>}
        {!footer && <div className="pb-4" />}
      </div>
    </div>,
    document.body
  )
}
