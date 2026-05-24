import { app, BrowserWindow, ipcMain, dialog, screen, globalShortcut, Tray, Menu, nativeImage, nativeTheme, shell, systemPreferences, session } from 'electron'
import { join } from 'path'
import { existsSync, readdirSync, statSync, createReadStream } from 'fs'
import { createInterface } from 'readline'
import { homedir } from 'os'
import { ControlPlane } from './claude/control-plane'
import { tabToMarkdown, defaultExportFilename, type TranscriptInput } from '../shared/transcript'
import { ensureSkills, type SkillStatus } from './skills/installer'
import { fetchCatalog, listInstalled, installPlugin, uninstallPlugin } from './marketplace/catalog'
import { log as _log, LOG_FILE, flushLogs } from './logger'
import {
  buildClaudeEnv,
  buildClaudeSpawnInvocation,
  execClaudeSync,
  getActiveInstance,
  getMode as getClaudeMode,
  setMode as setClaudeMode,
  onModeChange as onClaudeModeChange,
  type ClaudeMode,
} from './claude/claude-instance'
import * as raxAuth from './auth/rax'
import * as onboarding from './auth/onboarding'
import { IPC } from '../shared/types'
import type { RunOptions, NormalizedEvent, EnrichedError, DeviceMode, MirrorAction, SessionSnapshot } from '../shared/types'
import { CodeModeController, type CodeModeBroadcast } from './code-mode'
import { OrbController } from './orb'
import { TTSManager } from './orb/tts'
import { savePersistedVoice } from './orb/local-tts'
import { isValidVoice } from '../shared/kokoro-voices'
import {
  ensureAccessibilityOnStartup,
  isAccessibilityGranted,
  recheckAccessibilityAndPrompt,
} from './permissions'
import { sweepStaleOrbTempFiles } from './orb/orb-session'
import { sweepStaleTabMcpFiles } from './claude/computer-use-mcp'
import { WhisperDaemon } from './orb/whisper-daemon'
import {
  prepareAutoCapture,
  type AutoScreenshotDeps,
  type AutoScreenshotMode,
} from './orb/auto-screenshot'
import { createHaikuVerifier } from './orb/haiku-verifier'
import { writeFileSync, readFileSync } from 'fs'
import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import {
  initUpdater,
  checkForUpdates as updaterCheck,
  downloadUpdate as updaterDownload,
  installUpdate as updaterInstall,
  getStatus as updaterGetStatus,
} from './updater'

const DEBUG_MODE = process.env.RAX_DEBUG === '1'
const SPACES_DEBUG = DEBUG_MODE || process.env.RAX_SPACES_DEBUG === '1'

function getContentSecurityPolicy(): string {
  const isDev = !!process.env.ELECTRON_RENDERER_URL
  const connectSrc = isDev
    ? "connect-src 'self' ws://localhost:* http://localhost:*;"
    : "connect-src 'self';"
  const scriptSrc = isDev
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval';"
    : "script-src 'self';"

  return [
    "default-src 'none'",
    scriptSrc,
    // Poppins is loaded from Google Fonts in fullscreen/code-mode/pill/caption-pill
    // entries. The CSS file comes from fonts.googleapis.com; the actual woff2 files
    // come from fonts.gstatic.com. Both must be whitelisted or the stylesheet load
    // fails silently and the UI falls back to system fonts.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' https://fonts.gstatic.com",
    connectSrc,
    "object-src 'none'",
    "base-uri 'none'",
    // Allow <webview> to load any localhost dev server — webview content runs in
    // its own renderer process, so this only governs what the *shell* may embed.
    "frame-src 'self' http://localhost:* http://127.0.0.1:* http://0.0.0.0:*",
  ].join('; ')
}

function installContentSecurityPolicy(): void {
  const csp = getContentSecurityPolicy()
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    })
  })
}

function log(msg: string): void {
  _log('main', msg)
}

function downloadWhisperModel(destPath: string, url: string): Promise<void> {
  const { createWriteStream, mkdirSync, renameSync, unlinkSync } = require('fs')
  const { dirname } = require('path')
  const https = require('https')
  mkdirSync(dirname(destPath), { recursive: true })
  const tmpPath = destPath + '.downloading'
  const fetchUrl = (current: string, redirects: number): Promise<void> =>
    new Promise((resolve, reject) => {
      if (redirects > 5) { reject(new Error('Too many redirects')); return }
      https.get(current, (res: any) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          fetchUrl(res.headers.location, redirects + 1).then(resolve, reject)
          return
        }
        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`HTTP ${res.statusCode}`))
          return
        }
        const out = createWriteStream(tmpPath)
        res.pipe(out)
        out.on('finish', () => out.close(() => {
          try { renameSync(tmpPath, destPath); resolve() } catch (e) { reject(e) }
        }))
        out.on('error', (err: Error) => {
          try { unlinkSync(tmpPath) } catch {}
          reject(err)
        })
      }).on('error', reject)
    })
  return fetchUrl(url, 0)
}

let mainWindow: BrowserWindow | null = null
let fullscreenWindow: BrowserWindow | null = null
let orbWindow: BrowserWindow | null = null
let welcomeWindow: BrowserWindow | null = null
// Vertical agent dock — always-on-top floating window on the left edge of the
// user's primary display. Shows the five-agent roster (Max/Alex/Luna/Nova/Zara)
// + status indicators + completion toasts. Independent lifecycle from
// pill / fullscreen / orb; toggled via Cmd+Shift+D or the tray.
let dockWindow: BrowserWindow | null = null
// Bottom-of-screen "caption pill" subtitle window. Lifecycle is tied to the
// orb window: created right after the orb on summon, destroyed when the orb
// is destroyed. Always-on-screen at OS level once created; the pill content
// itself is only visible while an orb turn is active (CSS-driven fade) and
// only when the `voiceCaptionsEnabled` user setting is on.
let captionPillWindow: BrowserWindow | null = null
// Renderer-reported flag — true whenever the orb is recording / thinking /
// talking. We use it to suppress auto-hide-on-blur so a tool the orb itself
// triggered (which steals focus to the pill) doesn't kill the in-flight turn.
let orbRendererBusy = false
// Push-to-talk hot key may fire before the renderer has wired up its IPC
// listener (cold start / dev hot-reload / post-crash respawn). Buffer the
// intent here and flush when the renderer signals ready.
let pendingForceListen = false
// Hold-to-speak (Option+R) — globalShortcut on macOS fires only on the
// initial keydown (no auto-repeat callbacks). To detect the eventual key
// release we use three layers, ordered by reliability:
//   1. JXA poller (`startHoldKeyPoller`) — focus-independent global key
//      state via CoreGraphics. Required because the orb is a non-activating
//      NSPanel: `focus()` doesn't reliably make it the macOS key window, so
//      keyup events get routed to whatever app the user was in (browser,
//      IDE), not the orb's webContents. Authoritative.
//   2. `before-input-event` on orb webContents — works when the orb did
//      become key (e.g. user clicked the orb between presses). Fast path.
//   3. DOM `keyup` in renderer — backup for the same case as #2.
// Backup watchdog is a final safety net for the case where even the poller
// dies (osascript crash, CoreGraphics unavailable). Short (30s) so a
// missed-release stall recovers fast.
const HOLD_BACKUP_WATCHDOG_MS = 30 * 1000
let holdActive = false
let holdWatchdog: NodeJS.Timeout | null = null
let holdKeyupHandler: ((event: Electron.Event, input: Electron.Input) => void) | null = null
let holdKeyPoller: ChildProcess | null = null
let pendingHoldStart = false
let tray: Tray | null = null
let trayContextMenuFactory: (() => Menu) | null = null
let screenshotCounter = 0
let toggleSequence = 0
let lastWindowBounds: Electron.Rectangle | null = null
/** Last in-flight session snapshot, used to seed a freshly-opened renderer
 *  with the other renderer's state so pill ↔ fullscreen feel continuous. */
let lastSessionSnapshot: SessionSnapshot | null = null

// Feature flag: enable PTY interactive permissions transport
const INTERACTIVE_PTY = process.env.RAX_INTERACTIVE_PERMISSIONS_PTY === '1'

const controlPlane = new ControlPlane(INTERACTIVE_PTY)

// Keep native width fixed to avoid renderer animation vs setBounds race.
// The UI itself still launches in compact mode; extra width is transparent/click-through.
const BAR_WIDTH = 1040
const PILL_HEIGHT = 720  // Fixed native window height — extra room for expanded UI + shadow buffers
const PILL_BOTTOM_MARGIN = 24

// ─── Broadcast to renderer ───

function broadcast(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
  if (fullscreenWindow && !fullscreenWindow.isDestroyed()) {
    fullscreenWindow.webContents.send(channel, ...args)
  }
  // The dock subscribes to the same status-change / task-complete stream so
  // it can mirror agent status (dot color, pulse) and surface its own toasts.
  if (dockWindow && !dockWindow.isDestroyed()) {
    dockWindow.webContents.send(channel, ...args)
  }
}

function snapshotWindowState(reason: string): void {
  if (!SPACES_DEBUG) return
  if (!mainWindow || mainWindow.isDestroyed()) {
    log(`[spaces] ${reason} window=none`)
    return
  }

  const b = mainWindow.getBounds()
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const visibleOnAll = mainWindow.isVisibleOnAllWorkspaces()
  const wcFocused = mainWindow.webContents.isFocused()

  log(
    `[spaces] ${reason} ` +
    `vis=${mainWindow.isVisible()} focused=${mainWindow.isFocused()} wcFocused=${wcFocused} ` +
    `alwaysOnTop=${mainWindow.isAlwaysOnTop()} allWs=${visibleOnAll} ` +
    `bounds=(${b.x},${b.y},${b.width}x${b.height}) ` +
    `cursor=(${cursor.x},${cursor.y}) display=${display.id} ` +
    `workArea=(${display.workArea.x},${display.workArea.y},${display.workArea.width}x${display.workArea.height})`
  )
}

function scheduleToggleSnapshots(toggleId: number, phase: 'show' | 'hide'): void {
  if (!SPACES_DEBUG) return
  const probes = [0, 100, 400, 1200]
  for (const delay of probes) {
    setTimeout(() => {
      snapshotWindowState(`toggle#${toggleId} ${phase} +${delay}ms`)
    }, delay)
  }
}


// ─── Voice Orb controller ───
// Owned by main; lives across the whole app session. Its claude subprocess is
// spawned lazily on first turn. The orb window subscribes to ORB_EVENT.

/**
 * Resolve once a tab's run finishes (status leaves `running`/`connecting`).
 * Streams its assistant text along the way so we can return what it actually
 * said. Used by the orb's `rax_send_to_tab_and_wait` MCP tool.
 *
 * Honours both a hard timeout (default 10 min — `_send_to_tab_and_wait`
 * passes 0 to use this default) and an external AbortSignal so a cancelled
 * orb turn cleans up the listeners instead of leaking them across long-lived
 * cancelled tool calls.
 */
const DEFAULT_AWAIT_TAB_IDLE_MS = 10 * 60 * 1000
function awaitTabIdle(
  tabId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ text: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let buffered = ''
    let resolved = false
    const effectiveTimeout = timeoutMs && timeoutMs > 0 ? timeoutMs : DEFAULT_AWAIT_TAB_IDLE_MS
    const cleanup = () => {
      controlPlane.removeListener('event', onEvent)
      controlPlane.removeListener('tab-status-change', onStatus)
      clearTimeout(timer)
      if (signal && onAbort) signal.removeEventListener('abort', onAbort)
    }
    const finish = (text: string, timedOut = false) => {
      if (resolved) return
      resolved = true
      cleanup()
      resolve({ text: text.trim(), timedOut })
    }
    const onEvent = (id: string, event: NormalizedEvent) => {
      if (id !== tabId) return
      if (event.type === 'text_chunk') buffered += event.text
      if (event.type === 'task_complete') finish(buffered || event.result)
      if (event.type === 'error') finish(event.message || buffered)
      if (event.type === 'session_dead') finish(buffered || '(session ended)')
    }
    const onStatus = (id: string, newStatus: string) => {
      if (id !== tabId) return
      if (newStatus === 'failed' || newStatus === 'dead' || newStatus === 'completed') {
        // Give 250ms for any trailing text_chunk to land before resolving.
        setTimeout(() => finish(buffered), 250).unref?.()
      }
    }
    const timer = setTimeout(() => finish(buffered, true), effectiveTimeout)
    timer.unref?.()
    let onAbort: (() => void) | null = null
    if (signal) {
      if (signal.aborted) {
        // Already cancelled before we even subscribed — don't attach.
        resolved = true
        clearTimeout(timer)
        resolve({ text: buffered.trim(), timedOut: false })
        return
      }
      onAbort = () => finish(buffered)
      signal.addEventListener('abort', onAbort, { once: true })
    }
    controlPlane.on('event', onEvent)
    controlPlane.on('tab-status-change', onStatus)
  })
}

// Mirror actions are about pill ↔ fullscreen tab/session coherence. The orb
// and the caption-pill have their own session state and ignore these — so
// sending to every window wastes a synchronous IPC send per mirror. Restrict
// to mainWindow + fullscreenWindow, and guard each .send() so a window being
// destroyed mid-broadcast (e.g. user just closed fullscreen) can't throw.
function sendMirrorTo(action: MirrorAction, excludeSenderId?: number): void {
  const targets = [mainWindow, fullscreenWindow]
  for (const win of targets) {
    if (!win || win.isDestroyed()) continue
    if (excludeSenderId !== undefined && win.webContents.id === excludeSenderId) continue
    try {
      win.webContents.send(IPC.STATE_MIRROR_SUBSCRIBE, action)
    } catch {
      // window closed between isDestroyed() check and send()
    }
  }
}

const orb = new OrbController({
  controlPlane,
  broadcastMirror: (action: MirrorAction) => {
    sendMirrorTo(action)
  },
  showPillWindow: () => showWindow('orb tool'),
  getProjectPath: () => process.cwd(),
  awaitTabIdle,
})

// Wire computer-use MCP into chat-tab spawns. The provider returns null until
// the orb's RPC server has started; once started, every new tab spawn will
// load the MCP shim. Kicked off eagerly below so the very first chat turn
// already has screenshot + screen-control available.
controlPlane.setComputerUseRpc(() => orb.getRpcInfoSync())
orb.ensureRpc()
  .then((info) => log(`Orb RPC ready for computer-use tools: ${info.url}`))
  .catch((err: Error) => log(`Orb RPC failed to start — chat tabs will run without computer-use: ${err.message}`))

// ─── Auto-screenshot pipeline (built once at startup) ───
//
// When a voice turn's transcript hints at a screen reference ("look at this",
// "what does that say", "is it loading"), we pre-capture a screenshot of the
// cursor display and attach it as an image content block in the same
// stream-json user message. Saves a tool round-trip and lets the orb answer
// from pixel-zero. Modes:
//   - 'enabled'    — hybrid: regex + Haiku 4.5 ambiguity verifier.
//   - 'regex-only' — high-confidence regex hits only; ambiguous tier no-ops.
//                    Also the auto-fallback when ANTHROPIC_API_KEY is absent.
//   - 'disabled'   — bypass entirely.
const autoScreenshotMode: AutoScreenshotMode = (() => {
  const raw = (process.env.RAX_ORB_AUTO_SCREENSHOT || 'enabled').toLowerCase().trim()
  if (raw === 'disabled' || raw === 'off' || raw === '0') return 'disabled'
  if (raw === 'regex-only' || raw === 'regex') return 'regex-only'
  return 'enabled'
})()
const anthropicApiKey = (process.env.ANTHROPIC_API_KEY || '').trim()
// When Rax cloud mode is active, route every Anthropic SDK call through
// the Rax proxy (rax-ai.com / localhost:3001 in dev) using the per-device
// rax_sk_… key — exactly like the spawned `claude` CLI does. When Rax
// mode is off, fall back to the user's own ANTHROPIC_API_KEY from env.
// The supplier is consulted on every verify() so toggling Rax mode in
// Settings takes effect without restarting the main process.
const haikuVerifier = createHaikuVerifier(
  autoScreenshotMode === 'enabled'
    ? () => {
        if (raxAuth.isActive()) {
          const key = raxAuth.getActiveKey()
          if (key) return { apiKey: key, baseURL: raxAuth.baseUrl() }
        }
        return anthropicApiKey ? { apiKey: anthropicApiKey } : null
      }
    : null,
)
const effectiveAutoScreenshotMode: AutoScreenshotMode =
  autoScreenshotMode === 'enabled' && !haikuVerifier.enabled ? 'regex-only' : autoScreenshotMode
const autoScreenshotDeps: AutoScreenshotDeps = {
  mode: effectiveAutoScreenshotMode,
  haiku: haikuVerifier,
}
log(
  `[OrbAutoSS] mode=${effectiveAutoScreenshotMode} haiku=${haikuVerifier.enabled ? 'enabled' : 'disabled'}` +
    (autoScreenshotMode === 'enabled' && !haikuVerifier.enabled
      ? ' (no ANTHROPIC_API_KEY — degraded to regex-only)'
      : autoScreenshotMode === 'disabled'
      ? ' (RAX_ORB_AUTO_SCREENSHOT=disabled)'
      : ''),
)

// Fire-and-forget IPC to the standalone caption-pill window. No-ops if the
// pill isn't alive — the pill is only created alongside the orb, so during
// app warmup and after the orb is dismissed this is the expected state.
function sendToCaptionPill(payload: unknown): void {
  if (!captionPillWindow || captionPillWindow.isDestroyed()) return
  captionPillWindow.webContents.send(IPC.CAPTION_PILL_EVENT, payload)
}

// Subset of orb-event types the caption pill actually consumes. Other types
// (text_chunk fires per token, task_complete, tool_use, etc.) would cross the
// IPC boundary just to hit a switch default — wasteful during long responses.
const CAPTION_PILL_ORB_EVENT_TYPES = new Set<string>([
  'orb_user_turn',
  'error',
  'orb_session_dead',
])

orb.on('orb-event', (event: unknown) => {
  if (orbWindow && !orbWindow.isDestroyed()) {
    orbWindow.webContents.send(IPC.ORB_EVENT, event)
  }
  // Also surface to pill + fullscreen so they render the pinned voice tab.
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    if (orbWindow && win.webContents.id === orbWindow.webContents.id) continue
    win.webContents.send(IPC.ORB_EVENT_BROADCAST, event)
  }
  // Forward only the types the caption pill consumes. TTS lifecycle is sent
  // separately (segment/alignment/cancelled) below, and voice state arrives
  // via the ORB_VOICE_STATE renderer→main IPC.
  const t = (event as { type?: string } | null | undefined)?.type
  if (t && CAPTION_PILL_ORB_EVENT_TYPES.has(t)) {
    sendToCaptionPill(event)
  }
})

const tts = new TTSManager()
tts.on('done', (id: string) => {
  if (orbWindow && !orbWindow.isDestroyed()) {
    orbWindow.webContents.send(IPC.ORB_TTS_DONE, id)
  }
})

// Forward TTS segment lifecycle to the caption-pill window so it can do
// karaoke-style per-word highlighting. The pill anchors its rAF timer to
// `startedAtMs` and uses the per-character `alignment` (from ElevenLabs'
// with-timestamps endpoint) to find the active word at the current elapsed
// time. Alignment events arrive as the NDJSON body streams in — usually most
// of the alignment is known by the time playback begins, the rest fills in
// during the first ~200ms.
tts.on('segment', (segment: { id: string; text: string; alignment: { chars: string[]; starts: number[]; ends: number[] }; startedAtMs: number }) => {
  sendToCaptionPill({ type: 'tts_segment', ...segment })
})
tts.on('alignment', (payload: { id: string; alignment: { chars: string[]; starts: number[]; ends: number[] } }) => {
  sendToCaptionPill({ type: 'tts_alignment', ...payload })
})
tts.on('cancelled', (id: string) => {
  sendToCaptionPill({ type: 'tts_cancelled', id })
})

// Persistent whisper daemon — kept warm across the app lifetime so each
// voice turn skips the per-spawn model-load cost. Eagerly started when the
// orb window opens; the TRANSCRIBE_AUDIO IPC handler tries it first and
// falls through to the legacy per-spawn path if the daemon isn't ready.
const whisperDaemon = new WhisperDaemon()

// ─── Wire ControlPlane events → renderer ───

controlPlane.on('event', (tabId: string, event: NormalizedEvent) => {
  broadcast('rax:normalized-event', tabId, event)
  orb.applyControlPlaneEvent(tabId, event)
})

controlPlane.on('tab-status-change', (tabId: string, newStatus: string, oldStatus: string) => {
  broadcast('rax:tab-status-change', tabId, newStatus, oldStatus)
  orb.applyTabStatusChange(tabId, newStatus)
})

controlPlane.on('error', (tabId: string, error: EnrichedError) => {
  broadcast('rax:enriched-error', tabId, error)
})

// ─── Code Mode (live preview of project working directory) ───

const codeMode = new CodeModeController()

function broadcastToAll(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }
}

codeMode.on('broadcast', (msg: CodeModeBroadcast) => {
  if (msg.type === 'state') {
    broadcastToAll(IPC.CODE_MODE_STATUS_CHANGED, msg.state)
  } else if (msg.type === 'log') {
    broadcastToAll(IPC.CODE_MODE_LOG, msg)
  }
})

ipcMain.handle(IPC.CODE_MODE_START, async (_event, projectPath: string) => {
  if (!projectPath || typeof projectPath !== 'string') {
    return { ok: false, error: 'Missing project path' }
  }
  try {
    const state = await codeMode.start(projectPath)
    return { ok: state.status === 'ready', state }
  } catch (err) {
    return { ok: false, error: (err as Error).message, state: codeMode.getState() }
  }
})

ipcMain.handle(IPC.CODE_MODE_STOP, async () => {
  await codeMode.stop()
  return { ok: true, state: codeMode.getState() }
})

ipcMain.handle(IPC.CODE_MODE_STATUS, () => {
  return codeMode.getState()
})

ipcMain.handle(IPC.CODE_MODE_RELOAD, () => {
  return codeMode.reload()
})

ipcMain.handle(IPC.CODE_MODE_TOGGLE_INSPECT, () => {
  return codeMode.toggleInspect()
})

ipcMain.handle(IPC.CODE_MODE_SET_DEVICE, (_event, device: DeviceMode) => {
  codeMode.setDevice(device)
  return codeMode.getState()
})

ipcMain.handle(IPC.CODE_MODE_GET_INITIAL, () => {
  return codeMode.getState()
})

ipcMain.on(IPC.CODE_MODE_WEBVIEW_REGISTER, (_event, webContentsId: number) => {
  codeMode.registerWebview(webContentsId)
})

// ─── Window Creation ───

function createWindow(): void {
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const { width: screenWidth, height: screenHeight } = display.workAreaSize
  const { x: dx, y: dy } = display.workArea

  const x = dx + Math.round((screenWidth - BAR_WIDTH) / 2)
  const y = dy + screenHeight - PILL_HEIGHT - PILL_BOTTOM_MARGIN

  mainWindow = new BrowserWindow({
    width: BAR_WIDTH,
    height: PILL_HEIGHT,
    x,
    y,
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),  // NSPanel — non-activating, joins all spaces
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: true,
    backgroundColor: '#00000000',
    show: false,
    icon: join(__dirname, '../../resources/icon.icns'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })
  lastWindowBounds = mainWindow.getBounds()

  // Belt-and-suspenders: panel already joins all spaces and floats,
  // but explicit flags ensure correct behavior on older Electron builds.
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  mainWindow.setAlwaysOnTop(true, 'screen-saver')
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    // Enable OS-level click-through for transparent regions.
    // { forward: true } ensures mousemove events still reach the renderer
    // so it can toggle click-through off when cursor enters interactive UI.
    mainWindow?.setIgnoreMouseEvents(true, { forward: true })
    if (process.env.ELECTRON_RENDERER_URL) {
      mainWindow?.webContents.openDevTools({ mode: 'detach' })
    }
  })

  let forceQuit = false
  app.on('before-quit', () => { forceQuit = true })
  mainWindow.on('close', (e) => {
    if (!forceQuit) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ─── Fullscreen Window ───
// A standard resizable Mac window with traffic lights + sidebar layout.
// Mutually exclusive with the pill: opening fullscreen hides the pill,
// closing fullscreen brings the pill back. While the fullscreen window is
// open we also show the dock icon (the app behaves like a normal Mac app).

function broadcastFullscreenMode(isOpen: boolean): void {
  // Only pill and fullscreen care about this — orb/caption ignore it.
  const targets = [mainWindow, fullscreenWindow]
  for (const win of targets) {
    if (!win || win.isDestroyed()) continue
    try {
      win.webContents.send(IPC.FULLSCREEN_MODE_CHANGED, isOpen)
    } catch {
      // window closed between isDestroyed() check and send()
    }
  }
}

/**
 * First-launch welcome window. Normal Mac chrome (traffic lights),
 * centered, fixed size. Opened from app.whenReady() when
 * onboarding.completed === false. Closes itself when the user picks a
 * path via WELCOME_CLOSE.
 */
function createWelcomeWindow(): void {
  if (welcomeWindow && !welcomeWindow.isDestroyed()) {
    welcomeWindow.show()
    welcomeWindow.focus()
    return
  }

  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const { width: sw, height: sh } = display.workAreaSize
  const { x: dx, y: dy } = display.workArea

  const w = 720
  const h = 540
  const x = dx + Math.round((sw - w) / 2)
  const y = dy + Math.round((sh - h) / 2)

  welcomeWindow = new BrowserWindow({
    width: w,
    height: h,
    x,
    y,
    minWidth: 560,
    minHeight: 440,
    title: 'Welcome to Rax',
    show: false,
    paintWhenInitiallyHidden: false,
    frame: process.platform !== 'darwin',
    transparent: false,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#0c0c0e',
    icon: join(__dirname, '../../resources/icon.icns'),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 14, y: 14 } : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/welcome.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })

  welcomeWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  welcomeWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log(`[welcome] did-fail-load code=${code} desc=${desc} url=${url}`)
  })
  welcomeWindow.webContents.on('render-process-gone', (_e, details) => {
    log(`[welcome] render-process-gone reason=${details.reason}`)
  })
  welcomeWindow.webContents.on('did-finish-load', () => {
    log(`[welcome] did-finish-load`)
  })

  const url = process.env.ELECTRON_RENDERER_URL
    ? `${process.env.ELECTRON_RENDERER_URL}/welcome.html`
    : null
  log(`[welcome] loading: ${url ?? '(file)'}`)
  if (url) {
    welcomeWindow.loadURL(url)
  } else {
    welcomeWindow.loadFile(join(__dirname, '../renderer/welcome.html'))
  }

  const showAndPromote = (origin: string) => {
    if (!welcomeWindow || welcomeWindow.isDestroyed()) return
    log(`[welcome] show + promote (from ${origin})`)
    // The pill is at screen-saver level and would cover us; sit above
    // it for the duration of the welcome flow.
    welcomeWindow.setAlwaysOnTop(true, 'screen-saver')
    // Make the window appear on whichever Space the user is on, since
    // the app is in macOS accessory mode (dock hidden) and Electron
    // would otherwise stick it to its launch Space.
    welcomeWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    // Hide the pill so the user sees one clean surface during onboarding.
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
      mainWindow.hide()
    }
    // macOS: temporarily restore the Dock icon so the welcome is a
    // proper app window the user can Cmd-Tab to. We re-hide on close.
    if (process.platform === 'darwin' && app.dock) {
      app.dock.show().catch(() => {})
    }
    welcomeWindow.show()
    welcomeWindow.moveTop()
    welcomeWindow.focus()
    if (process.platform === 'darwin') app.focus({ steal: true })
    // Drop the always-on-top a tick later so the user can still alt-tab.
    setTimeout(() => {
      if (welcomeWindow && !welcomeWindow.isDestroyed()) {
        welcomeWindow.setAlwaysOnTop(false)
        welcomeWindow.setVisibleOnAllWorkspaces(false)
      }
    }, 1500)
  }

  // Belt-and-braces fallback: paintWhenInitiallyHidden=false plus an
  // accessory-mode app can delay ready-to-show. Show after did-finish-load
  // OR a fixed 1.5s timer — whichever fires first.
  welcomeWindow.webContents.once('did-finish-load', () => showAndPromote('did-finish-load'))
  welcomeWindow.once('ready-to-show', () => {
    if (welcomeWindow?.isVisible()) return
    showAndPromote('ready-to-show')
  })
  setTimeout(() => {
    if (welcomeWindow && !welcomeWindow.isDestroyed() && !welcomeWindow.isVisible()) {
      showAndPromote('1.5s-fallback')
    }
  }, 1500)

  welcomeWindow.on('closed', () => {
    welcomeWindow = null
    // Restore accessory mode so the dock icon goes away again.
    if (process.platform === 'darwin' && app.dock) {
      app.dock.hide()
    }
  })
}

ipcMain.handle(IPC.WELCOME_OPEN, () => createWelcomeWindow())
ipcMain.handle(IPC.WELCOME_CLOSE, () => {
  if (welcomeWindow && !welcomeWindow.isDestroyed()) welcomeWindow.close()
})

/**
 * Finish onboarding: create the pill (deferred at boot) and show it,
 * then close the welcome window. Wired to the "Launch Rax" button on
 * the welcome's success screen.
 */
ipcMain.handle(IPC.LAUNCH_PILL, async () => {
  log('[launch-pill] invoked')
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    snapshotWindowState('after deferred createWindow')
  }
  // First-time users go straight from the welcome window to the pill — the
  // agent dock follows the pill so a new user lands on the multi-agent UI
  // they were just sold in onboarding rather than discovering it on next
  // launch.
  if (!dockWindow || dockWindow.isDestroyed()) {
    createDockWindow()
  }
  // Wait one tick for ready-to-show to land if this is the first create.
  await new Promise((r) => setTimeout(r, 50))
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.focus()
  }
  if (welcomeWindow && !welcomeWindow.isDestroyed()) {
    welcomeWindow.close()
  }
})

function createFullscreenWindow(): void {
  if (fullscreenWindow && !fullscreenWindow.isDestroyed()) {
    // Already exists — just refocus it and ensure pill stays hidden + mode
    // broadcast stays accurate. Pill hide is idempotent (no-op if already
    // hidden) so it's safe to call unconditionally.
    fullscreenWindow.show()
    fullscreenWindow.focus()
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
      mainWindow.hide()
    }
    broadcastFullscreenMode(true)
    return
  }

  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const { width: sw, height: sh } = display.workAreaSize
  const { x: dx, y: dy } = display.workArea

  const initialWidth = Math.min(1280, sw - 40)
  const initialHeight = Math.min(840, sh - 40)
  const x = dx + Math.round((sw - initialWidth) / 2)
  const y = dy + Math.round((sh - initialHeight) / 2)

  fullscreenWindow = new BrowserWindow({
    width: initialWidth,
    height: initialHeight,
    x,
    y,
    minWidth: 820,
    minHeight: 540,
    title: 'Rax',
    show: false,
    // paintWhenInitiallyHidden=false avoids burning paint cycles between
    // BrowserWindow construction and the first ready-to-show callback —
    // we only call .show() once layout is done anyway.
    paintWhenInitiallyHidden: false,
    frame: process.platform !== 'darwin',
    transparent: false,
    resizable: true,
    movable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: true,
    backgroundColor: '#0c0c0e',
    icon: join(__dirname, '../../resources/icon.icns'),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 14, y: 16 } : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/fullscreen.js'),
      // sandbox=false enables the <webview> tag for the embedded code-mode
      // preview pane. contextIsolation stays on for security.
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // Throttle JS timers/RAF when the window is hidden behind another app
      // or minimized. Default in Electron is `true` but be explicit — the
      // fullscreen window can host an embedded <webview> with a dev server,
      // so keeping it cooperative when in the background is important.
      backgroundThrottling: true,
      // v8 code-cache for faster cold-start on subsequent opens (renderer JS
      // has been parsed at least once already after the first open).
      v8CacheOptions: 'code',
    },
  })

  fullscreenWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  fullscreenWindow.webContents.on('will-navigate', (event, navUrl) => {
    const allowed =
      navUrl.includes('fullscreen.html') ||
      (process.env.ELECTRON_RENDERER_URL && navUrl.startsWith(process.env.ELECTRON_RENDERER_URL))
    if (!allowed) event.preventDefault()
  })

  fullscreenWindow.webContents.on('did-attach-webview', (_event, contents) => {
    // External link behavior inside the embedded preview — open in default browser.
    contents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http://') || url.startsWith('https://')) {
        shell.openExternal(url).catch(() => {})
      }
      return { action: 'deny' }
    })
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    fullscreenWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/fullscreen.html`)
  } else {
    fullscreenWindow.loadFile(join(__dirname, '../renderer/fullscreen.html'))
  }

  const sendNativeFullscreen = (isNative: boolean) => {
    if (fullscreenWindow && !fullscreenWindow.isDestroyed()) {
      fullscreenWindow.webContents.send(IPC.FULLSCREEN_NATIVE_STATE, isNative)
    }
  }
  const onEnterFullscreen = () => sendNativeFullscreen(true)
  const onLeaveFullscreen = () => sendNativeFullscreen(false)
  fullscreenWindow.on('enter-full-screen', onEnterFullscreen)
  fullscreenWindow.on('leave-full-screen', onLeaveFullscreen)

  fullscreenWindow.once('ready-to-show', () => {
    if (!fullscreenWindow || fullscreenWindow.isDestroyed()) return
    fullscreenWindow.show()
    fullscreenWindow.focus()
    // Atomic handoff: only hide the pill after the fullscreen window is on
    // screen, so there's no black-screen gap where neither surface is visible.
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
      mainWindow.hide()
    }
    // Likewise, broadcast the mode change once the window is actually visible
    // so renderers don't react to a state that's not yet on screen.
    broadcastFullscreenMode(true)
    if (process.env.ELECTRON_RENDERER_URL) {
      fullscreenWindow.webContents.openDevTools({ mode: 'detach' })
    }
    // Send initial native-fullscreen state in case the window restored into it.
    fullscreenWindow.webContents.send(
      IPC.FULLSCREEN_NATIVE_STATE,
      !!fullscreenWindow.isFullScreen(),
    )
  })

  fullscreenWindow.on('closed', () => {
    // Detach our explicit listeners so a future window can register a fresh
    // pair without doubling up (Electron does drop them on destroy, but we
    // also keep refs around so closures can't fire on a destroyed window).
    try {
      fullscreenWindow?.removeListener('enter-full-screen', onEnterFullscreen)
      fullscreenWindow?.removeListener('leave-full-screen', onLeaveFullscreen)
    } catch {}
    fullscreenWindow = null
    // Switch code mode back to standalone-window mode — if a dev server is
    // still running, it'll pop a fresh preview window automatically.
    codeMode.setEmbedded(false)
    broadcastFullscreenMode(false)

    if (process.platform === 'darwin' && app.dock) {
      app.dock.hide()
    }
    rebuildTrayMenu()

    // Always bring the pill back. The previous `!isVisible()` guard could lie
    // after an unclean exit (renderer crash, force-quit child) — leaving the
    // user with no UI at all. showWindow() is idempotent for an already-visible
    // pill, so this is safe.
    if (mainWindow && !mainWindow.isDestroyed()) {
      showWindow('fullscreen-close')
    }
  })

  // Code mode embedded — fullscreen window will host the <webview> preview.
  codeMode.setEmbedded(true)

  if (process.platform === 'darwin' && app.dock) {
    app.dock.show().catch(() => {})
  }

  rebuildTrayMenu()
}

function closeFullscreenWindow(): void {
  if (fullscreenWindow && !fullscreenWindow.isDestroyed()) {
    fullscreenWindow.close()
  }
}

function toggleFullscreenWindow(): void {
  if (fullscreenWindow && !fullscreenWindow.isDestroyed()) {
    closeFullscreenWindow()
  } else {
    createFullscreenWindow()
  }
}

// ─── Voice Orb Window ───
// Floating, transparent, frameless panel sized like a Siri orb. Summoned by
// global shortcut or tray; click-outside / Esc dismisses. Reuses the existing
// VoiceOrb canvas inside src/renderer/orb/.

// Tight footprint — the window is just barely larger than the visible orb so
// the user can park it anywhere on screen, including hard against the top
// edge or over the menu bar. With size=100 in App.tsx the canvas is 200×200;
// we keep ~10px margin for the rim glow shadow.
const ORB_WINDOW_WIDTH = 220
const ORB_WINDOW_HEIGHT = 220

// Caption-pill window sits at the bottom-center of the display containing
// the orb. Sized to comfortably fit the glass pill (max-width: 540px text +
// chip + paddings) with enough margin around it for the drop shadow and the
// 8px fade-in slide animation. The pill itself is centered inside the
// window via flex layout, so the *window* doesn't need a tight fit.
const CAPTION_PILL_WIDTH = 760
const CAPTION_PILL_HEIGHT = 88
// Gap between the bottom edge of the window and the bottom of the display
// work area. Roughly matches the bottom inset of macOS notification banners.
const CAPTION_PILL_BOTTOM_INSET = 36

function orbStateFile(): string {
  return join(app.getPath('userData'), 'orb-state.json')
}

interface OrbPersistedState { x: number; y: number }

function loadOrbState(): OrbPersistedState | null {
  try {
    const raw = readFileSync(orbStateFile(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<OrbPersistedState>
    if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
      return { x: parsed.x, y: parsed.y }
    }
  } catch {}
  return null
}

function saveOrbState(state: OrbPersistedState): void {
  try {
    writeFileSync(orbStateFile(), JSON.stringify(state), 'utf-8')
  } catch (err) {
    log(`Failed to persist orb state: ${(err as Error).message}`)
  }
}

// Re-apply the floating + all-workspaces flags. macOS occasionally drops
// these on display reconfig, app-level focus churn, or after the OS demotes
// the panel level when another app goes fullscreen. Cheap to call — the
// system NOOPs when state already matches. We pass `skipTransformProcessType`
// after the initial create so re-asserts don't flicker the dock/process
// type (Electron's default behavior would briefly demote the app between
// UIElement and Foreground).
function reassertOrbVisibility(reason: string, opts: { initial?: boolean } = {}): void {
  if (!orbWindow || orbWindow.isDestroyed()) return
  try {
    const visOpts: { visibleOnFullScreen: boolean; skipTransformProcessType?: boolean } = {
      visibleOnFullScreen: true,
    }
    if (!opts.initial) visOpts.skipTransformProcessType = true
    orbWindow.setVisibleOnAllWorkspaces(true, visOpts)
    orbWindow.setAlwaysOnTop(true, 'screen-saver')
    if (DEBUG_MODE) log(`[orb] re-assert always-on-top (${reason})`)
  } catch (err) {
    log(`Orb re-assert failed (${reason}): ${(err as Error).message}`)
  }
}

// If the orb is parked on a display that's no longer connected (lid closed,
// external monitor unplugged), nudge it back into the nearest visible display
// so the user can still see and interact with it.
function rescueOrbPositionIfOffscreen(): void {
  if (!orbWindow || orbWindow.isDestroyed()) return
  const b = orbWindow.getBounds()
  const cx = b.x + Math.round(b.width / 2)
  const cy = b.y + Math.round(b.height / 2)
  const displays = screen.getAllDisplays()
  const inside = displays.some((d) => {
    const wa = d.workArea
    return cx >= wa.x && cx <= wa.x + wa.width && cy >= wa.y && cy <= wa.y + wa.height
  })
  if (inside) return
  const cursor = screen.getCursorScreenPoint()
  const target = screen.getDisplayNearestPoint(cursor)
  const inset = 20
  const nx = target.workArea.x + target.workArea.width - b.width - inset
  const ny = target.workArea.y + inset
  log(`[orb] rescued off-screen orb to display ${target.id}`)
  orbWindow.setBounds({ x: nx, y: ny, width: b.width, height: b.height })
  saveOrbState({ x: nx, y: ny })
}

function createOrbWindow(): void {
  if (orbWindow && !orbWindow.isDestroyed()) {
    showOrbWindow()
    return
  }

  // Restore prior position if we have one AND it falls within a currently
  // connected display. Otherwise (or first launch) park in the top-right of
  // the display under the cursor.
  const saved = loadOrbState()
  const savedIsVisible = saved
    ? screen.getAllDisplays().some((d) => {
        const cx = saved.x + Math.round(ORB_WINDOW_WIDTH / 2)
        const cy = saved.y + Math.round(ORB_WINDOW_HEIGHT / 2)
        const wa = d.workArea
        return cx >= wa.x && cx <= wa.x + wa.width && cy >= wa.y && cy <= wa.y + wa.height
      })
    : false
  let x: number
  let y: number
  if (saved && savedIsVisible) {
    x = saved.x
    y = saved.y
  } else {
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    const { width: sw } = display.workAreaSize
    const { x: dx, y: dy } = display.workArea
    const ORB_DEFAULT_INSET = 20
    x = dx + sw - ORB_WINDOW_WIDTH - ORB_DEFAULT_INSET
    y = dy + ORB_DEFAULT_INSET
  }

  orbWindow = new BrowserWindow({
    width: ORB_WINDOW_WIDTH,
    height: ORB_WINDOW_HEIGHT,
    x,
    y,
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: true,
    backgroundColor: '#00000000',
    show: false,
    // Allow positioning past the menu bar / off-screen edges. Without this,
    // macOS clamps the window to the work area so the orb stops short of the
    // very top of the screen. Despite the name, this option governs both size
    // AND position constraints on macOS.
    enableLargerThanScreen: true,
    icon: join(__dirname, '../../resources/icon.icns'),
    webPreferences: {
      preload: join(__dirname, '../preload/orb.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })
  reassertOrbVisibility('create', { initial: true })
  orbWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  orbWindow.webContents.on('will-navigate', (event) => event.preventDefault())

  // No auto-hide on blur. The orb is meant to stay parked on screen across
  // every Space, every fullscreen app, and every focus change until the user
  // explicitly dismisses it with Cmd+Shift+O (or the tray menu). Switching
  // desktops, clicking a browser tab, or any other focus shift must NOT
  // remove it — that's the whole point of a persistent ambient agent.

  orbWindow.once('ready-to-show', () => {
    orbWindow?.show()
    orbWindow?.focus()
    // Start fully click-through so the transparent corners pass clicks down to
    // the desktop. The renderer's mousemove handler turns capture back on
    // when the cursor enters the orb's circular hit zone, and back off when
    // it leaves. `forward: true` is critical — without it, the renderer
    // never receives the mousemove that signals "you're now over the orb".
    orbWindow?.setIgnoreMouseEvents(true, { forward: true })
    if (process.env.ELECTRON_RENDERER_URL) {
      orbWindow?.webContents.openDevTools({ mode: 'detach' })
    }
  })

  // Persist the orb's last position so a re-summon reuses it. Also reposition
  // the caption pill when the orb crosses display boundaries — otherwise the
  // pill stays on the original display until the next display-metrics-changed
  // (could be never, if the user only ever drags between two static displays).
  let lastOrbDisplayId: number | null = null
  orbWindow.on('moved', () => {
    if (!orbWindow || orbWindow.isDestroyed()) return
    const b = orbWindow.getBounds()
    saveOrbState({ x: b.x, y: b.y })
    try {
      const cx = b.x + Math.round(b.width / 2)
      const cy = b.y + Math.round(b.height / 2)
      const display = screen.getDisplayNearestPoint({ x: cx, y: cy })
      if (lastOrbDisplayId !== null && display.id !== lastOrbDisplayId) {
        repositionCaptionPillWindow()
      }
      lastOrbDisplayId = display.id
    } catch {}
  })

  orbWindow.on('closed', () => {
    orbWindow = null
    // Tear down the caption pill along with the orb. The caption is a pure
    // companion surface — it has no reason to outlive the orb.
    destroyCaptionPillWindow()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    orbWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/orb.html`)
  } else {
    orbWindow.loadFile(join(__dirname, '../renderer/orb.html'))
  }

  // Spin up the bottom-of-screen caption pill alongside the orb. We do this
  // before the claude backend warmup so the pill is ready to receive the
  // very first orb_user_turn event if the user is fast.
  createCaptionPillWindow()

  // Lazily start the orb backend the first time the window opens — and warm
  // the underlying claude subprocess so the user's first turn doesn't pay the
  // spawn-and-MCP-init latency.
  orb.ensureStarted()
    .then(() => orb.warmup())
    .catch((err) => log(`Orb start error: ${(err as Error).message}`))

  // Pre-warm the whisper daemon in parallel with the claude session. By the
  // time the user finishes their first utterance the model is resident and
  // transcription is sub-200ms instead of paying a fresh spawn. Non-blocking
  // and idempotent — TRANSCRIBE_AUDIO falls back to per-spawn if not ready.
  whisperDaemon.start().catch((err) => log(`Whisper daemon start error: ${(err as Error).message}`))

  // Snapshot freshness is already guaranteed by the renderer's per-state
  // rAF push to STATE_SNAPSHOT_PUSH (consumed by orb.tabContext in main),
  // so no explicit request is needed when the orb opens.
}

// ─── Caption pill window ───
//
// Bottom-of-screen subtitle window for the voice agent. Created alongside the
// orb; tied to the orb's lifecycle. Always sits at the bottom-center of the
// display containing the orb. Always click-through. The pill content itself
// fades in/out based on orb events (driven from the renderer); when no turn
// is active the window is visible at the OS level but visually empty.

function computeCaptionPillBounds(): { x: number; y: number; width: number; height: number } {
  // Anchor to the display containing the orb. If the orb isn't on a connected
  // display (or doesn't exist yet), fall back to the cursor's display.
  let target = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  if (orbWindow && !orbWindow.isDestroyed()) {
    const b = orbWindow.getBounds()
    const cx = b.x + Math.round(b.width / 2)
    const cy = b.y + Math.round(b.height / 2)
    target = screen.getDisplayNearestPoint({ x: cx, y: cy })
  }
  const wa = target.workArea
  const x = wa.x + Math.round((wa.width - CAPTION_PILL_WIDTH) / 2)
  const y = wa.y + wa.height - CAPTION_PILL_HEIGHT - CAPTION_PILL_BOTTOM_INSET
  return { x, y, width: CAPTION_PILL_WIDTH, height: CAPTION_PILL_HEIGHT }
}

function createCaptionPillWindow(): void {
  if (captionPillWindow && !captionPillWindow.isDestroyed()) return

  const { x, y, width, height } = computeCaptionPillBounds()

  captionPillWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: false,
    backgroundColor: '#00000000',
    // NOTE: do NOT set `focusable: false`. macOS NSPanels with focusable=false
    // can fail to display via showInactive — the window appears in the window
    // server but never on screen. setIgnoreMouseEvents below blocks pointer
    // events; that's enough to keep the pill passive without breaking show.
    show: false,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: join(__dirname, '../preload/caption-pill.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })

  // Pill is a passive caption — must never intercept clicks.
  captionPillWindow.setIgnoreMouseEvents(true, { forward: false })
  // Travel across every Space + every fullscreen app, same as the orb. The
  // orb-style screen-saver level keeps it on top of native fullscreen apps.
  try {
    captionPillWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    captionPillWindow.setAlwaysOnTop(true, 'screen-saver')
  } catch {}

  captionPillWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  captionPillWindow.webContents.on('will-navigate', (e) => e.preventDefault())

  captionPillWindow.once('ready-to-show', () => {
    captionPillWindow?.showInactive()
    log(`[caption-pill] shown at ${x},${y} ${width}×${height}`)
    if (process.env.ELECTRON_RENDERER_URL) {
      captionPillWindow?.webContents.openDevTools({ mode: 'detach' })
    }
  })

  captionPillWindow.on('closed', () => {
    captionPillWindow = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    captionPillWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/caption-pill.html`)
  } else {
    captionPillWindow.loadFile(join(__dirname, '../renderer/caption-pill.html'))
  }
}

function destroyCaptionPillWindow(): void {
  if (!captionPillWindow) return
  if (!captionPillWindow.isDestroyed()) captionPillWindow.destroy()
  captionPillWindow = null
}

function repositionCaptionPillWindow(): void {
  if (!captionPillWindow || captionPillWindow.isDestroyed()) return
  const bounds = computeCaptionPillBounds()
  captionPillWindow.setBounds(bounds)
}

function showOrbWindow(): void {
  if (!orbWindow || orbWindow.isDestroyed()) {
    createOrbWindow()
    return
  }
  reassertOrbVisibility('show')
  orbWindow.show()
  orbWindow.focus()
  orb.ensureStarted().catch((err) => log(`Orb start error: ${(err as Error).message}`))
}

function hideOrbWindow(): void {
  if (orbWindow && !orbWindow.isDestroyed() && orbWindow.isVisible()) {
    orbWindow.hide()
    // Kill any in-flight TTS up front so audio stops the moment the orb
    // disappears, instead of waiting for the renderer's onDismissed handler
    // to round-trip ttsCancel back through IPC (~50–100ms gap during which
    // the caption pill is already hidden but afplay keeps speaking).
    // tts.cancel() is idempotent; the renderer still tears down its queue
    // state via the ORB_DISMISSED notification below.
    tts.cancel()
    // Explicit dismiss — tell the renderer to clean up. Auto-hide-on-blur
    // does NOT send this, so a tab opened by the orb (which steals focus)
    // doesn't accidentally cancel the orb's in-flight turn.
    orbWindow.webContents.send(IPC.ORB_DISMISSED)
    // Also tell the caption pill: when the orb is dismissed the caption is
    // no longer relevant, so hide it immediately (otherwise the in-flight
    // response's last sentence keeps showing at the bottom of the screen
    // after the orb itself is gone).
    sendToCaptionPill({ type: 'orb_dismissed' })
    orbRendererBusy = false
    pendingForceListen = false
    pendingHoldStart = false
    if (holdWatchdog) {
      clearTimeout(holdWatchdog)
      holdWatchdog = null
    }
    holdActive = false
    stopHoldKeyPoller()
    detachHoldKeyupListener()
  }
}

function toggleOrbWindow(): void {
  if (orbWindow && !orbWindow.isDestroyed() && orbWindow.isVisible()) {
    hideOrbWindow()
  } else {
    showOrbWindow()
  }
}

// ─── Agent dock window ───
//
// Floating, transparent, frameless vertical dock parked on the left edge of
// the user's primary display. Hosts the five-agent roster. Same panel-style
// always-on-top + visible-on-all-spaces flags as the orb so the dock survives
// space switches and fullscreen apps. Click-through outside the icon bounds —
// the renderer toggles capture via setIgnoreMouseEvents when the cursor enters
// the icon column (mirrors src/renderer/orb/App.tsx's pattern).

// Inset from the left edge of the work area. Tuned so the visible glass
// column sits ~12px off the screen edge — close enough to read as an "edge
// ornament", far enough that the icons don't kiss the bezel. The CSS adds
// `.dock-column { margin-left: 6px }` inside the transparent window, so the
// effective visible offset = DOCK_LEFT_INSET + 6.
const DOCK_LEFT_INSET = 6
// Vertical bias above the work-area's geometric center. The dock looks more
// "anchored" sitting slightly above true middle — same trick designers use
// for logos and modal placement (the optical center is a touch higher than
// the math center because we read top-down). Positive = up.
const DOCK_VERTICAL_LIFT = 60
// Tight footprint — the visible dock is ~84px wide; we keep margin for the
// glass shadow and the optional toast that slides in from the right.
const DOCK_WINDOW_WIDTH = 340
// Tall enough for the 5-icon vertical column with headroom for toasts and the
// entrance animation. Slightly oversized so the transparent margin absorbs the
// glass blur halo without clipping.
const DOCK_WINDOW_HEIGHT = 560

function dockStateFile(): string {
  return join(app.getPath('userData'), 'dock-state.json')
}

interface DockPersistedState { x: number; y: number; visible: boolean }

function loadDockState(): DockPersistedState | null {
  try {
    const raw = readFileSync(dockStateFile(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<DockPersistedState>
    if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
      return {
        x: parsed.x,
        y: parsed.y,
        // Default to visible — the dock is meant to be ambient. The flag is
        // only persisted when the user explicitly hides it via the tray.
        visible: parsed.visible !== false,
      }
    }
  } catch {}
  return null
}

function saveDockState(state: DockPersistedState): void {
  try {
    writeFileSync(dockStateFile(), JSON.stringify(state), 'utf-8')
  } catch (err) {
    log(`Failed to persist dock state: ${(err as Error).message}`)
  }
}

function reassertDockVisibility(reason: string, opts: { initial?: boolean } = {}): void {
  if (!dockWindow || dockWindow.isDestroyed()) return
  try {
    const visOpts: { visibleOnFullScreen: boolean; skipTransformProcessType?: boolean } = {
      visibleOnFullScreen: true,
    }
    if (!opts.initial) visOpts.skipTransformProcessType = true
    dockWindow.setVisibleOnAllWorkspaces(true, visOpts)
    dockWindow.setAlwaysOnTop(true, 'screen-saver')
    if (DEBUG_MODE) log(`[dock] re-assert always-on-top (${reason})`)
  } catch (err) {
    log(`Dock re-assert failed (${reason}): ${(err as Error).message}`)
  }
}

function createDockWindow(): void {
  if (dockWindow && !dockWindow.isDestroyed()) {
    showDockWindow()
    return
  }

  // Restore prior position if we have one and it's still on a connected
  // display. Otherwise park vertically centered against the left edge of the
  // display under the cursor (best guess at "user's primary screen").
  const saved = loadDockState()
  const savedIsVisible = saved
    ? screen.getAllDisplays().some((d) => {
        const cx = saved.x + Math.round(DOCK_WINDOW_WIDTH / 2)
        const cy = saved.y + Math.round(DOCK_WINDOW_HEIGHT / 2)
        const wa = d.workArea
        return cx >= wa.x && cx <= wa.x + wa.width && cy >= wa.y && cy <= wa.y + wa.height
      })
    : false
  let x: number
  let y: number
  if (saved && savedIsVisible) {
    x = saved.x
    y = saved.y
  } else {
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    const { x: dx, y: dy, height: dh } = display.workArea
    x = dx + DOCK_LEFT_INSET
    y = dy + Math.round((dh - DOCK_WINDOW_HEIGHT) / 2) - DOCK_VERTICAL_LIFT
  }

  dockWindow = new BrowserWindow({
    width: DOCK_WINDOW_WIDTH,
    height: DOCK_WINDOW_HEIGHT,
    x,
    y,
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: true,
    backgroundColor: '#00000000',
    show: false,
    enableLargerThanScreen: true,
    icon: join(__dirname, '../../resources/icon.icns'),
    webPreferences: {
      preload: join(__dirname, '../preload/dock.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })
  reassertDockVisibility('create', { initial: true })
  dockWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  dockWindow.webContents.on('will-navigate', (event) => event.preventDefault())

  dockWindow.once('ready-to-show', () => {
    if (!dockWindow || dockWindow.isDestroyed()) return
    // The dock is an ambient surface — always show on app start. The saved
    // `visible` flag only governs in-session toggles (Cmd+Shift+D / tray) so
    // an accidental hide doesn't render the feature invisible across a
    // restart, leaving the user wondering where it went.
    dockWindow.show()
    // Start fully click-through; the renderer flips capture back on when the
    // cursor enters the icon column. `forward: true` is critical so the
    // renderer still receives the mousemove that signals "you're over me".
    dockWindow.setIgnoreMouseEvents(true, { forward: true })
  })

  dockWindow.on('moved', () => {
    if (!dockWindow || dockWindow.isDestroyed()) return
    const b = dockWindow.getBounds()
    saveDockState({ x: b.x, y: b.y, visible: dockWindow.isVisible() })
  })

  dockWindow.on('closed', () => {
    dockWindow = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    dockWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/dock.html`)
  } else {
    dockWindow.loadFile(join(__dirname, '../renderer/dock.html'))
  }
}

function showDockWindow(): void {
  if (!dockWindow || dockWindow.isDestroyed()) {
    createDockWindow()
    return
  }
  reassertDockVisibility('show')
  dockWindow.show()
  const b = dockWindow.getBounds()
  saveDockState({ x: b.x, y: b.y, visible: true })
  // Tray label flips between "Show Agent Dock" and "Hide Agent Dock" based on
  // current visibility — keep the menu in sync on every toggle.
  rebuildTrayMenu()
}

function hideDockWindow(): void {
  if (!dockWindow || dockWindow.isDestroyed()) return
  if (!dockWindow.isVisible()) return
  dockWindow.hide()
  const b = dockWindow.getBounds()
  saveDockState({ x: b.x, y: b.y, visible: false })
  rebuildTrayMenu()
}

function toggleDockWindow(): void {
  if (dockWindow && !dockWindow.isDestroyed() && dockWindow.isVisible()) {
    hideDockWindow()
  } else {
    if (!dockWindow || dockWindow.isDestroyed()) createDockWindow()
    else showDockWindow()
  }
}

function rebuildTrayMenu(): void {
  if (!tray || !trayContextMenuFactory) return
  try {
    tray.setContextMenu(trayContextMenuFactory())
  } catch {}
}

function showWindow(source = 'unknown'): void {
  if (!mainWindow) return
  const toggleId = ++toggleSequence

  if (lastWindowBounds) {
    mainWindow.setBounds(lastWindowBounds)
  }

  // Always re-assert space membership — the flag can be lost after hide/show cycles
  // and must be set before show() so the window joins the active Space, not its
  // last-known Space.
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  if (SPACES_DEBUG) {
    const b = mainWindow.getBounds()
    log(`[spaces] showWindow#${toggleId} source=${source} preserve-bounds=(${b.x},${b.y},${b.width}x${b.height})`)
    snapshotWindowState(`showWindow#${toggleId} pre-show`)
  }
  // As an accessory app (app.dock.hide), show() + focus gives keyboard
  // without deactivating the active app — hover preserved everywhere.
  mainWindow.show()
  if (lastWindowBounds) {
    mainWindow.setBounds(lastWindowBounds)
  }
  mainWindow.webContents.focus()
  broadcast(IPC.WINDOW_SHOWN)
  if (SPACES_DEBUG) scheduleToggleSnapshots(toggleId, 'show')
}

function resetWindowPosition(): void {
  if (!mainWindow) return

  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const { width: sw, height: sh } = display.workAreaSize
  const { x: dx, y: dy } = display.workArea

  mainWindow.setBounds({
    x: dx + Math.round((sw - BAR_WIDTH) / 2),
    y: dy + sh - PILL_HEIGHT - PILL_BOTTOM_MARGIN,
    width: BAR_WIDTH,
    height: PILL_HEIGHT,
  })
  lastWindowBounds = mainWindow.getBounds()
}

function toggleWindow(source = 'unknown'): void {
  if (!mainWindow) return
  const toggleId = ++toggleSequence
  if (SPACES_DEBUG) {
    log(`[spaces] toggle#${toggleId} source=${source} start`)
    snapshotWindowState(`toggle#${toggleId} pre`)
  }

  if (mainWindow.isVisible()) {
    mainWindow.hide()
    if (SPACES_DEBUG) scheduleToggleSnapshots(toggleId, 'hide')
  } else {
    showWindow(source)
  }
}

// ─── Resize ───
// Fixed-height mode: ignore renderer resize events to prevent jank.
// The native window stays at PILL_HEIGHT; all expand/collapse happens inside the renderer.

ipcMain.on(IPC.RESIZE_HEIGHT, () => {
  // No-op — fixed height window, no dynamic resize
})

ipcMain.on(IPC.SET_WINDOW_WIDTH, () => {
  // No-op — native width is fixed to keep expand/collapse animation smooth.
})

ipcMain.handle(IPC.ANIMATE_HEIGHT, () => {
  // No-op — kept for API compat, animation handled purely in renderer
})

ipcMain.on(IPC.HIDE_WINDOW, () => {
  mainWindow?.hide()
})

ipcMain.handle(IPC.IS_VISIBLE, () => {
  return mainWindow?.isVisible() ?? false
})

// OS-level click-through toggle — renderer calls this on mousemove
// to enable clicks on interactive UI while passing through transparent areas
ipcMain.on(IPC.SET_IGNORE_MOUSE_EVENTS, (event, ignore: boolean, options?: { forward?: boolean }) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win && !win.isDestroyed()) {
    win.setIgnoreMouseEvents(ignore, options || {})
  }
})

// Manual window drag — works reliably with frameless + setIgnoreMouseEvents.
// Uses setBounds rather than setPosition so the window can travel above the
// menu bar (negative y) — needed for the floating orb where the user expects
// to be able to park it anywhere, including the very top of the screen.
ipcMain.on(IPC.START_WINDOW_DRAG, (event, deltaX: number, deltaY: number) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win && !win.isDestroyed()) {
    const b = win.getBounds()
    win.setBounds({
      x: Math.round(b.x + deltaX),
      y: Math.round(b.y + deltaY),
      width: b.width,
      height: b.height,
    })
    // Only mirror the pill's bounds — the orb has its own drag and shouldn't
    // clobber the pill's restore position.
    if (win === mainWindow) lastWindowBounds = win.getBounds()
  }
})

ipcMain.on(IPC.RESET_WINDOW_POSITION, () => {
  resetWindowPosition()
})

// ─── IPC Handlers (typed, strict) ───

ipcMain.handle(IPC.START, async () => {
  log('IPC START — fetching static CLI info')

  const instance = getActiveInstance()

  const version = execClaudeSync(['-v']) ?? 'unknown'

  let auth: { email?: string; subscriptionType?: string; authMethod?: string } = {}
  const authRaw = execClaudeSync(['auth', 'status'])
  if (authRaw) {
    try { auth = JSON.parse(authRaw) } catch {}
  }

  let mcpServers: string[] = []
  const mcpRaw = execClaudeSync(['mcp', 'list'])
  if (mcpRaw) mcpServers = mcpRaw.split('\n').filter(Boolean)

  return {
    version,
    auth,
    mcpServers,
    projectPath: process.cwd(),
    homePath: require('os').homedir(),
    claudeMode: instance.mode,
    claudeAvailable: instance.available,
    claudeLabel: instance.label,
    claudeHome: instance.homeDescription,
    claudeUnavailableReason: instance.unavailableReason ?? null,
  }
})

ipcMain.handle(IPC.CREATE_TAB, (_event, payload?: { desiredId?: string }) => {
  const tabId = controlPlane.createTab(payload?.desiredId)
  log(`IPC CREATE_TAB${payload?.desiredId ? ` (desired=${payload.desiredId})` : ''} → ${tabId}`)
  return { tabId }
})

ipcMain.on(IPC.INIT_SESSION, (_event, tabId: string) => {
  log(`IPC INIT_SESSION: ${tabId}`)
  controlPlane.initSession(tabId)
})

ipcMain.on(IPC.RESET_TAB_SESSION, (_event, tabId: string) => {
  log(`IPC RESET_TAB_SESSION: ${tabId}`)
  controlPlane.resetTabSession(tabId)
})

ipcMain.handle(IPC.PROMPT, async (_event, { tabId, requestId, options }: { tabId: string; requestId: string; options: RunOptions }) => {
  if (DEBUG_MODE) {
    log(`IPC PROMPT: tab=${tabId} req=${requestId} prompt="${options.prompt.substring(0, 100)}"`)
  } else {
    log(`IPC PROMPT: tab=${tabId} req=${requestId}`)
  }

  if (!tabId) {
    throw new Error('No tabId provided — prompt rejected')
  }
  if (!requestId) {
    throw new Error('No requestId provided — prompt rejected')
  }

  try {
    await controlPlane.submitPrompt(tabId, requestId, options)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`PROMPT error: ${msg}`)
    throw err
  }
})

ipcMain.handle(IPC.CANCEL, (_event, requestId: string) => {
  log(`IPC CANCEL: ${requestId}`)
  return controlPlane.cancel(requestId)
})

ipcMain.handle(IPC.STOP_TAB, (_event, tabId: string) => {
  log(`IPC STOP_TAB: ${tabId}`)
  return controlPlane.cancelTab(tabId)
})

ipcMain.handle(IPC.RETRY, async (_event, { tabId, requestId, options }: { tabId: string; requestId: string; options: RunOptions }) => {
  log(`IPC RETRY: tab=${tabId} req=${requestId}`)
  return controlPlane.retry(tabId, requestId, options)
})

ipcMain.handle(IPC.STATUS, () => {
  return controlPlane.getHealth()
})

ipcMain.handle(IPC.TAB_HEALTH, () => {
  return controlPlane.getHealth()
})

ipcMain.handle(IPC.CLOSE_TAB, (_event, tabId: string) => {
  log(`IPC CLOSE_TAB: ${tabId}`)
  controlPlane.closeTab(tabId)
})

ipcMain.on(IPC.SET_PERMISSION_MODE, (_event, mode: string) => {
  if (mode !== 'ask' && mode !== 'auto' && mode !== 'bypass') {
    log(`IPC SET_PERMISSION_MODE: invalid mode "${mode}" — ignoring`)
    return
  }
  log(`IPC SET_PERMISSION_MODE: ${mode}`)
  controlPlane.setPermissionMode(mode)
})

ipcMain.handle(IPC.RESPOND_PERMISSION, (_event, { tabId, questionId, optionId }: { tabId: string; questionId: string; optionId: string }) => {
  log(`IPC RESPOND_PERMISSION: tab=${tabId} question=${questionId} option=${optionId}`)
  return controlPlane.respondToPermission(tabId, questionId, optionId)
})

ipcMain.handle(IPC.ALLOW_DENIED_TOOLS, (_event, { tabId, toolNames }: { tabId: string; toolNames: string[] }) => {
  log(`IPC ALLOW_DENIED_TOOLS: tab=${tabId} tools=${toolNames.join(',')}`)
  return controlPlane.allowDeniedTools(tabId, toolNames)
})

ipcMain.handle(IPC.LIST_SESSIONS, async (_e, projectPath?: string) => {
  log(`IPC LIST_SESSIONS ${projectPath ? `(path=${projectPath})` : ''}`)
  try {
    const cwd = projectPath || process.cwd()
    // Validate projectPath — reject null bytes, newlines, non-absolute paths
    if (/[\0\r\n]/.test(cwd) || !cwd.startsWith('/')) {
      log(`LIST_SESSIONS: rejected invalid projectPath: ${cwd}`)
      return []
    }
    // Claude stores project sessions at ~/.claude/projects/<encoded-path>/
    // Path encoding: replace all '/' with '-' (leading '/' becomes leading '-')
    const encodedPath = cwd.replace(/\//g, '-')
    const sessionsDir = join(homedir(), '.claude', 'projects', encodedPath)
    if (!existsSync(sessionsDir)) {
      log(`LIST_SESSIONS: directory not found: ${sessionsDir}`)
      return []
    }
    const files = readdirSync(sessionsDir).filter((f: string) => f.endsWith('.jsonl'))

    const sessions: Array<{ sessionId: string; slug: string | null; firstMessage: string | null; lastTimestamp: string; size: number }> = []

    // UUID v4 regex — only consider files named as valid UUIDs
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

    for (const file of files) {
      // The filename (without .jsonl) IS the canonical resume ID for `claude --resume`
      const fileSessionId = file.replace(/\.jsonl$/, '')
      if (!UUID_RE.test(fileSessionId)) continue // skip non-UUID files

      const filePath = join(sessionsDir, file)
      const stat = statSync(filePath)
      if (stat.size < 100) continue // skip trivially small files

      // Read lines to extract metadata and validate transcript schema
      const meta: { validated: boolean; slug: string | null; firstMessage: string | null; lastTimestamp: string | null } = {
        validated: false, slug: null, firstMessage: null, lastTimestamp: null,
      }

      await new Promise<void>((resolve) => {
        const rl = createInterface({ input: createReadStream(filePath) })
        rl.on('line', (line: string) => {
          try {
            const obj = JSON.parse(line)
            // Validate: must have expected Claude transcript fields
            if (!meta.validated && obj.type && obj.uuid && obj.timestamp) {
              meta.validated = true
            }
            if (obj.slug && !meta.slug) meta.slug = obj.slug
            if (obj.timestamp) meta.lastTimestamp = obj.timestamp
            if (obj.type === 'user' && !meta.firstMessage) {
              const content = obj.message?.content
              if (typeof content === 'string') {
                meta.firstMessage = content.substring(0, 100)
              } else if (Array.isArray(content)) {
                const textPart = content.find((p: any) => p.type === 'text')
                meta.firstMessage = textPart?.text?.substring(0, 100) || null
              }
            }
          } catch {}
          // Read all lines to get the last timestamp
        })
        rl.on('close', () => resolve())
      })

      if (meta.validated) {
        sessions.push({
          sessionId: fileSessionId,
          slug: meta.slug,
          firstMessage: meta.firstMessage,
          lastTimestamp: meta.lastTimestamp || stat.mtime.toISOString(),
          size: stat.size,
        })
      }
    }

    // Sort by last timestamp, most recent first
    sessions.sort((a, b) => new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime())
    return sessions.slice(0, 20) // Return top 20
  } catch (err) {
    log(`LIST_SESSIONS error: ${err}`)
    return []
  }
})

// Load conversation history from a session's JSONL file
ipcMain.handle(IPC.LOAD_SESSION, async (_e, arg: { sessionId: string; projectPath?: string } | string) => {
  const sessionId = typeof arg === 'string' ? arg : arg.sessionId
  const projectPath = typeof arg === 'string' ? undefined : arg.projectPath
  log(`IPC LOAD_SESSION ${sessionId}${projectPath ? ` (path=${projectPath})` : ''}`)

  // Validate sessionId — must be strict UUID to prevent path traversal via crafted filenames
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!UUID_RE.test(sessionId)) {
    log(`LOAD_SESSION: rejected invalid sessionId: ${sessionId}`)
    return []
  }

  try {
    const cwd = projectPath || process.cwd()
    // Validate projectPath — reject null bytes, newlines, non-absolute paths
    if (/[\0\r\n]/.test(cwd) || !cwd.startsWith('/')) {
      log(`LOAD_SESSION: rejected invalid projectPath: ${cwd}`)
      return []
    }
    const encodedPath = cwd.replace(/\//g, '-')
    const filePath = join(homedir(), '.claude', 'projects', encodedPath, `${sessionId}.jsonl`)
    if (!existsSync(filePath)) return []

    const messages: Array<{ role: string; content: string; toolName?: string; timestamp: number }> = []
    await new Promise<void>((resolve) => {
      const rl = createInterface({ input: createReadStream(filePath) })
      rl.on('line', (line: string) => {
        try {
          const obj = JSON.parse(line)
          if (obj.type === 'user') {
            const content = obj.message?.content
            let text = ''
            if (typeof content === 'string') {
              text = content
            } else if (Array.isArray(content)) {
              text = content
                .filter((b: any) => b.type === 'text')
                .map((b: any) => b.text)
                .join('\n')
            }
            if (text) {
              messages.push({ role: 'user', content: text, timestamp: new Date(obj.timestamp).getTime() })
            }
          } else if (obj.type === 'assistant') {
            const content = obj.message?.content
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'text' && block.text) {
                  messages.push({ role: 'assistant', content: block.text, timestamp: new Date(obj.timestamp).getTime() })
                } else if (block.type === 'tool_use' && block.name) {
                  messages.push({
                    role: 'tool',
                    content: '',
                    toolName: block.name,
                    timestamp: new Date(obj.timestamp).getTime(),
                  })
                }
              }
            }
          }
        } catch {}
      })
      rl.on('close', () => resolve())
    })
    return messages
  } catch (err) {
    log(`LOAD_SESSION error: ${err}`)
    return []
  }
})

ipcMain.handle(IPC.EXPORT_TRANSCRIPT, async (_event, input: TranscriptInput) => {
  if (!mainWindow) return { ok: false, error: 'Window not available' }
  if (!input || !Array.isArray(input.messages)) {
    return { ok: false, error: 'Invalid transcript payload' }
  }

  // Trust comes from contextIsolation + our own preload — but still cap input size
  // so a runaway tab can't propose a multi-GB save.
  const markdown = tabToMarkdown({ ...input, exportedAt: input.exportedAt || Date.now() })
  if (markdown.length > 32 * 1024 * 1024) {
    return { ok: false, error: 'Transcript exceeds 32 MB export limit' }
  }

  const suggestedName = defaultExportFilename(input.title, input.exportedAt || Date.now())
  if (process.platform === 'darwin') app.focus()
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export transcript',
    defaultPath: suggestedName,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  })
  if (result.canceled || !result.filePath) return { ok: false, canceled: true }

  try {
    const { writeFileSync } = require('fs')
    writeFileSync(result.filePath, markdown, 'utf-8')
    log(`EXPORT_TRANSCRIPT wrote ${markdown.length} bytes to ${result.filePath}`)
    return { ok: true, path: result.filePath }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`EXPORT_TRANSCRIPT failed: ${msg}`)
    return { ok: false, error: msg }
  }
})

ipcMain.handle(IPC.SELECT_DIRECTORY, async () => {
  if (!mainWindow) return null
  // macOS: activate app so unparented dialog appears on top (not behind other apps).
  // Unparented avoids modal dimming on the transparent overlay.
  // Activation is fine here — user is actively interacting with RAX.
  if (process.platform === 'darwin') app.focus()
  const options = { properties: ['openDirectory'] as const }
  const result = process.platform === 'darwin'
    ? await dialog.showOpenDialog(options)
    : await dialog.showOpenDialog(mainWindow, options)
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle(IPC.OPEN_EXTERNAL, async (_event, url: string) => {
  try {
    // Parse with URL constructor to reject malformed/ambiguous payloads
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    if (!parsed.hostname) return false
    await shell.openExternal(parsed.href)
    return true
  } catch {
    return false
  }
})

ipcMain.handle(IPC.ATTACH_FILES, async () => {
  if (!mainWindow) return null
  // macOS: activate app so unparented dialog appears on top
  if (process.platform === 'darwin') app.focus()
  const options = {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'All Files', extensions: ['*'] },
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] },
      { name: 'Code', extensions: ['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'md', 'json', 'yaml', 'toml'] },
    ],
  }
  const result = process.platform === 'darwin'
    ? await dialog.showOpenDialog(options)
    : await dialog.showOpenDialog(mainWindow, options)
  if (result.canceled || result.filePaths.length === 0) return null

  const { basename, extname } = require('path')
  const { readFileSync, statSync } = require('fs')

  const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])
  const mimeMap: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
    '.json': 'application/json', '.yaml': 'text/yaml', '.toml': 'text/toml',
  }

  return result.filePaths.map((fp: string) => {
    const ext = extname(fp).toLowerCase()
    const mime = mimeMap[ext] || 'application/octet-stream'
    const stat = statSync(fp)
    let dataUrl: string | undefined

    // Generate preview data URL for images (max 2MB to keep IPC fast)
    if (IMAGE_EXTS.has(ext) && stat.size < 2 * 1024 * 1024) {
      try {
        const buf = readFileSync(fp)
        dataUrl = `data:${mime};base64,${buf.toString('base64')}`
      } catch {}
    }

    return {
      id: crypto.randomUUID(),
      type: IMAGE_EXTS.has(ext) ? 'image' : 'file',
      name: basename(fp),
      path: fp,
      mimeType: mime,
      dataUrl,
      size: stat.size,
    }
  })
})

ipcMain.handle(IPC.TAKE_SCREENSHOT, async () => {
  if (!mainWindow) return null

  if (SPACES_DEBUG) snapshotWindowState('screenshot pre-hide')
  mainWindow.hide()
  await new Promise((r) => setTimeout(r, 300))

  try {
    const { execSync } = require('child_process')
    const { join } = require('path')
    const { tmpdir } = require('os')
    const { readFileSync, existsSync } = require('fs')

    const timestamp = Date.now()
    const screenshotPath = join(tmpdir(), `rax-screenshot-${timestamp}.png`)

    execSync(`/usr/sbin/screencapture -i "${screenshotPath}"`, {
      timeout: 30000,
      stdio: 'ignore',
    })

    if (!existsSync(screenshotPath)) {
      return null
    }

    // Return structured attachment with data URL preview
    const buf = readFileSync(screenshotPath)
    return {
      id: crypto.randomUUID(),
      type: 'image',
      name: `screenshot ${++screenshotCounter}.png`,
      path: screenshotPath,
      mimeType: 'image/png',
      dataUrl: `data:image/png;base64,${buf.toString('base64')}`,
      size: buf.length,
    }
  } catch {
    return null
  } finally {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.webContents.focus()
    }
    broadcast(IPC.WINDOW_SHOWN)
    if (SPACES_DEBUG) {
      log('[spaces] screenshot restore show+focus')
      snapshotWindowState('screenshot restore immediate')
      setTimeout(() => snapshotWindowState('screenshot restore +200ms'), 200)
    }
  }
})

let pasteCounter = 0
ipcMain.handle(IPC.PASTE_IMAGE, async (_event, dataUrl: string) => {
  try {
    const { writeFileSync } = require('fs')
    const { join } = require('path')
    const { tmpdir } = require('os')

    // Parse data URL: "data:image/png;base64,..."
    const match = dataUrl.match(/^data:(image\/(\w+));base64,(.+)$/)
    if (!match) return null

    const [, mimeType, ext, base64Data] = match
    const buf = Buffer.from(base64Data, 'base64')
    const timestamp = Date.now()
    const filePath = join(tmpdir(), `rax-paste-${timestamp}.${ext}`)
    writeFileSync(filePath, buf)

    return {
      id: crypto.randomUUID(),
      type: 'image',
      name: `pasted image ${++pasteCounter}.${ext}`,
      path: filePath,
      mimeType,
      dataUrl,
      size: buf.length,
    }
  } catch {
    return null
  }
})

ipcMain.handle(IPC.TRANSCRIBE_AUDIO, async (_event, audioBase64: string) => {
  const { writeFileSync, existsSync, unlinkSync, readFileSync } = require('fs')
  const { execFile } = require('child_process')
  const { join, basename } = require('path')
  const { tmpdir } = require('os')

  const startedAt = Date.now()
  const phaseMs: Record<string, number> = {}
  const mark = (name: string, t0: number) => { phaseMs[name] = Date.now() - t0 }

  const tmpWav = join(tmpdir(), `rax-voice-${Date.now()}.wav`)
  try {
    const runExecFile = (bin: string, args: string[], timeout: number): Promise<string> =>
      new Promise((resolve, reject) => {
        execFile(bin, args, { encoding: 'utf-8', timeout }, (err: any, stdout: string, stderr: string) => {
          if (err) {
            const detail = stderr?.trim() || stdout?.trim() || err.message
            reject(new Error(detail))
            return
          }
          resolve(stdout || '')
        })
      })

    let t0 = Date.now()
    const buf = Buffer.from(audioBase64, 'base64')
    writeFileSync(tmpWav, buf)
    mark('decode+write_wav', t0)

    // Fast path: long-lived whisper-server daemon if it's already loaded the
    // model. Skips the 300–700ms cold-spawn cost paid by the per-turn
    // whisperkit-cli / whisper-cli backends below. Falls through to the
    // legacy path if the daemon isn't ready (still starting up, not
    // installed, or transient HTTP failure).
    if (whisperDaemon.isReady()) {
      t0 = Date.now()
      try {
        const result = await whisperDaemon.transcribe(tmpWav)
        mark('whisper_daemon_transcribe', t0)
        log(`Transcription timing(ms): ${JSON.stringify({ ...phaseMs, total: Date.now() - startedAt, backend: 'daemon' })}`)
        return { error: null, transcript: result.transcript }
      } catch (err: any) {
        log(`Daemon transcribe failed (${err.message}) — falling through to per-spawn`)
        mark('whisper_daemon_failed', t0)
      }
    }

    // Find whisper backend in priority order: whisperkit-cli (Apple Silicon CoreML) → whisper-cli (whisper-cpp) → whisper (python)
    t0 = Date.now()
    const candidates = [
      '/opt/homebrew/bin/whisperkit-cli',
      '/usr/local/bin/whisperkit-cli',
      '/opt/homebrew/bin/whisper-cli',
      '/usr/local/bin/whisper-cli',
      '/opt/homebrew/bin/whisper',
      '/usr/local/bin/whisper',
      join(homedir(), '.local/bin/whisper'),
    ]

    let whisperBin = ''
    for (const c of candidates) {
      if (existsSync(c)) { whisperBin = c; break }
    }
    mark('probe_binary_paths', t0)

    if (!whisperBin) {
      t0 = Date.now()
      for (const name of ['whisperkit-cli', 'whisper-cli', 'whisper']) {
        try {
          whisperBin = await runExecFile('/bin/zsh', ['-lc', `whence -p ${name}`], 5000).then((s) => s.trim())
          if (whisperBin) break
        } catch {}
      }
      mark('probe_binary_whence', t0)
    }

    if (!whisperBin) {
      const hint = process.arch === 'arm64'
        ? 'brew install whisperkit-cli   (or: brew install whisper-cpp)'
        : 'brew install whisper-cpp'
      return {
        error: `Whisper not found. Install with:\n  ${hint}`,
        transcript: null,
      }
    }

    const isWhisperKit = whisperBin.includes('whisperkit-cli')
    const isWhisperCpp = !isWhisperKit && whisperBin.includes('whisper-cli')

    log(`Transcribing with: ${whisperBin} (backend: ${isWhisperKit ? 'WhisperKit' : isWhisperCpp ? 'whisper-cpp' : 'Python whisper'})`)

    let output: string
    // Allow opting into a more accurate (but slower) Whisper model via env var.
    // Set RAX_WHISPER_MODEL=base for better accuracy on accents / technical
    // jargon. Defaults to "tiny" for snappy turn-taking.
    const whisperModel = (process.env.RAX_WHISPER_MODEL || 'tiny').toLowerCase()

    if (isWhisperKit) {
      // WhisperKit (Apple Silicon CoreML) — auto-downloads models on first run
      // Use --report to produce a JSON file with a top-level "text" field for deterministic parsing
      const reportDir = tmpdir()
      t0 = Date.now()
      output = await runExecFile(
        whisperBin,
        ['transcribe', '--audio-path', tmpWav, '--model', whisperModel, '--without-timestamps', '--skip-special-tokens', '--report', '--report-path', reportDir],
        60000
      )
      mark('whisperkit_transcribe_report', t0)

      // WhisperKit writes <audioFileName>.json (filename without extension)
      const wavBasename = basename(tmpWav, '.wav')
      const reportPath = join(reportDir, `${wavBasename}.json`)
      if (existsSync(reportPath)) {
        try {
          t0 = Date.now()
          const report = JSON.parse(readFileSync(reportPath, 'utf-8'))
          const transcript = (report.text || '').trim()
          mark('whisperkit_parse_report_json', t0)
          try { unlinkSync(reportPath) } catch {}
          // Also clean up .srt that --report creates
          const srtPath = join(reportDir, `${wavBasename}.srt`)
          try { unlinkSync(srtPath) } catch {}
          log(`Transcription timing(ms): ${JSON.stringify({ ...phaseMs, total: Date.now() - startedAt })}`)
          return { error: null, transcript }
        } catch (parseErr: any) {
          log(`WhisperKit JSON parse failed: ${parseErr.message}, falling back to stdout`)
          try { unlinkSync(reportPath) } catch {}
        }
      }

      // Performance fallback: avoid a second full transcription if report file is missing/invalid.
      // Use stdout from the first run to keep latency close to pre-report behavior.
      if (!output || !output.trim()) {
        t0 = Date.now()
        output = await runExecFile(
          whisperBin,
          ['transcribe', '--audio-path', tmpWav, '--model', whisperModel, '--without-timestamps', '--skip-special-tokens'],
          60000
        )
        mark('whisperkit_transcribe_stdout_rerun', t0)
      }
    } else if (isWhisperCpp) {
      // whisper-cpp: whisper-cli -m model -f file --no-timestamps
      // Find model file — prefer multilingual (auto-detect language) over .en (English-only)
      const modelCandidates = [
        join(homedir(), '.local/share/whisper/ggml-base.bin'),
        join(homedir(), '.local/share/whisper/ggml-tiny.bin'),
        '/opt/homebrew/share/whisper-cpp/models/ggml-base.bin',
        '/opt/homebrew/share/whisper-cpp/models/ggml-tiny.bin',
        join(homedir(), '.local/share/whisper/ggml-base.en.bin'),
        join(homedir(), '.local/share/whisper/ggml-tiny.en.bin'),
        '/opt/homebrew/share/whisper-cpp/models/ggml-base.en.bin',
        '/opt/homebrew/share/whisper-cpp/models/ggml-tiny.en.bin',
      ]

      let modelPath = ''
      for (const m of modelCandidates) {
        if (existsSync(m)) { modelPath = m; break }
      }

      if (!modelPath) {
        const defaultModelPath = join(homedir(), '.local/share/whisper/ggml-tiny.bin')
        const modelUrl = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin'
        try {
          t0 = Date.now()
          log(`Whisper model missing — downloading ggml-tiny to ${defaultModelPath}`)
          await downloadWhisperModel(defaultModelPath, modelUrl)
          mark('whisper_model_download', t0)
          modelPath = defaultModelPath
          log(`Whisper model downloaded (${phaseMs['whisper_model_download']}ms)`)
        } catch (dlErr: any) {
          return {
            error: `Whisper model auto-download failed: ${dlErr.message}\nManual install:\n  mkdir -p ~/.local/share/whisper && curl -L -o ~/.local/share/whisper/ggml-tiny.bin ${modelUrl}`,
            transcript: null,
          }
        }
      }

      const isEnglishOnly = modelPath.includes('.en.')
      const langFlag = isEnglishOnly ? '-l en' : '-l auto'
      t0 = Date.now()
      output = await runExecFile(
        whisperBin,
        ['-m', modelPath, '-f', tmpWav, '--no-timestamps', '-l', isEnglishOnly ? 'en' : 'auto'],
        30000
      )
      mark('whisper_cpp_transcribe', t0)
    } else {
      // Python whisper
      t0 = Date.now()
      output = await runExecFile(
        whisperBin,
        [tmpWav, '--model', 'tiny', '--output_format', 'txt', '--output_dir', tmpdir()],
        30000
      )
      mark('python_whisper_transcribe', t0)
      // Python whisper writes .txt file
      const txtPath = tmpWav.replace('.wav', '.txt')
      if (existsSync(txtPath)) {
        t0 = Date.now()
        const transcript = readFileSync(txtPath, 'utf-8').trim()
        mark('python_whisper_read_txt', t0)
        try { unlinkSync(txtPath) } catch {}
        log(`Transcription timing(ms): ${JSON.stringify({ ...phaseMs, total: Date.now() - startedAt })}`)
        return { error: null, transcript }
      }
      // File not created — Python whisper failed silently
      return {
        error: `Whisper output file not found at ${txtPath}. Check disk space and permissions.`,
        transcript: null,
      }
    }

    // WhisperKit (stdout fallback) and whisper-cpp print to stdout directly
    // Strip timestamp patterns and known hallucination outputs
    const HALLUCINATIONS = /^\s*(\[BLANK_AUDIO\]|you\.?|thank you\.?|thanks\.?)\s*$/i
    const transcript = output
      .replace(/\[[\d:.]+\s*-->\s*[\d:.]+\]\s*/g, '')
      .trim()

    if (HALLUCINATIONS.test(transcript)) {
      log(`Transcription timing(ms): ${JSON.stringify({ ...phaseMs, total: Date.now() - startedAt })}`)
      return { error: null, transcript: '' }
    }

    log(`Transcription timing(ms): ${JSON.stringify({ ...phaseMs, total: Date.now() - startedAt })}`)
    return { error: null, transcript: transcript || '' }
  } catch (err: any) {
    log(`Transcription error: ${err.message}`)
    log(`Transcription timing(ms): ${JSON.stringify({ ...phaseMs, total: Date.now() - startedAt, failed: true })}`)
    return {
      error: `Transcription failed: ${err.message}`,
      transcript: null,
    }
  } finally {
    try { unlinkSync(tmpWav) } catch {}
  }
})

ipcMain.handle(IPC.GET_DIAGNOSTICS, () => {
  const { readFileSync, existsSync } = require('fs')
  const health = controlPlane.getHealth()

  let recentLogs = ''
  if (existsSync(LOG_FILE)) {
    try {
      const content = readFileSync(LOG_FILE, 'utf-8')
      const lines = content.split('\n')
      recentLogs = lines.slice(-100).join('\n')
    } catch {}
  }

  return {
    health,
    logPath: LOG_FILE,
    recentLogs,
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    appVersion: app.getVersion(),
    transport: INTERACTIVE_PTY ? 'pty' : 'stream-json',
  }
})

ipcMain.handle(IPC.OPEN_IN_TERMINAL, (_event, arg: string | null | { sessionId?: string | null; projectPath?: string }) => {
  const { execFile } = require('child_process')
  const claudeBin = 'claude'

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  // Support both old (string) and new ({ sessionId, projectPath }) calling convention
  let sessionId: string | null = null
  let projectPath: string = process.cwd()
  if (typeof arg === 'string') {
    sessionId = arg
  } else if (arg && typeof arg === 'object') {
    sessionId = arg.sessionId ?? null
    projectPath = arg.projectPath && arg.projectPath !== '~' ? arg.projectPath : process.cwd()
  }

  // Validate sessionId — must be a strict UUID to prevent injection into the shell command
  if (sessionId && !UUID_RE.test(sessionId)) {
    log(`OPEN_IN_TERMINAL: rejected invalid sessionId: ${sessionId}`)
    return false
  }

  // Sanitize projectPath — reject null bytes, newlines, and non-absolute paths
  if (/[\0\r\n]/.test(projectPath) || !projectPath.startsWith('/')) {
    log(`OPEN_IN_TERMINAL: rejected invalid projectPath: ${projectPath}`)
    return false
  }

  // Shell-safe single-quote escaping: replace ' with '\'' (end quote, escaped literal quote, reopen quote)
  // Single quotes block all shell expansion ($, `, \, etc.) — unlike double quotes which allow $() and backticks
  const shellSingleQuote = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'"
  // AppleScript string escaping: backslashes doubled, double quotes escaped
  const escapeAppleScript = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

  const safeDir = escapeAppleScript(shellSingleQuote(projectPath))

  let cmd: string
  if (sessionId) {
    // sessionId is UUID-validated above, safe to embed directly
    cmd = `cd ${safeDir} && ${claudeBin} --resume ${sessionId}`
  } else {
    cmd = `cd ${safeDir} && ${claudeBin}`
  }

  const script = `tell application "Terminal"
  activate
  do script "${cmd}"
end tell`

  try {
    execFile('/usr/bin/osascript', ['-e', script], (err: Error | null) => {
      if (err) log(`Failed to open terminal: ${err.message}`)
      else log(`Opened terminal with: ${cmd}`)
    })
    return true
  } catch (err: unknown) {
    log(`Failed to open terminal: ${err}`)
    return false
  }
})

// ─── Marketplace IPC ───

ipcMain.handle(IPC.MARKETPLACE_FETCH, async (_event, { forceRefresh } = {}) => {
  log('IPC MARKETPLACE_FETCH')
  return fetchCatalog(forceRefresh)
})

ipcMain.handle(IPC.MARKETPLACE_INSTALLED, async () => {
  log('IPC MARKETPLACE_INSTALLED')
  return listInstalled()
})

ipcMain.handle(IPC.MARKETPLACE_INSTALL, async (_event, { repo, pluginName, marketplace, sourcePath, isSkillMd }: { repo: string; pluginName: string; marketplace: string; sourcePath?: string; isSkillMd?: boolean }) => {
  log(`IPC MARKETPLACE_INSTALL: ${pluginName} from ${repo} (isSkillMd=${isSkillMd})`)
  return installPlugin(repo, pluginName, marketplace, sourcePath, isSkillMd)
})

ipcMain.handle(IPC.MARKETPLACE_UNINSTALL, async (_event, { pluginName }: { pluginName: string }) => {
  log(`IPC MARKETPLACE_UNINSTALL: ${pluginName}`)
  return uninstallPlugin(pluginName)
})

// ─── Auto-updater IPC ───
// All four channels are thin pass-throughs to ./updater. We rebuild the tray
// menu on every transition so the menu label ("Check for Updates…" →
// "Downloading… 42%" → "Restart to Install vX") stays accurate even when the
// user never opens the Settings UI.
ipcMain.handle(IPC.UPDATER_CHECK, async (_event, opts: { userInitiated?: boolean } = {}) => {
  return updaterCheck(opts)
})

ipcMain.handle(IPC.UPDATER_DOWNLOAD, async () => {
  await updaterDownload()
  return updaterGetStatus()
})

ipcMain.on(IPC.UPDATER_INSTALL, () => {
  updaterInstall()
})

ipcMain.handle(IPC.UPDATER_GET_STATUS, () => {
  return updaterGetStatus()
})

// ─── Voice Orb IPC ───

// Absolute placement for the orb — used by the renderer's drag handler. Sends
// (x, y) in screen coords; we keep the size unchanged. This bypasses the
// "delta from last move" logic in START_WINDOW_DRAG so a single clamped frame
// can't lose drag progress.
function flushPendingForceListen(): void {
  if (!pendingForceListen) return
  if (!orbWindow || orbWindow.isDestroyed()) return
  pendingForceListen = false
  orbWindow.webContents.send(IPC.ORB_FORCE_LISTEN)
}

function flushPendingHoldStart(): void {
  if (!pendingHoldStart) return
  if (!orbWindow || orbWindow.isDestroyed()) return
  pendingHoldStart = false
  attachHoldKeyupListener()
  orbWindow.webContents.send(IPC.ORB_HOLD_START)
}

function attachHoldKeyupListener(): void {
  if (!orbWindow || orbWindow.isDestroyed()) return
  if (holdKeyupHandler) return
  const wc = orbWindow.webContents
  holdKeyupHandler = (_event, input) => {
    if (input.type !== 'keyUp') return
    // Releasing either component of the chord ends the hold. `code` is
    // layout-independent, so it works regardless of locale or special-char
    // bindings (Option+R produces ® on US layout, e.g.).
    if (input.code === 'KeyR' || input.code === 'AltLeft' || input.code === 'AltRight') {
      endHold()
    }
  }
  wc.on('before-input-event', holdKeyupHandler)
}

function detachHoldKeyupListener(): void {
  if (!holdKeyupHandler) return
  if (orbWindow && !orbWindow.isDestroyed()) {
    orbWindow.webContents.removeListener('before-input-event', holdKeyupHandler)
  }
  holdKeyupHandler = null
}

// Focus-independent release detector. The orb panel doesn't reliably become
// the macOS key window, so we can't depend on `before-input-event` /
// renderer DOM keyup — both require keys to be routed to the orb. Instead
// we poll the global key state via CoreGraphics in a short osascript/JXA
// child: `CGEventSourceKeyState(kCGEventSourceStateCombinedSessionState, …)`
// reads the live state of the physical keys without requiring focus or
// accessibility permission. The child blocks until either Option (kVK_Option
// = 58 / kVK_RightOption = 61) OR R (kVK_ANSI_R = 15) is released, then
// exits with sentinel "done". Phase 1 waits up to 200ms to first observe
// the chord — this absorbs the brief window where the JS already saw the
// shortcut but the key-state cache hasn't caught up; if the chord never
// appears (very brief tap, user released before osascript started), we
// fall through immediately and treat it as a release.
function startHoldKeyPoller(): void {
  if (holdKeyPoller) return
  const jxa = `
    ObjC.import("CoreGraphics");
    const SRC = 0; // kCGEventSourceStateCombinedSessionState
    const VK_R = 15, VK_OPT_L = 58, VK_OPT_R = 61;
    function bothDown() {
      const opt = $.CGEventSourceKeyState(SRC, VK_OPT_L) || $.CGEventSourceKeyState(SRC, VK_OPT_R);
      const r = $.CGEventSourceKeyState(SRC, VK_R);
      return opt && r;
    }
    let t = 0;
    while (!bothDown() && t < 0.2) { delay(0.02); t += 0.02; }
    while (bothDown()) { delay(0.03); }
    "done"
  `
  let child: ChildProcess
  try {
    child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', jxa], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch (err) {
    log(`Hold key poller spawn failed: ${(err as Error).message}`)
    return
  }
  holdKeyPoller = child
  let out = ''
  child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString() })
  child.on('exit', (code) => {
    if (holdKeyPoller !== child) return // already replaced or explicitly killed
    holdKeyPoller = null
    if (code === 0 && out.includes('done')) {
      // Defer one tick so a same-frame keyup-listener call still wins the
      // idempotency check inside endHold — keeps endHold call-paths predictable.
      setImmediate(endHold)
    } else {
      log(`Hold key poller exited unexpectedly (code=${code}); falling back to keyup listeners + watchdog`)
    }
  })
  child.on('error', (err) => {
    if (holdKeyPoller === child) holdKeyPoller = null
    log(`Hold key poller error: ${err.message}`)
  })
}

function stopHoldKeyPoller(): void {
  if (!holdKeyPoller) return
  const child = holdKeyPoller
  holdKeyPoller = null
  try { child.kill('SIGKILL') } catch {}
}

// globalShortcut on macOS fires only ONCE per press (no auto-repeat),
// so we use this single fire to enter hold mode and rely on three layered
// release detectors: the focus-independent JXA poller (authoritative), the
// `before-input-event` listener on the orb webContents (fast path when
// focus did transfer), and the renderer DOM keyup listener (backup for the
// same case). The 30s backup watchdog is the final safety net if all three
// somehow fail; it does NOT bound a normal hold duration.
function onHoldShortcutPressed(): void {
  if (holdActive) return
  holdActive = true
  // Start the focus-independent poller first — it works even when the orb
  // never gets focus or is still mounting, which is exactly the case that
  // previously left holds stranded.
  startHoldKeyPoller()
  const needsCreate = !orbWindow || orbWindow.isDestroyed()
  const isVisible = !needsCreate && orbWindow!.isVisible()
  if (needsCreate) {
    // Cold start — webContents doesn't exist yet. Buffer; flush in
    // ORB_RENDERER_READY which also attaches the keyup listener.
    pendingHoldStart = true
    showOrbWindow()
  } else if (!isVisible) {
    // Orb existed but was hidden: webContents is alive, renderer is mounted.
    // Show + focus + attach + signal in one synchronous burst.
    showOrbWindow()
    attachHoldKeyupListener()
    orbWindow!.webContents.send(IPC.ORB_HOLD_START)
  } else {
    orbWindow!.focus()
    attachHoldKeyupListener()
    orbWindow!.webContents.send(IPC.ORB_HOLD_START)
  }
  if (holdWatchdog) clearTimeout(holdWatchdog)
  holdWatchdog = setTimeout(endHold, HOLD_BACKUP_WATCHDOG_MS)
}

function endHold(): void {
  if (!holdActive) return
  holdActive = false
  if (holdWatchdog) {
    clearTimeout(holdWatchdog)
    holdWatchdog = null
  }
  detachHoldKeyupListener()
  stopHoldKeyPoller()
  if (pendingHoldStart) {
    pendingHoldStart = false
    return
  }
  if (orbWindow && !orbWindow.isDestroyed()) {
    orbWindow.webContents.send(IPC.ORB_HOLD_END)
  }
}

ipcMain.on(IPC.ORB_RENDERER_READY, () => {
  log('Orb renderer ready — flushing any pending force-listen / hold-start')
  flushPendingForceListen()
  flushPendingHoldStart()
})

// Renderer pushes its current voice state ('idle' | 'listening' | 'transcribing' |
// 'thinking' | 'talking' | 'error') on every change. Re-emit to the caption-pill
// so the pill's visibility is driven by real speaking state rather than guessing
// from task_complete + a fixed-duration hide timer (which raced TTS overhang for
// long responses and showed stale text between turns for short ones).
ipcMain.on(IPC.ORB_VOICE_STATE, (_event, state: string) => {
  if (typeof state !== 'string') return
  sendToCaptionPill({ type: 'orb_voice_state', state })
  // Also feed the controller so the autonomous-recap flush can defer when
  // the user is actively engaged with the orb (listening / transcribing /
  // thinking) instead of speaking over them.
  orb.applyVoiceState(state)
})

ipcMain.on(IPC.ORB_BUSY, (_event, busy: boolean) => {
  orbRendererBusy = !!busy
})

ipcMain.on(IPC.ORB_SET_POSITION, (_event, x: number, y: number) => {
  if (!orbWindow || orbWindow.isDestroyed()) return
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return
  const b = orbWindow.getBounds()
  const nx = Math.round(x)
  const ny = Math.round(y)
  orbWindow.setBounds({ x: nx, y: ny, width: b.width, height: b.height })
  saveOrbState({ x: nx, y: ny })
})

ipcMain.handle(IPC.ORB_RESET_SESSION, () => {
  orb.resetSession()
  // Tell pill + fullscreen so they can insert a divider into the voice
  // tab transcript (we keep history; only the orb itself loses memory).
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    if (orbWindow && win.webContents.id === orbWindow.webContents.id) continue
    win.webContents.send(IPC.ORB_RESET_BROADCAST)
  }
  return { ok: true }
})

ipcMain.handle(IPC.ORB_TTS_SPEAK, (_event, text: string) => {
  if (typeof text !== 'string') return { id: '' }
  const id = tts.speak(text)
  return { id }
})

ipcMain.handle(IPC.ORB_TTS_CANCEL, () => {
  tts.cancel()
  return { ok: true }
})

ipcMain.handle(IPC.ORB_TTS_SET_VOICE, (_event, voiceId: string) => {
  // Reject typos / stale ids loudly so the renderer dropdown can show an
  // error rather than silently leaving the orb on its old voice.
  if (typeof voiceId !== 'string' || !isValidVoice(voiceId)) {
    return { ok: false, error: `unknown voice id: ${String(voiceId).slice(0, 40)}` }
  }
  // Apply to the live manager first — that always succeeds (in-memory).
  tts.setVoice(voiceId)
  // Persistence can fail (disk full / permissions / EROFS). Surface that
  // up so the renderer can warn the user instead of silently keeping the
  // old voice on next launch.
  const persisted = savePersistedVoice(voiceId)
  if (!persisted) {
    return {
      ok: false,
      voice: voiceId,
      error: 'voice applied for this session but could not be saved to disk',
    }
  }
  return { ok: true, voice: voiceId }
})

ipcMain.handle(IPC.ORB_TTS_GET_VOICE, () => {
  // Return the live manager state, not whatever getLocalTtsConfig() would
  // recompute right now — those can disagree in dev when RAX_TTS_VOICE
  // is set AND the user has clicked a different voice in Settings.
  return { voice: tts.getCurrentVoice() }
})

ipcMain.handle(IPC.ORB_SHOW, () => {
  showOrbWindow()
  return { ok: true }
})

ipcMain.handle(IPC.ORB_HIDE, () => {
  hideOrbWindow()
  return { ok: true }
})

ipcMain.handle(IPC.ORB_TOGGLE, () => {
  toggleOrbWindow()
  return { ok: true }
})

// ─── Dock IPC ───
ipcMain.handle(IPC.DOCK_TOGGLE, () => {
  toggleDockWindow()
  return { ok: true }
})

ipcMain.handle(IPC.DOCK_SHOW, () => {
  showDockWindow()
  return { ok: true }
})

ipcMain.handle(IPC.DOCK_HIDE, () => {
  hideDockWindow()
  return { ok: true }
})

ipcMain.on(IPC.DOCK_SET_POSITION, (_event, x: number, y: number) => {
  if (!dockWindow || dockWindow.isDestroyed()) return
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  // Clamp to a sane region — don't let the dock drift fully off-screen via a
  // rogue drag. The renderer also rate-limits position updates via rAF.
  const cx = Math.round(x) + Math.round(DOCK_WINDOW_WIDTH / 2)
  const cy = Math.round(y) + Math.round(DOCK_WINDOW_HEIGHT / 2)
  const nearest = screen.getDisplayNearestPoint({ x: cx, y: cy })
  const wa = nearest.workArea
  const minX = wa.x - DOCK_WINDOW_WIDTH + 80
  const maxX = wa.x + wa.width - 80
  const minY = wa.y - DOCK_WINDOW_HEIGHT + 120
  const maxY = wa.y + wa.height - 120
  const nx = Math.max(minX, Math.min(maxX, Math.round(x)))
  const ny = Math.max(minY, Math.min(maxY, Math.round(y)))
  const b = dockWindow.getBounds()
  dockWindow.setBounds({ x: nx, y: ny, width: b.width, height: b.height })
})

ipcMain.handle(IPC.DOCK_SELECT_AGENT, (_event, agentId: string) => {
  if (typeof agentId !== 'string' || !agentId) return { ok: false }
  // Push a tab-selected mirror so the other live renderers (pill +
  // fullscreen) update their active tab in lockstep. The dock itself doesn't
  // own a session store — it just nudges the other windows to focus the
  // requested agent.
  const action: MirrorAction = { kind: 'tab-selected', tabId: agentId }
  sendMirrorTo(action)
  // Also surface the pill (or fullscreen, whichever is closer to "the chat
  // surface") so the user sees their selection take effect. If both are
  // hidden, show the pill — it's the lightweight default.
  if (fullscreenWindow && !fullscreenWindow.isDestroyed() && fullscreenWindow.isVisible()) {
    fullscreenWindow.focus()
  } else if (mainWindow && !mainWindow.isDestroyed()) {
    showWindow('dock select')
  }
  return { ok: true }
})

ipcMain.handle(IPC.ORB_SUBMIT_TURN, async (_event, prompt: string) => {
  const cleaned = typeof prompt === 'string' ? prompt.trim() : ''
  if (!cleaned) return { ok: false, error: 'empty_prompt' }
  try {
    // Run the auto-screenshot pipeline FIRST so the screenshot rides on the
    // same stream-json user message as the transcript. OrbSession emits the
    // `orb_user_attachment` event before `orb_user_turn`, which drives the
    // orb-window flash and the voice-tab chip via the existing event fanout.
    const auto = await prepareAutoCapture(cleaned, autoScreenshotDeps)
    await orb.submitTurn(cleaned, auto.attachment ?? undefined)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
})

ipcMain.handle(IPC.ORB_CANCEL_TURN, () => {
  orb.cancelTurn()
  return { ok: true }
})

// ─── Fullscreen window IPC ───

ipcMain.handle(IPC.FULLSCREEN_OPEN, () => {
  createFullscreenWindow()
  return { ok: true }
})

ipcMain.handle(IPC.FULLSCREEN_CLOSE, () => {
  closeFullscreenWindow()
  return { ok: true }
})

ipcMain.handle(IPC.FULLSCREEN_TOGGLE, () => {
  toggleFullscreenWindow()
  return { ok: true }
})

ipcMain.handle(IPC.FULLSCREEN_IS_OPEN, () => {
  return !!(fullscreenWindow && !fullscreenWindow.isDestroyed() && fullscreenWindow.isVisible())
})

// ─── Cross-renderer state mirror ───
// One renderer publishes a MirrorAction. We rebroadcast to every other
// renderer so its store can apply the same mutation. The publisher's own
// webContents is excluded so the action isn't echoed back to itself.

ipcMain.on(IPC.STATE_MIRROR_PUBLISH, (event, action: MirrorAction) => {
  sendMirrorTo(action, event.sender.id)
  // The orb's tab context registry is fed by the same actions — user messages,
  // tab titles, working directories, etc. — so it can answer "what's tab 2 doing?"
  // without round-tripping back to a renderer.
  orb.applyMirrorAction(action)
})

// Snapshot push — the renderer that's about to be hidden ships its full
// session state to main so the next renderer to open can seed itself.
// A long-lived app would otherwise pin a snapshot indefinitely; TTL of 10
// minutes balances "user reopens fullscreen mid-task" against memory waste
// when neither surface has been touched in a while.
const SNAPSHOT_TTL_MS = 10 * 60 * 1000
let snapshotExpiryTimer: NodeJS.Timeout | null = null
function scheduleSnapshotExpiry(): void {
  if (snapshotExpiryTimer) clearTimeout(snapshotExpiryTimer)
  snapshotExpiryTimer = setTimeout(() => {
    lastSessionSnapshot = null
    snapshotExpiryTimer = null
  }, SNAPSHOT_TTL_MS)
}
ipcMain.on(IPC.STATE_SNAPSHOT_PUSH, (_event, snapshot: SessionSnapshot) => {
  if (!snapshot || !Array.isArray(snapshot.tabs)) return
  lastSessionSnapshot = snapshot
  scheduleSnapshotExpiry()
  // Also seed the orb's tab context so a freshly-summoned orb sees what the
  // pill knows about, including titles and last messages from before it started.
  orb.tabContext.applySessionSnapshot({ tabs: snapshot.tabs as Array<{ id: string; title: string; workingDirectory: string; status: string; claudeSessionId: string | null }> })
})

app.on('before-quit', () => {
  if (snapshotExpiryTimer) clearTimeout(snapshotExpiryTimer)
  lastSessionSnapshot = null
})

ipcMain.handle(IPC.STATE_SNAPSHOT_PULL, () => {
  return lastSessionSnapshot
})

// ─── Claude Instance (bundled vs system) ───

function buildInstanceInfo() {
  const instance = getActiveInstance()
  const version = instance.available ? execClaudeSync(['-v']) : null

  let auth: import('../shared/types').ClaudeInstanceInfo['auth'] = null
  if (instance.available) {
    const raw = execClaudeSync(['auth', 'status'])
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as {
          loggedIn?: boolean
          email?: string
          subscriptionType?: string
          authMethod?: string
          apiProvider?: string
        }
        const signedIn =
          typeof parsed.loggedIn === 'boolean'
            ? parsed.loggedIn
            : !!(parsed.email || (parsed.authMethod && parsed.authMethod !== 'none'))
        auth = {
          signedIn,
          email: parsed.email,
          subscriptionType: parsed.subscriptionType,
          authMethod: parsed.authMethod,
          apiProvider: parsed.apiProvider,
        }
      } catch {
        // Non-JSON output — fall back to a heuristic.
        const signedIn = !/\bnot signed in\b|\bno credentials\b/i.test(raw)
        auth = { signedIn }
      }
    }
  }

  let mcpServers: string[] = []
  if (instance.available) {
    const raw = execClaudeSync(['mcp', 'list'])
    if (raw) mcpServers = raw.split('\n').filter(Boolean)
  }

  return {
    mode: instance.mode,
    label: instance.label,
    homeDescription: instance.homeDescription,
    binaryPath: instance.binaryPath,
    available: instance.available,
    unavailableReason: instance.unavailableReason ?? null,
    version,
    auth,
    mcpServers,
  }
}

ipcMain.handle(IPC.CLAUDE_MODE_GET, () => getClaudeMode())

ipcMain.handle(IPC.CLAUDE_MODE_INFO, () => buildInstanceInfo())

ipcMain.handle(IPC.CLAUDE_MODE_SET, async (_event, mode: ClaudeMode) => {
  log(`IPC CLAUDE_MODE_SET → ${mode}`)
  setClaudeMode(mode)

  // Couple the binary-pick chip with the proxy toggle so the obvious
  // user mental model just works: "Rax's" implies "use Rax credits",
  // "Default" implies "use my own Anthropic / claude.ai login". Power
  // users can still flip them independently from the Rax cloud panel.
  const status = await raxAuth.getStatus()
  if (mode === 'system' && status.enabled) {
    log('[mode-couple] system mode → disabling Rax proxy')
    await raxAuth.setEnabled(false)
  } else if (mode === 'bundled' && status.signedIn && !status.enabled) {
    log('[mode-couple] bundled mode → enabling Rax proxy')
    await raxAuth.setEnabled(true)
  }

  return buildInstanceInfo()
})

onClaudeModeChange(() => {
  const info = buildInstanceInfo()
  log(`Broadcasting CLAUDE_MODE_CHANGED: ${info.mode} (available=${info.available})`)
  broadcast(IPC.CLAUDE_MODE_CHANGED, info)
})

// ── Rax cloud auth ─────────────────────────────────────────────────────────
// Manages the locally-stored rax_sk_… key used by the proxy at rax-ai.com.
// The actual env-injection happens in buildClaudeEnv (claude-instance.ts).

ipcMain.handle(IPC.RAX_AUTH_STATUS, async () => raxAuth.getStatus())

ipcMain.handle(IPC.RAX_AUTH_SIGN_IN, async () => {
  log('IPC RAX_AUTH_SIGN_IN — opening loopback OAuth')
  return raxAuth.signIn()
})

ipcMain.handle(IPC.RAX_AUTH_SIGN_OUT, async () => {
  await raxAuth.signOut()
  return raxAuth.getStatus()
})

ipcMain.handle(IPC.RAX_AUTH_SET_ENABLED, async (_event, enabled: boolean) => {
  await raxAuth.setEnabled(!!enabled)
  return raxAuth.getStatus()
})

ipcMain.handle(IPC.RAX_AUTH_FETCH_ACCOUNT, async () => raxAuth.fetchAccount())

raxAuth.onChange(async () => {
  const status = await raxAuth.getStatus()
  log(`Broadcasting RAX_AUTH_CHANGED: enabled=${status.enabled} signedIn=${status.signedIn}`)
  broadcast(IPC.RAX_AUTH_CHANGED, status)
})

ipcMain.handle(IPC.ONBOARDING_GET, async () => onboarding.getState())
ipcMain.handle(IPC.ONBOARDING_COMPLETE, async (_e, choice: 'rax' | 'own-claude' | 'skip') => {
  return onboarding.complete(choice)
})

// ── Login flow ─────────────────────────────────────────────────────────────
// Single in-flight login process. Spawns the active instance's claude with
// `login`, streams stdout/stderr to the renderer, detects browser URLs so the
// renderer can auto-open them, and signals exit + auth status.
let activeLoginChild: ChildProcess | null = null

ipcMain.handle(IPC.CLAUDE_LOGIN_START, (event) => {
  if (activeLoginChild && activeLoginChild.exitCode === null) {
    log('CLAUDE_LOGIN_START rejected — login already in flight')
    return { ok: false, error: 'A sign-in is already in progress.' }
  }

  let invocation: ReturnType<typeof buildClaudeSpawnInvocation>
  try {
    invocation = buildClaudeSpawnInvocation(['login'])
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }

  const senderWebContents = event.sender
  const send = (payload: import('../shared/types').ClaudeLoginEvent) => {
    if (!senderWebContents.isDestroyed()) {
      senderWebContents.send(IPC.CLAUDE_LOGIN_EVENT, payload)
    }
  }

  log(`Spawning login: ${invocation.command} ${invocation.args.join(' ')}`)
  const child = spawn(invocation.command, invocation.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: buildClaudeEnv(),
  })
  activeLoginChild = child

  // Open each OAuth URL exactly once — `claude login` re-prints it in
  // every status line and we don't want to spam the browser with tabs.
  const openedUrls = new Set<string>()
  const handleChunk = (data: Buffer) => {
    const text = data.toString('utf-8')
    send({ kind: 'output', text })
    const urlMatch = text.match(/https?:\/\/[\w./?=&%#:+\-~]+/g)
    if (urlMatch) {
      for (const url of urlMatch) {
        if (!/console\.anthropic\.com|claude\.ai|auth/i.test(url)) continue
        send({ kind: 'url', url })
        // Open in the user's default browser ourselves — the welcome
        // window may have closed by the time the URL arrives, and we
        // can't rely on a renderer being subscribed.
        if (!openedUrls.has(url)) {
          openedUrls.add(url)
          shell.openExternal(url).catch((err) =>
            log(`Failed to open login URL ${url}: ${(err as Error).message}`),
          )
        }
      }
    }
  }

  child.stdout?.on('data', handleChunk)
  child.stderr?.on('data', handleChunk)

  child.on('error', (err) => {
    log(`Login error: ${err.message}`)
    send({ kind: 'error', message: err.message })
  })

  child.on('close', (code) => {
    log(`Login process exited with code ${code}`)
    activeLoginChild = null

    // Verify by re-running auth status against the active instance.
    // `claude` sometimes writes its credentials file a beat after the
    // OAuth callback resolves, so check, then retry once after 800 ms
    // if the first read still says "not signed in" but the exit code
    // was 0 (which suggests success).
    const probe = (): boolean => {
      const raw = execClaudeSync(['auth', 'status'])
      if (!raw) return false
      try {
        const parsed = JSON.parse(raw)
        if (typeof parsed?.loggedIn === 'boolean') return parsed.loggedIn
        return !!(parsed?.email || (parsed?.authMethod && parsed.authMethod !== 'none'))
      } catch {
        return raw.trim().length > 0 && !/\bnot signed in\b|\bno credentials\b/i.test(raw)
      }
    }

    const finalize = (signedIn: boolean) => {
      log(`Login finalize: code=${code} signedIn=${signedIn}`)
      send({ kind: 'exit', code, signedIn })
      broadcast(IPC.CLAUDE_MODE_CHANGED, buildInstanceInfo())
    }

    const initial = probe()
    if (initial || code !== 0) {
      finalize(initial)
    } else {
      // Exit 0 but auth status says no — almost certainly a race. Retry.
      setTimeout(() => finalize(probe()), 800)
    }
  })

  return { ok: true }
})

ipcMain.handle(IPC.CLAUDE_LOGIN_CANCEL, () => {
  if (!activeLoginChild || activeLoginChild.exitCode !== null) return { ok: false }
  log('Cancelling in-flight login')
  try { activeLoginChild.kill('SIGTERM') } catch {}
  return { ok: true }
})

// ─── Theme Detection ───

ipcMain.handle(IPC.GET_THEME, () => {
  return { isDark: nativeTheme.shouldUseDarkColors }
})

nativeTheme.on('updated', () => {
  broadcast(IPC.THEME_CHANGED, nativeTheme.shouldUseDarkColors)
})

// ─── Permission Preflight ───
// Request all required macOS permissions upfront on first launch so the user
// is never interrupted mid-session by a permission prompt.

async function requestPermissions(): Promise<void> {
  if (process.platform !== 'darwin') return

  // ── Microphone (for voice input via Whisper) ──
  try {
    const micStatus = systemPreferences.getMediaAccessStatus('microphone')
    if (micStatus === 'not-determined') {
      await systemPreferences.askForMediaAccess('microphone')
    }
  } catch (err: any) {
    log(`Permission preflight: microphone check failed — ${err.message}`)
  }

  // ── Accessibility (REQUIRED for global keyboard shortcuts) ──
  // Despite the older comment claiming globalShortcut works without it on
  // modern macOS — that's only true for the unsigned dev binary, which
  // most macOS versions silently trust. The signed DMG-installed binary
  // at `/Applications/Rax.app` is a fresh identity in macOS's eyes:
  // `globalShortcut.register('Cmd+Shift+O', ...)` returns true, but
  // events are never delivered until the user adds the app to Privacy
  // & Security → Accessibility. The user has no way of knowing this
  // unless we tell them.
  //
  // `ensureAccessibilityOnStartup` does NOT block — it kicks off the
  // native macOS prompt + an Electron dialog + a 1.5s poller that
  // detects when the user toggles the switch. Startup proceeds; the
  // already-registered shortcuts start firing the moment the toggle
  // flips on, no relaunch needed.
  ensureAccessibilityOnStartup()

  // Screen Recording: not requested upfront — macOS 15 Sequoia shows an alarming
  // "bypass private window picker" dialog. Let the OS prompt naturally if/when
  // the screenshot feature is actually used.
}

// ─── App Lifecycle ───

app.whenReady().then(async () => {
  // macOS: become an accessory app. Accessory apps can have key windows (keyboard works)
  // without deactivating the currently active app (hover preserved in browsers).
  // This is how Spotlight, Alfred, Raycast work.
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide()
  }

  // Sweep any orb temp files left behind by a previous launch that crashed
  // before shutdown(). Best-effort.
  sweepStaleOrbTempFiles()
  sweepStaleTabMcpFiles()

  // Request permissions upfront so the user is never interrupted mid-session.
  await requestPermissions()

  installContentSecurityPolicy()

  // Skill provisioning — non-blocking, streams status to renderer
  ensureSkills((status: SkillStatus) => {
    log(`Skill ${status.name}: ${status.state}${status.error ? ` — ${status.error}` : ''}`)
    broadcast(IPC.SKILL_STATUS, status)
  }).catch((err: Error) => log(`Skill provisioning error: ${err.message}`))

  // Reconcile claude-mode + rax-proxy state. Earlier builds let these two
  // drift (you could be on system Claude but still routing through the
  // Rax proxy → mystery 402s). Treat the chip as the source of truth:
  // mode=system implies proxy off; mode=bundled with a key implies on.
  const currentInstance = getActiveInstance()
  const raxStatusBoot = await raxAuth.getStatus()
  if (currentInstance.mode === 'system' && raxStatusBoot.enabled) {
    log('[boot-reconcile] system Claude + Rax proxy on — disabling proxy')
    await raxAuth.setEnabled(false)
  }

  // Decide whether to launch into the pill directly or into the welcome
  // window. We defer creating the pill at all until onboarding is done —
  // that way a brand-new user sees ONLY the welcome until they finish
  // and click "Launch Rax".
  const ob = await onboarding.getState()
  log(`[welcome-gate] onboarding.completed=${ob.completed}`)
  if (!ob.completed) {
    log('[welcome-gate] opening welcome window (pill deferred)')
    createWelcomeWindow()
  } else {
    createWindow()
    snapshotWindowState('after createWindow')
    // Boot the agent dock alongside the pill. The dock honours its saved
    // visible flag, so users who explicitly hid it last session don't get
    // ambushed by a re-show.
    createDockWindow()
  }

  if (SPACES_DEBUG) {
    mainWindow?.on('show', () => snapshotWindowState('event window show'))
    mainWindow?.on('hide', () => snapshotWindowState('event window hide'))
    mainWindow?.on('focus', () => snapshotWindowState('event window focus'))
    mainWindow?.on('blur', () => snapshotWindowState('event window blur'))
    mainWindow?.webContents.on('focus', () => snapshotWindowState('event webContents focus'))
    mainWindow?.webContents.on('blur', () => snapshotWindowState('event webContents blur'))

    app.on('browser-window-focus', () => snapshotWindowState('event app browser-window-focus'))
    app.on('browser-window-blur', () => snapshotWindowState('event app browser-window-blur'))

    screen.on('display-added', (_e, display) => {
      log(`[spaces] event display-added id=${display.id}`)
      snapshotWindowState('event display-added')
    })
    screen.on('display-removed', (_e, display) => {
      log(`[spaces] event display-removed id=${display.id}`)
      snapshotWindowState('event display-removed')
    })
    screen.on('display-metrics-changed', (_e, display, changedMetrics) => {
      log(`[spaces] event display-metrics-changed id=${display.id} changed=${changedMetrics.join(',')}`)
      snapshotWindowState('event display-metrics-changed')
    })
  }

  // Orb persistence — re-assert always-on-top + all-spaces visibility on every
  // display reconfig and on every focus change. macOS occasionally drops the
  // panel level when another app goes fullscreen or when displays are
  // hot-plugged; without this the orb can sink behind the new key window.
  // Also clamps the orb back into a visible display if its saved position
  // falls off-screen (e.g. external monitor unplugged).
  screen.on('display-added', () => {
    reassertOrbVisibility('display-added')
    rescueOrbPositionIfOffscreen()
    repositionCaptionPillWindow()
    reassertDockVisibility('display-added')
  })
  screen.on('display-removed', () => {
    reassertOrbVisibility('display-removed')
    rescueOrbPositionIfOffscreen()
    repositionCaptionPillWindow()
    reassertDockVisibility('display-removed')
  })
  screen.on('display-metrics-changed', () => {
    reassertOrbVisibility('display-metrics-changed')
    rescueOrbPositionIfOffscreen()
    repositionCaptionPillWindow()
    reassertDockVisibility('display-metrics-changed')
  })
  app.on('browser-window-focus', () => {
    reassertOrbVisibility('browser-window-focus')
    reassertDockVisibility('browser-window-focus')
  })


  // Primary: Option+Space (2 keys, doesn't conflict with shell)
  // Fallback: Cmd+Shift+K kept as secondary shortcut
  const registered = globalShortcut.register('Alt+Space', () => toggleWindow('shortcut Alt+Space'))
  if (!registered) {
    log('Alt+Space shortcut registration failed — macOS input sources may claim it')
  }
  globalShortcut.register('CommandOrControl+Shift+K', () => toggleWindow('shortcut Cmd/Ctrl+Shift+K'))
  // Fullscreen window — Cmd+Shift+F
  globalShortcut.register('CommandOrControl+Shift+F', () => toggleFullscreenWindow())
  // Voice orb — Cmd+Shift+O (Siri-style summon)
  globalShortcut.register('CommandOrControl+Shift+O', () => toggleOrbWindow())
  // Agent dock — Cmd+Shift+D (toggle the vertical dock on the left edge)
  globalShortcut.register('CommandOrControl+Shift+D', () => toggleDockWindow())
  // Push-to-talk: summon the orb (if hidden) AND immediately start listening.
  // We mark the intent and let the renderer flush it once it has wired its
  // listener (`ORB_RENDERER_READY`). Previously we relied on a 220ms timeout
  // which dropped the message during slow renderer mounts (dev hot-reload,
  // post-crash respawns).
  globalShortcut.register('CommandOrControl+Shift+;', () => {
    pendingForceListen = true
    if (!orbWindow || orbWindow.isDestroyed() || !orbWindow.isVisible()) {
      showOrbWindow()
      // ORB_RENDERER_READY will fire once mount completes; no timeout needed.
    } else {
      // Already visible — try to flush immediately. If the renderer has
      // already ready'd this still works because we send synchronously.
      flushPendingForceListen()
    }
  })
  // Hold-to-speak: Option+R held → orb listens; release → submits.
  // globalShortcut fires once on press; release is detected via
  // `before-input-event` on the orb webContents. See onHoldShortcutPressed.
  const holdRegistered = globalShortcut.register('Alt+R', onHoldShortcutPressed)
  if (!holdRegistered) {
    log('Alt+R hold-to-speak shortcut registration failed — another app may have claimed it')
  }

  const trayIconPath = join(__dirname, '../../resources/trayTemplate.png')
  const trayIcon = nativeImage.createFromPath(trayIconPath)
  trayIcon.setTemplateImage(true)
  tray = new Tray(trayIcon)
  tray.setToolTip('Rax — Claude Code UI')
  tray.on('click', () => toggleWindow('tray click'))

  // Wire the auto-updater. Safe to call before any tray/menu work — the
  // module no-ops cleanly in dev (`!app.isPackaged`) and only attaches its
  // background timers when there's a real installed app to upgrade.
  // We wrap `broadcast` so every UPDATER_STATUS push also rebuilds the tray
  // menu — the label needs to reflect the current phase ("Check for
  // updates" → "Downloading 42%" → "Restart to Install v…").
  initUpdater((channel, ...args) => {
    broadcast(channel, ...args)
    if (channel === IPC.UPDATER_STATUS) {
      try { rebuildTrayMenu() } catch {}
    }
  })
  trayContextMenuFactory = () => {
    const updaterStatus = updaterGetStatus()
    const updaterLabel = (() => {
      switch (updaterStatus.phase) {
        case 'checking': return 'Checking for Updates…'
        case 'available': return `Download Rax v${updaterStatus.availableVersion}…`
        case 'downloading': {
          const pct = Math.round(updaterStatus.downloadPercent ?? 0)
          return `Downloading update… ${pct}%`
        }
        case 'downloaded': return `Restart to Install v${updaterStatus.availableVersion}`
        case 'unsupported': return 'Check for Updates (unavailable)'
        default: return 'Check for Updates…'
      }
    })()
    return Menu.buildFromTemplate([
      { label: 'Show Rax', click: () => showWindow('tray menu') },
      {
        label: fullscreenWindow && !fullscreenWindow.isDestroyed() ? 'Close Window' : 'Open Window',
        accelerator: 'CommandOrControl+Shift+F',
        click: () => toggleFullscreenWindow(),
      },
      {
        label: orbWindow && !orbWindow.isDestroyed() && orbWindow.isVisible() ? 'Hide Voice Orb' : 'Summon Voice Orb',
        accelerator: 'CommandOrControl+Shift+O',
        click: () => toggleOrbWindow(),
      },
      {
        label: dockWindow && !dockWindow.isDestroyed() && dockWindow.isVisible() ? 'Hide Agent Dock' : 'Show Agent Dock',
        accelerator: 'CommandOrControl+Shift+D',
        click: () => toggleDockWindow(),
      },
      { type: 'separator' },
      {
        label: updaterLabel,
        enabled: updaterStatus.phase !== 'unsupported' && updaterStatus.phase !== 'checking' && updaterStatus.phase !== 'downloading',
        click: () => {
          if (updaterStatus.phase === 'downloaded') {
            updaterInstall()
          } else if (updaterStatus.phase === 'available') {
            void updaterDownload()
          } else {
            void updaterCheck({ userInitiated: true })
          }
        },
      },
      // Permissions row — shows a checkmark when Accessibility is granted
      // and a warning glyph when it isn't (silently broken shortcuts).
      // Clicking either takes the user to the right Settings pane.
      ...(process.platform === 'darwin' ? [
        { type: 'separator' as const },
        isAccessibilityGranted()
          ? {
              label: '✓ Keyboard shortcuts: enabled',
              enabled: false,
            }
          : {
              label: '⚠︎ Grant Accessibility…',
              click: () => recheckAccessibilityAndPrompt(),
            },
      ] : []),
      { type: 'separator' },
      { label: 'Quit', click: () => { app.quit() } },
    ])
  }
  tray.setContextMenu(trayContextMenuFactory())

  // app 'activate' fires when macOS brings the app to the foreground (e.g. after
  // webContents.focus() triggers applicationDidBecomeActive on some macOS versions).
  // Using showWindow here instead of toggleWindow prevents the re-entry race where
  // a summon immediately hides itself because activate fires mid-show.
  app.on('activate', () => {
    // Dock icon click — if a fullscreen window already exists, just bring it
    // forward. Otherwise default behavior: summon the pill.
    if (fullscreenWindow && !fullscreenWindow.isDestroyed()) {
      if (!fullscreenWindow.isVisible()) fullscreenWindow.show()
      fullscreenWindow.focus()
      return
    }
    showWindow('app activate')
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  stopHoldKeyPoller()
  tts.shutdown()
  orb.shutdown()
  whisperDaemon.shutdown()
  controlPlane.shutdown()
  codeMode.shutdown()
  flushLogs()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
