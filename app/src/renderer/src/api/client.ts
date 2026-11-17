import { ApiError } from './errors'
import { buildUrl } from '../lib/url'
import type {
  AlbumDetail,
  Album,
  Artist,
  ArtistDetail,
  Home,
  Page,
  Playlist,
  PlaylistDetail,
  AddToPlaylistResult,
  CreatePlaylistInput,
  UpdatePlaylistInput,
  AdminJob,
  AdminSource,
  AdminStats,
  AdminTrack,
  AdminUser,
  Backup,
  ConnectCommandKind,
  ConnectPlaybackState,
  ConnectSession,
  ConnectSessionList,
  CreateUserInput,
  SearchResults,
  SearchType,
  SetLyricsInput,
  SourceResult,
  SpotifyImport,
  SpotifyPlaylist,
  SpotifyStatus,
  StartSpotifyImportInput,
  UpdateUserInput,
  ServerInfo,
  ServerLyrics,
  Session,
  StreamInfo,
  Track,
  User
} from './types'

/** Session as kept by the app: server it belongs to + absolute expiry. */
export interface StoredSession extends Session {
  serverUrl: string
  /** Epoch ms when the access token expires. */
  expiresAt: number
}

type Query = Record<string, string | number | boolean | undefined>

interface RequestOptions {
  query?: Query
  body?: unknown
  signal?: AbortSignal
  auth?: boolean
}

export interface ApiClientOptions {
  getSession: () => StoredSession | null
  setSession: (session: StoredSession | null) => void
  fetch?: typeof fetch
  timeoutMs?: number
  now?: () => number
  /**
   * Hosted web: the refresh token lives in an HttpOnly cookie. Every request carries
   * `X-Nocturne-Session: cookie` and `credentials: 'same-origin'`; refresh/logout post `{}`.
   */
  cookieSession?: boolean
}

/** Marks a request as cookie-session mode (see docs/HOSTED_AND_ADMIN.md §2). */
export const COOKIE_SESSION_HEADER = 'X-Nocturne-Session'
export const COOKIE_SESSION_VALUE = 'cookie'

const EXPIRY_SKEW_MS = 30_000

/** Combines an optional caller signal with a timeout. */
function withTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; done: () => void; timedOut: () => boolean } {
  const ctrl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ctrl.abort()
  }, ms)
  const onAbort = (): void => ctrl.abort()
  if (signal) {
    if (signal.aborted) ctrl.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: ctrl.signal,
    timedOut: () => timedOut,
    done: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

function retryAfterSeconds(res: Response): number | undefined {
  const raw = res.headers.get('Retry-After')
  if (!raw) return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

async function readError(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { message?: unknown; error?: unknown }
    const msg = body.message ?? body.error
    return typeof msg === 'string' ? msg : undefined
  } catch {
    return undefined
  }
}

async function rawRequest<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  outerSignal?: AbortSignal,
  credentials: RequestCredentials = 'omit'
): Promise<T> {
  const t = withTimeout(outerSignal, timeoutMs)
  let res: Response
  try {
    res = await fetchImpl(url, { ...init, signal: t.signal, credentials, cache: 'no-store' })
  } catch (err) {
    t.done()
    if (t.timedOut()) throw new ApiError('timeout', 'The server took too long to respond.')
    if (outerSignal?.aborted) throw new ApiError('aborted', 'Request cancelled.')
    throw new ApiError('network', "Can't reach the server. Check your connection.", 0)
  }
  t.done()
  if (!res.ok) throw ApiError.fromStatus(res.status, await readError(res), retryAfterSeconds(res))
  if (res.status === 204) return undefined as T
  const type = res.headers.get('Content-Type') ?? ''
  if (!type.includes('json')) throw new ApiError('bad_response', 'The server sent an unexpected response.', res.status)
  try {
    return (await res.json()) as T
  } catch {
    throw new ApiError('bad_response', 'The server sent an unexpected response.', res.status)
  }
}

export function toStoredSession(serverUrl: string, session: Session, now: number, opts: { cookieSession?: boolean } = {}): StoredSession {
  // In cookie mode the refresh token travels in an HttpOnly cookie, so the body carries "".
  const refreshOk = typeof session?.refreshToken === 'string' && (opts.cookieSession === true || session.refreshToken !== '')
  if (!session || typeof session.accessToken !== 'string' || !refreshOk || !session.user) {
    throw new ApiError('bad_response', 'The server sent an invalid sign-in response.')
  }
  const expiresIn = Number.isFinite(session.expiresIn) && session.expiresIn > 0 ? session.expiresIn : 3600
  return { ...session, serverUrl, expiresAt: now + expiresIn * 1000 }
}

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' }
const COOKIE_HEADERS = { ...JSON_HEADERS, [COOKIE_SESSION_HEADER]: COOKIE_SESSION_VALUE }

/** Unauthenticated helpers used before a session exists. */
export const ServerApi = {
  info(serverUrl: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<ServerInfo> {
    return rawRequest<ServerInfo>(fetchImpl, buildUrl(serverUrl, '/v1/info'), { headers: { Accept: 'application/json' } }, 8000, signal)
  },

  async login(
    serverUrl: string,
    username: string,
    password: string,
    fetchImpl: typeof fetch = fetch,
    now = Date.now(),
    opts: { cookieSession?: boolean } = {}
  ): Promise<StoredSession> {
    const cookieSession = opts.cookieSession === true
    try {
      const session = await rawRequest<Session>(
        fetchImpl,
        buildUrl(serverUrl, '/v1/auth/login'),
        { method: 'POST', headers: cookieSession ? COOKIE_HEADERS : JSON_HEADERS, body: JSON.stringify({ username, password }) },
        15000,
        undefined,
        cookieSession ? 'same-origin' : 'omit'
      )
      return toStoredSession(serverUrl, session, now, { cookieSession })
    } catch (err) {
      if (err instanceof ApiError && err.code === 'unauthorized') {
        throw new ApiError('unauthorized', 'Wrong username or password.', 401)
      }
      throw err
    }
  },

  /**
   * Cookie mode: exchanges the HttpOnly `nocturne_rt` cookie for a fresh session (used on startup).
   * A missing/invalid cookie rejects with code `unauthorized`.
   */
  async refreshCookie(serverUrl: string, fetchImpl: typeof fetch = fetch, now = Date.now(), signal?: AbortSignal): Promise<StoredSession> {
    const session = await rawRequest<Session>(
      fetchImpl,
      buildUrl(serverUrl, '/v1/auth/refresh'),
      { method: 'POST', headers: COOKIE_HEADERS, body: '{}' },
      15000,
      signal,
      'same-origin'
    )
    return toStoredSession(serverUrl, session, now, { cookieSession: true })
  }
}

/** Accepts either a bare array or a `Page`-like `{ items }` body. */
function listOf<T>(body: T[] | { items?: T[] } | null | undefined): T[] {
  if (Array.isArray(body)) return body
  return Array.isArray(body?.items) ? body.items : []
}

export class ApiClient {
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly now: () => number
  private readonly cookie: boolean
  private refreshing: Promise<StoredSession> | null = null

  constructor(private readonly opts: ApiClientOptions) {
    this.fetchImpl = opts.fetch ?? ((...args) => fetch(...args))
    this.timeoutMs = opts.timeoutMs ?? 15000
    this.now = opts.now ?? Date.now
    this.cookie = opts.cookieSession === true
  }

  private session(): StoredSession {
    const s = this.opts.getSession()
    if (!s) throw new ApiError('unauthorized', 'You are signed out.', 401)
    return s
  }

  /** Refreshes the access token. Concurrent callers share one in-flight refresh. */
  refresh(): Promise<StoredSession> {
    if (this.refreshing) return this.refreshing
    let current: StoredSession
    try {
      current = this.session()
    } catch (err) {
      return Promise.reject(err)
    }
    this.refreshing = rawRequest<Session>(
      this.fetchImpl,
      buildUrl(current.serverUrl, '/v1/auth/refresh'),
      {
        method: 'POST',
        headers: this.cookie ? COOKIE_HEADERS : JSON_HEADERS,
        body: JSON.stringify(this.cookie ? {} : { refreshToken: current.refreshToken })
      },
      this.timeoutMs,
      undefined,
      this.cookie ? 'same-origin' : 'omit'
    )
      .then((s) => {
        const stored = toStoredSession(current.serverUrl, s, this.now(), { cookieSession: this.cookie })
        this.opts.setSession(stored)
        return stored
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && (err.code === 'unauthorized' || err.code === 'bad_request' || err.code === 'forbidden')) {
          this.opts.setSession(null)
          throw new ApiError('unauthorized', 'Your session has expired. Please sign in again.', 401)
        }
        throw err
      })
      .finally(() => {
        this.refreshing = null
      })
    return this.refreshing
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const auth = options.auth !== false
    let session = auth ? this.session() : this.opts.getSession()
    if (auth && session && session.expiresAt - EXPIRY_SKEW_MS <= this.now()) session = await this.refresh()
    const base = session?.serverUrl
    if (!base) throw new ApiError('unauthorized', 'You are signed out.', 401)

    const send = (token: string | undefined): Promise<T> => {
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (options.body !== undefined) headers['Content-Type'] = 'application/json'
      if (token) headers['Authorization'] = `Bearer ${token}`
      if (this.cookie) headers[COOKIE_SESSION_HEADER] = COOKIE_SESSION_VALUE
      return rawRequest<T>(
        this.fetchImpl,
        buildUrl(base, path, options.query),
        { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) },
        this.timeoutMs,
        options.signal,
        this.cookie ? 'same-origin' : 'omit'
      )
    }

    try {
      return await send(auth ? session!.accessToken : undefined)
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
      if (auth && err.code === 'unauthorized') {
        const fresh = await this.refresh()
        return send(fresh.accessToken)
      }
      if (method === 'GET' && (err.code === 'network' || err.code === 'server') && !options.signal?.aborted) {
        await new Promise((r) => setTimeout(r, 400))
        return send(auth ? this.session().accessToken : undefined)
      }
      throw err
    }
  }

  // ---- Endpoints -------------------------------------------------------

  me(signal?: AbortSignal): Promise<User> {
    return this.request('GET', '/v1/me', { signal })
  }

  async logout(): Promise<void> {
    const s = this.opts.getSession()
    if (!s) return
    try {
      await this.request('POST', '/v1/auth/logout', { body: this.cookie ? {} : { refreshToken: s.refreshToken } })
    } finally {
      this.opts.setSession(null)
    }
  }

  serverInfo(signal?: AbortSignal): Promise<ServerInfo> {
    return this.request('GET', '/v1/info', { signal, auth: false })
  }

  /**
   * Public in-app update feed for a build target (android / windows / desktop).
   * Returns a server-relative `url`; the caller joins it with the session serverUrl.
   */
  checkUpdate(platform: string, signal?: AbortSignal): Promise<{ version: string; url: string; sha256?: string; notes?: string }> {
    return this.request('GET', `/v1/updates/${encodeURIComponent(platform)}`, { signal, auth: false })
  }

  home(signal?: AbortSignal): Promise<Home> {
    return this.request('GET', '/v1/home', { signal })
  }

  search(q: string, opts: { types?: SearchType[]; limit?: number; signal?: AbortSignal } = {}): Promise<SearchResults> {
    return this.request('GET', '/v1/search', {
      signal: opts.signal,
      query: { q, types: opts.types?.join(','), limit: opts.limit }
    })
  }

  libraryTracks(offset = 0, limit = 50, signal?: AbortSignal): Promise<Page<Track>> {
    return this.request('GET', '/v1/library/tracks', { signal, query: { offset, limit } })
  }

  librarySongs(offset = 0, limit = 50, signal?: AbortSignal): Promise<Page<Track>> {
    return this.request('GET', '/v1/library/songs', { signal, query: { offset, limit } })
  }

  libraryAlbums(offset = 0, limit = 50, signal?: AbortSignal): Promise<Page<Album>> {
    return this.request('GET', '/v1/library/albums', { signal, query: { offset, limit } })
  }

  libraryArtists(offset = 0, limit = 50, signal?: AbortSignal): Promise<Page<Artist>> {
    return this.request('GET', '/v1/library/artists', { signal, query: { offset, limit } })
  }

  libraryPlaylists(offset = 0, limit = 50, signal?: AbortSignal): Promise<Page<Playlist>> {
    return this.request('GET', '/v1/library/playlists', { signal, query: { offset, limit } })
  }

  album(id: string, signal?: AbortSignal): Promise<AlbumDetail> {
    return this.request('GET', `/v1/albums/${encodeURIComponent(id)}`, { signal })
  }

  artist(id: string, signal?: AbortSignal): Promise<ArtistDetail> {
    return this.request('GET', `/v1/artists/${encodeURIComponent(id)}`, { signal })
  }

  playlist(id: string, signal?: AbortSignal): Promise<PlaylistDetail> {
    return this.request('GET', `/v1/playlists/${encodeURIComponent(id)}`, { signal })
  }

  // ---- Playlist editing (capabilities.playlists) ------------------------

  /** Creates a playlist owned by the current user (201 → the new playlist with its tracks). */
  createPlaylist(input: CreatePlaylistInput): Promise<PlaylistDetail> {
    return this.request('POST', '/v1/playlists', { body: input })
  }

  updatePlaylist(id: string, input: UpdatePlaylistInput): Promise<Playlist> {
    return this.request('PATCH', `/v1/playlists/${encodeURIComponent(id)}`, { body: input })
  }

  deletePlaylist(id: string): Promise<void> {
    return this.request('DELETE', `/v1/playlists/${encodeURIComponent(id)}`)
  }

  /** Appends songs; ones already in the playlist come back in `skipped`. */
  async addToPlaylist(id: string, trackIds: string[]): Promise<AddToPlaylistResult> {
    const r = await this.request<Omit<AddToPlaylistResult, 'added'> & { added: number | string[] }>(
      'POST',
      `/v1/playlists/${encodeURIComponent(id)}/tracks`,
      { body: { trackIds } }
    )
    // Servers report `added` either as a count or as the list of added ids.
    return { ...r, added: Array.isArray(r.added) ? r.added.length : r.added }
  }

  removeFromPlaylist(id: string, trackId: string): Promise<void> {
    return this.request('DELETE', `/v1/playlists/${encodeURIComponent(id)}/tracks/${encodeURIComponent(trackId)}`)
  }

  /** Replaces the order; `trackIds` must be a permutation of the playlist's current songs. */
  reorderPlaylist(id: string, trackIds: string[]): Promise<PlaylistDetail> {
    return this.request('PUT', `/v1/playlists/${encodeURIComponent(id)}/tracks`, { body: { trackIds } })
  }

  stream(trackId: string, signal?: AbortSignal): Promise<StreamInfo> {
    return this.request('GET', `/v1/tracks/${encodeURIComponent(trackId)}/stream`, { signal })
  }

  lyrics(trackId: string, signal?: AbortSignal): Promise<ServerLyrics> {
    return this.request('GET', `/v1/tracks/${encodeURIComponent(trackId)}/lyrics`, { signal })
  }

  setLiked(trackId: string, liked: boolean): Promise<void> {
    return this.request(liked ? 'PUT' : 'DELETE', `/v1/library/tracks/${encodeURIComponent(trackId)}`)
  }

  reportPlayed(trackId: string, playedSeconds: number): Promise<void> {
    return this.request('POST', `/v1/tracks/${encodeURIComponent(trackId)}/played`, {
      body: { playedSeconds: Math.round(playedSeconds), at: new Date(this.now()).toISOString() }
    })
  }

  // ---- Connect (remote playback control) --------------------------------

  connectRegister(name: string, platform: string, controllable: boolean): Promise<ConnectSession> {
    return this.request('POST', '/v1/connect/sessions', { body: { name, platform, controllable } })
  }

  connectSessions(signal?: AbortSignal): Promise<ConnectSessionList> {
    return this.request('GET', '/v1/connect/sessions', { signal })
  }

  connectUnregister(id: string): Promise<void> {
    return this.request('DELETE', `/v1/connect/sessions/${encodeURIComponent(id)}`)
  }

  connectPutState(id: string, state: ConnectPlaybackState): Promise<void> {
    return this.request('PUT', `/v1/connect/sessions/${encodeURIComponent(id)}/state`, { body: { state } })
  }

  connectHeartbeat(id: string): Promise<void> {
    return this.request('POST', `/v1/connect/sessions/${encodeURIComponent(id)}/heartbeat`)
  }

  connectCommand(id: string, kind: ConnectCommandKind, payload?: Record<string, unknown>): Promise<void> {
    return this.request('POST', `/v1/connect/sessions/${encodeURIComponent(id)}/commands`, { body: { kind, payload } })
  }

  /** Absolute SSE URL for a session's event stream, with a fresh access token in the
   *  query (EventSource cannot send an Authorization header). */
  async connectEventsUrl(id: string): Promise<string> {
    let session = this.session()
    if (session.expiresAt - EXPIRY_SKEW_MS <= this.now()) session = await this.refresh()
    return buildUrl(session.serverUrl, `/v1/connect/sessions/${encodeURIComponent(id)}/events`, {
      access_token: session.accessToken
    })
  }

  // ---- Spotify import (capabilities.spotifyImport) ----------------------

  spotifyStatus(signal?: AbortSignal): Promise<SpotifyStatus> {
    return this.request('GET', '/v1/spotify/status', { signal })
  }

  /** Starts the Spotify login; open the returned `url` in the system browser. */
  async spotifyAuthorize(): Promise<{ url: string }> {
    const res = await this.request<{ url?: unknown }>('POST', '/v1/spotify/authorize')
    const url = typeof res?.url === 'string' ? res.url : ''
    let ok = false
    try {
      const parsed = new URL(url)
      ok = parsed.protocol === 'https:' || parsed.protocol === 'http:'
    } catch {
      ok = false
    }
    if (!ok) throw new ApiError('bad_response', 'The server sent an invalid Spotify login link.')
    return { url }
  }

  spotifyDisconnect(): Promise<void> {
    return this.request('DELETE', '/v1/spotify/connection')
  }

  async spotifyPlaylists(signal?: AbortSignal): Promise<SpotifyPlaylist[]> {
    return listOf(await this.request<SpotifyPlaylist[] | { items?: SpotifyPlaylist[] }>('GET', '/v1/spotify/playlists', { signal }))
  }

  /** 202 → the queued import. */
  spotifyStartImport(input: StartSpotifyImportInput): Promise<SpotifyImport> {
    return this.request('POST', '/v1/spotify/imports', { body: input })
  }

  /** Newest first. */
  async spotifyImports(signal?: AbortSignal): Promise<SpotifyImport[]> {
    return listOf(await this.request<SpotifyImport[] | { items?: SpotifyImport[] }>('GET', '/v1/spotify/imports', { signal }))
  }

  spotifyImport(id: string, signal?: AbortSignal): Promise<SpotifyImport> {
    return this.request('GET', `/v1/spotify/imports/${encodeURIComponent(id)}`, { signal })
  }

  spotifyCancelImport(id: string): Promise<void> {
    return this.request('DELETE', `/v1/spotify/imports/${encodeURIComponent(id)}`)
  }

  // ---- Admin ------------------------------------------------------------

  adminStats(signal?: AbortSignal): Promise<AdminStats> {
    return this.request('GET', '/v1/admin/stats', { signal })
  }

  adminSearchSource(source: AdminSource, q: string, signal?: AbortSignal): Promise<{ results: SourceResult[] }> {
    return this.request('GET', '/v1/admin/sources/search', { signal, query: { source, q } })
  }

  /** Start downloading a search result (`id`) or a pasted link (`url`). */
  adminStartDownload(input: { source: AdminSource; id?: string; url?: string }): Promise<AdminJob> {
    return this.request('POST', '/v1/admin/downloads', { body: input })
  }

  /** Import a whole playlist (Spotify/YouTube link) into the library and as a playlist. */
  adminImportPlaylist(url: string): Promise<AdminJob> {
    return this.request('POST', '/v1/admin/imports', { body: { url } })
  }

  adminJobs(signal?: AbortSignal): Promise<{ jobs: AdminJob[] }> {
    return this.request('GET', '/v1/admin/jobs', { signal })
  }

  adminJob(id: string, signal?: AbortSignal): Promise<AdminJob> {
    return this.request('GET', `/v1/admin/jobs/${encodeURIComponent(id)}`, { signal })
  }

  adminCancelJob(id: string): Promise<void> {
    return this.request('DELETE', `/v1/admin/jobs/${encodeURIComponent(id)}`)
  }

  adminRescan(): Promise<AdminJob> {
    return this.request('POST', '/v1/admin/library/rescan')
  }

  /** Downloads the Android signing keystore backup (zip) as an authenticated blob. */
  async adminDownloadKeystore(): Promise<Blob> {
    let session = this.session()
    if (session && session.expiresAt - EXPIRY_SKEW_MS <= this.now()) session = await this.refresh()
    const base = session?.serverUrl
    if (!base) throw new ApiError('unauthorized', 'You are signed out.', 401)
    const headers: Record<string, string> = { Accept: 'application/zip' }
    if (this.cookie) headers[COOKIE_SESSION_HEADER] = COOKIE_SESSION_VALUE
    else headers['Authorization'] = `Bearer ${session.accessToken}`
    const res = await this.fetchImpl(buildUrl(base, '/v1/admin/signing/keystore'), {
      method: 'GET',
      headers,
      credentials: this.cookie ? 'same-origin' : 'omit',
      cache: 'no-store'
    })
    if (!res.ok) throw new ApiError('server', `Keystore download failed (${res.status})`, res.status)
    return res.blob()
  }

  adminTracks(
    opts: { q?: string; offset?: number; limit?: number; lyrics?: 'missing' | 'present'; signal?: AbortSignal } = {}
  ): Promise<Page<AdminTrack>> {
    return this.request('GET', '/v1/admin/tracks', {
      signal: opts.signal,
      query: { q: opts.q || undefined, offset: opts.offset ?? 0, limit: opts.limit ?? 50, lyrics: opts.lyrics }
    })
  }

  /** Stores (replaces) the TTML or LRC lyrics of a track. */
  adminSetLyrics(trackId: string, input: SetLyricsInput): Promise<void> {
    return this.request('PUT', `/v1/admin/tracks/${encodeURIComponent(trackId)}/lyrics`, { body: input })
  }

  adminDeleteLyrics(trackId: string): Promise<void> {
    return this.request('DELETE', `/v1/admin/tracks/${encodeURIComponent(trackId)}/lyrics`)
  }

  adminDeleteTrack(id: string): Promise<void> {
    return this.request('DELETE', `/v1/admin/tracks/${encodeURIComponent(id)}`)
  }

  adminUsers(signal?: AbortSignal): Promise<{ users: AdminUser[] }> {
    return this.request('GET', '/v1/admin/users', { signal })
  }

  adminCreateUser(input: CreateUserInput): Promise<AdminUser> {
    return this.request('POST', '/v1/admin/users', { body: input })
  }

  adminUpdateUser(id: string, input: UpdateUserInput): Promise<AdminUser> {
    return this.request('PATCH', `/v1/admin/users/${encodeURIComponent(id)}`, { body: input })
  }

  adminDeleteUser(id: string): Promise<void> {
    return this.request('DELETE', `/v1/admin/users/${encodeURIComponent(id)}`)
  }

  adminBackups(signal?: AbortSignal): Promise<{ backups: Backup[] }> {
    return this.request('GET', '/v1/admin/backups', { signal })
  }

  adminCreateBackup(): Promise<AdminJob> {
    return this.request('POST', '/v1/admin/backups')
  }

  adminRestoreBackup(id: string): Promise<AdminJob> {
    return this.request('POST', `/v1/admin/backups/${encodeURIComponent(id)}/restore`, { body: { confirm: true } })
  }

  /**
   * Uploads one audio file (multipart field "file"). Uses XHR so the UI can show
   * upload progress, which fetch can't report.
   */
  async adminUpload(file: Blob, filename: string, opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {}): Promise<AdminTrack> {
    let session = this.session()
    if (session.expiresAt - EXPIRY_SKEW_MS <= this.now()) session = await this.refresh()
    const send = (token: string): Promise<AdminTrack> =>
      new Promise<AdminTrack>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('POST', buildUrl(session.serverUrl, '/v1/admin/uploads'))
        xhr.setRequestHeader('Authorization', `Bearer ${token}`)
        xhr.setRequestHeader('Accept', 'application/json')
        if (this.cookie) xhr.setRequestHeader(COOKIE_SESSION_HEADER, COOKIE_SESSION_VALUE)
        xhr.withCredentials = this.cookie
        xhr.responseType = 'text'
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total)
        }
        xhr.onload = () => {
          let body: unknown = null
          try {
            body = xhr.responseText ? JSON.parse(xhr.responseText) : null
          } catch {
            body = null
          }
          if (xhr.status >= 200 && xhr.status < 300 && body) {
            opts.onProgress?.(1)
            resolve(body as AdminTrack)
            return
          }
          const msg = body && typeof (body as { message?: unknown }).message === 'string' ? (body as { message: string }).message : undefined
          const failed = xhr.status >= 300 || (xhr.status > 0 && xhr.status < 200)
          reject(failed ? ApiError.fromStatus(xhr.status, msg) : new ApiError('bad_response', 'The server sent an unexpected response.'))
        }
        xhr.onerror = () => reject(new ApiError('network', "Can't reach the server. Check your connection."))
        xhr.onabort = () => reject(new ApiError('aborted', 'Upload cancelled.'))
        if (opts.signal?.aborted) {
          reject(new ApiError('aborted', 'Upload cancelled.'))
          return
        }
        opts.signal?.addEventListener('abort', () => xhr.abort(), { once: true })
        const form = new FormData()
        form.append('file', file, filename)
        xhr.send(form)
      })
    try {
      return await send(session.accessToken)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'unauthorized') {
        session = await this.refresh()
        return send(session.accessToken)
      }
      throw err
    }
  }
}
