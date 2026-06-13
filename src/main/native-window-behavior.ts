// Loader for the mac window-behavior native addon (see
// native/mac-window-behavior.mm). Gives overlay windows the
// NSWindowCollectionBehaviorStationary flag so they stay on screen during
// Mission Control — the one collection behavior Electron doesn't expose.
//
// Deliberately failure-tolerant: if the .node is missing (non-mac, dev tree
// without a vendor run, stripped build) every call returns false and callers
// fall back to setHiddenInMissionControl(true), restoring the previous
// behavior exactly.

import { createRequire } from 'module'
import { join } from 'path'
import { app } from 'electron'
import type { BrowserWindow } from 'electron'

type WindowBehaviorAddon = {
  makeStationary(handle: Buffer): boolean
  pinToSpace(handle: Buffer): boolean
}

const nodeRequire = createRequire(__filename)

// undefined = not yet attempted, null = attempted and unavailable.
let addon: WindowBehaviorAddon | null | undefined
let loadFailureLogged = false

function loadAddon(): WindowBehaviorAddon | null {
  if (addon !== undefined) return addon
  addon = null
  if (process.platform !== 'darwin') return addon
  const path = app.isPackaged
    ? join(process.resourcesPath, 'native', 'mac-window-behavior.node')
    : join(app.getAppPath(), 'resources', 'native', 'mac-window-behavior.node')
  try {
    addon = nodeRequire(path) as WindowBehaviorAddon
  } catch (err) {
    if (!loadFailureLogged) {
      loadFailureLogged = true
      console.warn(
        `[native-window-behavior] addon unavailable (${(err as Error).message}); ` +
          'falling back to hiddenInMissionControl'
      )
    }
  }
  return addon
}

/** Pin `win` on screen through Mission Control / Exposé (stationary +
 *  join-all-Spaces + fullscreen-auxiliary). Returns false when the native
 *  addon isn't available — caller should fall back to transient. */
export function applyStationaryOverlay(win: BrowserWindow): boolean {
  const a = loadAddon()
  if (!a) return false
  try {
    return a.makeStationary(win.getNativeWindowHandle())
  } catch {
    return false
  }
}

/** Move `win` into a private always-shown window-server space so it does NOT
 *  ride the slide animation during a three-finger Space swipe (the one thing
 *  collectionBehavior=stationary does NOT prevent on macOS 26 — measured).
 *  Must be called AFTER the window has a live window number (i.e. after it has
 *  been shown) and AFTER any setVisibleOnAllWorkspaces call, which would
 *  otherwise re-attach it to the user spaces. Idempotent. Returns false when
 *  the addon is unavailable or the window isn't on screen yet. */
export function pinOverlayToSpace(win: BrowserWindow): boolean {
  const a = loadAddon()
  if (!a) return false
  try {
    return a.pinToSpace(win.getNativeWindowHandle())
  } catch {
    return false
  }
}
