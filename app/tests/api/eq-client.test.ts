import { describe, expect, it, vi } from 'vitest'
import { ApiClient, type StoredSession } from '@/api/client'
import { ApiError } from '@/api/errors'
import { storedSession } from '../helpers/fixtures'
import { emptyResponse, fakeFetch, jsonResponse, type FakeFetch } from '../helpers/http'

const BASE = 'https://music.example.com'
const NOW = 1_000_000

function client(f: FakeFetch): ApiClient {
  const session: { current: StoredSession | null } = { current: storedSession({ expiresAt: NOW + 3_600_000 }) }
  return new ApiClient({ getSession: () => session.current, setSession: vi.fn(), fetch: f, now: () => NOW })
}

const G = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

describe('equalizer endpoints', () => {
  it('eqState GETs /v1/me/eq with auth', async () => {
    const body = { enabled: true, preamp: -2, gains: G, presetId: 'rock', updatedAt: 't' }
    const f = fakeFetch(() => jsonResponse(body))
    expect(await client(f).eqState()).toEqual(body)
    expect(f.calls[0]).toMatchObject({ method: 'GET', url: `${BASE}/v1/me/eq` })
    expect(f.calls[0]!.headers.Authorization).toBe('Bearer access-1')
  })

  it('putEqState PUTs the whole state', async () => {
    const state = { enabled: false, preamp: -3, gains: G, presetId: null }
    const f = fakeFetch(() => jsonResponse({ ...state, updatedAt: 'x' }))
    await client(f).putEqState(state)
    expect(f.calls[0]).toMatchObject({ method: 'PUT', url: `${BASE}/v1/me/eq`, body: state })
  })

  it('lists, creates, updates and deletes presets (ids are URL encoded)', async () => {
    const preset = { id: 'custom:abc', name: 'N', preamp: 0, gains: G, createdAt: 'a', updatedAt: 'a' }
    const f = fakeFetch((c) => (c.method === 'DELETE' ? emptyResponse(204) : jsonResponse(c.method === 'GET' ? { items: [preset] } : preset, { status: c.method === 'POST' ? 201 : 200 })))
    const c = client(f)
    expect((await c.eqPresets()).items).toEqual([preset])
    expect(await c.createEqPreset({ name: 'N', preamp: 0, gains: G })).toEqual(preset)
    await c.updateEqPreset('custom:abc', { name: 'M' })
    await expect(c.deleteEqPreset('custom:abc')).resolves.toBeUndefined()
    expect(f.calls.map((x) => [x.method, x.url])).toEqual([
      ['GET', `${BASE}/v1/me/eq/presets`],
      ['POST', `${BASE}/v1/me/eq/presets`],
      ['PUT', `${BASE}/v1/me/eq/presets/custom%3Aabc`],
      ['DELETE', `${BASE}/v1/me/eq/presets/custom%3Aabc`]
    ])
    expect(f.calls[1]!.body).toEqual({ name: 'N', preamp: 0, gains: G })
    expect(f.calls[2]!.body).toEqual({ name: 'M' })
  })

  it('surfaces validation errors as ApiError', async () => {
    const f = fakeFetch(() => jsonResponse({ message: 'gains must be a list of 10 numbers.', code: 'bad_request' }, { status: 400 }))
    await expect(client(f).putEqState({ enabled: true, preamp: 0, gains: [0], presetId: null })).rejects.toBeInstanceOf(ApiError)
  })
})
