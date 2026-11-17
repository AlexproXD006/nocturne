// @vitest-environment node
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/* eslint-disable @typescript-eslint/no-explicit-any */
const SERVER_FILE = resolve(__dirname, '../../mock-server/server.mjs')
const RENDERER = resolve(__dirname, '../../src/renderer/src')
const available = existsSync(SERVER_FILE)

const { ApiClient, ServerApi } = (await import(/* @vite-ignore */ `${RENDERER}/api/client.ts`)) as any
const { resolveTracks } = (await import(/* @vite-ignore */ `${RENDERER}/player/resolveTracks.ts`)) as any

/** Minimal SSE reader over fetch (Node has no EventSource): yields parsed `data:` events. */
async function openEvents(url: string): Promise<{ next: () => Promise<any>; close: () => void }> {
  const ctl = new AbortController()
  const res = await fetch(url, { signal: ctl.signal })
  expect(res.status).toBe(200)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const queue: any[] = []
  const next = async (): Promise<any> => {
    for (;;) {
      if (queue.length) return queue.shift()
      const { value, done } = await reader.read()
      if (done) throw new Error('stream closed')
      buf += decoder.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const data = chunk.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n')
        if (data) queue.push(JSON.parse(data))
      }
    }
  }
  return { next, close: () => ctl.abort() }
}

describe.skipIf(!available)('mock server: Nocturne Connect remote playback', () => {
  let mock: any
  let url: string
  let pc: any
  let phone: any

  const clientFor = async (user: string, pass: string): Promise<any> => {
    const holder = { current: await ServerApi.login(url, user, pass, fetch) }
    return new ApiClient({ getSession: () => holder.current, setSession: (s: any) => (holder.current = s), fetch: (...a: Parameters<typeof fetch>) => fetch(...a), timeoutMs: 10_000 })
  }

  beforeAll(async () => {
    const { createMockServer } = (await import(/* @vite-ignore */ pathToFileURL(SERVER_FILE).href)) as any
    mock = createMockServer({ quiet: true, jobTickMs: 0, loginLimit: { max: 0, windowMs: 60_000 } })
    url = (await mock.listen(0)).url
    pc = await clientFor('demo', 'demo')
    phone = await clientFor('demo', 'demo')
  })

  afterAll(async () => {
    await mock.close()
  })

  it('advertises connect and serves single tracks', async () => {
    expect((await pc.serverInfo()).capabilities.connect).toBe(true)
    const id = mock.catalog.tracks[0].id
    expect((await pc.track(id)).id).toBe(id)
    await expect(pc.track('nope')).rejects.toMatchObject({ status: 404 })
  })

  it('delivers playContext / addToQueue / playNext / setVolume to the remote and broadcasts its state', async () => {
    const pcSession = await pc.connectRegister('PC (Windows)', 'desktop', true)
    const phoneSession = await phone.connectRegister('Android phone', 'android', true)
    const pcEvents = await openEvents(await pc.connectEventsUrl(pcSession.id))
    const phoneEvents = await openEvents(await phone.connectEventsUrl(phoneSession.id))
    try {
      const ids = mock.catalog.tracks.slice(0, 5).map((t: any) => t.id)
      await phone.connectCommand(pcSession.id, 'playContext', { context: { type: 'tracks', name: 'Mix' }, trackIds: ids, startIndex: 2, shuffle: false })
      const ev = await pcEvents.next()
      expect(ev).toMatchObject({ type: 'command', kind: 'playContext', payload: { trackIds: ids, startIndex: 2 } })

      await phone.connectCommand(pcSession.id, 'addToQueue', { trackIds: [ids[0]] })
      expect(await pcEvents.next()).toMatchObject({ kind: 'addToQueue' })
      await phone.connectCommand(pcSession.id, 'playNext', { trackIds: [ids[1]] })
      expect(await pcEvents.next()).toMatchObject({ kind: 'playNext' })
      await phone.connectCommand(pcSession.id, 'setVolume', { volume: 0.3 })
      expect(await pcEvents.next()).toMatchObject({ kind: 'setVolume', payload: { volume: 0.3 } })

      // The receiver can turn the ids back into tracks through the API.
      const resolved = await resolveTracks(ids, pc, { context: null })
      expect(resolved.map((t: any) => t?.id)).toEqual(ids)

      // State reported by the PC reaches the phone (the controller) with its session id.
      await pc.connectPutState(pcSession.id, { status: 'playing', volume: 0.3, muted: false, userQueue: [ids[1], ids[0]], upNext: [ids[3]] })
      let st = await phoneEvents.next()
      while (st.type !== 'state') st = await phoneEvents.next()
      expect(st).toMatchObject({ sessionId: pcSession.id, state: { volume: 0.3, userQueue: [ids[1], ids[0]] } })

      // Validation mirrors the server.
      await expect(phone.connectCommand(pcSession.id, 'playContext', { trackIds: [], startIndex: 0 })).rejects.toMatchObject({ status: 400 })
      await expect(phone.connectCommand(pcSession.id, 'playContext', { trackIds: ids, startIndex: 9 })).rejects.toMatchObject({ status: 400 })
      await expect(phone.connectCommand(pcSession.id, 'addToQueue', { trackIds: Array.from({ length: 5001 }, (_, i) => `t${i}`) })).rejects.toMatchObject({ status: 400 })
      await expect(phone.connectCommand(pcSession.id, 'setVolume', { volume: 2 })).rejects.toMatchObject({ status: 400 })
      await expect(phone.connectCommand(pcSession.id, 'selfdestruct')).rejects.toMatchObject({ status: 400 })

      // Rename shows up in the list.
      await pc.connectRename(pcSession.id, 'Studio PC')
      const { sessions } = await phone.connectSessions()
      expect(sessions.find((s: any) => s.id === pcSession.id)).toMatchObject({ name: 'Studio PC', online: true })
    } finally {
      pcEvents.close()
      phoneEvents.close()
    }
  })

  it('reports an offline session with 409', async () => {
    const s = await pc.connectRegister('Old tab', 'web', true)
    await expect(phone.connectCommand(s.id, 'pause')).rejects.toMatchObject({ status: 409 })
  })
})
