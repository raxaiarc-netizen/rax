// ─── Intro cameo window (main side) ───
//
// Owns the short-lived, full-display, transparent, click-through window in
// which the big mascot performs before merging into the notch (see
// src/renderer/intro/main.tsx for the choreography). index.ts orchestrates
// WHEN it plays (summonOrbWithIntro) and what happens at its cues; this
// module owns the window's lifecycle and the IPC plumbing.
//
// Level contract: the cameo rides 'status'+0 — one notch BELOW the notch
// bar's 'status'+1 — so the final approach visibly ducks BEHIND the bar:
// that occlusion is the "merge". Click-through and non-activating
// throughout; it must never steal keystrokes or clicks for its ~4s of life.
import { BrowserWindow, ipcMain, type Display } from 'electron'
import { join } from 'path'
import { IPC } from '../../shared/types'

export interface IntroSeat {
  x: number
  y: number
  size: number
}

/** Which number the mascot performs: 'game' is the full first-install
 *  catch-me-if-you-can; 'glance' is the everyday opener — spawn, take a
 *  good look at the screen for a few seconds, leap to the notch. */
export type IntroVariant = 'game' | 'glance'

export interface IntroCallbacks {
  /** Leap wind-up — show the notch window NOW so the bar slide lands a
   *  beat before the mascot does. */
  onBarCue: () => void
  /** Touchdown behind the bar — release the notch mascot ('land'). The
   *  window is already torn down when this fires. */
  onDone: () => void
  /** The window died WITHOUT completing (crash, load failure, watchdog) —
   *  the caller must make sure the notch still appears. Never fired for
   *  explicit destroyIntro() calls or normal completion. */
  onGone: (reason: string) => void
}

let win: BrowserWindow | null = null
let cbs: IntroCallbacks | null = null
let active = false
let closedByUs = false
let pendingPlay: {
  seat: IntroSeat
  display: { x: number; y: number; width: number; height: number }
  colorId: string
  variant: IntroVariant
  cursor: { x: number; y: number }
} | null = null
let watchdog: NodeJS.Timeout | null = null

// Registered once at module load; handlers consult current state so stale
// windows (already torn down) can't fire callbacks.
ipcMain.on(IPC.INTRO_READY, (e) => {
  if (!active || !win || win.isDestroyed() || e.sender !== win.webContents || !pendingPlay) return
  // Transparent window — nothing flashes by showing before the play push.
  win.showInactive()
  win.webContents.send(IPC.INTRO_PLAY, pendingPlay)
  pendingPlay = null
})
ipcMain.on(IPC.INTRO_BAR_CUE, (e) => {
  if (!active || e.sender !== win?.webContents) return
  cbs?.onBarCue()
})
ipcMain.on(IPC.INTRO_DONE, (e) => {
  if (!active || e.sender !== win?.webContents) return
  const done = cbs
  destroyIntro()
  done?.onDone()
})

export function isIntroActive(): boolean {
  return active
}

export function playIntro(
  display: Display,
  payload: {
    seat: IntroSeat
    colorId: string
    variant: IntroVariant
    /** Cursor at summon time, screen DIPs — keeps the spawn away from it. */
    cursor: { x: number; y: number }
  },
  callbacks: IntroCallbacks,
): void {
  if (active) return
  active = true
  closedByUs = false
  cbs = callbacks
  pendingPlay = { ...payload, display: display.bounds }

  win = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
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
    // Same caption-pill caveat: do NOT set focusable:false — macOS NSPanels
    // with it can fail to display via showInactive. Ignored mouse events
    // below keep it passive.
    show: false,
    hiddenInMissionControl: true,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: join(__dirname, '../preload/intro.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })

  // Click-through with mousemove FORWARDING: clicks land on whatever is
  // underneath (the desktop stays fully usable), but the renderer still
  // sees the cursor — that powers the catch-me-if-you-can game (proximity
  // dodges) and the mascot's cursor-following eyes. Since he dodges before
  // the pointer can ever reach him, a click "on him" is impossible by
  // construction — no click capture needed.
  win.setIgnoreMouseEvents(true, { forward: true })
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    // 'status'+0: above normal windows, below the notch bar ('status'+1).
    win.setAlwaysOnTop(true, 'status', 0)
  } catch {}
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  win.on('closed', () => {
    win = null
    if (active && !closedByUs) {
      const gone = cbs
      finishState()
      gone?.onGone('closed')
    }
  })

  // Fail fast on a dead renderer — the 16s watchdog still backstops, but a
  // crash/load failure should put the notch up NOW, not in 16 seconds.
  const failFast = (reason: string): void => {
    if (!active || closedByUs) return
    const gone = cbs
    destroyIntro()
    gone?.onGone(reason)
  }
  win.webContents.on('render-process-gone', (_e, details) => {
    failFast(`renderer-gone:${details.reason}`)
  })
  win.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    // -3 (ABORTED) is benign churn (e.g. our own teardown), not a failure.
    if (isMainFrame && code !== -3) failFast(`load-failed:${code} ${desc}`)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/intro.html`)
  } else {
    win.loadFile(join(__dirname, '../renderer/intro.html'))
  }

  // Hard cap on the whole performance — a wedged renderer (GPU stall, load
  // failure, never-arriving ready) must not leave the user notch-less.
  // Generous: the catch-me game alone may run ~8s before the renderer's own
  // boredom/deadline logic sends him home.
  watchdog = setTimeout(() => {
    if (!active) return
    const gone = cbs
    destroyIntro()
    gone?.onGone('timeout')
  }, 16_000)
}

function finishState(): void {
  active = false
  cbs = null
  pendingPlay = null
  if (watchdog) {
    clearTimeout(watchdog)
    watchdog = null
  }
}

/** Tear the cameo down without firing callbacks — for normal completion,
 *  user skips, and "a plain show needs the stage cleared" aborts. */
export function destroyIntro(): void {
  closedByUs = true
  finishState()
  if (win && !win.isDestroyed()) win.destroy()
  win = null
}
