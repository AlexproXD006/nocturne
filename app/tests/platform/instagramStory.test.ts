import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInstagramStoryShare } from '../../src/renderer/src/platform/instagramStory'

const payload = { imageBase64: 'AQID', appId: '1234567890', top: '#112233', bottom: '#000000' }

describe('createInstagramStoryShare', () => {
  it('forwards the payload to the native plugin', async () => {
    const shareToInstagramStory = vi.fn(async () => ({ opened: true, installed: true }))
    const r = await createInstagramStoryShare(Promise.resolve({ plugin: { shareToInstagramStory } }))(payload)
    expect(r).toBe('opened')
    expect(shareToInstagramStory).toHaveBeenCalledWith({ imageBase64: 'AQID', appId: '1234567890', topColor: '#112233', bottomColor: '#000000' })
  })
  it('reports a missing Instagram', async () => {
    const plugin = { shareToInstagramStory: vi.fn(async () => ({ opened: false, installed: false })) }
    expect(await createInstagramStoryShare(Promise.resolve({ plugin }))(payload)).toBe('not-installed')
  })
  it('maps cancel and rethrows other errors', async () => {
    const cancel = { shareToInstagramStory: vi.fn(async () => { throw new Error('User cancelled') }) }
    expect(await createInstagramStoryShare(Promise.resolve({ plugin: cancel }))(payload)).toBe('cancelled')
    const boom = { shareToInstagramStory: vi.fn(async () => { throw new Error('boom') }) }
    await expect(createInstagramStoryShare(Promise.resolve({ plugin: boom }))(payload)).rejects.toThrow('boom')
  })
})

describe('platform wiring', () => {
  afterEach(() => {
    delete (globalThis as { Capacitor?: unknown }).Capacitor
    vi.resetModules()
  })
  it.each(['android', 'ios'] as const)('%s exposes shareInstagramStory', async (os) => {
    ;(globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true, getPlatform: () => os }
    vi.doMock('@aparajita/capacitor-secure-storage', () => ({ SecureStorage: { setKeyPrefix: vi.fn() } }))
    const { detectPlatform } = await import('../../src/renderer/src/platform')
    expect(typeof detectPlatform().shareInstagramStory).toBe('function')
  })
  it('web has none', async () => {
    const { detectPlatform } = await import('../../src/renderer/src/platform')
    expect(detectPlatform().shareInstagramStory ?? null).toBeNull()
  })
})
