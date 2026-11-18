import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Download, Share2, X } from 'lucide-react'
import { useUi } from '../store/ui'
import { prefersReducedMotion, useSettings } from '../store/settings'
import { cx } from './common'
import {
  canvasToPngBlob,
  drawLyricCard,
  ensureCardFonts,
  loadCardImage,
  type CardRatio
} from '../lib/lyricCard'
import { useT, type MessageKey } from '../i18n'

export interface LyricCardProps {
  title: string
  artist: string
  /** Selected lyric lines, in reading order (1–10). */
  lines: string[]
  coverUrl?: string
  onClose: () => void
}

const RATIO_OPTIONS: Array<{ id: CardRatio; label: MessageKey }> = [
  { id: 'square', label: 'card.square' },
  { id: 'story', label: 'card.story' }
]

/**
 * Modal that turns selected lyric lines into a shareable image. A single canvas
 * is drawn at 1080px and shown scaled-down as a live preview; the same canvas is
 * the export source. Album art is loaded with CORS and drawn best-effort — if it
 * can't be used the card falls back to gradient-only so export always works.
 */
export function LyricCard({ title, artist, lines, coverUrl, onClose }: LyricCardProps): ReactNode {
  const tr = useT()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const coverRef = useRef<HTMLImageElement | null>(null)
  const [ratio, setRatio] = useState<CardRatio>('square')
  const [coverVersion, setCoverVersion] = useState(0)
  const [busy, setBusy] = useState(false)
  const [closing, setClosing] = useState(false)
  const toast = useUi((s) => s.toast)
  const reduced = prefersReducedMotion(useSettings((s) => s.motion))

  // Plays the exit animation, then unmounts. Instant when motion is reduced.
  const requestClose = useCallback((): void => {
    if (reduced) {
      onClose()
      return
    }
    setClosing((c) => {
      if (!c) window.setTimeout(onClose, 160)
      return true
    })
  }, [reduced, onClose])

  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  // Load the album art once (best-effort; null on CORS failure).
  useEffect(() => {
    let alive = true
    void loadCardImage(coverUrl).then((img) => {
      if (!alive) return
      coverRef.current = img
      setCoverVersion((v) => v + 1)
    })
    return () => {
      alive = false
    }
  }, [coverUrl])

  // Draw / redraw whenever the ratio, lines or cover change.
  useEffect(() => {
    let alive = true
    void ensureCardFonts().then(() => {
      const canvas = canvasRef.current
      if (!alive || !canvas) return
      drawLyricCard(canvas, ratio, { title, artist, lines }, coverRef.current)
    })
    return () => {
      alive = false
    }
  }, [ratio, title, artist, lines, coverVersion])

  // Esc closes; also keep global player shortcuts from firing behind the dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        requestClose()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [requestClose])

  /** Returns a PNG blob, retrying without the cover if the canvas was tainted. */
  const currentBlob = async (): Promise<Blob | null> => {
    const canvas = canvasRef.current
    if (!canvas) return null
    let blob = await canvasToPngBlob(canvas)
    if (!blob && coverRef.current) {
      await ensureCardFonts()
      drawLyricCard(canvas, ratio, { title, artist, lines }, null)
      blob = await canvasToPngBlob(canvas)
    }
    return blob
  }

  const triggerDownload = (blob: Blob): void => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'nocturne-lyrics.png'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1500)
  }

  const onDownload = async (): Promise<void> => {
    setBusy(true)
    try {
      const blob = await currentBlob()
      if (!blob) {
        toast(tr('card.imageFailed'), 'error')
        return
      }
      triggerDownload(blob)
    } catch {
      toast(tr('card.imageFailed'), 'error')
    } finally {
      setBusy(false)
    }
  }

  const onShare = async (): Promise<void> => {
    setBusy(true)
    try {
      const blob = await currentBlob()
      if (!blob) {
        toast(tr('card.imageFailed'), 'error')
        return
      }
      const file = new File([blob], 'nocturne-lyrics.png', { type: 'image/png' })
      const data: ShareData = { files: [file], title, text: artist ? `${title} — ${artist}` : title }
      if (typeof navigator.canShare === 'function' && navigator.canShare(data)) {
        try {
          await navigator.share(data)
          return
        } catch (err) {
          // User-cancelled share is not an error; anything else falls back.
          if (err instanceof DOMException && err.name === 'AbortError') return
        }
      }
      triggerDownload(blob)
    } catch {
      toast(tr('card.shareFailed'), 'error')
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div
      className={cx(
        'g-scrim fixed inset-0 z-[120] flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4',
        !reduced && (closing ? 'overlay-fade-out' : 'overlay-fade')
      )}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={tr('card.lyricsDialog')}
        className={cx(
          'g-pop g-sheet flex max-h-[94dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-line bg-ink-850 pb-[env(safe-area-inset-bottom)] shadow-2xl shadow-black/70 sm:max-w-md sm:rounded-2xl sm:pb-0',
          !reduced && (closing ? 'modal-pop-out' : 'modal-pop')
        )}
      >
        <div className="flex items-center justify-between gap-4 px-5 pt-5 pb-1">
          <h2 className="text-lg font-bold tracking-tight">{tr('card.lyricsTitle')}</h2>
          <button
            type="button"
            aria-label={tr('card.close')}
            onClick={requestClose}
            className="-mt-1 -mr-2 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-fg-muted hover:bg-white/8 hover:text-fg"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 pt-3" role="group" aria-label={tr('card.shapeGroup')}>
          <div className="inline-flex rounded-full bg-ink-900 p-1">
            {RATIO_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                aria-pressed={ratio === opt.id}
                onClick={() => setRatio(opt.id)}
                className={
                  'rounded-full px-4 py-1.5 text-sm font-medium transition-colors ' +
                  (ratio === opt.id ? 'bg-accent text-ink-950' : 'text-fg-muted hover:text-fg')
                }
              >
                {tr(opt.label)}
              </button>
            ))}
          </div>
        </div>

        <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-5 py-4">
          <canvas
            ref={canvasRef}
            aria-label={tr('card.lyricsPreview', { title })}
            role="img"
            className="h-auto max-h-[56vh] w-auto max-w-full rounded-xl shadow-lg shadow-black/50"
          />
        </div>

        <div className="flex gap-2 px-5 pt-1 pb-5">
          <button
            type="button"
            aria-label={tr('card.downloadLabel')}
            disabled={busy}
            onClick={() => void onDownload()}
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-full bg-white/10 px-4 py-3 text-sm font-semibold text-fg transition-colors hover:bg-white/14 disabled:pointer-events-none disabled:opacity-50"
          >
            <Download className="h-4 w-4" /> {tr('card.download')}
          </button>
          {canNativeShare && (
            <button
              type="button"
              aria-label={tr('card.shareLabel')}
              disabled={busy}
              onClick={() => void onShare()}
              className="inline-flex flex-1 items-center justify-center gap-2 rounded-full bg-accent px-4 py-3 text-sm font-semibold text-ink-950 transition-transform active:scale-95 disabled:pointer-events-none disabled:opacity-50"
            >
              <Share2 className="h-4 w-4" /> {tr('card.share')}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
