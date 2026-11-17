import { afterEach, describe, expect, it, vi } from 'vitest'

// The native plugins only exist on-device: registerPlugin() hands back fakes by name.
const caps = vi.hoisted(() => {
  const updates = {
    configure: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
    notify: vi.fn(async () => ({ posted: true })),
    addListener: vi.fn(async () => ({ remove: async () => undefined }))
  }
  const media = { update: vi.fn(), clear: vi.fn(), addListener: vi.fn(async () => ({ remove: async () => undefined })) }
  return { updates, media, registerPlugin: vi.fn((name: string) => (name === 'NocturneUpdates' ? updates : media)) }
})
vi.mock('@capacitor/core', () => ({ registerPlugin: caps.registerPlugin }))
vi.mock('@aparajita/capacitor-secure-storage', () => ({
  SecureStorage: { setKeyPrefix: vi.fn(async () => undefined), get: vi.fn(), set: vi.fn(), remove: vi.fn() }
}))

async function load(): Promise<typeof import('@/platform')> {
  vi.resetModules()
  return import('@/platform')
}

afterEach(() => {
  delete (window as { nocturne?: unknown }).nocturne
  delete (globalThis as { Capacitor?: unknown }).Capacitor
})

describe('platform: update notifications wiring', () => {
  it('web has neither native updates nor a desktop notifier', async () => {
    const p = (await load()).detectPlatform()
    expect(p.kind).toBe('web')
    expect(p.nativeUpdates).toBeNull()
    expect(p.notifyUpdate).toBeNull()
  })

  it('android exposes the NocturneUpdates plugin', async () => {
    ;(globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' }
    const p = (await load()).detectPlatform()
    expect(p.kind).toBe('android')
    expect(p.notifyUpdate).toBeNull()
    await p.nativeUpdates!.configure('https://s.example', 'android')
    expect(caps.registerPlugin).toHaveBeenCalledWith('NocturneUpdates')
    expect(caps.updates.configure).toHaveBeenCalledWith({ serverUrl: 'https://s.example', channel: 'android' })
    await expect(p.nativeUpdates!.notify('9.9.9')).resolves.toBe(true)
  })

  it('desktop forwards to the bridge and tolerates an old preload / failures', async () => {
    const notifyUpdate = vi.fn(async () => true)
    const base = { secure: {}, window: {}, app: { info: vi.fn(), openExternal: vi.fn() } }
    ;(window as { nocturne?: unknown }).nocturne = { ...base, app: { ...base.app, notifyUpdate } }
    let p = (await load()).detectPlatform()
    expect(p.kind).toBe('desktop')
    expect(p.nativeUpdates).toBeNull()
    await expect(p.notifyUpdate!({ version: '2.0.0', url: 'https://s.example/dl' })).resolves.toBe(true)
    expect(notifyUpdate).toHaveBeenCalledWith({ version: '2.0.0', url: 'https://s.example/dl' })

    notifyUpdate.mockRejectedValueOnce(new Error('ipc'))
    await expect(p.notifyUpdate!({ version: '2.0.0', url: 'https://s.example/dl' })).resolves.toBe(false)

    ;(window as { nocturne?: unknown }).nocturne = base // preload without notifyUpdate
    p = (await load()).detectPlatform()
    await expect(p.notifyUpdate!({ version: '2.0.0', url: 'https://s.example/dl' })).resolves.toBe(false)
  })
})
