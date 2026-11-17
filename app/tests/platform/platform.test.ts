import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The native plugins only exist on-device; the web proxies throw "not implemented" when awaited.
vi.mock('@aparajita/capacitor-secure-storage', () => ({
  SecureStorage: { setKeyPrefix: vi.fn(async () => undefined), get: vi.fn(), set: vi.fn(), remove: vi.fn() }
}))
// The app-local NocturneMedia plugin (Media3 session) is reached through registerPlugin().
const media = vi.hoisted(() => {
  let handler: ((e: unknown) => void) | null = null
  return {
    plugin: {
      update: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      addListener: vi.fn(async (_event: string, fn: (e: unknown) => void) => {
        handler = fn
        return { remove: async () => undefined }
      })
    },
    registerPlugin: vi.fn(),
    fire: (e: unknown) => handler?.(e)
  }
})
vi.mock('@capacitor/core', () => ({
  registerPlugin: media.registerPlugin.mockImplementation(() => media.plugin)
}))

type PlatformModule = typeof import('@/platform')

async function load(): Promise<PlatformModule> {
  vi.resetModules()
  return import('@/platform')
}

function setCapacitor(android: boolean): void {
  ;(globalThis as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => android,
    getPlatform: () => (android ? 'android' : 'web')
  }
}

function fakeBridge(over: { secureStorage?: boolean; rejectInfo?: boolean } = {}) {
  const secureStore = new Map<string, string>()
  return {
    secure: {
      get: vi.fn(async (k: string) => secureStore.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => void secureStore.set(k, v)),
      delete: vi.fn(async (k: string) => void secureStore.delete(k))
    },
    app: {
      info: vi.fn(() => (over.rejectInfo ? Promise.reject(new Error('x')) : Promise.resolve({ secureStorage: over.secureStorage ?? true }))),
      openExternal: vi.fn(async () => undefined)
    },
    window: { minimize: vi.fn() }
  }
}

beforeEach(() => {
  vi.unstubAllEnvs()
})
afterEach(() => {
  vi.unstubAllEnvs()
  delete (window as { nocturne?: unknown }).nocturne
  delete (globalThis as { Capacitor?: unknown }).Capacitor
})

describe('detectPlatform: web', () => {
  it('plain dev web has no hosted origin and keeps the sessionStorage fallback', async () => {
    vi.stubEnv('VITE_HOSTED', '')
    const { detectPlatform } = await load()
    const p = detectPlatform()
    expect(p.kind).toBe('web')
    expect(p.hostedOrigin).toBeNull()
    expect(p.window).toBeNull()
    expect(p.nativeNowPlaying).toBeNull()
    await expect(p.secureAtRest()).resolves.toBe(false)
  })

  it('VITE_HOSTED values other than "true" are not hosted', async () => {
    for (const v of ['false', '1', 'TRUE', 'yes']) {
      vi.stubEnv('VITE_HOSTED', v)
      expect((await load()).detectPlatform().hostedOrigin).toBeNull()
    }
  })

  it('hosted web uses location.origin and persists no secrets anywhere', async () => {
    vi.stubEnv('VITE_HOSTED', 'true')
    const { detectPlatform } = await load()
    const p = detectPlatform()
    expect(p.kind).toBe('web')
    expect(p.hostedOrigin).toBe(window.location.origin)
    await p.secure.set('session', 'SECRET')
    await expect(p.secure.get('session')).resolves.toBeNull()
    await expect(p.secure.delete('session')).resolves.toBeUndefined()
    expect(sessionStorage.length).toBe(0)
    expect(localStorage.length).toBe(0)
    await expect(p.secureAtRest()).resolves.toBe(false)
  })

  it('the module-level `platform` export matches detection at import time', async () => {
    vi.stubEnv('VITE_HOSTED', 'true')
    expect((await load()).platform.hostedOrigin).toBe(window.location.origin)
    vi.stubEnv('VITE_HOSTED', '')
    expect((await load()).platform.hostedOrigin).toBeNull()
  })

  it('sessionStorage fallback stores under a prefix, reads back and deletes', async () => {
    vi.stubEnv('VITE_HOSTED', '')
    const p = (await load()).detectPlatform()
    await p.secure.set('session', 'abc')
    expect(sessionStorage.getItem('nocturne.secure.session')).toBe('abc')
    await expect(p.secure.get('session')).resolves.toBe('abc')
    await expect(p.secure.get('missing')).resolves.toBeNull()
    await p.secure.delete('session')
    expect(sessionStorage.getItem('nocturne.secure.session')).toBeNull()
    await expect(p.secure.get('session')).resolves.toBeNull()
  })

  it('sessionStorage fallback returns null when storage throws', async () => {
    vi.stubEnv('VITE_HOSTED', '')
    const p = (await load()).detectPlatform()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    await expect(p.secure.get('session')).resolves.toBeNull()
  })

  it('openExternal opens a noopener window', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const p = (await load()).detectPlatform()
    await p.openExternal('https://example.com')
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer')
  })
})

describe('detectPlatform: desktop bridge', () => {
  it('prefers window.nocturne, wiring secure storage, window and externals; hostedOrigin is null', async () => {
    vi.stubEnv('VITE_HOSTED', 'true') // desktop must win even if the flag leaks in
    const bridge = fakeBridge()
    ;(window as { nocturne?: unknown }).nocturne = bridge
    const p = (await load()).detectPlatform()
    expect(p.kind).toBe('desktop')
    expect(p.hostedOrigin).toBeNull()
    expect(p.secure).toBe(bridge.secure)
    expect(p.window).toBe(bridge.window)
    expect(p.nativeNowPlaying).toBeNull()
    await p.openExternal('https://example.com')
    expect(bridge.app.openExternal).toHaveBeenCalledWith('https://example.com')
  })

  it('reports secure-at-rest from the main process once and caches it', async () => {
    const bridge = fakeBridge({ secureStorage: true })
    ;(window as { nocturne?: unknown }).nocturne = bridge
    const p = (await load()).detectPlatform()
    await expect(p.secureAtRest()).resolves.toBe(true)
    await expect(p.secureAtRest()).resolves.toBe(true)
    expect(bridge.app.info).toHaveBeenCalledTimes(1)
  })

  it('falls back to false when app.info fails', async () => {
    ;(window as { nocturne?: unknown }).nocturne = fakeBridge({ rejectInfo: true })
    await expect((await load()).detectPlatform().secureAtRest()).resolves.toBe(false)
  })
})

describe('detectPlatform: android', () => {
  it('detects Capacitor android with a null hostedOrigin', async () => {
    setCapacitor(true)
    const p = (await load()).detectPlatform()
    expect(p.kind).toBe('android')
    expect(p.hostedOrigin).toBeNull()
    expect(p.window).toBeNull()
    expect(p.nativeNowPlaying).not.toBeNull()
    await expect(p.secureAtRest()).resolves.toBe(true)
  })

  it('drives the NocturneMedia plugin: extended info out, new commands in', async () => {
    setCapacitor(true)
    const p = (await load()).detectPlatform()
    const np = p.nativeNowPlaying!
    const got: unknown[] = []
    const off = np.onCommand((c) => got.push(c))
    np.update({
      id: 'q1',
      title: 'Song',
      artist: 'Artist',
      album: 'Album',
      artworkUrl: 'https://img.example.com/a.jpg',
      duration: 200,
      position: 10,
      playing: true,
      hasPrev: true,
      hasNext: true,
      liked: true,
      shuffle: false,
      repeat: 'all'
    })
    await vi.waitFor(() => expect(media.plugin.update).toHaveBeenCalled())
    expect(media.registerPlugin).toHaveBeenCalledWith('NocturneMedia')
    expect(media.plugin.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'Song', liked: true, shuffle: false, repeat: 'all', position: 10, duration: 200 })
    )
    await vi.waitFor(() => expect(media.plugin.addListener).toHaveBeenCalledWith('command', expect.any(Function)))
    media.fire({ kind: 'like' })
    media.fire({ kind: 'shuffle' })
    media.fire({ kind: 'repeat' })
    media.fire({ kind: 'seekTo', position: 42 })
    media.fire({ kind: 'next' })
    expect(got).toEqual(['like', 'shuffle', 'repeat', { seekTo: 42 }, 'next'])
    off()
    np.clear()
    await vi.waitFor(() => expect(media.plugin.clear).toHaveBeenCalled())
  })

  it('a non-native Capacitor (browser) is plain web', async () => {
    setCapacitor(false)
    expect((await load()).detectPlatform().kind).toBe('web')
  })

  it('opens external links in a noopener window', async () => {
    setCapacitor(true)
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    await (await load()).detectPlatform().openExternal('https://example.com/x')
    expect(open).toHaveBeenCalledWith('https://example.com/x', '_blank', 'noopener,noreferrer')
  })
})
