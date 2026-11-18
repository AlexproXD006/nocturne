import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { EqPresetInput, EqPresetWire, EqStateWire } from '../api/types'
import { readJson, writeJson } from '../lib/storage'
import {
  builtinPreset,
  clampGain,
  clampPreamp,
  DEFAULT_EQ,
  isCustomId,
  presetToState,
  sameGains,
  sanitizeEq,
  sanitizeGains,
  suggestPreamp,
  type CustomPreset,
  type EqState
} from '../lib/eq'

/** The slice of ApiClient this store uses. */
export interface EqApi {
  eqState(signal?: AbortSignal): Promise<EqStateWire>
  putEqState(state: EqState): Promise<EqStateWire>
  eqPresets(signal?: AbortSignal): Promise<{ items: EqPresetWire[] }>
  createEqPreset(input: EqPresetInput): Promise<EqPresetWire>
  updateEqPreset(id: string, patch: Partial<EqPresetInput>): Promise<EqPresetWire>
  deleteEqPreset(id: string): Promise<void>
}

export interface EqDeps {
  api: EqApi
  /** Pushes the state to the audio path (Web Audio graph or the Android service). */
  apply(state: EqState): void
  /** Quiet period before a burst of edits is sent to the server. */
  saveDelayMs?: number
}

export interface EqStore extends EqState {
  presets: CustomPreset[]
  /** Keep the preamp at the automatic headroom while editing bands (turned off by moving the preamp by hand). */
  autoHeadroom: boolean
  /** The server answered at least once this session. */
  synced: boolean
  /** Local changes the server has not accepted yet. */
  unsynced: boolean
  /** The snapshot applied to audio. */
  snapshot(): EqState
  load(): Promise<void>
  setEnabled(enabled: boolean): void
  setGain(band: number, gain: number): void
  setPreamp(preamp: number): void
  /** Sets the preamp to the automatic headroom and keeps it following edits. */
  autoPreamp(): void
  selectBuiltin(id: string): void
  selectCustom(id: string): void
  /** Saves the current curve as a new custom preset and selects it. Rejects on server errors. */
  createPreset(name: string): Promise<CustomPreset>
  renamePreset(id: string, name: string): Promise<void>
  duplicatePreset(id: string, name: string): Promise<CustomPreset>
  deletePreset(id: string): Promise<void>
  /** Writes the current curve into the selected custom preset. */
  updatePreset(id: string): Promise<void>
  /** Forgets everything (sign-out); the audio goes back to flat. */
  reset(): void
}

const KEY = 'nocturne.eq.v1'

interface Cache {
  state: EqState
  presets: CustomPreset[]
  autoHeadroom: boolean
  unsynced: boolean
}

function toPreset(w: EqPresetWire): CustomPreset {
  return { id: w.id, name: w.name, preamp: clampPreamp(w.preamp), gains: sanitizeGains(w.gains) }
}

function loadCache(): Cache {
  const raw = readJson<Record<string, unknown>>(KEY, {})
  const presets = Array.isArray(raw.presets)
    ? (raw.presets as unknown[])
        .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && typeof (p as { id?: unknown }).id === 'string')
        .map((p) => ({ id: String(p.id), name: typeof p.name === 'string' ? p.name : '', preamp: clampPreamp(Number(p.preamp)), gains: sanitizeGains(p.gains) }))
    : []
  return {
    state: raw.state ? sanitizeEq(raw.state) : { ...DEFAULT_EQ, gains: [...DEFAULT_EQ.gains] },
    presets,
    autoHeadroom: raw.autoHeadroom !== false,
    unsynced: raw.unsynced === true
  }
}

export function createEqStore(deps: EqDeps): UseBoundStore<StoreApi<EqStore>> {
  const delay = deps.saveDelayMs ?? 500
  const cache = loadCache()
  let timer: ReturnType<typeof setTimeout> | null = null
  let saving = false
  let resave = false

  const store = create<EqStore>((set, get) => {
    const snap = (): EqState => {
      const s = get()
      return { enabled: s.enabled, preamp: s.preamp, gains: s.gains, presetId: s.presetId }
    }
    const persist = (): void => {
      const s = get()
      writeJson(KEY, { state: snap(), presets: s.presets, autoHeadroom: s.autoHeadroom, unsynced: s.unsynced } satisfies Cache)
    }
    const commit = (patch: Partial<EqStore>, sync = true): void => {
      set(patch)
      if (sync) set({ unsynced: true })
      persist()
      deps.apply(snap())
      if (sync) schedule()
    }
    const schedule = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void flush(), delay)
    }
    const flush = async (): Promise<void> => {
      timer = null
      if (saving) {
        resave = true
        return
      }
      saving = true
      try {
        const sent = snap()
        await deps.api.putEqState(sent)
        const now = snap()
        const changed = now.enabled !== sent.enabled || now.preamp !== sent.preamp || now.presetId !== sent.presetId || !sameGains(now.gains, sent.gains)
        set({ synced: true, unsynced: changed })
        persist()
        if (changed) resave = true
      } catch {
        // Offline or server error: the change stays local (`unsynced`) and goes up on the next edit or load.
      } finally {
        saving = false
        if (resave) {
          resave = false
          schedule()
        }
      }
    }
    const editCurve = (gains: number[], preamp: number): void => {
      const cur = get().presetId
      // Editing a built-in preset makes it a custom curve; a saved custom preset stays selected (shown as modified).
      commit({ gains, preamp, presetId: isCustomId(cur) ? cur : null })
    }

    return {
      ...cache.state,
      presets: cache.presets,
      autoHeadroom: cache.autoHeadroom,
      synced: false,
      unsynced: cache.unsynced,
      snapshot: snap,

      async load() {
        let remote: EqStateWire
        let presets: EqPresetWire[]
        try {
          ;[remote, presets] = await Promise.all([deps.api.eqState(), deps.api.eqPresets().then((r) => r.items)])
        } catch {
          return // offline / old server: keep the local copy
        }
        const list = presets.map(toPreset)
        const local = snap()
        const neverSaved = remote.updatedAt === null
        const localIsDefault = local.enabled && local.preamp === 0 && local.presetId === 'flat' && sameGains(local.gains, DEFAULT_EQ.gains)
        if (get().unsynced || (neverSaved && !localIsDefault)) {
          // This device has newer / first-time settings: keep them and push them up.
          set({ presets: list, synced: true })
          persist()
          deps.apply(snap())
          schedule()
          return
        }
        const next = sanitizeEq(remote)
        set({ ...next, presets: list, synced: true, unsynced: false })
        persist()
        deps.apply(snap())
      },

      setEnabled(enabled) {
        commit({ enabled })
      },
      setGain(band, gain) {
        if (!Number.isInteger(band) || band < 0 || band >= DEFAULT_EQ.gains.length) return
        const gains = [...get().gains]
        const v = clampGain(gain)
        if (gains[band] === v) return
        gains[band] = v
        editCurve(gains, get().autoHeadroom ? suggestPreamp(gains) : get().preamp)
      },
      setPreamp(preamp) {
        const v = clampPreamp(preamp)
        if (v === get().preamp && !get().autoHeadroom) return
        const cur = get().presetId
        commit({ preamp: v, autoHeadroom: false, presetId: isCustomId(cur) ? cur : null })
      },
      autoPreamp() {
        commit({ preamp: suggestPreamp(get().gains), autoHeadroom: true })
      },
      selectBuiltin(id) {
        const p = builtinPreset(id)
        if (!p) return
        const s = presetToState(p, get().enabled)
        commit({ gains: s.gains, preamp: s.preamp, presetId: s.presetId })
      },
      selectCustom(id) {
        const p = get().presets.find((x) => x.id === id)
        if (!p) return
        commit({ gains: [...p.gains], preamp: p.preamp, presetId: p.id })
      },

      async createPreset(name) {
        const s = get()
        const created = toPreset(await deps.api.createEqPreset({ name, preamp: s.preamp, gains: s.gains }))
        commit({ presets: [...get().presets, created], gains: [...created.gains], preamp: created.preamp, presetId: created.id })
        return created
      },
      async renamePreset(id, name) {
        const updated = toPreset(await deps.api.updateEqPreset(id, { name }))
        commit({ presets: get().presets.map((p) => (p.id === id ? updated : p)) }, false)
      },
      async duplicatePreset(id, name) {
        const src = get().presets.find((p) => p.id === id)
        if (!src) throw new Error('preset not found')
        const created = toPreset(await deps.api.createEqPreset({ name, preamp: src.preamp, gains: src.gains }))
        commit({ presets: [...get().presets, created], gains: [...created.gains], preamp: created.preamp, presetId: created.id })
        return created
      },
      async deletePreset(id) {
        await deps.api.deleteEqPreset(id)
        const was = get().presetId === id
        commit({ presets: get().presets.filter((p) => p.id !== id), ...(was ? { presetId: null } : {}) }, was)
      },
      async updatePreset(id) {
        const s = get()
        const updated = toPreset(await deps.api.updateEqPreset(id, { preamp: s.preamp, gains: s.gains }))
        commit({ presets: get().presets.map((p) => (p.id === id ? updated : p)) }, false)
      },

      reset() {
        if (timer) clearTimeout(timer)
        timer = null
        const flat = { ...DEFAULT_EQ, gains: [...DEFAULT_EQ.gains] }
        set({ ...flat, presets: [], autoHeadroom: true, synced: false, unsynced: false })
        persist()
        deps.apply(snap())
      }
    }
  })
  return store
}

/** True when the selected custom preset differs from the live curve (the page offers "Save changes"). */
export function isPresetDirty(s: Pick<EqStore, 'presetId' | 'presets' | 'gains' | 'preamp'>): boolean {
  if (!isCustomId(s.presetId)) return false
  const p = s.presets.find((x) => x.id === s.presetId)
  return !!p && (p.preamp !== s.preamp || !sameGains(p.gains, s.gains))
}
