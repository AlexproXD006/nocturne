import { useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { platform } from '../platform'
import { useSession } from '../services'
import { useUi } from '../store/ui'
import { exportStoryCard } from '../lib/cardExport'
import { canShareToInstagramStory, instagramAppId, type StoryColors } from '../lib/instagramStory'
import { useT } from '../i18n'

/** Instagram camera glyph (lucide has no brand icons). */
export function InstagramGlyph({ className }: { className?: string }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.3" cy="6.7" r="0.6" fill="currentColor" />
    </svg>
  )
}

/** Hook: the App ID when this build + server can share to Instagram stories, else null (button hidden). */
export function useInstagramAppId(): string | null {
  const info = useSession((s) => s.server)
  return canShareToInstagramStory(platform.kind, info) ? instagramAppId(info) : null
}

export interface InstagramStoryButtonProps {
  canvas: () => HTMLCanvasElement | null
  redrawWithoutImages: () => void
  filename: string
  colors: () => StoryColors
  meta: { title?: string; text?: string }
  disabled?: boolean
  onBusy?: (busy: boolean) => void
}

/** "Historia de Instagram": renders nothing on desktop / web or when the server has no App ID. */
export function InstagramStoryButton(props: InstagramStoryButtonProps): ReactNode {
  const tr = useT()
  const appId = useInstagramAppId()
  const toast = useUi((s) => s.toast)
  const [busy, setBusy] = useState(false)
  if (!appId) return null

  const run = async (): Promise<void> => {
    const canvas = props.canvas()
    if (!canvas) return
    setBusy(true)
    props.onBusy?.(true)
    try {
      const r = await exportStoryCard(canvas, props.redrawWithoutImages, props.filename, appId, props.colors(), props.meta)
      if (r === 'not-installed') toast(tr('card.instagramMissing'))
    } catch {
      toast(tr('card.shareFailed'), 'error')
    } finally {
      setBusy(false)
      props.onBusy?.(false)
    }
  }

  return (
    <button
      type="button"
      aria-label={tr('card.instagramLabel')}
      disabled={busy || props.disabled}
      onClick={() => void run()}
      className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-white/10 px-4 py-3 text-sm font-semibold text-fg transition-colors hover:bg-white/14 disabled:pointer-events-none disabled:opacity-50"
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <InstagramGlyph className="h-4 w-4" />} {tr('card.instagram')}
    </button>
  )
}
