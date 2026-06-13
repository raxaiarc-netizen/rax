// Preload for the intro cameo window — the center-screen mascot that wakes
// up, scans the desktop, and merges into the notch. Tiny surface: one push
// in (play), three signals out (ready / bar-cue / done).
import { contextBridge, ipcRenderer } from 'electron'

// Inlined channel names (sandboxed preloads can't require shared chunks) —
// keep in sync with src/shared/types.ts.
const CHANNELS = {
  INTRO_READY: 'rax:intro-ready',
  INTRO_PLAY: 'rax:intro-play',
  INTRO_BAR_CUE: 'rax:intro-bar-cue',
  INTRO_DONE: 'rax:intro-done',
} as const

/** Everything the cameo needs to perform: where to land (the mascot's seat
 *  in the notch bar, screen DIPs), the display it's covering, which visor
 *  colorway to wear, and which number to perform ('game' = first-install
 *  chase, 'glance' = everyday look-around opener). */
export interface IntroPlayPayload {
  seat: { x: number; y: number; size: number }
  display: { x: number; y: number; width: number; height: number }
  colorId: string
  variant: 'game' | 'glance'
  /** Cursor at summon time, screen DIPs — the game variant spawns the
   *  mascot away from it so a parked pointer can't trigger the first dodge. */
  cursor: { x: number; y: number }
}

export interface IntroAPI {
  /** Renderer mounted and listening — main replies with the play push. */
  ready(): void
  /** The play payload (fired once per window). */
  onPlay(callback: (payload: IntroPlayPayload) => void): () => void
  /** "Start the notch bar slide NOW" — fired at leap wind-up so the bar is
   *  settled by touchdown. */
  barCue(): void
  /** Touched down behind the bar — main releases the notch mascot and
   *  destroys this window. */
  done(): void
}

const api: IntroAPI = {
  ready: () => ipcRenderer.send(CHANNELS.INTRO_READY),
  onPlay: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: IntroPlayPayload) => callback(payload)
    ipcRenderer.on(CHANNELS.INTRO_PLAY, handler)
    return () => ipcRenderer.removeListener(CHANNELS.INTRO_PLAY, handler)
  },
  barCue: () => ipcRenderer.send(CHANNELS.INTRO_BAR_CUE),
  done: () => ipcRenderer.send(CHANNELS.INTRO_DONE),
}

contextBridge.exposeInMainWorld('intro', api)
