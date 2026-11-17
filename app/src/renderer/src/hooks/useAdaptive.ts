import { useEffect, useMemo } from 'react'
import { platform } from '../services'
import { glassColors, resolvePerformance, type DeviceEnv } from '../lib/adaptive'
import { prefersReducedMotion, useSettings } from '../store/settings'

/**
 * Device facts the Adaptive backdrop's "auto" performance mode looks at.
 * `deviceMemory` is Chromium-only (Android WebView and Electron have it); when
 * a value is missing it simply doesn't count towards "low end".
 */
export function readDeviceEnv(reducedMotion: boolean): DeviceEnv {
  const nav = (typeof navigator !== 'undefined' ? navigator : {}) as { hardwareConcurrency?: number; deviceMemory?: number }
  return {
    reducedMotion,
    android: platform.kind === 'android',
    cores: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : undefined,
    memory: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : undefined
  }
}

/** DeviceEnv for the current motion preference (memoized). */
export function useDeviceEnv(): DeviceEnv {
  const motion = useSettings((s) => s.motion)
  return useMemo(() => readDeviceEnv(prefersReducedMotion(motion)), [motion])
}

/**
 * Publishes the Adaptive options the global CSS needs on <html>:
 *  - data-adaptive-scope ("everywhere" | "fullscreen"): glass panels only in "everywhere"
 *  - data-adaptive-perf ("quality" | "saver"): saver drops the panels' backdrop-filter
 *  - --adaptive-main-bg / --adaptive-chrome-bg / --adaptive-fade-*: panel glass colours
 */
export function useAdaptiveRoot(): void {
  const scope = useSettings((s) => s.adaptive.scope)
  const glass = useSettings((s) => s.adaptive.glass)
  const performance = useSettings((s) => s.adaptive.performance)
  const env = useDeviceEnv()
  const tier = resolvePerformance(performance, env)
  useEffect(() => {
    const root = document.documentElement
    root.setAttribute('data-adaptive-scope', scope)
    root.setAttribute('data-adaptive-perf', tier)
  }, [scope, tier])
  useEffect(() => {
    const c = glassColors(glass)
    const st = document.documentElement.style
    st.setProperty('--adaptive-main-bg', c.main)
    st.setProperty('--adaptive-chrome-bg', c.chrome)
    st.setProperty('--adaptive-fade-top', c.fadeTop)
    st.setProperty('--adaptive-fade-bottom', c.fadeBottom)
  }, [glass])
}
