import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, Disc3, Heart, Loader2, RotateCcw } from 'lucide-react'
import type { Image } from '../api/types'
import { finish, hasObserver, track, type ArtJob } from '../lib/artLoader'
import { pickImage, thumbUrl } from '../lib/url'
import { api, platform } from '../services'
import { useLikes } from '../store/likes'
import { useUi } from '../store/ui'
import { describeError } from '../api/errors'
import { useT } from '../i18n'

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

/** One automatic retry after this long when a cover fails to load (slow thumbnail generation, flaky network). */
export const ARTWORK_RETRY_MS = 1500

export const Artwork = memo(function Artwork({
  images,
  size,
  alt = '',
  className,
  rounded = 'rounded-lg',
  round = false,
  eager = false
}: {
  images: Image[] | undefined
  size: number
  alt?: string
  className?: string
  rounded?: string
  round?: boolean
  /** Skip lazy loading (the fullscreen cover: a lazy image inside an animated layer can stay unloaded on WebViews). */
  eager?: boolean
}): ReactNode {
  const px = Math.ceil(size * (typeof devicePixelRatio === 'number' ? Math.min(3, devicePixelRatio) : 1))
  const picked = pickImage(images, px)
  // Small thumbnails (the server caches them on disk) instead of the 300/640 px defaults; eager covers keep theirs.
  const url = picked && !eager ? thumbUrl(picked, px) : picked
  // Failure state is tied to the URL it happened for: a new track's cover always gets a fresh attempt.
  const [err, setErr] = useState<{ url: string; n: number }>({ url: '', n: 0 })
  const failures = err.url === url ? err.n : 0
  const shape = round ? 'rounded-full' : rounded
  const gated = !eager && hasObserver()
  // Viewport-driven loading: the <img> gets its src only once the shared loader grants it a slot (see lib/artLoader).
  const [granted, setGranted] = useState<string>('')
  const imgRef = useRef<HTMLImageElement | null>(null)
  const jobRef = useRef<ArtJob | null>(null)
  useEffect(() => {
    const el = imgRef.current
    if (!gated || !url || !el) return
    const t = track(
      el,
      () => setGranted(url),
      () => setGranted((g) => (g === url ? '' : g))
    )
    jobRef.current = t.job
    return () => {
      t.stop()
      jobRef.current = null
    }
  }, [gated, url, failures])
  const src = gated ? (granted === url ? url : undefined) : url
  useEffect(() => {
    if (!url || failures !== 1) return
    const id = setTimeout(() => setErr((e) => (e.url === url && e.n === 1 ? { url, n: 0.5 } : e)), ARTWORK_RETRY_MS)
    return () => clearTimeout(id)
  }, [url, failures])
  // n: 0 = loading/ok, 1 = failed once (placeholder, retry pending), 0.5 = retrying, 2 = gave up.
  if (!url || failures === 1 || failures === 2) {
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
      key={`${url}|${failures}`}
      ref={(el) => {
        imgRef.current = el
        // Already in the browser cache: show it at once instead of fading in.
        if (el && gated && el.complete && el.naturalWidth > 0) el.dataset.c = '1'
      }}
      src={src}
      alt={src ? alt : ''}
      loading={gated ? undefined : eager ? 'eager' : 'lazy'}
      decoding="async"
      fetchPriority={eager || src ? 'high' : 'auto'}
      draggable={false}
      referrerPolicy="no-referrer"
      onLoad={(e) => {
        if (gated && !e.currentTarget.dataset.c) e.currentTarget.dataset.l = '1'
        if (jobRef.current) finish(jobRef.current)
      }}
      onError={() => {
        if (jobRef.current) finish(jobRef.current)
        setErr({ url, n: failures === 0.5 ? 2 : 1 })
      }}
      data-art={gated ? '' : undefined}
      className={cx('bg-ink-800 object-cover', shape, className)}
    />
  )
})

export function Spinner({ className }: { className?: string }): ReactNode {
  const t = useT()
  return <Loader2 className={cx('animate-spin text-fg-muted', className ?? 'h-5 w-5')} aria-label={t('ui.loading')} />
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }): ReactNode {
  const t = useT()
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-20 text-center fade-up">
      <AlertCircle className="h-8 w-8 text-fg-subtle" strokeWidth={1.5} />
      <p className="max-w-sm text-sm text-fg-muted">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-1 inline-flex items-center gap-2 rounded-full bg-white/8 px-4 py-2 text-sm font-medium hover:bg-white/12"
        >
          <RotateCcw className="h-4 w-4" /> {t('ui.tryAgain')}
        </button>
      )}
    </div>
  )
}

export function EmptyState({ icon, title, hint, action }: { icon: ReactNode; title: string; hint?: string; action?: ReactNode }): ReactNode {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-20 text-center fade-up">
      <div className="mb-1 text-fg-subtle">{icon}</div>
      <p className="font-semibold">{title}</p>
      {hint && <p className="max-w-sm text-sm text-fg-muted">{hint}</p>}
      {action && <div className="mt-3">{action}</div>}
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
  const t = useT()
  const liked = useLikes((s) => s.overrides[trackId] ?? serverValue === true)
  const pending = useLikes((s) => Boolean(s.pending[trackId]))
  return (
    <button
      type="button"
      aria-label={liked ? t('ui.unlike') : t('ui.like')}
      title={liked ? t('ui.unlike') : t('ui.like')}
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
