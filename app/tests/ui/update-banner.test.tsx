import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const svc = vi.hoisted(() => ({ openExternal: vi.fn(async () => undefined) }))
vi.mock('@/services', async () => {
  const { create } = await import('zustand')
  return {
    platform: { kind: 'desktop', hostedOrigin: null, openExternal: svc.openExternal },
    api: { checkUpdate: vi.fn(async () => ({ version: '9.0.0', url: '/dl/9.0.0' })) },
    useSession: create(() => ({ status: 'signedOut', session: null, lastServerUrl: '' }))
  }
})

import { UpdateBanner } from '@/components/UpdateBanner'
import { useUpdates } from '@/store/updates'
import { useUpdateReveal } from '@/store/updateNotifications'

beforeEach(() => {
  useUpdateReveal.setState({ version: null })
  useUpdates.setState({
    available: true,
    latest: { version: '9.0.0', url: '/dl/9.0.0' },
    downloadUrl: 'https://music.example.com/dl/9.0.0',
    checked: true,
    checking: false
  })
})

describe('UpdateBanner + notification tap', () => {
  it('a dismissed version comes back when the notification is tapped, and goes again on Later', async () => {
    localStorage.setItem('nocturne.update.dismissed', JSON.stringify('9.0.0'))
    render(<UpdateBanner />)
    expect(screen.queryByText('New version 9.0.0 available')).toBeNull()
    act(() => useUpdateReveal.getState().reveal('9.0.0'))
    expect(screen.getByText('New version 9.0.0 available')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss update' }))
    expect(screen.queryByText('New version 9.0.0 available')).toBeNull()
    expect(useUpdateReveal.getState().version).toBeNull()
  })

  it('revealing another version does not override the dismissal of this one', () => {
    localStorage.setItem('nocturne.update.dismissed', JSON.stringify('9.0.0'))
    render(<UpdateBanner />)
    act(() => useUpdateReveal.getState().reveal('8.0.0'))
    expect(screen.queryByText('New version 9.0.0 available')).toBeNull()
  })

  it('is a full pill that owns the status-bar inset and flags the root while mounted', () => {
    const { unmount } = render(<UpdateBanner />)
    const banner = screen.getByTestId('update-banner')
    expect(banner.className).toContain('update-banner')
    expect(screen.getByRole('button', { name: /Install/ })).toBeInTheDocument()
    expect(document.documentElement.hasAttribute('data-update-banner')).toBe(true)
    unmount()
    expect(document.documentElement.hasAttribute('data-update-banner')).toBe(false)
  })
})

describe.each(['dark', 'oled', 'glass', 'adaptive', 'midnight'])('UpdateBanner under theme %s', (theme) => {
  it('shows the text and the install / dismiss buttons, above the shell backdrop, and leaves no band after dismissing', async () => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.removeItem('nocturne.update.dismissed')
    render(<UpdateBanner />)
    expect(screen.getByText('New version 9.0.0 available')).toBeVisible()
    expect(screen.getByRole('button', { name: /Install/ })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Dismiss update' })).toBeVisible()
    // Must stack above the fixed full-viewport backdrop inside the (isolated) shell that follows it.
    const cls = screen.getByTestId('update-banner').className
    expect(cls).toContain('relative')
    expect(cls).toContain('z-20')
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss update' }))
    expect(screen.queryByTestId('update-banner')).toBeNull()
    expect(document.documentElement.hasAttribute('data-update-banner')).toBe(false)
    document.documentElement.removeAttribute('data-theme')
  })
})
