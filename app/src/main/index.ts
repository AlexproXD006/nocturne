import { join } from 'node:path'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import {
  app,
  clipboard,
  dialog,
  nativeImage,
  BrowserWindow,
  ipcMain,
  net,
  Notification,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  type IpcMainInvokeEvent,
  type WebContents
} from 'electron'
import { IPC, type AppInfo, type WindowState } from '../shared/ipc'
import {
  APP_ORIGIN,
  APP_SCHEME,
  buildCsp,
  isPermissionAllowed,
  isSafeExternalUrl,
  isTrustedRendererUrl,
  mimeFor,
  resolveAppAsset
} from './security'
import { SecureStore } from './secure-store'
import { loadBounds, saveBounds } from './window-state'
import { parseUpdateNotice } from './update-notice'

const DEV_SERVER = process.env['ELECTRON_RENDERER_URL']
const isDev = !app.isPackaged && Boolean(DEV_SERVER)
const RENDERER_ROOT = join(__dirname, '../renderer')

// Must run before `ready`: our scheme behaves like https (secure context, fetch, media streaming).
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true }
  }
])

app.setAppUserModelId('es.alexcloudweb.nocturne')
// Hardware media keys + SMTC (Windows) / MPRIS (Linux) driven by navigator.mediaSession.
app.commandLine.appendSwitch('enable-features', 'HardwareMediaKeyHandling,MediaSessionService')

let mainWindow: BrowserWindow | null = null
let store: SecureStore | null = null
// Strong reference: a garbage-collected Notification loses its click handler.
let updateNotification: Notification | null = null

function focusMainWindow(): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

/** "Nocturne X available": click focuses the window and opens the download URL. */
function showUpdateNotification(raw: unknown): boolean {
  const notice = parseUpdateNotice(raw)
  if (!notice || !Notification.isSupported()) return false
  try {
    updateNotification?.close()
    const n = new Notification({
      title: notice.title,
      body: notice.body,
      icon: join(__dirname, '../../build/icon.png')
    })
    n.on('click', () => {
      focusMainWindow()
      void shell.openExternal(notice.url).catch(() => undefined)
    })
    n.on('close', () => {
      if (updateNotification === n) updateNotification = null
    })
    updateNotification = n
    n.show()
    return true
  } catch {
    return false
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
  void app.whenReady().then(bootstrap)
}

function windowState(win: BrowserWindow): WindowState {
  return { maximized: win.isMaximized(), fullscreen: win.isFullScreen(), focused: win.isFocused() }
}

function assertTrusted(event: IpcMainInvokeEvent): void {
  if (!isTrustedRendererUrl(event.senderFrame?.url, isDev ? DEV_SERVER : undefined)) {
    throw new Error('Blocked IPC from untrusted frame')
  }
}

function handle<T extends unknown[], R>(channel: string, fn: (event: IpcMainInvokeEvent, ...args: T) => R): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrusted(event)
    return fn(event, ...(args as T))
  })
}

function registerAppProtocol(): void {
  const csp = buildCsp()
  protocol.handle(APP_SCHEME, async (request) => {
    const file = resolveAppAsset(request.url, RENDERER_ROOT)
    if (!file) return new Response('Not found', { status: 404 })
    try {
      const res = await net.fetch(pathToFileURL(file).toString())
      const headers = new Headers({
        'Content-Type': mimeFor(file),
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Opener-Policy': 'same-origin'
      })
      if (file.endsWith('.html')) headers.set('Content-Security-Policy', csp)
      return new Response(res.body, { status: res.status, headers })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

function hardenSession(): void {
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(isPermissionAllowed(permission)))
  ses.setPermissionCheckHandler((_wc, permission) => isPermissionAllowed(permission))
  ses.setDevicePermissionHandler(() => false)
  if (isDev && DEV_SERVER) {
    const devCsp = buildCsp({ dev: true, devServer: DEV_SERVER })
    const origin = new URL(DEV_SERVER).origin
    ses.webRequest.onHeadersReceived({ urls: [`${origin}/*`] }, (details, callback) => {
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [devCsp] } })
    })
  }
}

function hardenContents(contents: WebContents): void {
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url, isDev ? DEV_SERVER : undefined)) event.preventDefault()
  })
  contents.on('will-redirect', (event, url) => {
    if (!isTrustedRendererUrl(url, isDev ? DEV_SERVER : undefined)) event.preventDefault()
  })
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
}

function createWindow(): BrowserWindow {
  const stateFile = join(app.getPath('userData'), 'window-state.json')
  const saved = loadBounds(stateFile)
  const visible = saved.x !== undefined && saved.y !== undefined
    ? screen.getAllDisplays().some(({ workArea: a }) =>
        saved.x! >= a.x - 50 && saved.y! >= a.y - 50 && saved.x! < a.x + a.width && saved.y! < a.y + a.height)
    : false

  const win = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    x: visible ? saved.x : undefined,
    y: visible ? saved.y : undefined,
    minWidth: 880,
    minHeight: 600,
    show: false,
    frame: false,
    backgroundColor: '#070a12',
    title: 'Nocturne',
    icon: join(__dirname, '../../build/icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
      devTools: isDev
    }
  })
  win.removeMenu()
  if (saved.maximized) win.maximize()

  const sendState = (): void => {
    if (!win.isDestroyed()) win.webContents.send(IPC.windowState, windowState(win))
  }
  for (const evt of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur'] as const) {
    win.on(evt as 'maximize', sendState)
  }
  win.once('ready-to-show', () => win.show())
  win.on('close', () => {
    const b = win.getNormalBounds()
    saveBounds(stateFile, { ...b, maximized: win.isMaximized() })
  })
  win.on('closed', () => {
    mainWindow = null
  })

  if (isDev && DEV_SERVER) void win.loadURL(DEV_SERVER)
  else void win.loadURL(`${APP_ORIGIN}/index.html`)
  return win
}

function registerIpc(): void {
  const withWindow = (event: IpcMainInvokeEvent): BrowserWindow | null => BrowserWindow.fromWebContents(event.sender)

  handle(IPC.secureGet, (_e, key: unknown) => {
    SecureStore.validateKey(key)
    return store!.get(key)
  })
  handle(IPC.secureSet, (_e, key: unknown, value: unknown) => {
    SecureStore.validateKey(key)
    SecureStore.validateValue(value)
    return store!.set(key, value)
  })
  handle(IPC.secureDelete, (_e, key: unknown) => {
    SecureStore.validateKey(key)
    return store!.delete(key)
  })

  handle(IPC.windowMinimize, (e) => withWindow(e)?.minimize())
  handle(IPC.windowToggleMaximize, (e) => {
    const win = withWindow(e)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  handle(IPC.windowClose, (e) => withWindow(e)?.close())
  handle(IPC.windowSetFullscreen, (e, on: unknown) => withWindow(e)?.setFullScreen(on === true))

  handle(IPC.appInfo, (): AppInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    secureStorage: safeStorage.isEncryptionAvailable()
  }))
  handle(IPC.openExternal, async (_e, url: unknown) => {
    if (!isSafeExternalUrl(url)) throw new Error('Refusing to open non-web URL')
    await shell.openExternal(url)
  })
  handle(IPC.notifyUpdate, (_e, info: unknown) => showUpdateNotification(info))
  handle(IPC.imageSave, async (e, bytes: unknown, filename: unknown) => {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > 32 * 1024 * 1024) throw new Error('Invalid image')
    const base = typeof filename === 'string' ? filename.replace(/[^\w.-]+/g, '-').slice(0, 100) : ''
    const name = base.toLowerCase().endsWith('.png') ? base : 'nocturne.png'
    const win = withWindow(e)
    const opts = { defaultPath: join(app.getPath('pictures'), name), filters: [{ name: 'PNG', extensions: ['png'] }] }
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return false
    await writeFile(res.filePath, bytes)
    return true
  })
  handle(IPC.imageCopy, (_e, bytes: unknown) => {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > 32 * 1024 * 1024) throw new Error('Invalid image')
    const img = nativeImage.createFromBuffer(Buffer.from(bytes))
    if (img.isEmpty()) throw new Error('Invalid image')
    ;(clipboard as unknown as { writeImage(i: Electron.NativeImage): void }).writeImage(img)
    return true
  })
}

async function bootstrap(): Promise<void> {
  store = new SecureStore(join(app.getPath('userData'), 'secure-store.json'), safeStorage, {
    readFile: (p) => readFile(p, 'utf8'),
    writeFile: (p, d) => writeFile(p, d, { mode: 0o600 }),
    rename
  })
  registerAppProtocol()
  hardenSession()
  app.on('web-contents-created', (_e, contents) => hardenContents(contents))
  registerIpc()
  mainWindow = createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
