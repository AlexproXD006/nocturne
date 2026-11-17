import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AdminTrack } from '@/api/types'
import { useUi } from '@/store/ui'
import { LyricsTab } from '@/pages/admin/LyricsTab'
import { track } from '../helpers/fixtures'

const h = vi.hoisted(() => ({
  api: { adminTracks: vi.fn(), adminSetLyrics: vi.fn(), adminDeleteLyrics: vi.fn() },
  playTracks: vi.fn()
}))

vi.mock('@/services', () => ({
  api: h.api,
  platform: {},
  getEngine: () => null,
  lrclib: { find: vi.fn() },
  useSession: Object.assign((sel: (s: unknown) => unknown) => sel({ server: null }), { getState: () => ({}) }),
  usePlayer: Object.assign(() => undefined, { getState: () => ({ playTracks: h.playTracks }) })
}))

const song = (id: string, title: string, artist: string, over: Partial<AdminTrack> = {}): AdminTrack => ({
  ...track(id, { title, artists: [{ id: `a-${id}`, name: artist }], duration: 192 }),
  ...over
})

let missing: AdminTrack[]
let present: AdminTrack[]

const page = (items: AdminTrack[]) => ({ items, offset: 0, limit: 50, total: items.length })
const TTML = (title: string, artist: string): string =>
  `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><head><metadata><ttm:title>${title}</ttm:title><ttm:agent type="person" xml:id="v1"><ttm:name>${artist}</ttm:name></ttm:agent></metadata></head><body dur="3:12"><div><p begin="1s" end="3s"><span begin="1s" end="2s">hello</span> <span begin="2s" end="3s">world</span></p></div></body></tt>`
const file = (name: string, content: string): File => new File([content], name, { type: 'text/plain' })

beforeEach(() => {
  missing = [song('m1', 'Paper Lanterns', 'Mira Vale'), song('m2', 'Midnight Drive', 'The Example Band')]
  present = [song('p1', 'Old Song', 'Someone', { lyrics: 'lrc' })]
  Object.values(h.api).forEach((f) => f.mockReset())
  h.playTracks.mockReset()
  h.api.adminSetLyrics.mockResolvedValue(undefined)
  h.api.adminDeleteLyrics.mockResolvedValue(undefined)
  h.api.adminTracks.mockImplementation(async (opts: { q?: string; limit?: number; lyrics?: 'missing' | 'present' }) => {
    if (opts.limit === 1) return { items: [], offset: 0, limit: 1, total: opts.lyrics === 'missing' ? missing.length : present.length }
    const words = (opts.q ?? '').toLowerCase().split(/\s+/).filter(Boolean)
    const matches = (t: AdminTrack): boolean => words.every((w) => `${t.title} ${t.artists[0]!.name}`.toLowerCase().includes(w))
    const pool = opts.lyrics === 'missing' ? missing : opts.lyrics === 'present' ? present : [...missing, ...present]
    return page(pool.filter(matches))
  })
  useUi.setState({ toasts: [], panel: null })
  globalThis.IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] {
      return []
    }
  } as never
})

const toasts = (): string[] => useUi.getState().toasts.map((t) => t.message)

describe('LyricsTab coverage and lists', () => {
  it('summarises coverage from the missing/present totals', async () => {
    render(<LyricsTab />)
    const box = await screen.findByTestId('lyrics-coverage')
    expect(box).toHaveTextContent('1 of 3 tracks have lyrics')
    expect(box).toHaveTextContent('2 missing')
    expect(h.api.adminTracks).toHaveBeenCalledWith(expect.objectContaining({ lyrics: 'missing', limit: 1 }))
    expect(h.api.adminTracks).toHaveBeenCalledWith(expect.objectContaining({ lyrics: 'present', limit: 1 }))
  })

  it('lists tracks missing lyrics and tracks with lyrics', async () => {
    render(<LyricsTab />)
    expect(await screen.findByText('Paper Lanterns')).toBeInTheDocument()
    expect(screen.getByText('Midnight Drive')).toBeInTheDocument()
    expect(await screen.findByText('Old Song')).toBeInTheDocument()
    expect(screen.getByText('lrc')).toBeInTheDocument()
  })

  it('filters the missing list with the search box (debounced) and passes the query to the API', async () => {
    render(<LyricsTab />)
    await screen.findByText('Paper Lanterns')
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search tracks without lyrics' }), 'midnight')
    await waitFor(() => expect(screen.queryByText('Paper Lanterns')).toBeNull())
    expect(screen.getByText('Midnight Drive')).toBeInTheDocument()
    expect(h.api.adminTracks).toHaveBeenCalledWith(expect.objectContaining({ q: 'midnight', lyrics: 'missing' }))
  })

  it('shows an empty state when nothing matches', async () => {
    render(<LyricsTab />)
    await screen.findByText('Paper Lanterns')
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search tracks without lyrics' }), 'zzzz')
    expect(await screen.findByText('No matching tracks')).toBeInTheDocument()
  })

  it('plays a track from the missing list', async () => {
    render(<LyricsTab />)
    await userEvent.click(await screen.findByRole('button', { name: 'Play Paper Lanterns' }))
    expect(h.playTracks).toHaveBeenCalledWith([missing[0]], 0, expect.anything())
  })
})

describe('single upload', () => {
  it('validates, stores the file and removes the row', async () => {
    render(<LyricsTab />)
    await userEvent.click(await screen.findByRole('button', { name: 'Upload lyrics for Paper Lanterns' }))
    const input = screen.getAllByTestId('lyrics-file-input')[0]!
    const content = TTML('Whatever', 'Anyone')
    await userEvent.upload(input, file('x.ttml', content))
    await waitFor(() => expect(h.api.adminSetLyrics).toHaveBeenCalledWith('m1', { format: 'ttml', content }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Upload lyrics for Paper Lanterns' })).toBeNull())
    expect(screen.getByRole('button', { name: 'Upload lyrics for Midnight Drive' })).toBeInTheDocument()
    expect(toasts().some((m) => /Saved TTML lyrics for “Paper Lanterns”/.test(m))).toBe(true)
  })

  it('accepts LRC files', async () => {
    render(<LyricsTab />)
    await userEvent.click(await screen.findByRole('button', { name: 'Upload lyrics for Midnight Drive' }))
    await userEvent.upload(screen.getAllByTestId('lyrics-file-input')[0]!, file('x.lrc', '[00:01.00] hi'))
    await waitFor(() => expect(h.api.adminSetLyrics).toHaveBeenCalledWith('m2', { format: 'lrc', content: '[00:01.00] hi' }))
  })

  it('refuses invalid files client-side with an error toast and keeps the row', async () => {
    render(<LyricsTab />)
    await userEvent.click(await screen.findByRole('button', { name: 'Upload lyrics for Paper Lanterns' }))
    await userEvent.upload(screen.getAllByTestId('lyrics-file-input')[0]!, file('bad.lrc', 'no timestamps'), { applyAccept: false })
    await waitFor(() => expect(useUi.getState().toasts.some((t) => t.tone === 'error' && /bad\.lrc/.test(t.message))).toBe(true))
    expect(h.api.adminSetLyrics).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Upload lyrics for Paper Lanterns' })).toBeInTheDocument()
  })

  it('reports server errors and keeps the row', async () => {
    h.api.adminSetLyrics.mockRejectedValue(new Error('Server says no'))
    render(<LyricsTab />)
    await userEvent.click(await screen.findByRole('button', { name: 'Upload lyrics for Paper Lanterns' }))
    await userEvent.upload(screen.getAllByTestId('lyrics-file-input')[0]!, file('x.lrc', '[00:01.00] hi'))
    await waitFor(() => expect(toasts().some((m) => /Server says no/.test(m))).toBe(true))
    expect(screen.getByRole('button', { name: 'Upload lyrics for Paper Lanterns' })).toBeInTheDocument()
  })
})

describe('with-lyrics actions', () => {
  it('replaces lyrics and updates the format chip', async () => {
    render(<LyricsTab />)
    await userEvent.click(await screen.findByRole('button', { name: 'Replace lyrics for Old Song' }))
    await userEvent.upload(screen.getAllByTestId('lyrics-file-input')[1]!, file('new.ttml', TTML('Old Song', 'Someone')))
    await waitFor(() => expect(h.api.adminSetLyrics).toHaveBeenCalledWith('p1', expect.objectContaining({ format: 'ttml' })))
    await waitFor(() => expect(screen.getByText('ttml')).toBeInTheDocument())
    expect(toasts()).toContain('Replaced lyrics for “Old Song”')
  })

  it('removes lyrics only after confirming', async () => {
    render(<LyricsTab />)
    await userEvent.click(await screen.findByRole('button', { name: 'Remove lyrics from Old Song' }))
    const dialog = await screen.findByRole('dialog', { name: 'Remove these lyrics?' })
    expect(h.api.adminDeleteLyrics).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove lyrics' }))
    await waitFor(() => expect(h.api.adminDeleteLyrics).toHaveBeenCalledWith('p1'))
    await waitFor(() => expect(screen.queryByText('Old Song')).toBeNull())
    expect(toasts()).toContain('Removed lyrics from “Old Song”')
  })

  it('cancelling the confirmation keeps the lyrics', async () => {
    render(<LyricsTab />)
    await userEvent.click(await screen.findByRole('button', { name: 'Remove lyrics from Old Song' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(h.api.adminDeleteLyrics).not.toHaveBeenCalled()
    expect(screen.getByText('Old Song')).toBeInTheDocument()
  })

  it('previews by playing the track and opening the lyrics panel', async () => {
    render(<LyricsTab />)
    await userEvent.click(await screen.findByRole('button', { name: 'Preview lyrics for Old Song' }))
    expect(h.playTracks).toHaveBeenCalledWith([present[0]], 0, expect.anything())
    expect(useUi.getState().panel).toBe('lyrics')
  })

  it('does not close the lyrics panel when it is already open', async () => {
    useUi.setState({ panel: 'lyrics' })
    render(<LyricsTab />)
    await userEvent.click(await screen.findByRole('button', { name: 'Preview lyrics for Old Song' }))
    expect(useUi.getState().panel).toBe('lyrics')
  })
})

describe('bulk import', () => {
  const bulk = (): HTMLInputElement => screen.getByTestId('lyrics-bulk-input') as HTMLInputElement

  it('matches files to tracks, shows confidence, and saves the selected ones', async () => {
    render(<LyricsTab />)
    await screen.findByText('Paper Lanterns')
    const good = TTML('Paper Lanterns', 'Mira Vale')
    await userEvent.upload(bulk(), [file('a.ttml', good), file('Nobody - Unknown Thing.lrc', '[00:01.00] hi')], { applyAccept: false })

    const rows = await waitFor(() => {
      const r = screen.getAllByTestId('bulk-row')
      expect(r.every((x) => x.dataset.status === 'ready')).toBe(true)
      return r
    })
    expect(within(rows[0]!).getByText('Auto')).toBeInTheDocument()
    expect(within(rows[0]!).getByText('Word sync')).toBeInTheDocument()
    expect(within(rows[0]!).getByRole('combobox')).toHaveValue('m1')
    expect(within(rows[1]!).getByRole('combobox')).toHaveValue('')
    expect(rows[1]).toHaveTextContent('No match')
    expect(within(rows[0]!).getByRole('checkbox')).toBeChecked()
    expect(within(rows[1]!).getByRole('checkbox')).toBeDisabled()

    await userEvent.click(screen.getByRole('button', { name: 'Save 1' }))
    await waitFor(() => expect(h.api.adminSetLyrics).toHaveBeenCalledTimes(1))
    expect(h.api.adminSetLyrics).toHaveBeenCalledWith('m1', { format: 'ttml', content: good })
    await waitFor(() => expect(within(screen.getAllByTestId('bulk-row')[0]!).getByText('Saved')).toBeInTheDocument())
    expect(toasts()).toContain('Saved lyrics for 1 track')
    // The saved track leaves the missing list.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Upload lyrics for Paper Lanterns' })).toBeNull())
  })

  it('searches "artist title" first and falls back to the title alone', async () => {
    render(<LyricsTab />)
    await screen.findByText('Paper Lanterns')
    await userEvent.upload(bulk(), file('Wrong Artist - Midnight Drive.lrc', '[00:01.00] hi'), { applyAccept: false })
    await waitFor(() => expect(screen.getByTestId('bulk-row').dataset.status).toBe('ready'))
    const queries = h.api.adminTracks.mock.calls.map((c) => c[0].q).filter(Boolean)
    expect(queries).toContain('Wrong Artist Midnight Drive')
    expect(queries).toContain('Midnight Drive')
    // A same-titled song by another artist is a suggestion to review, not an automatic match.
    const row = screen.getByTestId('bulk-row')
    expect(within(row).getByText('Review')).toBeInTheDocument()
    expect(within(row).getByRole('checkbox')).not.toBeChecked()
  })

  it('lets the user pick another candidate or search for one, then save', async () => {
    render(<LyricsTab />)
    await screen.findByText('Paper Lanterns')
    await userEvent.upload(bulk(), file('Nobody - Unknown Thing.lrc', '[00:01.00] hi'), { applyAccept: false })
    const row = await screen.findByTestId('bulk-row')
    await waitFor(() => expect(row.dataset.status).toBe('ready'))
    await userEvent.click(within(row).getByRole('button', { name: /find track/i }))
    await userEvent.type(within(row).getByRole('searchbox', { name: 'Search for a track' }), 'midnight')
    await userEvent.click(await within(row).findByRole('button', { name: /Midnight Drive/ }))
    expect(within(row).getByText('Manual')).toBeInTheDocument()
    expect(within(row).getByRole('combobox')).toHaveValue('m2')
    expect(within(row).getByRole('checkbox')).toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: 'Save 1' }))
    await waitFor(() => expect(h.api.adminSetLyrics).toHaveBeenCalledWith('m2', { format: 'lrc', content: '[00:01.00] hi' }))
  })

  it('flags invalid files, wrong extensions, and warns when a track already has lyrics', async () => {
    render(<LyricsTab />)
    await screen.findByText('Paper Lanterns')
    await userEvent.upload(
      bulk(),
      [file('broken.ttml', '<tt><body>'), file('notes.pdf', 'x'), file('Someone - Old Song.lrc', '[00:01.00] hi')],
      { applyAccept: false }
    )
    await waitFor(() => expect(screen.getAllByTestId('bulk-row').every((r) => r.dataset.status !== 'reading' && r.dataset.status !== 'matching')).toBe(true))
    const rows = screen.getAllByTestId('bulk-row')
    expect(within(rows[0]!).getByText('Invalid')).toBeInTheDocument()
    expect(within(rows[1]!).getByText('Invalid')).toBeInTheDocument()
    expect(within(rows[1]!).getByText(/Not a lyrics file/)).toBeInTheDocument()
    expect(within(rows[2]!).getByText('Replaces lrc')).toBeInTheDocument()
  })

  it('reports per-row failures and allows retrying', async () => {
    h.api.adminSetLyrics.mockRejectedValueOnce(new Error('disk full'))
    render(<LyricsTab />)
    await screen.findByText('Paper Lanterns')
    await userEvent.upload(bulk(), file('a.ttml', TTML('Paper Lanterns', 'Mira Vale')), { applyAccept: false })
    await waitFor(() => expect(screen.getByTestId('bulk-row').dataset.status).toBe('ready'))
    await userEvent.click(screen.getByRole('button', { name: 'Save 1' }))
    await waitFor(() => expect(screen.getByTestId('bulk-row').dataset.status).toBe('error'))
    expect(screen.getByText('disk full')).toBeInTheDocument()
    expect(toasts().some((m) => /could not be saved/.test(m))).toBe(true)
    // Still checked, so it can simply be saved again.
    await userEvent.click(screen.getByRole('button', { name: 'Save 1' }))
    await waitFor(() => expect(screen.getByTestId('bulk-row').dataset.status).toBe('saved'))
  })

  it('warns when two files target the same track, and Clear empties the list', async () => {
    render(<LyricsTab />)
    await screen.findByText('Paper Lanterns')
    const ttml = TTML('Paper Lanterns', 'Mira Vale')
    await userEvent.upload(bulk(), [file('a.ttml', ttml), file('b.ttml', ttml)], { applyAccept: false })
    await waitFor(() => expect(screen.getAllByTestId('bulk-row').every((r) => r.dataset.status === 'ready')).toBe(true))
    expect(screen.getAllByText('Same track as another file')).toHaveLength(2)
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(screen.queryAllByTestId('bulk-row')).toHaveLength(0)
  })

  it('select-auto checks every automatic match and removing a row drops it', async () => {
    render(<LyricsTab />)
    await screen.findByText('Paper Lanterns')
    await userEvent.upload(bulk(), [file('a.ttml', TTML('Paper Lanterns', 'Mira Vale'))], { applyAccept: false })
    await waitFor(() => expect(screen.getByTestId('bulk-row').dataset.status).toBe('ready'))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Save a.ttml' }))
    expect(screen.getByRole('button', { name: 'Save 0' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Select auto matches' }))
    expect(screen.getByRole('button', { name: 'Save 1' })).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: 'Remove a.ttml' }))
    expect(screen.queryAllByTestId('bulk-row')).toHaveLength(0)
  })

  it('shows a search failure on the row and still lets the user pick a track', async () => {
    render(<LyricsTab />)
    await screen.findByText('Paper Lanterns')
    const original = h.api.adminTracks.getMockImplementation()!
    h.api.adminTracks.mockImplementation(async (opts: { q?: string; limit?: number; lyrics?: 'missing' | 'present' }) => {
      if (opts.q === 'Mira Vale Paper Lanterns') throw new Error('search is down')
      return original(opts)
    })
    await userEvent.upload(bulk(), file('a.ttml', TTML('Paper Lanterns', 'Mira Vale')), { applyAccept: false })
    await waitFor(() => expect(screen.getByTestId('bulk-row').dataset.status).toBe('ready'))
    expect(screen.getByText(/Search failed: search is down/)).toBeInTheDocument()
  })
})
