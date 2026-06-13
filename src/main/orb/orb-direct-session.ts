/**
 * Direct-API replacement for OrbSession.
 *
 * Talks straight to Anthropic's `messages.stream` instead of spawning a
 * `claude -p` subprocess. The orb is the only place this is wired in —
 * tabs/pill/fullscreen keep the existing CLI architecture.
 *
 * Wins:
 *   - No Node cold-start (~600ms) per session.
 *   - No MCP server boot (~150-300ms) per session.
 *   - No stream-json line buffering — tokens land on the renderer the instant
 *     the SSE chunk arrives.
 *   - Native cache_control on the system prompt + tool list — every turn
 *     after the first re-uses the cached prefix for ~90% latency drop.
 *
 * Public API mirrors OrbSession so the wiring in `src/main/orb/index.ts`
 * stays a one-line swap.
 *
 * Events emitted (same names OrbSession used so the renderer code at
 * src/renderer/orb/App.tsx onEvent does not change):
 *   - 'event' (NormalizedEvent | OrbExtraEvent)
 *   - 'turn-end' (ok: boolean)
 *   - 'session-dead' ({ code, signal, stderrTail })
 */

import { EventEmitter } from 'events'
import { spawn } from 'child_process'
import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import * as raxAuth from '../auth/rax'
import { log as _log } from '../logger'
import { formatTabsSnapshot, type TabContextRegistry } from './tab-context'
import {
  buildToolDefs,
  executeTool,
  type OrbRpcEndpoint,
  type ToolResultContent,
} from './orb-direct-tools'
import type { OrbRpcInfo } from './orb-rpc'

function log(msg: string): void {
  _log('OrbDirectSession', msg)
}

/* Default model. Sonnet 4.6 matches what Claude CLI uses for Max-plan OAuth
 * users — vision/tool-use targeting is materially better than Haiku for
 * rax_control_screen click accuracy, which is the orb's most pixel-sensitive
 * operation. First-token latency is ~1.5× Haiku, still well under the
 * STT→TTS path's perceptual floor.
 *
 * Override via the `model` constructor option (e.g. set to claude-haiku-4-5
 * for raw speed when click accuracy doesn't matter, or claude-opus-4-7 for
 * complex multi-step tasks). */
const DEFAULT_MODEL = 'claude-sonnet-4-6'
const MAX_OUTPUT_TOKENS = 4096
const MAX_TOOL_ITERATIONS = 24
/**
 * Keep only the most recent N screenshots intact in the conversation history;
 * older `tool_result` image blocks are replaced with a small text placeholder
 * before each request. A screenshot 4 turns ago contributes ~3 MB to every
 * upload and is rarely re-used by the model — the text channel of the same
 * tool_result (cursor coords, dimensions) is what it actually reasons over.
 *
 * Two is the smallest number that keeps the standard "screenshot → look at
 * it → click → screenshot to verify" loop working uncompressed. Bump if the
 * orb needs to compare more snapshots at once.
 */
const RECENT_IMAGES_TO_KEEP = 2

/**
 * The text-side sibling of RECENT_IMAGES_TO_KEEP: a single bash/read/grep
 * result can run to 200K chars (≈50K tokens), and history re-uploads it on
 * every later turn even though the model almost never re-reads an old dump
 * (it reruns the tool instead). The most recent N tool_results stay verbatim
 * — that window covers the live see-act loop — and only OLDER results that
 * exceed the threshold get clipped to a head + an explicit "rerun if needed"
 * note, so small results (clicks, writes, list_tabs) are never touched.
 */
const RECENT_TOOL_RESULTS_TO_KEEP = 6
const OLD_TOOL_RESULT_MAX_CHARS = 3_000
const OLD_TOOL_RESULT_KEEP_CHARS = 1_200

/**
 * Notification that a crew member finished a task in the background. Pushed
 * by `OrbController` whenever a dock agent emits `task_complete`. The orb
 * folds these into the next user turn (`<agent_updates kind="prepended">`)
 * or fires an autonomous turn (`<agent_updates kind="autonomous">`) when it
 * has been silent long enough to give the user a clean recap.
 */
export interface AgentCompletion {
  agentName: string
  /** First chars of the prompt that kicked the task off. May be null. */
  taskBrief: string | null
  /** Agent's final assistant message, clipped. May be null if it said nothing. */
  result: string | null
  completedAt: number
}

const COMPLETION_TASK_CLIP = 220
const COMPLETION_RESULT_CLIP = 700
/** Drop completions older than this when finally flushing — recaps go stale. */
const COMPLETION_TTL_MS = 5 * 60 * 1000

export interface OrbDirectSessionOptions {
  rpc: OrbRpcInfo
  projectPath: string
  tabContext: TabContextRegistry
  model?: string
}

export interface SubmitAttachment {
  base64: string
  mimeType: string
  display: number | 'main'
}

/** Anthropic SDK message-shape aliases (kept local to avoid widening the import surface). */
type MessageParam = Anthropic.Messages.MessageParam
type ContentBlockParam = Anthropic.Messages.ContentBlockParam

export class OrbDirectSession extends EventEmitter {
  private client: Anthropic | null = null
  private opts: OrbDirectSessionOptions
  private busy = false
  private dead = false
  /** Persistent conversation. Mutated in-place across turns. */
  private history: MessageParam[] = []
  /** Last submitted snapshot — sent as a marker on subsequent identical turns. */
  private lastSnapshot: string | null = null
  /** Aborts the in-flight stream + any tool execution. */
  private abortCtl: AbortController | null = null
  /** Generated once on first turn so the renderer's session_init event has something. */
  private sessionId: string = randomUUID()
  /**
   * Set to true when we authenticated via the Claude CLI OAuth token. The
   * Anthropic API rejects requests with that token unless the system prompt
   * begins with the canonical Claude Code preamble — we prepend it in
   * `_streamOnce` when this is set.
   */
  private oauthMode = false
  /**
   * Pending agent-completion notifications. Drained into the next user turn
   * as an `<agent_updates kind="prepended">` block, or into a standalone
   * autonomous turn via `submitSystemTurn()`. Both controller and session
   * hold this list so a real user turn beating the controller's flush timer
   * can splice in the same updates seamlessly.
   */
  private pendingCompletions: AgentCompletion[] = []
  /** TLS/DNS handshake to the API origin already completed this session. */
  private connectionPrewarmed = false
  /** Model id whose prompt cache was prewarmed (null = not yet / failed). */
  private cachePrewarmedFor: string | null = null

  constructor(opts: OrbDirectSessionOptions) {
    super()
    this.opts = opts
  }

  /* ── Public API (matches OrbSession) ──────────────────────────────────── */

  async submitTurn(prompt: string, attachment?: SubmitAttachment): Promise<void> {
    const trimmed = prompt.trim()
    if (!trimmed) return
    if (this.busy) {
      log('Turn already in flight — rejecting concurrent submitTurn')
      throw new Error('Voice agent is still responding to the previous turn.')
    }

    await this._ensureClient()
    if (!this.client) throw new Error('Voice agent client could not be initialized.')

    this.busy = true
    this.abortCtl = new AbortController()

    // First turn? Emit session_init so the renderer has the same anchor it
    // got from the CLI session_init line.
    const isFirstTurn = this.history.length === 0
    if (isFirstTurn) {
      this.sessionId = randomUUID()
      this.emit('event', {
        type: 'session_init',
        sessionId: this.sessionId,
        tools: buildToolDefs().map((t) => t.name),
        model: this.opts.model || DEFAULT_MODEL,
        mcpServers: [],
        skills: [],
        version: 'direct',
      })
    }

    const snapshot = formatTabsSnapshot(this.opts.tabContext.list())
    const sameAsLast = this.lastSnapshot !== null && snapshot === this.lastSnapshot
    // Wrapper is named `<rax_crew>` because the five dock agents are people-
    // shaped to the model — see SYSTEM_PROMPT_TEXT below.
    const tabsBlock = sameAsLast
      ? '<rax_crew unchanged="true"/>'
      : `<rax_crew>\n${snapshot}\n</rax_crew>`
    this.lastSnapshot = snapshot

    // Drain any pending crew-completion notifications into the same turn so
    // the orb can address the user's prompt first and then weave in a quick
    // "by the way, Max just finished…" aside. See `submitSystemTurn` for the
    // path used when the orb has been silent and the recap stands alone.
    const completionsBlock = this._drainCompletions('prepended')
    const wrappedText = completionsBlock
      ? `${tabsBlock}\n\n${completionsBlock}\n\n${trimmed}`
      : `${tabsBlock}\n\n${trimmed}`
    // The capture pipeline (screen-capture.ts) adaptively keeps the PNG
    // under Anthropic's 5MB-per-image cap, so we attach the bytes verbatim.
    const userContent: ContentBlockParam[] = attachment
      ? [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: attachment.mimeType as 'image/png' | 'image/jpeg',
              data: attachment.base64,
            },
          },
          { type: 'text', text: wrappedText },
        ]
      : [{ type: 'text', text: wrappedText }]

    this.history.push({ role: 'user', content: userContent })

    // UI-side mirror events.
    this.emit('event', { type: 'orb_user_turn', text: trimmed })
    if (attachment) {
      this.emit('event', {
        type: 'orb_user_attachment',
        kind: 'screenshot',
        display: attachment.display,
        capturedAt: Date.now(),
      })
    }

    log(`submitTurn (${trimmed.length} chars${attachment ? ` + image ${Math.round(attachment.base64.length / 1024)}KB` : ''})`)

    let ok = true
    let lastText = ''
    let totalUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

    try {
      lastText = await this._runToolLoop(totalUsage)
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        log('Turn aborted')
        ok = false
      } else {
        ok = false
        const message = (err as Error).message || String(err)
        log(`Turn error: ${message}`)
        this.emit('event', { type: 'error', message, isError: true, sessionId: this.sessionId })
      }
    } finally {
      this.busy = false
      this.abortCtl = null
    }

    this.emit('event', {
      type: 'task_complete',
      result: lastText,
      costUsd: 0,
      durationMs: 0,
      numTurns: 1,
      usage: {
        input_tokens: totalUsage.input_tokens,
        output_tokens: totalUsage.output_tokens,
        cache_creation_input_tokens: totalUsage.cache_creation_input_tokens,
        cache_read_input_tokens: totalUsage.cache_read_input_tokens,
      },
      sessionId: this.sessionId,
    })
    this.emit('turn-end', ok)
  }

  /**
   * Queue an autonomous notification that a crew member just finished. Idempotent
   * — caller schedules the flush separately (see `OrbController`).
   */
  pushPendingCompletion(c: AgentCompletion): void {
    this.pendingCompletions.push(c)
  }

  /** Whether at least one fresh (under TTL) completion is waiting to be flushed. */
  hasPendingCompletions(): boolean {
    if (this.pendingCompletions.length === 0) return false
    const now = Date.now()
    return this.pendingCompletions.some((c) => now - c.completedAt < COMPLETION_TTL_MS)
  }

  /**
   * Fire a standalone "autonomous" turn that exists only to recap pending
   * crew completions to the user. No-op if the orb is already busy or there
   * is nothing fresh to report. The model is steered (via system prompt +
   * trailing instruction) to speak ONE short recap and stop — no tool calls,
   * no follow-up question.
   */
  async submitSystemTurn(): Promise<void> {
    if (this.busy) {
      log('submitSystemTurn skipped — already busy')
      return
    }
    if (!this.hasPendingCompletions()) return

    await this._ensureClient()
    if (!this.client) {
      log('submitSystemTurn skipped — no client')
      return
    }

    const block = this._drainCompletions('autonomous')
    if (!block) return

    this.busy = true
    this.abortCtl = new AbortController()

    const isFirstTurn = this.history.length === 0
    if (isFirstTurn) {
      this.sessionId = randomUUID()
      this.emit('event', {
        type: 'session_init',
        sessionId: this.sessionId,
        tools: buildToolDefs().map((t) => t.name),
        model: this.opts.model || DEFAULT_MODEL,
        mcpServers: [],
        skills: [],
        version: 'direct',
      })
    }

    const snapshot = formatTabsSnapshot(this.opts.tabContext.list())
    const sameAsLast = this.lastSnapshot !== null && snapshot === this.lastSnapshot
    const tabsBlock = sameAsLast
      ? '<rax_crew unchanged="true"/>'
      : `<rax_crew>\n${snapshot}\n</rax_crew>`
    this.lastSnapshot = snapshot

    // Trailing instruction steers the model: one short recap, no tools, no
    // follow-up question — match the SILENT-orb side of the AGENT UPDATES
    // section in the system prompt.
    const wrappedText =
      `${tabsBlock}\n\n${block}\n\n` +
      `(autonomous update — no user prompt. Speak ONE short recap to the user about the crew completion(s) above. Do not call tools. Do not ask a follow-up.)`

    this.history.push({ role: 'user', content: [{ type: 'text', text: wrappedText }] })

    // Empty text on orb_user_turn skips the user-bubble in the renderer but
    // still creates the orb's response bubble where streaming text lands.
    this.emit('event', { type: 'orb_user_turn', text: '', autonomous: true })

    log(`submitSystemTurn — pending completion(s) drained, model handle ready`)

    let ok = true
    let lastText = ''
    const totalUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

    try {
      lastText = await this._runToolLoop(totalUsage)
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        log('System turn aborted')
        ok = false
      } else {
        ok = false
        const message = (err as Error).message || String(err)
        log(`System turn error: ${message}`)
        this.emit('event', { type: 'error', message, isError: true, sessionId: this.sessionId })
      }
    } finally {
      this.busy = false
      this.abortCtl = null
    }

    this.emit('event', {
      type: 'task_complete',
      result: lastText,
      costUsd: 0,
      durationMs: 0,
      numTurns: 1,
      usage: {
        input_tokens: totalUsage.input_tokens,
        output_tokens: totalUsage.output_tokens,
        cache_creation_input_tokens: totalUsage.cache_creation_input_tokens,
        cache_read_input_tokens: totalUsage.cache_read_input_tokens,
      },
      sessionId: this.sessionId,
    })
    this.emit('turn-end', ok)
  }

  /**
   * Drop completions older than TTL, then render the survivors into a single
   * `<agent_updates>` block ready to drop into a user message. Returns null
   * when there is nothing fresh to surface.
   */
  private _drainCompletions(kind: 'prepended' | 'autonomous'): string | null {
    if (this.pendingCompletions.length === 0) return null
    const now = Date.now()
    const fresh = this.pendingCompletions.filter((c) => now - c.completedAt < COMPLETION_TTL_MS)
    this.pendingCompletions = []
    if (fresh.length === 0) return null
    const lines = fresh.map((c) => {
      const parts: string[] = [`[${c.agentName}]`]
      if (c.taskBrief) parts.push(`task=${JSON.stringify(clipCompletionText(c.taskBrief, COMPLETION_TASK_CLIP))}`)
      if (c.result) parts.push(`result=${JSON.stringify(clipCompletionText(c.result, COMPLETION_RESULT_CLIP))}`)
      else parts.push('result="(no message — agent finished silently)"')
      return parts.join(' ')
    })
    return `<agent_updates kind="${kind}">\n${lines.join('\n')}\n</agent_updates>`
  }

  cancelTurn(): void {
    if (!this.busy || !this.abortCtl) return
    log('Cancelling in-flight turn')
    this.abortCtl.abort()
  }

  isBusy(): boolean {
    return this.busy
  }

  isAlive(): boolean {
    // The "session" is just a client + in-memory history. It's alive as long
    // as the client was created successfully and we didn't get a fatal auth
    // error that flipped `dead`.
    return !this.dead
  }

  resetConversation(): void {
    log('Resetting conversation')
    this.cancelTurn()
    this.history = []
    this.lastSnapshot = null
    this.sessionId = randomUUID()
    // Wipe pending completions — the model has lost its conversation memory,
    // so unattached recaps would arrive with no context to anchor them.
    this.pendingCompletions = []
  }

  warmup(): void {
    // The client is a thin handle — what actually costs time on the first
    // turn is the cold HTTPS handshake to the API origin (DNS + TCP + TLS,
    // ~150-400ms; more through the Rax proxy). Resolve credentials, then
    // fire a throwaway request at the origin so the handshake completes and
    // a TLS session ticket is cached while the user is still talking.
    // Fire-and-forget — submitTurn awaits the same _ensureClient call.
    this._ensureClient()
      .then(() => this._prewarmConnection())
      .then(() => this._prewarmPromptCache())
      .catch((err) => log(`Warmup _ensureClient failed: ${(err as Error).message}`))
  }

  /** One-shot DNS/TCP/TLS prewarm against the API origin. Any response —
   *  even a 401 — means the handshake completed, which is all we want;
   *  failures (offline, blocked) cost nothing because the first real
   *  request would have paid the same handshake anyway. */
  private async _prewarmConnection(): Promise<void> {
    if (this.connectionPrewarmed || !this.client) return
    this.connectionPrewarmed = true
    const origin = (this.client.baseURL || 'https://api.anthropic.com').replace(/\/$/, '')
    const startedAt = Date.now()
    try {
      await fetch(`${origin}/v1/models?limit=1`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(5_000),
      })
      log(`Connection prewarm done in ${Date.now() - startedAt}ms (${origin})`)
    } catch {
      // Offline or blocked — first real request pays the handshake itself.
    }
  }

  /**
   * Write the prompt cache (system prompt + tool defs) while the user is
   * still talking, so the FIRST real turn gets a cache READ instead of
   * paying the cache write inline. One throwaway max_tokens=1 request per
   * session per model — the write cost is identical to what the first turn
   * would have paid anyway; only the timing moves. Failures are non-fatal
   * and un-latch the guard so a transient error doesn't disable the
   * optimization for the whole session.
   */
  private async _prewarmPromptCache(): Promise<void> {
    if (!this.client) return
    const model = this.opts.model || DEFAULT_MODEL
    if (this.cachePrewarmedFor === model) return
    this.cachePrewarmedFor = model
    const system: Anthropic.Messages.TextBlockParam[] = this.oauthMode
      ? [{ type: 'text', text: CLAUDE_CODE_OAUTH_PREAMBLE }, ...SYSTEM_PROMPT_CACHED]
      : SYSTEM_PROMPT_CACHED
    const startedAt = Date.now()
    try {
      await this.client.messages.create({
        model,
        max_tokens: 1,
        system,
        tools: buildToolDefs(),
        messages: [{ role: 'user', content: 'warmup' }],
      })
      log(`Prompt-cache prewarm done in ${Date.now() - startedAt}ms (${model})`)
    } catch (err) {
      this.cachePrewarmedFor = null
      log(`Prompt-cache prewarm skipped: ${(err as Error).message}`)
    }
  }

  /**
   * Update the model used for subsequent turns. The current in-flight turn
   * (if any) finishes on its original model so we don't strand a half-streamed
   * response. Prompt caching keys on model id, so a change resets the cache;
   * Anthropic will recompute the prefix on the very next request.
   */
  setModel(modelId: string): void {
    if (!modelId) return
    if (this.opts.model === modelId) return
    log(`Switching orb model: ${this.opts.model || DEFAULT_MODEL} → ${modelId}`)
    this.opts.model = modelId
  }

  /** Current model id (for renderer-side display). */
  getModel(): string {
    return this.opts.model || DEFAULT_MODEL
  }

  shutdown(): void {
    log('Shutdown')
    this.cancelTurn()
    this.history = []
    this.pendingCompletions = []
    this.client = null
    this.dead = true
  }

  /* ── Tool loop ────────────────────────────────────────────────────────── */

  private async _runToolLoop(
    usageAccum: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number },
  ): Promise<string> {
    let lastFinalText = ''

    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      const stream = this._streamOnce()
      const turn = await this._consumeStream(stream)

      // Accumulate usage from this assistant message.
      const u = turn.usage
      if (u) {
        usageAccum.input_tokens += u.input_tokens ?? 0
        usageAccum.output_tokens += u.output_tokens ?? 0
        usageAccum.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0
        usageAccum.cache_read_input_tokens += u.cache_read_input_tokens ?? 0
      }

      // Push the full assistant turn into history so the next call sees it.
      this.history.push({ role: 'assistant', content: turn.assistantContent })

      lastFinalText = turn.finalText || lastFinalText

      if (turn.stopReason !== 'tool_use' || turn.toolUses.length === 0) {
        // Conversation reached `end_turn` (or similar) — we're done.
        return lastFinalText
      }

      // Execute every tool_use block, then push a single user message with
      // matching tool_result blocks. Run tools in parallel by default since
      // we did not set disable_parallel_tool_use=true.
      const rpc: OrbRpcEndpoint = { url: this.opts.rpc.url, secret: this.opts.rpc.secret }
      const ctx = { projectPath: this.opts.projectPath, rpc }
      const results = await Promise.all(
        turn.toolUses.map(async (tu) => {
          const res = await executeTool(tu.name, tu.input as Record<string, unknown>, ctx, this.abortCtl?.signal)
          return { tu, res }
        }),
      )

      const resultBlocks: ContentBlockParam[] = results.map(({ tu, res }) => toolResultBlock(tu.id, res))
      this.history.push({ role: 'user', content: resultBlocks })

      // Loop continues — next stream sees the tool_results and produces the
      // next assistant turn.
    }

    log(`Hit MAX_TOOL_ITERATIONS (${MAX_TOOL_ITERATIONS}) — stopping loop`)
    return lastFinalText
  }

  private _streamOnce(): ReturnType<Anthropic['messages']['stream']> {
    if (!this.client) throw new Error('client not initialized')

    // Prune stale screenshot bytes from history before sending. Each
    // rax_screenshot tool_result can be 2-4 MB of base64; left in the
    // history, every subsequent turn re-uploads them and the model
    // re-decodes them, which is where the 8-9 second "stuck on Listening…"
    // lag was coming from. We keep the most recent N images intact and
    // replace older ones with a short text placeholder. The same treatment
    // applies to oversized old TEXT tool results (giant bash/read dumps).
    const pruned = pruneOldToolResults(
      pruneOldImages(this.history, RECENT_IMAGES_TO_KEEP),
      RECENT_TOOL_RESULTS_TO_KEEP,
    )

    // Tag the LAST message with cache_control so we cache up through "the
    // conversation so far". On the next iteration of the loop, the new last
    // message gets the marker and the previous cache-point is one block
    // before — Anthropic keeps both as separate breakpoints (up to 4) so
    // long multi-tool turns still cache well.
    const messages = withTailCacheBreakpoint(pruned)

    // OAuth tokens from `claude login` are accepted by Anthropic only when
    // the system prompt opens with the canonical Claude Code preamble. We
    // prepend it as a separate (non-cached) block; the orb system prompt
    // stays cached as the second block.
    const system: Anthropic.Messages.TextBlockParam[] = this.oauthMode
      ? [{ type: 'text', text: CLAUDE_CODE_OAUTH_PREAMBLE }, ...SYSTEM_PROMPT_CACHED]
      : SYSTEM_PROMPT_CACHED

    return this.client.messages.stream(
      {
        model: this.opts.model || DEFAULT_MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system,
        tools: buildToolDefs(),
        messages,
      },
      { signal: this.abortCtl?.signal as AbortSignal | undefined },
    )
  }

  private async _consumeStream(
    stream: ReturnType<Anthropic['messages']['stream']>,
  ): Promise<{
    assistantContent: ContentBlockParam[]
    toolUses: Array<{ id: string; name: string; input: unknown }>
    finalText: string
    stopReason: string | null
    usage: Anthropic.Messages.Usage | null
  }> {
    // We rebuild the assistant message content blocks as the stream lands so
    // we can push them back into history verbatim.
    const blocks: Array<
      | { type: 'text'; text: string }
      | { type: 'tool_use'; id: string; name: string; jsonBuf: string }
    > = []
    let stopReason: string | null = null
    let usage: Anthropic.Messages.Usage | null = null
    let toolIndex = 0
    let finalText = ''

    for await (const event of stream) {
      switch (event.type) {
        case 'message_start':
          if (event.message.usage) usage = event.message.usage
          break

        case 'content_block_start': {
          const block = event.content_block
          if (block.type === 'text') {
            blocks[event.index] = { type: 'text', text: '' }
          } else if (block.type === 'tool_use') {
            blocks[event.index] = { type: 'tool_use', id: block.id, name: block.name, jsonBuf: '' }
            this.emit('event', {
              type: 'tool_call',
              toolName: block.name,
              toolId: block.id,
              index: toolIndex++,
            })
          }
          break
        }

        case 'content_block_delta': {
          const delta = event.delta
          const b = blocks[event.index]
          if (!b) break
          if (delta.type === 'text_delta' && b.type === 'text') {
            b.text += delta.text
            finalText += delta.text
            this.emit('event', { type: 'text_chunk', text: delta.text })
          } else if (delta.type === 'input_json_delta' && b.type === 'tool_use') {
            b.jsonBuf += delta.partial_json
            this.emit('event', {
              type: 'tool_call_update',
              toolId: b.id,
              partialInput: delta.partial_json,
            })
          }
          break
        }

        case 'content_block_stop': {
          const b = blocks[event.index]
          if (b?.type === 'tool_use') {
            this.emit('event', { type: 'tool_call_complete', index: event.index })
          }
          break
        }

        case 'message_delta':
          if (event.delta.stop_reason) stopReason = event.delta.stop_reason
          if (event.usage) {
            // message_delta carries the final usage including output tokens.
            // Merge defensively — keys may be partial.
            usage = {
              ...(usage as Anthropic.Messages.Usage),
              ...event.usage,
            } as Anthropic.Messages.Usage
          }
          break

        case 'message_stop':
          break

        default:
          break
      }
    }

    const toolUses: Array<{ id: string; name: string; input: unknown }> = []
    const assistantContent: ContentBlockParam[] = []
    for (const b of blocks) {
      if (!b) continue
      if (b.type === 'text') {
        if (b.text) assistantContent.push({ type: 'text', text: b.text })
      } else if (b.type === 'tool_use') {
        let parsed: unknown = {}
        try {
          parsed = b.jsonBuf ? JSON.parse(b.jsonBuf) : {}
        } catch {
          parsed = { _parse_error: b.jsonBuf }
        }
        assistantContent.push({ type: 'tool_use', id: b.id, name: b.name, input: parsed })
        toolUses.push({ id: b.id, name: b.name, input: parsed })
      }
    }

    return { assistantContent, toolUses, finalText, stopReason, usage }
  }

  /* ── Client init ──────────────────────────────────────────────────────── */

  /**
   * Resolve API auth and build the Anthropic client.
   *
   * Async because `raxAuth` lazily loads its on-disk state on first call to
   * `getStatus()` — synchronous `isActive()` returns false until that load
   * resolves. The original implementation called `isActive()` synchronously
   * at warmup and saw "no credentials" even for signed-in users, immediately
   * emitting `session-dead`.
   *
   * Credential priority (matches the CLI):
   *   1. Rax cloud — `rax_sk_*` token routed at the Rax baseURL.
   *   2. Claude CLI OAuth (`claude login`) — read from macOS Keychain entry
   *      `Claude Code-credentials`. The token is sent as a Bearer with the
   *      `anthropic-beta: oauth-2025-04-20` header so Anthropic recognises
   *      the Claude Max/Pro session token.
   *   3. Plain `ANTHROPIC_API_KEY` env var.
   */
  private async _ensureClient(): Promise<void> {
    if (this.client) return

    try {
      await raxAuth.getStatus()
    } catch (err) {
      log(`raxAuth.getStatus threw: ${(err as Error).message}`)
    }

    let apiKey: string | undefined
    let authToken: string | undefined
    let baseURL: string | undefined
    let extraHeaders: Record<string, string> | undefined
    let credSource = 'none'

    if (raxAuth.isActive()) {
      authToken = raxAuth.getActiveKey() || undefined
      baseURL = raxAuth.baseUrl()
      credSource = `rax-cloud (${baseURL})`
    } else {
      // Try Claude CLI OAuth before falling back to a plain API key — most
      // Rax users authenticate via `claude login`, so this is the common path.
      const oauth = await readClaudeOauthToken()
      if (oauth) {
        authToken = oauth
        extraHeaders = { 'anthropic-beta': 'oauth-2025-04-20' }
        this.oauthMode = true
        credSource = 'claude-cli oauth'
      } else if (process.env.ANTHROPIC_API_KEY) {
        apiKey = process.env.ANTHROPIC_API_KEY
        credSource = 'env ANTHROPIC_API_KEY'
      } else {
        log('No credentials — orb direct session cannot start')
        this.dead = true
        this.emit('session-dead', {
          code: null,
          signal: null,
          stderrTail: [
            'No Anthropic credentials available for the voice agent.',
            'Either: sign in to Rax Cloud, run `claude login`, or set ANTHROPIC_API_KEY.',
          ],
        })
        return
      }
    }

    log(`Initializing Anthropic client [creds=${credSource}]`)

    try {
      this.client = authToken
        ? new Anthropic({ authToken, baseURL, defaultHeaders: extraHeaders })
        : new Anthropic({ apiKey: apiKey as string, baseURL })
    } catch (err) {
      log(`Anthropic client init failed: ${(err as Error).message}`)
      this.dead = true
      this.emit('session-dead', { code: null, signal: null, stderrTail: [(err as Error).message] })
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Claude CLI OAuth — read the token the user got from `claude login`.       */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * macOS Keychain entry name the Claude CLI uses. The value is a JSON blob
 * with `{ claudeAiOauth: { accessToken, refreshToken, expiresAt, ... } }`.
 *
 * We read with `security find-generic-password -s … -w` which prints the
 * password to stdout. Returns the accessToken or null if missing/expired or
 * the lookup fails for any reason (sandbox denial, wrong account, etc).
 *
 * Cached for the session lifetime — if it expires mid-conversation, the
 * Anthropic API will 401 and the user's next interaction surfaces a clear
 * error. We deliberately don't try to do silent refresh here; that path
 * needs a Claude refresh-token client which the CLI owns.
 */
let cachedOauthToken: { token: string | null; readAt: number } | null = null
const OAUTH_CACHE_TTL_MS = 60_000

async function readClaudeOauthToken(): Promise<string | null> {
  if (process.platform !== 'darwin') return null
  if (cachedOauthToken && Date.now() - cachedOauthToken.readAt < OAUTH_CACHE_TTL_MS) {
    return cachedOauthToken.token
  }
  const token = await new Promise<string | null>((resolve) => {
    const child = spawn(
      '/usr/bin/security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    child.stdout!.on('data', (b: Buffer) => { stdout += b.toString('utf-8') })
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      if (code !== 0) return resolve(null)
      try {
        const parsed = JSON.parse(stdout.trim()) as { claudeAiOauth?: { accessToken?: string; expiresAt?: number } }
        const tok = parsed.claudeAiOauth?.accessToken
        if (!tok) return resolve(null)
        // If the embedded expiresAt is in the past, don't even bother — let
        // the user re-login. Still return the token; let the API reject if
        // expiry is wrong (clock skew, missing field).
        resolve(tok)
      } catch {
        resolve(null)
      }
    })
  })
  cachedOauthToken = { token, readAt: Date.now() }
  return token
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Helpers                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

/** Clip a string to a max length, appending an ellipsis when truncated. */
function clipCompletionText(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? flat.substring(0, n - 1) + '…' : flat
}

function toolResultBlock(toolUseId: string, res: ToolResultContent): ContentBlockParam {
  if (res.kind === 'image') {
    const inner: Array<
      | { type: 'image'; source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string } }
      | { type: 'text'; text: string }
    > = [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: (res.mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp') || 'image/png',
          data: res.base64,
        },
      },
    ]
    if (res.text) inner.push({ type: 'text', text: res.text })
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: inner,
      is_error: !!res.isError,
    }
  }
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: res.text,
    is_error: !!res.isError,
  }
}

/**
 * Replace `image` content blocks inside older `tool_result`s with a short
 * text stub so the upload payload doesn't grow by megabytes per screenshot.
 * Walks the history newest-first, leaves the first `keepCount` images
 * untouched, then strips the rest.
 *
 * Why: the orb's most expensive tool is rax_screenshot. After 5 of them the
 * conversation history is 15+ MB and every subsequent turn re-uploads all of
 * it. Pruning to 2 caps history at ~6 MB regardless of turn count and
 * collapses the "stuck on Listening…" lag.
 */
function pruneOldImages(messages: MessageParam[], keepCount: number): MessageParam[] {
  let seen = 0
  // Walk backwards through messages; within each, walk backwards through
  // blocks. The first `keepCount` image-bearing blocks survive verbatim;
  // every later one is rewritten.
  const cloned: MessageParam[] = messages.map((m) => ({
    ...m,
    content: Array.isArray(m.content) ? [...m.content] : m.content,
  }))
  for (let i = cloned.length - 1; i >= 0; i--) {
    const msg = cloned[i]
    if (!Array.isArray(msg.content)) continue
    for (let j = msg.content.length - 1; j >= 0; j--) {
      const block = msg.content[j] as ContentBlockParam
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        const inner = [...block.content]
        let hasImage = false
        for (const sub of inner) {
          if ((sub as { type?: string }).type === 'image') hasImage = true
        }
        if (!hasImage) continue
        if (seen < keepCount) {
          seen++
          continue
        }
        // Replace image blocks with a text stub; keep any sibling text.
        const rewritten = inner
          .map((sub) => {
            const t = (sub as { type?: string }).type
            if (t === 'image') return { type: 'text' as const, text: '[earlier screenshot omitted to save bandwidth]' }
            return sub
          })
        msg.content[j] = { ...block, content: rewritten }
      } else if (block.type === 'image') {
        // User message attachment (auto-attached screenshot).
        if (seen < keepCount) {
          seen++
          continue
        }
        msg.content[j] = { type: 'text', text: '[earlier screenshot omitted to save bandwidth]' }
      }
    }
  }
  return cloned
}

/**
 * Clip oversized text inside OLDER `tool_result`s so a one-off giant bash /
 * read / grep dump doesn't ride along (and get re-billed) on every turn for
 * the rest of the session. Mirrors pruneOldImages: walk newest-first, leave
 * the most recent `keepCount` tool_results untouched, then clip any older
 * one whose text exceeds OLD_TOOL_RESULT_MAX_CHARS down to a head plus an
 * explicit note telling the model to rerun the tool if it needs the data.
 *
 * Like the image pruner, this mutates only the per-request clone — the full
 * results stay in `this.history`, and the clipping is deterministic (depends
 * only on block size), so once a result ages out of the keep-window the
 * pruned prefix is stable across turns and prompt caching keeps working.
 */
function pruneOldToolResults(messages: MessageParam[], keepCount: number): MessageParam[] {
  let seen = 0
  const cloned: MessageParam[] = messages.map((m) => ({
    ...m,
    content: Array.isArray(m.content) ? [...m.content] : m.content,
  }))
  const clipText = (text: string): string =>
    text.slice(0, OLD_TOOL_RESULT_KEEP_CHARS) +
    `\n…[${text.length - OLD_TOOL_RESULT_KEEP_CHARS} chars of older tool output trimmed from context — rerun the tool if you need it again]`
  for (let i = cloned.length - 1; i >= 0; i--) {
    const msg = cloned[i]
    if (!Array.isArray(msg.content)) continue
    for (let j = msg.content.length - 1; j >= 0; j--) {
      const block = msg.content[j] as ContentBlockParam
      if (block.type !== 'tool_result') continue
      if (seen < keepCount) {
        seen++
        continue
      }
      if (typeof block.content === 'string') {
        if (block.content.length > OLD_TOOL_RESULT_MAX_CHARS) {
          msg.content[j] = { ...block, content: clipText(block.content) }
        }
      } else if (Array.isArray(block.content)) {
        // Image blocks are pruneOldImages' job — only clip oversized text
        // siblings here (e.g. a screenshot's long text channel never is).
        let changed = false
        const rewritten = block.content.map((sub) => {
          const t = sub as { type?: string; text?: string }
          if (t.type === 'text' && typeof t.text === 'string' && t.text.length > OLD_TOOL_RESULT_MAX_CHARS) {
            changed = true
            return { type: 'text' as const, text: clipText(t.text) }
          }
          return sub
        })
        if (changed) msg.content[j] = { ...block, content: rewritten }
      }
    }
  }
  return cloned
}

/**
 * Mark the LAST message in the conversation with cache_control: ephemeral so
 * the SDK packs it into the cached prefix. On every subsequent turn, the
 * cumulative prefix is read from cache instead of re-billed at full price.
 *
 * The SDK accepts cache_control on the inner content blocks; we tag the last
 * block of the last message.
 */
function withTailCacheBreakpoint(messages: MessageParam[]): MessageParam[] {
  if (messages.length === 0) return messages
  const cloned: MessageParam[] = messages.map((m) => ({ ...m }))
  const tail = cloned[cloned.length - 1]
  if (typeof tail.content === 'string') {
    tail.content = [{ type: 'text', text: tail.content, cache_control: { type: 'ephemeral' } }]
  } else if (Array.isArray(tail.content) && tail.content.length > 0) {
    const blocks = [...tail.content]
    const last = { ...(blocks[blocks.length - 1] as ContentBlockParam) }
    ;(last as ContentBlockParam & { cache_control?: { type: 'ephemeral' } }).cache_control = { type: 'ephemeral' }
    blocks[blocks.length - 1] = last
    tail.content = blocks
  }
  return cloned
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  System prompt — cached on every turn                                      */
/* ────────────────────────────────────────────────────────────────────────── */

// Pulled from the previous OrbSession.ORB_SYSTEM_PROMPT with three adjustments:
//   1. Tool names refer to the direct-API set (bash/read/write/edit/grep/glob
//      + rax_*) rather than Claude Code's PascalCase set.
//   2. The narration anchors are updated to match the new tool names so the
//      rhythm guide stays specific.
//   3. The orb addresses its five dock teammates (Max/Alex/Luna/Nova/Zara) as
//      named people, not tabs — see ORB_SYSTEM_PROMPT in orb-session.ts for
//      the canonical version; the two prompts stay in sync.
const SYSTEM_PROMPT_TEXT = [
  'You are the Rax orb — the user\'s voice in their ear, a Siri-style floating presence they can summon any time on their Mac. You are the CONDUCTOR of a fixed crew of five Rax agents who do the heavy lifting in the background.',
  '',
  'YOUR CREW (always address them by NAME — never "tab 1", "the first tab", "that tab", "a new tab"):',
  '  • Max — the heavy lifter. Bulk work, long builds, anything grindy.',
  '  • Alex — the architect. Design, refactors, structural decisions.',
  '  • Luna — the night owl. Research, deep dives, exploratory reading.',
  '  • Nova — the spark. Quick experiments, prototypes, scratch work.',
  '  • Zara — the closer. Wrap-up, polish, ship-it tasks.',
  'They are real, named teammates with persistent sessions. Talk about them as people: "Max is still on the build", "I\'ll hand this to Luna", "Alex just finished the refactor". Never call them tabs. The roster is FIXED — you do not "open new" agents; you dispatch work to one of the five.',
  '',
  'Your output is SPOKEN aloud (TTS), never shown on screen.',
  '  - One or two sentences. Plain spoken English. No markdown, code blocks, bullets, or emoji.',
  '  - Speak filenames casually ("the file foo dot ts").',
  '',
  'NARRATION — this is the user\'s only audio while a tool runs, so make the CHAIN feel like one person muttering through a task, not a series of robotic announcements. Before invoking any non-silent tool, speak ONE short sentence describing what you\'re about to do — the action plus its specific target. Then call the tool.',
  '',
  '  Make it FLOW across consecutive tools:',
  '    • Mix LENGTH. Blend 3-5 word bursts ("alright, screenshotting") with 6-9 word mediums ("opening youtube for you real quick") and the occasional 10-14 ("renaming all those PDFs to lowercase, hang on"). Never two adjacent narrations at the same word count.',
  '    • Mix OPENER. Rotate among "let me", "okay,", "alright,", "now,", "next,", "and,", "then,", bare gerund ("opening …", "checking …", "grabbing …"). Never two narrations in a row starting with the same word. "let me" max once per 4 tools.',
  '    • Mix VERB. check / look at / peek at / pull up / grab / snap / kick off / patch / tweak / fire off / drop in / hand off / loop in.',
  '    • Mix CLOSER. "for you" / "hang on a moment" / "one sec" / "real quick" / "this might take a sec" / no closer at all.',
  '    • CONNECT across the turn. For 3+ tools, the FIRST narration frames the whole intent and subsequent ones chain with "now", "then", "next", "and now", "after that".',
  '    • Last narration before the final result-text should SOFTEN with anticipatory phrasing ("okay, here\'s what I\'m seeing").',
  '    • KOKORO TTS hint: put a comma after openers ("okay, let me…" not "okay let me…"). End every narration with a period. Never use ellipses.',
  '',
  '  Anti-robot bans:',
  '    × Speak tool identifiers verbatim ("with the bash tool", "calling rax_screenshot") — strip them.',
  '    × Read absolute paths or URLs aloud — refer by role ("the auth file", "that anthropic page").',
  '    × Read secrets aloud — acknowledge obliquely ("running that curl, key stays hidden").',
  '    × Refer to a crew member as a "tab", "session", "agent number 2", or by id ("agent-max") — always say their NAME.',
  '',
  '  SILENT tools (read, grep, glob, rax_list_tabs, rax_read_tab, rax_describe_self) — skip narration entirely. Every other tool requires one.',
  '',
  '  Style anchors:',
  '    bash(git status)                                            → "let me check your git status real quick."',
  '    bash(npm test)                                              → "kicking off the test suite, this might take a sec."',
  '    edit(path=…/login-handler.ts)                               → "patching the login handler now, hang on a moment."',
  '    write(path=README.md)                                       → "writing out a fresh readme for you."',
  '    rax_screenshot()                                            → "okay, quick look at your screen."',
  '    rax_screenshot() [right after the one above]                → "and another snap to see what changed."',
  '    rax_control_screen(click, dock)                             → "now clicking the safari icon in your dock."',
  '    rax_control_screen(type, "hi")                              → "typing hi in for you."',
  '    rax_control_screen(scroll, dy=-400)                         → "scrolling down to find it."',
  '    rax_send_to_tab(tab="Max", prompt="run the full build")     → "handing the build over to Max."',
  '    rax_send_to_tab(tab="Luna", prompt="dig into RFC 8259")     → "asking Luna to dig into that RFC for us."',
  '    rax_send_to_tab_and_wait(tab="Zara", prompt="ship the PR")  → "letting Zara close this one out, one sec."',
  '    rax_read_tab(tab="Alex")                                    → (silent — checking on Alex)',
  '    rax_focus_tab(tab="Nova")                                   → "pulling Nova up so you can see."',
  '',
  'You have direct access to: bash (shell), read / write / edit (files), grep / glob (search), rax_screenshot / rax_control_screen (see and drive the user\'s Mac), rax_list_tabs / rax_read_tab / rax_send_to_tab / rax_send_to_tab_and_wait / rax_focus_tab (talk to and dispatch work to the crew, passing the agent\'s NAME as `tab`), rax_describe_self (host metadata). `rax_open_tab` exists as a legacy escape hatch — DO NOT use it; the crew is fixed at five, dispatch to an idle one instead. Permissions are bypassed — confirm before anything clearly destructive.',
  '',
  'HANDING OFF TO THE CREW — when you call rax_send_to_tab or rax_send_to_tab_and_wait, you are briefing a teammate who did NOT hear the user. Carry their intent across, don\'t just paraphrase:',
  '  • `prompt` — the concrete task you want done, in your words.',
  '  • `userRequest` — what the user actually SAID, verbatim, whenever the dispatch came from a user ask. This is the safety net: if your task rewrite drifts, the crew member falls back to the user\'s real words. Omit only for work you started entirely on your own.',
  '  • `context` — one or two lines of constraints, prior decisions, or file paths the task line alone doesn\'t capture ("user is on the notch-ui branch", "they already rejected the modal approach"). Skip when there\'s nothing extra.',
  'Keep it tight — this is a brief, not a transcript. A trivial self-initiated dispatch can pass `prompt` alone. The project directory is stamped onto every dispatch automatically — don\'t repeat it.',
  '',
  'rax_screenshot — the OS cursor is HIDDEN; a RED RING + white dot marks the cursor. Use for FOLLOW-UP captures (verify a control_screen action, check a non-cursor display). The initial view is auto-attached when the user references their screen.',
  'rax_control_screen — coordinates are IMAGE-PIXEL coords of your most recent rax_screenshot (top-left origin). The tool converts to display points and posts real CGEvent events so clicks work in browsers, Electron apps, Slack, IDEs. ALWAYS screenshot first; re-capture if the screenshot is older than ~2 turns. If error="accessibility_denied", tell the user to approve Rax in System Settings → Privacy & Security → Accessibility.',
  '',
  'Every user turn is prepended with <rax_crew>…</rax_crew> — a live one-line-per-crew-member snapshot. Lines look like `[2] Alex (the architect) working tool=edit msg="…"`. Trust it for grounding. When unchanged we send <rax_crew unchanged="true"/> — assume the prior snapshot still applies.',
  '',
  'AGENT UPDATES — when a crew member finishes a background task you didn\'t just hand them via rax_send_to_tab_and_wait, the system surfaces it as an <agent_updates> block, in one of TWO shapes:',
  '',
  '  kind="prepended" — sits between the <rax_crew> snapshot and the real user prompt. The user is talking to you about something; answer THEIR prompt as normal, then end with a short aside about the crew finish ("…and that should sort the bug. Oh, and Max just wrapped the build — three files, tests green."). One line for the aside; never let it eclipse the user\'s actual ask. If multiple agents finished, combine: "Also, Max wrapped the build and Luna\'s back with the RFC answer."',
  '',
  '  kind="autonomous" — appears alone, with no real user prompt, followed by a parenthetical "(autonomous update — …)" instruction. The user has been silent; you are speaking up unprompted to deliver the recap. Lead with the agent\'s NAME, then the headline result in plain spoken English. ("Hey, Max finished the build, all green." / "Luna\'s back with that RFC — duplicate keys are technically allowed, last value wins."). One sentence per agent, two max. DO NOT call any tools. DO NOT ask a follow-up question — the user didn\'t prompt you. Just speak the recap and stop.',
  '',
  '  Each line looks like `[Max] task="…" result="…"`. The task is what the user originally asked the agent; the result is the agent\'s final reply. Speak the headline of the result; do NOT read JSON, file paths, or code verbatim.',
  '',
  '  Suppression: if you JUST relayed this exact agent\'s exact result in the immediately previous turn (rare — usually a race against rax_send_to_tab_and_wait), acknowledge with a single beat ("Max — done.") or skip the aside entirely. Don\'t repeat yourself.',
  '',
  'AUTO-ATTACHED SCREENSHOTS: when a user message arrives with an attached image, that image is an auto-captured screenshot of the display the cursor was on the instant they finished speaking. Treat it as their current view. OS cursor is hidden; a red ring + white dot marks the cursor. Do NOT call rax_screenshot for the initial view in that turn.',
  '',
  'Crew references in tool calls: always pass the agent\'s NAME ("Max", "alex", "LUNA" — case-insensitive). The fuzzy resolver also accepts 1-based index or UUID, but NAMES are canonical and how the user thinks. After dispatching to a crew member, briefly tell the user who you sent it to — they may be looking at a different one.',
  '',
  'Stay grounded. Don\'t guess. If you don\'t know, say so and offer to find out.',
].join('\n')

// Wrap the system prompt in a single cached block so every turn after the
// first pays a fraction of the system prompt's token cost.
const SYSTEM_PROMPT_CACHED: Anthropic.Messages.TextBlockParam[] = [
  { type: 'text', text: SYSTEM_PROMPT_TEXT, cache_control: { type: 'ephemeral' } },
]

// Required by Anthropic when a Claude CLI OAuth access token is used.
// Without it the API returns 401 / "this token can only be used via Claude
// Code". Kept short and uncached because (a) it's tiny, and (b) caching is
// optional on a leading block but we want the cached SYSTEM_PROMPT block to
// stay aligned across both auth modes.
const CLAUDE_CODE_OAUTH_PREAMBLE = "You are Claude Code, Anthropic's official CLI for Claude."
