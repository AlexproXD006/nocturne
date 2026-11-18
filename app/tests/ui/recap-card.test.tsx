import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const { saveOrShareImage } = vi.hoisted(() => ({ saveOrShareImage: vi.fn() }))
vi.mock('../../src/renderer/src/platform', () => ({ platform: { saveOrShareImage, kind: 'web' } }))
vi.mock('../../src/renderer/src/lib/lyricCard', () => ({
  canvasToPngBlob: vi.fn(async () => new Blob(['x'])),
  ensureCardFonts: vi.fn(async () => undefined),
  loadCardImage: vi.fn(async () => null)
}))
vi.mock('../../src/renderer/src/lib/recapCard', () => ({ drawRecapCard: vi.fn(), parseAccent: () => [1, 2, 3] }))

import { RecapCard } from '../../src/renderer/src/components/RecapCard'
import { useUi } from '../../src/renderer/src/store/ui'

const data = { periodLabel: 'Week 1', artists: [], topTrack: null } as never

describe('RecapCard buttons', () => {
  beforeEach(() => {
    saveOrShareImage.mockReset()
    useUi.setState({ toasts: [] })
  })
  it('shows Share and Save image, and routes the intent', async () => {
    saveOrShareImage.mockResolvedValue('saved')
    render(<RecapCard data={data} onClose={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'Share image' }))
    await waitFor(() => expect(saveOrShareImage).toHaveBeenCalledWith(expect.any(Blob), expect.stringMatching(/\.png$/), expect.objectContaining({ intent: 'share' })))
    fireEvent.click(screen.getByRole('button', { name: 'Save image' }))
    await waitFor(() => expect(saveOrShareImage).toHaveBeenLastCalledWith(expect.any(Blob), expect.any(String), expect.objectContaining({ intent: 'save' })))
    await waitFor(() => expect(useUi.getState().toasts.some((t) => t.message === 'Image saved')).toBe(true))
  })
  it('toasts an error when export fails', async () => {
    saveOrShareImage.mockRejectedValue(new Error('x'))
    render(<RecapCard data={data} onClose={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save image' }))
    await waitFor(() => expect(useUi.getState().toasts.some((t) => t.tone === 'error')).toBe(true))
  })
})
