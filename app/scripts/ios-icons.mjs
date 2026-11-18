// Generates the iOS app icon and launch images from ONE source PNG (default build/icon.png, 1024x1024).
// No extra dependencies: the PNG is embedded in an SVG and rasterized with @resvg/resvg-js.
//   node scripts/ios-icons.mjs [path/to/icon-1024.png]
// To swap the icon: replace build/icon.png (or pass another file) and re-run `npm run ios:icons`.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
import { Resvg } from '@resvg/resvg-js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS = join(ROOT, 'ios/App/App/Assets.xcassets')
export const BACKGROUND = '#08080b'
/** Plate colour behind transparent corners of the source icon (iOS applies its own mask). */
export const ICON_PLATE = '#0e0e12'

function embed(png) {
  return `data:image/png;base64,${png.toString('base64')}`
}

/** Encodes RGBA pixels as an alpha-free 8-bit RGB PNG (App Store icons must not have an alpha channel). */
export function encodeRgbPng(rgba, width, height) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      raw[row + 1 + x * 3] = rgba[i]
      raw[row + 2 + x * 3] = rgba[i + 1]
      raw[row + 3 + x * 3] = rgba[i + 2]
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function rasterize(svg, size, bg = BACKGROUND) {
  const img = new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: bg }).render()
  return encodeRgbPng(img.pixels, img.width, img.height)
}

/** Opaque 1024x1024 icon (iOS rejects alpha in the marketing icon and masks the corners itself). */
export function renderIcon(png, size = 1024) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<rect width="${size}" height="${size}" fill="${ICON_PLATE}"/>
<image href="${embed(png)}" x="0" y="0" width="${size}" height="${size}"/></svg>`
  return rasterize(svg, size, ICON_PLATE)
}

/** Dark launch image with the icon centred at ~22% of the short side. */
export function renderSplash(png, size = 2732) {
  const icon = Math.round(size * 0.22)
  const o = Math.round((size - icon) / 2)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<rect width="${size}" height="${size}" fill="${BACKGROUND}"/>
<image href="${embed(png)}" x="${o}" y="${o}" width="${icon}" height="${icon}"/></svg>`
  return rasterize(svg, size)
}

export function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG file')
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

export async function makeIosIcons(src = join(ROOT, 'build/icon.png')) {
  const png = await readFile(src)
  const { width, height } = pngSize(png)
  if (width !== height || width < 1024) throw new Error(`${src} must be a square PNG of at least 1024x1024 (got ${width}x${height})`)
  const icons = join(ASSETS, 'AppIcon.appiconset')
  const splash = join(ASSETS, 'Splash.imageset')
  await mkdir(icons, { recursive: true })
  await mkdir(splash, { recursive: true })
  const written = [join(icons, 'AppIcon-512@2x.png')]
  await writeFile(written[0], renderIcon(png))
  const s = renderSplash(png)
  for (const n of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
    await writeFile(join(splash, n), s)
    written.push(join(splash, n))
  }
  return written
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const f of await makeIosIcons(process.argv[2] ? resolve(process.argv[2]) : undefined)) console.log('wrote', f)
}
