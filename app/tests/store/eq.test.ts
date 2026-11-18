import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEqStore, isPresetDirty, type EqApi } from '@/store/eq'
import { ApiError } from '@/api/errors'
import type { EqPresetWire, EqStateWire } from '@/api/types'
import { BUILTIN_PRESETS, DEFAULT_EQ, isClippingRisk } from '@/lib/eq'

const G0 = new Array<number>(10).fill(0)
const wire = (over: Partial<EqStateWire> = {}): EqStateWire => ({ enabled: true, preamp: 0, gains: [...G0], presetId: 'flat', updatedAt: null, ...over })
let n = 0
const preset = (over: Partial<EqPresetWire> = {}): EqPresetWire => ({ id: `custom:${++n}`, name: 'P', preamp: 0, gains: [...G0], createdAt: 'a', updatedAt: 'a', ...over })

function setup(remote: EqStateWire = wire(), presets: EqPresetWire[] = []) {
  const api = {
    eqState: vi.fn(async () => remote),
    putEqState: vi.fn(async (s: unknown) => ({ ...(s as object), updatedAt: 'now' }) as EqStateWire),
    eqPresets: vi.fn(async () => ({ items: presets })),
    createEqPreset: vi.fn(async (i: { name: string; preamp: number; gains: number[] }) => preset(i)),
    updateEqPreset: vi.fn(async (id: string, p: object) => preset({ id, ...p })),
    deleteEqPreset: vi.fn(async () => undefined)
  } satisfies EqApi
  const apply = vi.fn()
  const store = createEqStore({ api, apply, saveDelayMs: 100 })
  return { api, apply, store }
}

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
})

describe('eq store: editing', () => {
  it('starts flat and enabled', () => {
    const { store } = setup()
    expect(store.getState().snapshot()).toEqual({ ...DEFAULT_EQ })
  })

  it('setGain applies at once, snaps/clamps, switches off the built-in preset and follows automatic headroom', () => {
    const { store, apply } = setup()
    store.getState().selectBuiltin('rock')
    store.getState().setGain(5, 99)
    const s = store.getState()
    expect(s.gains[5]).toBe(12)
    expect(s.presetId).toBeNull()
    expect(s.preamp).toBeLessThan(0)
    expect(isClippingRisk(s.gains, s.preamp)).toBe(false)
    expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({ presetId: null }))
    store.getState().setGain(99, 3) // out-of-range band ignored
    store.getState().setGain(-1, 3)
    expect(store.getState().gains).toHaveLength(10)
  })

  it('moving the preamp by hand disables automatic headroom; Auto re-enables it', () => {
    const { store } = setup()
    store.getState().setGain(3, 6)
    const auto = store.getState().preamp
    store.getState().setPreamp(-1)
    expect(store.getState().autoHeadroom).toBe(false)
    store.getState().setGain(3, 8)
    expect(store.getState().preamp).toBe(-1)
    store.getState().autoPreamp()
    expect(store.getState().autoHeadroom).toBe(true)
    expect(store.getState().preamp).toBeLessThan(auto)
  })

  it('selectBuiltin loads the curve with its headroom; unknown ids are ignored', () => {
    const { store } = setup()
    store.getState().selectBuiltin('bass-boost')
    const bb = BUILTIN_PRESETS.find((p) => p.id === 'bass-boost')!
    expect(store.getState().gains).toEqual([...bb.gains])
    expect(store.getState().presetId).toBe('bass-boost')
    store.getState().selectBuiltin('nope')
    expect(store.getState().presetId).toBe('bass-boost')
  })

  it('setEnabled toggles without touching the curve', () => {
    const { store, apply } = setup()
    store.getState().selectBuiltin('pop')
    store.getState().setEnabled(false)
    expect(store.getState().enabled).toBe(false)
    expect(store.getState().presetId).toBe('pop')
    expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }))
  })
})

describe('eq store: server sync', () => {
  it('debounces edits into one PUT with the final state', async () => {
    const { store, api } = setup()
    store.getState().setGain(0, 3)
    store.getState().setGain(0, 4)
    store.getState().setGain(1, 2)
    expect(api.putEqState).not.toHaveBeenCalled()
    expect(store.getState().unsynced).toBe(true)
    await vi.advanceTimersByTimeAsync(150)
    expect(api.putEqState).toHaveBeenCalledOnce()
    expect(api.putEqState).toHaveBeenCalledWith(expect.objectContaining({ gains: expect.arrayContaining([4, 2]), enabled: true }))
    expect(store.getState().unsynced).toBe(false)
    expect(store.getState().synced).toBe(true)
  })

  it('keeps local changes when the server is unreachable and retries on load', async () => {
    const { store, api } = setup(wire({ gains: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], presetId: null, updatedAt: 't' }))
    api.putEqState.mockRejectedValueOnce(new ApiError('network', 'down'))
    store.getState().setGain(2, 5)
    await vi.advanceTimersByTimeAsync(150)
    expect(store.getState().unsynced).toBe(true)
    await store.getState().load()
    // local edits win over the stale server copy and are pushed up again
    expect(store.getState().gains[2]).toBe(5)
    await vi.advanceTimersByTimeAsync(150)
    expect(api.putEqState).toHaveBeenCalledTimes(2)
    expect(store.getState().unsynced).toBe(false)
  })

  it('load adopts the server state and presets and applies them', async () => {
    const p = preset({ name: 'Mine', gains: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] })
    const { store, apply } = setup(wire({ enabled: false, preamp: -2, gains: [3, 0, 0, 0, 0, 0, 0, 0, 0, 0], presetId: null, updatedAt: 't' }), [p])
    await store.getState().load()
    const s = store.getState()
    expect(s.enabled).toBe(false)
    expect(s.preamp).toBe(-2)
    expect(s.gains[0]).toBe(3)
    expect(s.presets).toEqual([{ id: p.id, name: 'Mine', preamp: 0, gains: p.gains }])
    expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false, preamp: -2 }))
  })

  it('uploads a first-time local curve when the server has never stored one', async () => {
    const { store, api } = setup(wire({ updatedAt: null }))
    store.getState().selectBuiltin('rock')
    await vi.advanceTimersByTimeAsync(150)
    api.putEqState.mockClear()
    // simulate an app restart with the cache but a server that still reports "never saved"
    const again = createEqStore({ api, apply: vi.fn(), saveDelayMs: 100 })
    expect(again.getState().presetId).toBe('rock')
    await again.getState().load()
    expect(again.getState().presetId).toBe('rock')
  })

  it('survives an unreachable server on load (cached copy stays)', async () => {
    const { store, api } = setup()
    store.getState().selectBuiltin('jazz')
    api.eqState.mockRejectedValueOnce(new ApiError('network', 'down'))
    await store.getState().load()
    expect(store.getState().presetId).toBe('jazz')
  })

  it('restores from the local cache at startup', () => {
    const a = setup()
    a.store.getState().setEnabled(false)
    a.store.getState().selectBuiltin('car')
    const b = createEqStore({ api: a.api, apply: vi.fn() })
    expect(b.getState().presetId).toBe('car')
    expect(b.getState().enabled).toBe(false)
  })

  it('reset (sign-out) goes back to flat and forgets presets', async () => {
    const { store, apply } = setup(wire(), [preset()])
    await store.getState().load()
    store.getState().selectBuiltin('rock')
    store.getState().reset()
    expect(store.getState().presets).toEqual([])
    expect(store.getState().presetId).toBe('flat')
    expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({ presetId: 'flat', preamp: 0 }))
  })
})

describe('eq store: custom presets', () => {
  it('creates from the current curve and selects it', async () => {
    const { store, api } = setup()
    store.getState().setGain(4, 3)
    const cur = store.getState()
    const created = await store.getState().createPreset('Mi curva')
    expect(api.createEqPreset).toHaveBeenCalledWith({ name: 'Mi curva', preamp: cur.preamp, gains: cur.gains })
    expect(store.getState().presets).toHaveLength(1)
    expect(store.getState().presetId).toBe(created.id)
  })

  it('does not change local state when the server rejects the create', async () => {
    const { store, api } = setup()
    api.createEqPreset.mockRejectedValueOnce(new ApiError('server', 'too many'))
    await expect(store.getState().createPreset('x')).rejects.toBeTruthy()
    expect(store.getState().presets).toEqual([])
  })

  it('renames, duplicates, selects, tracks modification, saves changes and deletes', async () => {
    const { store, api } = setup()
    store.getState().setGain(0, 4)
    const a = await store.getState().createPreset('A')
    await store.getState().renamePreset(a.id, 'Renamed')
    expect(api.updateEqPreset).toHaveBeenCalledWith(a.id, { name: 'Renamed' })
    expect(store.getState().presets[0]!.name).toBe('Renamed')

    const b = await store.getState().duplicatePreset(a.id, 'Renamed (copy)')
    expect(store.getState().presets).toHaveLength(2)
    expect(store.getState().presetId).toBe(b.id)

    store.getState().selectCustom(a.id)
    expect(store.getState().presetId).toBe(a.id)
    expect(isPresetDirty(store.getState())).toBe(false)
    store.getState().setGain(7, -3)
    expect(store.getState().presetId).toBe(a.id) // stays selected, shown as modified
    expect(isPresetDirty(store.getState())).toBe(true)
    await store.getState().updatePreset(a.id)
    expect(api.updateEqPreset).toHaveBeenLastCalledWith(a.id, expect.objectContaining({ gains: store.getState().gains }))
    expect(isPresetDirty(store.getState())).toBe(false)

    await store.getState().deletePreset(a.id)
    expect(store.getState().presets.map((p) => p.id)).toEqual([b.id])
    expect(store.getState().presetId).toBeNull()
    store.getState().selectCustom('custom:missing')
    expect(store.getState().presetId).toBeNull()
  })

  it('isPresetDirty is false for built-ins and unknown ids', () => {
    expect(isPresetDirty({ presetId: 'rock', presets: [], gains: G0, preamp: 0 })).toBe(false)
    expect(isPresetDirty({ presetId: 'custom:x', presets: [], gains: G0, preamp: 0 })).toBe(false)
  })
})
