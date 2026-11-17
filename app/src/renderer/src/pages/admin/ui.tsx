import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { cx } from '../../components/common'

export const inputClass =
  'w-full rounded-xl border border-line bg-ink-900 py-2.5 pr-4 pl-4 text-[15px] outline-none transition placeholder:text-fg-subtle focus:border-accent/70 focus:bg-ink-800 disabled:opacity-50'

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-ink-950 hover:brightness-110',
  secondary: 'bg-white/[0.08] text-fg hover:bg-white/[0.14]',
  danger: 'bg-[#e5484d]/15 text-[#ff8f93] hover:bg-[#e5484d]/25',
  ghost: 'text-fg-muted hover:bg-white/8 hover:text-fg'
}

export function Button({
  variant = 'secondary',
  size = 'md',
  busy,
  icon,
  children,
  className,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; busy?: boolean; icon?: ReactNode }): ReactNode {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        'no-drag inline-flex shrink-0 items-center justify-center gap-2 rounded-full font-semibold whitespace-nowrap transition active:scale-[0.97]',
        'disabled:pointer-events-none disabled:opacity-40 [&>svg]:h-4 [&>svg]:w-4',
        size === 'sm' ? 'h-8 px-3.5 text-[13px]' : 'h-10 px-5 text-sm',
        VARIANTS[variant],
        className
      )}
    >
      {busy ? <Loader2 className="animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  )
}

/** Card surface used by every admin panel. */
export function Card({
  title,
  action,
  children,
  className,
  id
}: {
  title?: string
  action?: ReactNode
  children: ReactNode
  className?: string
  id?: string
}): ReactNode {
  return (
    <section aria-labelledby={title && id ? id : undefined} className={cx('fade-up rounded-2xl bg-ink-850 p-4 sm:p-5', className)}>
      {(title || action) && (
        <div className="mb-4 flex min-h-8 flex-wrap items-center justify-between gap-x-4 gap-y-2">
          {title && (
            <h2 id={id} className="text-lg font-bold tracking-tight">
              {title}
            </h2>
          )}
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

export type ChipTone = 'neutral' | 'accent' | 'good' | 'warn' | 'bad'
const CHIP: Record<ChipTone, string> = {
  neutral: 'bg-white/[0.08] text-fg-muted',
  accent: 'bg-accent-soft text-accent',
  good: 'bg-[#2fbf71]/15 text-[#5fd698]',
  warn: 'bg-[#f5a524]/15 text-[#ffc15e]',
  bad: 'bg-[#e5484d]/15 text-[#ff8f93]'
}

export function Chip({ tone = 'neutral', children, className }: { tone?: ChipTone; children: ReactNode; className?: string }): ReactNode {
  return (
    <span className={cx('inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold tracking-wide uppercase', CHIP[tone], className)}>
      {children}
    </span>
  )
}

/** Thin progress bar. `value` is 0..1; omit for an indeterminate (pulsing) bar. */
export function ProgressBar({ value, label, tone = 'accent', className }: { value?: number; label: string; tone?: 'accent' | 'good' | 'bad' | 'warn'; className?: string }): ReactNode {
  const pct = value === undefined ? undefined : Math.round(Math.min(1, Math.max(0, value)) * 100)
  const fill = tone === 'good' ? 'bg-[#5fd698]' : tone === 'bad' ? 'bg-[#ff8f93]' : tone === 'warn' ? 'bg-[#ffc15e]' : 'bg-accent'
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className={cx('h-1.5 w-full overflow-hidden rounded-full bg-white/10', className)}
    >
      <div
        className={cx('h-full rounded-full transition-[width] duration-300 ease-out', fill, pct === undefined && 'w-full animate-pulse opacity-50')}
        style={pct === undefined ? undefined : { width: `${pct}%` }}
      />
    </div>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label
}: {
  value: T
  options: { id: T; label: string; icon?: ReactNode }[]
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
            'inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors [&>svg]:h-4 [&>svg]:w-4',
            value === o.id ? 'bg-fg text-ink-950' : 'text-fg-muted hover:text-fg'
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-xs font-semibold text-fg-muted">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1.5 text-xs text-fg-subtle">{hint}</p>}
    </div>
  )
}

export function InlineError({ message }: { message: string | null }): ReactNode {
  return (
    <p role="alert" className={cx('text-sm text-[#ff9b9b]', !message && 'sr-only')}>
      {message ?? ''}
    </p>
  )
}

/** Debounces a fast-changing value. */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return v
}

/** Re-renders the caller every `ms` so relative timestamps stay fresh. */
export function useTick(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}
