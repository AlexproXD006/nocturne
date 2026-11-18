import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AdminTrack } from '@/api/types'
import { useUi } from '@/store/ui'
import { LyricsEditDialog } from '@/pages/admin/LyricsEditDialog'
import { track } from '../helpers/fixtures'

const h = vi.hoisted(() => ({ api: { lyrics: vi.fn(), adminSetLyrics: vi.fn(), adminDeleteLyrics: vi.fn() } }))
vi.mock('@/services', () => ({ api: h.api, platform: {} }))

const song = (over: Partial<AdminTrack> = {}): AdminTrack => ({ ...track('t1', { title: 'Paper Lanterns' }), ...over })

beforeEach(() => {
  Object.values(h.api).forEach((f) => f.mockReset())
  h.api.adminSetLyrics.mockResolvedValue(undefined)
  h.api.adminDeleteLyrics.mockResolvedValue(undefined)
  useUi.setState({ toasts: [] })
})

describe('LyricsEditDialog', () => {
  it('pasted timestamped text is detected as LRC, previewed and saved', async () => {
    const onClose = vi.fn()
    const onChanged = vi.fn()
    render(<LyricsEditDialog track={song()} onClose={onClose} onChanged={onChanged} />)
    expect(screen.getByRole('button', { name: 'Save lyrics' })).toBeDisabled()
    await userEvent.click(screen.getByLabelText('Lyrics text'))
    await userEvent.paste('[00:01.00] hello\n[00:05.00] world')
    expect(screen.getByTestId('lyrics-edit-preview')).toHaveTextContent('2 lines')
    expect(screen.getByTestId('lyrics-edit-preview')).toHaveTextContent('0:01 hello')
    await userEvent.click(screen.getByRole('button', { name: 'Save lyrics' }))
    await waitFor(() => expect(h.api.adminSetLyrics).toHaveBeenCalledWith('t1', { format: 'lrc', content: '[00:01.00] hello\n[00:05.00] world' }))
    expect(onChanged).toHaveBeenCalledWith('lrc')
    expect(onClose).toHaveBeenCalled()
  })

  it('plain text saves as plain; LRC format without timestamps blocks saving', async () => {
    render(<LyricsEditDialog track={song()} onClose={() => undefined} />)
    await userEvent.click(screen.getByLabelText('Lyrics text'))
    await userEvent.paste('la la\nla la la')
    await userEvent.click(screen.getByRole('radio', { name: 'Synced (LRC)' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/timestamps/i)
    expect(screen.getByRole('button', { name: 'Save lyrics' })).toBeDisabled()
    await userEvent.click(screen.getByRole('radio', { name: 'Plain text' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save lyrics' }))
    await waitFor(() => expect(h.api.adminSetLyrics).toHaveBeenCalledWith('t1', { format: 'plain', content: 'la la\nla la la' }))
  })

  it('loads a chosen .lrc file into the editor', async () => {
    render(<LyricsEditDialog track={song()} onClose={() => undefined} />)
    await userEvent.upload(screen.getByTestId('lyrics-edit-file'), new File(['[00:02.00] from file'], 'a.lrc', { type: 'text/plain' }))
    await waitFor(() => expect(screen.getByLabelText('Lyrics text')).toHaveValue('[00:02.00] from file'))
  })

  it('prefills stored lyrics and can remove them', async () => {
    h.api.lyrics.mockResolvedValue({ synced: '[00:01.00] stored', plain: null })
    const onChanged = vi.fn()
    render(<LyricsEditDialog track={song({ lyrics: 'lrc' })} onClose={() => undefined} onChanged={onChanged} />)
    await waitFor(() => expect(screen.getByLabelText('Lyrics text')).toHaveValue('[00:01.00] stored'))
    await userEvent.click(screen.getByRole('button', { name: 'Remove lyrics' }))
    await waitFor(() => expect(h.api.adminDeleteLyrics).toHaveBeenCalledWith('t1'))
    expect(onChanged).toHaveBeenCalledWith(null)
  })

  it('shows the server error and stays open when saving fails', async () => {
    h.api.adminSetLyrics.mockRejectedValue(new Error('boom'))
    const onClose = vi.fn()
    render(<LyricsEditDialog track={song()} onClose={onClose} />)
    await userEvent.click(screen.getByLabelText('Lyrics text'))
    await userEvent.paste('some words')
    await userEvent.click(screen.getByRole('button', { name: 'Save lyrics' }))
    await waitFor(() => expect(screen.getByRole('alert')).not.toBeEmptyDOMElement())
    expect(onClose).not.toHaveBeenCalled()
  })
})
