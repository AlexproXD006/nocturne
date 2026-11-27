import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Download, Loader2, Share2, X } from 'lucide-react'
import { useUi } from '../store/ui'
import { prefersReducedMotion, useSettings } from '../store/settings'
import { cx } from './common'
import { ensureCardFonts, loadCardImage } from '../lib/lyricCard'
import { exportCard } from '../lib/cardExport'
import type { ImageIntent } from '../platform'
import { drawRecapCard, parseAccent, type RecapImages } from '../lib/recapCard'
import { storyColorsFromAccent } from '../lib/instagramStory'
import { InstagramStoryButton } from './InstagramStoryButton'
import type { RecapData } from '../lib/stats'
import { useT } from '../i18n'

/**
 * Modal that renders the period recap as a 1080×1920 image (same canvas = preview + export source).
 * Artist photos come from Deezer's CORS-enabled CDN and the cover from the signed art URL; anything
 * that fails to load is drawn as a placeholder so the canvas is never tainted.
 */
export function RecapCard({ data, onClose }: { data: RecapData; onClose: () => void }): ReactNode {
  const tr = useT()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imagesRef = useRef<RecapImages>({ artists: [], cover: null })
  const [version, setVersion] = useState(0)
  const [busy, setBusy] = useState(false)
  const [closing, setClosing] = useState(false)
  const toast = useUi((s) => s.toast)
  const reduced = prefersReducedMotion(useSettings((s) => s.motion))

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

  const run = async (intent: ImageIntent): Promise<void> => {
    const canvas = canvasRef.current
    if (!canvas) return
    setBusy(true)
    try {
      const result = await exportCard(
        canvas,
        () => drawRecapCard(canvas, data, { artists: [], cover: null }, accent()),
        fileName,
        intent,
        { title: tr('card.recapShareTitle', { period: data.periodLabel }) }
      )
      if (result === 'saved') toast(tr('card.saved'))
      else if (result === 'copied') toast(tr('card.copied'))
    } catch {
      toast(intent === 'share' ? tr('card.shareFailed') : tr('card.imageFailed'), 'error')
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
        aria-label={tr('card.recapDialog')}
        className={cx(
          'g-pop g-sheet flex max-h-[94dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-line bg-ink-850 pb-[env(safe-area-inset-bottom)] shadow-2xl shadow-black/70 sm:max-w-md sm:rounded-2xl sm:pb-0',
          !reduced && (closing ? 'modal-pop-out' : 'modal-pop')
        )}
      >
        <div className="flex items-center justify-between gap-4 px-5 pt-5 pb-1">
          <h2 className="text-lg font-bold tracking-tight">{tr('card.recapTitle')}</h2>
          <button
            type="button"
            aria-label={tr('card.close')}
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
            aria-label={tr('card.recapPreview', { period: data.periodLabel })}
            className="h-auto max-h-[64vh] w-auto max-w-full rounded-xl shadow-lg shadow-black/50"
          />
        </div>
        <div className="flex gap-2 px-5 pt-1 pb-5">
          <button
            type="button"
            aria-label={tr('card.downloadLabel')}
            disabled={busy}
            onClick={() => void run('save')}
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-full bg-white/10 px-4 py-3 text-sm font-semibold text-fg transition-colors hover:bg-white/14 disabled:pointer-events-none disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} {tr('card.download')}
          </button>
          {(
            <button
              type="button"
              aria-label={tr('card.shareLabel')}
              disabled={busy}
              onClick={() => void run('share')}
              className="inline-flex flex-1 items-center justify-center gap-2 rounded-full bg-accent px-4 py-3 text-sm font-semibold text-ink-950 transition-transform active:scale-95 disabled:pointer-events-none disabled:opacity-50"
            >
              <Share2 className="h-4 w-4" /> {tr('card.share')}
            </button>
          )}
        </div>
        <div className="px-5 pb-5">
          <InstagramStoryButton
            canvas={() => canvasRef.current}
            redrawWithoutImages={() => canvasRef.current && drawRecapCard(canvasRef.current, data, { artists: [], cover: null }, accent())}
            filename={fileName}
            colors={() => storyColorsFromAccent(accent())}
            meta={{ title: tr('card.recapShareTitle', { period: data.periodLabel }) }}
            disabled={busy}
          />
        </div>
      </div>
    </div>,
    document.body
  )
}
