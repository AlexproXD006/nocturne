import type { NocturneBridge } from '../shared/ipc'

declare global {
  interface Window {
    /** Present only inside the Electron desktop app. */
    nocturne?: NocturneBridge
  }
  const __APP_VERSION__: string
}

export {}
