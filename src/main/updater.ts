// Auto-update controller for Rax.
//
// Wraps `electron-updater`'s autoUpdater so the rest of the app can drive
// update checks through a small, typed surface. Status is broadcast over the
// `IPC.UPDATER_STATUS` channel so the Software Update window and the Settings
// "Check for updates" row can render progress without polling. All user-facing
// decisions (download? restart?) happen in the Software Update window — this
// module never opens native dialogs.
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

import { app, BrowserWindow } from 'electron'
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
/** Opens (or focuses) the dedicated Software Update window. Injected by
 *  index.ts at init so this module stays free of window-management code. */
let openUpdateWindowFn: () => void = () => {}
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

export function initUpdater(
  broadcast: (channel: string, ...args: unknown[]) => void,
  openUpdateWindow?: () => void,
): void {
  if (initialized) return
  initialized = true
  broadcastFn = broadcast
  if (openUpdateWindow) openUpdateWindowFn = openUpdateWindow

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
    // restart prompt when ready. User-initiated checks: open the Software
    // Update window so they can read the notes and choose.
    if (!currentCheckUserInitiated) {
      void downloadUpdate().catch((err) => {
        log(`auto-download failed: ${(err as Error).message}`)
      })
      return
    }
    openUpdateWindowFn()
  })

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    log(`no update available (latest: v${info.version})`)
    setStatus({
      phase: 'not-available',
      availableVersion: info.version,
      error: undefined,
    })
    // No dialog: the Software Update window / Settings row render the
    // "up to date" state inline wherever the check was started from.
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
      releaseUrl: releaseUrlFor(info.version),
      downloadPercent: 100,
    })
    // Surface the "restart to install" decision in the Software Update
    // window — for background downloads this is the first thing the user
    // sees about the update.
    openUpdateWindowFn()
  })

  autoUpdater.on('error', (err: Error) => {
    const message = err?.message || String(err)
    log(`updater error: ${message}`)
    setStatus({ phase: 'error', error: message })
    // Errors render inline in the Software Update window / Settings row;
    // background-check errors stay silent (next scheduled check retries).
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
    return cachedStatus
  }
  currentCheckUserInitiated = !!opts.userInitiated
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    const message = (err as Error)?.message || String(err)
    log(`checkForUpdates threw: ${message}`)
    setStatus({ phase: 'error', error: message })
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

/**
 * Strip every window's hide-on-close guard before installing.
 *
 * On macOS the native Squirrel quitAndInstall closes all windows FIRST and
 * only calls app.quit() once they're gone — so `before-quit` has not fired
 * yet, and any close handler that preventDefaults (the pill hides instead
 * of closing) silently deadlocks the install. Exported so the dev-mode
 * regression harness in index.ts can exercise the same path.
 */
export function prepareWindowsForUpdateInstall(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.removeAllListeners('close')
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
      prepareWindowsForUpdateInstall()
      autoUpdater.quitAndInstall(false, true)
    } catch (err) {
      log(`quitAndInstall threw: ${(err as Error).message}`)
    }
  })
}
