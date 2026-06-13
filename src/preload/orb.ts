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
  ORB_SET_FOCUSABLE: 'rax:orb-set-focusable',
  ORB_DISPLAY_PROFILE: 'rax:orb-display-profile',
  ORB_TTS_SPEAK: 'rax:orb-tts-speak',
  ORB_TTS_CANCEL: 'rax:orb-tts-cancel',
  ORB_TTS_DONE: 'rax:orb-tts-done',
  ORB_TTS_LEVELS: 'rax:orb-tts-levels',
  ORB_RENDERER_READY: 'rax:orb-renderer-ready',
  ORB_BUSY: 'rax:orb-busy',
  ORB_VOICE_STATE: 'rax:orb-voice-state',
  ORB_MASCOT_COLOR: 'rax:orb-mascot-color',
  ORB_MASCOT_SEAT: 'rax:orb-mascot-seat',
  ORB_ENTRANCE: 'rax:orb-entrance',
  ORB_TTS_SET_VOICE: 'rax:orb-tts-set-voice',
  ORB_TTS_GET_VOICE: 'rax:orb-tts-get-voice',
  ORB_SET_MASCOT_COLOR: 'rax:orb-set-mascot-color',
  ORB_TOGGLE_DOCK: 'rax:orb-toggle-dock',
  ORB_DOCK_VISIBLE: 'rax:orb-dock-visible',
  ORB_TTS_PREVIEW: 'rax:orb-tts-preview',
  ORB_GROK_GET_CONFIG: 'rax:orb-grok-get-config',
  ORB_GROK_SET_CONFIG: 'rax:orb-grok-set-config',
  ORB_GROK_CONFIG: 'rax:orb-grok-config',
  ORB_GROK_START: 'rax:orb-grok-start',
  ORB_GROK_STOP: 'rax:orb-grok-stop',
  ORB_GROK_AUDIO: 'rax:orb-grok-audio',
  ORB_GROK_HOLD: 'rax:orb-grok-hold',
  ORB_GROK_EVENT: 'rax:orb-grok-event',
  ORB_GROK_CAPTION: 'rax:orb-grok-caption',
  ORB_GEMINI_GET_CONFIG: 'rax:orb-gemini-get-config',
  ORB_GEMINI_SET_CONFIG: 'rax:orb-gemini-set-config',
  ORB_GEMINI_CONFIG: 'rax:orb-gemini-config',
  ORB_GEMINI_START: 'rax:orb-gemini-start',
  ORB_GEMINI_STOP: 'rax:orb-gemini-stop',
  ORB_GEMINI_AUDIO: 'rax:orb-gemini-audio',
  ORB_GEMINI_HOLD: 'rax:orb-gemini-hold',
  ORB_GEMINI_EVENT: 'rax:orb-gemini-event',
  ORB_GEMINI_CAPTION: 'rax:orb-gemini-caption',
  ORB_TOUR_GET: 'rax:orb-tour-get',
  ORB_TOUR_STEP: 'rax:orb-tour-step',
  ORB_TOUR_DONE: 'rax:orb-tour-done',
  ORB_TOUR_OPEN_KEYS: 'rax:orb-tour-open-keys',
  ORB_TOUR_ACTIVE: 'rax:orb-tour-active',
  ORB_TOUR_CUE: 'rax:orb-tour-cue',
  ORB_TOUR_PILL_DONE: 'rax:orb-tour-pill-done',
} as const

type TourTarget = 'tabbar' | 'voicetab'

/** Public realtime-backend config (no key material crosses the bridge) —
 *  the same shape for Grok and Gemini. */
export interface GrokPublicConfig {
  enabled: boolean
  voice: string
  hasKey: boolean
  keyTail: string
  /** Hold-to-talk (⌥R) instead of the open-mic continuous conversation. */
  pushToTalk?: boolean
  /** Gemini only: stream live screen frames into the session. */
  screenShare?: boolean
}

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
  /** Report the mascot's seat rect (window-relative DIPs, parked bar) so the
   *  intro cameo can fly the big mascot to exactly this spot. */
  pushMascotSeat(seat: {
    x: number
    y: number
    width: number
    height: number
    /** Display profile the seat was measured under — main ignores seats
     *  measured for the wrong profile (parked geometry differs ~52px). */
    notched: boolean
  }): void
  /** Entrance/exit choreography pushes — 'hold' parks the mascot off-stage
   *  while the intro cameo plays; 'show' = the window just became visible
   *  (start the bar entrance); 'land' thuds the mascot into his seat;
   *  'hide' = dismissal (contract into the notch before the window hides). */
  onEntrance(callback: (payload: { kind: 'hold' | 'land' | 'show' | 'hide' }) => void): () => void
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
  /** The notch window is non-focusable by default (it's a system-style
   *  overlay, not an app window). The settings panel needs real keyboard
   *  focus for its API-key inputs — toggle focusability around its lifetime. */
  setFocusable(focusable: boolean): void
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
  /** Grok voice (realtime speech-to-speech backend) — public config read. */
  getGrokConfig(): Promise<GrokPublicConfig>
  /** Merge-write Grok settings. Flipping `enabled` rebuilds the orb backend. */
  setGrokConfig(
    partial: Partial<{ enabled: boolean; apiKey: string; voice: string; pushToTalk: boolean }>,
  ): Promise<{ ok: boolean; config?: GrokPublicConfig; error?: string }>
  /** Main pushes the public Grok config on renderer-ready + every change. */
  onGrokConfig(callback: (config: GrokPublicConfig) => void): () => void
  /** Open the realtime session (main connects the WebSocket). */
  grokStart(): Promise<{ ok: boolean; error?: string }>
  /** Close the realtime session. */
  grokStop(): Promise<{ ok: boolean }>
  /** Stream one base64 PCM16 mono 24kHz mic chunk to the live session. */
  grokSendAudio(base64Pcm: string): void
  /** Push-to-talk ⌥R edge (true = held, false = released → answer). */
  grokSetHold(active: boolean): void
  /** Realtime session events (audio deltas, VAD signals, tool calls, …). */
  onGrokEvent(callback: (event: { type: string; [k: string]: unknown }) => void): () => void
  /** Caption traffic for the bottom pill — segments are scheduled against
   *  the renderer's audio clock; main just forwards to the pill window. */
  grokSendCaption(payload: { kind: 'segment'; segment: Record<string, unknown> } | { kind: 'clear'; id: string }): void
  /** Gemini Live (the second realtime backend) — same surface as the Grok
   *  set above, channel-for-channel. */
  getGeminiConfig(): Promise<GrokPublicConfig>
  setGeminiConfig(
    partial: Partial<{
      enabled: boolean
      apiKey: string
      voice: string
      screenShare: boolean
      pushToTalk: boolean
    }>,
  ): Promise<{ ok: boolean; config?: GrokPublicConfig; error?: string }>
  onGeminiConfig(callback: (config: GrokPublicConfig) => void): () => void
  geminiStart(): Promise<{ ok: boolean; error?: string }>
  geminiStop(): Promise<{ ok: boolean }>
  geminiSendAudio(base64Pcm: string): void
  geminiSetHold(active: boolean): void
  onGeminiEvent(callback: (event: { type: string; [k: string]: unknown }) => void): () => void
  geminiSendCaption(payload: { kind: 'segment'; segment: Record<string, unknown> } | { kind: 'clear'; id: string }): void
  /** First-install tour state — `{ pending, step }` (step = resume point). */
  tourGet(): Promise<{ pending: boolean; step: number }>
  /** Persist the step index the tour just reached (resume point). */
  tourStep(step: number): void
  /** Mark the tour done forever — finished naturally or skipped. */
  tourDone(how: 'finished' | 'skipped'): Promise<{ ok: boolean }>
  /** Open the Google AI Studio API-key page in the default browser. */
  tourOpenKeys(): Promise<{ ok: boolean }>
  /** Bracket the tour so main suppresses the bottom caption pill. */
  tourSetActive(active: boolean): void
  /** Ask the chat pill to spotlight a real element and report the gesture
   *  (null clears). Main makes the pill visible and relays the cue. */
  tourCue(target: TourTarget | null): void
  /** The pill reported the gated action was performed. */
  onTourPillDone(callback: (target: TourTarget) => void): () => void
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
  pushMascotSeat: (seat) => ipcRenderer.send(CHANNELS.ORB_MASCOT_SEAT, seat),
  onEntrance: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { kind: 'hold' | 'land' }) =>
      callback(payload)
    ipcRenderer.on(CHANNELS.ORB_ENTRANCE, handler)
    return () => ipcRenderer.removeListener(CHANNELS.ORB_ENTRANCE, handler)
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
  setFocusable: (focusable) => ipcRenderer.send(CHANNELS.ORB_SET_FOCUSABLE, !!focusable),
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
  getGrokConfig: () => ipcRenderer.invoke(CHANNELS.ORB_GROK_GET_CONFIG),
  setGrokConfig: (partial) => ipcRenderer.invoke(CHANNELS.ORB_GROK_SET_CONFIG, partial),
  onGrokConfig: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, config: GrokPublicConfig) => callback(config)
    ipcRenderer.on(CHANNELS.ORB_GROK_CONFIG, handler)
    return () => ipcRenderer.removeListener(CHANNELS.ORB_GROK_CONFIG, handler)
  },
  grokStart: () => ipcRenderer.invoke(CHANNELS.ORB_GROK_START),
  grokStop: () => ipcRenderer.invoke(CHANNELS.ORB_GROK_STOP),
  grokSendAudio: (base64Pcm) => ipcRenderer.send(CHANNELS.ORB_GROK_AUDIO, base64Pcm),
  grokSetHold: (active) => ipcRenderer.send(CHANNELS.ORB_GROK_HOLD, active),
  onGrokEvent: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, event: { type: string; [k: string]: unknown }) =>
      callback(event)
    ipcRenderer.on(CHANNELS.ORB_GROK_EVENT, handler)
    return () => ipcRenderer.removeListener(CHANNELS.ORB_GROK_EVENT, handler)
  },
  grokSendCaption: (payload) => ipcRenderer.send(CHANNELS.ORB_GROK_CAPTION, payload),
  getGeminiConfig: () => ipcRenderer.invoke(CHANNELS.ORB_GEMINI_GET_CONFIG),
  setGeminiConfig: (partial) => ipcRenderer.invoke(CHANNELS.ORB_GEMINI_SET_CONFIG, partial),
  onGeminiConfig: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, config: GrokPublicConfig) => callback(config)
    ipcRenderer.on(CHANNELS.ORB_GEMINI_CONFIG, handler)
    return () => ipcRenderer.removeListener(CHANNELS.ORB_GEMINI_CONFIG, handler)
  },
  geminiStart: () => ipcRenderer.invoke(CHANNELS.ORB_GEMINI_START),
  geminiStop: () => ipcRenderer.invoke(CHANNELS.ORB_GEMINI_STOP),
  geminiSendAudio: (base64Pcm) => ipcRenderer.send(CHANNELS.ORB_GEMINI_AUDIO, base64Pcm),
  geminiSetHold: (active) => ipcRenderer.send(CHANNELS.ORB_GEMINI_HOLD, active),
  onGeminiEvent: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, event: { type: string; [k: string]: unknown }) =>
      callback(event)
    ipcRenderer.on(CHANNELS.ORB_GEMINI_EVENT, handler)
    return () => ipcRenderer.removeListener(CHANNELS.ORB_GEMINI_EVENT, handler)
  },
  geminiSendCaption: (payload) => ipcRenderer.send(CHANNELS.ORB_GEMINI_CAPTION, payload),
  tourGet: () => ipcRenderer.invoke(CHANNELS.ORB_TOUR_GET),
  tourStep: (step) => ipcRenderer.send(CHANNELS.ORB_TOUR_STEP, step),
  tourDone: (how) => ipcRenderer.invoke(CHANNELS.ORB_TOUR_DONE, how),
  tourOpenKeys: () => ipcRenderer.invoke(CHANNELS.ORB_TOUR_OPEN_KEYS),
  tourSetActive: (active) => ipcRenderer.send(CHANNELS.ORB_TOUR_ACTIVE, { active: !!active }),
  tourCue: (target) => ipcRenderer.send(CHANNELS.ORB_TOUR_CUE, { target }),
  onTourPillDone: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { target: TourTarget }) =>
      callback(payload?.target)
    ipcRenderer.on(CHANNELS.ORB_TOUR_PILL_DONE, handler)
    return () => ipcRenderer.removeListener(CHANNELS.ORB_TOUR_PILL_DONE, handler)
  },
}

contextBridge.exposeInMainWorld('orb', api)
