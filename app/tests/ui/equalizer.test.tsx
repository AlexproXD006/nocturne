import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const svc = vi.hoisted(() => ({ useEq: null as unknown }))
vi.mock('@/services', async () => {
  const { createEqStore } = await import('@/store/eq')
  const api = {
    eqState: vi.fn(async () => ({ enabled: true, preamp: 0, gains: new Array(10).fill(0), presetId: 'flat', updatedAt: null })),
    putEqState: vi.fn(async (s: unknown) => s),
    eqPresets: vi.fn(async () => ({ items: [] })),
    createEqPreset: vi.fn(async (i: { name: string; preamp: number; gains: number[] }) => ({ id: 'custom:1', createdAt: 'a', updatedAt: 'a', ...i })),
    updateEqPreset: vi.fn(),
    deleteEqPreset: vi.fn(async () => undefined)
  }
  svc.useEq = createEqStore({ api: api as never, apply: vi.fn(), saveDelayMs: 10 })
  const { create } = await import('zustand')
  const useSession = create(() => ({ status: 'signedIn', session: { user: { id: 'u1', username: 'demo', displayName: 'Demo' } }, server: null, logout: async () => undefined }))
  const usePlayer = create(() => ({ queue: { items: [], index: -1, shuffle: false, repeat: 'off', context: null }, status: 'idle' }))
  const { connectMocks } = await import('../helpers/services-mock')
  return { platform: { kind: 'web' }, useEq: svc.useEq, api, useSession, usePlayer, getEngine: () => null, ...connectMocks(usePlayer) }
})

import { EqCurve, pointToBand } from '@/components/EqCurve'
import { EqualizerPage } from '@/pages/Equalizer'
import { useEq } from '@/services'
import { setLanguagePref } from '@/i18n'

beforeEach(() => {
  Element.prototype.scrollTo = vi.fn()
  localStorage.clear()
  setLanguagePref('en')
  useEq.getState().reset()
})

describe('pointToBand', () => {
  const rect = { left: 0, top: 0, width: 1000, height: 300 }
  it('picks the nearest band and a snapped gain from the pointer', () => {
    expect(pointToBand(50, 150, rect)).toEqual({ band: 0, gain: 0 })
    expect(pointToBand(950, 0, rect)).toEqual({ band: 9, gain: 12 })
    expect(pointToBand(5000, 5000, rect).band).toBe(9)
    expect(pointToBand(-50, -50, rect)).toEqual({ band: 0, gain: 12 })
    expect(pointToBand(550, 300, rect)).toEqual({ band: 5, gain: -12 })
  })
})

describe('EqCurve', () => {
  it('renders ten accessible sliders with values', () => {
    render(<EqCurve gains={[3, 0, 0, 0, 0, 0, 0, 0, 0, -2.5]} onChange={() => undefined} />)
    const sliders = screen.getAllByRole('slider')
    expect(sliders).toHaveLength(10)
    expect(sliders[0]).toHaveAttribute('aria-valuenow', '3')
    expect(sliders[0]).toHaveAttribute('aria-valuemin', '-12')
    expect(sliders[0]).toHaveAttribute('aria-valuemax', '12')
    expect(sliders[0]).toHaveAttribute('aria-label', '31 Hz')
    expect(sliders[9]).toHaveAttribute('aria-valuetext', '-2.5 dB')
    expect(sliders[5]).toHaveAttribute('aria-label', '1k Hz')
  })

  it('supports the keyboard: arrows, page keys, Home/End and 0', () => {
    const onChange = vi.fn()
    render(<EqCurve gains={[0, 0, 0, 0, 0, 1, 0, 0, 0, 0]} onChange={onChange} />)
    const s = screen.getAllByRole('slider')[5]!
    fireEvent.keyDown(s, { key: 'ArrowUp' })
    expect(onChange).toHaveBeenLastCalledWith(5, 1.5)
    fireEvent.keyDown(s, { key: 'ArrowDown' })
    expect(onChange).toHaveBeenLastCalledWith(5, 0.5)
    fireEvent.keyDown(s, { key: 'PageUp' })
    expect(onChange).toHaveBeenLastCalledWith(5, 4)
    fireEvent.keyDown(s, { key: 'Home' })
    expect(onChange).toHaveBeenLastCalledWith(5, -12)
    fireEvent.keyDown(s, { key: 'End' })
    expect(onChange).toHaveBeenLastCalledWith(5, 12)
    fireEvent.keyDown(s, { key: '0' })
    expect(onChange).toHaveBeenLastCalledWith(5, 0)
    const n = onChange.mock.calls.length
    fireEvent.keyDown(s, { key: 'a' })
    expect(onChange).toHaveBeenCalledTimes(n)
  })

  it('ignores input while disabled', () => {
    const onChange = vi.fn()
    render(<EqCurve gains={new Array<number>(10).fill(0)} disabled onChange={onChange} />)
    fireEvent.keyDown(screen.getAllByRole('slider')[0]!, { key: 'ArrowUp' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('drags a handle with the pointer', () => {
    const onChange = vi.fn()
    const { container } = render(<EqCurve gains={new Array<number>(10).fill(0)} onChange={onChange} />)
    const plot = container.querySelector('.eq-plot') as HTMLElement
    plot.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 300, right: 1000, bottom: 300, x: 0, y: 0, toJSON: () => ({}) })
    const handle = screen.getAllByRole('slider')[3]!
    fireEvent.pointerDown(handle, { clientX: 350, clientY: 75, pointerId: 1 })
    expect(onChange).toHaveBeenLastCalledWith(3, 7)
    fireEvent.pointerMove(plot, { clientX: 360, clientY: 30, pointerId: 1 })
    expect(onChange).toHaveBeenLastCalledWith(3, 11)
    fireEvent.pointerUp(plot, { pointerId: 1 })
    onChange.mockClear()
    fireEvent.pointerMove(plot, { clientX: 360, clientY: 30, pointerId: 1 })
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('EqualizerPage', () => {
  it('shows presets in the active language and applies one', () => {
    render(<EqualizerPage />)
    expect(screen.getByRole('heading', { name: 'Equalizer' })).toBeInTheDocument()
    const group = screen.getByRole('radiogroup', { name: 'Presets' })
    expect(within(group).getAllByRole('radio')).toHaveLength(18)
    fireEvent.click(within(group).getByRole('radio', { name: 'Rock' }))
    expect(useEq.getState().presetId).toBe('rock')
    expect(within(group).getByRole('radio', { name: 'Rock' })).toHaveAttribute('aria-checked', 'true')
    expect(useEq.getState().preamp).toBeLessThan(0)
  })

  it('localises preset names to Spanish', () => {
    setLanguagePref('es')
    render(<EqualizerPage />)
    const group = screen.getByRole('radiogroup', { name: 'Modos' })
    for (const n of ['Plano', 'Más graves', 'Menos graves', 'Más agudos', 'Voces', 'Electrónica', 'Clásica', 'Acústica', 'Noche', 'Altavoces pequeños', 'Auriculares', 'Coche']) {
      expect(within(group).getByRole('radio', { name: n })).toBeInTheDocument()
    }
  })

  it('toggles the equalizer and warns about clipping', () => {
    render(<EqualizerPage />)
    fireEvent.click(screen.getByRole('switch', { name: 'Equalizer' }))
    expect(useEq.getState().enabled).toBe(false)
    fireEvent.click(screen.getByRole('switch', { name: 'Equalizer' }))
    act(() => {
      useEq.getState().setGain(5, 12)
      useEq.getState().setPreamp(0)
    })
    expect(screen.getByRole('alert')).toHaveTextContent(/Clipping risk/)
    fireEvent.click(screen.getByRole('button', { name: /Auto/ }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('saves the current curve as a custom preset through the dialog', async () => {
    render(<EqualizerPage />)
    act(() => useEq.getState().setGain(2, 4))
    fireEvent.click(screen.getByRole('button', { name: /Save as preset/ }))
    const input = await screen.findByLabelText('Preset name')
    fireEvent.change(input, { target: { value: 'Night out' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await vi.waitFor(() => expect(useEq.getState().presets.map((p) => p.name)).toEqual(['Night out']))
    expect(await screen.findByRole('radio', { name: 'Night out' })).toHaveAttribute('aria-checked', 'true')
  })
})
