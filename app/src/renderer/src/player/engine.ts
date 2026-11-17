/**
 * Dual-deck audio engine.
 *  - The standby deck preloads the next track so transitions are gapless.
 *  - Optional crossfade between decks.
 *  - Web Audio analyser for the visualizer. Requires CORS on the stream; if the
 *    server doesn't send CORS headers we transparently fall back to plain playback.
 */

export interface EngineEvents {
  onTime?(current: number, duration: number): void
  onPlaying?(): void
  onPause?(): void
  onWaiting?(): void
  onEnded?(): void
  onError?(message: string): void
  onReactiveChange?(reactive: boolean): void
}

export interface EngineOptions {
  createAudio?: () => HTMLAudioElement
  AudioContextCtor?: typeof AudioContext | null
  /** Short fades on play/pause avoid clicks. */
  microFadeSec?: number
}

interface Deck {
  el: HTMLAudioElement
  key: string | null
  url: string | null
  source: MediaElementAudioSourceNode | null
  gain: GainNode | null
  fade: number
  fadeTimer: ReturnType<typeof setInterval> | null
  ready: boolean
}

type DeckEvent = 'timeupdate' | 'durationchange' | 'playing' | 'pause' | 'waiting' | 'ended' | 'error' | 'canplay'
const DECK_EVENTS: DeckEvent[] = ['timeupdate', 'durationchange', 'playing', 'pause', 'waiting', 'ended', 'error', 'canplay']

function mediaErrorMessage(el: HTMLAudioElement): string {
  switch (el.error?.code) {
    case 2: return 'Network error while streaming.'
    case 3: return 'This track could not be decoded.'
    case 4: return "This track can't be played (unsupported format or link expired)."
    default: return 'Playback failed.'
  }
}

export class AudioEngine {
  private decks: [Deck, Deck]
  private active = 0
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private analyser: AnalyserNode | null = null
  private volume = 1
  private reactiveMode: boolean
  private probingPlain = false
  private transitioning = false
  private playToken = 0
  private readonly createAudio: () => HTMLAudioElement
  private readonly Ctx: typeof AudioContext | null
  private readonly microFade: number
  private listeners = new Map<HTMLAudioElement, Array<[string, EventListener]>>()

  constructor(private readonly events: EngineEvents = {}, opts: EngineOptions = {}) {
    this.createAudio = opts.createAudio ?? (() => new Audio())
    this.Ctx = opts.AudioContextCtor === undefined
      ? ((globalThis as { AudioContext?: typeof AudioContext }).AudioContext ?? null)
      : opts.AudioContextCtor
    this.microFade = opts.microFadeSec ?? 0.12
    this.reactiveMode = this.Ctx !== null
    this.decks = [this.makeDeck(), this.makeDeck()]
  }

  get reactive(): boolean {
    return this.reactiveMode && this.analyser !== null
  }

  get currentTime(): number {
    return this.deck().el.currentTime || 0
  }

  get duration(): number {
    const d = this.deck().el.duration
    return Number.isFinite(d) ? d : 0
  }

  get paused(): boolean {
    return this.deck().el.paused
  }

  get currentKey(): string | null {
    return this.deck().key
  }

  get isTransitioning(): boolean {
    return this.transitioning
  }

  private deck(i = this.active): Deck {
    return this.decks[i]!
  }

  private standbyIndex(): number {
    return this.active === 0 ? 1 : 0
  }

  private makeDeck(): Deck {
    const el = this.createAudio()
    el.preload = 'auto'
    if (this.reactiveMode) el.crossOrigin = 'anonymous'
    const deck: Deck = { el, key: null, url: null, source: null, gain: null, fade: 1, fadeTimer: null, ready: false }
    const bound: Array<[string, EventListener]> = []
    for (const type of DECK_EVENTS) {
      const fn = (): void => this.handle(deck, type)
      el.addEventListener(type, fn)
      bound.push([type, fn])
    }
    this.listeners.set(el, bound)
    if (this.ctx) this.connect(deck)
    return deck
  }

  private disposeDeck(deck: Deck): void {
    if (deck.fadeTimer) clearInterval(deck.fadeTimer)
    for (const [type, fn] of this.listeners.get(deck.el) ?? []) deck.el.removeEventListener(type, fn)
    this.listeners.delete(deck.el)
    deck.el.pause()
    deck.el.removeAttribute('src')
    try {
      deck.el.load()
    } catch {
      /* jsdom */
    }
    deck.source?.disconnect()
    deck.gain?.disconnect()
  }

  /** Lazily creates the audio graph (must follow a user gesture in browsers). */
  private ensureGraph(): void {
    if (!this.reactiveMode || this.ctx || !this.Ctx) return
    try {
      this.ctx = new this.Ctx({ latencyHint: 'playback' })
      this.master = this.ctx.createGain()
      this.master.gain.value = this.volume
      this.analyser = this.ctx.createAnalyser()
      this.analyser.fftSize = 2048
      this.analyser.smoothingTimeConstant = 0.78
      this.master.connect(this.analyser)
      this.analyser.connect(this.ctx.destination)
      for (const d of this.decks) this.connect(d)
      this.events.onReactiveChange?.(true)
    } catch {
      this.ctx = null
      this.master = null
      this.analyser = null
      this.reactiveMode = false
      // Without an analyser there is no reason to demand CORS from the stream.
      for (const d of this.decks) d.el.crossOrigin = null
    }
  }

  private connect(deck: Deck): void {
    if (!this.ctx || !this.master || deck.source) return
    deck.source = this.ctx.createMediaElementSource(deck.el)
    deck.gain = this.ctx.createGain()
    deck.gain.gain.value = deck.fade
    deck.source.connect(deck.gain)
    deck.gain.connect(this.master)
    deck.el.volume = 1
  }

  private applyElementVolume(deck: Deck): void {
    if (!deck.gain) deck.el.volume = Math.min(1, Math.max(0, this.volume * deck.fade))
  }

  private setFade(deck: Deck, target: number, seconds: number): Promise<void> {
    if (deck.fadeTimer) {
      clearInterval(deck.fadeTimer)
      deck.fadeTimer = null
    }
    const from = deck.fade
    deck.fade = target
    if (seconds <= 0) {
      if (deck.gain && this.ctx) {
        deck.gain.gain.cancelScheduledValues(this.ctx.currentTime)
        deck.gain.gain.setValueAtTime(target, this.ctx.currentTime)
      }
      this.applyElementVolume(deck)
      return Promise.resolve()
    }
    if (deck.gain && this.ctx) {
      const now = this.ctx.currentTime
      deck.gain.gain.cancelScheduledValues(now)
      deck.gain.gain.setValueAtTime(from, now)
      deck.gain.gain.linearRampToValueAtTime(target, now + seconds)
      return new Promise((r) => setTimeout(r, seconds * 1000))
    }
    return new Promise((resolve) => {
      const start = performance.now()
      deck.fade = from
      deck.fadeTimer = setInterval(() => {
        const t = Math.min(1, (performance.now() - start) / (seconds * 1000))
        deck.fade = from + (target - from) * t
        this.applyElementVolume(deck)
        if (t >= 1) {
          clearInterval(deck.fadeTimer!)
          deck.fadeTimer = null
          resolve()
        }
      }, 40)
    })
  }

  private handle(deck: Deck, type: DeckEvent): void {
    const isActive = deck === this.deck()
    if (type === 'canplay') {
      deck.ready = true
      if (this.probingPlain && isActive) this.probingPlain = false
      return
    }
    if (type === 'error') {
      if (!deck.url) return
      if (!isActive) {
        // Preload failure: forget it, the track will be loaded normally later.
        deck.key = null
        deck.url = null
        return
      }
      this.handleActiveError(deck)
      return
    }
    if (!isActive) return
    switch (type) {
      case 'timeupdate':
      case 'durationchange':
        this.events.onTime?.(this.currentTime, this.duration)
        break
      case 'playing':
        this.events.onPlaying?.()
        break
      case 'pause':
        if (!deck.el.ended) this.events.onPause?.()
        break
      case 'waiting':
        this.events.onWaiting?.()
        break
      case 'ended':
        this.events.onEnded?.()
        break
    }
  }

  private handleActiveError(deck: Deck): void {
    if (this.reactiveMode && !this.probingPlain && deck.el.crossOrigin) {
      // Likely missing CORS headers: retry without the analyser.
      const { key, url } = deck
      const resumeAt = deck.el.currentTime || 0
      this.probingPlain = true
      this.rebuild(false)
      if (key && url) this.load(key, url, { autoplay: true, startAt: resumeAt })
      return
    }
    if (this.probingPlain) {
      // Plain playback failed as well: it was not a CORS problem.
      this.probingPlain = false
      const canReact = this.Ctx !== null
      if (canReact) this.rebuild(true)
    }
    this.events.onError?.(mediaErrorMessage(deck.el))
  }

  private rebuild(reactive: boolean): void {
    for (const d of this.decks) this.disposeDeck(d)
    if (this.ctx && !reactive) {
      void this.ctx.close().catch(() => undefined)
      this.ctx = null
      this.master = null
      this.analyser = null
    }
    this.reactiveMode = reactive
    this.decks = [this.makeDeck(), this.makeDeck()]
    this.active = 0
    this.transitioning = false
    this.events.onReactiveChange?.(this.reactive)
  }

  private assign(deck: Deck, key: string, url: string): void {
    deck.key = key
    deck.url = url
    deck.ready = false
    deck.el.src = url
    deck.el.load()
  }

  /** Loads and (optionally) plays a track on the active deck, reusing a preload if present. */
  load(key: string, url: string, opts: { autoplay?: boolean; startAt?: number } = {}): void {
    this.ensureGraph()
    const token = ++this.playToken
    this.transitioning = false
    const standby = this.deck(this.standbyIndex())
    const current = this.deck()
    if (standby.key === key && standby.url) {
      current.el.pause()
      void this.setFade(current, 0, 0)
      this.active = this.standbyIndex()
    } else {
      current.el.pause()
      this.assign(current, key, url)
    }
    const deck = this.deck()
    void this.setFade(deck, 1, 0)
    if (opts.startAt && opts.startAt > 0) {
      const seekWhenReady = (): void => {
        deck.el.currentTime = opts.startAt!
      }
      if (deck.el.readyState >= 1) seekWhenReady()
      else deck.el.addEventListener('loadedmetadata', seekWhenReady, { once: true })
    } else if (deck.el.currentTime > 0) {
      deck.el.currentTime = 0
    }
    // Clean the other deck so it can take the next preload.
    const other = this.deck(this.standbyIndex())
    if (other.key !== null && other !== deck) {
      other.el.pause()
      other.key = null
      other.url = null
    }
    if (opts.autoplay !== false) void this.startPlayback(deck, token)
  }

  /** Preloads a track on the standby deck. */
  preload(key: string, url: string): void {
    const standby = this.deck(this.standbyIndex())
    if (standby.key === key || this.transitioning) return
    standby.el.pause()
    void this.setFade(standby, 1, 0)
    this.assign(standby, key, url)
  }

  hasPreloaded(key: string): boolean {
    const s = this.deck(this.standbyIndex())
    return s.key === key && s.url !== null
  }

  /** Starts the next track on the standby deck and fades between them. */
  crossfadeTo(key: string, url: string, seconds: number): void {
    if (this.transitioning) return
    this.ensureGraph()
    const outgoing = this.deck()
    const inIndex = this.standbyIndex()
    const incoming = this.deck(inIndex)
    if (incoming.key !== key) this.assign(incoming, key, url)
    this.transitioning = true
    const token = ++this.playToken
    void this.setFade(incoming, 0, 0)
    this.active = inIndex
    incoming.el.currentTime = 0
    void incoming.el.play().then(
      () => {
        if (token !== this.playToken) return
        void this.setFade(incoming, 1, seconds)
        void this.setFade(outgoing, 0, seconds).then(() => {
          if (token !== this.playToken) return
          outgoing.el.pause()
          outgoing.key = null
          outgoing.url = null
          this.transitioning = false
        })
      },
      () => {
        this.transitioning = false
        this.events.onError?.('Playback was blocked by the system.')
      }
    )
  }

  private async startPlayback(deck: Deck, token: number): Promise<void> {
    try {
      if (this.ctx?.state === 'suspended') await this.ctx.resume()
      void this.setFade(deck, 0, 0)
      await deck.el.play()
      if (token !== this.playToken) return
      await this.setFade(deck, 1, this.microFade)
    } catch (err) {
      if (token !== this.playToken) return
      const name = (err as { name?: string })?.name
      if (name === 'AbortError') return
      if (name === 'NotAllowedError') this.events.onError?.('Press play to start listening.')
      // Other errors surface through the element's error event.
    }
  }

  async play(): Promise<void> {
    const deck = this.deck()
    if (!deck.url) return
    this.ensureGraph()
    await this.startPlayback(deck, ++this.playToken)
  }

  async pause(): Promise<void> {
    const deck = this.deck()
    const token = ++this.playToken
    if (deck.el.paused) return
    await this.setFade(deck, 0, this.microFade)
    if (token !== this.playToken) return
    deck.el.pause()
    // Abort any crossfade: silence the other deck too.
    if (this.transitioning) {
      const other = this.deck(this.standbyIndex())
      other.el.pause()
      other.key = null
      other.url = null
      this.transitioning = false
    }
  }

  seek(seconds: number): void {
    const deck = this.deck()
    const d = this.duration
    deck.el.currentTime = Math.max(0, d > 0 ? Math.min(seconds, d - 0.05) : seconds)
    this.events.onTime?.(this.currentTime, d)
  }

  setVolume(v: number): void {
    if (!Number.isFinite(v)) return
    this.volume = Math.min(1, Math.max(0, v))
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.015)
    for (const d of this.decks) this.applyElementVolume(d)
  }

  stop(): void {
    ++this.playToken
    for (const d of this.decks) {
      d.el.pause()
      d.key = null
      d.url = null
      d.el.removeAttribute('src')
    }
    this.transitioning = false
  }

  /** Fills `out` with frequency data. Returns false when no analyser is available. */
  getFrequencyData(out: Uint8Array<ArrayBuffer>): boolean {
    if (!this.analyser) return false
    this.analyser.getByteFrequencyData(out)
    return true
  }

  get frequencyBinCount(): number {
    return this.analyser?.frequencyBinCount ?? 1024
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 44100
  }

  destroy(): void {
    for (const d of this.decks) this.disposeDeck(d)
    void this.ctx?.close().catch(() => undefined)
    this.ctx = null
  }
}
