import { describe, expect, it, vi } from 'vitest'
import { cardBlob } from '@/lib/cardExport'

function canvasWith(results: Array<Blob | 'throw'>): HTMLCanvasElement {
  let i = 0
  return {
    toBlob(cb: (b: Blob | null) => void) {
      const r = results[i++]
      if (r === 'throw') throw new DOMException('tainted', 'SecurityError')
      cb(r ?? null)
    }
  } as unknown as HTMLCanvasElement
}

describe('cardBlob', () => {
  it('returns the blob directly when the canvas is clean', async () => {
    const b = new Blob(['x'])
    const redraw = vi.fn()
    expect(await cardBlob(canvasWith([b]), redraw)).toBe(b)
    expect(redraw).not.toHaveBeenCalled()
  })
  it('redraws with placeholders when the canvas is tainted', async () => {
    const b = new Blob(['x'])
    const redraw = vi.fn()
    expect(await cardBlob(canvasWith(['throw', b]), redraw)).toBe(b)
    expect(redraw).toHaveBeenCalledOnce()
  })
  it('throws (so the UI toasts) when even the fallback fails', async () => {
    await expect(cardBlob(canvasWith(['throw', 'throw']), vi.fn())).rejects.toThrow()
  })
})
