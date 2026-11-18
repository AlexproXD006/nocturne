/**
 * Contract between the player store and the Android Media3 service (ExoPlayer inside a
 * MediaLibraryService, also the Android Auto backend). The WebView is only a remote UI for it.
 * Times are in seconds.
 */

export type NativeRepeat = 'off' | 'all' | 'one'

export interface NativeQueueItem {
  /** Queue entry id (unique inside the queue; becomes the ExoPlayer mediaId). */
  uid: string
  trackId: string
  title: string
  artist: string
  album: string
  artworkUrl: string
  duration: number
}

/** The native queue as seen by native (used to adopt a queue that Android Auto started). */
export interface NativeSnapshot {
  items: (NativeQueueItem & { track?: unknown })[]
  index: number
  position: number
  playing: boolean
  repeat: NativeRepeat
  shuffle: boolean
  contextName?: string
}

/** Equalizer state sent to the Media3 service (10 gains in dB, preamp in dB). */
export interface NativeEq {
  enabled: boolean
  preamp: number
  gains: number[]
}

/** Session handed to native secure storage so the service can call the API with no WebView. */
export interface NativeSession {
  serverUrl: string
  accessToken: string
  refreshToken: string
  /** Epoch ms. */
  expiresAt: number
  userId: string
}

export type NativePlayerEvent =
  | { type: 'state'; status: 'idle' | 'buffering' | 'playing' | 'paused' | 'ended' }
  | { type: 'position'; position: number; duration: number }
  | { type: 'index'; uid: string }
  | { type: 'error'; message: string }
  /** The queue was replaced from outside the WebView (Android Auto, voice search, Bluetooth). */
  | { type: 'queue'; snapshot: NativeSnapshot }
  | { type: 'liked'; trackId: string; liked: boolean }
  /** Buttons that need the WebView's queue model (Android Auto shuffle / repeat). */
  | { type: 'command'; kind: 'shuffle' | 'repeat' }
  /** Native refreshed the access token (rotating refresh token): the WebView must adopt it. */
  | { type: 'auth'; session: NativeSession }

export interface SetQueueOptions {
  /** Start/stop playing; undefined keeps the current play intent. */
  play?: boolean
  /** Position to start the target item at. */
  startAt?: number
  /** Restart the target item even if it is already the current one. */
  reset?: boolean
}

export interface NativePlayer {
  /** Replaces/aligns the native queue. Keeps the current item playing when it is still in `items`. */
  setQueue(items: NativeQueueItem[], index: number, opts?: SetQueueOptions): void
  play(): void
  pause(): void
  seek(seconds: number): void
  setVolume(volume: number): void
  setRepeat(mode: NativeRepeat): void
  /** Display flag for the shuffle button (the WebView owns the shuffled order). */
  setShuffle(on: boolean): void
  /** Pause when the current track ends (sleep timer "end of track"). */
  setPauseAtEnd(on: boolean): void
  stop(): void
  /** Mirrors the heart state of a track so the car/notification button matches. */
  setLiked(trackId: string, liked: boolean): void
  setAuth(session: NativeSession | null): void
  getAuth(): Promise<NativeSession | null>
  setLyricsInCar(enabled: boolean): void
  /** Equalizer state for the ExoPlayer audio processor; the service also persists it and applies it with the app closed. */
  setEq(state: NativeEq): void
  getSnapshot(): Promise<NativeSnapshot | null>
  on(listener: (e: NativePlayerEvent) => void): () => void
}
