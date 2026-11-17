import { type ReactNode } from 'react'
import { cx } from '../components/common'

/** Building blocks shared by the Settings page and its sub-panels. */

export function Row({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children?: ReactNode; htmlFor?: string }): ReactNode {
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

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx(
        // The ::after extends the hit area to 44px tall without changing the look.
        'relative h-7 w-12 shrink-0 rounded-full transition-colors duration-200 after:absolute after:-inset-2',
        checked ? 'bg-accent' : 'bg-white/15'
      )}
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

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  large = false
}: {
  value: T
  options: { id: T; label: string }[]
  onChange: (v: T) => void
  label: string
  /** Full-width on phones with 44px touch targets. */
  large?: boolean
}): ReactNode {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx('rounded-full bg-white/[0.07] p-1', large ? 'flex w-full sm:inline-flex sm:w-auto' : 'inline-flex')}
    >
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={cx(
            'rounded-full text-sm font-medium transition-colors',
            large ? 'min-h-11 min-w-0 flex-1 truncate px-3 sm:flex-none sm:px-3.5' : 'px-3.5 py-1.5',
            value === o.id ? 'bg-fg text-ink-950' : 'text-fg-muted hover:text-fg'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

