import { BrowserWindow, screen, WebContents } from 'electron'
import { join } from 'path'
import type { DeviceMode } from '../../shared/types'

const DEVICE_DIMENSIONS: Record<DeviceMode, { width: number; height: number }> = {
  mobile: { width: 412, height: 870 },
  tablet: { width: 834, height: 1000 },
  desktop: { width: 1280, height: 900 },
}

/** Extra height for our floating toolbar + window chrome. */
const TOOLBAR_HEIGHT_PADDING = 0

export interface PreviewWindowController {
  window: BrowserWindow
  setDevice(mode: DeviceMode): void
  registerWebview(webContentsId: number): void
  reloadWebview(): boolean
  toggleInspect(): boolean
  isInspecting(): boolean
  destroy(): void
}

export interface PreviewWindowOptions {
  url: string
  device: DeviceMode
  onClosed: () => void
}

export function createPreviewWindow(options: PreviewWindowOptions): PreviewWindowController {
  const { url, device, onClosed } = options

  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const target = DEVICE_DIMENSIONS[device]

  const x = display.workArea.x + Math.max(20, Math.round((display.workArea.width - target.width) / 2))
  const y = display.workArea.y + Math.max(20, Math.round((display.workArea.height - target.height) / 2))

  const win = new BrowserWindow({
    width: target.width,
    height: target.height + TOOLBAR_HEIGHT_PADDING,
    x,
    y,
    title: 'Rax — Code Mode',
    frame: false,
    transparent: false,
    resizable: true,
    movable: true,
    minimizable: true,
    maximizable: true,
    backgroundColor: '#101012',
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 14, y: 16 } : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/code-mode.js'),
      sandbox: false,            // need <webview> + ipcRenderer
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })

  let webviewWebContents: WebContents | null = null
  let inspecting = false

  const initialPayload = {
    url,
    device,
  }

  // Pass the initial URL via the URL query string AND make it available on demand
  // through the preload (preload listens to a one-shot IPC).
  const params = new URLSearchParams({
    url,
    device,
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/code-mode.html?${params.toString()}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/code-mode.html'), { search: params.toString() })
  }

  win.once('ready-to-show', () => {
    win.show()
  })

  win.on('closed', () => {
    onClosed()
  })

  // Don't let the preview shell navigate away from our renderer page.
  win.webContents.on('will-navigate', (event, navUrl) => {
    if (!navUrl.includes('code-mode.html') && !navUrl.startsWith(process.env.ELECTRON_RENDERER_URL || '')) {
      event.preventDefault()
    }
  })

  // The <webview> requests permission to attach. Let it through.
  win.webContents.on('did-attach-webview', (_event, contents) => {
    webviewWebContents = contents
  })

  // Open external links from inside the previewed app in the user's default browser.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith('http://') || target.startsWith('https://')) {
      const { shell } = require('electron')
      shell.openExternal(target).catch(() => {})
    }
    return { action: 'deny' }
  })

  void initialPayload

  return {
    window: win,
    setDevice(mode: DeviceMode) {
      const dims = DEVICE_DIMENSIONS[mode]
      const bounds = win.getBounds()
      win.setBounds({
        x: bounds.x,
        y: bounds.y,
        width: dims.width,
        height: dims.height + TOOLBAR_HEIGHT_PADDING,
      })
    },
    registerWebview(webContentsId: number) {
      const { webContents } = require('electron') as typeof import('electron')
      const wc = webContents.fromId(webContentsId)
      if (wc) webviewWebContents = wc
    },
    reloadWebview(): boolean {
      if (!webviewWebContents || webviewWebContents.isDestroyed()) return false
      webviewWebContents.reload()
      return true
    },
    toggleInspect(): boolean {
      // Resolve the webview lazily. The cached reference can be stale if the
      // webview reloaded; falling back to a live lookup of all webContents
      // lets the button work even before `did-attach-webview` has fired.
      let wc: WebContents | null = webviewWebContents
      if (!wc || wc.isDestroyed()) {
        try {
          const { webContents } = require('electron') as typeof import('electron')
          const all = webContents.getAllWebContents()
          // Pick a guest webContents whose embedder is THIS preview window.
          wc =
            all.find(
              (c) =>
                c.getType() === 'webview' &&
                !c.isDestroyed() &&
                c.hostWebContents?.id === win.webContents.id,
            ) || null
          if (wc) webviewWebContents = wc
        } catch {}
      }
      if (!wc || wc.isDestroyed()) return false

      if (wc.isDevToolsOpened()) {
        wc.closeDevTools()
        inspecting = false
        return inspecting
      }

      // Open docked to the right so the user always sees the panel pop in
      // beside the previewed page — never behind it.
      wc.openDevTools({ mode: 'right', activate: true })
      inspecting = true

      // Once the DevTools webContents exists, raise its window to the front
      // and start in element-picker mode so the inspect button feels native.
      const tryFocus = (attempts = 0) => {
        const dtwc = wc!.devToolsWebContents
        if (!dtwc || dtwc.isDestroyed()) {
          if (attempts < 20) setTimeout(() => tryFocus(attempts + 1), 25)
          return
        }
        try {
          dtwc.focus()
          // Defer one tick to let the panel finish wiring up before sending
          // it a command to enter "select element" mode.
          setTimeout(() => {
            try {
              dtwc.executeJavaScript(
                "DevToolsAPI && DevToolsAPI.enterInspectElementMode && DevToolsAPI.enterInspectElementMode()",
              ).catch(() => {})
            } catch {}
          }, 80)
        } catch {}
      }
      tryFocus()

      return inspecting
    },
    isInspecting() {
      return inspecting
    },
    destroy() {
      if (!win.isDestroyed()) win.destroy()
    },
  }
}
