import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach } from 'vitest'
import { setLanguagePref } from '../src/renderer/src/i18n'

// Node-environment suites (src/main) have no DOM; only wire DOM helpers when present.
const hasDom = typeof window !== 'undefined' && typeof document !== 'undefined'

if (hasDom) {
  if (typeof globalThis.performance === 'undefined') {
    ;(globalThis as { performance: Pick<Performance, 'now'> }).performance = { now: () => Date.now() }
  }
  if (typeof globalThis.requestAnimationFrame === 'undefined') {
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 16) as unknown as number) as typeof requestAnimationFrame
    globalThis.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof cancelAnimationFrame
  }
}

beforeEach(() => {
  // Tests assert English by default; individual suites switch language explicitly.
  setLanguagePref('en')
  if (!hasDom) return
  try {
    localStorage.clear()
    sessionStorage.clear()
  } catch {
    /* storage unavailable */
  }
})

afterEach(() => {
  if (hasDom) cleanup()
})
