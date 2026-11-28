import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type NocturneBridge, type OfflineProgress, type WindowState } from '../shared/ipc'

// Minimal, typed surface. No raw ipcRenderer is ever exposed to the page.
const bridge: NocturneBridge = {
  secure: {
    get: (key) => ipcRenderer.invoke(IPC.secureGet, key),
    set: (key, value) => ipcRenderer.invoke(IPC.secureSet, key, value),
    delete: (key) => ipcRenderer.invoke(IPC.secureDelete, key)
  },
  window: {
    minimize: () => ipcRenderer.invoke(IPC.windowMinimize),
    toggleMaximize: () => ipcRenderer.invoke(IPC.windowToggleMaximize),
    close: () => ipcRenderer.invoke(IPC.windowClose),
    setFullscreen: (on) => ipcRenderer.invoke(IPC.windowSetFullscreen, on === true),
    onState: (listener) => {
      const wrapped = (_e: IpcRendererEvent, state: WindowState): void => listener(state)
      ipcRenderer.on(IPC.windowState, wrapped)
      return () => ipcRenderer.removeListener(IPC.windowState, wrapped)
    }
  },
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo),
    openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
    notifyUpdate: (info) => ipcRenderer.invoke(IPC.notifyUpdate, info)
  },
  offline: {
    list: () => ipcRenderer.invoke(IPC.offlineList),
    store: (id, url, opts) => ipcRenderer.invoke(IPC.offlineStore, id, url, opts),
    abort: (id) => ipcRenderer.invoke(IPC.offlineAbort, id),
    onProgress: (listener) => {
      const wrapped = (_e: IpcRendererEvent, p: OfflineProgress): void => listener(p)
      ipcRenderer.on(IPC.offlineProgress, wrapped)
      return () => ipcRenderer.removeListener(IPC.offlineProgress, wrapped)
    },
    setPinned: (id, pinned) => ipcRenderer.invoke(IPC.offlineSetPinned, id, pinned),
    touch: (id) => ipcRenderer.invoke(IPC.offlineTouch, id),
    remove: (ids) => ipcRenderer.invoke(IPC.offlineRemove, ids),
    clearAuto: () => ipcRenderer.invoke(IPC.offlineClear),
    configure: (settings) => ipcRenderer.invoke(IPC.offlineConfigure, settings)
  },
  image: {
    save: (bytes, filename) => ipcRenderer.invoke(IPC.imageSave, bytes, filename),
    copy: (bytes) => ipcRenderer.invoke(IPC.imageCopy, bytes)
  }
}

contextBridge.exposeInMainWorld('nocturne', Object.freeze(bridge))
