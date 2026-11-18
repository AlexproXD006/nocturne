import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Download, Share2, X } from 'lucide-react'
import { useUi } from '../store/ui'
import { prefersReducedMotion, useSettings } from '../store/settings'
import { cx } from './common'
import { canvasToPngBlob, ensureCardFonts, loadCardImage } from '../lib/lyricCard'
import { drawRecapCard, parseAccent, type RecapImages } from '../lib/recapCard'
import type { RecapData } from '../lib/stats'

/**
 * Modal that renders the period recap as a 1080×1920 image (same canvas = preview + export source).
 * Artist photos come from Deezer's CORS-enabled CDN and the cover from the signed art URL; anything
 * that fails to load is drawn as a placeholder so the canvas is never tainted.
 */
export function RecapCard({ data, onClose }: { data: RecapData; onClose: () => void }): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imagesRef = useRef<RecapImages>({ artists: [], cover: null })
  const [version, setVersion] = useState(0)
  const [busy, setBusy] = useState(false)
  const [closing, setClosing] = useState(false)
  const toast = useUi((s) => s.toast)
  const reduced = prefersReducedMotion(useSettings((s) => s.motion))
  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

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

  useEffect(() => {
    let alive = true
    void Promise.all([
      Promise.all(data.artists.map((a) => loadCardImage(a.image ?? undefined))),
      loadCardImage(data.topTrack?.coverUrl ?? undefined)
    ]).then(([artists, cover]) => {
      if (!alive) return
      imagesRef.current = { artists, cover }
      setVersion((v) => v + 1)
    })
    return () => {
      alive = false
    }
  }, [data])

  const accent = (): [number, number, number] =>
    parseAccent(typeof document === 'undefined' ? null : getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb'))

  useEffect(() => {
    let alive = true
    void ensureCardFonts().then(() => {
      const canvas = canvasRef.current
      if (!alive || !canvas) return
      drawRecapCard(canvas, data, imagesRef.current, accent())
    })
    return () => {
      alive = false
    }
  }, [data, version])

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

  const fileName = `nocturne-recap-${data.periodLabel.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'stats'}.png`

  /** PNG blob; if the canvas was tainted, redraw with placeholders instead of images. */
  const currentBlob = async (): Promise<Blob | null> => {
    const canvas = canvasRef.current
    if (!canvas) return null
    let blob = await canvasToPngBlob(canvas)
    if (!blob) {
      await ensureCardFonts()
      drawRecapCard(canvas, data, { artists: [], cover: null }, accent())
      blob = await canvasToPngBlob(canvas)
    }
    return blob
  }

  const triggerDownload = (blob: Blob): void => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1500)
  }

  const run = async (share: boolean): Promise<void> => {
    setBusy(true)
    try {
      const blob = await currentBlob()
      if (!blob) {
        toast('Could not create the image.', 'error')
        return
      }
      if (share) {
        const file = new File([blob], fileName, { type: 'image/png' })
        const payload: ShareData = { files: [file], title: `My Nocturne ${data.periodLabel}` }
        if (typeof navigator.canShare === 'function' && navigator.canShare(payload)) {
          try {
            await navigator.share(payload)
            return
          } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') return
          }
        }
      }
      triggerDownload(blob)
    } catch {
      toast(share ? 'Could not share the image.' : 'Could not create the image.', 'error')
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div
      className={cx(
        'fixed inset-0 z-[120] flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4',
        !reduced && (closing ? 'overlay-fade-out' : 'overlay-fade')
      )}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Share recap as image"
        className={cx(
          'flex max-h-[94dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-line bg-ink-850 pb-[env(safe-area-inset-bottom)] shadow-2xl shadow-black/70 sm:max-w-md sm:rounded-2xl sm:pb-0',
          !reduced && (closing ? 'modal-pop-out' : 'modal-pop')
        )}
      >
        <div className="flex items-center justify-between gap-4 px-5 pt-5 pb-1">
          <h2 className="text-lg font-bold tracking-tight">Share recap</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={requestClose}
            className="-mt-1 -mr-2 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-fg-muted hover:bg-white/8 hover:text-fg"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-5 py-4">
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={`Recap card preview for ${data.periodLabel}`}
            className="h-auto max-h-[64vh] w-auto max-w-full rounded-xl shadow-lg shadow-black/50"
          />
        </div>
        <div className="flex gap-2 px-5 pt-1 pb-5">
          <button
            type="button"
            aria-label="Download image"
            disabled={busy}
            onClick={() => void run(false)}
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-full bg-white/10 px-4 py-3 text-sm font-semibold text-fg transition-colors hover:bg-white/14 disabled:pointer-events-none disabled:opacity-50"
          >
            <Download className="h-4 w-4" /> Download
          </button>
          {canNativeShare && (
            <button
              type="button"
              aria-label="Share image"
              disabled={busy}
              onClick={() => void run(true)}
              className="inline-flex flex-1 items-center justify-center gap-2 rounded-full bg-accent px-4 py-3 text-sm font-semibold text-ink-950 transition-transform active:scale-95 disabled:pointer-events-none disabled:opacity-50"
            >
              <Share2 className="h-4 w-4" /> Share
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
