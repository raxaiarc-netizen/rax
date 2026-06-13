import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import {
  buildToolDefs,
  executeTool,
  type ToolExecContext,
  type ToolResultContent,
} from './orb-direct-tools'
import { formatTabsSnapshot, type TabContextRegistry } from './tab-context'
import { locateTargetForGrok } from './grok-vision'
import { captureScreenForOrb, isCaptureFailure, type CaptureCalibration } from './screen-capture'
import { getGeminiVoiceConfig, GEMINI_LIVE_MODEL } from './gemini-voice-config'
import type { GrokRendererEvent } from './grok-voice-session'

/** Same renderer-event contract as the Grok backend — the renderer voice
 *  client is shared, so the payload shape is identical by design. */
export type GeminiRendererEvent = GrokRendererEvent
import type { OrbRpcInfo } from './orb-rpc'
import type { AgentCompletion, SubmitAttachment } from './orb-session'
import { log as _log } from '../logger'

function log(msg: string): void {
  _log('GeminiVoice', msg)
}

// Env override mirrors GEMINI_LIVE_MODEL: lets users route through a proxy
// and lets a protocol harness point at a local mock.
const GEMINI_LIVE_URL =
  process.env.RAX_GEMINI_LIVE_URL ||
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'
const COMPLETION_TASK_CLIP = 220
const COMPLETION_RESULT_CLIP = 700
const COMPLETION_TTL_MS = 5 * 60 * 1000
/** Keep tool outputs sane for a speech model's context. */
const TOOL_OUTPUT_CLIP = 16_000
/** Don't speak an autonomous recap on the heels of the user's own speech. */
const SYSTEM_TURN_QUIET_MS = 2_500
const CONNECT_TIMEOUT_MS = 12_000
/** Output PCM rate the Live API streams at (renderer plays natively). */
const OUTPUT_RATE = 24_000
/** Screen-share frame cadence. The Live API caps video at 1 fps; a capture
 *  itself costs a few hundred ms of subprocess work (screencapture + sips +
 *  the JXA cursor annotator), so 1.5s keeps the stream smooth without
 *  saturating a core — and every frame costs tokens. */
const SCREEN_FRAME_INTERVAL_MS = 1_500
/** Streamed frames are smaller than rax_screenshot's 1280/1600px captures —
 *  enough to read window-level content, cheap enough to send continuously.
 *  Click coordinates never come from frames (see _groundedClick). */
const SCREEN_FRAME_MAX_EDGE = 1_024
/** Below this grounder confidence we refuse to click — same bar as Grok
 *  mode: a wrong click is worse than admitting the target wasn't found. */
const MIN_CLICK_CONFIDENCE = 0.4

/**
 * Gemini-specific system prompt — a sibling of GROK_VOICE_SYSTEM_PROMPT in
 * grok-voice-session.ts, kept as its own constant so each realtime backend
 * can be tuned independently (the grok one encodes a grok-specific
 * narrate-instead-of-call failure mode; the call-first framing is just as
 * healthy a default here). Compact on purpose: realtime speech models do
 * worse with the full 9.6KB orb prompt.
 */
const GEMINI_VOICE_SYSTEM_PROMPT = [
  "You are the Rax orb — the user's voice assistant on their Mac, running as a realtime speech-to-speech agent, and the conductor of a fixed crew of five Rax agents who do heavy work in the background.",
  '',
  'ACT, DON\'T DESCRIBE: your functions are live and real; words alone do nothing. When the user asks you to do, open, check, run, fix, create, or find anything, EMIT THE FUNCTION CALL FIRST — the result comes back to you and the conversation continues, so you lose nothing by calling immediately. Never speak phrases like "I\'ll use the bash tool" or "opening it now" as a substitute for the call: a response that promises an action but contains no function call is a hard failure. Never offer-and-wait either ("I could check…", "I can have Nova look at it") — do the thing, then report. At most a few words of acknowledgment, then the call, then the real result.',
  '',
  "Your output is spoken aloud. One or two short sentences, plain conversational English. No markdown, no lists, no emoji. Don't read file paths, URLs, secrets, or raw pixel coordinates aloud — say what something IS, not its numbers.",
  '',
  'TOOLS on the user\'s real Mac (permissions bypassed — confirm before anything clearly destructive):',
  '  - bash — shell: open apps and sites (open "https://…"), git, npm, curl, files, anything terminal.',
  '  - read / write / edit — files. grep / glob — search (silent, no narration needed).',
  '  - rax_screenshot — your EYES: the captured screenshot is shown to you DIRECTLY as an image in this conversation, so answer from what you actually SEE in it. The text result additionally reports the cursor\'s exact image-pixel coordinates — the red ring + white dot in the image marks that spot. Call it whenever the user asks about their screen ("what am I looking at", "what\'s my mouse on").',
  '  - rax_control_screen — real mouse and keyboard. To CLICK, just describe the target: action="click", target="the calendar icon in the dock" — be specific, name what you actually see. You never deal in coordinates; the system locates the target on screen and clicks it, then tells you what it clicked or that it couldn\'t find it (then look again or describe it differently). Type with action="type" + text; press keys with action="key" + key; scroll with action="scroll" + dy. After each action you are shown a fresh frame so you can verify what changed. If error="accessibility_denied", tell the user to approve Rax in System Settings → Privacy & Security → Accessibility.',
  '  - SCREEN SHARING: when the user flips "Share screen" in the notch settings, frames of their screen stream to you continuously — you ALWAYS see their current screen, live, with a red ring + white dot marking their cursor. While sharing, rax_screenshot is DISABLED — never call it; everything it could tell you (including where the cursor is and what it\'s on) is already visible in the latest frame, so just answer from what you see. To click something you see, describe it: rax_control_screen action="click" target="…"; the next frames show you the result.',
  '',
  'YOUR CREW — five real, named teammates with persistent sessions (never call them "tabs" or numbers):',
  '  Max (heavy lifter: bulk work, long builds) · Alex (architect: design, refactors) · Luna (researcher: deep dives) · Nova (spark: quick experiments) · Zara (closer: polish, ship-it).',
  "  - rax_list_tabs / rax_read_tab (silent) — check who's busy and what they said. The crew snapshot is NOT auto-attached in this mode; call rax_list_tabs when you need it.",
  '  - rax_send_to_tab / rax_send_to_tab_and_wait — dispatch work by NAME (tab="Max"). The crew member heard NOTHING of this conversation: write the prompt like a ticket — WHAT to do, WHERE (file paths, app, area of the codebase) when you know it, and what DONE looks like. Never send a bare topic like "fix the bug". ALWAYS pass userRequest with the user\'s verbatim words when the task came from them, and context with constraints or paths you know; the project directory is attached automatically. Use the _and_wait variant when you need the answer to reply. Tell the user who you handed it to.',
  '  - rax_focus_tab — bring their window forward. rax_set_dock — show/hide the crew dock.',
  '  - Never call rax_open_tab — the crew is fixed at five.',
  '',
  'AGENT UPDATES: an <agent_updates> block in a message means crew members finished background work. kind="prepended": answer the user\'s request first, then add one short aside ("…and Max just wrapped the build"). kind="autonomous": no user prompt — speak ONE short recap leading with the agent\'s name, call no tools, ask no follow-up.',
  '',
  "Stay grounded: if you don't know, say so and offer to find out. When a request needs many steps, do them — keep narration minimal between calls.",
  '',
  'FINAL RULE: if your reply mentions doing something, the matching function call MUST be in this same response. Call first, talk after.',
].join('\n')

/** Minimal structural type for Node's undici-backed global WebSocket. */
interface NodeWebSocket {
  readyState: number
  binaryType: string
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: string, listener: (event: { data?: unknown; code?: number; reason?: string; message?: string }) => void): void
}

type NodeWebSocketCtor = new (url: string) => NodeWebSocket

const WS_OPEN = 1

export interface GeminiVoiceSessionOptions {
  rpc: OrbRpcInfo
  projectPath: string
  tabContext: TabContextRegistry
  model?: string
  /** Called with each screen-share frame's geometry so the RPC server can
   *  resolve unit:"norm1000" clicks against the frame the model just saw.
   *  Called with null when the frame loop stops, so a dead session's
   *  geometry can't hijack later clicks from another backend. */
  onFrameCalibration?: (cal: CaptureCalibration | null) => void
}

/** Shapes of the BidiGenerateContent server message fields we consume. */
interface GeminiServerContent {
  modelTurn?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string }; text?: string }> }
  inputTranscription?: { text?: string }
  outputTranscription?: { text?: string }
  interrupted?: boolean
  turnComplete?: boolean
  generationComplete?: boolean
}

interface GeminiServerMessage {
  setupComplete?: Record<string, unknown>
  serverContent?: GeminiServerContent
  toolCall?: { functionCalls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }> }
  toolCallCancellation?: { ids?: string[] }
  goAway?: { timeLeft?: string }
  usageMetadata?: Record<string, unknown>
  error?: { message?: string }
}

/**
 * Fourth orb backend: Google's Gemini Live API over a realtime WebSocket
 * (BidiGenerateContent) — the sibling of GrokVoiceSession, behind the same
 * notch opt-in pattern (gemini-voice-config.ts; mutually exclusive with the
 * Grok toggle).
 *
 * The renderer half is the SAME RealtimeVoiceClient the Grok backend uses:
 * this class translates the Live API's protocol onto the renderer-event
 * contract Grok established (GrokRendererEvent — pushed over ORB_GEMINI_EVENT)
 * and onto the normalized 'event' stream (orb_user_turn / text_chunk /
 * tool_call / task_complete) that feeds the voice tab + caption pill.
 *
 * Protocol mapping notes:
 *   · One Gemini "turn" can interleave tool calls; the renderer thinks in
 *     response windows (response_started … response_done gate its audio).
 *     We open a window on the first model output and close it on toolCall /
 *     interrupted / turnComplete — a tool continuation opens a fresh one,
 *     which also resets the caption timeline cleanly.
 *   · Output transcription deltas carry no timestamps (unlike Grok's
 *     start_time), so caption anchors are synthesized: seconds of response
 *     audio forwarded so far when the text delta arrives. Audio and text
 *     stream together, so this tracks the spoken position closely.
 *   · Mic audio arrives from the renderer as PCM16 @ 24kHz; the Live API
 *     accepts any declared rate (`audio/pcm;rate=24000`) and resamples
 *     server-side, so no local SRC is needed.
 *   · Vision is NATIVE: rax_screenshot results, a post-rax_control_screen
 *     verification shot, and (opt-in) continuous screen-share frames all go
 *     up as realtimeInput.video image frames the model actually sees — no
 *     claude-haiku description sidecar like the Grok session needs.
 *   · Sequential function calling: the model pauses after toolCall until
 *     toolResponse — no explicit continuation request exists (or is needed),
 *     unlike the OpenAI-style response.create the Grok session sends.
 *
 * Exposes the same surface as OrbSession / OrbDirectSession / GrokVoiceSession
 * so OrbController stays the single branch point.
 */
export class GeminiVoiceSession extends EventEmitter {
  private opts: GeminiVoiceSessionOptions
  private ws: NodeWebSocket | null = null
  /** TCP/WS handshake completed (undici fires error-without-close before). */
  private opened = false
  /** setupComplete received — safe to stream audio / send content. */
  private wsReady = false
  /** endVoiceSession was called — the next close event is expected. */
  private closing = false

  private sessionId: string | null = null
  /** A renderer response window is open (first output → toolCall/turn end). */
  private activeSegment = false
  /** PCM16 samples forwarded to the renderer in the current segment —
   *  divided by OUTPUT_RATE this is the caption anchor for text deltas. */
  private segmentSamples = 0
  /** The model owes us output: user turn committed or toolResponse sent,
   *  and the closing turnComplete hasn't arrived yet. */
  private turnOpen = false
  /** toolResponse sent; the model hasn't resumed streaming yet. */
  private continuationPending = false
  /** Tool ids currently executing locally. */
  private pendingTools = new Set<string>()
  /** Tool ids the server cancelled (toolCallCancellation) while they were
   *  still running — their results must be dropped, not sent back. */
  private cancelledTools = new Set<string>()
  private lastUserSpeechAt = 0
  /** Push-to-talk mode, snapshotted at connect (the setup message sent then
   *  disables automatic activity detection; flipping the setting recreates
   *  the backend). */
  private sessionPtt = false
  /** ⌥R is currently held (PTT mode only). */
  private holdActive = false
  private toolIndex = 0
  /** Spoken text of the whole logical turn (across tool continuations). */
  private turnText = ''
  /** Accumulated input transcription of the user's current utterance —
   *  deltas are incremental fragments; one orb_user_turn is committed when
   *  the model starts answering. */
  private pendingUserTranscript = ''

  private pendingCompletions: AgentCompletion[] = []
  private lastSnapshot: string | null = null

  /** Screen-share loop — armed for the whole session, frames only flow while
   *  config.screenShare is on (so the toggle works live, no reconnect). */
  private frameTimer: NodeJS.Timeout | null = null
  /** A capture+send is already in flight — skip this tick. */
  private frameInFlight = false
  /** Base64 of the last share-loop frame actually sent. A static screen
   *  (user reading, idle, listening) produces byte-identical captures —
   *  re-sending those ~40×/min is pure token burn for zero new pixels, so
   *  the loop dedupes. Any real change (cursor ring moves, clock ticks,
   *  window paints) differs and goes through. */
  private lastFrameBase64: string | null = null

  constructor(opts: GeminiVoiceSessionOptions) {
    super()
    this.opts = opts
  }

  /* ── OrbBackend surface (matches the other backends) ───────────────────── */

  /**
   * Text-input turn. Not used by the renderer's voice flow in Gemini mode
   * (the audio stream carries the user's words), but the controller contract
   * requires it and it keeps typed/system entry points functional.
   */
  async submitTurn(prompt: string, _attachment?: SubmitAttachment): Promise<void> {
    const trimmed = prompt.trim()
    if (!trimmed) return
    if (!this.isAlive()) {
      throw new Error('Gemini voice session is not connected — click the notch to start one.')
    }
    if (this.isBusy()) {
      throw new Error('Voice agent is still responding to the previous turn.')
    }

    const completionsBlock = this._drainCompletions('prepended')
    const wrapped = completionsBlock
      ? `${this._tabsBlock()}\n\n${completionsBlock}\n\n${trimmed}`
      : `${this._tabsBlock()}\n\n${trimmed}`

    this.emit('event', { type: 'orb_user_turn', text: trimmed })
    this.turnOpen = true
    this.turnText = ''
    this._send({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text: wrapped }] }],
        turnComplete: true,
      },
    })
  }

  /**
   * The Live API has no client-side response cancel — interruption is the
   * server VAD's job (the user talking over the model). Nothing to do.
   */
  cancelTurn(): void {
    log('cancelTurn requested — no client-side cancel in the Live API, ignoring')
  }

  isBusy(): boolean {
    return this.activeSegment || this.pendingTools.size > 0 || this.continuationPending
  }

  isAlive(): boolean {
    return !!this.ws && this.ws.readyState === WS_OPEN && this.wsReady
  }

  resetConversation(): void {
    log('Resetting conversation — closing realtime socket')
    this.pendingCompletions = []
    this.lastSnapshot = null
    this.endVoiceSession()
  }

  /**
   * No-op: a Gemini session only exists while the user is actually in a
   * voice conversation. Eagerly opening the socket at app boot would start
   * a billed realtime session with no mic attached.
   */
  warmup(): void {}

  /** Model picker pushes land here like the other backends; the realtime
   *  model is independent of the chat-model picker, so we just record it. */
  setModel(modelId: string): void {
    if (modelId) this.opts.model = modelId
  }

  getModel(): string | undefined {
    return this.opts.model
  }

  shutdown(): void {
    log('Shutdown requested')
    this.pendingCompletions = []
    this._stopFrameLoop()
    this.endVoiceSession()
  }

  pushPendingCompletion(c: AgentCompletion): void {
    this.pendingCompletions.push(c)
  }

  hasPendingCompletions(): boolean {
    if (this.pendingCompletions.length === 0) return false
    const now = Date.now()
    return this.pendingCompletions.some((c) => now - c.completedAt < COMPLETION_TTL_MS)
  }

  /**
   * Gate the controller's autonomous-recap flush, same contract as the Grok
   * session. There is no explicit speech-stopped signal here; input
   * transcription deltas refresh lastUserSpeechAt continuously while the
   * user talks, so the quiet window doubles as the "not mid-sentence" check.
   */
  canAcceptSystemTurn(): boolean {
    return (
      this.isAlive() &&
      !this.isBusy() &&
      Date.now() - this.lastUserSpeechAt > SYSTEM_TURN_QUIET_MS
    )
  }

  async submitSystemTurn(): Promise<void> {
    if (!this.canAcceptSystemTurn()) {
      log('submitSystemTurn skipped — session busy, closed, or user mid-speech')
      return
    }
    const block = this._drainCompletions('autonomous')
    if (!block) return

    const wrapped =
      `${this._tabsBlock()}\n\n${block}\n\n` +
      `(autonomous update — no user prompt. Speak ONE short recap to the user about the crew completion(s) above. Do not call tools. Do not ask a follow-up.)`

    log('submitSystemTurn — speaking crew recap through the live Gemini session')
    this.emit('event', { type: 'orb_user_turn', text: '', autonomous: true })
    this.turnOpen = true
    this.turnText = ''
    this._send({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text: wrapped }] }],
        turnComplete: true,
      },
    })
  }

  /* ── Voice-session lifecycle (ORB_GEMINI_* IPC surface) ────────────────── */

  /**
   * Open the realtime WebSocket and configure the session. Resolves once the
   * server acks the setup message (setupComplete) — only then is audio
   * accepted; 'grok-event' { type:'ready' } is emitted at the same moment.
   */
  async startVoiceSession(): Promise<{ ok: boolean; error?: string }> {
    if (this.ws && this.ws.readyState === WS_OPEN) return { ok: true }

    const cfg = getGeminiVoiceConfig()
    if (!cfg.apiKey) {
      return { ok: false, error: 'No Google AI API key — add one in the notch voice settings.' }
    }
    const WebSocketCtor = (globalThis as Record<string, unknown>).WebSocket as
      | NodeWebSocketCtor
      | undefined
    if (typeof WebSocketCtor !== 'function') {
      return { ok: false, error: 'This build lacks WebSocket support in the main process.' }
    }

    this.closing = false
    this.opened = false
    this.wsReady = false
    this._resetTurnState()
    this.sessionPtt = cfg.pushToTalk

    // Auth rides the query string (the Live API's documented scheme), so no
    // undici headers extension is needed here. Never log the full URL.
    const url = `${GEMINI_LIVE_URL}?key=${encodeURIComponent(cfg.apiKey)}`
    log(`Connecting ${GEMINI_LIVE_URL} [model=${GEMINI_LIVE_MODEL}]`)

    return new Promise((resolve) => {
      let settled = false
      const settle = (res: { ok: boolean; error?: string }) => {
        if (!settled) {
          settled = true
          resolve(res)
        }
      }
      const timeout = setTimeout(() => {
        log('Connect timeout')
        const pending = this.ws
        // Drop the reference FIRST so a late open/close on the abandoned
        // socket no-ops against the identity guards below.
        if (!this.wsReady) this.ws = null
        try { pending?.close() } catch {}
        settle({ ok: false, error: 'Timed out connecting to the Gemini Live API.' })
      }, CONNECT_TIMEOUT_MS)
      timeout.unref?.()

      let ws: NodeWebSocket
      try {
        ws = new WebSocketCtor(url)
      } catch (err) {
        clearTimeout(timeout)
        settle({ ok: false, error: `WebSocket failed: ${(err as Error).message}` })
        return
      }
      // The Live API sends JSON in binary frames as well as text frames —
      // arraybuffer keeps the handler synchronous (Blob would force async).
      try { ws.binaryType = 'arraybuffer' } catch {}
      this.ws = ws

      ws.addEventListener('open', () => {
        if (this.ws !== ws) return
        log('Socket open — sending setup')
        this.opened = true
        this.sessionId = randomUUID()
        try {
          ws.send(JSON.stringify(this._setupPayload(cfg.voice)))
        } catch (err) {
          clearTimeout(timeout)
          settle({ ok: false, error: `Failed to configure session: ${(err as Error).message}` })
        }
        // Not ready yet — wsReady (and the renderer 'ready') waits for the
        // server's setupComplete ack; mic chunks before that are dropped.
      })

      ws.addEventListener('message', (event) => {
        if (this.ws !== ws) return
        let raw = ''
        if (typeof event.data === 'string') {
          raw = event.data
        } else if (event.data instanceof ArrayBuffer) {
          raw = Buffer.from(event.data).toString('utf-8')
        }
        if (!raw) return
        let parsed: GeminiServerMessage
        try {
          parsed = JSON.parse(raw) as GeminiServerMessage
        } catch {
          return
        }
        this._handleServerMessage(parsed, () => {
          clearTimeout(timeout)
          settle({ ok: true })
        })
      })

      ws.addEventListener('error', (event) => {
        if (this.ws !== ws) return
        const msg = String(event?.message || 'WebSocket error')
        log(`Socket error: ${msg}`)
        clearTimeout(timeout)
        // A failed HANDSHAKE (non-101 — bad key, network block) fires
        // 'error' but, in undici, no 'close' after it. Without this the
        // session would hold a dead socket forever. Post-handshake errors
        // do get a close event — let that path run the teardown.
        if (!this.opened) {
          this.ws = null
          settle({
            ok: false,
            error:
              'Could not connect to Gemini — check your Google AI API key in the notch settings (and your network).',
          })
          return
        }
        settle({ ok: false, error: msg })
      })

      ws.addEventListener('close', (event) => {
        if (this.ws !== ws) return
        const code = typeof event.code === 'number' ? event.code : 0
        const reason = String(event.reason || '')
        log(`Socket closed code=${code} reason=${reason.slice(0, 200)}`)
        clearTimeout(timeout)
        this._stopFrameLoop()
        const wasExpected = this.closing
        this.ws = null
        this.opened = false
        this.wsReady = false
        this.closing = false
        const hadOpenTurn = this.isBusy() || this.turnOpen
        this._resetTurnState()
        if (hadOpenTurn) this.emit('turn-end', false)
        this.emit('gemini-event', {
          type: 'closed',
          expected: wasExpected,
          code,
          reason: reason.slice(0, 300),
        } satisfies GeminiRendererEvent)
        if (!wasExpected) {
          // Setup rejections close with a policy-ish code + an explanatory
          // reason (bad key, model not found) — surface something actionable.
          const hint =
            /key|auth|401|403|permission|API_KEY/i.test(reason) || code === 1008
              ? 'Gemini rejected the connection — check your Google AI API key in the notch settings.'
              : `Gemini voice connection lost (code ${code}).`
          settle({ ok: false, error: hint })
          this.emit('session-dead', { code, signal: null, stderrTail: [hint, reason].filter(Boolean) })
        }
      })
    })
  }

  /** Close the realtime socket. The backend object itself stays usable. */
  endVoiceSession(): void {
    if (!this.ws) return
    log('Ending voice session')
    this.closing = true
    try { this.ws.close(1000, 'user ended session') } catch {}
  }

  /** Renderer mic audio — base64 PCM16 mono @ 24kHz (rate declared below;
   *  the Live API resamples server-side). */
  appendAudio(base64Pcm: string): void {
    if (!this.isAlive() || !base64Pcm) return
    // PTT: audio outside the activityStart/activityEnd window is undefined
    // behavior with automatic detection disabled — drop the racers.
    if (this.sessionPtt && !this.holdActive) return
    this._send({
      realtimeInput: { audio: { data: base64Pcm, mimeType: 'audio/pcm;rate=24000' } },
    })
  }

  /**
   * Push-to-talk turn boundaries (⌥R edges, forwarded from the renderer).
   * Only meaningful when the session was opened with pushToTalk on — setup
   * disabled the Live API's automatic activity detection, so the client owns
   * the turn markers: activityStart on hold (which also interrupts any
   * in-flight generation, per START_OF_ACTIVITY_INTERRUPTS), activityEnd on
   * release (after which the model answers). The synthesized speech_started/
   * stopped events keep the shared renderer client's playback-flush and
   * state machinery identical to what server VAD drives in open-mic mode.
   */
  setHold(active: boolean): void {
    if (!this.isAlive() || !this.sessionPtt) return
    if (active === this.holdActive) return
    this.holdActive = active
    this.lastUserSpeechAt = Date.now()
    if (active) {
      this._send({ realtimeInput: { activityStart: {} } })
      this.pendingUserTranscript = ''
      this.emit('gemini-event', { type: 'speech_started' } satisfies GeminiRendererEvent)
    } else {
      this._send({ realtimeInput: { activityEnd: {} } })
      this.emit('gemini-event', { type: 'speech_stopped' } satisfies GeminiRendererEvent)
    }
  }

  isVoiceSessionActive(): boolean {
    return this.isAlive()
  }

  /* ── Server message handling ───────────────────────────────────────────── */

  private _handleServerMessage(msg: GeminiServerMessage, onSetupComplete: () => void): void {
    // BidiGenerateContentServerMessage fields are NOT mutually exclusive
    // (usageMetadata rides along with content) — check each independently.
    if (msg.setupComplete) {
      log('setupComplete')
      this.wsReady = true
      this.emit('event', {
        type: 'session_init',
        sessionId: this.sessionId,
        tools: buildToolDefs().map((t) => t.name),
        model: GEMINI_LIVE_MODEL,
        mcpServers: [],
        skills: [],
        version: 'gemini-voice',
      })
      this.emit('gemini-event', { type: 'ready' } satisfies GeminiRendererEvent)
      onSetupComplete()
      this._startFrameLoop()
      // Recaps that piled up while no session existed get spoken once the
      // user opens one — after a short beat so the greeting doesn't talk
      // over the user's first words.
      if (this.hasPendingCompletions()) {
        const t = setTimeout(() => {
          this.submitSystemTurn().catch((err: Error) => log(`connect-flush recap failed: ${err.message}`))
        }, 1_200)
        t.unref?.()
      }
    }

    if (msg.serverContent) this._handleServerContent(msg.serverContent)

    if (msg.toolCall?.functionCalls?.length) {
      // The model pauses (sequential calling) the moment it emits the calls
      // — close the renderer's response window so it shows "thinking"; the
      // continuation opens a fresh window when output resumes.
      for (const fc of msg.toolCall.functionCalls) {
        const id = String(fc.id || '')
        const name = String(fc.name || '')
        if (!id || !name || this.pendingTools.has(id)) continue
        void this._runTool(name, id, fc.args || {})
      }
      this._closeSegment()
    }

    if (msg.toolCallCancellation?.ids?.length) {
      // The model retracted these calls (usually a barge-in mid-tool). Mark
      // them so the still-running executions drop their results instead of
      // sending a toolResponse the server no longer expects.
      for (const id of msg.toolCallCancellation.ids) {
        const key = String(id)
        if (this.pendingTools.delete(key)) this.cancelledTools.add(key)
      }
      log(`toolCallCancellation: ${msg.toolCallCancellation.ids.join(', ')}`)
      // With the calls retracted nothing more is owed — close the turn if
      // a turnComplete already came and went.
      this._maybeCloseTurn()
    }

    if (msg.goAway) {
      // The server will drop the connection shortly (session time limit).
      // Nothing graceful to do mid-conversation — the close handler surfaces
      // the disconnect and the renderer offers a reconnect.
      log(`goAway received (timeLeft=${String(msg.goAway.timeLeft || '?')})`)
    }

    if (msg.error) {
      const message = String(msg.error.message || 'Gemini Live error')
      log(`Server error: ${message}`)
      this.emit('gemini-event', { type: 'error', message } satisfies GeminiRendererEvent)
      this.emit('event', { type: 'error', message, isError: true, sessionId: this.sessionId })
    }
  }

  private _handleServerContent(sc: GeminiServerContent): void {
    // The user's words, transcribed server-side as INCREMENTAL fragments
    // (unlike Grok's cumulative re-sends) — accumulate, commit once when
    // the model starts answering.
    const inputText = sc.inputTranscription?.text
    if (typeof inputText === 'string' && inputText) {
      this.pendingUserTranscript += inputText
      this.lastUserSpeechAt = Date.now()
      this.emit('gemini-event', {
        type: 'user_transcript',
        text: this.pendingUserTranscript,
      } satisfies GeminiRendererEvent)
    }

    if (sc.interrupted) {
      // Server VAD cancelled the generation (barge-in). The renderer flushes
      // local playback + captions on speech_started; the stopped pair keeps
      // its state machine from camping in 'listening-as-speaking'.
      log('interrupted — user barged in')
      this.lastUserSpeechAt = Date.now()
      this.emit('gemini-event', { type: 'speech_started' } satisfies GeminiRendererEvent)
      this.emit('gemini-event', { type: 'speech_stopped' } satisfies GeminiRendererEvent)
      this._closeSegment()
      // The model abandoned this turn — any owed tool continuation dies with
      // it (without this, a barge-in between toolResponse and the resumed
      // output left continuationPending stuck true: isBusy() forever, recaps
      // and typed turns blocked for the rest of the session).
      this.continuationPending = false
      // The interrupted turn is over for transcript purposes — close it with
      // whatever was spoken. A trailing turnComplete no-ops via turnOpen.
      this._maybeCloseTurn()
    }

    // Spoken-text transcription of the assistant's audio. No timestamps in
    // this protocol — anchor each delta at the seconds of audio already
    // forwarded for this response window (text and audio stream together).
    const outputText = sc.outputTranscription?.text
    if (typeof outputText === 'string' && outputText) {
      this._ensureSegmentStarted()
      this.turnText += outputText
      this.emit('event', { type: 'text_chunk', text: outputText })
      this.emit('gemini-event', {
        type: 'text',
        delta: outputText,
        startTime: this.segmentSamples / OUTPUT_RATE,
      } satisfies GeminiRendererEvent)
    }

    const parts = sc.modelTurn?.parts
    if (Array.isArray(parts)) {
      for (const part of parts) {
        const data = part?.inlineData?.data
        if (typeof data === 'string' && data) {
          this._ensureSegmentStarted()
          this.segmentSamples += pcm16SamplesInBase64(data)
          this.emit('gemini-event', { type: 'audio', base64: data } satisfies GeminiRendererEvent)
        }
      }
    }

    if (sc.turnComplete) {
      this._closeSegment()
      this._maybeCloseTurn()
    }
  }

  /**
   * First output of a response window: open it, commit the user's spoken
   * turn to the transcript mirror exactly once, clear the continuation flag.
   */
  private _ensureSegmentStarted(): void {
    if (this.activeSegment) return
    this.activeSegment = true
    this.continuationPending = false
    this.segmentSamples = 0
    if (!this.turnOpen) {
      this.turnOpen = true
      this.turnText = ''
      if (this.pendingUserTranscript) {
        this.emit('event', { type: 'orb_user_turn', text: this.pendingUserTranscript.trim() })
      }
    }
    this.pendingUserTranscript = ''
    this.emit('gemini-event', { type: 'response_started' } satisfies GeminiRendererEvent)
  }

  private _closeSegment(): void {
    if (!this.activeSegment) return
    this.activeSegment = false
    this.emit('gemini-event', { type: 'response_done' } satisfies GeminiRendererEvent)
  }

  /** One task_complete per logical turn, once nothing more is owed. */
  private _maybeCloseTurn(): void {
    if (!this.turnOpen) return
    if (this.activeSegment || this.pendingTools.size > 0 || this.continuationPending) return
    this.turnOpen = false
    this.emit('event', {
      type: 'task_complete',
      result: this.turnText,
      costUsd: 0,
      durationMs: 0,
      numTurns: 1,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      sessionId: this.sessionId,
    })
    this.emit('turn-end', true)
  }

  /* ── Tools ─────────────────────────────────────────────────────────────── */

  private async _runTool(name: string, callId: string, input: Record<string, unknown>): Promise<void> {
    this.pendingTools.add(callId)
    log(`Tool call: ${name} (${callId})`)
    this.emit('event', { type: 'tool_call', toolName: name, toolId: callId, index: this.toolIndex++ })
    this.emit('gemini-event', { type: 'tool_call', name } satisfies GeminiRendererEvent)

    const ctx: ToolExecContext = {
      projectPath: this.opts.projectPath,
      rpc: { url: this.opts.rpc.url, secret: this.opts.rpc.secret },
    }

    let res: ToolResultContent
    try {
      res = await this._executeGeminiTool(name, input, ctx)
    } catch (err) {
      res = { kind: 'text', text: `Error: ${(err as Error).message}`, isError: true }
    }
    // toolResponse takes a JSON payload, not image blocks — but unlike Grok
    // (which needs a claude-haiku vision sidecar to describe screenshots),
    // Gemini Live is natively multimodal: push the actual pixels into the
    // conversation as a video frame and let the model SEE them. The text
    // output keeps the cursor coordinates the click calibration relies on.
    //
    // EXCEPT while screen share is on: the model is already watching live
    // frames of this exact screen, so uploading the screenshot again would
    // bill a duplicate image for pixels it can already see. Hard-enforced
    // here (not just prompt-discouraged): the tool degrades to its text
    // channel — the cursor's exact coordinates, the one thing the share
    // stream can't report.
    let output: string
    if (res.kind === 'image') {
      if (getGeminiVoiceConfig().screenShare) {
        output = res.text || 'Screenshot captured.'
        output +=
          '\n\nScreen sharing is ON, so no extra image was sent — you are already watching live frames of this screen; answer from the latest frame you see. The cursor coordinates reported above are exact.'
      } else {
        const shown = this._sendVideoFrame(res.base64, res.mimeType)
        output = res.text || 'Screenshot captured.'
        output += shown
          ? '\n\nThe screenshot itself has just been shown to you as a video frame — answer from what you actually SEE in it. For clicking, use the image-pixel coordinates reported above.'
          : '\n(The session dropped before the image could be shown to you — the cursor coordinates above are still reliable.)'
      }
    } else {
      output = res.text
    }
    this.pendingTools.delete(callId)

    // Cancelled mid-execution (toolCallCancellation, usually a barge-in):
    // the server no longer expects a response for this id — drop the result.
    if (this.cancelledTools.delete(callId)) {
      log(`Tool ${name} (${callId}) finished after cancellation — result dropped`)
      this._maybeCloseTurn()
      return
    }

    // See-act loop: after a successful screen-control action, capture and
    // show the model a fresh frame so it can verify what its click/keystroke
    // actually did without spending another tool call. Sent BEFORE the
    // toolResponse so the frame is in context when the model continues.
    // Screen-share mode skips this: the calibrated stream is already
    // delivering frames, and a competing one-off capture would just fight
    // the loop for the capture pipeline.
    if (
      name === 'rax_control_screen' &&
      !res.isError &&
      !getGeminiVoiceConfig().screenShare &&
      this.isAlive()
    ) {
      const sent = await this._sendScreenFrame()
      if (sent) {
        output +=
          '\n\nA fresh frame of the screen AFTER this action has just been shown to you — verify the result from what you see.'
      }
    }

    if (output.length > TOOL_OUTPUT_CLIP) {
      output = output.slice(0, TOOL_OUTPUT_CLIP) + `\n…(truncated ${output.length - TOOL_OUTPUT_CLIP} chars)`
    }

    if (!this.isAlive()) {
      log(`Tool ${name} finished after session close — result dropped`)
      return
    }

    log(`Tool done: ${name} (${callId}) — ${output.length} chars${res.isError ? ' [error]' : ''}`)
    this._send({
      toolResponse: {
        functionResponses: [{ id: callId, name, response: { output } }],
      },
    })
    // The model resumes on its own once every pending call has its response
    // — continuationPending keeps isBusy()/task_complete honest in between.
    if (this.pendingTools.size === 0) this.continuationPending = true
  }

  /**
   * Tool dispatch with the Gemini-mode click override. Gemini SEES the
   * screen (frames stream natively), but realtime models are unreliable at
   * EMITTING precise coordinates for what they see — live testing showed
   * consistently offset clicks (Gemini's native pointing convention is also
   * y-first 0-1000, the transpose of our x,y fields). So, exactly like Grok
   * mode, a click arrives as a `target` DESCRIPTION and the session grounds
   * it: fresh capture → vision grounder → calibrated norm1000 click.
   * Everything else passes straight through to the shared executor.
   */
  private async _executeGeminiTool(
    name: string,
    input: Record<string, unknown>,
    ctx: ToolExecContext,
  ): Promise<ToolResultContent> {
    // Screen share makes rax_screenshot fully redundant: the live frames are
    // captured WITH the red-ring cursor marker, and Gemini-mode clicks never
    // take model-supplied coordinates (they're target descriptions grounded
    // by _groundedClick). Short-circuit before any capture work happens so a
    // stray call costs neither a subprocess pipeline nor duplicate tokens.
    if (name === 'rax_screenshot' && getGeminiVoiceConfig().screenShare) {
      return {
        kind: 'text',
        text:
          'Screen sharing is ON — rax_screenshot is disabled. You already see the user\'s screen as continuous live frames; the red ring with the white dot in them marks their cursor. Answer from the latest frame you see. To click something, call rax_control_screen with a target description.',
        isError: false,
      }
    }
    if (name === 'rax_control_screen') {
      const action = String(input.action ?? '').trim()
      const target = typeof input.target === 'string' ? input.target.trim() : ''
      if ((action === 'click' || action === 'double_click') && target) {
        return this._groundedClick(action, target, input, ctx)
      }
    }
    return executeTool(name, input, ctx)
  }

  private async _groundedClick(
    action: string,
    target: string,
    input: Record<string, unknown>,
    ctx: ToolExecContext,
  ): Promise<ToolResultContent> {
    // Direct capture, not via the RPC screenshot route: the display the
    // model has been watching is the CURSOR display (that's what the share
    // stream captures), and the red ring is off so it can't occlude the
    // target. maxEdge 1280 keeps the image under the Anthropic API's resize
    // threshold, so the grounder model sees these exact pixels and its
    // pixel-coordinate answer maps 1:1 through this capture's calibration.
    const shot = await captureScreenForOrb({
      display: 'cursor',
      downscale: true,
      annotateCursor: false,
      maxEdge: 1280,
    })
    if (isCaptureFailure(shot)) {
      return {
        kind: 'text',
        text: `Couldn't capture the screen to find "${target}": ${shot.message}`,
        isError: true,
      }
    }
    if (!shot.calibration) {
      return {
        kind: 'text',
        text: `I captured the screen but couldn't calibrate it for clicking, so I did NOT click "${target}". Try again in a moment.`,
        isError: true,
      }
    }
    const cal = shot.calibration

    const loc = await locateTargetForGrok(shot.base64, shot.mimeType, target, cal.imageOutWidth, cal.imageOutHeight)
    if (!loc) {
      return {
        kind: 'text',
        text: `I can see the screen, but the click-targeting helper isn't available right now, so I can't reliably click "${target}".`,
        isError: true,
      }
    }
    if (!loc.found || loc.confidence < MIN_CLICK_CONFIDENCE) {
      const closest = loc.label ? ` The closest thing I can make out is ${loc.label}.` : ''
      return {
        kind: 'text',
        text: `I looked but couldn't confidently find "${target}" on screen, so I did NOT click.${closest} Tell me where it is or what it looks like and I'll try again.`,
        isError: false,
      }
    }

    // unit:'px' + the explicit calibration of THIS capture: the grounder's
    // pixel answer converts to a global point through the exact geometry it
    // was read from. The shared stream-calibration cache is deliberately NOT
    // used — the 1.5s share-frame loop overwrites it concurrently, which
    // could re-map the click onto a different frame (or display) than the
    // one the grounder searched.
    const clickRes = await executeTool(
      'rax_control_screen',
      { action, x: loc.x, y: loc.y, unit: 'px', calibration: cal, button: input.button },
      ctx,
    )
    if (clickRes.isError) {
      // Pass structured failures (e.g. accessibility_denied) through verbatim.
      return clickRes
    }
    const verb = action === 'double_click' ? 'Double-clicked' : 'Clicked'
    return {
      kind: 'text',
      text: `${verb} ${loc.label || target}. If that wasn't the right spot, tell me and I'll look again.`,
      isError: false,
    }
  }

  /* ── Screen vision ─────────────────────────────────────────────────────── */

  /** Push one image into the live conversation. The Live API accepts ≤1fps
   *  JPEG/PNG frames over realtimeInput.video — this is what makes the
   *  Gemini orb's eyes native instead of sidecar-described. */
  private _sendVideoFrame(base64: string, mimeType: string): boolean {
    if (!this.isAlive() || !base64) return false
    this._send({ realtimeInput: { video: { data: base64, mimeType } } })
    return true
  }

  /** Capture the display under the cursor (red-ring annotated) and stream it
   *  as a JPEG frame (~10× lighter than PNG — this runs every 1.5s). Each
   *  frame's geometry is registered with the RPC server so the model can
   *  click what it sees via unit:"norm1000" coordinates. Self-throttling:
   *  skips while a capture is in flight. `dedupe` (the share loop) skips
   *  frames identical to the last one sent — the model already has those
   *  exact pixels in context; the post-action verification path never
   *  dedupes so "a fresh frame has been shown to you" stays truthful. */
  private async _sendScreenFrame(dedupe = false): Promise<boolean> {
    if (!this.isAlive() || this.frameInFlight) return false
    this.frameInFlight = true
    try {
      const shot = await captureScreenForOrb({
        display: 'cursor',
        downscale: true,
        annotateCursor: true,
        maxEdge: SCREEN_FRAME_MAX_EDGE,
        format: 'jpg',
      })
      if (isCaptureFailure(shot)) {
        log(`screen frame capture failed: ${shot.message}`)
        return false
      }
      if (dedupe && shot.base64 === this.lastFrameBase64) {
        // Static screen — same pixels are already the model's latest frame.
        // Calibration is unchanged too, so skip the re-registration as well.
        return false
      }
      const sent = this._sendVideoFrame(shot.base64, shot.mimeType)
      if (sent) {
        this.lastFrameBase64 = shot.base64
        if (shot.calibration) this.opts.onFrameCalibration?.(shot.calibration)
      }
      return sent
    } catch (err) {
      log(`screen frame failed: ${(err as Error).message}`)
      return false
    } finally {
      this.frameInFlight = false
    }
  }

  private _startFrameLoop(): void {
    if (this.frameTimer) return
    const tick = () => {
      // Config read per tick — the notch "Share screen" toggle works live,
      // mid-session, without a reconnect.
      if (!getGeminiVoiceConfig().screenShare) return
      void this._sendScreenFrame(true)
    }
    this.frameTimer = setInterval(tick, SCREEN_FRAME_INTERVAL_MS)
    this.frameTimer.unref?.()
    // First frame immediately — the model should have eyes from the user's
    // first words, not 1.5s into the conversation.
    tick()
  }

  private _stopFrameLoop(): void {
    // Forget the dedup baseline so the next session's first frame always
    // goes through, even if the screen hasn't changed since this one.
    this.lastFrameBase64 = null
    if (this.frameTimer) {
      clearInterval(this.frameTimer)
      this.frameTimer = null
      // Retire this session's frame geometry — without this, the stale
      // calibration outlived the session forever and silently re-mapped any
      // later norm1000 click (e.g. from a subsequent Grok session) onto a
      // frame that no longer reflects the screen.
      this.opts.onFrameCalibration?.(null)
    }
  }

  /* ── Internals ─────────────────────────────────────────────────────────── */

  private _resetTurnState(): void {
    this.activeSegment = false
    this.segmentSamples = 0
    this.holdActive = false
    this.turnOpen = false
    this.continuationPending = false
    this.pendingTools.clear()
    this.cancelledTools.clear()
    this.turnText = ''
    this.pendingUserTranscript = ''
  }

  private _send(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return
    try {
      this.ws.send(JSON.stringify(payload))
    } catch (err) {
      log(`send failed: ${(err as Error).message}`)
    }
  }

  private _setupPayload(voice: string): Record<string, unknown> {
    const setup: Record<string, unknown> = {
      model: `models/${GEMINI_LIVE_MODEL}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
      systemInstruction: { parts: [{ text: GEMINI_VOICE_SYSTEM_PROMPT }] },
      tools: [{ functionDeclarations: geminiToolDefs() }],
      // Both transcription streams on: input feeds the voice tab's user
      // bubbles, output feeds the caption pill + transcript.
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      // Without compression, audio-only sessions hard-stop at the API's
      // 15-minute ceiling; a sliding window lets long conversations live.
      contextWindowCompression: { slidingWindow: {} },
    }
    if (this.sessionPtt) {
      // Push-to-talk: the client marks turn boundaries itself (setHold →
      // activityStart/activityEnd), so the server's VAD must be off.
      setup.realtimeInputConfig = { automaticActivityDetection: { disabled: true } }
    }
    return { setup }
  }

  private _tabsBlock(): string {
    const snapshot = formatTabsSnapshot(this.opts.tabContext.list())
    const sameAsLast = this.lastSnapshot !== null && snapshot === this.lastSnapshot
    this.lastSnapshot = snapshot
    return sameAsLast ? '<rax_crew unchanged="true"/>' : `<rax_crew>\n${snapshot}\n</rax_crew>`
  }

  private _drainCompletions(kind: 'prepended' | 'autonomous'): string | null {
    if (this.pendingCompletions.length === 0) return null
    const now = Date.now()
    const fresh = this.pendingCompletions.filter((c) => now - c.completedAt < COMPLETION_TTL_MS)
    this.pendingCompletions = []
    if (fresh.length === 0) return null
    const lines = fresh.map((c) => {
      const parts: string[] = [`[${c.agentName}]`]
      if (c.taskBrief) parts.push(`task=${JSON.stringify(clip(c.taskBrief, COMPLETION_TASK_CLIP))}`)
      if (c.result) parts.push(`result=${JSON.stringify(clip(c.result, COMPLETION_RESULT_CLIP))}`)
      else parts.push('result="(no message — agent finished silently)"')
      return parts.join(' ')
    })
    return `<agent_updates kind="${kind}">\n${lines.join('\n')}\n</agent_updates>`
  }
}

/** Same tool catalog as the direct backend, as Live API functionDeclarations. */
function geminiToolDefs(): Array<Record<string, unknown>> {
  return buildToolDefs().map((t) => {
    // Drop the Anthropic-only cache_control marker the builder sets on the
    // last tool; the Live API rejects unknown fields.
    const { name, description, input_schema } = t as {
      name: string
      description?: string
      input_schema: unknown
    }
    // rax_control_screen: realtime models emit unreliable coordinates even
    // for screens they can see, so the click path is re-shaped to take a
    // TARGET DESCRIPTION instead of x/y (the session grounds it to
    // coordinates via a vision model — see _groundedClick). x/y are removed
    // entirely so the model can't fall back to guessing numbers.
    if (name === 'rax_control_screen') {
      return {
        name,
        description:
          'Drive the user\'s real mouse and keyboard. To CLICK something, set action to "click" (or "double_click") and describe it in `target` — e.g. target="the calendar icon in the dock". You do not work in coordinates; the system sees the screen and clicks the right spot, then tells you what it clicked (or that it could not find the target — if so, look again or ask the user). For typing use action="type" with `text`; for a keypress use action="key" with `key` (+ optional `modifiers`); to scroll use action="scroll" with `dy` (negative = down). If a result says error="accessibility_denied", tell the user to approve Rax in System Settings → Privacy & Security → Accessibility.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['click', 'double_click', 'type', 'key', 'scroll', 'cursor_position'] },
            target: {
              type: 'string',
              description:
                'For click / double_click: a short natural-language description of the on-screen element to click ("the blue Get Started button", "the Safari icon in the dock", "the search field"). Required for clicks.',
            },
            button: { type: 'string', enum: ['left', 'right'] },
            text: { type: 'string', description: 'For action="type": the text to type.' },
            key: { type: 'string', description: 'For action="key": e.g. "return", "esc", "tab", "a".' },
            modifiers: { type: 'array', items: { type: 'string', enum: ['cmd', 'command', 'shift', 'alt', 'option', 'opt', 'ctrl', 'control'] } },
            dy: { type: 'integer', description: 'For action="scroll": vertical wheel delta (negative scrolls down).' },
            dx: { type: 'integer', description: 'For action="scroll": horizontal wheel delta.' },
          },
          required: ['action'],
        },
      }
    }
    return {
      name,
      description: description || '',
      parameters: input_schema,
    }
  })
}

/** PCM16 sample count of a base64 payload, from length arithmetic alone. */
function pcm16SamplesInBase64(b64: string): number {
  let padding = 0
  if (b64.endsWith('==')) padding = 2
  else if (b64.endsWith('=')) padding = 1
  return Math.max(0, Math.floor(((b64.length * 3) / 4 - padding) / 2))
}

function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? flat.substring(0, n - 1) + '…' : flat
}
