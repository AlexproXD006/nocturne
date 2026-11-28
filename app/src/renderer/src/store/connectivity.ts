import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { computeOnline, isNetworkFailure } from '../lib/offline/connectivity'

export interface ConnectivityState {
  browser: boolean
  native: boolean | null
  /** Unmetered (Wi-Fi) network; null when unknown. */
  unmetered: boolean | null
  apiReachable: boolean
  online: boolean
  setBrowser(online: boolean): void
  setNative(online: boolean, unmetered: boolean): void
  /** Call with the outcome of an API request: `null` = success, anything else = the thrown error. */
  report(err: unknown | null): void
  /** Asks the server now (used while offline, to notice that it is back). */
  probe(): Promise<void>
}

export interface ConnectivityDeps {
  browserOnline(): boolean
  /** Resolves when the server answers (any HTTP answer counts). */
  ping(): Promise<void>
  /** Milliseconds between probes while the server is unreachable. */
  probeEveryMs?: number
}

export function createConnectivityStore(deps: ConnectivityDeps): UseBoundStore<StoreApi<ConnectivityState>> {
  let timer: ReturnType<typeof setInterval> | null = null
  const every = deps.probeEveryMs ?? 15_000

  const store = create<ConnectivityState>((set, get) => {
    const apply = (patch: Partial<Pick<ConnectivityState, 'browser' | 'native' | 'unmetered' | 'apiReachable'>>): void => {
      const next = { ...get(), ...patch }
      const online = computeOnline({ browser: next.browser, native: next.native, apiReachable: next.apiReachable })
      set({ ...patch, online })
      if (!online && !timer && next.apiReachable === false && (next.native ?? next.browser)) {
        timer = setInterval(() => void get().probe(), every)
      } else if (online && timer) {
        clearInterval(timer)
        timer = null
      }
    }
    const browser = deps.browserOnline()
    return {
      browser,
      native: null,
      unmetered: null,
      apiReachable: true,
      online: browser,
      setBrowser: (online) => apply({ browser: online, ...(online ? {} : { apiReachable: get().apiReachable }) }),
      setNative: (online, unmetered) => apply({ native: online, unmetered }),
      report(err) {
        if (err === null) {
          if (!get().apiReachable) apply({ apiReachable: true })
        } else if (isNetworkFailure(err) && get().apiReachable) {
          apply({ apiReachable: false })
        }
      },
      async probe() {
        try {
          await deps.ping()
          get().report(null)
        } catch (e) {
          // Any answer from the server (even an error status) means it is reachable.
          if (!isNetworkFailure(e)) get().report(null)
        }
      }
    }
  })
  return store
}
