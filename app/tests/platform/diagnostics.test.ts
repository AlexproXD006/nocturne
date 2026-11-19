import { describe, expect, it, vi } from 'vitest'
import { crashPayload, createNativeDiagnostics, installJsErrorHooks, type DiagnosticsPlugin } from '@/platform/diagnostics'
import { headLines } from '@/pages/admin/DiagnosticsTab'
import { en } from '@/i18n/en'
import { es } from '@/i18n/es'

function plugin(over: Partial<Record<keyof DiagnosticsPlugin, unknown>> = {}) {
  const raw = {
    recordJsError: vi.fn(async () => undefined),
    pending: vi.fn(async () => ({ reports: [{ kind: 'native', version: '1', android: 'A14', device: 'S', at: 1, trace: 'boom' }] })),
    discard: vi.fn(async () => undefined),
    logSnapshot: vi.fn(async () => ({ log: 'W/x: y', device: { version: '1', android: 'A14', device: 'S' } })),
    ...over
  }
  return { raw, box: Promise.resolve({ plugin: raw as unknown as DiagnosticsPlugin }) }
}

describe('createNativeDiagnostics', () => {
  it('lists pending reports, snapshots the log and discards', async () => {
    const p = plugin()
    const d = createNativeDiagnostics(p.box)
    expect((await d.pending())[0]?.trace).toBe('boom')
    expect(await d.logSnapshot()).toEqual({ log: 'W/x: y', version: '1', android: 'A14', device: 'S' })
    await d.discard()
    expect(p.raw.discard).toHaveBeenCalled()
  })

  it('never throws when the plugin is missing', async () => {
    const d = createNativeDiagnostics(Promise.reject(new Error('no plugin')))
    expect(await d.pending()).toEqual([])
    expect(await d.logSnapshot()).toBeNull()
    await expect(d.discard()).resolves.toBeUndefined()
    await expect(d.recordJsError('m', 's')).resolves.toBeUndefined()
  })

  it('builds the server payload', () => {
    const p = crashPayload({ kind: 'native', version: '1.1.1', android: 'A14', device: 'S', at: 5, trace: 't' })
    expect(p).toMatchObject({ source: 'crash', kind: 'native', version: '1.1.1', trace: 't', at: 5 })
  })
})

describe('installJsErrorHooks', () => {
  it('records errors and rejections, rate limited, and uninstalls', () => {
    const handlers = new Map<string, (e: Event) => void>()
    const target = {
      addEventListener: (n: string, f: (e: Event) => void) => void handlers.set(n, f),
      removeEventListener: (n: string) => void handlers.delete(n)
    }
    const rec = vi.fn(async () => undefined)
    const off = installJsErrorHooks({ recordJsError: rec }, target as unknown as Window)
    handlers.get('error')?.({ message: 'bad', error: { stack: 'at x' } } as unknown as Event)
    handlers.get('unhandledrejection')?.({ reason: new Error('nope') } as unknown as Event)
    expect(rec).toHaveBeenCalledTimes(1)
    expect(rec).toHaveBeenCalledWith('bad', 'at x')
    off()
    expect(handlers.size).toBe(0)
  })
})

describe('admin diagnostics + i18n', () => {
  it('shows the first non-empty lines', () => {
    expect(headLines('a\n\nb\nc\nd', 2)).toBe('a\nb')
  })
  it('has the crash prompt and diagnostics keys in en and es', () => {
    for (const k of ['crash.title', 'crash.message', 'crash.send', 'crash.discard', 'adm.tab.diagnostics', 'set.diagRow'] as const) {
      expect(en[k]).toBeTruthy()
      expect(es[k]).toBeTruthy()
    }
    expect(es['crash.message']).toContain('Nocturne se cerró inesperadamente. ¿Enviar informe?')
  })
})
