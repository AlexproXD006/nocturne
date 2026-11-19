/**
 * JS side of the app-local Capacitor plugin `NocturneDiag`
 * (android/app/src/main/java/es/alexcloudweb/nocturne/diag/NocturneDiagPlugin.java): native crash reports kept
 * on disk by the uncaught-exception handler, JS errors recorded into the same store, and the scrubbed log ring.
 * Every method is fail-safe (never throws).
 */
export interface CrashReport {
  /** Stored file name (native only). */
  id?: string
  kind: 'native' | 'js'
  version: string
  android: string
  device: string
  /** Epoch ms. */
  at: number
  trace: string
}

export interface DiagnosticsPlugin {
  recordJsError(options: { message: string; stack: string }): Promise<void>
  pending(): Promise<{ reports?: CrashReport[] }>
  discard(): Promise<void>
  logSnapshot(): Promise<{ log?: string; device?: { version?: string; android?: string; device?: string } }>
}

export interface LogSnapshot {
  log: string
  version: string
  android: string
  device: string
}

export interface NativeDiagnostics {
  recordJsError(message: string, stack: string): Promise<void>
  pending(): Promise<CrashReport[]>
  discard(): Promise<void>
  logSnapshot(): Promise<LogSnapshot | null>
}

export function createNativeDiagnostics(box: Promise<{ plugin: DiagnosticsPlugin }>): NativeDiagnostics {
  return {
    async recordJsError(message, stack) {
      try {
        await (await box).plugin.recordJsError({ message: message.slice(0, 2000), stack: stack.slice(0, 8000) })
      } catch {
        /* ignore */
      }
    },
    async pending() {
      try {
        const res = await (await box).plugin.pending()
        return Array.isArray(res?.reports) ? res.reports.filter((r) => r && typeof r.trace === 'string') : []
      } catch {
        return []
      }
    },
    async discard() {
      try {
        await (await box).plugin.discard()
      } catch {
        /* ignore */
      }
    },
    async logSnapshot() {
      try {
        const r = await (await box).plugin.logSnapshot()
        return {
          log: typeof r?.log === 'string' ? r.log : '',
          version: r?.device?.version ?? '',
          android: r?.device?.android ?? '',
          device: r?.device?.device ?? ''
        }
      } catch {
        return null
      }
    }
  }
}

/** Server payload of one crash report (the server scrubs it again). */
export function crashPayload(r: CrashReport): Record<string, unknown> {
  return { source: 'crash', kind: r.kind === 'js' ? 'js' : 'native', version: r.version, android: r.android, device: r.device, at: r.at, trace: r.trace.slice(0, 48_000) }
}

/** window.onerror / unhandledrejection -> the native store; at most one report every 5 s. Returns an uninstall function. */
export function installJsErrorHooks(diag: Pick<NativeDiagnostics, 'recordJsError'>, target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window): () => void {
  let last = 0
  const record = (message: string, stack: string): void => {
    const now = Date.now()
    if (now - last < 5000) return
    last = now
    void diag.recordJsError(message, stack)
  }
  const onError = (e: Event): void => {
    const ev = e as ErrorEvent
    const err = ev.error as { stack?: unknown } | undefined
    record(String(ev.message ?? 'error'), typeof err?.stack === 'string' ? err.stack : `${ev.filename ?? ''}:${ev.lineno ?? 0}:${ev.colno ?? 0}`)
  }
  const onRejection = (e: Event): void => {
    const reason = (e as PromiseRejectionEvent).reason as { message?: unknown; stack?: unknown } | string | undefined
    if (typeof reason === 'string') record(`unhandledrejection: ${reason}`, '')
    else record(`unhandledrejection: ${String(reason?.message ?? 'rejected')}`, typeof reason?.stack === 'string' ? reason.stack : '')
  }
  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)
  return () => {
    target.removeEventListener('error', onError)
    target.removeEventListener('unhandledrejection', onRejection)
  }
}
