import { readFileSync, writeFileSync } from 'node:fs'

export interface Bounds {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

export const DEFAULT_BOUNDS: Bounds = { width: 1280, height: 820, maximized: false }

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** Reads saved window bounds, falling back to defaults on any problem. */
export function loadBounds(file: string): Bounds {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Bounds>
    if (!isNum(raw.width) || !isNum(raw.height)) return { ...DEFAULT_BOUNDS }
    return {
      x: isNum(raw.x) ? raw.x : undefined,
      y: isNum(raw.y) ? raw.y : undefined,
      width: Math.max(880, Math.min(raw.width, 10000)),
      height: Math.max(600, Math.min(raw.height, 10000)),
      maximized: raw.maximized === true
    }
  } catch {
    return { ...DEFAULT_BOUNDS }
  }
}

export function saveBounds(file: string, bounds: Bounds): void {
  try {
    writeFileSync(file, JSON.stringify(bounds))
  } catch {
    /* non-fatal */
  }
}
