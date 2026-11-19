import { useEffect, useState, type ReactNode } from 'react'
import { api, platform } from '../services'
import { crashPayload, type CrashReport } from '../platform/diagnostics'
import { useUi } from '../store/ui'
import { useT } from '../i18n'
import { ConfirmDialog } from './ConfirmDialog'

/**
 * Shown once after a crash (Android): the native uncaught-exception handler left report files, so ask
 * "Nocturne closed unexpectedly. Send the report?". Send -> POST /v1/diagnostics/crash, then discard.
 */
export function CrashReportPrompt(): ReactNode {
  const tr = useT()
  const [reports, setReports] = useState<CrashReport[]>([])

  useEffect(() => {
    const diag = platform.diagnostics
    if (!diag) return
    let alive = true
    void diag.pending().then((r) => {
      if (alive && r.length > 0) setReports(r)
    })
    return () => {
      alive = false
    }
  }, [])

  if (reports.length === 0) return null
  const close = (): void => {
    void platform.diagnostics?.discard()
    setReports([])
  }
  return (
    <ConfirmDialog
      title={tr('crash.title')}
      message={tr('crash.message')}
      confirmLabel={tr('crash.send')}
      cancelLabel={tr('crash.discard')}
      onConfirm={async () => {
        for (const r of reports) await api.sendDiagnostic(crashPayload(r))
        useUi.getState().toast(tr('crash.sent'))
      }}
      onClose={close}
    />
  )
}
