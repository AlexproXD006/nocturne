/** Wire types for the Nocturne server API (v1). See docs/API.md. */

export interface Image {
  url: string
  width?: number
  height?: number
}

export interface ArtistRef {
  id: string
  name: string
}

export interface AlbumRef {
  id: string
  title: string
}

export interface Track {
  id: string
  title: string
  artists: ArtistRef[]
  album: AlbumRef | null
  /** Seconds. */
  duration: number
  artwork: Image[]
  explicit?: boolean
  trackNumber?: number
  discNumber?: number
  liked?: boolean
}

export interface Album {
  id: string
  title: string
  artists: ArtistRef[]
  year?: number
  artwork: Image[]
  trackCount?: number
  type?: 'album' | 'single' | 'ep' | 'compilation'
}

export interface AlbumDetail extends Album {
  tracks: Track[]
  /** Seconds. */
  totalDuration?: number
}

export interface Artist {
  id: string
  name: string
  artwork: Image[]
  followers?: number
}

export interface ArtistDetail extends Artist {
  bio?: string
  topTracks: Track[]
  albums: Album[]
}

export interface Playlist {
  id: string
  name: string
  description?: string
  owner?: { id: string; name: string }
  artwork: Image[]
  trackCount?: number
}

export interface PlaylistDetail extends Playlist {
  tracks: Track[]
}

export type UserRole = 'admin' | 'user'

export interface User {
  id: string
  username: string
  displayName: string
  avatar?: Image[]
  /** Admins can open the Admin section. Missing = 'user'. */
  role?: UserRole
}

export interface Session {
  accessToken: string
  refreshToken: string
  /** Seconds until access token expiry. */
  expiresIn: number
  user: User
}

export interface ServerInfo {
  name: string
  version: string
  apiVersion: 1
  capabilities?: {
    lyrics?: boolean
    likes?: boolean
    scrobble?: boolean
    /** Server implements /v1/admin/*. */
    admin?: boolean
    /** Download sources the server can fetch music from. */
    sources?: AdminSource[]
    /** Server accepts audio uploads; value is the max size in bytes. */
    uploadMaxBytes?: number
    /** Server implements /v1/connect/* (remote playback control between devices). */
    connect?: boolean
  }
}

// ---- Connect (remote playback control) --------------------------------

/** Playback snapshot a session reports and controllers read. */
export interface ConnectPlaybackState {
  status?: 'idle' | 'loading' | 'playing' | 'paused' | 'buffering' | 'error'
  track?: Track | null
  position?: number
  duration?: number
  shuffle?: boolean
  repeat?: 'off' | 'all' | 'one'
  volume?: number
  muted?: boolean
  queueLength?: number
}

export interface ConnectSession {
  id: string
  name: string
  platform: string
  controllable: boolean
  state: ConnectPlaybackState
  online: boolean
  lastSeenAt: string
}

export interface ConnectSessionList {
  sessions: ConnectSession[]
}

export type ConnectCommandKind =
  | 'play' | 'pause' | 'toggle' | 'next' | 'previous'
  | 'seek' | 'setShuffle' | 'setRepeat' | 'setVolume' | 'stop' | 'transferTo'

export interface ConnectCommand {
  kind: ConnectCommandKind
  payload?: Record<string, unknown>
}

/** Events pushed down the SSE stream. */
export type ConnectEvent =
  | { type: 'command'; kind: ConnectCommandKind; payload: Record<string, unknown> }
  | { type: 'state'; state: ConnectPlaybackState }
  | { type: 'closed' }

export interface Page<T> {
  items: T[]
  offset: number
  limit: number
  total: number
}

export type HomeSection =
  | { id: string; title: string; kind: 'tracks'; items: Track[] }
  | { id: string; title: string; kind: 'albums'; items: Album[] }
  | { id: string; title: string; kind: 'artists'; items: Artist[] }
  | { id: string; title: string; kind: 'playlists'; items: Playlist[] }

export interface Home {
  sections: HomeSection[]
}

export type SearchType = 'track' | 'album' | 'artist' | 'playlist'

export interface SearchResults {
  tracks: Track[]
  albums: Album[]
  artists: Artist[]
  playlists: Playlist[]
}

export interface StreamInfo {
  /** Short-lived, pre-signed URL the audio element can load without auth headers. */
  url: string
  /** ISO 8601 timestamp after which the URL stops working. */
  expiresAt: string
  mimeType?: string
  bitrate?: number
}

export interface ServerLyrics {
  /** LRC text with [mm:ss.xx] timestamps, or null if only plain lyrics exist. */
  synced: string | null
  plain: string | null
  /**
   * TTML document (W3C Timed Text / Apple Music style, may contain word-level
   * <span begin end> timing) uploaded for this track by an admin. Takes priority
   * over every other source when present. Optional for older servers.
   */
  ttml?: string | null
}

export type LyricsFormat = 'ttml' | 'lrc'

// ---- Admin (/v1/admin/*, role 'admin' only) -------------------------------

export type AdminSource = 'spotify' | 'youtube'

export interface AdminStats {
  tracks: number
  albums: number
  artists: number
  playlists: number
  users: number
  /** Total size of the music library on disk. */
  storageBytes: number
  /** Free space left on the music volume, if known. */
  freeBytes?: number
  plays: number
  /** Jobs currently queued or running. */
  activeJobs: number
}

export interface SourceResult {
  /** Opaque id understood by POST /v1/admin/downloads for this source. */
  id: string
  source: AdminSource
  kind: 'track' | 'album' | 'playlist'
  title: string
  artist: string
  album?: string
  duration?: number
  artworkUrl?: string
  /** Public page for the item (shown as a link). */
  url?: string
  /** True when the library already contains this item. */
  inLibrary?: boolean
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
export type JobKind = 'download' | 'import' | 'rescan' | 'backup' | 'restore'

export interface AdminJob {
  id: string
  kind: JobKind
  source?: AdminSource | 'url'
  title: string
  status: JobStatus
  /** 0..1 when known. */
  progress?: number
  /** Human readable step, e.g. "Downloading 3/12". */
  message?: string
  error?: string
  /** Tracks added by the job so far. */
  trackIds?: string[]
  createdAt: string
  finishedAt?: string
}

export interface AdminUser extends User {
  role: UserRole
  createdAt: string
  lastLoginAt?: string | null
  disabled?: boolean
}

export interface CreateUserInput {
  username: string
  displayName?: string
  password: string
  role: UserRole
}

export interface UpdateUserInput {
  displayName?: string
  password?: string
  role?: UserRole
  disabled?: boolean
}

export interface Backup {
  id: string
  createdAt: string
  sizeBytes: number
  /** What the backup contains, e.g. "database", "database+playlists". */
  label?: string
}

export interface AdminTrack extends Track {
  addedAt?: string
  playCount?: number
  /** Size of the audio file in bytes. */
  sizeBytes?: number
  format?: string
  /** Lyrics stored on the server for this track, if any. */
  lyrics?: LyricsFormat | null
}

export interface SetLyricsInput {
  format: LyricsFormat
  /** Full TTML or LRC document, UTF-8, ≤ 1 MiB. */
  content: string
}
