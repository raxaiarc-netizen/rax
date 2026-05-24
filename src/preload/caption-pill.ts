// Preload for the standalone caption-pill window — the bottom-of-screen
// subtitle that shows what the user just said and what the orb is saying
// right now. Tiny surface: just receives orb events forwarded from main.
import { contextBridge, ipcRenderer } from 'electron'

// IPC channel names are inlined here (rather than imported from shared/types)
// so this preload bundles to a single self-contained file. Sandboxed preloads
// cannot resolve relative require() paths, so any shared chunk would fail to
// load at runtime. Keep these strings in sync with src/shared/types.ts.
const CHANNELS = {
  CAPTION_PILL_EVENT: 'rax:caption-pill-event',
} as const

export interface CaptionPillAPI {
  /** Subscribe to forwarded orb events (orb_user_turn, text_chunk,
   *  task_complete, error, orb_session_dead). */
  onEvent(callback: (event: unknown) => void): () => void
}

const api: CaptionPillAPI = {
  onEvent: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, event: unknown) => callback(event)
    ipcRenderer.on(CHANNELS.CAPTION_PILL_EVENT, handler)
    return () => ipcRenderer.removeListener(CHANNELS.CAPTION_PILL_EVENT, handler)
  },
}

contextBridge.exposeInMainWorld('captionPill', api)
