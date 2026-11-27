import { canvasToPngBlob, ensureCardFonts } from './lyricCard'
import { platform, type ImageIntent, type ImageResult } from '../platform'
import { blobToBase64 } from '../platform/saveImage'
import { buildStoryPayload, renderSticker, type StoryColors } from './instagramStory'

/**
 * Renders the card canvas to PNG. If the canvas is tainted (a cross-origin image without CORS),
 * `redrawWithoutImages` repaints it with placeholders and we retry; throws when no PNG can be made.
 */
export async function cardBlob(canvas: HTMLCanvasElement, redrawWithoutImages: () => void): Promise<Blob> {
  let blob = await canvasToPngBlob(canvas)
  if (!blob) {
    await ensureCardFonts()
    redrawWithoutImages()
    blob = await canvasToPngBlob(canvas)
  }
  if (!blob) throw new Error('Could not render the card')
  return blob
}

export async function exportCard(
  canvas: HTMLCanvasElement,
  redrawWithoutImages: () => void,
  filename: string,
  intent: ImageIntent,
  meta: { title?: string; text?: string }
): Promise<ImageResult> {
  const blob = await cardBlob(canvas, redrawWithoutImages)
  return platform.saveOrShareImage(blob, filename, { intent, ...meta })
}

/**
 * Shares the card as an Instagram story sticker (native hand-off). When Instagram is not installed
 * (or the platform has no hand-off) it returns 'not-installed' / falls back to the normal share
 * sheet with the full card, so the user always gets something shareable.
 */
export async function exportStoryCard(
  canvas: HTMLCanvasElement,
  redrawWithoutImages: () => void,
  filename: string,
  appId: string,
  colors: StoryColors,
  meta: { title?: string; text?: string }
): Promise<'opened' | 'cancelled' | 'not-installed'> {
  const share = platform.shareInstagramStory
  if (!share) return 'not-installed'
  // Make sure the canvas is exportable (not tainted) before building the sticker from it.
  await cardBlob(canvas, redrawWithoutImages)
  const sticker = await renderSticker(canvas)
  const result = await share(buildStoryPayload(await blobToBase64(sticker), appId, colors))
  if (result === 'not-installed') await exportCard(canvas, redrawWithoutImages, filename, 'share', meta)
  return result
}
