import { create } from 'zustand'

export type SidePanel = 'queue' | 'lyrics' | null

export interface ToastAction {
  label: string
  /** Runs when the action button is pressed; the toast is dismissed first. */
  run: () => void
}

export interface Toast {
  id: number
  message: string
  tone: 'info' | 'error'
  /** Optional button shown next to the message (e.g. "Add again"). */
  action?: ToastAction
}

interface UiState {
  panel: SidePanel
  fullscreen: boolean
  toasts: Toast[]
  togglePanel(panel: Exclude<SidePanel, null>): void
  closePanel(): void
  setFullscreen(on: boolean): void
  toast(message: string, tone?: Toast['tone'], opts?: { action?: ToastAction }): void
  dismissToast(id: number): void
}

let toastId = 0

export const useUi = create<UiState>((set, get) => ({
  panel: null,
  fullscreen: false,
  toasts: [],
  togglePanel(panel) {
    set({ panel: get().panel === panel ? null : panel })
  },
  closePanel() {
    set({ panel: null })
  },
  setFullscreen(on) {
    set({ fullscreen: on })
  },
  toast(message, tone = 'info', opts) {
    const id = ++toastId
    const action = opts?.action
    // Collapse duplicates so a flapping error doesn't stack up.
    const rest = get().toasts.filter((t) => t.message !== message).slice(-2)
    set({ toasts: [...rest, action ? { id, message, tone, action } : { id, message, tone }] })
    // Toasts with a button stay a little longer so there is time to reach it.
    setTimeout(() => get().dismissToast(id), tone === 'error' || action ? 6000 : 3500)
  },
  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) })
  }
}))
