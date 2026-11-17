// Rasterizes src/renderer/public/icon.svg into the desktop icons (and exports helpers
// used by patch-android.mjs for the launcher icons).
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import pngToIco from 'png-to-ico'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const SVG_PATH = join(ROOT, 'src/renderer/public/icon.svg')
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

/** Renders an SVG string to a square PNG buffer of the given pixel size. */
export function renderPng(svg, size) {
  return new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' }).render().asPng()
}

/**
 * Android adaptive-icon foreground: the glyph without the rounded-square plate,
 * scaled into the 66% safe zone of a 108dp canvas.
 */
export function foregroundSvg(svg) {
  const inner = svg.replace(/<rect width="512" height="512"[^>]*\/>/, '')
  const body = inner.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
  // Glyph occupies roughly 100..400 of the 512 box; scale 0.78 around the centre.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><g transform="translate(256 256) scale(0.78) translate(-256 -256)">${body}</g></svg>`
}

/** Plain rounded-square plate colour used behind the adaptive foreground. */
export const ICON_BACKGROUND = '#0e0e12'

export async function makeIcons(outDir = join(ROOT, 'build')) {
  const svg = await readFile(SVG_PATH, 'utf8')
  await mkdir(outDir, { recursive: true })
  const written = []
  for (const size of [1024, 512]) {
    const file = join(outDir, size === 1024 ? 'icon.png' : 'icon-512.png')
    await writeFile(file, renderPng(svg, size))
    written.push(file)
  }
  const ico = await pngToIco(ICO_SIZES.map((s) => renderPng(svg, s)))
  const icoFile = join(outDir, 'icon.ico')
  await writeFile(icoFile, ico)
  written.push(icoFile)
  return written
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  makeIcons().then(
    (files) => files.forEach((f) => console.log('wrote', f)),
    (err) => {
      console.error(err)
      process.exit(1)
    }
  )
}
