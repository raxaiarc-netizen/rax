import { contextBridge, ipcRenderer } from 'electron'
import type { CodeModeState, DeviceMode } from '../shared/types'

// IPC channel names are inlined here (rather than imported from shared/types)
// so this preload bundles to a single self-contained file. Sandboxed preloads
// cannot resolve relative require() paths, so any shared chunk would fail to
// load at runtime. Keep these strings in sync with src/shared/types.ts.
const CHANNELS = {
  CODE_MODE_GET_INITIAL: 'rax:code-mode-get-initial',
  CODE_MODE_RELOAD: 'rax:code-mode-reload',
  CODE_MODE_TOGGLE_INSPECT: 'rax:code-mode-toggle-inspect',
  CODE_MODE_SET_DEVICE: 'rax:code-mode-set-device',
  CODE_MODE_STOP: 'rax:code-mode-stop',
  CODE_MODE_WEBVIEW_REGISTER: 'rax:code-mode-webview-register',
  CODE_MODE_STATUS_CHANGED: 'rax:code-mode-status-changed',
  CODE_MODE_LOG: 'rax:code-mode-log',
  OPEN_EXTERNAL: 'rax:open-external',
} as const

export interface CodeModePreviewAPI {
  getInitialState(): Promise<CodeModeState>
  reload(): Promise<boolean>
  toggleInspect(): Promise<boolean>
  setDevice(device: DeviceMode): Promise<CodeModeState>
  stop(): Promise<{ ok: boolean; state: CodeModeState }>
  registerWebview(webContentsId: number): void
  openExternal(url: string): Promise<{ ok: boolean }>
  onStatus(callback: (state: CodeModeState) => void): () => void
  onLog(callback: (msg: { stream: 'stdout' | 'stderr'; line: string }) => void): () => void
}

const api: CodeModePreviewAPI = {
  getInitialState: () => ipcRenderer.invoke(CHANNELS.CODE_MODE_GET_INITIAL),
  reload: () => ipcRenderer.invoke(CHANNELS.CODE_MODE_RELOAD),
  toggleInspect: () => ipcRenderer.invoke(CHANNELS.CODE_MODE_TOGGLE_INSPECT),
  setDevice: (device) => ipcRenderer.invoke(CHANNELS.CODE_MODE_SET_DEVICE, device),
  stop: () => ipcRenderer.invoke(CHANNELS.CODE_MODE_STOP),
  registerWebview: (id) => ipcRenderer.send(CHANNELS.CODE_MODE_WEBVIEW_REGISTER, id),
  openExternal: (url) => ipcRenderer.invoke(CHANNELS.OPEN_EXTERNAL, url),
  onStatus: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, state: CodeModeState) => callback(state)
    ipcRenderer.on(CHANNELS.CODE_MODE_STATUS_CHANGED, handler)
    return () => ipcRenderer.removeListener(CHANNELS.CODE_MODE_STATUS_CHANGED, handler)
  },
  onLog: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      msg: { stream: 'stdout' | 'stderr'; line: string },
    ) => callback(msg)
    ipcRenderer.on(CHANNELS.CODE_MODE_LOG, handler)
    return () => ipcRenderer.removeListener(CHANNELS.CODE_MODE_LOG, handler)
  },
}

contextBridge.exposeInMainWorld('codeMode', api)
