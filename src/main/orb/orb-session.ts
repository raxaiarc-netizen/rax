import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { existsSync, writeFileSync, unlinkSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
// Vite resolves `?raw` imports as their file contents — we ship the MCP shim
// inline in the bundle and write it to a temp file at orb startup.
// eslint-disable-next-line import/no-unresolved
import mcpServerSrc from './mcp-server.cjs?raw'
import { StreamParser } from '../stream-parser'
import { normalize } from '../claude/event-normalizer'
import { buildClaudeEnv, buildClaudeSpawnInvocation } from '../claude/claude-instance'
import { log as _log } from '../logger'
import type { ClaudeEvent, NormalizedEvent } from '../../shared/types'
import type { OrbRpcInfo } from './orb-rpc'
import { formatTabsSnapshot, type TabContextRegistry } from './tab-context'

function log(msg: string): void {
  _log('OrbSession', msg)
}

const TEMP_PREFIX = 'rax-orb-'

export interface OrbSessionOptions {
  rpc: OrbRpcInfo
  /** Default working directory for the orb's claude process. */
  projectPath: string
  /** Optional model override. */
  model?: string
  /**
   * Live mirror of every open tab. Read at submitTurn time to prepend a compact
   * snapshot to the user message so the model grounds without a rax_list_tabs
   * round-trip.
   */
  tabContext: TabContextRegistry
}

/**
 * Image attachment riding on a single user turn, captured by the auto-
 * screenshot pipeline before submitTurn ran. Lives only for the duration of
 * one stream-json `user` message — we do not retain it on the session.
 */
export interface SubmitAttachment {
  base64: string
  mimeType: string
  display: number | 'main'
}

/**
 * Crew-completion notification. Mirrors the type in `orb-direct-session.ts`
 * so the controller can talk to either backend interchangeably. See that
 * file's `AgentCompletion` doc for the full lifecycle.
 */
export interface AgentCompletion {
  agentName: string
  taskBrief: string | null
  result: string | null
  completedAt: number
}

const COMPLETION_TASK_CLIP = 220
const COMPLETION_RESULT_CLIP = 700
const COMPLETION_TTL_MS = 5 * 60 * 1000

/**
 * The voice agent's own claude process. Single long-lived `claude -p
 * --input-format stream-json` subprocess; turns are written to stdin one at a
 * time, the response stream is forwarded to the orb window as normalized
 * events.
 *
 * Differs from the per-tab RunManager:
 *  - Bypass permission mode (the user explicitly summoned the agent — Siri energy).
 *  - --mcp-config wires the rax-orb tab tools.
 *  - --append-system-prompt teaches the agent what it is and how to speak.
 *  - Lifetime is the app, not a single run. Stdin stays open across turns.
 *
 * Events:
 *  - 'event'          (NormalizedEvent | OrbExtraEvent)
 *  - 'turn-end'       (ok: boolean)
 *  - 'session-dead'   ({ code, signal, stderrTail })
 */
export class OrbSession extends EventEmitter {
  private child: ChildProcess | null = null
  private parser: StreamParser | null = null
  private mcpConfigPath = ''
  private mcpScriptPath = ''
  private opts: OrbSessionOptions
  private busy = false
  private stderrTail: string[] = []
  /** Last snapshot we sent so we can omit unchanged ones from subsequent turns. */
  private lastSnapshot: string | null = null
  /** Queue of crew-completion notifications waiting to surface to the user. */
  private pendingCompletions: AgentCompletion[] = []

  constructor(opts: OrbSessionOptions) {
    super()
    this.opts = opts
  }

  // ─── Public API ───

  /** Submit one user turn. Resolves when the turn fully completes (task_complete). */
  async submitTurn(prompt: string, attachment?: SubmitAttachment): Promise<void> {
    const trimmed = prompt.trim()
    if (!trimmed) return

    if (this.busy) {
      log('Turn already in flight — rejecting concurrent submitTurn')
      throw new Error('Voice agent is still responding to the previous turn.')
    }

    this._ensureSpawned()

    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      throw new Error('Voice agent process is not running.')
    }

    this.busy = true

    // Prepend a live tab snapshot so the model can answer "what's tab 2 doing?"
    // without a rax_list_tabs round-trip. To keep the prompt-cache hot
    // across consecutive turns we only resend the snapshot when it has
    // actually changed since the last turn — when it's the same, we send a
    // single-byte `unchanged` marker instead of the full N×~120-char block.
    // The model already has the prior snapshot in its conversation context.
    const snapshot = formatTabsSnapshot(this.opts.tabContext.list())
    // Wrapper is named `<rax_crew>` because the five dock agents are people-
    // shaped to the model — see ORB_SYSTEM_PROMPT.
    const sameAsLast = this.lastSnapshot !== null && snapshot === this.lastSnapshot
    const tabsBlock = sameAsLast
      ? '<rax_crew unchanged="true"/>'
      : `<rax_crew>\n${snapshot}\n</rax_crew>`
    this.lastSnapshot = snapshot
    // Splice in any pending crew completions so the orb can address the user
    // first and end with a quick "and Max just wrapped the build" aside. The
    // standalone autonomous-recap path lives in `submitSystemTurn` below.
    const completionsBlock = this._drainCompletions('prepended')
    const wrapped = completionsBlock
      ? `${tabsBlock}\n\n${completionsBlock}\n\n${trimmed}`
      : `${tabsBlock}\n\n${trimmed}`

    // When an auto-attached screenshot is supplied, lead with the image so
    // the agent reasons over the pixels alongside the user's words. Anthropic
    // recommends image-before-text when the prompt refers to the image.
    type StreamJsonContent =
      | { type: 'text'; text: string }
      | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
    const content: StreamJsonContent[] = attachment
      ? [
          { type: 'image', source: { type: 'base64', media_type: attachment.mimeType, data: attachment.base64 } },
          { type: 'text', text: wrapped },
        ]
      : [{ type: 'text', text: wrapped }]

    const userMessage = JSON.stringify({
      type: 'user',
      message: { role: 'user', content },
    })

    log(
      `Submitting turn (${trimmed.length} chars + tabs ${sameAsLast ? 'unchanged' : `${snapshot.length}b`}` +
        `${attachment ? ` + image ${Math.round(attachment.base64.length / 1024)}KB` : ''})`,
    )
    this.child.stdin.write(userMessage + '\n')

    // orb_user_turn first so the voice tab's user-message bubble exists
    // before orb_user_attachment lands — the chip is rendered on the bubble
    // for the same turn. The orb window's flash is a canvas overlay that
    // doesn't depend on event ordering, so a sub-ms delay is invisible.
    this.emit('event', { type: 'orb_user_turn', text: trimmed })
    if (attachment) {
      this.emit('event', {
        type: 'orb_user_attachment',
        kind: 'screenshot',
        display: attachment.display,
        capturedAt: Date.now(),
      })
    }

    // No turn timeout — voice agent runs as long as the user-summoned task
    // needs. The user can right-click the orb to cancel.
  }

  /**
   * Cancel an in-flight turn gracefully. Sends a stream-json "interrupt"
   * over stdin so the claude process can finalize the turn cleanly without
   * us having to kill the whole subprocess (which would force a respawn).
   */
  cancelTurn(): void {
    if (!this.child || !this.busy) return
    this._cancelTurnInternal('user')
  }

  /** Whether a turn is currently being processed. */
  isBusy(): boolean {
    return this.busy
  }

  /** Queue an autonomous notification that a crew member just finished. */
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
   * Fire an autonomous turn whose only payload is the pending agent_updates
   * block. No-op if the orb is busy or there is nothing fresh to surface.
   * The trailing instruction line steers the model to speak ONE short recap
   * and stop — no tools, no follow-up question.
   */
  async submitSystemTurn(): Promise<void> {
    if (this.busy) {
      log('submitSystemTurn skipped — already busy')
      return
    }
    if (!this.hasPendingCompletions()) return

    this._ensureSpawned()
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      log('submitSystemTurn skipped — process not running')
      return
    }

    const block = this._drainCompletions('autonomous')
    if (!block) return

    this.busy = true

    const snapshot = formatTabsSnapshot(this.opts.tabContext.list())
    const sameAsLast = this.lastSnapshot !== null && snapshot === this.lastSnapshot
    const tabsBlock = sameAsLast
      ? '<rax_crew unchanged="true"/>'
      : `<rax_crew>\n${snapshot}\n</rax_crew>`
    this.lastSnapshot = snapshot

    const wrapped =
      `${tabsBlock}\n\n${block}\n\n` +
      `(autonomous update — no user prompt. Speak ONE short recap to the user about the crew completion(s) above. Do not call tools. Do not ask a follow-up.)`

    const userMessage = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: wrapped }] },
    })

    log('submitSystemTurn — pending completion(s) drained, writing to stdin')
    this.child.stdin.write(userMessage + '\n')

    // Empty text on orb_user_turn skips the user-bubble in the renderer but
    // still arms the orb's response bubble for streaming text.
    this.emit('event', { type: 'orb_user_turn', text: '', autonomous: true })
  }

  /**
   * Drop expired completions, then render the survivors into one
   * `<agent_updates>` block ready to splice into a user message. Returns
   * null if there is nothing fresh left to surface.
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

  /** Whether the underlying claude process is alive and ready. */
  isAlive(): boolean {
    return !!this.child && this.child.exitCode === null && !this.child.killed
  }

  /**
   * Reset the conversation. Kills the current claude subprocess so the next
   * turn spawns a fresh session with no memory of prior turns. Used by the
   * "new conversation" gesture.
   */
  resetConversation(): void {
    log('Resetting conversation — killing current claude process')
    if (this.child) {
      try { this.child.stdin?.end() } catch {}
      try { this.child.kill('SIGTERM') } catch {}
      this.child = null
    }
    this.parser = null
    this.busy = false
    // Fresh process means the model has lost its conversation context, so
    // the next turn must include a full tab snapshot again.
    this.lastSnapshot = null
    // Drop any queued recaps — unattached, they'd arrive with no anchor
    // in the new conversation.
    this.pendingCompletions = []
  }


  /**
   * Eagerly warm the claude subprocess so the user's first turn doesn't pay
   * the spawn-and-init latency. Idempotent.
   */
  warmup(): void {
    if (this.isAlive()) return
    log('Warming up orb claude process')
    try {
      this._ensureSpawned()
    } catch (err) {
      log(`Warmup failed: ${(err as Error).message}`)
    }
  }

  /**
   * Update the model used for subsequent turns. The CLI session reads model
   * from `--model` at spawn time, so we cannot live-switch — instead we
   * remember the new id and respawn on the next turn so it picks up the flag.
   * If no turn is in flight we proactively respawn now so the user's first
   * turn after the picker change is immediate.
   */
  setModel(modelId: string): void {
    if (!modelId) return
    if (this.opts.model === modelId) return
    log(`Switching orb (CLI) model: ${this.opts.model || 'cli-default'} → ${modelId}; will respawn`)
    this.opts.model = modelId
    if (!this.busy && this.child) {
      try { this.child.stdin?.end() } catch {}
      try { this.child.kill('SIGTERM') } catch {}
      this.child = null
      this.parser = null
      this.lastSnapshot = null
    }
  }

  getModel(): string | undefined {
    return this.opts.model
  }

  shutdown(): void {
    log('Shutdown requested')
    if (this.child) {
      try {
        this.child.stdin?.end()
      } catch {}
      try {
        this.child.kill('SIGTERM')
      } catch {}
      this.child = null
    }
    this.pendingCompletions = []
    this._cleanupTempFiles()
  }

  // ─── Internals ───

  private _cancelTurnInternal(reason: 'user'): void {
    if (!this.child) return
    log(`Cancelling in-flight turn (${reason})`)
    // stream-json "interrupt" — claude finalizes gracefully.
    try {
      const msg = JSON.stringify({ type: 'interrupt' })
      if (this.child.stdin && !this.child.stdin.destroyed) {
        this.child.stdin.write(msg + '\n')
      }
    } catch {}
    // Belt-and-suspenders: if claude doesn't respond to interrupt within 4s,
    // SIGINT the process — but resetConversation will respawn next turn.
    setTimeout(() => {
      if (this.busy && this.child && !this.child.killed) {
        log('Interrupt unanswered — escalating to SIGINT')
        try { this.child.kill('SIGINT') } catch {}
      }
    }, 4000).unref?.()
  }

  private _ensureSpawned(): void {
    if (this.isAlive()) return

    // Materialize the MCP stdio shim to a tmp file that claude can spawn.
    // Use a fresh path each time so we don't collide with a stale one left by
    // a previous launch.
    if (!this.mcpScriptPath || !existsSync(this.mcpScriptPath)) {
      const dir = tmpdir()
      this.mcpScriptPath = join(dir, `${TEMP_PREFIX}mcp-${randomBytes(6).toString('hex')}.cjs`)
      writeFileSync(this.mcpScriptPath, mcpServerSrc as string, { mode: 0o600 })
    }

    if (!this.mcpConfigPath || !existsSync(this.mcpConfigPath)) {
      this.mcpConfigPath = join(tmpdir(), `${TEMP_PREFIX}cfg-${randomBytes(6).toString('hex')}.json`)
      const cfg = {
        mcpServers: {
          'rax-orb': {
            type: 'stdio',
            command: process.execPath, // Electron's bundled node can run plain CJS.
            args: [this.mcpScriptPath],
            env: {
              RAX_ORB_RPC_URL: this.opts.rpc.url,
              RAX_ORB_RPC_SECRET: this.opts.rpc.secret,
              ELECTRON_RUN_AS_NODE: '1',
            },
          },
        },
      }
      writeFileSync(this.mcpConfigPath, JSON.stringify(cfg), { mode: 0o600 })
    }

    const args: string[] = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', 'bypassPermissions',
      '--mcp-config', this.mcpConfigPath,
      '--append-system-prompt', ORB_SYSTEM_PROMPT,
    ]
    if (this.opts.model && !this.opts.model.startsWith('kimi-')) {
      args.push('--model', this.opts.model)
    }
    // kimi-* model ids fail the CLI's local --model validator. We omit the
    // flag and let buildClaudeEnv's ANTHROPIC_*_MODEL env vars take over.

    const { command, args: spawnArgs, instance } = buildClaudeSpawnInvocation(args)
    log(`Spawning orb claude [${instance.mode}]: ${command} ${spawnArgs.slice(0, 12).join(' ')} …`)

    const child = spawn(command, spawnArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.opts.projectPath,
      // RAX_REQUESTED_MODEL tells buildClaudeEnv which provider to wire
      // (kimi-* → Moonshot, otherwise Rax cloud or user's own creds).
      env: buildClaudeEnv(this.opts.model ? { RAX_REQUESTED_MODEL: this.opts.model } : undefined),
    })
    this.child = child
    log(`Spawned PID ${child.pid}`)

    const parser = StreamParser.fromStream(child.stdout!)
    this.parser = parser

    parser.on('event', (raw: ClaudeEvent) => this._handleRawEvent(raw))
    parser.on('parse-error', (line: string) => log(`Parse error: ${line.substring(0, 200)}`))

    child.stderr?.setEncoding('utf-8')
    child.stderr?.on('data', (data: string) => {
      const lines = data.split('\n').filter((l) => l.trim())
      for (const line of lines) {
        this.stderrTail.push(line)
        if (this.stderrTail.length > 50) this.stderrTail.shift()
      }
      if (data.trim()) log(`stderr: ${data.trim().substring(0, 400)}`)
    })

    child.on('close', (code, signal) => {
      log(`Process closed: code=${code} signal=${signal}`)
      const wasIntentional = this.child === child ? false : true // resetConversation already cleared this.child
      this.busy = false
      if (this.child === child) this.child = null
      this.parser = null
      // Don't emit session-dead for intentional resets — the controller already knows.
      if (!wasIntentional) {
        this.emit('session-dead', { code, signal, stderrTail: [...this.stderrTail] })
      }
    })

    child.on('error', (err) => {
      log(`Process error: ${err.message}`)
      this.busy = false
      this.emit('session-dead', { code: null, signal: null, stderrTail: [err.message] })
    })
  }

  private _handleRawEvent(raw: ClaudeEvent): void {
    if (raw.type === 'result') {
      // claude prints `result` to mark the end of the turn. Keep stdin open
      // for the next turn — closing it would force a respawn and lose memory.
      const ok = !(raw as { is_error?: boolean }).is_error
      const normalized = normalize(raw)
      for (const evt of normalized) this.emit('event', evt)
      this.busy = false
      this.emit('turn-end', ok)
      return
    }

    const normalized = normalize(raw)
    for (const evt of normalized) this.emit('event', evt)
  }

  private _cleanupTempFiles(): void {
    if (this.mcpScriptPath) {
      try { unlinkSync(this.mcpScriptPath) } catch {}
      this.mcpScriptPath = ''
    }
    if (this.mcpConfigPath) {
      try { unlinkSync(this.mcpConfigPath) } catch {}
      this.mcpConfigPath = ''
    }
  }
}

/** Clip a string to a max length, appending an ellipsis when truncated. */
function clipCompletionText(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? flat.substring(0, n - 1) + '…' : flat
}

/**
 * Sweep any leftover orb temp files from previous launches that didn't get a
 * chance to call shutdown (force-quit, crash, hard kill). Called once on app
 * startup. Best-effort; failures are logged but never thrown.
 */
export function sweepStaleOrbTempFiles(): number {
  let removed = 0
  try {
    const dir = tmpdir()
    const files = readdirSync(dir)
    for (const f of files) {
      if (f.startsWith(TEMP_PREFIX) && (f.endsWith('.cjs') || f.endsWith('.json'))) {
        try {
          unlinkSync(join(dir, f))
          removed++
        } catch {}
      }
    }
    if (removed > 0) log(`Swept ${removed} stale orb temp file(s)`)
  } catch (err) {
    log(`Sweep failed: ${(err as Error).message}`)
  }
  return removed
}

// Kept tight on purpose — every byte rides on every turn before prompt
// caching warms. Stylistic guidance ("don't preface with 'great question'")
// and verbose macOS-permissions troubleshooting were removed; the model
// already obeys the former, and the latter is now surfaced inline by the
// `accessibility_denied` error returned from rax_control_screen.
const ORB_SYSTEM_PROMPT = [
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
  '    • Mix OPENER. Rotate among "let me", "okay,", "alright,", "now,", "next,", "and,", "then,", bare gerund ("opening …", "checking …", "grabbing …"). Never two narrations in a row starting with the same word. "let me" max once per 4 tools — it\'s the biggest robotic tell.',
  '    • Mix VERB. check / look at / peek at / pull up / grab / snap / kick off / patch / tweak / fire off / drop in / hand off / loop in. Don\'t repeat a main verb within 2 narrations.',
  '    • Mix CLOSER. "for you" / "hang on a moment" / "one sec" / "real quick" / "this might take a sec" / no closer at all. Don\'t repeat the same closer back-to-back.',
  '    • CONNECT across the turn. For 3+ tools on one composite request, the FIRST narration frames the whole intent ("okay, let me take a look at your desktop"), and subsequent ones chain with "now", "then", "next", "and now", "after that". For unrelated tools in the same turn use honest separators ("also", "separately", "and one other thing") — don\'t fake continuity.',
  '    • SAME TARGET as the previous tool? Use pronouns or "another / again / one more". Don\'t re-introduce the target each time ("taking a screenshot… now another to compare" — not "taking a screenshot… now taking a screenshot of display two").',
  '    • REACTING to what a previous tool revealed? Open with "interesting —", "hm,", "ahh, I see —", "okay so". Marks a genuine pivot, not a fake one.',
  '    • LAST narration before the final result-text should SOFTEN with anticipatory phrasing ("okay, here\'s what I\'m seeing", "let me put this together") so the seam between narration and result disappears.',
  '    • KOKORO TTS hint: put a comma after openers ("okay, let me…" not "okay let me…") — Kokoro gives commas a real breath. End every narration with a period. Never use ellipses (they render as uncertain drift).',
  '',
  '  Anti-robot bans (never do these):',
  '    × Speak tool identifiers verbatim ("with the write tool now", "calling rax_screenshot") — strip them; the user doesn\'t care which tool.',
  '    × Read absolute file paths or URLs aloud — refer by role/topic ("the auth file", "that anthropic page", "your safari icon").',
  '    × Read secrets / tokens / api keys — acknowledge obliquely ("running that curl, key stays hidden").',
  '    × Refer to a crew member as a "tab", "session", "agent number 2", or by id ("agent-max") — always say their NAME.',
  '    × Chant: identical opener, identical verb, identical length, or identical "now" tic across consecutive narrations.',
  '',
  '  SILENT tools (Read / Glob / Grep / LS / TodoRead / TodoWrite) — skip narration entirely. For everything else, narration is REQUIRED.',
  '',
  '  Style anchors (copy the rhythm, not the words):',
  '    Bash(git status)                              → "let me check your git status real quick."',
  '    Bash(npm test)                                → "kicking off the test suite, this might take a sec."',
  '    Bash(curl with bearer token)                  → "running that curl for you, key stays hidden."',
  '    Edit(file_path=…/login-handler.ts)            → "patching the login handler now, hang on a moment."',
  '    Write(file_path=README.md)                    → "writing out a fresh readme for you."',
  '    WebSearch(query="kokoro prosody pause")       → "searching the web for kokoro prosody pause."',
  '    WebFetch(url=anthropic.com/news/claude-4-7)   → "pulling up that anthropic article now."',
  '    rax_screenshot()                              → "okay, quick look at your screen."',
  '    rax_screenshot() [right after the one above]  → "and another snap to see what changed."',
  '    rax_control_screen(action=click, dock area)   → "now clicking the safari icon in your dock."',
  '    rax_control_screen(action=type, text="hi")    → "typing hi in for you."',
  '    rax_control_screen(action=scroll, dy=-400)    → "scrolling down to find it."',
  '    rax_send_to_tab(tab="Max", prompt="run the full build")     → "handing the build over to Max."',
  '    rax_send_to_tab(tab="Luna", prompt="dig into RFC 8259")     → "asking Luna to dig into that RFC for us."',
  '    rax_send_to_tab_and_wait(tab="Zara", prompt="ship the PR")  → "letting Zara close this one out, one sec."',
  '    rax_read_tab(tab="Alex")                                    → (silent — checking on Alex)',
  '    rax_focus_tab(tab="Nova")                                   → "pulling Nova up so you can see."',
  '',
  'You have the full Claude Code toolbelt (Bash, Read, Edit, Write, Glob, Grep, WebSearch, WebFetch, etc.) on the user\'s real Mac. Permissions are bypassed for your session — confirm before anything clearly destructive.',
  '',
  'MCP toolset "rax-orb" — your eyes, hands, and crew radio:',
  '  - rax_list_tabs / rax_read_tab — check what each crew member is doing right now (status, last message, transcript depth).',
  '  - rax_send_to_tab / rax_send_to_tab_and_wait — dispatch a prompt to a named crew member. Always pass their NAME as `tab` (e.g. `tab="Max"`). Use the …_and_wait variant when the user needs the answer before you can reply.',
  '  - rax_focus_tab — bring a crew member\'s window forward so the user can watch them work. Again, refer by NAME.',
  '  - rax_open_tab — legacy escape hatch only. The crew is fixed at five; do NOT spin up new ones. Use rax_send_to_tab against an idle crew member instead.',
  '  - rax_describe_self — host / project / platform metadata.',
  '  - rax_screenshot — capture the screen. The OS cursor is HIDDEN; a RED RING + white dot marks the cursor location. Use this for FOLLOW-UP captures (e.g. to verify a control_screen action took effect, or to capture a non-cursor display). The initial screen view is auto-attached for screen-reference turns — see below.',
  '  - rax_control_screen — drive mouse and keyboard (click / double_click / type / key / scroll / cursor_position). COORDINATES ARE IMAGE-PIXEL COORDS of your most recent rax_screenshot — the exact pixels you see in the picture, top-left origin. The tool internally converts to display points and posts real CGEvent mouse/keyboard events (not AppleScript) so clicks work reliably in browsers, Electron apps, Slack, IDEs. ALWAYS screenshot first; if a screenshot is older than ~2 turns, re-capture before clicking — the window arrangement may have changed. If the response has error="accessibility_denied", tell the user to approve Rax in System Settings → Privacy & Security → Accessibility, then retry.',
  '',
  'Every user turn is prepended with <rax_crew>…</rax_crew> — a live one-line-per-crew-member snapshot. Lines look like `[2] Alex (the architect) working tool=Edit msg="…"`. Trust it for grounding. When the same snapshot would repeat we send <rax_crew unchanged="true"/> instead — assume the prior snapshot still applies. Use rax_read_tab for transcript depth, rax_list_tabs for fields the snapshot omits.',
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
  'AUTO-ATTACHED SCREENSHOTS: when a user message arrives with an attached image, that image is an auto-captured screenshot of the display the user\'s cursor was on, taken the instant they finished speaking. Treat it as their current view. The OS cursor is hidden; a red ring with a white dot marks the cursor location. Do NOT call rax_screenshot for the initial view in that turn — you already have it. Only call rax_screenshot if you need a follow-up capture (e.g. to verify a rax_control_screen action took effect, or if the user references a different display).',
  '',
  'Crew references in tool calls: always pass the agent\'s NAME ("Max", "alex", "LUNA" — case-insensitive). The fuzzy resolver also accepts 1-based index or UUID, but NAMES are canonical and how the user thinks. After dispatching to a crew member, briefly tell the user who you sent it to — they may be looking at a different one.',
  '',
  'Stay grounded. Don\'t guess. If you don\'t know, say so and offer to find out.',
].join('\n')
