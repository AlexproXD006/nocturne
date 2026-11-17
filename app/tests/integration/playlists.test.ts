// @vitest-environment node
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/* eslint-disable @typescript-eslint/no-explicit-any */
// Same approach as mock-server.test.ts: renderer modules are loaded by absolute path.
const SERVER_FILE = resolve(__dirname, '../../mock-server/server.mjs')
const RENDERER = resolve(__dirname, '../../src/renderer/src')
const available = existsSync(SERVER_FILE)

const { ApiClient, ServerApi } = (await import(/* @vite-ignore */ `${RENDERER}/api/client.ts`)) as any

describe.skipIf(!available)('mock server: playlist editing (real ApiClient over HTTP)', () => {
  let mock: any
  let url: string
  let api: any
  let guest: any
  let trackIds: string[]

  const clientFor = async (user: string, pass: string): Promise<any> => {
    const holder = { current: await ServerApi.login(url, user, pass, fetch) }
    return new ApiClient({ getSession: () => holder.current, setSession: (s: any) => (holder.current = s), fetch: (...a: Parameters<typeof fetch>) => fetch(...a), timeoutMs: 10_000 })
  }

  beforeAll(async () => {
    const { createMockServer } = (await import(/* @vite-ignore */ pathToFileURL(SERVER_FILE).href)) as any
    mock = createMockServer({ quiet: true, loginLimit: { max: 0, windowMs: 60_000 } })
    url = (await mock.listen(0)).url
    api = await clientFor('demo', 'demo')
    guest = await clientFor('guest', 'guestguest')
    trackIds = mock.catalog.tracks.slice(0, 4).map((t: any) => t.id)
  })

  afterAll(async () => {
    await mock.close()
  })

  it('advertises the playlists capability', async () => {
    expect((await api.serverInfo()).capabilities.playlists).toBe(true)
  })

  it('runs the full create → add → reorder → remove → rename → delete flow', async () => {
    const created = await api.createPlaylist({ name: '  Road trip ', trackIds: [trackIds[0]] })
    expect(created).toMatchObject({ name: 'Road trip', editable: true, trackCount: 1 })
    expect(created.tracks.map((t: any) => t.id)).toEqual([trackIds[0]])

    const lib = await api.libraryPlaylists(0, 50)
    expect(lib.items[0]).toMatchObject({ id: created.id, editable: true })
    expect(lib.items.slice(1).every((p: any) => p.editable === false)).toBe(true)

    const added = await api.addToPlaylist(created.id, trackIds)
    expect(added).toMatchObject({ added: 3, skipped: [trackIds[0]], playlist: { trackCount: 4 } })

    const reversed = [...trackIds].reverse()
    expect((await api.reorderPlaylist(created.id, reversed)).tracks.map((t: any) => t.id)).toEqual(reversed)
    await expect(api.reorderPlaylist(created.id, trackIds.slice(1))).rejects.toMatchObject({ code: 'bad_request' })

    await expect(api.removeFromPlaylist(created.id, trackIds[2])).resolves.toBeUndefined()
    expect((await api.playlist(created.id)).tracks.map((t: any) => t.id)).toEqual(reversed.filter((id) => id !== trackIds[2]))

    expect(await api.updatePlaylist(created.id, { name: 'Night drive', description: 'Late' })).toMatchObject({ name: 'Night drive', description: 'Late' })

    await expect(guest.playlist(created.id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(guest.deletePlaylist(created.id)).rejects.toMatchObject({ code: 'not_found' })

    await expect(api.deletePlaylist(created.id)).resolves.toBeUndefined()
    await expect(api.playlist(created.id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('keeps the same song more than once, with one entry id per occurrence', async () => {
    const [a, b] = trackIds as [string, string]
    const created = await api.createPlaylist({ name: 'Dupes', trackIds: [a, b] })
    expect(created.tracks.every((t: any) => typeof t.entryId === 'string')).toBe(true)

    // Default: already-present songs are skipped.
    expect(await api.addToPlaylist(created.id, [a])).toMatchObject({ added: 0, skipped: [a] })
    // allowDuplicates: appended again as a new entry.
    expect(await api.addToPlaylist(created.id, [a], { allowDuplicates: true })).toMatchObject({ added: 1, skipped: [], playlist: { trackCount: 3 } })
    let pl = await api.playlist(created.id)
    expect(pl.tracks.map((t: any) => t.id)).toEqual([a, b, a])
    const [e1, e2, e3] = pl.tracks.map((t: any) => t.entryId)
    expect(new Set([e1, e2, e3]).size).toBe(3)
    // Entry ids are stable across reads.
    expect((await api.playlist(created.id)).tracks.map((t: any) => t.entryId)).toEqual([e1, e2, e3])

    // Reorder by entry ids: only the chosen occurrence moves.
    pl = await api.reorderPlaylist(created.id, [pl.tracks[2], pl.tracks[0], pl.tracks[1]])
    expect(pl.tracks.map((t: any) => t.entryId)).toEqual([e3, e1, e2])
    await expect(api.reorderPlaylist(created.id, [{ id: a, entryId: e1 }, { id: b, entryId: e2 }, { id: a, entryId: 'nope' }])).rejects.toMatchObject({
      code: 'bad_request'
    })
    await expect(api.reorderPlaylist(created.id, [{ id: a, entryId: e1 }, { id: a, entryId: e1 }, { id: b, entryId: e2 }])).rejects.toMatchObject({
      code: 'bad_request'
    })

    // Legacy reorder by song ids still works with duplicates and keeps the entry ids.
    pl = await api.reorderPlaylist(created.id, [b, a, a])
    expect(pl.tracks.map((t: any) => t.id)).toEqual([b, a, a])
    expect(pl.tracks.map((t: any) => t.entryId)).toEqual([e2, e3, e1])

    // Removing one entry leaves the other copy.
    await expect(api.removePlaylistEntry(created.id, e3)).resolves.toBeUndefined()
    pl = await api.playlist(created.id)
    expect(pl.tracks.map((t: any) => t.entryId)).toEqual([e2, e1])
    await expect(api.removePlaylistEntry(created.id, e3)).rejects.toMatchObject({ code: 'not_found' })

    // The legacy track delete removes every occurrence.
    await api.addToPlaylist(created.id, [a], { allowDuplicates: true })
    expect((await api.playlist(created.id)).tracks.map((t: any) => t.id)).toEqual([b, a, a])
    await api.removeFromPlaylist(created.id, a)
    expect((await api.playlist(created.id)).tracks.map((t: any) => t.id)).toEqual([b])

    await expect(guest.removePlaylistEntry(created.id, e2)).rejects.toMatchObject({ code: 'not_found' })
    await api.deletePlaylist(created.id)
  })

  it('rejects bad input and edits to shared playlists', async () => {
    await expect(api.createPlaylist({ name: '   ' })).rejects.toMatchObject({ code: 'bad_request' })
    await expect(api.createPlaylist({ name: 'x'.repeat(101) })).rejects.toMatchObject({ code: 'bad_request' })
    await expect(api.createPlaylist({ name: 'ok', description: 'x'.repeat(301) })).rejects.toMatchObject({ code: 'bad_request' })
    await expect(api.createPlaylist({ name: 'ok', trackIds: ['nope'] })).rejects.toMatchObject({ code: 'bad_request' })
    const shared = mock.catalog.playlists.find((p: any) => !p.ownerId)
    await expect(api.addToPlaylist(shared.id, trackIds)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(api.deletePlaylist(shared.id)).rejects.toMatchObject({ code: 'forbidden' })
  })
})
