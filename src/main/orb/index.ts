import { EventEmitter } from 'events'
import { TabContextRegistry } from './tab-context'
import { OrbRpcServer, type OrbRpcInfo } from './orb-rpc'
import { OrbSession, type SubmitAttachment, type AgentCompletion } from './orb-session'
import { OrbDirectSession } from './orb-direct-session'
import { GrokVoiceSession, type GrokRendererEvent } from './grok-voice-session'
import { getGrokVoiceConfig } from './grok-voice-config'
import { GeminiVoiceSession, type GeminiRendererEvent } from './gemini-voice-session'
import { getGeminiVoiceConfig } from './gemini-voice-config'
import { isAgentId, getAgent } from '../../shared/agents'

/**
 * The orb has four backends:
 *   - CLI mode: spawn `claude -p --input-format stream-json` (the original).
 *   - Direct mode: call Anthropic's API straight from main with an in-process
 *     tool loop. Much faster TTFA, no Node cold-start, no MCP boot.
 *   - Grok voice mode: xAI's realtime speech-to-speech agent over WebSocket —
 *     replaces whisper + the turn loop + Kokoro in one hop. Opt-in from the
 *     notch settings (grok-voice-config.ts); requires the user's xAI key.
 *   - Gemini voice mode: Google's Live API, same realtime shape as Grok
 *     behind its own opt-in toggle (gemini-voice-config.ts; the two realtime
 *     toggles are mutually exclusive). Requires the user's Google AI key.
 *
 * Direct mode is the default for the orb only (tabs/pill/fullscreen are
 * untouched). Set `RAX_ORB_BACKEND=cli` to fall back. All implementations
 * intentionally expose the same surface (submitTurn / cancelTurn / warmup /
 * resetConversation / isAlive / isBusy / shutdown + 'event', 'turn-end',
 * 'session-dead' emitters) so this file is the only branch point.
 */
type OrbBackend = OrbSession | OrbDirectSession | GrokVoiceSession | GeminiVoiceSession
const ORB_BACKEND: 'direct' | 'cli' =
  (process.env.RAX_ORB_BACKEND || 'direct').toLowerCase() === 'cli' ? 'cli' : 'direct'
import type { ControlPlane } from '../claude/control-plane'
import type { MirrorAction, NormalizedEvent } from '../../shared/types'
import { log as _log } from '../logger'

function log(msg: string): void {
  _log('Orb', msg)
}

export interface OrbControllerDeps {
  controlPlane: ControlPlane
  broadcastMirror: (action: MirrorAction) => void
  showPillWindow: () => void
  getProjectPath: () => string
  /**
   * Resolve a tab's last assistant message after it goes idle. Used by the
   * `rax_send_to_tab_and_wait` RPC tool. Returns the final text once the
   * tab transitions to `idle`/`completed` again. Pass an AbortSignal to
   * tear down listeners early when the orb's MCP HTTP request is cancelled.
   */
  awaitTabIdle: (tabId: string, timeoutMs: number, signal?: AbortSignal) => Promise<{ text: string; timedOut: boolean }>
  /**
   * Whether the orb window is currently on screen. The autonomous-recap
   * flush consults this so a dismissed orb never speaks as a disembodied
   * voice with no UI anywhere; showOrbWindow re-arms the flush on summon.
   */
  isOrbVisible?: () => boolean
  /**
   * Show / hide / toggle the agents dock (undefined toggles). Returns the
   * resulting visibility. Backs the orb's `rax_set_dock` tool ('user'
   * cause — sticky intent) and the dispatch auto-show ('auto' cause — the
   * dock tucks itself away once the crew goes quiet).
   */
  setDockVisible: (visible?: boolean, cause?: 'user' | 'auto') => boolean
}

/**
 * Top-level wiring for the voice orb. Owns:
 *  - TabContextRegistry — live tab state mirror.
 *  - OrbRpcServer       — HTTP bridge with the orb's tab tools.
 *  - OrbSession         — the orb's persistent claude subprocess.
 *
 * The orb window subscribes via `'orb-event'`; the controller forwards every
 * NormalizedEvent (text_chunk, tool_call, task_complete, …) plus orb-only
 * extras like `orb_user_turn` and `orb_session_dead`.
 */
export class OrbController extends EventEmitter {
  readonly tabContext = new TabContextRegistry()
  private rpc: OrbRpcServer
  private rpcInfo: OrbRpcInfo | null = null
  private rpcStartPromise: Promise<OrbRpcInfo> | null = null
  private session: OrbBackend | null = null
  private deps: OrbControllerDeps
  private started = false
  private startPromise: Promise<void> | null = null

  // Crash-loop backoff. The previous behaviour ("session-dead → respawn
  // immediately, forever") meant a misconfigured claude binary or bad system
  // prompt would burn CPU spawning the same dying subprocess in a loop. We
  // now back off exponentially (1s, 4s, 16s) and give up after the cap so
  // the renderer can show a clear "voice agent unavailable" state instead of
  // a perpetually-busy spinner.
  private crashCount = 0
  private nextRespawnAt = 0
  private respawnTimer: NodeJS.Timeout | null = null
  private static readonly CRASH_BACKOFF_MS = [1_000, 4_000, 16_000]
  /**
   * Last model id pushed by the renderer. Stored independently of the
   * session so it survives crashes / respawns — when _createSession runs,
   * it re-applies this so the freshly-spawned backend honours the user's
   * pick without needing the renderer to re-push.
   */
  private lastRequestedModel: string | null = null

  /**
   * Tab IDs the orb is currently waiting for via rax_send_to_tab_and_wait.
   * The orb consumes the result inside its own running turn, so a separate
   * autonomous "agent finished" recap would be the orb repeating itself.
   * Populated by the wrapped awaitTabIdle below; consulted in
   * `_enqueueAgentCompletion`.
   */
  private orbAwaitedTabs = new Set<string>()

  /**
   * Last voice state reported by the renderer ('idle' | 'listening' |
   * 'transcribing' | 'thinking' | 'talking' | 'error'). Tracked so we don't
   * step on the user mid-input: the autonomous-recap flush will defer while
   * the user is actively speaking or being transcribed.
   */
  private lastVoiceState: string = 'idle'

  /**
   * Pending autonomous-recap flush. Debounced so a burst of completions
   * coalesces into a single spoken update, and re-scheduled after each
   * orb turn-end so notifications that arrived while the orb was busy
   * still surface promptly.
   */
  private flushTimer: NodeJS.Timeout | null = null

  /**
   * Wait this long for additional completions before flushing — long enough
   * for a parallel "Max + Luna finishing within 1.5s of each other" pattern
   * to coalesce into a single spoken update, short enough that the recap
   * still feels live.
   */
  private static readonly COMPLETION_BATCH_DEBOUNCE_MS = 1800

  /**
   * Short fallback re-flush delay used after the orb finishes its own turn.
   * The current turn may have been a user reply that did NOT pick up the
   * pending completions (e.g. they arrived mid-turn), so we try again
   * shortly after turn-end.
   */
  private static readonly POST_TURN_FLUSH_DELAY_MS = 700

  constructor(deps: OrbControllerDeps) {
    super()
    this.deps = deps
    // Wrap awaitTabIdle so we can track which tabs the orb is currently
    // waiting on inside its own turn. The set is consulted before queuing
    // an autonomous recap so we don't double-narrate a result the orb is
    // about to read out itself.
    const wrappedAwait = async (tabId: string, timeoutMs: number, signal?: AbortSignal) => {
      this.orbAwaitedTabs.add(tabId)
      try {
        return await deps.awaitTabIdle(tabId, timeoutMs, signal)
      } finally {
        this.orbAwaitedTabs.delete(tabId)
      }
    }
    this.rpc = new OrbRpcServer({
      tabContext: this.tabContext,
      controlPlane: deps.controlPlane,
      broadcastMirror: deps.broadcastMirror,
      showPillWindow: deps.showPillWindow,
      getProjectPath: deps.getProjectPath,
      awaitTabIdle: wrappedAwait,
      setDockVisible: deps.setDockVisible,
    })
  }

  // ─── Lifecycle ───

  /**
   * Start the local RPC HTTP server only. Idempotent. Cheap. Safe to call at
   * app boot — chat tabs need the RPC URL/secret so their MCP shim can hit
   * `/screenshot` and `/control_screen`. The orb's own claude session is NOT
   * spawned by this; call `ensureStarted()` (or `submitTurn`) for that.
   */
  async ensureRpc(): Promise<OrbRpcInfo> {
    if (this.rpcInfo) return this.rpcInfo
    if (this.rpcStartPromise) return this.rpcStartPromise
    this.rpcStartPromise = this.rpc.start()
      .then((info) => {
        this.rpcInfo = info
        return info
      })
      .finally(() => {
        this.rpcStartPromise = null
      })
    return this.rpcStartPromise
  }

  /** Last-known RPC info, or null if not started. Synchronous accessor. */
  getRpcInfoSync(): OrbRpcInfo | null {
    return this.rpcInfo
  }

  /** Start the RPC bridge + (lazily) the claude session. Idempotent. */
  async ensureStarted(): Promise<void> {
    if (this.started) return
    if (this.startPromise) return this.startPromise
    this.startPromise = this._start().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  private async _start(): Promise<void> {
    log('Starting orb controller')
    const rpcInfo = await this.ensureRpc()
    this.session = this._createSession(rpcInfo)
    this.started = true
    log('Orb controller started')
  }

  private _createSession(rpcInfo: Awaited<ReturnType<OrbRpcServer['start']>>): OrbBackend {
    // Realtime voice (user opt-in from the notch settings) replaces the
    // entire local pipeline with a speech-to-speech agent — Grok or Gemini,
    // whichever toggle is on (the settings layer keeps them exclusive; Grok
    // wins deterministically if a stale config file ever has both). Falls
    // through to the default backend when a toggle is on but no key is
    // stored yet, so the orb never goes dead while the user is mid-setup.
    const grokCfg = getGrokVoiceConfig()
    const geminiCfg = getGeminiVoiceConfig()
    const useGrok = grokCfg.enabled && grokCfg.apiKey.length > 0
    const useGemini = !useGrok && geminiCfg.enabled && geminiCfg.apiKey.length > 0
    // Direct mode talks straight to Anthropic — no CLI subprocess, no MCP
    // boot, prompt caching on the system prompt + tool schema. CLI mode is
    // kept as a fallback under RAX_ORB_BACKEND=cli so we can flip back in a
    // pinch without a rebuild.
    log(`Creating orb session [backend=${useGrok ? 'grok-voice' : useGemini ? 'gemini-voice' : ORB_BACKEND}]`)
    const session: OrbBackend = useGrok
      ? new GrokVoiceSession({
          rpc: rpcInfo,
          projectPath: this.deps.getProjectPath(),
          tabContext: this.tabContext,
          model: this.lastRequestedModel ?? undefined,
        })
      : useGemini
      ? new GeminiVoiceSession({
          rpc: rpcInfo,
          projectPath: this.deps.getProjectPath(),
          tabContext: this.tabContext,
          model: this.lastRequestedModel ?? undefined,
          // Screen-share frames register their geometry with the RPC server
          // so unit:"norm1000" clicks resolve against the frame the model is
          // actually looking at.
          onFrameCalibration: (cal) => this.rpc.setStreamCalibration(cal),
        })
      : ORB_BACKEND === 'direct'
      ? new OrbDirectSession({
          rpc: rpcInfo,
          projectPath: this.deps.getProjectPath(),
          tabContext: this.tabContext,
          model: this.lastRequestedModel ?? undefined,
        })
      : new OrbSession({
          rpc: rpcInfo,
          projectPath: this.deps.getProjectPath(),
          tabContext: this.tabContext,
          model: this.lastRequestedModel ?? undefined,
        })
    session.on('event', (evt: NormalizedEvent | { type: string; [k: string]: unknown }) =>
      this.emit('orb-event', evt),
    )
    if (session instanceof GrokVoiceSession) {
      session.on('grok-event', (evt: GrokRendererEvent) => this.emit('grok-event', evt))
    } else if (session instanceof GeminiVoiceSession) {
      session.on('gemini-event', (evt: GeminiRendererEvent) => this.emit('gemini-event', evt))
    }
    session.on('turn-end', (ok: boolean) => {
      // A successful turn means the session is healthy — clear any prior
      // crash count so a future single failure doesn't trigger long backoff.
      if (ok) this.crashCount = 0
      this.emit('orb-turn-end', ok)
      // Completions that landed mid-turn (or that weren't spliced into a
      // user reply) now get a short window to flush as an autonomous recap.
      if (session.hasPendingCompletions()) {
        this._scheduleAutonomousFlush(OrbController.POST_TURN_FLUSH_DELAY_MS)
      }
    })
    session.on('session-dead', (info: { code: number | null; signal: string | null; stderrTail: string[] }) => {
      log(`Session dead: code=${info.code} signal=${info.signal}`)
      this.emit('orb-event', {
        type: 'orb_session_dead',
        code: info.code,
        signal: info.signal,
        stderrTail: info.stderrTail,
        crashCount: this.crashCount + 1,
      })
      this._scheduleRespawn(rpcInfo)
    })
    return session
  }

  private _scheduleRespawn(rpcInfo: Awaited<ReturnType<OrbRpcServer['start']>>): void {
    // Drop a stale timer so back-to-back crashes don't queue duplicates.
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer)
      this.respawnTimer = null
    }
    this.crashCount += 1
    const idx = Math.min(this.crashCount - 1, OrbController.CRASH_BACKOFF_MS.length - 1)
    const delay = OrbController.CRASH_BACKOFF_MS[idx]
    if (this.crashCount > OrbController.CRASH_BACKOFF_MS.length) {
      log(`Session has crashed ${this.crashCount} times — giving up auto-respawn until next user action`)
      // Stay in a "no session" state. The next `submitTurn` will trigger
      // _ensureSpawned again; if the user explicitly retries we honour them.
      this.session = null
      this.nextRespawnAt = 0
      return
    }
    this.nextRespawnAt = Date.now() + delay
    log(`Respawning orb session in ${delay}ms (crash #${this.crashCount})`)
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null
      try {
        this.session = this._createSession(rpcInfo)
        this.session.warmup()
      } catch (err) {
        log(`Respawn failed: ${(err as Error).message}`)
      }
    }, delay)
    this.respawnTimer.unref?.()
  }

  shutdown(): void {
    log('Shutting down')
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer)
      this.respawnTimer = null
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.session) {
      this.session.shutdown()
      this.session = null
    }
    this.rpc.stop()
    this.started = false
  }

  // ─── Public API used by IPC ───

  async submitTurn(prompt: string, attachment?: SubmitAttachment): Promise<void> {
    await this.ensureStarted()
    if (!this.session) {
      // Backoff cap had been reached and we shed the session pointer. The
      // user is explicitly trying again, so honour them with a fresh attempt
      // and reset the crash counter — they are signalling that something has
      // changed (settings tweak, network came back, etc).
      log('submitTurn: no session — user-initiated re-attempt, resetting crash count')
      this.crashCount = 0
      const rpcInfo = await this.rpc.start()
      this.session = this._createSession(rpcInfo)
    }
    if (!this.session.isAlive()) {
      // Session died and is being respawned. Try once.
      log('submitTurn: session not alive, warming up before submit')
      this.session.warmup()
    }
    if (this.session.isBusy()) {
      // A previous turn is still draining — most commonly an autonomous
      // recap the user never saw finish, or the tail of a gracefully
      // interrupted turn. The user's spoken turn always wins: cancel and
      // wait briefly for the abort to unwind instead of bubbling a
      // "still responding" rejection into a red error toast.
      log('submitTurn: session busy — cancelling previous turn before submit')
      this.session.cancelTurn()
      const deadline = Date.now() + 4_000
      while (this.session.isBusy() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    await this.session.submitTurn(prompt, attachment)
  }

  cancelTurn(): void {
    if (!this.session) return
    this.session.cancelTurn()
  }

  /** Reset the conversation: kill the underlying claude process so the next turn starts fresh. */
  resetSession(): void {
    if (!this.session) return
    this.session.resetConversation()
    // Eagerly warm so the first post-reset turn doesn't pay spawn latency.
    this.session.warmup()
  }

  /** Eagerly spawn the claude subprocess. Called when the orb window first opens. */
  warmup(): void {
    if (!this.session) return
    this.session.warmup()
  }

  /**
   * Update the model used for the next turn. Idempotent; safe to call from
   * the renderer on every preferredModel change. The new id is also stashed
   * on the controller so a respawned session (after crash/reset) inherits
   * it without the renderer having to re-push.
   */
  setModel(modelId: string): void {
    if (!modelId) return
    this.lastRequestedModel = modelId
    if (this.session) this.session.setModel(modelId)
  }

  /** Current model id surfaced to the renderer for the picker label. */
  getModel(): string | null {
    if (this.session) {
      const m = this.session.getModel()
      if (m) return m
    }
    return this.lastRequestedModel || null
  }

  isBusy(): boolean {
    return !!this.session && this.session.isBusy()
  }

  // ─── Realtime voice sessions (ORB_GROK_* / ORB_GEMINI_* IPC) ───

  /**
   * Tear down the current backend and build a fresh one from the current
   * settings. Called when a notch realtime toggle (or its key/voice) flips
   * so the backend choice tracks the user's intent without a relaunch.
   */
  async recreateSession(): Promise<void> {
    log('Recreating orb session (settings changed)')
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer)
      this.respawnTimer = null
    }
    if (this.session) {
      this.session.shutdown()
      this.session = null
    }
    this.crashCount = 0
    const rpcInfo = await this.ensureRpc()
    this.session = this._createSession(rpcInfo)
    this.started = true
  }

  private _grokSession(): GrokVoiceSession | null {
    return this.session instanceof GrokVoiceSession ? this.session : null
  }

  private _geminiSession(): GeminiVoiceSession | null {
    return this.session instanceof GeminiVoiceSession ? this.session : null
  }

  /** Whichever realtime backend is live (they share the recap-gating and
   *  voice-session surfaces), or null when the local pipeline is active. */
  private _realtimeSession(): GrokVoiceSession | GeminiVoiceSession | null {
    return this._grokSession() ?? this._geminiSession()
  }

  /** Open the realtime socket (creating the grok backend first if needed). */
  async grokStart(): Promise<{ ok: boolean; error?: string }> {
    await this.ensureStarted()
    let grok = this._grokSession()
    if (!grok) {
      // Settings say grok but the live session predates the flip (or died) —
      // rebuild from config. If config doesn't resolve to grok, refuse.
      const cfg = getGrokVoiceConfig()
      if (!cfg.enabled) return { ok: false, error: 'Grok voice is not enabled.' }
      if (!cfg.apiKey) return { ok: false, error: 'No xAI API key — add one in the notch voice settings.' }
      await this.recreateSession()
      grok = this._grokSession()
      if (!grok) return { ok: false, error: 'Grok voice backend could not be created.' }
    }
    return grok.startVoiceSession()
  }

  /** Close the realtime socket (the backend object stays for the next start). */
  grokStop(): void {
    this._grokSession()?.endVoiceSession()
  }

  /** Renderer mic audio passthrough — base64 PCM16 mono @ 24kHz. */
  grokAppendAudio(base64Pcm: string): void {
    this._grokSession()?.appendAudio(base64Pcm)
  }

  /** Push-to-talk ⌥R edge passthrough (no-op unless the session is in PTT). */
  grokSetHold(active: boolean): void {
    this._grokSession()?.setHold(active)
  }

  /** Open the realtime socket (creating the gemini backend first if needed). */
  async geminiStart(): Promise<{ ok: boolean; error?: string }> {
    await this.ensureStarted()
    let gemini = this._geminiSession()
    if (!gemini) {
      // Settings say gemini but the live session predates the flip (or died)
      // — rebuild from config. If config doesn't resolve to gemini, refuse.
      const cfg = getGeminiVoiceConfig()
      if (!cfg.enabled) return { ok: false, error: 'Gemini voice is not enabled.' }
      if (!cfg.apiKey) return { ok: false, error: 'No Google AI API key — add one in the notch voice settings.' }
      await this.recreateSession()
      gemini = this._geminiSession()
      if (!gemini) return { ok: false, error: 'Gemini voice backend could not be created.' }
    }
    return gemini.startVoiceSession()
  }

  /** Close the realtime socket (the backend object stays for the next start). */
  geminiStop(): void {
    this._geminiSession()?.endVoiceSession()
  }

  /** Renderer mic audio passthrough — base64 PCM16 mono @ 24kHz. */
  geminiAppendAudio(base64Pcm: string): void {
    this._geminiSession()?.appendAudio(base64Pcm)
  }

  /** Push-to-talk ⌥R edge passthrough (no-op unless the session is in PTT). */
  geminiSetHold(active: boolean): void {
    this._geminiSession()?.setHold(active)
  }

  // ─── Tab context feed (called from main process event wiring) ───

  applyControlPlaneEvent(tabId: string, event: NormalizedEvent): void {
    this.tabContext.applyEvent(tabId, event)
    // After tabContext integrates the event (which sets lastAssistantMessage
    // on task_complete), surface dock-agent finishes to the orb so it can
    // voice the recap to the user.
    if (event.type === 'task_complete' && isAgentId(tabId)) {
      this._enqueueAgentCompletion(tabId)
    }
  }

  applyTabStatusChange(tabId: string, newStatus: string): void {
    this.tabContext.applyStatusChange(tabId, newStatus)
  }

  applyMirrorAction(action: MirrorAction): void {
    this.tabContext.applyMirrorAction(action)
  }

  /**
   * Renderer-pushed voice state. Used by the autonomous-recap flush so we
   * don't speak over the user mid-input. 'listening' / 'transcribing' /
   * 'thinking' all mean the user is actively engaged — defer the recap until
   * they're done; the post-turn-end re-flush picks it back up.
   */
  applyVoiceState(state: string): void {
    if (typeof state !== 'string') return
    this.lastVoiceState = state
  }

  // ─── Crew completion → autonomous recap ───

  /**
   * Build an AgentCompletion from the just-arrived task_complete event and
   * either suppress it (orb just consumed the result via send_to_tab_and_wait)
   * or hand it to the session + schedule a debounced autonomous-recap flush.
   */
  private _enqueueAgentCompletion(tabId: string): void {
    if (this.orbAwaitedTabs.has(tabId)) {
      // Orb is mid-consume of this tab's result via rax_send_to_tab_and_wait;
      // the running turn will fold it into its own response. Notifying again
      // would make the orb repeat itself.
      return
    }
    const agent = getAgent(tabId)
    if (!agent) return
    const snap = this.tabContext.get(tabId)
    if (!snap) return

    const completion: AgentCompletion = {
      agentName: agent.name,
      taskBrief: snap.lastUserMessage || null,
      result: snap.lastAssistantMessage || null,
      completedAt: Date.now(),
    }

    if (this.session) {
      this.session.pushPendingCompletion(completion)
    }
    this._scheduleAutonomousFlush(OrbController.COMPLETION_BATCH_DEBOUNCE_MS)
  }

  /**
   * Schedule (or re-schedule, debouncing) the autonomous-recap flush. The
   * flush only fires when the orb is idle AND the user isn't mid-input; if
   * either is false at fire time, we drop this attempt and rely on the
   * turn-end / next-completion path to re-arm.
   */
  private _scheduleAutonomousFlush(delayMs: number): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      if (!this.session) return
      if (!this.session.isAlive()) return
      if (!this.session.hasPendingCompletions()) return
      // Orb is talking / thinking — submitSystemTurn would reject. The next
      // turn-end will re-arm us with POST_TURN_FLUSH_DELAY_MS.
      if (this.session.isBusy()) return
      // Orb dismissed — a recap now would be a disembodied voice with no UI
      // anywhere on screen. Drop this attempt; showOrbWindow re-arms via
      // flushPendingRecaps() and the completion TTL ages out stale news.
      if (this.deps.isOrbVisible && !this.deps.isOrbVisible()) {
        log('Autonomous flush deferred — orb window hidden')
        return
      }
      // User is mid-input or the orb is still audibly speaking. 'talking'
      // matters: the session's turn ends while TTS is still draining, so
      // without it the recap splices into the tail of the previous answer —
      // and a click to silence that tail destroys the recap with it.
      //
      // Realtime backends (Grok/Gemini): the renderer's voice-state
      // heuristic doesn't apply — 'listening' is the RESTING state of an
      // open realtime session, so gating on it would defer recaps forever.
      // The session itself knows whether the user is mid-sentence; ask it.
      const realtime = this._realtimeSession()
      if (realtime) {
        if (!realtime.canAcceptSystemTurn()) {
          log('Autonomous flush deferred — realtime session busy or user speaking')
          this._scheduleAutonomousFlush(1_500)
          return
        }
      } else if (
        this.lastVoiceState === 'listening' ||
        this.lastVoiceState === 'transcribing' ||
        this.lastVoiceState === 'thinking' ||
        this.lastVoiceState === 'talking'
      ) {
        log(`Autonomous flush deferred — voice state '${this.lastVoiceState}'`)
        // Re-arm rather than drop: TTS overhang routinely outlives the
        // 700ms post-turn re-flush and nothing else would retry. Bounded —
        // once the completions age past their TTL the timer body bails.
        this._scheduleAutonomousFlush(1_500)
        return
      }
      this.session.submitSystemTurn().catch((err: Error) => {
        log(`submitSystemTurn failed: ${err.message}`)
      })
    }, delayMs)
    this.flushTimer.unref?.()
  }

  /**
   * Re-arm the autonomous-recap flush. Called when the orb window is
   * summoned so recaps that piled up while it was hidden get spoken now
   * that there's a visible surface for them.
   */
  flushPendingRecaps(): void {
    this._scheduleAutonomousFlush(800)
  }
}
