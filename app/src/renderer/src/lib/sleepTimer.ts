/** Pure helpers for the sleep timer (see store/sleepTimer.ts). */

/** Volume fades out linearly over this many seconds before playback pauses. */
export const FADE_SECONDS = 10

/** Quick choices, in minutes. "End of track" and "Custom" are separate menu entries. */
export const SLEEP_PRESETS = [5, 15, 30, 45, 60] as const

export const MAX_CUSTOM_MINUTES = 720

/** Gain multiplier (0..1) for `remainingSec` seconds before the timer ends. */
export function fadeFactor(remainingSec: number): number {
  if (!Number.isFinite(remainingSec) || remainingSec >= FADE_SECONDS) return 1
  if (remainingSec <= 0) return 0
  return remainingSec / FADE_SECONDS
}

/** Minutes typed by the user ("45", "1.5" is rejected): a whole number in 1..720, else null. */
export function parseCustomMinutes(input: string): number | null {
  const v = input.trim()
  if (!/^\d{1,4}$/.test(v)) return null
  const n = Number(v)
  return n >= 1 && n <= MAX_CUSTOM_MINUTES ? n : null
}

/** "4:07" or "1:02:03" (rounded up so the display never shows 0:00 while time is left). */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
