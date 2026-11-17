import { create } from 'zustand'

export type SidePanel = 'queue' | 'lyrics' | null

export interface Toast {
  id: number
  message: string
  tone: 'info' | 'error'
}

interface UiState {
  panel: SidePanel
  fullscreen: boolean
  toasts: Toast[]
  togglePanel(panel: Exclude<SidePanel, null>): void
  closePanel(): void
  setFullscreen(on: boolean): void
  toast(message: string, tone?: Toast['tone']): void
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
  toast(message, tone = 'info') {
    const id = ++toastId
    // Collapse duplicates so a flapping error doesn't stack up.
    const rest = get().toasts.filter((t) => t.message !== message).slice(-2)
    set({ toasts: [...rest, { id, message, tone }] })
    setTimeout(() => get().dismissToast(id), tone === 'error' ? 6000 : 3500)
  },
  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) })
  }
}))
