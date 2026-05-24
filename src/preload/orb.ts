// Preload for the voice orb window. Smaller surface than the main `window.rax`
// API — the orb only needs voice transcription, the orb session, and dismiss.
import { contextBridge, ipcRenderer } from 'electron'

// IPC channel names are inlined here (rather than imported from shared/types)
// so this preload bundles to a single self-contained file. Sandboxed preloads
// cannot resolve relative require() paths, so any shared chunk would fail to
// load at runtime. Keep these strings in sync with src/shared/types.ts.
const CHANNELS = {
  ORB_HIDE: 'rax:orb-hide',
  ORB_SUBMIT_TURN: 'rax:orb-submit-turn',
  ORB_CANCEL_TURN: 'rax:orb-cancel-turn',
  ORB_RESET_SESSION: 'rax:orb-reset-session',
  ORB_EVENT: 'rax:orb-event',
  ORB_DISMISSED: 'rax:orb-dismissed',
  ORB_FORCE_LISTEN: 'rax:orb-force-listen',
  ORB_HOLD_START: 'rax:orb-hold-start',
  ORB_HOLD_END: 'rax:orb-hold-end',
  TRANSCRIBE_AUDIO: 'rax:transcribe-audio',
  SET_IGNORE_MOUSE_EVENTS: 'rax:set-ignore-mouse-events',
  ORB_SET_POSITION: 'rax:orb-set-position',
  ORB_TTS_SPEAK: 'rax:orb-tts-speak',
  ORB_TTS_CANCEL: 'rax:orb-tts-cancel',
  ORB_TTS_DONE: 'rax:orb-tts-done',
  ORB_RENDERER_READY: 'rax:orb-renderer-ready',
  ORB_BUSY: 'rax:orb-busy',
  ORB_VOICE_STATE: 'rax:orb-voice-state',
} as const

export interface OrbAPI {
  /** Submit a transcribed user turn to the orb's claude session. */
  submitTurn(prompt: string): Promise<{ ok: boolean; error?: string }>
  /** Cancel the in-flight turn (graceful via stream-json). */
  cancelTurn(): Promise<{ ok: boolean }>
  /** Reset the conversation: kill the current claude session so the next turn starts fresh. */
  resetSession(): Promise<{ ok: boolean }>
  /** Hide the orb window. */
  hide(): Promise<void>
  /** Run audio through Whisper and return the transcript. */
  transcribeAudio(audioBase64: string): Promise<{ error: string | null; transcript: string | null }>
  /** Subscribe to orb events (text_chunk, tool_call, task_complete, orb_user_turn, etc.). */
  onEvent(callback: (event: unknown) => void): () => void
  /** "The host wants you to start listening now" — fired by the push-to-talk global hotkey. */
  onForceListen(callback: () => void): () => void
  /** Hold-to-speak began (Option+R held) — start a recording that ignores VAD silence. */
  onHoldStart(callback: () => void): () => void
  /** Hold-to-speak released — stop recording and submit whatever was captured. */
  onHoldEnd(callback: () => void): () => void
  /** "The host hid the window" — fired when the user explicitly dismissed (Esc / shortcut). */
  onDismissed(callback: () => void): () => void
  /** Absolute window placement — bypasses macOS work-area clamps. */
  setBounds(x: number, y: number): void
  /** OS-level click-through for transparent regions. */
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void
  /** Speak a sentence via the system `say` command. Returns an id; `tts:done` arrives when finished. */
  ttsSpeak(text: string): Promise<{ id: string }>
  /** Cancel any in-flight TTS. */
  ttsCancel(): Promise<void>
  /** Subscribe to TTS completion (per-id). */
  onTtsDone(callback: (id: string) => void): () => void
  /** Tell main the renderer has wired up its IPC listeners — main flushes any queued force-listen. */
  rendererReady(): void
  /** Tell main whether the renderer is busy (recording / thinking / talking). Main uses this
   *  to decide whether a blur should auto-hide the window. */
  setBusy(busy: boolean): void
  /** Tell main the orb's current voice-state ('idle' | 'listening' | 'transcribing' |
   *  'thinking' | 'talking' | 'error'). Main re-emits it to the caption-pill window
   *  so the pill stays in sync with real speaking state. */
  setVoiceState(state: string): void
}

const api: OrbAPI = {
  submitTurn: (prompt) => ipcRenderer.invoke(CHANNELS.ORB_SUBMIT_TURN, prompt),
  cancelTurn: () => ipcRenderer.invoke(CHANNELS.ORB_CANCEL_TURN),
  resetSession: () => ipcRenderer.invoke(CHANNELS.ORB_RESET_SESSION),
  hide: () => ipcRenderer.invoke(CHANNELS.ORB_HIDE).then(() => undefined),
  transcribeAudio: (audioBase64) => ipcRenderer.invoke(CHANNELS.TRANSCRIBE_AUDIO, audioBase64),
  onEvent: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, event: unknown) => callback(event)
    ipcRenderer.on(CHANNELS.ORB_EVENT, handler)
    return () => ipcRenderer.removeListener(CHANNELS.ORB_EVENT, handler)
  },
  onForceListen: (callback) => {
    const handler = () => callback()
    ipcRenderer.on(CHANNELS.ORB_FORCE_LISTEN, handler)
    return () => ipcRenderer.removeListener(CHANNELS.ORB_FORCE_LISTEN, handler)
  },
  onHoldStart: (callback) => {
    const handler = () => callback()
    ipcRenderer.on(CHANNELS.ORB_HOLD_START, handler)
    return () => ipcRenderer.removeListener(CHANNELS.ORB_HOLD_START, handler)
  },
  onHoldEnd: (callback) => {
    const handler = () => callback()
    ipcRenderer.on(CHANNELS.ORB_HOLD_END, handler)
    return () => ipcRenderer.removeListener(CHANNELS.ORB_HOLD_END, handler)
  },
  onDismissed: (callback) => {
    const handler = () => callback()
    ipcRenderer.on(CHANNELS.ORB_DISMISSED, handler)
    return () => ipcRenderer.removeListener(CHANNELS.ORB_DISMISSED, handler)
  },
  setBounds: (x, y) => ipcRenderer.send(CHANNELS.ORB_SET_POSITION, x, y),
  setIgnoreMouseEvents: (ignore, options) =>
    ipcRenderer.send(CHANNELS.SET_IGNORE_MOUSE_EVENTS, ignore, options || {}),
  ttsSpeak: (text) => ipcRenderer.invoke(CHANNELS.ORB_TTS_SPEAK, text),
  ttsCancel: () => ipcRenderer.invoke(CHANNELS.ORB_TTS_CANCEL).then(() => undefined),
  onTtsDone: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, id: string) => callback(id)
    ipcRenderer.on(CHANNELS.ORB_TTS_DONE, handler)
    return () => ipcRenderer.removeListener(CHANNELS.ORB_TTS_DONE, handler)
  },
  rendererReady: () => ipcRenderer.send(CHANNELS.ORB_RENDERER_READY),
  setBusy: (busy) => ipcRenderer.send(CHANNELS.ORB_BUSY, !!busy),
  setVoiceState: (state) => ipcRenderer.send(CHANNELS.ORB_VOICE_STATE, state),
}

contextBridge.exposeInMainWorld('orb', api)
