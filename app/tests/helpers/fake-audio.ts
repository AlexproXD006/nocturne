import { vi } from 'vitest'

/** Minimal HTMLAudioElement double: an EventTarget with the members AudioEngine touches. */
export class FakeAudio extends EventTarget {
  src = ''
  currentTime = 0
  duration = Number.NaN
  paused = true
  ended = false
  readyState = 0
  crossOrigin: string | null = null
  volume = 1
  preload = ''
  error: { code: number } | null = null

  playError: Error | null = null
  /** When set, play() returns this promise instead of resolving on its own. */
  playGate: Promise<void> | null = null
  playCalls = 0
  pauseCalls = 0
  loadCalls = 0
  srcRemoved = false

  play(): Promise<void> {
    this.playCalls++
    this.paused = false
    const gate = this.playGate
    const failure = this.playError
    return Promise.resolve()
      .then(() => gate)
      .then(() => {
        if (failure) {
          this.paused = true
          throw failure
        }
        this.dispatchEvent(new Event('playing'))
      })
  }

  pause(): void {
    this.pauseCalls++
    if (!this.paused) {
      this.paused = true
      this.dispatchEvent(new Event('pause'))
    }
  }

  load(): void {
    this.loadCalls++
  }

  removeAttribute(name: string): void {
    if (name === 'src') {
      this.src = ''
      this.srcRemoved = true
    }
  }

  emit(type: string): void {
    this.dispatchEvent(new Event(type))
  }
}

export function domError(name: string, message = name): Error {
  return Object.assign(new Error(message), { name })
}

export class FakeParam {
  value = 1
  cancelScheduledValues = vi.fn()
  setValueAtTime = vi.fn((v: number) => {
    this.value = v
  })
  linearRampToValueAtTime = vi.fn()
  setTargetAtTime = vi.fn()
}

export class FakeGain {
  gain = new FakeParam()
  connect = vi.fn()
  disconnect = vi.fn()
}

export class FakeAnalyser {
  fftSize = 0
  smoothingTimeConstant = 0
  frequencyBinCount = 1024
  connect = vi.fn()
  disconnect = vi.fn()
  getByteFrequencyData = vi.fn((out: Uint8Array) => {
    out.fill(7)
  })
}

export class FakeBiquad {
  type = 'peaking'
  frequency = new FakeParam()
  Q = new FakeParam()
  gain = new FakeParam()
  connect = vi.fn()
  disconnect = vi.fn()
}

export class FakeSource {
  connect = vi.fn()
  disconnect = vi.fn()
  constructor(readonly el: unknown) {}
}

export class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  static throwOnConstruct = false
  state: 'running' | 'suspended' | 'closed' = 'running'
  currentTime = 5
  sampleRate = 48000
  destination = { kind: 'destination' }
  gains: FakeGain[] = []
  analysers: FakeAnalyser[] = []
  filters: FakeBiquad[] = []
  sources: FakeSource[] = []
  resume = vi.fn(async () => {
    this.state = 'running'
  })
  close = vi.fn(async () => {
    this.state = 'closed'
  })

  constructor(readonly options?: unknown) {
    if (FakeAudioContext.throwOnConstruct) throw new Error('AudioContext not allowed')
    FakeAudioContext.instances.push(this)
  }

  createGain(): FakeGain {
    const g = new FakeGain()
    this.gains.push(g)
    return g
  }

  createBiquadFilter(): FakeBiquad {
    const f = new FakeBiquad()
    this.filters.push(f)
    return f
  }

  createAnalyser(): FakeAnalyser {
    const a = new FakeAnalyser()
    this.analysers.push(a)
    return a
  }

  createMediaElementSource(el: unknown): FakeSource {
    const s = new FakeSource(el)
    this.sources.push(s)
    return s
  }

  static reset(): void {
    FakeAudioContext.instances = []
    FakeAudioContext.throwOnConstruct = false
  }
}
