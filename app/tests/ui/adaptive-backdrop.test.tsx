import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const svc = vi.hoisted(() => ({ engine: null as null | { reactive: boolean; frequencyBinCount: number; sampleRate: number; getFrequencyData: (o: Uint8Array) => boolean } }))
vi.mock('@/services', async () => {
  const { create } = await import('zustand')
  return {
    platform: { kind: 'web', hostedOrigin: null },
    getEngine: () => svc.engine,
    usePlayer: create(() => ({
      status: 'playing',
      queue: { items: [{ track: { artwork: [{ url: 'https://img.test/cover.jpg', width: 300 }] } }], index: 0 }
    })),
    useConnect: create(() => ({ remote: null }))
  }
})
vi.mock('@/player/queue', () => ({
  currentItem: (q: { items: unknown[]; index: number }) => q.items[q.index] ?? null
}))

import { AdaptiveBackdrop } from '@/components/AdaptiveBackdrop'
import { AdaptiveSettingsPanel } from '@/pages/AdaptiveSettings'
import { useAdaptiveRoot } from '@/hooks/useAdaptive'
import { useSettings } from '@/store/settings'
import { useUi } from '@/store/ui'
import { usePlayer } from '@/services'

function Root(): null {
  useAdaptiveRoot()
  return null
}

beforeEach(() => {
  useSettings.getState().reset()
  useSettings.getState().update({ theme: 'adaptive', motion: 'full' })
  useUi.getState().setFullscreen(false)
  svc.engine = null
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AdaptiveBackdrop scope', () => {
  it('renders app-wide with scope "everywhere" (default)', () => {
    render(<AdaptiveBackdrop />)
    expect(screen.getByTestId('adaptive-backdrop-app')).toBeInTheDocument()
  })

  it('is absent app-wide with scope "fullscreen", but the embedded one still renders', () => {
    useSettings.getState().updateAdaptive({ scope: 'fullscreen' })
    render(
      <>
        <AdaptiveBackdrop />
        <AdaptiveBackdrop variant="embedded" />
      </>
    )
    expect(screen.queryByTestId('adaptive-backdrop-app')).toBeNull()
    expect(screen.getByTestId('adaptive-backdrop-embedded')).toBeInTheDocument()
  })

  it('is absent for other themes', () => {
    useSettings.getState().update({ theme: 'dark' })
    render(<AdaptiveBackdrop />)
    expect(screen.queryByTestId('adaptive-backdrop-app')).toBeNull()
  })

  it('publishes scope, perf tier and glass on <html>', () => {
    render(<Root />)
    const html = document.documentElement
    expect(html.getAttribute('data-adaptive-scope')).toBe('everywhere')
    expect(html.style.getPropertyValue('--adaptive-main-bg')).toBe('rgb(8 8 12 / 0.38)')
    act(() => useSettings.getState().updateAdaptive({ scope: 'fullscreen', glass: 0, performance: 'saver' }))
    expect(html.getAttribute('data-adaptive-scope')).toBe('fullscreen')
    expect(html.getAttribute('data-adaptive-perf')).toBe('saver')
    expect(html.style.getPropertyValue('--adaptive-main-bg')).toBe('rgb(8 8 12 / 1)')
  })

  it('default look: one cover layer at 300px with the original opacity/blur/saturation and 45% dim', () => {
    render(<AdaptiveBackdrop />)
    const root = screen.getByTestId('adaptive-backdrop-app')
    expect(root.style.getPropertyValue('--ab-opacity')).toBe('0.55')
    expect(root.style.getPropertyValue('--ab-filter')).toBe('blur(64px) saturate(150%)')
    expect(root.querySelectorAll('img')).toHaveLength(1)
    expect((root.querySelector('.ab-dim') as HTMLElement).style.opacity).toBe('0.45')
  })
})

describe('motion and reduced motion', () => {
  it('pulse runs when allowed', () => {
    useSettings.getState().updateAdaptive({ motion: 'pulse' })
    render(<AdaptiveBackdrop />)
    const root = screen.getByTestId('adaptive-backdrop-app')
    expect(root.dataset.motion).toBe('pulse')
    expect(root.querySelector('.ab-pulse')).not.toBeNull()
  })

  it('pulse is disabled (and never reads the analyser) under reduced motion', async () => {
    const getFrequencyData = vi.fn(() => true)
    svc.engine = { reactive: true, frequencyBinCount: 1024, sampleRate: 44100, getFrequencyData }
    useSettings.getState().update({ motion: 'reduced' })
    useSettings.getState().updateAdaptive({ motion: 'pulse', performance: 'quality' })
    render(<AdaptiveBackdrop />)
    const root = screen.getByTestId('adaptive-backdrop-app')
    expect(root.dataset.motion).toBe('static')
    expect(root.querySelector('.ab-pulse')).toBeNull()
    await new Promise((r) => setTimeout(r, 60))
    expect(getFrequencyData).not.toHaveBeenCalled()
  })

  it('pulse reads the existing analyser when active', async () => {
    const getFrequencyData = vi.fn((o: Uint8Array) => {
      o.fill(200)
      return true
    })
    svc.engine = { reactive: true, frequencyBinCount: 1024, sampleRate: 44100, getFrequencyData }
    useSettings.getState().updateAdaptive({ motion: 'pulse', performance: 'quality' })
    render(<AdaptiveBackdrop />)
    const media = screen.getByTestId('adaptive-backdrop-app').querySelector('.ab-media') as HTMLElement
    await vi.waitFor(() => expect(media.style.transform).toMatch(/^scale\(1\.0[1-9]/), { timeout: 1500 })
    expect(getFrequencyData).toHaveBeenCalled()
  })

  it('freezes and dims slightly while paused', () => {
    usePlayer.setState({ status: 'paused' })
    useSettings.getState().updateAdaptive({ motion: 'drift' })
    render(<AdaptiveBackdrop />)
    const root = screen.getByTestId('adaptive-backdrop-app')
    expect(root.className).toContain('ab-frozen')
    expect(Number((root.querySelector('.ab-dim') as HTMLElement).style.opacity)).toBeCloseTo(0.57, 5)
    usePlayer.setState({ status: 'playing' })
  })

  it('the app-wide layer freezes while the fullscreen player covers it', () => {
    useUi.getState().setFullscreen(true)
    render(<AdaptiveBackdrop />)
    expect(screen.getByTestId('adaptive-backdrop-app').className).toContain('ab-frozen')
  })
})

describe('AdaptiveSettingsPanel', () => {
  it('applies a preset in one tap and marks edits as custom', async () => {
    render(<AdaptiveSettingsPanel />)
    await userEvent.click(screen.getByRole('radio', { name: /Vinyl/ }))
    expect(useSettings.getState().adaptive).toMatchObject({ preset: 'vinyl', motion: 'spin' })
    await userEvent.click(screen.getByRole('radio', { name: 'Aurora' }))
    expect(useSettings.getState().adaptive).toMatchObject({ preset: 'custom', style: 'aurora' })
    expect(screen.getByText('Custom')).toBeInTheDocument()
    expect(screen.getByTestId('adaptive-preview')).toBeInTheDocument()
  })

  it('advanced options are collapsed under "More options"', async () => {
    render(<AdaptiveSettingsPanel />)
    expect(screen.queryByLabelText('Blur')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'More options' }))
    expect(screen.getByLabelText('Blur')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('radio', { name: 'Now playing only' }))
    expect(useSettings.getState().adaptive.scope).toBe('fullscreen')
    expect(screen.queryByLabelText('Panel glass')).toBeNull()
  })
})
