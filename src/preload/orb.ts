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
  ORB_DISPLAY_PROFILE: 'rax:orb-display-profile',
  ORB_TTS_SPEAK: 'rax:orb-tts-speak',
  ORB_TTS_CANCEL: 'rax:orb-tts-cancel',
  ORB_TTS_DONE: 'rax:orb-tts-done',
  ORB_TTS_LEVELS: 'rax:orb-tts-levels',
  ORB_RENDERER_READY: 'rax:orb-renderer-ready',
  ORB_BUSY: 'rax:orb-busy',
  ORB_VOICE_STATE: 'rax:orb-voice-state',
  ORB_MASCOT_COLOR: 'rax:orb-mascot-color',
  ORB_TTS_SET_VOICE: 'rax:orb-tts-set-voice',
  ORB_TTS_GET_VOICE: 'rax:orb-tts-get-voice',
  ORB_SET_MASCOT_COLOR: 'rax:orb-set-mascot-color',
  ORB_TOGGLE_DOCK: 'rax:orb-toggle-dock',
  ORB_DOCK_VISIBLE: 'rax:orb-dock-visible',
  ORB_TTS_PREVIEW: 'rax:orb-tts-preview',
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
  /** Display traits under the island (hardware notch or not) — pushed by main
   *  on create, summon, and display reconfiguration. */
  onDisplayProfile(callback: (profile: { notched: boolean }) => void): () => void
  /** Mascot visor colorway (see shared/mascot-colors.ts) — pushed by main on
   *  renderer-ready and whenever the Settings selection changes. */
  onMascotColor(callback: (payload: { colorId: string }) => void): () => void
  /** The notch's inline settings panel writes through the same main-process
   *  handlers the fullscreen Settings view uses — one on-disk truth. */
  setVoice(voiceId: string): Promise<{ ok: boolean; voice?: string; error?: string }>
  getVoice(): Promise<{ voice: string }>
  /** Play a short sample in the given voice WITHOUT changing the configured
   *  voice — the panel's play button. Returns the sample duration. */
  previewVoice(voiceId: string): Promise<{ ok: boolean; durationMs?: number; error?: string }>
  /** Main persists + pushes the change back via onMascotColor, so the
   *  swatch selection and the visor stay slaved to one source of truth. */
  setMascotColor(colorId: string): Promise<{ ok: boolean; color?: string; error?: string }>
  /** Toggle the agents dock window. Returns the resulting visibility. */
  toggleDock(): Promise<{ ok: boolean; visible: boolean }>
  /** Dock visibility pushes — sent on renderer-ready and whenever ANY
   *  surface (notch button, tray, the orb's own rax_set_dock tool) flips
   *  the dock, so the notch toggle always reflects truth. */
  onDockVisible(callback: (payload: { visible: boolean }) => void): () => void
  /** OS-level click-through for transparent regions. */
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void
  /** Speak a sentence via the system `say` command. Returns an id; `tts:done` arrives when finished. */
  ttsSpeak(text: string): Promise<{ id: string }>
  /** Cancel any in-flight TTS. */
  ttsCancel(): Promise<void>
  /** Subscribe to TTS completion (per-id). */
  onTtsDone(callback: (id: string) => void): () => void
  /** Loudness timeline of the utterance afplay just started playing —
   *  `levels[i]` covers `frameMs` ms of audio starting `startedAtMs + i*frameMs`
   *  (Date.now() domain). Drives the notch waveform during speech. */
  onTtsLevels(
    callback: (payload: { id: string; startedAtMs: number; frameMs: number; levels: number[] }) => void,
  ): () => void
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
  onDisplayProfile: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, profile: { notched: boolean }) => callback(profile)
    ipcRenderer.on(CHANNELS.ORB_DISPLAY_PROFILE, handler)
    return () => ipcRenderer.removeListener(CHANNELS.ORB_DISPLAY_PROFILE, handler)
  },
  onMascotColor: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { colorId: string }) => callback(payload)
    ipcRenderer.on(CHANNELS.ORB_MASCOT_COLOR, handler)
    return () => ipcRenderer.removeListener(CHANNELS.ORB_MASCOT_COLOR, handler)
  },
  setVoice: (voiceId) => ipcRenderer.invoke(CHANNELS.ORB_TTS_SET_VOICE, voiceId),
  getVoice: () => ipcRenderer.invoke(CHANNELS.ORB_TTS_GET_VOICE),
  previewVoice: (voiceId) => ipcRenderer.invoke(CHANNELS.ORB_TTS_PREVIEW, voiceId),
  setMascotColor: (colorId) => ipcRenderer.invoke(CHANNELS.ORB_SET_MASCOT_COLOR, colorId),
  toggleDock: () => ipcRenderer.invoke(CHANNELS.ORB_TOGGLE_DOCK),
  onDockVisible: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { visible: boolean }) => callback(payload)
    ipcRenderer.on(CHANNELS.ORB_DOCK_VISIBLE, handler)
    return () => ipcRenderer.removeListener(CHANNELS.ORB_DOCK_VISIBLE, handler)
  },
  setIgnoreMouseEvents: (ignore, options) =>
    ipcRenderer.send(CHANNELS.SET_IGNORE_MOUSE_EVENTS, ignore, options || {}),
  ttsSpeak: (text) => ipcRenderer.invoke(CHANNELS.ORB_TTS_SPEAK, text),
  ttsCancel: () => ipcRenderer.invoke(CHANNELS.ORB_TTS_CANCEL).then(() => undefined),
  onTtsDone: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, id: string) => callback(id)
    ipcRenderer.on(CHANNELS.ORB_TTS_DONE, handler)
    return () => ipcRenderer.removeListener(CHANNELS.ORB_TTS_DONE, handler)
  },
  onTtsLevels: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      payload: { id: string; startedAtMs: number; frameMs: number; levels: number[] },
    ) => callback(payload)
    ipcRenderer.on(CHANNELS.ORB_TTS_LEVELS, handler)
    return () => ipcRenderer.removeListener(CHANNELS.ORB_TTS_LEVELS, handler)
  },
  rendererReady: () => ipcRenderer.send(CHANNELS.ORB_RENDERER_READY),
  setBusy: (busy) => ipcRenderer.send(CHANNELS.ORB_BUSY, !!busy),
  setVoiceState: (state) => ipcRenderer.send(CHANNELS.ORB_VOICE_STATE, state),
}

contextBridge.exposeInMainWorld('orb', api)
