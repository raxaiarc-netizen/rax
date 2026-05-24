import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/types'
import type { RunOptions, NormalizedEvent, HealthReport, EnrichedError, Attachment, SessionMeta, CatalogPlugin, SessionLoadMessage, CodeModeState, DeviceMode, MirrorAction, SessionSnapshot, ClaudeMode, ClaudeInstanceInfo, ClaudeLoginEvent, UpdaterStatus } from '../shared/types'
import type { TranscriptInput } from '../shared/transcript'

export interface ExportTranscriptResult {
  ok: boolean
  path?: string
  error?: string
  canceled?: boolean
}

export interface RaxAPI {
  // ─── Request-response (renderer → main) ───
  start(): Promise<{ version: string; auth: { email?: string; subscriptionType?: string; authMethod?: string }; mcpServers: string[]; projectPath: string; homePath: string }>
  createTab(opts?: { desiredId?: string }): Promise<{ tabId: string }>
  prompt(tabId: string, requestId: string, options: RunOptions): Promise<void>
  cancel(requestId: string): Promise<boolean>
  stopTab(tabId: string): Promise<boolean>
  retry(tabId: string, requestId: string, options: RunOptions): Promise<void>
  status(): Promise<HealthReport>
  tabHealth(): Promise<HealthReport>
  closeTab(tabId: string): Promise<void>
  selectDirectory(): Promise<string | null>
  openExternal(url: string): Promise<boolean>
  openInTerminal(sessionId: string | null, projectPath?: string): Promise<boolean>
  attachFiles(): Promise<Attachment[] | null>
  takeScreenshot(): Promise<Attachment | null>
  pasteImage(dataUrl: string): Promise<Attachment | null>
  transcribeAudio(audioBase64: string): Promise<{ error: string | null; transcript: string | null }>
  getDiagnostics(): Promise<any>
  respondPermission(tabId: string, questionId: string, optionId: string): Promise<boolean>
  allowDeniedTools(tabId: string, toolNames: string[]): Promise<boolean>
  initSession(tabId: string): void
  resetTabSession(tabId: string): void
  listSessions(projectPath?: string): Promise<SessionMeta[]>
  loadSession(sessionId: string, projectPath?: string): Promise<SessionLoadMessage[]>
  exportTranscript(input: TranscriptInput): Promise<ExportTranscriptResult>
  fetchMarketplace(forceRefresh?: boolean): Promise<{ plugins: CatalogPlugin[]; error: string | null }>
  listInstalledPlugins(): Promise<string[]>
  installPlugin(repo: string, pluginName: string, marketplace: string, sourcePath?: string, isSkillMd?: boolean): Promise<{ ok: boolean; error?: string }>
  uninstallPlugin(pluginName: string): Promise<{ ok: boolean; error?: string }>
  setPermissionMode(mode: string): void
  getTheme(): Promise<{ isDark: boolean }>
  onThemeChange(callback: (isDark: boolean) => void): () => void

  // ─── Window management ───
  resizeHeight(height: number): void
  setWindowWidth(width: number): void
  animateHeight(from: number, to: number, durationMs: number): Promise<void>
  hideWindow(): void
  isVisible(): Promise<boolean>
  /** OS-level click-through for transparent window regions */
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void
  /** Manual window drag for frameless windows */
  startWindowDrag(deltaX: number, deltaY: number): void
  /** Reset overlay to its default bottom-center position */
  resetWindowPosition(): void

  // ─── Event listeners (main → renderer) ───
  onEvent(callback: (tabId: string, event: NormalizedEvent) => void): () => void
  onTabStatusChange(callback: (tabId: string, newStatus: string, oldStatus: string) => void): () => void
  onError(callback: (tabId: string, error: EnrichedError) => void): () => void
  onSkillStatus(callback: (status: { name: string; state: string; error?: string; reason?: string }) => void): () => void
  onWindowShown(callback: () => void): () => void

  // ─── Code Mode (live preview) ───
  startCodeMode(projectPath: string): Promise<{ ok: boolean; error?: string; state: CodeModeState }>
  stopCodeMode(): Promise<{ ok: boolean; state: CodeModeState }>
  getCodeModeStatus(): Promise<CodeModeState>
  reloadCodeMode(): Promise<boolean>
  toggleCodeModeInspect(): Promise<boolean>
  setCodeModeDevice(device: DeviceMode): Promise<CodeModeState>
  onCodeModeStatus(callback: (state: CodeModeState) => void): () => void

  // ─── Fullscreen window ───
  openFullscreen(): Promise<{ ok: boolean }>
  closeFullscreen(): Promise<{ ok: boolean }>
  toggleFullscreen(): Promise<{ ok: boolean }>
  isFullscreenOpen(): Promise<boolean>
  onFullscreenModeChanged(callback: (isOpen: boolean) => void): () => void
  onFullscreenNativeStateChanged(callback: (isNative: boolean) => void): () => void

  // ─── Cross-renderer state mirror ───
  publishMirror(action: MirrorAction): void
  onMirror(callback: (action: MirrorAction) => void): () => void
  pushSnapshot(snapshot: SessionSnapshot): void
  pullSnapshot(): Promise<SessionSnapshot | null>

  // ─── Voice orb broadcasts + controls ───
  /** Stream of orb session events forwarded to pill + fullscreen so the
   *  dedicated voice tab can render history. */
  onOrbEventBroadcast(callback: (event: { type: string; [k: string]: unknown }) => void): () => void
  /** Fired when the orb conversation is reset (Voice tab's "Reset history"
   *  button or Cmd+R on the orb). Renderers wipe the voice tab's messages. */
  onOrbResetBroadcast(callback: () => void): () => void
  /** Show / toggle / reset the orb window from the pill or fullscreen UI. */
  showOrb(): Promise<{ ok: boolean }>
  toggleOrb(): Promise<{ ok: boolean }>
  resetOrb(): Promise<{ ok: boolean }>
  /** Persist a Kokoro voice id and apply it to the live TTSManager. The
   *  renderer Settings dropdown is the only call site today. Returns
   *  `{ok:false}` if the id isn't in the catalog. */
  setOrbVoice(voiceId: string): Promise<{ ok: boolean; voice?: string; error?: string }>
  /** Returns the voice id the orb is currently configured to use —
   *  honouring env override > persisted file > default. Settings reads
   *  this on mount so its dropdown reflects the actual main-process
   *  truth rather than just localStorage. */
  getOrbVoice(): Promise<{ voice: string }>

  // ─── Claude instance (bundled vs system) ───
  getClaudeMode(): Promise<ClaudeMode>
  setClaudeMode(mode: ClaudeMode): Promise<ClaudeInstanceInfo>
  getClaudeInstanceInfo(): Promise<ClaudeInstanceInfo>
  onClaudeModeChanged(callback: (info: ClaudeInstanceInfo) => void): () => void
  startClaudeLogin(): Promise<{ ok: boolean; error?: string }>
  cancelClaudeLogin(): Promise<{ ok: boolean }>
  onClaudeLoginEvent(callback: (event: ClaudeLoginEvent) => void): () => void

  // ─── Rax cloud auth ───
  getRaxAuthStatus(): Promise<import('../shared/types').RaxAuthStatus>
  raxAuthSignIn(): Promise<{ ok: true } | { ok: false; reason: string }>
  raxAuthSignOut(): Promise<import('../shared/types').RaxAuthStatus>
  raxAuthSetEnabled(enabled: boolean): Promise<import('../shared/types').RaxAuthStatus>
  raxAuthFetchAccount(): Promise<import('../shared/types').RaxAccountInfo>
  onRaxAuthChanged(callback: (status: import('../shared/types').RaxAuthStatus) => void): () => void

  // ─── First-launch onboarding ───
  getOnboarding(): Promise<{ completed: boolean; completedAt: string | null; choice: 'rax' | 'own-claude' | 'skip' | null }>
  completeOnboarding(choice: 'rax' | 'own-claude' | 'skip'): Promise<{ completed: boolean; completedAt: string | null; choice: 'rax' | 'own-claude' | 'skip' | null }>
  openWelcome(): Promise<void>
  closeWelcome(): Promise<void>
  launchPill(): Promise<void>

  // ─── Auto-updater ───
  /** Force an update check now. `userInitiated:true` surfaces failures and
   *  "up to date" as native dialogs (Settings button behaviour); silent
   *  background checks should pass false. Resolves to the final snapshot. */
  checkForUpdates(opts?: { userInitiated?: boolean }): Promise<UpdaterStatus>
  /** Start downloading the currently-available update. No-op if `phase`
   *  isn't `available`. The renderer typically calls this only when the
   *  user has answered the in-app prompt. */
  downloadUpdate(): Promise<void>
  /** Restart and apply the downloaded update. The app will quit + relaunch. */
  installUpdate(): void
  /** Pull the cached UpdaterStatus without triggering a check. Used on
   *  Settings mount to render the right initial state. */
  getUpdaterStatus(): Promise<UpdaterStatus>
  /** Subscribe to push UpdaterStatus updates. Returns an unsubscribe fn. */
  onUpdaterStatus(callback: (status: UpdaterStatus) => void): () => void
}

const api: RaxAPI = {
  // ─── Request-response ───
  start: () => ipcRenderer.invoke(IPC.START),
  createTab: (opts?: { desiredId?: string }) => ipcRenderer.invoke(IPC.CREATE_TAB, opts),
  prompt: (tabId, requestId, options) => ipcRenderer.invoke(IPC.PROMPT, { tabId, requestId, options }),
  cancel: (requestId) => ipcRenderer.invoke(IPC.CANCEL, requestId),
  stopTab: (tabId) => ipcRenderer.invoke(IPC.STOP_TAB, tabId),
  retry: (tabId, requestId, options) => ipcRenderer.invoke(IPC.RETRY, { tabId, requestId, options }),
  status: () => ipcRenderer.invoke(IPC.STATUS),
  tabHealth: () => ipcRenderer.invoke(IPC.TAB_HEALTH),
  closeTab: (tabId) => ipcRenderer.invoke(IPC.CLOSE_TAB, tabId),
  selectDirectory: () => ipcRenderer.invoke(IPC.SELECT_DIRECTORY),
  openExternal: (url) => ipcRenderer.invoke(IPC.OPEN_EXTERNAL, url),
  openInTerminal: (sessionId, projectPath) => ipcRenderer.invoke(IPC.OPEN_IN_TERMINAL, { sessionId, projectPath }),
  attachFiles: () => ipcRenderer.invoke(IPC.ATTACH_FILES),
  takeScreenshot: () => ipcRenderer.invoke(IPC.TAKE_SCREENSHOT),
  pasteImage: (dataUrl) => ipcRenderer.invoke(IPC.PASTE_IMAGE, dataUrl),
  transcribeAudio: (audioBase64) => ipcRenderer.invoke(IPC.TRANSCRIBE_AUDIO, audioBase64),
  getDiagnostics: () => ipcRenderer.invoke(IPC.GET_DIAGNOSTICS),
  respondPermission: (tabId, questionId, optionId) =>
    ipcRenderer.invoke(IPC.RESPOND_PERMISSION, { tabId, questionId, optionId }),
  allowDeniedTools: (tabId, toolNames) =>
    ipcRenderer.invoke(IPC.ALLOW_DENIED_TOOLS, { tabId, toolNames }),
  initSession: (tabId) => ipcRenderer.send(IPC.INIT_SESSION, tabId),
  resetTabSession: (tabId) => ipcRenderer.send(IPC.RESET_TAB_SESSION, tabId),
  listSessions: (projectPath?: string) => ipcRenderer.invoke(IPC.LIST_SESSIONS, projectPath),
  loadSession: (sessionId: string, projectPath?: string) => ipcRenderer.invoke(IPC.LOAD_SESSION, { sessionId, projectPath }),
  exportTranscript: (input) => ipcRenderer.invoke(IPC.EXPORT_TRANSCRIPT, input),
  fetchMarketplace: (forceRefresh) => ipcRenderer.invoke(IPC.MARKETPLACE_FETCH, { forceRefresh }),
  listInstalledPlugins: () => ipcRenderer.invoke(IPC.MARKETPLACE_INSTALLED),
  installPlugin: (repo, pluginName, marketplace, sourcePath, isSkillMd) =>
    ipcRenderer.invoke(IPC.MARKETPLACE_INSTALL, { repo, pluginName, marketplace, sourcePath, isSkillMd }),
  uninstallPlugin: (pluginName) =>
    ipcRenderer.invoke(IPC.MARKETPLACE_UNINSTALL, { pluginName }),
  setPermissionMode: (mode) => ipcRenderer.send(IPC.SET_PERMISSION_MODE, mode),
  getTheme: () => ipcRenderer.invoke(IPC.GET_THEME),
  onThemeChange: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, isDark: boolean) => callback(isDark)
    ipcRenderer.on(IPC.THEME_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC.THEME_CHANGED, handler)
  },

  // ─── Window management ───
  resizeHeight: (height) => ipcRenderer.send(IPC.RESIZE_HEIGHT, height),
  animateHeight: (from, to, durationMs) =>
    ipcRenderer.invoke(IPC.ANIMATE_HEIGHT, { from, to, durationMs }),
  hideWindow: () => ipcRenderer.send(IPC.HIDE_WINDOW),
  isVisible: () => ipcRenderer.invoke(IPC.IS_VISIBLE),
  setIgnoreMouseEvents: (ignore, options) =>
    ipcRenderer.send(IPC.SET_IGNORE_MOUSE_EVENTS, ignore, options || {}),
  startWindowDrag: (deltaX, deltaY) =>
    ipcRenderer.send(IPC.START_WINDOW_DRAG, deltaX, deltaY),
  resetWindowPosition: () => ipcRenderer.send(IPC.RESET_WINDOW_POSITION),
  setWindowWidth: (width) => ipcRenderer.send(IPC.SET_WINDOW_WIDTH, width),

  // ─── Event listeners ───
  onEvent: (callback) => {
    const channels = [
      IPC.TEXT_CHUNK, IPC.TOOL_CALL, IPC.TOOL_CALL_UPDATE,
      IPC.TOOL_CALL_COMPLETE, IPC.TASK_UPDATE, IPC.TASK_COMPLETE,
      IPC.SESSION_DEAD, IPC.SESSION_INIT, IPC.ERROR, IPC.RATE_LIMIT,
    ]
    // Single unified handler — all normalized events come through one channel
    const handler = (_e: Electron.IpcRendererEvent, tabId: string, event: NormalizedEvent) => callback(tabId, event)
    ipcRenderer.on('rax:normalized-event', handler)
    return () => ipcRenderer.removeListener('rax:normalized-event', handler)
  },

  onTabStatusChange: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, tabId: string, newStatus: string, oldStatus: string) =>
      callback(tabId, newStatus, oldStatus)
    ipcRenderer.on('rax:tab-status-change', handler)
    return () => ipcRenderer.removeListener('rax:tab-status-change', handler)
  },

  onError: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, tabId: string, error: EnrichedError) =>
      callback(tabId, error)
    ipcRenderer.on('rax:enriched-error', handler)
    return () => ipcRenderer.removeListener('rax:enriched-error', handler)
  },

  onSkillStatus: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, status: any) => callback(status)
    ipcRenderer.on(IPC.SKILL_STATUS, handler)
    return () => ipcRenderer.removeListener(IPC.SKILL_STATUS, handler)
  },

  onWindowShown: (callback) => {
    const handler = () => callback()
    ipcRenderer.on(IPC.WINDOW_SHOWN, handler)
    return () => ipcRenderer.removeListener(IPC.WINDOW_SHOWN, handler)
  },

  // ─── Code Mode ───
  startCodeMode: (projectPath) => ipcRenderer.invoke(IPC.CODE_MODE_START, projectPath),
  stopCodeMode: () => ipcRenderer.invoke(IPC.CODE_MODE_STOP),
  getCodeModeStatus: () => ipcRenderer.invoke(IPC.CODE_MODE_STATUS),
  reloadCodeMode: () => ipcRenderer.invoke(IPC.CODE_MODE_RELOAD),
  toggleCodeModeInspect: () => ipcRenderer.invoke(IPC.CODE_MODE_TOGGLE_INSPECT),
  setCodeModeDevice: (device) => ipcRenderer.invoke(IPC.CODE_MODE_SET_DEVICE, device),
  onCodeModeStatus: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, state: CodeModeState) => callback(state)
    ipcRenderer.on(IPC.CODE_MODE_STATUS_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC.CODE_MODE_STATUS_CHANGED, handler)
  },

  // ─── Fullscreen window ───
  openFullscreen: () => ipcRenderer.invoke(IPC.FULLSCREEN_OPEN),
  closeFullscreen: () => ipcRenderer.invoke(IPC.FULLSCREEN_CLOSE),
  toggleFullscreen: () => ipcRenderer.invoke(IPC.FULLSCREEN_TOGGLE),
  isFullscreenOpen: () => ipcRenderer.invoke(IPC.FULLSCREEN_IS_OPEN),
  onFullscreenModeChanged: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, isOpen: boolean) => callback(isOpen)
    ipcRenderer.on(IPC.FULLSCREEN_MODE_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC.FULLSCREEN_MODE_CHANGED, handler)
  },
  onFullscreenNativeStateChanged: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, isNative: boolean) => callback(isNative)
    ipcRenderer.on(IPC.FULLSCREEN_NATIVE_STATE, handler)
    return () => ipcRenderer.removeListener(IPC.FULLSCREEN_NATIVE_STATE, handler)
  },

  // ─── State mirror ───
  publishMirror: (action) => ipcRenderer.send(IPC.STATE_MIRROR_PUBLISH, action),
  onMirror: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, action: MirrorAction) => callback(action)
    ipcRenderer.on(IPC.STATE_MIRROR_SUBSCRIBE, handler)
    return () => ipcRenderer.removeListener(IPC.STATE_MIRROR_SUBSCRIBE, handler)
  },
  pushSnapshot: (snapshot) => ipcRenderer.send(IPC.STATE_SNAPSHOT_PUSH, snapshot),
  pullSnapshot: () => ipcRenderer.invoke(IPC.STATE_SNAPSHOT_PULL),

  // ─── Voice orb broadcasts + controls ───
  onOrbEventBroadcast: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, event: { type: string; [k: string]: unknown }) =>
      callback(event)
    ipcRenderer.on(IPC.ORB_EVENT_BROADCAST, handler)
    return () => ipcRenderer.removeListener(IPC.ORB_EVENT_BROADCAST, handler)
  },
  onOrbResetBroadcast: (callback) => {
    const handler = () => callback()
    ipcRenderer.on(IPC.ORB_RESET_BROADCAST, handler)
    return () => ipcRenderer.removeListener(IPC.ORB_RESET_BROADCAST, handler)
  },
  showOrb: () => ipcRenderer.invoke(IPC.ORB_SHOW),
  toggleOrb: () => ipcRenderer.invoke(IPC.ORB_TOGGLE),
  resetOrb: () => ipcRenderer.invoke(IPC.ORB_RESET_SESSION),
  setOrbVoice: (voiceId) => ipcRenderer.invoke(IPC.ORB_TTS_SET_VOICE, voiceId),
  getOrbVoice: () => ipcRenderer.invoke(IPC.ORB_TTS_GET_VOICE),

  // ─── Claude instance ───
  getClaudeMode: () => ipcRenderer.invoke(IPC.CLAUDE_MODE_GET),
  setClaudeMode: (mode) => ipcRenderer.invoke(IPC.CLAUDE_MODE_SET, mode),
  getClaudeInstanceInfo: () => ipcRenderer.invoke(IPC.CLAUDE_MODE_INFO),
  onClaudeModeChanged: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, info: ClaudeInstanceInfo) => callback(info)
    ipcRenderer.on(IPC.CLAUDE_MODE_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC.CLAUDE_MODE_CHANGED, handler)
  },
  startClaudeLogin: () => ipcRenderer.invoke(IPC.CLAUDE_LOGIN_START),
  cancelClaudeLogin: () => ipcRenderer.invoke(IPC.CLAUDE_LOGIN_CANCEL),
  onClaudeLoginEvent: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, event: ClaudeLoginEvent) => callback(event)
    ipcRenderer.on(IPC.CLAUDE_LOGIN_EVENT, handler)
    return () => ipcRenderer.removeListener(IPC.CLAUDE_LOGIN_EVENT, handler)
  },

  // ─── Rax cloud auth ───
  getRaxAuthStatus: () => ipcRenderer.invoke(IPC.RAX_AUTH_STATUS),
  raxAuthSignIn: () => ipcRenderer.invoke(IPC.RAX_AUTH_SIGN_IN),
  raxAuthSignOut: () => ipcRenderer.invoke(IPC.RAX_AUTH_SIGN_OUT),
  raxAuthSetEnabled: (enabled: boolean) => ipcRenderer.invoke(IPC.RAX_AUTH_SET_ENABLED, enabled),
  raxAuthFetchAccount: () => ipcRenderer.invoke(IPC.RAX_AUTH_FETCH_ACCOUNT),
  onRaxAuthChanged: (callback: (s: import('../shared/types').RaxAuthStatus) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, status: import('../shared/types').RaxAuthStatus) => callback(status)
    ipcRenderer.on(IPC.RAX_AUTH_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC.RAX_AUTH_CHANGED, handler)
  },

  // ─── Onboarding ───
  getOnboarding: () => ipcRenderer.invoke(IPC.ONBOARDING_GET),
  completeOnboarding: (choice) => ipcRenderer.invoke(IPC.ONBOARDING_COMPLETE, choice),
  openWelcome: () => ipcRenderer.invoke(IPC.WELCOME_OPEN),
  closeWelcome: () => ipcRenderer.invoke(IPC.WELCOME_CLOSE),
  launchPill: () => ipcRenderer.invoke(IPC.LAUNCH_PILL),

  // ─── Auto-updater ───
  checkForUpdates: (opts) => ipcRenderer.invoke(IPC.UPDATER_CHECK, opts ?? {}),
  downloadUpdate: () => ipcRenderer.invoke(IPC.UPDATER_DOWNLOAD),
  installUpdate: () => ipcRenderer.send(IPC.UPDATER_INSTALL),
  getUpdaterStatus: () => ipcRenderer.invoke(IPC.UPDATER_GET_STATUS),
  onUpdaterStatus: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, status: UpdaterStatus) => callback(status)
    ipcRenderer.on(IPC.UPDATER_STATUS, handler)
    return () => ipcRenderer.removeListener(IPC.UPDATER_STATUS, handler)
  },
}

contextBridge.exposeInMainWorld('rax', api)
