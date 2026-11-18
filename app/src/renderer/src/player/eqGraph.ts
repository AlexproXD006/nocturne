import { bandType, clampGain, clampPreamp, DEFAULT_EQ, EQ_BANDS, EQ_BAND_COUNT, EQ_Q, type EqState } from '../lib/eq'

/** Parameter changes glide (time constant, seconds) so dragging a band never clicks. */
const SMOOTH = 0.02
/** After flattening for a bypass, wait this long (ms) before re-wiring around the filters. */
const BYPASS_SETTLE_MS = 90

/**
 * The equalizer part of the Web Audio graph: `input -> 10 BiquadFilterNodes -> preamp -> output`.
 * Disabled = bypass: the filters are flattened (no click), then the signal is wired straight from
 * `input` to `output`, so a disabled equalizer costs no processing and cannot colour the sound.
 */
export class EqGraph {
  private readonly filters: BiquadFilterNode[]
  private readonly preamp: GainNode
  private state: EqState = { ...DEFAULT_EQ, gains: [...DEFAULT_EQ.gains] }
  private bypassed = false
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly ctx: AudioContext,
    private readonly input: AudioNode,
    private readonly output: AudioNode
  ) {
    this.filters = EQ_BANDS.map((freq, i) => {
      const f = ctx.createBiquadFilter()
      f.type = bandType(i)
      f.frequency.value = freq
      f.Q.value = EQ_Q
      f.gain.value = 0
      return f
    })
    this.preamp = ctx.createGain()
    this.preamp.gain.value = 1
    this.filters.forEach((f, i) => {
      if (i > 0) this.filters[i - 1]!.connect(f)
    })
    this.filters[EQ_BAND_COUNT - 1]!.connect(this.preamp)
    this.preamp.connect(output)
    this.bypassed = true
    this.input.connect(output)
  }

  get isBypassed(): boolean {
    return this.bypassed
  }

  get filterNodes(): readonly BiquadFilterNode[] {
    return this.filters
  }

  get preampNode(): GainNode {
    return this.preamp
  }

  apply(next: EqState): void {
    this.state = next
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const now = this.ctx.currentTime
    if (next.enabled) {
      if (this.bypassed) this.engage()
      this.filters.forEach((f, i) => f.gain.setTargetAtTime(clampGain(next.gains[i] ?? 0), now, SMOOTH))
      this.preamp.gain.setTargetAtTime(dbToLinear(clampPreamp(next.preamp)), now, SMOOTH)
    } else if (!this.bypassed) {
      this.filters.forEach((f) => f.gain.setTargetAtTime(0, now, SMOOTH))
      this.preamp.gain.setTargetAtTime(1, now, SMOOTH)
      this.timer = setTimeout(() => {
        this.timer = null
        if (!this.state.enabled) this.release()
      }, BYPASS_SETTLE_MS)
    }
  }

  /** Routes the signal through the filters. */
  private engage(): void {
    this.input.connect(this.filters[0]!)
    this.input.disconnect(this.output)
    this.bypassed = false
  }

  /** Routes the signal around the filters (they are already flat). */
  private release(): void {
    this.input.connect(this.output)
    this.input.disconnect(this.filters[0]!)
    this.bypassed = true
  }

  destroy(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.filters.forEach((f) => f.disconnect())
    this.preamp.disconnect()
  }
}

export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20)
}
