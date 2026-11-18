/**
 * Exporting a rendered PNG (recap / lyric card) differs per platform:
 *  - Capacitor (Android/iOS): `<a download>` and `navigator.share({files})` do nothing in the WebView,
 *    so write the file to the cache dir and open the native share sheet (which also offers
 *    "Save to gallery" / "Save image").
 *  - Electron: native save dialog / clipboard through the preload bridge.
 *  - Web: Web Share with files when supported, else a real `<a download>` appended to the DOM.
 */
import type { NocturneBridge } from '../../../shared/ipc'

export type ImageIntent = 'share' | 'save'
export type ImageResult = 'shared' | 'saved' | 'copied' | 'cancelled'

export interface ImageOptions {
  intent: ImageIntent
  title?: string
  text?: string
}

export type SaveOrShareImage = (blob: Blob, filename: string, opts: ImageOptions) => Promise<ImageResult>

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onerror = () => reject(r.error ?? new Error('read failed'))
    r.onload = () => {
      const s = String(r.result)
      const i = s.indexOf(',')
      resolve(i >= 0 ? s.slice(i + 1) : s)
    }
    r.readAsDataURL(blob)
  })
}

function isCancel(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null
  return e?.name === 'AbortError' || /cancel/i.test(e?.message ?? '')
}

/** Capacitor Filesystem + Share. Plugins are loaded lazily and never returned from a Promise directly. */
export function capacitorSaveOrShare(): SaveOrShareImage {
  return async (blob, filename, opts) => {
    const [{ Filesystem, Directory }, { Share }] = await Promise.all([import('@capacitor/filesystem'), import('@capacitor/share')])
    const path = `cards/${filename}`
    const data = await blobToBase64(blob)
    const written = await Filesystem.writeFile({ path, data, directory: Directory.Cache, recursive: true })
    try {
      await Share.share({
        title: opts.title,
        text: opts.text,
        files: [written.uri],
        dialogTitle: opts.title
      })
      return opts.intent === 'save' ? 'saved' : 'shared'
    } catch (err) {
      if (isCancel(err)) return 'cancelled'
      throw err
    }
  }
}

export function desktopSaveOrShare(bridge: NocturneBridge): SaveOrShareImage {
  return async (blob, filename, opts) => {
    if (!bridge.image) return webSaveOrShare()(blob, filename, opts)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    if (opts.intent === 'share') {
      await bridge.image.copy(bytes)
      return 'copied'
    }
    return (await bridge.image.save(bytes, filename)) ? 'saved' : 'cancelled'
  }
}

export function webSaveOrShare(): SaveOrShareImage {
  return async (blob, filename, opts) => {
    if (opts.intent === 'share' && typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      const file = new File([blob], filename, { type: 'image/png' })
      const data: ShareData = { files: [file], title: opts.title, text: opts.text }
      if (typeof navigator.canShare === 'function' && navigator.canShare(data)) {
        try {
          await navigator.share(data)
          return 'shared'
        } catch (err) {
          if (isCancel(err)) return 'cancelled'
          // fall through to a download
        }
      }
    }
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    setTimeout(() => {
      a.remove()
      URL.revokeObjectURL(url)
    }, 4000)
    return 'saved'
  }
}
