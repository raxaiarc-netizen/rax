import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import {
  buildToolDefs,
  executeTool,
  type ToolExecContext,
  type ToolResultContent,
} from './orb-direct-tools'
import { formatTabsSnapshot, type TabContextRegistry } from './tab-context'
import { describeScreenshotForGrok, locateTargetForGrok } from './grok-vision'
import { captureScreenForOrb, isCaptureFailure } from './screen-capture'
import { getGrokVoiceConfig, GROK_REALTIME_MODEL } from './grok-voice-config'
import type { OrbRpcInfo } from './orb-rpc'
import type { AgentCompletion, SubmitAttachment } from './orb-session'
import { log as _log } from '../logger'

function log(msg: string): void {
  _log('GrokVoice', msg)
}

// Env override mirrors GROK_REALTIME_MODEL: lets users route through a
// proxy and lets the protocol harness point at a local mock.
const GROK_REALTIME_URL = process.env.RAX_GROK_REALTIME_URL || 'wss://api.x.ai/v1/realtime'
const COMPLETION_TASK_CLIP = 220
const COMPLETION_RESULT_CLIP = 700
const COMPLETION_TTL_MS = 5 * 60 * 1000
/** Keep tool outputs sane for a speech model's context. */
const TOOL_OUTPUT_CLIP = 16_000
/** Below this grounding confidence we decline to click rather than guess —
 *  a wrong click is worse than "I couldn't find it." */
const MIN_CLICK_CONFIDENCE = 0.4
/** Don't speak an autonomous recap on the heels of the user's own speech. */
const SYSTEM_TURN_QUIET_MS = 2_500
const CONNECT_TIMEOUT_MS = 12_000
/** Push-to-talk: a hold shorter than this is a fat-finger, not an utterance —
 *  committing a near-empty input buffer makes the API error (and the model
 *  answer dead air). The renderer uses the same floor to decide whether a
 *  response is coming (see realtime-voice.ts PTT_MIN_AUDIO_MS). */
const PTT_MIN_AUDIO_MS = 120

/**
 * Grok-specific system prompt. NOT the shared SYSTEM_PROMPT_TEXT: live
 * probing showed the realtime voice model stops emitting function calls
 * entirely under the full 9.6KB orb prompt — its NARRATION style-anchor
 * table ("rax_screenshot() → 'okay, quick look at your screen.'") teaches
 * the model to produce the SENTENCES INSTEAD OF THE CALLS, and "speak one
 * sentence, then call" ordering lets the speech satisfy the request.
 * (Bisect: tiny prompt + all 16 tools → calls fine; full prompt + 2 tools
 * → narrates "I'll use the bash tool" and never calls.)
 *
 * This compact version keeps the persona, the crew, the tool semantics and
 * the agent-updates contract, but is call-first and names the failure mode
 * explicitly. Validated live 5/5: open-site (bash), file write, screenshot,
 * crew dispatch with verbatim userRequest, and pure chat with no spurious
 * calls.
 */
export const GROK_VOICE_SYSTEM_PROMPT = [
  "You are the Rax orb — the user's voice assistant on their Mac, running as a realtime speech-to-speech agent, and the conductor of a fixed crew of five Rax agents who do heavy work in the background.",
  '',
  'ACT, DON\'T DESCRIBE: your functions are live and real; words alone do nothing. When the user asks you to do, open, check, run, fix, create, or find anything, EMIT THE FUNCTION CALL FIRST — the result comes back to you and the conversation continues, so you lose nothing by calling immediately. Never speak phrases like "I\'ll use the bash tool" or "opening it now" as a substitute for the call: a response that promises an action but contains no function call is a hard failure. Never offer-and-wait either ("I could check…", "I can have Nova look at it") — do the thing, then report. At most a few words of acknowledgment, then the call, then the real result.',
  '',
  "Your output is spoken aloud. One or two short sentences, plain conversational English. No markdown, no lists, no emoji. Don't read file paths, URLs, secrets, or raw pixel coordinates aloud — say what something IS, not its numbers.",
  '',
  'TOOLS on the user\'s real Mac (permissions bypassed — confirm before anything clearly destructive):',
  '  - bash — shell: open apps and sites (open "https://…"), git, npm, curl, files, anything terminal.',
  '  - read / write / edit — files. grep / glob — search (silent, no narration needed).',
  '  - rax_screenshot — your EYES: returns screen metadata, the cursor\'s exact image-pixel coordinates, and a trusted vision description of what\'s on screen and what the cursor is on. Call it whenever the user asks about their screen ("what am I looking at", "what\'s my mouse on") and answer from the description — e.g. "you\'re hovering over the Save button in the toolbar."',
  '  - rax_control_screen — real mouse and keyboard. To CLICK, just describe the target: action="click", target="the calendar icon in the dock". You never deal in coordinates — the system sees the screen and clicks the right spot, then tells you what it clicked or that it couldn\'t find it (then look again or ask the user to describe it). Type with action="type" + text; press keys with action="key" + key; scroll with action="scroll" + dy. If a result says accessibility_denied, tell the user to approve Rax in System Settings → Privacy & Security → Accessibility.',
  '  - You can SEE the screen yourself via rax_screenshot — answer screen questions directly. Do not punt them to the crew.',
  '',
  'DO IT YOURSELF FIRST: you have real hands and eyes. The DEFAULT is to handle the request with your own tools (bash, files, screenshot, control_screen) and answer. Only involve the crew when the user EXPLICITLY asks for it — names a teammate ("ask Max to…", "have Luna research…"), or asks for long background work to run while they keep talking. Never volunteer the crew for something you can just do, and never say things like "I\'ll hand this to Max" unless the user asked you to. When you do dispatch, you must already know the task — never call rax_send_to_tab with a vague or empty brief just because a name came up.',
  '',
  'YOUR CREW — five real, named teammates (never call them "tabs" or numbers), for when the user asks:',
  '  Max (heavy lifter: bulk work, long builds) · Alex (architect: design, refactors) · Luna (researcher: deep dives) · Nova (spark: quick experiments) · Zara (closer: polish, ship-it).',
  "  - rax_list_tabs / rax_read_tab (silent) — check who's busy and what they said. The crew snapshot is NOT auto-attached in this mode; call rax_list_tabs when the user asks about the crew.",
  '  - rax_send_to_tab / rax_send_to_tab_and_wait — dispatch a CONCRETE task by NAME (tab="Max"), only when asked. The crew member heard NOTHING of this conversation: write the prompt like a ticket — WHAT to do, WHERE (file paths, app, area of the codebase) when you know it, and what DONE looks like. Never send a bare topic like "fix the bug". ALWAYS pass userRequest with the user\'s verbatim words, and context with constraints or paths you know; the project directory is attached automatically. Use the _and_wait variant when you need their answer to reply. Tell the user who you handed it to.',
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
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: string, listener: (event: { data?: unknown; code?: number; reason?: string; message?: string }) => void): void
}

type NodeWebSocketCtor = new (
  url: string,
  // undici extension: { headers } — the standard ctor takes protocols here.
  options?: { headers?: Record<string, string> },
) => NodeWebSocket

const WS_OPEN = 1

export interface GrokVoiceSessionOptions {
  rpc: OrbRpcInfo
  projectPath: string
  tabContext: TabContextRegistry
  model?: string
}

/**
 * Renderer-facing event pushed over ORB_GROK_EVENT. The orb window drives
 * its mic/playback/state machinery from these; the standard 'event' stream
 * (orb_user_turn / text_chunk / tool_call / task_complete) keeps feeding the
 * voice-tab transcript + caption pill exactly like the other two backends.
 */
export interface GrokRendererEvent {
  type:
    | 'ready'
    | 'speech_started'
    | 'speech_stopped'
    | 'user_transcript'
    | 'response_started'
    | 'audio'
    /** Assistant transcript delta. `startTime` (when present) is seconds
     *  into THIS response's audio where the text begins — the renderer
     *  phase-locks captions to playback with it. */
    | 'text'
    | 'tool_call'
    | 'response_done'
    | 'error'
    | 'closed'
  [k: string]: unknown
}

/**
 * Third orb backend: xAI's Grok Voice Agent API over a realtime WebSocket.
 *
 * The whole local pipeline — whisper STT, the claude/Anthropic turn loop and
 * Kokoro TTS — is replaced by one speech-to-speech session with server-side
 * VAD and barge-in. The renderer streams raw PCM16 mic audio up via
 * `appendAudio` and plays the PCM16 deltas this class forwards down; tools
 * and the system prompt are the SAME ones the direct backend uses (executed
 * in-process via `executeTool`), so the agent's abilities don't change with
 * the transport.
 *
 * Exposes the same surface as OrbSession / OrbDirectSession so OrbController
 * stays the single branch point:
 *   submitTurn / cancelTurn / warmup / resetConversation / isAlive / isBusy /
 *   shutdown / setModel / getModel / pushPendingCompletion /
 *   hasPendingCompletions / submitSystemTurn
 *   + 'event', 'turn-end', 'session-dead' emitters.
 *
 * Voice-session specific surface (wired through new ORB_GROK_* IPC):
 *   startVoiceSession / endVoiceSession / appendAudio + 'grok-event' emitter.
 */
export class GrokVoiceSession extends EventEmitter {
  private opts: GrokVoiceSessionOptions
  private ws: NodeWebSocket | null = null
  /** session.update has been sent — safe to stream audio. */
  private wsReady = false
  /** endVoiceSession was called — the next close event is expected. */
  private closing = false

  private sessionId: string | null = null
  /** Between response.created and response.done. */
  private activeResponse = false
  /** call_ids of tools currently executing locally. */
  private pendingTools = new Set<string>()
  /** call_ids already dispatched — dedupes the overlapping event shapes
   *  (function_call_arguments.done + output_item.done both describe the
   *  same call). */
  private seenCallIds = new Set<string>()
  /** Tool output(s) submitted; the continuation response.create is owed.
   *  Per the API contract, ALL pending calls must resolve before it. */
  private continuationDue = false
  /** Continuation response.create sent; cleared on the next response.created. */
  private continuationInFlight = false
  private userSpeaking = false
  private lastUserSpeechAt = 0
  /** Push-to-talk mode, snapshotted at connect (the session.update sent then
   *  decides VAD vs manual turns; flipping the setting recreates the backend). */
  private sessionPtt = false
  /** ⌥R is currently held (PTT mode only). */
  private holdActive = false
  /** Milliseconds of mic audio appended during the current hold. */
  private heldAudioMs = 0
  /** Whether the current chain of responses is an open spoken turn (cleared
   *  when a response finishes with no tool continuation pending). */
  private turnOpen = false
  private toolIndex = 0
  private responseText = ''
  /** Cumulative server transcription of the user's current utterance. The
   *  server re-sends it with corrections, so we stash and emit ONE
   *  orb_user_turn when the model commits to responding (response.created)
   *  — emitting per event produced duplicate bubbles in the voice tab. */
  private pendingUserTranscript = ''
  /** Server event types already logged as unhandled (once each). */
  private loggedUnknownTypes = new Set<string>()

  private pendingCompletions: AgentCompletion[] = []
  private lastSnapshot: string | null = null

  constructor(opts: GrokVoiceSessionOptions) {
    super()
    this.opts = opts
  }

  /* ── OrbBackend surface (matches OrbSession / OrbDirectSession) ────────── */

  /**
   * Text-input turn. Not used by the renderer's voice flow in Grok mode (the
   * audio stream carries the user's words), but the controller contract
   * requires it and it keeps typed/system entry points functional.
   */
  async submitTurn(prompt: string, _attachment?: SubmitAttachment): Promise<void> {
    const trimmed = prompt.trim()
    if (!trimmed) return
    if (!this.isAlive()) {
      throw new Error('Grok voice session is not connected — click the notch to start one.')
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
    this._send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: wrapped }] },
    })
    this._send({ type: 'response.create' })
  }

  cancelTurn(): void {
    if (!this.isAlive()) return
    log('Cancelling in-flight response')
    this._send({ type: 'response.cancel' })
  }

  isBusy(): boolean {
    return (
      this.activeResponse ||
      this.pendingTools.size > 0 ||
      this.continuationDue ||
      this.continuationInFlight
    )
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
   * No-op: a Grok session only exists while the user is actually in a voice
   * conversation. Eagerly opening the socket at app boot would start a
   * billed realtime session with no mic attached.
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
   * Gate the controller's autonomous-recap flush. The renderer's voice-state
   * heuristic doesn't work for this backend ('listening' is the resting
   * state of an open session), so the session reports directly: connected,
   * idle, the user isn't mid-sentence, and a respectful beat has passed
   * since they last spoke.
   */
  canAcceptSystemTurn(): boolean {
    return (
      this.isAlive() &&
      !this.isBusy() &&
      !this.userSpeaking &&
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

    log('submitSystemTurn — speaking crew recap through the live Grok session')
    this.emit('event', { type: 'orb_user_turn', text: '', autonomous: true })
    this.turnOpen = true
    this._send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: wrapped }] },
    })
    this._send({ type: 'response.create' })
  }

  /* ── Voice-session lifecycle (ORB_GROK_* IPC surface) ──────────────────── */

  /**
   * Open the realtime WebSocket and configure the session. Resolves once the
   * socket is open and session.update is sent; 'grok-event' { type:'ready' }
   * follows when the server acks with session.created.
   */
  async startVoiceSession(): Promise<{ ok: boolean; error?: string }> {
    if (this.ws && this.ws.readyState === WS_OPEN) return { ok: true }

    const cfg = getGrokVoiceConfig()
    if (!cfg.apiKey) {
      return { ok: false, error: 'No xAI API key — add one in the notch voice settings.' }
    }
    const WebSocketCtor = (globalThis as Record<string, unknown>).WebSocket as
      | NodeWebSocketCtor
      | undefined
    if (typeof WebSocketCtor !== 'function') {
      return { ok: false, error: 'This build lacks WebSocket support in the main process.' }
    }

    this.closing = false
    this.wsReady = false
    this._resetTurnState()
    this.sessionPtt = cfg.pushToTalk

    const url = `${GROK_REALTIME_URL}?model=${encodeURIComponent(GROK_REALTIME_MODEL)}`
    log(`Connecting ${url}`)

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
        settle({ ok: false, error: 'Timed out connecting to the Grok realtime API.' })
      }, CONNECT_TIMEOUT_MS)
      timeout.unref?.()

      let ws: NodeWebSocket
      try {
        ws = new WebSocketCtor(url, { headers: { Authorization: `Bearer ${cfg.apiKey}` } })
      } catch (err) {
        clearTimeout(timeout)
        settle({ ok: false, error: `WebSocket failed: ${(err as Error).message}` })
        return
      }
      this.ws = ws

      ws.addEventListener('open', () => {
        if (this.ws !== ws) return
        log('Socket open — sending session.update')
        this.sessionId = randomUUID()
        try {
          ws.send(JSON.stringify(this._sessionUpdatePayload(cfg.voice)))
        } catch (err) {
          clearTimeout(timeout)
          settle({ ok: false, error: `Failed to configure session: ${(err as Error).message}` })
          return
        }
        this.wsReady = true
        clearTimeout(timeout)
        // session_init keeps the voice-tab transcript anchored the same way
        // the other two backends do on their first turn.
        this.emit('event', {
          type: 'session_init',
          sessionId: this.sessionId,
          tools: buildToolDefs().map((t) => t.name),
          model: GROK_REALTIME_MODEL,
          mcpServers: [],
          skills: [],
          version: 'grok-voice',
        })
        settle({ ok: true })
      })

      ws.addEventListener('message', (event) => {
        if (this.ws !== ws) return
        const raw = typeof event.data === 'string' ? event.data : ''
        if (!raw) return
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(raw) as Record<string, unknown>
        } catch {
          return
        }
        this._handleServerEvent(parsed)
      })

      ws.addEventListener('error', (event) => {
        if (this.ws !== ws) return
        const msg = String(event?.message || 'WebSocket error')
        log(`Socket error: ${msg}`)
        clearTimeout(timeout)
        // A failed HANDSHAKE (non-101 — bad key, network block) fires
        // 'error' but, in undici, no 'close' after it. Without this the
        // session would hold a dead socket forever. Mid-session errors
        // (wsReady) do get a close event — let that path run the teardown.
        if (!this.wsReady) {
          this.ws = null
          settle({
            ok: false,
            error:
              'Could not connect to Grok — check your xAI API key in the notch settings (and your network).',
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
        const wasExpected = this.closing
        this.ws = null
        this.wsReady = false
        this.closing = false
        const hadOpenTurn = this.isBusy() || this.turnOpen
        this._resetTurnState()
        if (hadOpenTurn) this.emit('turn-end', false)
        this.emit('grok-event', {
          type: 'closed',
          expected: wasExpected,
          code,
          reason: reason.slice(0, 300),
        } satisfies GrokRendererEvent)
        if (!wasExpected) {
          // 1008-ish policy closes are nearly always a bad/expired key —
          // surface something the user can act on.
          const hint =
            code === 1008 || /auth|401|403|key/i.test(reason)
              ? 'Grok rejected the connection — check your xAI API key in the notch settings.'
              : `Grok voice connection lost (code ${code}).`
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

  /** Renderer mic audio — base64 PCM16 mono @ 24kHz. */
  appendAudio(base64Pcm: string): void {
    if (!this.isAlive() || !base64Pcm) return
    if (this.sessionPtt) {
      // The renderer gates capture to the hold window, but a chunk can race
      // the release — count only what belongs to the current hold.
      if (!this.holdActive) return
      this.heldAudioMs += pcm16Base64Ms(base64Pcm)
    }
    this._send({ type: 'input_audio_buffer.append', audio: base64Pcm })
  }

  /**
   * Push-to-talk turn boundaries (⌥R edges, forwarded from the renderer).
   * Only meaningful when the session was opened with pushToTalk on — the
   * session.update sent at connect disabled server VAD, so turn-taking is
   * entirely these two signals: hold = the user is talking (cancel anything
   * the orb is saying), release = commit the buffered audio and ask for the
   * answer. The synthesized speech_started/stopped events keep the shared
   * renderer client's playback-flush and state machinery identical to what
   * server VAD drives in open-mic mode.
   */
  setHold(active: boolean): void {
    if (!this.isAlive() || !this.sessionPtt) return
    if (active === this.holdActive) return
    this.holdActive = active
    this.lastUserSpeechAt = Date.now()
    if (active) {
      this.userSpeaking = true
      this.heldAudioMs = 0
      // Barge-in by key: with VAD off the server won't interrupt itself.
      if (this.activeResponse) this._send({ type: 'response.cancel' })
      // Drop any stale buffered audio (e.g. a previous too-short hold).
      this._send({ type: 'input_audio_buffer.clear' })
      this.pendingUserTranscript = ''
      this.emit('grok-event', { type: 'speech_started' } satisfies GrokRendererEvent)
    } else {
      this.userSpeaking = false
      this.emit('grok-event', { type: 'speech_stopped' } satisfies GrokRendererEvent)
      if (this.heldAudioMs >= PTT_MIN_AUDIO_MS) {
        // response.created sets turnOpen + commits the transcript bubble.
        this._send({ type: 'input_audio_buffer.commit' })
        this._send({ type: 'response.create' })
      } else {
        // Tap, not talk — clear instead of committing dead air.
        this._send({ type: 'input_audio_buffer.clear' })
      }
      this.heldAudioMs = 0
    }
  }

  isVoiceSessionActive(): boolean {
    return this.isAlive()
  }

  /* ── Server event handling ─────────────────────────────────────────────── */

  private _handleServerEvent(evt: Record<string, unknown>): void {
    const type = String(evt.type || '')
    switch (type) {
      case 'session.created': {
        log('session.created')
        this.emit('grok-event', { type: 'ready' } satisfies GrokRendererEvent)
        // Recaps that piled up while no session existed get spoken once the
        // user opens one — after a short beat so the greeting doesn't talk
        // over the user's first words.
        if (this.hasPendingCompletions()) {
          const t = setTimeout(() => {
            this.submitSystemTurn().catch((err: Error) => log(`connect-flush recap failed: ${err.message}`))
          }, 1_200)
          t.unref?.()
        }
        break
      }

      case 'session.updated':
        log('session.updated — config acknowledged')
        break

      case 'input_audio_buffer.speech_started': {
        this.userSpeaking = true
        this.lastUserSpeechAt = Date.now()
        // A new utterance starts a fresh transcription stream.
        this.pendingUserTranscript = ''
        // Server VAD interrupts any in-flight response itself; the renderer
        // flushes its local playback and captions on this signal.
        this.emit('grok-event', { type: 'speech_started' } satisfies GrokRendererEvent)
        break
      }

      case 'input_audio_buffer.speech_stopped': {
        this.userSpeaking = false
        this.lastUserSpeechAt = Date.now()
        this.emit('grok-event', { type: 'speech_stopped' } satisfies GrokRendererEvent)
        break
      }

      // The user's words, transcribed server-side. `.updated` arrives many
      // times per utterance with a CUMULATIVE transcript (later events
      // correct earlier ones), so we only stash here — the single
      // orb_user_turn for the voice tab is emitted on response.created,
      // when the model commits to answering this utterance.
      case 'conversation.item.input_audio_transcription.updated':
      case 'conversation.item.input_audio_transcription.completed':
      case 'conversation.item.audio_transcription.completed': {
        const transcript = String(
          (evt as { transcript?: unknown }).transcript ||
            (evt as { item?: { transcript?: unknown } }).item?.transcript ||
            '',
        ).trim()
        if (transcript) {
          this.pendingUserTranscript = transcript
          this.emit('grok-event', { type: 'user_transcript', text: transcript } satisfies GrokRendererEvent)
        }
        break
      }

      case 'response.created': {
        this.activeResponse = true
        this.continuationInFlight = false
        this.turnOpen = true
        this.responseText = ''
        // Commit the user's spoken turn to the transcript mirror exactly
        // once, with the final corrected text. Tool-continuation responses
        // arrive with an empty stash and skip this.
        if (this.pendingUserTranscript) {
          this.emit('event', { type: 'orb_user_turn', text: this.pendingUserTranscript })
          this.pendingUserTranscript = ''
        }
        this.emit('grok-event', { type: 'response_started' } satisfies GrokRendererEvent)
        break
      }

      case 'response.output_audio.delta':
      case 'response.audio.delta': {
        const delta = String((evt as { delta?: unknown }).delta || '')
        if (delta) {
          this.emit('grok-event', { type: 'audio', base64: delta } satisfies GrokRendererEvent)
        }
        break
      }

      // Spoken-text transcription of the assistant's audio. Carries
      // `start_time` — seconds into this response's audio where the text
      // begins — which the renderer uses to phase-lock captions to the
      // actual playback. Names vary across spec revisions.
      case 'response.text.delta':
      case 'response.output_text.delta':
      case 'response.audio_transcript.delta':
      case 'response.output_audio_transcript.delta': {
        const delta = String((evt as { delta?: unknown }).delta || '')
        if (!delta) break
        this.responseText += delta
        this.emit('event', { type: 'text_chunk', text: delta })
        const rawStart = Number((evt as { start_time?: unknown }).start_time)
        this.emit('grok-event', {
          type: 'text',
          delta,
          startTime: Number.isFinite(rawStart) ? rawStart : null,
        } satisfies GrokRendererEvent)
        break
      }

      case 'response.function_call_arguments.done': {
        const name = String((evt as { name?: unknown }).name || '')
        const callId = String((evt as { call_id?: unknown }).call_id || '')
        const argsJson = String((evt as { arguments?: unknown }).arguments || '{}')
        if (name && callId && !this.seenCallIds.has(callId)) {
          this.seenCallIds.add(callId)
          void this._runTool(name, callId, argsJson)
        }
        break
      }

      // Safety net for spec drift: a completed function_call item carries
      // the same name/call_id/arguments. seenCallIds dedupes against the
      // event above (observed live: both fire for one call).
      case 'response.output_item.done': {
        const item = (evt as { item?: { type?: string; status?: string; call_id?: string; name?: string; arguments?: string } }).item
        if (
          item?.type === 'function_call' &&
          item.status === 'completed' &&
          item.call_id &&
          item.name &&
          !this.seenCallIds.has(item.call_id)
        ) {
          this.seenCallIds.add(item.call_id)
          void this._runTool(item.name, item.call_id, String(item.arguments || '{}'))
        }
        break
      }

      case 'response.done': {
        this.activeResponse = false
        this.emit('grok-event', { type: 'response_done' } satisfies GrokRendererEvent)
        this._maybeContinue()
        this._maybeCloseTurn()
        break
      }

      case 'error': {
        const err = (evt as { error?: { message?: unknown; code?: unknown } }).error
        const message = String(err?.message || (evt as { message?: unknown }).message || 'Grok realtime error')
        log(`Server error event: ${JSON.stringify(evt).slice(0, 400)}`)
        // Per-event hiccups (e.g. a malformed cancel) shouldn't tear the
        // session down — surface fatal-looking ones, log the rest.
        if (/auth|key|quota|credit|rate|limit|invalid_request/i.test(message)) {
          this.emit('grok-event', { type: 'error', message } satisfies GrokRendererEvent)
          this.emit('event', { type: 'error', message, isError: true, sessionId: this.sessionId })
        }
        break
      }

      // High-frequency / informational events we deliberately ignore
      // (observed live; listed so they don't hit the unknown-type log).
      case 'ping':
      case 'conversation.created':
      case 'conversation.item.added':
      case 'response.output_item.added':
      case 'response.content_part.added':
      case 'response.content_part.done':
      case 'response.output_audio.done':
      case 'response.output_audio_transcript.done':
      case 'response.function_call_arguments.delta':
      case 'input_audio_buffer.committed':
        break

      default: {
        // Unknown types get logged once each — silence here is how the
        // first round of tool-call debugging went blind.
        if (!this.loggedUnknownTypes.has(type)) {
          this.loggedUnknownTypes.add(type)
          log(`Unhandled server event '${type}': ${JSON.stringify(evt).slice(0, 300)}`)
        }
        break
      }
    }
  }

  /**
   * Send the continuation response.create once EVERY pending tool has
   * resolved and the triggering response has fully finished — the API
   * contract requires all function outputs before the next response.
   */
  private _maybeContinue(): void {
    if (!this.continuationDue) return
    if (this.activeResponse || this.pendingTools.size > 0) return
    if (!this.isAlive()) return
    this.continuationDue = false
    this.continuationInFlight = true
    this._send({ type: 'response.create' })
  }

  /** One task_complete per spoken turn, only when no continuation is owed. */
  private _maybeCloseTurn(): void {
    if (!this.turnOpen) return
    if (this.activeResponse || this.pendingTools.size > 0 || this.continuationDue || this.continuationInFlight) {
      return
    }
    this.turnOpen = false
    this.emit('event', {
      type: 'task_complete',
      result: this.responseText,
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

  private async _runTool(name: string, callId: string, argsJson: string): Promise<void> {
    this.pendingTools.add(callId)
    log(`Tool call: ${name} (${callId})`)
    this.emit('event', { type: 'tool_call', toolName: name, toolId: callId, index: this.toolIndex++ })
    this.emit('grok-event', { type: 'tool_call', name } satisfies GrokRendererEvent)

    let input: Record<string, unknown> = {}
    try {
      input = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {}
    } catch {
      input = {}
    }

    const ctx: ToolExecContext = {
      projectPath: this.opts.projectPath,
      rpc: { url: this.opts.rpc.url, secret: this.opts.rpc.secret },
    }

    let res: ToolResultContent
    try {
      res = await this._executeGrokTool(name, input, ctx)
    } catch (err) {
      res = { kind: 'text', text: `Error: ${(err as Error).message}`, isError: true }
    }
    // The realtime API takes a string output, so image results can't ride
    // along directly. The vision sidecar (grok-vision.ts) looks at the
    // screenshot and the description rides back inside the tool output —
    // working eyes in one tool hop. When no sidecar credentials exist, an
    // honest "content unknown" note keeps the model from aiming blind.
    let output: string
    if (res.kind === 'image') {
      let vision: string | null = null
      try {
        vision = await describeScreenshotForGrok(res.base64, res.mimeType, res.text || '')
      } catch {
        vision = null
      }
      output = res.text || 'Screenshot captured.'
      output += vision
        ? `\n\nWHAT THE SCREENSHOT SHOWS (a vision model looked at it for you — trust this):\n${vision}`
        : '\n(No vision sidecar available — the image content is unknown to you. The cursor coordinates above are reliable; for visual inspection dispatch a crew member.)'
    } else {
      output = res.text
    }
    this.pendingTools.delete(callId)
    if (output.length > TOOL_OUTPUT_CLIP) {
      output = output.slice(0, TOOL_OUTPUT_CLIP) + `\n…(truncated ${output.length - TOOL_OUTPUT_CLIP} chars)`
    }

    if (!this.isAlive()) {
      log(`Tool ${name} finished after session close — result dropped`)
      return
    }

    log(`Tool done: ${name} (${callId}) — ${output.length} chars${res.isError ? ' [error]' : ''}`)
    this._send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output },
    })
    // Continuation: the model picks the conversation back up with the tool
    // result in context — once ALL parallel calls have resolved and the
    // triggering response has closed.
    this.continuationDue = true
    this._maybeContinue()
  }

  /**
   * Tool dispatch with the Grok-mode click override. The blind realtime model
   * can't read pixel coordinates, so a click arrives as a `target` DESCRIPTION
   * ("the calendar icon in the dock"). We screenshot, ask a vision model that
   * SEES the pixels for the point (the same mechanism that makes the default
   * orb click accurately), then click via the calibrated norm1000 path.
   * Everything else passes straight through to the shared executor.
   */
  private async _executeGrokTool(
    name: string,
    input: Record<string, unknown>,
    ctx: ToolExecContext,
  ): Promise<ToolResultContent> {
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
    // Direct capture of the display under the CURSOR (where the user is
    // actually working — the RPC screenshot route only does the main
    // display), red ring OFF so it can't occlude or bias the target search.
    // maxEdge 1280 keeps the image under the Anthropic API's resize
    // threshold, so the grounder model sees these exact pixels and its
    // pixel-coordinate answer maps 1:1 through this capture's calibration.
    const shot = await captureScreenForOrb({
      display: 'cursor',
      downscale: true,
      annotateCursor: false,
      maxEdge: 1280,
    })
    if (isCaptureFailure(shot)) {
      return { kind: 'text', text: `Couldn't capture the screen to find "${target}": ${shot.message}`, isError: true }
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
    // was read from — no shared calibration caches involved.
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

  /* ── Internals ─────────────────────────────────────────────────────────── */

  private _resetTurnState(): void {
    this.activeResponse = false
    this.pendingTools.clear()
    this.seenCallIds.clear()
    this.continuationDue = false
    this.continuationInFlight = false
    this.userSpeaking = false
    this.holdActive = false
    this.heldAudioMs = 0
    this.turnOpen = false
    this.responseText = ''
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

  private _sessionUpdatePayload(voice: string): Record<string, unknown> {
    return {
      type: 'session.update',
      session: {
        voice,
        instructions: GROK_VOICE_SYSTEM_PROMPT,
        // Push-to-talk disables server VAD entirely: setHold() owns the turn
        // boundaries (manual buffer commit + response.create on key release).
        turn_detection: this.sessionPtt
          ? null
          : {
              type: 'server_vad',
              threshold: 0.85,
              silence_duration_ms: 500,
              prefix_padding_ms: 333,
            },
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24_000 },
            transcription: { language_hint: 'en' },
          },
          output: {
            format: { type: 'audio/pcm', rate: 24_000 },
            speed: 1.0,
          },
        },
        tools: grokToolDefs(),
      },
    }
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

/** Same tool catalog as the direct backend, in OpenAI Realtime function shape.
 *  Exported for live protocol probing. */
export function grokToolDefs(): Array<Record<string, unknown>> {
  return buildToolDefs().map((t) => {
    // Drop the Anthropic-only cache_control marker the builder sets on the
    // last tool; the realtime API rejects unknown fields.
    const { name, description, input_schema } = t as {
      name: string
      description?: string
      input_schema: unknown
    }
    // rax_control_screen: the realtime model is blind to pixels, so its
    // click path is re-shaped to take a TARGET DESCRIPTION instead of x/y
    // (the session grounds it to coordinates via a vision model). x/y are
    // removed entirely so the model can't fall back to guessing numbers.
    if (name === 'rax_control_screen') {
      return {
        type: 'function',
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
      type: 'function',
      name,
      description: description || '',
      parameters: input_schema,
    }
  })
}

function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? flat.substring(0, n - 1) + '…' : flat
}

/** Milliseconds of PCM16@24kHz in a base64 payload, from length arithmetic. */
function pcm16Base64Ms(b64: string): number {
  let padding = 0
  if (b64.endsWith('==')) padding = 2
  else if (b64.endsWith('=')) padding = 1
  const samples = Math.max(0, Math.floor(((b64.length * 3) / 4 - padding) / 2))
  return samples / 24
}
