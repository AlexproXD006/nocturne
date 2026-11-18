import { afterEach, describe, expect, it, vi } from 'vitest'

const writeFile = vi.fn(async () => ({ uri: 'file:///cache/cards/x.png' }))
const share = vi.fn(async () => ({}))
vi.mock('@capacitor/filesystem', () => ({ Filesystem: { writeFile }, Directory: { Cache: 'CACHE' } }))
vi.mock('@capacitor/share', () => ({ Share: { share } }))
vi.mock('@aparajita/capacitor-secure-storage', () => ({
  SecureStorage: { setKeyPrefix: vi.fn(async () => undefined), get: vi.fn(), set: vi.fn(), remove: vi.fn() }
}))

const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })

afterEach(() => {
  delete (globalThis as { Capacitor?: unknown }).Capacitor
  delete (window as { nocturne?: unknown }).nocturne
  vi.resetModules()
  vi.clearAllMocks()
})

describe('saveOrShareImage routing', () => {
  for (const os of ['android', 'ios'] as const) {
    it(`${os}: writes to cache and opens the native share sheet`, async () => {
      ;(globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true, getPlatform: () => os }
      const { detectPlatform } = await import('../../src/renderer/src/platform')
      const r = await detectPlatform().saveOrShareImage(blob, 'a.png', { intent: 'share', title: 'T' })
      expect(r).toBe('shared')
      expect(writeFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'cards/a.png', directory: 'CACHE', data: 'AQID' }))
      expect(share).toHaveBeenCalledWith(expect.objectContaining({ files: ['file:///cache/cards/x.png'] }))
      expect(await detectPlatform().saveOrShareImage(blob, 'a.png', { intent: 'save' })).toBe('saved')
    })
  }

  it('mobile: a dismissed share sheet is "cancelled", real errors propagate', async () => {
    ;(globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' }
    const { detectPlatform } = await import('../../src/renderer/src/platform')
    share.mockRejectedValueOnce(new Error('Share canceled'))
    await expect(detectPlatform().saveOrShareImage(blob, 'a.png', { intent: 'share' })).resolves.toBe('cancelled')
    share.mockRejectedValueOnce(new Error('boom'))
    await expect(detectPlatform().saveOrShareImage(blob, 'a.png', { intent: 'share' })).rejects.toThrow('boom')
  })

  it('desktop: save uses the dialog bridge, share copies to the clipboard', async () => {
    const image = { save: vi.fn(async () => true), copy: vi.fn(async () => true) }
    ;(window as unknown as { nocturne: unknown }).nocturne = {
      secure: {}, window: {}, app: { info: vi.fn(), openExternal: vi.fn() }, image
    }
    const { detectPlatform } = await import('../../src/renderer/src/platform')
    const p = detectPlatform()
    expect(p.kind).toBe('desktop')
    expect(await p.saveOrShareImage(blob, 'a.png', { intent: 'save' })).toBe('saved')
    expect(image.save).toHaveBeenCalledWith(expect.any(Uint8Array), 'a.png')
    image.save.mockResolvedValueOnce(false)
    expect(await p.saveOrShareImage(blob, 'a.png', { intent: 'save' })).toBe('cancelled')
    expect(await p.saveOrShareImage(blob, 'a.png', { intent: 'share' })).toBe('copied')
    expect(image.copy).toHaveBeenCalled()
  })

  it('web: Web Share with files when supported, else an <a download> in the DOM', async () => {
    const { detectPlatform } = await import('../../src/renderer/src/platform')
    const p = detectPlatform()
    const navShare = vi.fn(async () => undefined)
    Object.assign(navigator, { share: navShare, canShare: () => true })
    expect(await p.saveOrShareImage(blob, 'a.png', { intent: 'share' })).toBe('shared')
    expect(navShare).toHaveBeenCalled()

    Object.assign(navigator, { share: undefined, canShare: undefined })
    URL.createObjectURL = vi.fn(() => 'blob:x')
    URL.revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.isConnected).toBe(true)
      expect(this.download).toBe('a.png')
    })
    expect(await p.saveOrShareImage(blob, 'a.png', { intent: 'save' })).toBe('saved')
    expect(click).toHaveBeenCalled()
  })
})
