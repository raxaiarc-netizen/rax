// Auto-update controller for Rax.
//
// Wraps `electron-updater`'s autoUpdater so the rest of the app can drive
// update checks through a small, typed surface. Status is broadcast over the
// `IPC.UPDATER_STATUS` channel so the Settings "Check for updates" UI can
// render progress without polling.
//
// Distribution provider is configured via `build.publish` in package.json
// (GitHub releases). The autoUpdater reads `latest-mac.yml` from the release
// to learn the available version + the signed update artifact URL.
//
// macOS gotchas:
//   - autoUpdater only works for installed signed builds. In `npm run dev`
//     and inside an unsigned ad-hoc build it throws "Could not get code
//     signature" or "Application is not signed" — we catch and surface a
//     polite error.
//   - The download payload is the .zip (NOT the .dmg). electron-builder
//     produces both; the .zip's `latest-mac.yml` entry is what gets
//     downloaded and unpacked into the running .app.

import { app, BrowserWindow, dialog, shell } from 'electron'
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import { log as _log } from './logger'
import { IPC } from '../shared/types'

function log(msg: string): void {
  _log('updater', msg)
}

export type UpdaterPhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'unsupported'

export interface UpdaterStatus {
  phase: UpdaterPhase
  currentVersion: string
  availableVersion?: string
  releaseNotes?: string
  releaseUrl?: string
  downloadPercent?: number
  bytesPerSecond?: number
  transferred?: number
  total?: number
  error?: string
  /** Was the most recent check initiated by the user (vs. background)? */
  userInitiated?: boolean
}

let cachedStatus: UpdaterStatus = {
  phase: 'idle',
  currentVersion: app.getVersion(),
}

let broadcastFn: (channel: string, ...args: unknown[]) => void = () => {}
let currentCheckUserInitiated = false
let initialized = false

function setStatus(patch: Partial<UpdaterStatus>): void {
  cachedStatus = { ...cachedStatus, ...patch, currentVersion: app.getVersion() }
  try {
    broadcastFn(IPC.UPDATER_STATUS, cachedStatus)
  } catch (err) {
    log(`broadcast failed: ${(err as Error).message}`)
  }
}

function isUpdaterSupported(): { ok: true } | { ok: false; reason: string } {
  if (!app.isPackaged) {
    return { ok: false, reason: 'Auto-update only runs in a packaged build (current process is in dev mode).' }
  }
  if (process.platform !== 'darwin' && process.platform !== 'win32' && process.platform !== 'linux') {
    return { ok: false, reason: `Unsupported platform: ${process.platform}` }
  }
  return { ok: true }
}

function releaseUrlFor(version: string): string {
  return `https://github.com/raxaiarc-netizen/rax/releases/tag/v${version}`
}

export function getStatus(): UpdaterStatus {
  return cachedStatus
}

export function initUpdater(broadcast: (channel: string, ...args: unknown[]) => void): void {
  if (initialized) return
  initialized = true
  broadcastFn = broadcast

  const support = isUpdaterSupported()
  if (!support.ok) {
    log(`updater disabled — ${support.reason}`)
    setStatus({ phase: 'unsupported', error: support.reason })
    return
  }

  // We drive download + install explicitly from the UI / dialog confirmation
  // so the user is never surprised by an in-place upgrade.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowDowngrade = false
  // electron-log integration is optional; route the updater's logs into the
  // existing rax logger so they show up in the same file.
  autoUpdater.logger = {
    info: (m: unknown) => log(`info: ${String(m)}`),
    warn: (m: unknown) => log(`warn: ${String(m)}`),
    error: (m: unknown) => log(`error: ${String(m)}`),
    debug: (m: unknown) => log(`debug: ${String(m)}`),
  } as unknown as typeof autoUpdater.logger

  autoUpdater.on('checking-for-update', () => {
    log('checking for update')
    setStatus({ phase: 'checking', error: undefined, userInitiated: currentCheckUserInitiated })
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    log(`update available: v${info.version}`)
    setStatus({
      phase: 'available',
      availableVersion: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
      releaseUrl: releaseUrlFor(info.version),
      error: undefined,
    })

    // Background checks: auto-start the download so the user just gets a
    // restart prompt when ready. User-initiated checks: prompt first so they
    // know what's happening.
    if (!currentCheckUserInitiated) {
      void downloadUpdate().catch((err) => {
        log(`auto-download failed: ${(err as Error).message}`)
      })
      return
    }
    void promptUserForDownload(info)
  })

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    log(`no update available (latest: v${info.version})`)
    setStatus({
      phase: 'not-available',
      availableVersion: info.version,
      error: undefined,
    })
    if (currentCheckUserInitiated) {
      void dialog.showMessageBox({
        type: 'info',
        title: 'Rax is up to date',
        message: `You're running the latest version (v${app.getVersion()}).`,
        buttons: ['OK'],
      })
    }
  })

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    setStatus({
      phase: 'downloading',
      downloadPercent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    })
  })

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    log(`update downloaded: v${info.version}`)
    setStatus({
      phase: 'downloaded',
      availableVersion: info.version,
      downloadPercent: 100,
    })
    void promptUserForInstall(info)
  })

  autoUpdater.on('error', (err: Error) => {
    const message = err?.message || String(err)
    log(`updater error: ${message}`)
    setStatus({ phase: 'error', error: message })
    if (currentCheckUserInitiated) {
      void dialog.showMessageBox({
        type: 'error',
        title: 'Update check failed',
        message: 'Could not check for updates.',
        detail: message,
        buttons: ['OK'],
      })
    }
  })

  log(`updater initialized — current v${app.getVersion()}`)

  // Background check on startup, then again every 6 hours while the app is
  // open. Delay the first check 30s so it doesn't compete with the warm-up
  // work (claude spawn, whisper daemon, dock window).
  setTimeout(() => {
    void checkForUpdates({ userInitiated: false }).catch((err) => {
      log(`startup check failed: ${(err as Error).message}`)
    })
  }, 30_000).unref?.()

  const SIX_HOURS_MS = 6 * 60 * 60 * 1000
  setInterval(() => {
    void checkForUpdates({ userInitiated: false }).catch((err) => {
      log(`periodic check failed: ${(err as Error).message}`)
    })
  }, SIX_HOURS_MS).unref?.()
}

export async function checkForUpdates(
  opts: { userInitiated?: boolean } = {},
): Promise<UpdaterStatus> {
  const support = isUpdaterSupported()
  if (!support.ok) {
    setStatus({ phase: 'unsupported', error: support.reason })
    if (opts.userInitiated) {
      void dialog.showMessageBox({
        type: 'info',
        title: 'Auto-update unavailable',
        message: 'Auto-update is not available in this build.',
        detail: support.reason,
        buttons: ['OK'],
      })
    }
    return cachedStatus
  }
  currentCheckUserInitiated = !!opts.userInitiated
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    const message = (err as Error)?.message || String(err)
    log(`checkForUpdates threw: ${message}`)
    setStatus({ phase: 'error', error: message })
    if (opts.userInitiated) {
      void dialog.showMessageBox({
        type: 'error',
        title: 'Update check failed',
        message: 'Could not reach the update server.',
        detail: message,
        buttons: ['OK'],
      })
    }
  }
  return cachedStatus
}

export async function downloadUpdate(): Promise<void> {
  const support = isUpdaterSupported()
  if (!support.ok) return
  try {
    await autoUpdater.downloadUpdate()
  } catch (err) {
    const message = (err as Error)?.message || String(err)
    log(`downloadUpdate threw: ${message}`)
    setStatus({ phase: 'error', error: message })
  }
}

export function installUpdate(): void {
  const support = isUpdaterSupported()
  if (!support.ok) return
  // isSilent=false (show progress UI), isForceRunAfter=true (relaunch).
  // quitAndInstall() must be called from the main process — it terminates the
  // current app, runs the installer, then relaunches.
  setImmediate(() => {
    try {
      autoUpdater.quitAndInstall(false, true)
    } catch (err) {
      log(`quitAndInstall threw: ${(err as Error).message}`)
    }
  })
}

async function promptUserForDownload(info: UpdateInfo): Promise<void> {
  const focusedWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const result = await dialog.showMessageBox(focusedWindow ?? undefined as unknown as BrowserWindow, {
    type: 'info',
    title: 'Update available',
    message: `Rax v${info.version} is available`,
    detail: `You're on v${app.getVersion()}. Download in the background and install on next quit?`,
    buttons: ['Download', 'View release notes', 'Later'],
    defaultId: 0,
    cancelId: 2,
  })
  if (result.response === 0) {
    void downloadUpdate()
  } else if (result.response === 1) {
    void shell.openExternal(releaseUrlFor(info.version))
  }
}

async function promptUserForInstall(info: UpdateInfo): Promise<void> {
  const focusedWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const result = await dialog.showMessageBox(focusedWindow ?? undefined as unknown as BrowserWindow, {
    type: 'info',
    title: 'Update ready to install',
    message: `Rax v${info.version} downloaded`,
    detail: 'Restart now to apply the update? Your in-progress sessions will be reloaded.',
    buttons: ['Restart now', 'Install on quit'],
    defaultId: 0,
    cancelId: 1,
  })
  if (result.response === 0) {
    installUpdate()
  }
}
