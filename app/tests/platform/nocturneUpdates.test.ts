import { describe, expect, it, vi } from 'vitest'
import { createNativeUpdates, type NocturneUpdatesPlugin } from '@/platform/nocturneUpdates'

function fakePlugin(over: Partial<Record<keyof NocturneUpdatesPlugin, unknown>> = {}) {
  let handler: ((e: { version?: string }) => void) | null = null
  const plugin = {
    configure: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
    notify: vi.fn(async () => ({ posted: true })),
    addListener: vi.fn(async (_e: string, fn: (e: { version?: string }) => void) => {
      handler = fn
      return { remove: async () => undefined }
    }),
    ...over
  }
  return { plugin: plugin as unknown as NocturneUpdatesPlugin, raw: plugin, fire: (e: unknown) => handler?.(e as { version?: string }) }
}

describe('createNativeUpdates', () => {
  it('forwards configure / clear / notify to the plugin', async () => {
    const f = fakePlugin()
    const u = createNativeUpdates(Promise.resolve({ plugin: f.plugin }))
    await u.configure('https://music.example.com', 'android-beta')
    expect(f.raw.configure).toHaveBeenCalledWith({ serverUrl: 'https://music.example.com', channel: 'android-beta' })
    await u.clear()
    expect(f.raw.clear).toHaveBeenCalled()
    await expect(u.notify('1.2.3')).resolves.toBe(true)
    expect(f.raw.notify).toHaveBeenCalledWith({ version: '1.2.3' })
  })

  it('never throws: rejected calls, missing results and a failed plugin load are swallowed', async () => {
    const boom = vi.fn(async () => {
      throw new Error('not implemented')
    })
    const f = fakePlugin({ configure: boom, clear: boom, notify: boom, addListener: boom })
    const u = createNativeUpdates(Promise.resolve({ plugin: f.plugin }))
    await expect(u.configure('https://x', 'android')).resolves.toBeUndefined()
    await expect(u.clear()).resolves.toBeUndefined()
    await expect(u.notify('1.0.0')).resolves.toBe(false)
    expect(() => u.onTapped(() => undefined)).not.toThrow()

    const g = fakePlugin({ notify: vi.fn(async () => undefined) })
    await expect(createNativeUpdates(Promise.resolve({ plugin: g.plugin })).notify('1.0.0')).resolves.toBe(false)

    const broken = createNativeUpdates(Promise.reject(new Error('no plugin')))
    await expect(broken.configure('https://x', 'android')).resolves.toBeUndefined()
    await expect(broken.clear()).resolves.toBeUndefined()
    await expect(broken.notify('1.0.0')).resolves.toBe(false)
    expect(() => broken.onTapped(() => undefined)).not.toThrow()
  })

  it('delivers notification taps to listeners (subscribing once) and stops after unsubscribe', async () => {
    const f = fakePlugin()
    const u = createNativeUpdates(Promise.resolve({ plugin: f.plugin }))
    const a = vi.fn()
    const b = vi.fn(() => {
      throw new Error('listener bug')
    })
    const offA = u.onTapped(a)
    u.onTapped(b)
    await vi.waitFor(() => expect(f.raw.addListener).toHaveBeenCalledTimes(1))
    expect(f.raw.addListener).toHaveBeenCalledWith('updateTapped', expect.any(Function))
    f.fire({ version: '2.0.0' })
    expect(a).toHaveBeenCalledWith('2.0.0')
    expect(b).toHaveBeenCalledWith('2.0.0')
    f.fire({ version: '' })
    f.fire(null)
    expect(a).toHaveBeenLastCalledWith(null)
    offA()
    f.fire({ version: '2.0.1' })
    expect(a).toHaveBeenCalledTimes(3)
  })

  it('replays a tap that arrived while nobody listened', async () => {
    const f = fakePlugin()
    const u = createNativeUpdates(Promise.resolve({ plugin: f.plugin }))
    const off = u.onTapped(() => undefined)
    await vi.waitFor(() => expect(f.raw.addListener).toHaveBeenCalled())
    off()
    f.fire({ version: '3.0.0' })
    const late = vi.fn(() => {
      throw new Error('ignored')
    })
    expect(() => u.onTapped(late)).not.toThrow()
    expect(late).toHaveBeenCalledWith('3.0.0')
    const later = vi.fn()
    u.onTapped(later)
    expect(later).not.toHaveBeenCalled()
  })
})
