import { useState, type ReactNode } from 'react'
import { AlertCircle, Disc3, Heart, Loader2, RotateCcw } from 'lucide-react'
import type { Image } from '../api/types'
import { pickImage } from '../lib/url'
import { api, platform } from '../services'
import { useLikes } from '../store/likes'
import { useUi } from '../store/ui'
import { describeError } from '../api/errors'

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export function Artwork({
  images,
  size,
  alt = '',
  className,
  rounded = 'rounded-lg',
  round = false
}: {
  images: Image[] | undefined
  size: number
  alt?: string
  className?: string
  rounded?: string
  round?: boolean
}): ReactNode {
  const url = pickImage(images, size * (typeof devicePixelRatio === 'number' ? Math.min(2, devicePixelRatio) : 1))
  const [failed, setFailed] = useState(false)
  const shape = round ? 'rounded-full' : rounded
  if (!url || failed) {
    return (
      <div
        className={cx('flex items-center justify-center bg-gradient-to-br from-ink-700 to-ink-800 text-fg-subtle', shape, className)}
        aria-hidden={alt ? undefined : true}
        role={alt ? 'img' : undefined}
        aria-label={alt || undefined}
      >
        <Disc3 className="h-1/3 w-1/3" strokeWidth={1.5} />
      </div>
    )
  }
  return (
    <img
      src={url}
      alt={alt}
      loading="lazy"
      decoding="async"
      draggable={false}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={cx('bg-ink-800 object-cover', shape, className)}
    />
  )
}

export function Spinner({ className }: { className?: string }): ReactNode {
  return <Loader2 className={cx('animate-spin text-fg-muted', className ?? 'h-5 w-5')} aria-label="Loading" />
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }): ReactNode {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-20 text-center fade-up">
      <AlertCircle className="h-8 w-8 text-fg-subtle" strokeWidth={1.5} />
      <p className="max-w-sm text-sm text-fg-muted">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-1 inline-flex items-center gap-2 rounded-full bg-white/8 px-4 py-2 text-sm font-medium hover:bg-white/12"
        >
          <RotateCcw className="h-4 w-4" /> Try again
        </button>
      )}
    </div>
  )
}

export function EmptyState({ icon, title, hint }: { icon: ReactNode; title: string; hint?: string }): ReactNode {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-20 text-center fade-up">
      <div className="mb-1 text-fg-subtle">{icon}</div>
      <p className="font-semibold">{title}</p>
      {hint && <p className="max-w-sm text-sm text-fg-muted">{hint}</p>}
    </div>
  )
}

export function IconButton({
  label,
  onClick,
  children,
  active,
  disabled,
  className,
  size = 'md'
}: {
  label: string
  onClick?: () => void
  children: ReactNode
  active?: boolean
  disabled?: boolean
  className?: string
  size?: 'sm' | 'md' | 'lg'
}): ReactNode {
  const dims = size === 'sm' ? 'h-8 w-8' : size === 'lg' ? 'h-11 w-11' : 'h-9 w-9'
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'no-drag relative inline-flex shrink-0 items-center justify-center rounded-full transition-colors duration-150',
        'disabled:pointer-events-none disabled:opacity-35',
        active ? 'text-accent' : 'text-fg-muted hover:text-fg',
        'hover:bg-white/6 active:scale-95',
        dims,
        className
      )}
    >
      {children}
      {active && <span className="absolute bottom-1 h-1 w-1 rounded-full bg-accent" aria-hidden />}
    </button>
  )
}

export function LikeButton({ trackId, serverValue, size = 'sm' }: { trackId: string; serverValue?: boolean; size?: 'sm' | 'md' }): ReactNode {
  const liked = useLikes((s) => s.overrides[trackId] ?? serverValue === true)
  const pending = useLikes((s) => Boolean(s.pending[trackId]))
  return (
    <button
      type="button"
      aria-label={liked ? 'Remove from liked songs' : 'Save to liked songs'}
      title={liked ? 'Remove from liked songs' : 'Save to liked songs'}
      aria-pressed={liked}
      disabled={pending}
      onClick={(e) => {
        e.stopPropagation()
        useLikes
          .getState()
          .toggle(trackId, liked, (id, v) => api.setLiked(id, v))
          .catch((err: unknown) => useUi.getState().toast(describeError(err), 'error'))
      }}
      className={cx(
        'no-drag inline-flex items-center justify-center rounded-full transition active:scale-90',
        size === 'sm' ? 'h-8 w-8' : 'h-10 w-10',
        liked ? 'text-accent' : 'text-fg-subtle hover:text-fg'
      )}
    >
      <Heart className={size === 'sm' ? 'h-4 w-4' : 'h-5 w-5'} fill={liked ? 'currentColor' : 'none'} />
    </button>
  )
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }): ReactNode {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault()
        void platform.openExternal(href)
      }}
      className="text-accent underline-offset-2 hover:underline"
    >
      {children}
    </a>
  )
}

export function SectionHeader({ title, action }: { title: string; action?: ReactNode }): ReactNode {
  return (
    <div className="mb-3 flex items-end justify-between gap-4">
      <h2 className="text-xl font-bold tracking-tight">{title}</h2>
      {action}
    </div>
  )
}
