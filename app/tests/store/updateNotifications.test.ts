import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import {
  NOTIFIED_KEY,
  createUpdateNotifications,
  markNotified,
  readNotified,
  useUpdateReveal,
  type UpdateNotificationDeps
} from '@/store/updateNotifications'
import type { NativeUpdates } from '@/platform'

type Session = ReturnType<UpdateNotificationDeps['session']['getState']>
type Updates = ReturnType<UpdateNotificationDeps['updates']['getState']>

function stores() {
  const session = createStore<Session>(() => ({ status: 'restoring', session: null, lastServerUrl: '' }))
  const check = vi.fn(async () => undefined)
  const updates = createStore<Updates>(() => ({ available: false, latest: null, downloadUrl: null, checked: false, check }))
  return { session, updates, check }
}

function fakeNative() {
  let tap: ((v: string | null) => void) | null = null
  const n = {
    configure: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
    notify: vi.fn(async () => true),
    onTapped: vi.fn((fn: (v: string | null) => void) => {
      tap = fn
      return () => {
        tap = null
      }
    })
  }
  return { native: n as NativeUpdates, raw: n, tap: (v: string | null) => tap?.(v) }
}

const signedIn = (serverUrl = 'https://music.example.com'): Partial<Session> => ({
  status: 'signedIn',
  session: { serverUrl },
  lastServerUrl: serverUrl
})
const found = (version: string, downloadUrl: string | null = `https://music.example.com/dl/${version}`): Partial<Updates> => ({
  available: true,
  latest: { version },
  downloadUrl,
  checked: true
})

beforeEach(() => {
  useUpdateReveal.setState({ version: null })
})

describe('desktop dedupe store', () => {
  it('marks a version once', () => {
    expect(readNotified()).toBe('')
    expect(markNotified('1.0.0')).toBe(true)
    expect(localStorage.getItem(NOTIFIED_KEY)).toBe('"1.0.0"')
    expect(markNotified('1.0.0')).toBe(false)
    expect(markNotified('')).toBe(false)
    expect(markNotified('1.0.1')).toBe(true)
  })

  it('survives broken storage (notifies, never throws)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(readNotified()).toBe('')
    expect(markNotified('1.0.0')).toBe(true)
  })
})

describe('createUpdateNotifications', () => {
  it('web and hosted: does nothing', () => {
    const s = stores()
    const notifyUpdate = vi.fn(async () => true)
    for (const platform of [
      { kind: 'web' as const, hostedOrigin: null, nativeUpdates: null, notifyUpdate },
      { kind: 'desktop' as const, hostedOrigin: 'https://x', nativeUpdates: null, notifyUpdate }
    ]) {
      const stop = createUpdateNotifications({ platform, session: s.session, updates: s.updates, channel: () => 'desktop' })
      s.updates.setState(found('9.0.0'))
      stop()
    }
    expect(notifyUpdate).not.toHaveBeenCalled()
  })

  it('desktop: notifies once per version (persisted), with the download URL', async () => {
    const s = stores()
    const notifyUpdate = vi.fn(async () => true)
    const deps = {
      platform: { kind: 'desktop' as const, hostedOrigin: null, nativeUpdates: null, notifyUpdate },
      session: s.session,
      updates: s.updates,
      channel: () => 'desktop'
    }
    const stop = createUpdateNotifications(deps)
    s.session.setState(signedIn())
    s.updates.setState(found('2.0.0', null)) // no download URL yet: wait
    expect(notifyUpdate).not.toHaveBeenCalled()
    s.updates.setState(found('2.0.0'))
    s.updates.setState({ checking: true } as Partial<Updates>)
    s.updates.setState(found('2.0.0'))
    expect(notifyUpdate).toHaveBeenCalledTimes(1)
    expect(notifyUpdate).toHaveBeenCalledWith({ version: '2.0.0', url: 'https://music.example.com/dl/2.0.0' })
    expect(readNotified()).toBe('2.0.0')
    stop()

    // App restart: same version is not notified again; a newer one is.
    const s2 = stores()
    s2.updates.setState(found('2.0.0'))
    const stop2 = createUpdateNotifications({ ...deps, session: s2.session, updates: s2.updates })
    expect(notifyUpdate).toHaveBeenCalledTimes(1)
    s2.updates.setState(found('2.1.0'))
    expect(notifyUpdate).toHaveBeenCalledTimes(2)
    stop2()
    s2.updates.setState(found('2.2.0'))
    expect(notifyUpdate).toHaveBeenCalledTimes(2)
  })

  it('desktop: no notifier (old preload) or a rejected notifier never throws', async () => {
    const s = stores()
    const notifyUpdate = vi.fn(async () => {
      throw new Error('ipc')
    })
    createUpdateNotifications({
      platform: { kind: 'desktop', hostedOrigin: null, nativeUpdates: null, notifyUpdate },
      session: s.session,
      updates: s.updates,
      channel: () => 'desktop'
    })
    expect(() => s.updates.setState(found('3.0.0'))).not.toThrow()
    const t = stores()
    createUpdateNotifications({
      platform: { kind: 'desktop', hostedOrigin: null },
      session: t.session,
      updates: t.updates,
      channel: () => 'desktop'
    })
    expect(() => t.updates.setState(found('3.0.1'))).not.toThrow()
  })

  it('android: configures on sign-in, clears on sign-out, re-configures on server/channel change', () => {
    const s = stores()
    const n = fakeNative()
    let channel: string | null = 'android'
    createUpdateNotifications({
      platform: { kind: 'android', hostedOrigin: null, nativeUpdates: n.native, notifyUpdate: null },
      session: s.session,
      updates: s.updates,
      channel: () => channel
    })
    expect(n.raw.configure).not.toHaveBeenCalled()
    expect(n.raw.clear).not.toHaveBeenCalled() // still restoring
    s.session.setState({ status: 'signedOut' })
    expect(n.raw.clear).toHaveBeenCalledTimes(1)
    s.session.setState({ status: 'signedOut', lastServerUrl: 'x' })
    expect(n.raw.clear).toHaveBeenCalledTimes(1)

    s.session.setState(signedIn())
    expect(n.raw.configure).toHaveBeenCalledWith('https://music.example.com', 'android')
    s.session.setState({ ...signedIn(), lastServerUrl: 'https://music.example.com' })
    expect(n.raw.configure).toHaveBeenCalledTimes(1)
    channel = 'android-beta'
    s.session.setState(signedIn('https://other.example.com'))
    expect(n.raw.configure).toHaveBeenLastCalledWith('https://other.example.com', 'android-beta')

    s.session.setState({ status: 'signedOut', session: null })
    expect(n.raw.clear).toHaveBeenCalledTimes(2)
    channel = null
    s.session.setState(signedIn())
    expect(n.raw.configure).toHaveBeenCalledTimes(2) // no channel: nothing to schedule
    channel = 'android'
    s.session.setState({ status: 'signedIn', session: null, lastServerUrl: '' })
    expect(n.raw.configure).toHaveBeenCalledTimes(2) // no server: nothing to schedule
  })

  it('android: asks native to notify once per version per run (native dedupes across runs)', () => {
    const s = stores()
    const n = fakeNative()
    s.updates.setState(found('4.0.0', null))
    createUpdateNotifications({
      platform: { kind: 'android', hostedOrigin: null, nativeUpdates: n.native, notifyUpdate: null },
      session: s.session,
      updates: s.updates,
      channel: () => 'android'
    })
    expect(n.raw.notify).toHaveBeenCalledWith('4.0.0') // download URL not required on android
    s.updates.setState(found('4.0.0'))
    expect(n.raw.notify).toHaveBeenCalledTimes(1)
    s.updates.setState({ available: false })
    s.updates.setState(found('4.0.1'))
    expect(n.raw.notify).toHaveBeenCalledTimes(2)
    expect(localStorage.getItem(NOTIFIED_KEY)).toBeNull() // desktop key untouched
  })

  it('android: a notification tap reveals the banner and refreshes a completed check', () => {
    const s = stores()
    const n = fakeNative()
    createUpdateNotifications({
      platform: { kind: 'android', hostedOrigin: null, nativeUpdates: n.native, notifyUpdate: null },
      session: s.session,
      updates: s.updates,
      channel: () => 'android'
    })
    n.tap('5.0.0')
    expect(useUpdateReveal.getState().version).toBe('5.0.0')
    expect(s.check).not.toHaveBeenCalled() // first check still pending: the banner runs it
    s.updates.setState(found('5.0.1'))
    n.tap(null)
    expect(useUpdateReveal.getState().version).toBe('5.0.1')
    expect(s.check).toHaveBeenCalledTimes(1)
  })

  it('android without the plugin does nothing', () => {
    const s = stores()
    const stop = createUpdateNotifications({
      platform: { kind: 'android', hostedOrigin: null, nativeUpdates: null, notifyUpdate: null },
      session: s.session,
      updates: s.updates,
      channel: () => 'android'
    })
    expect(() => {
      s.session.setState(signedIn())
      s.updates.setState(found('6.0.0'))
    }).not.toThrow()
    stop()
  })
})
