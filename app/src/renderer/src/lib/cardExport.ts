import { canvasToPngBlob, ensureCardFonts } from './lyricCard'
import { platform, type ImageIntent, type ImageResult } from '../platform'

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
