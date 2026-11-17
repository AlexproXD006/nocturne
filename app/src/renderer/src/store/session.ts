import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { ApiClient, ServerApi, type StoredSession } from '../api/client'
import { ApiError } from '../api/errors'
import type { ServerInfo } from '../api/types'
import { normalizeServerUrl } from '../lib/url'
import { readJson, writeJson } from '../lib/storage'
import type { SecureStorage } from '../platform'

export type SessionStatus = 'restoring' | 'signedOut' | 'signedIn'

export interface SessionState {
  status: SessionStatus
  session: StoredSession | null
  server: ServerInfo | null
  lastServerUrl: string
  /**
   * Hosted mode only: set when restore() could not reach the server (as opposed to the user simply being
   * signed out), so the UI can show "Can't reach the server". Cleared by a successful restore/login.
   */
  restoreError: string | null
  restore(): Promise<void>
  login(serverUrl: string, username: string, password: string): Promise<void>
  logout(): Promise<void>
  setSession(session: StoredSession | null): void
}

const SECURE_KEY = 'session'
const SERVER_KEY = 'nocturne.server'

export interface SessionDeps {
  secure: SecureStorage
  fetch?: typeof fetch
  now?: () => number
  defaultServer?: string
  /** Hosted web: refresh token lives in an HttpOnly cookie; nothing secret is persisted. */
  cookieSession?: boolean
  /** Hosted web: the only server there is (`location.origin`). Login ignores the address argument. */
  hostedOrigin?: string | null
}

/** True when the signed-in user is an admin AND the connected server implements the admin API. */
export function isAdmin(state: Pick<SessionState, 'session' | 'server'>): boolean {
  return state.session?.user.role === 'admin' && state.server?.capabilities?.admin === true
}

function isStoredSession(v: unknown): v is StoredSession {
  const s = v as StoredSession
  return Boolean(
    s && typeof s.accessToken === 'string' && typeof s.refreshToken === 'string' &&
    typeof s.serverUrl === 'string' && typeof s.expiresAt === 'number' && s.user && typeof s.user.id === 'string'
  )
}

export function createSessionStore(deps: SessionDeps): { useSession: UseBoundStore<StoreApi<SessionState>>; api: ApiClient } {
  const fetchImpl = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const now = deps.now ?? Date.now
  const cookie = deps.cookieSession === true
  const hostedOrigin = deps.hostedOrigin ?? null
  let persistChain: Promise<unknown> = Promise.resolve()
  const persist = (s: StoredSession | null): void => {
    if (cookie) return // the refresh token is an HttpOnly cookie; the access token stays in memory
    const run = (): Promise<void> => (s ? deps.secure.set(SECURE_KEY, JSON.stringify(s)) : deps.secure.delete(SECURE_KEY))
    persistChain = persistChain.then(run, run).catch(() => undefined)
  }

  const useSession = create<SessionState>((set, get) => ({
    status: 'restoring',
    session: null,
    server: null,
    lastServerUrl: hostedOrigin ?? readJson<string>(SERVER_KEY, deps.defaultServer ?? '', (v): v is string => typeof v === 'string'),
    restoreError: null,

    setSession(session) {
      persist(session)
      if (!session) set({ session: null, status: 'signedOut' })
      else set({ session, status: 'signedIn' })
    },

    async restore() {
      if (cookie) {
        await restoreFromCookie()
        return
      }
      let stored: StoredSession | null = null
      try {
        const raw = await deps.secure.get(SECURE_KEY)
        const parsed = raw ? (JSON.parse(raw) as unknown) : null
        stored = isStoredSession(parsed) ? parsed : null
      } catch {
        stored = null
      }
      if (!stored) {
        set({ status: 'signedOut', session: null })
        return
      }
      set({ session: stored, status: 'signedIn' })
      // Validate in the background; a dead refresh token signs the user out.
      // Settle both independently: a failing /v1/me (e.g. an older server that 404s it)
      // must not discard the server info, or capability-gated UI such as the Admin
      // menu disappears until the next sign-in.
      const [info, me] = await Promise.allSettled([ServerApi.info(stored.serverUrl, fetchImpl), api.me()])
      if (info.status === 'fulfilled') set({ server: info.value })
      if (me.status === 'rejected' && me.reason instanceof ApiError && me.reason.code === 'unauthorized') get().setSession(null)
      // Offline etc.: keep the session, the UI will show errors where needed.
    },

    async login(rawUrl, username, password) {
      const serverUrl = hostedOrigin ? hostedOrigin.replace(/\/+$/, '') : normalizeServerUrl(rawUrl)
      if (!username.trim() || !password) throw new Error('Enter your username and password.')
      let server: ServerInfo
      try {
        server = await ServerApi.info(serverUrl, fetchImpl)
      } catch (err) {
        if (err instanceof ApiError && (err.code === 'network' || err.code === 'timeout')) {
          throw new ApiError(err.code, "Couldn't reach that server. Check the address and that it's online.")
        }
        if (err instanceof ApiError && (err.code === 'not_found' || err.code === 'bad_response')) {
          throw new ApiError(err.code, "That address doesn't look like a Nocturne-compatible server.")
        }
        throw err
      }
      if (server.apiVersion !== 1) throw new Error(`Unsupported server API version (${String(server.apiVersion)}).`)
      const session = await ServerApi.login(serverUrl, username.trim(), password, fetchImpl, now(), { cookieSession: cookie })
      if (!hostedOrigin) writeJson(SERVER_KEY, serverUrl)
      set({ server, lastServerUrl: serverUrl, restoreError: null })
      get().setSession(session)
    },

    async logout() {
      try {
        await api.logout()
      } catch {
        /* sign out locally regardless */
      }
      get().setSession(null)
      set({ server: null })
    }
  }))

  async function restoreFromCookie(): Promise<void> {
    const set = useSession.setState
    const origin = hostedOrigin ?? useSession.getState().lastServerUrl
    if (!origin) {
      set({ status: 'signedOut', session: null })
      return
    }
    let session: StoredSession
    try {
      session = await ServerApi.refreshCookie(origin, fetchImpl, now())
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'unauthorized' || err.code === 'forbidden' || err.code === 'bad_request')) {
        set({ status: 'signedOut', session: null, restoreError: null })
      } else {
        const message = err instanceof ApiError ? err.message : "Can't reach the server."
        set({ status: 'signedOut', session: null, restoreError: message, lastServerUrl: origin })
      }
      return
    }
    // The access token is in hand: signed in even if /v1/info hiccups (isAdmin is just false until it loads).
    let server: ServerInfo | null = null
    try {
      server = await ServerApi.info(origin, fetchImpl)
    } catch {
      server = null
    }
    set({ session, server, status: 'signedIn', restoreError: null, lastServerUrl: origin })
  }

  const api = new ApiClient({
    cookieSession: cookie,
    getSession: () => useSession.getState().session,
    setSession: (s) => useSession.getState().setSession(s),
    fetch: fetchImpl,
    now
  })

  return { useSession, api }
}
