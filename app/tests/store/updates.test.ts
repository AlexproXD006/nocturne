import { beforeEach, describe, expect, it, vi } from 'vitest'

const svc = vi.hoisted(() => ({
  platform: { kind: 'desktop' as 'desktop' | 'android' | 'ios' | 'web', hostedOrigin: null as string | null },
  checkUpdate: vi.fn(),
  session: { session: { serverUrl: 'https://music.example.com' } as { serverUrl: string } | null, lastServerUrl: '' }
}))
vi.mock('@/services', () => ({
  platform: svc.platform,
  api: { checkUpdate: svc.checkUpdate },
  useSession: { getState: () => svc.session }
}))

import { targetPlatform, useUpdates } from '@/store/updates'

beforeEach(() => {
  svc.platform.kind = 'desktop'
  svc.platform.hostedOrigin = null
  svc.session = { session: { serverUrl: 'https://music.example.com' }, lastServerUrl: '' }
  svc.checkUpdate.mockReset()
  useUpdates.setState({ available: false, latest: null, downloadUrl: null, checking: false, checked: false })
})

describe('targetPlatform', () => {
  it('maps the build to its feed', () => {
    expect(targetPlatform('1.0.0')).toBe('desktop')
    svc.platform.kind = 'android'
    expect(targetPlatform('1.0.0')).toBe('android')
    expect(targetPlatform('1.0.1-beta.2')).toBe('android-beta')
    svc.platform.kind = 'ios'
    expect(targetPlatform('1.0.0')).toBe('ios')
    expect(targetPlatform('1.1.0-beta.1')).toBe('ios-beta')
    svc.platform.kind = 'web'
    expect(targetPlatform('1.0.0')).toBeNull()
    svc.platform.kind = 'desktop'
    svc.platform.hostedOrigin = 'https://x'
    expect(targetPlatform('1.0.0')).toBeNull()
  })
})

describe('useUpdates.check', () => {
  it('flags a newer version and builds the absolute download URL', async () => {
    svc.checkUpdate.mockResolvedValue({ version: '99.0.0', url: '/dl/app.exe' })
    await useUpdates.getState().check()
    const s = useUpdates.getState()
    expect(svc.checkUpdate).toHaveBeenCalledWith('desktop')
    expect(s.available).toBe(true)
    expect(s.downloadUrl).toBe('https://music.example.com/dl/app.exe')
    expect(s.checked).toBe(true)
    expect(s.checking).toBe(false)
  })

  it('falls back to the last server; no server means no download URL', async () => {
    svc.checkUpdate.mockResolvedValue({ version: '99.0.0', url: '/dl/app.exe' })
    svc.session = { session: null, lastServerUrl: 'https://last.example.com' }
    await useUpdates.getState().check()
    expect(useUpdates.getState().downloadUrl).toBe('https://last.example.com/dl/app.exe')
    svc.session = { session: null, lastServerUrl: '' }
    await useUpdates.getState().check()
    expect(useUpdates.getState().downloadUrl).toBeNull()
  })

  it('stays quiet on errors and does nothing on web', async () => {
    svc.checkUpdate.mockRejectedValue(new Error('offline'))
    await useUpdates.getState().check()
    expect(useUpdates.getState()).toMatchObject({ available: false, checked: true, checking: false })
    svc.platform.kind = 'web'
    svc.checkUpdate.mockClear()
    await useUpdates.getState().check()
    expect(svc.checkUpdate).not.toHaveBeenCalled()
  })

  it('autoCheck runs once', async () => {
    svc.checkUpdate.mockResolvedValue({ version: '0.0.0', url: '/dl' })
    useUpdates.getState().autoCheck()
    useUpdates.getState().autoCheck()
    await vi.waitFor(() => expect(useUpdates.getState().checked).toBe(true))
    useUpdates.getState().autoCheck()
    expect(svc.checkUpdate).toHaveBeenCalledTimes(1)
    expect(useUpdates.getState().available).toBe(false)
  })
})
