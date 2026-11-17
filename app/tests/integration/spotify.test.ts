// @vitest-environment node
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/* eslint-disable @typescript-eslint/no-explicit-any */
// Same approach as playlists.test.ts: renderer modules are loaded by absolute path.
const SERVER_FILE = resolve(__dirname, '../../mock-server/server.mjs')
const RENDERER = resolve(__dirname, '../../src/renderer/src')
const available = existsSync(SERVER_FILE)

const { ApiClient, ServerApi } = (await import(/* @vite-ignore */ `${RENDERER}/api/client.ts`)) as any

describe.skipIf(!available)('mock server: Spotify import (real ApiClient over HTTP)', () => {
  let mock: any
  let url: string
  let api: any
  let guest: any

  const clientFor = async (user: string, pass: string): Promise<any> => {
    const holder = { current: await ServerApi.login(url, user, pass, fetch) }
    return new ApiClient({ getSession: () => holder.current, setSession: (s: any) => (holder.current = s), fetch: (...a: Parameters<typeof fetch>) => fetch(...a), timeoutMs: 10_000 })
  }

  beforeAll(async () => {
    const { createMockServer } = (await import(/* @vite-ignore */ pathToFileURL(SERVER_FILE).href)) as any
    mock = createMockServer({ quiet: true, jobTickMs: 0, loginLimit: { max: 0, windowMs: 60_000 } })
    url = (await mock.listen(0)).url
    api = await clientFor('demo', 'demo')
    guest = await clientFor('guest', 'guestguest')
  })

  afterAll(async () => {
    await mock.close()
  })

  it('advertises the capability', async () => {
    expect((await api.serverInfo()).capabilities.spotifyImport).toBe(true)
  })

  it('requires a connection, then connects through the mock login page', async () => {
    expect(await api.spotifyStatus()).toEqual({ configured: true, connected: false })
    await expect(api.spotifyPlaylists()).rejects.toMatchObject({ status: 409 })
    await expect(api.spotifyStartImport({ playlist: 'x'.repeat(22) })).rejects.toMatchObject({ status: 409 })

    const { url: login } = await api.spotifyAuthorize()
    expect(login).toMatch(/\/v1\/spotify\/mock-login\?state=[0-9a-f]+$/)
    const page = await fetch(login)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('go back to Nocturne')
    expect((await fetch(login)).status).toBe(400) // single use

    const status = await api.spotifyStatus()
    expect(status).toMatchObject({ configured: true, connected: true, account: { id: 'demo-spotify' } })
    const days = (Date.parse(status.expiresAt) - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(179)
    expect(await guest.spotifyStatus()).toMatchObject({ connected: false })
  })

  it('lists playlists and runs an import to completion, filling a real playlist', async () => {
    const list = await api.spotifyPlaylists()
    const favs = list.find((p: any) => p.name === 'Favs 2.0')
    expect(favs).toMatchObject({ trackCount: 48, image: expect.stringContaining('/art/spotify/') })
    expect((await fetch(favs.image)).status).toBe(200)

    const started = await api.spotifyStartImport({ playlist: `https://open.spotify.com/playlist/${favs.id}?si=abc` })
    expect(started).toMatchObject({ status: 'queued', spotifyPlaylist: { id: favs.id, name: 'Favs 2.0' } })
    await expect(api.spotifyStartImport({ playlist: favs.id })).rejects.toMatchObject({ status: 409 })

    const statuses = new Set<string>()
    let cur = started
    for (let i = 0; i < 40 && cur.status !== 'done'; i++) {
      mock.advanceSpotify(1)
      cur = await api.spotifyImport(started.id)
      statuses.add(cur.status)
      expect(cur.matched + cur.downloaded + cur.failed + cur.pending).toBe(cur.total)
    }
    expect([...statuses]).toEqual(expect.arrayContaining(['reading', 'matching', 'downloading', 'done']))
    expect(cur).toMatchObject({ status: 'done', total: 48, pending: 0, playlistId: expect.any(String), finishedAt: expect.any(String) })
    expect(cur.failures).toHaveLength(cur.failed)

    const pl = await api.playlist(cur.playlistId)
    expect(pl).toMatchObject({ name: 'Favs 2.0', editable: true })
    expect(pl.tracks.length).toBeGreaterThan(0)
    expect((await api.spotifyImports())[0].id).toBe(started.id)
    await expect(api.spotifyCancelImport(started.id)).rejects.toMatchObject({ status: 409 })
  })

  it('without downloads, missing songs are reported as not found', async () => {
    const list = await api.spotifyPlaylists()
    const gym = list.find((p: any) => p.name === 'Gym Rotation')
    const started = await api.spotifyStartImport({ playlist: gym.id, download: false })
    mock.advanceSpotify(20)
    const done = await api.spotifyImport(started.id)
    expect(done).toMatchObject({ status: 'done', downloaded: 0 })
    expect(done.matched + done.failed).toBe(done.total)
  })

  it('cancels, validates input and keeps imports per user', async () => {
    const started = await api.spotifyStartImport({ playlist: `spotify:playlist:${'Q'.repeat(22)}` })
    await expect(api.spotifyCancelImport(started.id)).resolves.toBeUndefined()
    expect(await api.spotifyImport(started.id)).toMatchObject({ status: 'cancelled' })
    await expect(api.spotifyStartImport({ playlist: 'https://example.com/x' })).rejects.toMatchObject({ status: 400 })
    await expect(api.spotifyStartImport({ playlist: `missing${'0'.repeat(20)}` })).rejects.toMatchObject({ status: 404 })
    await expect(guest.spotifyImport(started.id)).rejects.toMatchObject({ code: 'not_found' })
    expect(await guest.spotifyImports()).toEqual([])
  })

  it('disconnects', async () => {
    await expect(api.spotifyDisconnect()).resolves.toBeUndefined()
    expect(await api.spotifyStatus()).toMatchObject({ connected: false })
  })
})
