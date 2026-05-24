import { EventEmitter } from 'events'
import { TabContextRegistry } from './tab-context'
import { OrbRpcServer, type OrbRpcInfo } from './orb-rpc'
import { OrbSession, type SubmitAttachment, type AgentCompletion } from './orb-session'
import { OrbDirectSession } from './orb-direct-session'
import { isAgentId, getAgent } from '../../shared/agents'

/**
 * The orb has two backends:
 *   - CLI mode: spawn `claude -p --input-format stream-json` (the original).
 *   - Direct mode: call Anthropic's API straight from main with an in-process
 *     tool loop. Much faster TTFA, no Node cold-start, no MCP boot.
 *
 * Direct mode is the new default for the orb only (tabs/pill/fullscreen are
 * untouched). Set `RAX_ORB_BACKEND=cli` to fall back. The two implementations
 * intentionally expose the same surface (submitTurn / cancelTurn / warmup /
 * resetConversation / isAlive / isBusy / shutdown + 'event', 'turn-end',
 * 'session-dead' emitters) so this file is the only branch point.
 */
type OrbBackend = OrbSession | OrbDirectSession
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
    // Direct mode talks straight to Anthropic — no CLI subprocess, no MCP
    // boot, prompt caching on the system prompt + tool schema. CLI mode is
    // kept as a fallback under RAX_ORB_BACKEND=cli so we can flip back in a
    // pinch without a rebuild.
    log(`Creating orb session [backend=${ORB_BACKEND}]`)
    const session: OrbBackend = ORB_BACKEND === 'direct'
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
      // User is mid-input ('listening' / 'transcribing' / 'thinking'). Don't
      // step on them; the recap will get spliced into their turn as a
      // kind="prepended" block once they submit.
      if (this.lastVoiceState === 'listening' || this.lastVoiceState === 'transcribing' || this.lastVoiceState === 'thinking') {
        log(`Autonomous flush deferred — voice state '${this.lastVoiceState}'`)
        return
      }
      this.session.submitSystemTurn().catch((err: Error) => {
        log(`submitSystemTurn failed: ${err.message}`)
      })
    }, delayMs)
    this.flushTimer.unref?.()
  }
}
