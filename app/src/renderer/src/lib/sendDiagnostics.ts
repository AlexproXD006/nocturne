import { api, platform } from '../services'
import { useUi } from '../store/ui'

/** Settings -> "Send diagnostic report": the scrubbed native log ring goes to the server (admins read it in Admin > Diagnostics). */
export async function sendDiagnosticLog(okMessage: string, failMessage: string): Promise<boolean> {
  try {
    const snap = await platform.diagnostics?.logSnapshot()
    if (!snap) throw new Error('no log')
    await api.sendDiagnostic({
      source: 'manual',
      kind: 'log',
      version: snap.version || __APP_VERSION__,
      android: snap.android,
      device: snap.device,
      at: Date.now(),
      log: snap.log.trim() ? snap.log : '(empty log)'
    })
    useUi.getState().toast(okMessage)
    return true
  } catch {
    useUi.getState().toast(failMessage, 'error')
    return false
  }
}
