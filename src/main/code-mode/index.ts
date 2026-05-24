import { EventEmitter } from 'events'
import { detectProject } from './detect-project'
import { DevServerManager, DevServerEvent } from './dev-server'
import { createPreviewWindow, PreviewWindowController } from './window'
import type { CodeModeState, DeviceMode } from '../../shared/types'

export type CodeModeBroadcast =
  | { type: 'state'; state: CodeModeState }
  | { type: 'log'; stream: 'stdout' | 'stderr'; line: string }

export class CodeModeController extends EventEmitter {
  private state: CodeModeState = {
    status: 'idle',
    projectPath: null,
    project: null,
    url: null,
    error: null,
    device: 'desktop',
    inspecting: false,
  }
  private server = new DevServerManager()
  private window: PreviewWindowController | null = null
  /**
   * When true, code mode skips creating its own preview window — the fullscreen
   * window embeds the dev-server URL directly via <webview>. Set externally by
   * the main process based on whether the fullscreen window is open.
   */
  private embeddedMode = false

  constructor() {
    super()
    this.server.on('event', (evt: DevServerEvent) => {
      if (evt.type === 'log') {
        this.emit('broadcast', { type: 'log', stream: evt.stream, line: evt.line })
      } else if (evt.type === 'exit' && this.state.status === 'ready') {
        // Dev server died after starting — surface it as an error.
        this.transition({ status: 'error', error: 'Dev server exited unexpectedly' })
      }
    })
  }

  getState(): CodeModeState {
    return { ...this.state }
  }

  recentLogs(): string[] {
    return this.server.recentLogs()
  }

  private transition(patch: Partial<CodeModeState>): void {
    this.state = { ...this.state, ...patch }
    this.emit('broadcast', { type: 'state', state: this.getState() })
  }

  setEmbedded(embedded: boolean): void {
    this.embeddedMode = embedded
    // If we're switching while a preview window exists, close it. The
    // embedding renderer (fullscreen) already reads codeMode.url from state
    // and will render its own webview.
    if (embedded && this.window) {
      try { this.window.destroy() } catch {}
      this.window = null
    }
    // If we're switching back to non-embedded while code mode is ready,
    // pop a fresh preview window so the user keeps a visible preview.
    if (!embedded && this.state.status === 'ready' && this.state.url && !this.window) {
      try {
        this.window = createPreviewWindow({
          url: this.state.url,
          device: this.state.device,
          onClosed: () => {
            if (this.window) this.window = null
            if (this.state.status === 'ready' || this.state.status === 'starting') {
              this.stop().catch(() => {})
            }
          },
        })
      } catch {}
    }
  }

  async start(projectPath: string): Promise<CodeModeState> {
    if (this.state.status === 'starting' || this.state.status === 'detecting') {
      return this.getState()
    }
    if (this.state.status === 'ready') {
      // Already running for the same path — just refocus the window.
      if (this.state.projectPath === projectPath) {
        this.window?.window.show()
        return this.getState()
      }
      // Different path — stop first.
      await this.stop()
    }

    this.transition({
      status: 'detecting',
      projectPath,
      project: null,
      url: null,
      error: null,
    })

    const project = detectProject(projectPath)
    if (project.kind === 'unknown') {
      this.transition({
        status: 'error',
        error:
          "Couldn't find a recognizable project. Need a package.json with a dev/start script, or an index.html.",
        project,
      })
      return this.getState()
    }

    this.transition({ status: 'starting', project })

    try {
      const result = await this.server.start(projectPath, project)
      this.transition({ status: 'ready', url: result.url })

      // Embedded mode (fullscreen window is open) — skip the preview window.
      if (this.embeddedMode) return this.getState()

      const win = createPreviewWindow({
        url: result.url,
        device: this.state.device,
        onClosed: () => {
          // User closed the preview window — stop the dev server too.
          if (this.window) {
            this.window = null
          }
          if (this.state.status === 'ready' || this.state.status === 'starting') {
            this.stop().catch(() => {})
          }
        },
      })
      this.window = win
      return this.getState()
    } catch (err) {
      const message = (err as Error).message
      this.transition({ status: 'error', error: message })
      return this.getState()
    }
  }

  async stop(): Promise<void> {
    if (this.state.status === 'idle' || this.state.status === 'stopping') return
    this.transition({ status: 'stopping' })
    try {
      this.server.kill()
    } catch {}
    if (this.window) {
      try {
        this.window.destroy()
      } catch {}
      this.window = null
    }
    this.transition({
      status: 'idle',
      url: null,
      project: null,
      projectPath: null,
      error: null,
      inspecting: false,
    })
  }

  reload(): boolean {
    if (!this.window) return false
    return this.window.reloadWebview()
  }

  toggleInspect(): boolean {
    if (!this.window) return false
    const next = this.window.toggleInspect()
    this.transition({ inspecting: next })
    return next
  }

  setDevice(device: DeviceMode): void {
    this.transition({ device })
    if (this.window) this.window.setDevice(device)
  }

  registerWebview(webContentsId: number): void {
    this.window?.registerWebview(webContentsId)
  }

  shutdown(): void {
    this.server.kill()
    if (this.window) {
      try {
        this.window.destroy()
      } catch {}
      this.window = null
    }
  }
}
