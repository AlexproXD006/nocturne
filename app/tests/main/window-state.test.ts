// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_BOUNDS, loadBounds, saveBounds } from '../../src/main/window-state'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nocturne-ws-'))
  file = join(dir, 'window.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('loadBounds', () => {
  it('returns defaults when the file does not exist', () => {
    expect(loadBounds(file)).toEqual(DEFAULT_BOUNDS)
  })

  it('returns a fresh copy of the defaults (callers may mutate it)', () => {
    const a = loadBounds(file)
    a.width = 1
    expect(loadBounds(file)).toEqual(DEFAULT_BOUNDS)
    expect(DEFAULT_BOUNDS.width).toBe(1280)
  })

  it.each([
    ['invalid json', '{nope'],
    ['empty file', ''],
    ['json null', 'null'],
    ['array', '[]'],
    ['missing width', JSON.stringify({ height: 700 })],
    ['missing height', JSON.stringify({ width: 1000 })],
    ['string size', JSON.stringify({ width: '1000', height: 700 })],
    ['null size', JSON.stringify({ width: null, height: null })]
  ])('falls back to defaults on %s', (_n, content) => {
    writeFileSync(file, content)
    expect(loadBounds(file)).toEqual(DEFAULT_BOUNDS)
  })

  it('reads valid bounds, including position and maximized', () => {
    writeFileSync(file, JSON.stringify({ x: 10, y: -20, width: 1400, height: 900, maximized: true }))
    expect(loadBounds(file)).toEqual({ x: 10, y: -20, width: 1400, height: 900, maximized: true })
  })

  it('leaves position undefined when it is missing or not a finite number', () => {
    writeFileSync(file, JSON.stringify({ x: 'a', y: null, width: 1000, height: 700 }))
    expect(loadBounds(file)).toEqual({ x: undefined, y: undefined, width: 1000, height: 700, maximized: false })
    writeFileSync(file, JSON.stringify({ width: 1000, height: 700 }))
    const b = loadBounds(file)
    expect(b.x).toBeUndefined()
    expect(b.y).toBeUndefined()
  })

  it('clamps sizes to sane minimum and maximum values', () => {
    writeFileSync(file, JSON.stringify({ width: 10, height: 10 }))
    expect(loadBounds(file)).toMatchObject({ width: 880, height: 600 })
    writeFileSync(file, JSON.stringify({ width: 99999, height: 50000 }))
    expect(loadBounds(file)).toMatchObject({ width: 10000, height: 10000 })
    writeFileSync(file, JSON.stringify({ width: 880, height: 600 }))
    expect(loadBounds(file)).toMatchObject({ width: 880, height: 600 })
  })

  it('treats only literal true as maximized', () => {
    writeFileSync(file, JSON.stringify({ width: 1000, height: 700, maximized: 'true' }))
    expect(loadBounds(file).maximized).toBe(false)
    writeFileSync(file, JSON.stringify({ width: 1000, height: 700, maximized: 1 }))
    expect(loadBounds(file).maximized).toBe(false)
  })

  it('falls back to defaults when the path is a directory', () => {
    expect(loadBounds(dir)).toEqual(DEFAULT_BOUNDS)
  })
})

describe('saveBounds', () => {
  it('writes JSON that loadBounds reads back', () => {
    saveBounds(file, { x: 5, y: 6, width: 1111, height: 777, maximized: true })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ x: 5, y: 6, width: 1111, height: 777, maximized: true })
    expect(loadBounds(file)).toEqual({ x: 5, y: 6, width: 1111, height: 777, maximized: true })
  })

  it('omits undefined position', () => {
    saveBounds(file, { width: 1000, height: 700, maximized: false })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ width: 1000, height: 700, maximized: false })
  })

  it('overwrites previous content', () => {
    saveBounds(file, { width: 1000, height: 700, maximized: false })
    saveBounds(file, { width: 1200, height: 800, maximized: true })
    expect(loadBounds(file)).toMatchObject({ width: 1200, height: 800, maximized: true })
  })

  it('never throws when the target is unwritable', () => {
    expect(() => saveBounds(join(dir, 'missing', 'dir', 'w.json'), DEFAULT_BOUNDS)).not.toThrow()
    mkdirSync(join(dir, 'isdir'))
    expect(() => saveBounds(join(dir, 'isdir'), DEFAULT_BOUNDS)).not.toThrow()
  })
})
