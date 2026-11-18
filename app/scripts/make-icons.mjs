// Rasterizes resources/icon/icon.svg into the desktop icons (and exports renderPng,
// used by patch-android.mjs for the launcher icons).
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import pngToIco from 'png-to-ico'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const SVG_PATH = join(ROOT, 'resources/icon/icon.svg')
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

/** Renders an SVG string to a square PNG buffer of the given pixel size. */
export function renderPng(svg, size) {
  return new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' }).render().asPng()
}

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
