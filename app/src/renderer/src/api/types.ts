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
  /** Artist photo (Deezer), CORS-enabled; null/absent when none was found. */
  image?: string | null
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
  /** True when the signed-in user may rename / delete / change the tracks of this playlist. */
  editable?: boolean
  /** True for a generated "Hecho para ti" mix (opens the read-only mix page; id is `daily-1`, `rediscover`, ...). */
  mix?: boolean
}

/**
 * A song as it appears in a playlist. The same song may appear more than once; servers that support
 * that give every occurrence its own `entryId` (unique within the playlist). Older servers omit it.
 */
export interface PlaylistTrack extends Track {
  entryId?: string
}

export interface PlaylistDetail extends Playlist {
  /** In playlist order. May contain the same song more than once. */
  tracks: PlaylistTrack[]
}

export interface CreatePlaylistInput {
  /** 1–100 characters. */
  name: string
  /** ≤ 300 characters. */
  description?: string
  /** Songs to put in the new playlist, in order. */
  trackIds?: string[]
}

export interface AddToPlaylistOptions {
  /** Append songs even when they are already in the playlist (another occurrence). */
  allowDuplicates?: boolean
}

export interface UpdatePlaylistInput {
  name?: string
  description?: string
}

/**
 * Response of POST /v1/playlists/:id/tracks. Unless `allowDuplicates` was sent, songs already in the
 * playlist are skipped (listed in `skipped`), not duplicated.
 */
export interface AddToPlaylistResult {
  added: number
  skipped: string[]
  playlist: Playlist
}

/** Limits enforced by the server (and mirrored by the forms). */
export const PLAYLIST_NAME_MAX = 100
export const PLAYLIST_DESCRIPTION_MAX = 300

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
    /** Server lets users create and edit their own playlists (POST/PATCH/DELETE /v1/playlists…). */
    playlists?: boolean
    /** Server implements /v1/spotify/* (connect a Spotify account and import its playlists). */
    spotifyImport?: boolean
    /** Server implements GET /v1/radio (Autoplay: similar songs from the library). */
    radio?: boolean
    /** Server implements /v1/listenbrainz/* (scrobbling to ListenBrainz). */
    listenbrainz?: boolean
  }
}

/** GET /v1/listenbrainz/status */
export interface ListenBrainzStatus {
  connected: boolean
  /** Scrobbling on/off (the token stays saved when off). */
  enabled: boolean
  /** Also send "now playing". */
  nowPlaying: boolean
  userName: string | null
  /** Listens waiting to be sent (retrying). */
  pending: number
  lastError: string | null
  lastOkAt?: string | null
}

// ---- Spotify import (capabilities.spotifyImport) ------------------------

export interface SpotifyAccount {
  id: string
  displayName: string
}

/** GET /v1/spotify/status */
export interface SpotifyStatus {
  /** False when the server has no Spotify app credentials: importing is unavailable. */
  configured: boolean
  connected: boolean
  account?: SpotifyAccount
  /** ISO 8601: when the stored Spotify authorization stops working (~180 days after connecting). */
  expiresAt?: string
}

/** One of the user's playlists on Spotify (GET /v1/spotify/playlists). */
export interface SpotifyPlaylist {
  id: string
  name: string
  trackCount: number
  /** Cover image URL. */
  image?: string
  /** Display name of the owner. */
  owner?: string
  public?: boolean
}

export type SpotifyImportStatus = 'queued' | 'reading' | 'matching' | 'downloading' | 'done' | 'failed' | 'cancelled'

export interface SpotifyImportFailure {
  title: string
  artists: string
  reason: string
}

export interface SpotifyImport {
  id: string
  status: SpotifyImportStatus
  spotifyPlaylist: { id: string; name: string; image?: string }
  /** The Nocturne playlist being filled, once it exists. */
  playlistId?: string
  total: number
  /** Songs that were already in the library. */
  matched: number
  /** Songs downloaded to the server during the import. */
  downloaded: number
  /** Songs that could not be found / downloaded. */
  failed: number
  /** Songs not processed yet. */
  pending: number
  failures: SpotifyImportFailure[]
  /** Optional human readable reason when `status` is 'failed' (not in the base contract). */
  error?: string
  createdAt: string
  finishedAt?: string
}

/** POST /v1/spotify/imports */
export interface StartSpotifyImportInput {
  /** Spotify playlist id or open.spotify.com URL. */
  playlist: string
  /** Download songs missing from the library (server default: true). */
  download?: boolean
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
  /** 0..1 */
  volume?: number
  muted?: boolean
  queueLength?: number
  /** What the queue was started from (album, playlist…), when known. */
  context?: ConnectContext | null
  /** "Next from <context>": ids of the next few context tracks (≤ CONNECT_UP_NEXT). */
  upNext?: string[]
  /** "Next in queue": ids of the user-queued tracks, in play order (≤ CONNECT_UP_NEXT). */
  userQueue?: string[]
  /** Sender clock (ms since epoch) when this snapshot was taken. Informational only. */
  updatedAt?: number
}

export interface ConnectContext {
  type: 'album' | 'playlist' | 'artist' | 'search' | 'library' | 'home' | 'tracks'
  id?: string
  name?: string
}

/** Most track ids a playContext / addToQueue / playNext command may carry (server-enforced). */
export const CONNECT_MAX_TRACK_IDS = 5000
/** Upcoming ids included in a reported state. */
export const CONNECT_UP_NEXT = 50

/** Payload of the `playContext` command: the receiving player loads these tracks and starts at `startIndex`. */
export interface ConnectPlayContextPayload {
  context: ConnectContext
  trackIds: string[]
  startIndex: number
  shuffle?: boolean
}

/** Payload of `addToQueue` / `playNext`. */
export interface ConnectTrackIdsPayload {
  trackIds: string[]
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
  | 'playContext' | 'addToQueue' | 'playNext'

export interface ConnectCommand {
  kind: ConnectCommandKind
  payload?: Record<string, unknown>
}

/** Events pushed down the SSE stream. */
export type ConnectEvent =
  | { type: 'command'; kind: ConnectCommandKind; payload: Record<string, unknown> }
  /** `sessionId` names the session whose state changed (absent on older servers: then it is our own). */
  | { type: 'state'; sessionId?: string; state: ConnectPlaybackState }
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
  /** Shared per-track timing offset in ms (positive = lyrics later). Optional for older servers. */
  offsetMs?: number
  /** "admin" when synced / plain come from admin-stored lyrics (top priority, beats LRCLIB). */
  source?: string
}

export type LyricsFormat = 'ttml' | 'lrc' | 'plain'

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

export interface DiagnosticReport {
  id: string
  userId: string
  username: string | null
  createdAt: string
  occurredAt: string | null
  source: 'crash' | 'manual'
  kind: string
  version: string
  os: string
  device: string
  body: string
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
  /** TTML document (≤ 1 MiB), LRC text with timestamps or plain text (≤ 200 KB), UTF-8. */
  content: string
}

// ---- Listening stats (GET /v1/stats/*) ------------------------------------

export type StatsRange = 'week' | 'month' | 'year' | 'all'

export interface StatsTotals {
  minutes: number
  plays: number
  distinctTracks: number
  distinctArtists: number
}

export interface StatsDelta {
  minutes: number
  /** Percent change in minutes; null when the previous period had none. */
  minutesPct: number | null
  plays: number
}

export interface StatsTopTrack {
  track: Track
  plays: number
  minutes: number
}

export interface StatsTopArtist {
  artist: Artist
  plays: number
  minutes: number
}

export interface StatsTopAlbum {
  album: Album
  plays: number
  minutes: number
}

export interface StatsSummary {
  range: StatsRange
  offset: number
  /** First local date (YYYY-MM-DD); null for "all". */
  start: string | null
  /** Exclusive end date; null for "all". */
  end: string | null
  label: string
  totals: StatsTotals
  previous: StatsTotals | null
  delta: StatsDelta | null
  topTracks: StatsTopTrack[]
  topArtists: StatsTopArtist[]
  topAlbums: StatsTopAlbum[]
}

export interface StatsHistoryItem {
  /** Local date (YYYY-MM-DD) the bucket starts on. */
  start: string
  minutes: number
  plays: number
}

export interface StatsHistory {
  period: 'week' | 'month'
  items: StatsHistoryItem[]
}

/** Per-user equalizer (GET/PUT /v1/me/eq). `updatedAt` is null until the user saved something. */
export interface EqStateWire {
  enabled: boolean
  preamp: number
  gains: number[]
  presetId: string | null
  updatedAt: string | null
}

/** A user's custom equalizer preset (/v1/me/eq/presets). */
export interface EqPresetWire {
  id: string
  name: string
  preamp: number
  gains: number[]
  createdAt: string
  updatedAt: string
}

export interface EqPresetInput {
  name: string
  preamp: number
  gains: number[]
}
