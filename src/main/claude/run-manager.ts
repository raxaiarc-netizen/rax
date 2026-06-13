import { spawn, ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { homedir } from 'os'
import { StreamParser } from '../stream-parser'
import { normalize } from './event-normalizer'
import { log as _log } from '../logger'
import { applyBalanceGate, buildClaudeEnv, buildClaudeSpawnInvocation } from './claude-instance'
import { ensureTabMcpFiles, TAB_MCP_TOOL_NAMES } from './computer-use-mcp'
import type { OrbRpcInfo } from '../orb/orb-rpc'
import type { ClaudeEvent, NormalizedEvent, RunOptions, EnrichedError } from '../../shared/types'

const MAX_RING_LINES = 100
const DEBUG = process.env.RAX_DEBUG === '1'

// Appended to Claude's default system prompt so it knows it's running inside RAX.
// Uses --append-system-prompt (additive) not --system-prompt (replacement).
const RAX_SYSTEM_HINT = [
  'IMPORTANT: You are NOT running in a terminal. You are running inside RAX,',
  'a desktop chat application with a rich UI that renders full markdown.',
  'RAX is a GUI wrapper around Claude Code — the user sees your output in a',
  'styled conversation view, not a raw terminal.',
  '',
  'Because RAX renders markdown natively, you MUST use rich formatting when it helps:',
  '- Always use clickable markdown links: [label](https://url) — they render as real buttons.',
  '- When the user asks for images, and public web images are appropriate, proactively find and render them in RAX.',
  '- Workflow: WebSearch for relevant public pages -> WebFetch those pages -> extract real image URLs -> render with markdown ![alt](url).',
  '- Do not guess, fabricate, or construct image URLs from memory.',
  '- Only embed images when the URL is a real publicly accessible image URL found through tools or explicitly provided by the user.',
  '- If real image URLs cannot be obtained confidently, fall back to clickable links and briefly say so.',
  '- Do not ask whether RAX can render images; assume it can.',
  '- Use tables, bold, headers, and bullet lists freely — they all render beautifully.',
  '- Use code blocks with language tags for syntax highlighting.',
  '',
  'You are still a software engineering assistant. Keep using your tools (Read, Edit, Bash, etc.)',
  'normally. But when presenting information, links, resources, or explanations to the user,',
  'take full advantage of the rich UI. The user expects a polished chat experience, not raw terminal text.',
].join('\n')

/**
 * Per-crew-member identity + voice-orb contract, appended to the system
 * prompt of the five fixed dock agents (Max/Alex/Luna/Nova/Zara). Built in
 * ControlPlane._dispatch (which knows the tabId → agent mapping) and passed
 * down via RunOptions.appendSystemPrompt.
 *
 * Two jobs:
 *  1. SENDER AWARENESS — work can arrive two ways: dispatched by the user's
 *     realtime VOICE assistant (the Rax orb) or typed directly by the user.
 *     Orb dispatches are mechanically wrapped in <orb_dispatch> tags at the
 *     RPC layer (see wrapOrbDispatch in orb-rpc.ts), so the agent can tell
 *     them apart with certainty instead of guessing from tone.
 *  2. VOICE-FRIENDLY REPLIES — when the work came from the orb, the agent's
 *     final message gets relayed to the user BY VOICE (either returned to
 *     the orb via rax_send_to_tab_and_wait or spoken as an <agent_updates>
 *     recap). A reply that leads with paths/code makes a terrible recap, so
 *     the contract asks for a spoken-English headline first, details below.
 */
export function buildCrewAgentHint(name: string, tagline: string): string {
  return [
    '',
    `YOUR IDENTITY: you are ${name} — "${tagline}" — one of the five Rax crew agents (Max the heavy lifter, Alex the architect, Luna the researcher, Nova the spark, Zara the closer) shown in the dock on the user's screen. The user also has a realtime VOICE assistant, the Rax orb, which conducts the crew: the user speaks to the orb, and the orb dispatches work to you and reports your results back — often out loud.`,
    '',
    'WHO IS TALKING TO YOU:',
    '  - A message wrapped in <orb_dispatch> tags came from the VOICE ORB on the user\'s behalf — the user spoke, the orb briefed you. Inside you may find a <crew_handoff> block (the user\'s verbatim words are the source of truth over the orb\'s rewrite) and a "Project directory:" line telling you which project the work belongs to.',
    '  - Any message WITHOUT <orb_dispatch> tags was typed by the user directly into your chat window. Talk to them normally — full markdown, as much detail as helps.',
    '',
    'REPLYING TO AN ORB DISPATCH — your final message will be relayed to the user by voice as a short recap, so shape it for speech:',
    '  - Open with 1-2 plain spoken-English sentences stating the outcome ("Done — the build passes again; the culprit was a stale import."). No file paths, URLs, code, or markdown syntax in those opening sentences.',
    '  - Put the full details — paths, diffs, commands, caveats — BELOW that headline for the user to read in the dock.',
    '  - If you are blocked or need a decision, say so in the headline in one sentence the orb can speak.',
    '  - You are talking to the USER, not the orb — the orb is just the messenger. Never address the orb.',
  ].join('\n')
}

// Appended ONLY when the computer-use MCP is wired in. Tells Claude that
// rax_screenshot / rax_control_screen exist, that they act on the user's
// real Mac, and how to combine them safely. Same shape as the orb's prompt
// but tuned for a typed-chat surface instead of a voice surface.
const COMPUTER_USE_HINT = [
  '',
  'COMPUTER USE — you can see the user\'s screen and drive their mouse/keyboard:',
  '  - mcp__rax-tools__rax_screenshot — capture the screen. The OS cursor arrow is hidden;',
  '    a red ring + white dot marks the cursor location. Use whenever the user says "look at this",',
  '    "what\'s on my screen", "what am I pointing at", or before driving the cursor.',
  '  - mcp__rax-tools__rax_control_screen — click / double_click / type / key / scroll / cursor_position.',
  '    ALWAYS take a screenshot first. Pass coordinates as IMAGE-PIXEL coords of that screenshot — the',
  '    exact pixels you see in the picture, top-left origin. The tool internally converts to global',
  '    display points and posts real CGEvent mouse/keyboard events (not AppleScript), so clicks work',
  '    reliably in browsers, Electron apps, Slack, IDEs, etc. If your screenshot is more than a couple',
  '    of turns old, re-capture before clicking — the window arrangement may have changed.',
  '    If the response has error="accessibility_denied", tell the user to approve Rax in',
  '    System Settings → Privacy & Security → Accessibility, then retry.',
  '  - Only drive the screen when the user has clearly asked for it. Never click destructive controls',
  '    (Delete, Send, Submit, paid actions) without explicit confirmation in the same turn.',
].join('\n')

// Tools auto-approved via --allowedTools (never trigger the permission card).
// Includes routine internal agent mechanics (Agent, Task, TaskOutput, TodoWrite,
// Notebook) — prompting for these would make UX terrible without adding meaningful
// safety. This is a deliberate RAX policy choice, not native Claude parity.
// If runtime evidence shows any of these create real user-facing approval moments,
// they should be moved to the hook matcher in permission-server.ts instead.
const SAFE_TOOLS = [
  'Read', 'Glob', 'Grep', 'LS',
  'TodoRead', 'TodoWrite',
  'Agent', 'Task', 'TaskOutput',
  'Notebook',
  'WebSearch',
  // NOTE: WebFetch is NOT here — it can exfiltrate transcript content to an
  // arbitrary URL, so it routes through the permission hook with a
  // domain-scoped allow option instead.
]

// Pre-approved set used when the hook server is unavailable AND the user has
// chosen 'auto' mode. We pre-approve every dangerous tool because the user
// has explicitly opted out of approval prompts.
//
// For 'ask' mode without a hook we INTENTIONALLY do NOT pre-approve dangerous
// tools — only SAFE_TOOLS. Claude then surfaces dangerous-tool requests as
// `permission_denials` in the result event, which the renderer renders as the
// PermissionDeniedCard with `hookReached=false`. That keeps the user-visible
// promise of 'ask' mode honored: never silently approve a destructive tool
// just because the hook server failed to start.
const HOOKLESS_AUTO_ALLOWED_TOOLS = [
  'Bash', 'Edit', 'Write', 'MultiEdit', 'WebFetch',
  ...SAFE_TOOLS,
]

function log(msg: string): void {
  _log('RunManager', msg)
}

export interface RunHandle {
  runId: string
  sessionId: string | null
  process: ChildProcess
  pid: number | null
  startedAt: number
  /** Ring buffer of last N stderr lines */
  stderrTail: string[]
  /** Ring buffer of last N stdout lines */
  stdoutTail: string[]
  /** Count of tool calls seen during this run */
  toolCallCount: number
  /** Whether any permission_request event was seen during this run */
  sawPermissionRequest: boolean
  /** Permission denials from result event */
  permissionDenials: Array<{ tool_name: string; tool_use_id: string }>
}

/**
 * RunManager: spawns one `claude -p` process per run, parses NDJSON,
 * emits normalized events, handles cancel, and keeps diagnostic ring buffers.
 *
 * Events emitted:
 *  - 'normalized' (runId, NormalizedEvent)
 *  - 'raw' (runId, ClaudeEvent)  — for logging/debugging
 *  - 'exit' (runId, code, signal, sessionId)
 *  - 'error' (runId, Error)
 */
export class RunManager extends EventEmitter {
  private activeRuns = new Map<string, RunHandle>()
  /** Holds recently-finished runs so diagnostics survive past process exit */
  private _finishedRuns = new Map<string, RunHandle>()
  /**
   * Resolver for the orb RPC server info. Pull-style so RunManager can be
   * constructed before the orb's RPC has started; returns null until it has.
   * When non-null, the MCP shim is materialized and `--mcp-config` is wired
   * into every spawn so chat tabs gain screenshot + screen-control tools.
   */
  private rpcInfoProvider: (() => OrbRpcInfo | null) | null = null

  constructor() {
    super()
  }

  /**
   * Wire up the computer-use MCP. Called once at startup after the orb's
   * RPC server has been started. Idempotent — late calls replace the provider.
   */
  setRpcInfoProvider(provider: () => OrbRpcInfo | null): void {
    this.rpcInfoProvider = provider
  }

  startRun(requestId: string, options: RunOptions): RunHandle {
    const cwd = options.projectPath === '~' ? homedir() : options.projectPath

    // Bypass: skip Claude's permission machinery entirely so dangerous tools
    // (Write/Edit/Bash/MultiEdit) cannot be denied by the CLI's own checks.
    // This matches the StatusBar tooltip's promise of "equivalent to
    // --dangerously-skip-permissions" — without it, bypass relied on the hook
    // server's auto-allow path, which fails closed on any timing/HTTP hiccup.
    const claudePermMode = options.permissionMode === 'bypass' ? 'bypassPermissions' : 'default'

    const args: string[] = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', claudePermMode,
    ]

    // Wire the computer-use MCP if the orb's RPC server is up. Materializes
    // a per-app-launch shim that proxies tools/call → orb-rpc HTTP endpoints,
    // giving chat tabs access to rax_screenshot + rax_control_screen.
    // Failure here is non-fatal: we log and run without computer use, since
    // the orb RPC being down should never break the chat surface.
    let computerUseEnabled = false
    const rpc = this.rpcInfoProvider ? this.rpcInfoProvider() : null
    if (rpc) {
      try {
        const { configPath } = ensureTabMcpFiles(rpc)
        args.push('--mcp-config', configPath)
        computerUseEnabled = true
      } catch (err) {
        log(`Failed to wire computer-use MCP — running without it: ${(err as Error).message}`)
      }
    }

    if (options.sessionId) {
      args.push('--resume', options.sessionId)
    }
    // $0-balance backstop — swaps a paid model for the free Rax Default when
    // the Rax proxy is active with no credits (see claude-instance.ts).
    options.model = applyBalanceGate(options.model)
    if (options.model && !options.model.startsWith('kimi-')) {
      args.push('--model', options.model)
    }
    // For kimi-* the CLI's own model validator rejects the id before any
    // request is sent. We omit --model and rely on the ANTHROPIC_*_MODEL
    // env vars set by buildClaudeEnv to route the spawn to Moonshot.
    // Effort is Anthropic-only — the Moonshot proxy doesn't understand the
    // CLI's effort plumbing, so skip it for kimi-* spawns too.
    if (options.effort && !(options.model || '').startsWith('kimi-')) {
      args.push('--effort', options.effort)
    }
    if (options.addDirs && options.addDirs.length > 0) {
      for (const dir of options.addDirs) {
        args.push('--add-dir', dir)
      }
    }

    // Computer-use MCP tools route through the orb's RPC bridge — they don't
    // touch the filesystem or shell, and they already pre-flight the macOS
    // Accessibility permission. Pre-approve them everywhere so they never hit
    // a permission card. The user controls them at the OS level (Accessibility
    // toggle in System Settings).
    const computerUseAllowed = computerUseEnabled ? [...TAB_MCP_TOOL_NAMES] : []

    if (options.permissionMode === 'bypass') {
      // bypassPermissions allows everything natively — no --settings, no --allowedTools needed.
      // User-supplied allowedTools (rare) are still honored.
      const merged = [...computerUseAllowed, ...(options.allowedTools || [])]
      if (merged.length > 0) {
        args.push('--allowedTools', merged.join(','))
      }
    } else if (options.hookSettingsPath) {
      // RAX-scoped hook settings: the PreToolUse HTTP hook handles permissions
      // for dangerous tools (Bash, Edit, Write, MultiEdit).
      // Auto-approve safe tools so they don't trigger the permission card.
      args.push('--settings', options.hookSettingsPath)
      const safeAllowed = [
        ...SAFE_TOOLS,
        ...computerUseAllowed,
        ...(options.allowedTools || []),
      ]
      args.push('--allowedTools', safeAllowed.join(','))
    } else if (options.permissionMode === 'auto') {
      // Hookless auto: user explicitly opted out of prompts, pre-approve
      // dangerous tools too.
      const allAllowed = [
        ...HOOKLESS_AUTO_ALLOWED_TOOLS,
        ...computerUseAllowed,
        ...(options.allowedTools || []),
      ]
      args.push('--allowedTools', allAllowed.join(','))
    } else {
      // Hookless ASK (or undefined mode — treat as ask): fail CLOSED.
      // Only safe tools are pre-approved; dangerous tools end up in the
      // result event's permission_denials, which the renderer surfaces as
      // a PermissionDeniedCard with hookReached=false. The user can then
      // hit "Allow & Retry" or restart with the hook server working.
      log(`Hook server unavailable in ask mode — failing closed (dangerous tools will be denied by Claude)`)
      const safeOnly = [
        ...SAFE_TOOLS,
        ...computerUseAllowed,
        ...(options.allowedTools || []),
      ]
      args.push('--allowedTools', safeOnly.join(','))
    }
    if (options.maxTurns) {
      args.push('--max-turns', String(options.maxTurns))
    }
    if (options.maxBudgetUsd) {
      args.push('--max-budget-usd', String(options.maxBudgetUsd))
    }
    if (options.systemPrompt) {
      args.push('--system-prompt', options.systemPrompt)
    }
    // Always tell Claude it's inside RAX (additive, doesn't replace base prompt).
    // When the computer-use MCP is wired in, also teach Claude that those tools
    // exist and how to use them safely. Crew tabs additionally get their
    // identity + voice-orb contract via options.appendSystemPrompt.
    let appendedPrompt = computerUseEnabled
      ? `${RAX_SYSTEM_HINT}\n${COMPUTER_USE_HINT}`
      : RAX_SYSTEM_HINT
    if (options.appendSystemPrompt) {
      appendedPrompt += `\n${options.appendSystemPrompt}`
    }
    args.push('--append-system-prompt', appendedPrompt)

    const { command, args: spawnArgs, instance } = buildClaudeSpawnInvocation(args)
    if (DEBUG) {
      log(`Starting run ${requestId} [${instance.mode}]: ${command} ${spawnArgs.join(' ')}`)
      log(`Prompt: ${options.prompt.substring(0, 200)}`)
    } else {
      log(`Starting run ${requestId} [${instance.mode}]`)
    }

    const child = spawn(command, spawnArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      // RAX_REQUESTED_MODEL tells buildClaudeEnv which provider to wire
      // (kimi-* → Moonshot, otherwise Rax cloud or user's own creds).
      // The sentinel is stripped before the subprocess inherits the env.
      env: buildClaudeEnv(options.model ? { RAX_REQUESTED_MODEL: options.model } : undefined),
    })

    log(`Spawned PID: ${child.pid}`)

    const handle: RunHandle = {
      runId: requestId,
      sessionId: options.sessionId || null,
      process: child,
      pid: child.pid || null,
      startedAt: Date.now(),
      stderrTail: [],
      stdoutTail: [],
      toolCallCount: 0,
      sawPermissionRequest: false,
      permissionDenials: [],
    }

    // ─── stdout → NDJSON parser → normalizer → events ───
    const parser = StreamParser.fromStream(child.stdout!)

    parser.on('event', (raw: ClaudeEvent) => {
      // Track session ID
      if (raw.type === 'system' && 'subtype' in raw && raw.subtype === 'init') {
        handle.sessionId = (raw as any).session_id
      }

      // Track permission_request events
      if (raw.type === 'permission_request' || (raw.type === 'system' && 'subtype' in raw && (raw as any).subtype === 'permission_request')) {
        handle.sawPermissionRequest = true
        log(`Permission request seen [${requestId}]`)
      }

      // Extract permission_denials from result event
      if (raw.type === 'result') {
        const denials = (raw as any).permission_denials
        if (Array.isArray(denials) && denials.length > 0) {
          handle.permissionDenials = denials.map((d: any) => ({
            tool_name: d.tool_name || '',
            tool_use_id: d.tool_use_id || '',
          }))
          log(`Permission denials [${requestId}]: ${JSON.stringify(handle.permissionDenials)}`)
        }
      }

      // Ring buffer stdout lines (raw JSON for diagnostics)
      this._ringPush(handle.stdoutTail, JSON.stringify(raw).substring(0, 300))

      // Emit raw event for debugging
      this.emit('raw', requestId, raw)

      // Normalize and emit canonical events
      const normalized = normalize(raw)
      for (const evt of normalized) {
        if (evt.type === 'tool_call') handle.toolCallCount++
        this.emit('normalized', requestId, evt)
      }

      // Close stdin after result event — with stream-json input the process
      // stays alive waiting for more input; closing stdin triggers clean exit.
      if (raw.type === 'result') {
        log(`Run complete [${requestId}]: sawPermissionRequest=${handle.sawPermissionRequest}, denials=${handle.permissionDenials.length}`)
        try { child.stdin?.end() } catch {}
      }
    })

    parser.on('parse-error', (line: string) => {
      log(`Parse error [${requestId}]: ${line.substring(0, 200)}`)
      this._ringPush(handle.stderrTail, `[parse-error] ${line.substring(0, 200)}`)
    })

    // ─── stderr ring buffer ───
    child.stderr?.setEncoding('utf-8')
    child.stderr?.on('data', (data: string) => {
      const lines = data.split('\n').filter((l: string) => l.trim())
      for (const line of lines) {
        this._ringPush(handle.stderrTail, line)
      }
      log(`Stderr [${requestId}]: ${data.trim().substring(0, 500)}`)
    })

    // ─── Process lifecycle ───
    // Snapshot diagnostics BEFORE deleting the handle so callers can still read them.
    child.on('close', (code, signal) => {
      log(`Process closed [${requestId}]: code=${code} signal=${signal}`)
      // Move handle to finished map so getEnrichedError still works after exit
      this._finishedRuns.set(requestId, handle)
      this.activeRuns.delete(requestId)
      this.emit('exit', requestId, code, signal, handle.sessionId)
      // Clean up finished run after a short delay (gives callers time to read diagnostics)
      setTimeout(() => this._finishedRuns.delete(requestId), 5000)
    })

    child.on('error', (err) => {
      log(`Process error [${requestId}]: ${err.message}`)
      this._finishedRuns.set(requestId, handle)
      this.activeRuns.delete(requestId)
      this.emit('error', requestId, err)
      setTimeout(() => this._finishedRuns.delete(requestId), 5000)
    })

    // ─── Write prompt to stdin (stream-json format, keep open) ───
    // Using --input-format stream-json for bidirectional communication.
    // Stdin stays open so follow-up messages can be sent.
    const userMessage = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: options.prompt }],
      },
    })
    child.stdin!.write(userMessage + '\n')

    this.activeRuns.set(requestId, handle)
    return handle
  }

  /**
   * Write a message to a running process's stdin (for follow-up prompts, etc.)
   */
  writeToStdin(requestId: string, message: object): boolean {
    const handle = this.activeRuns.get(requestId)
    if (!handle) return false
    if (!handle.process.stdin || handle.process.stdin.destroyed) return false

    const json = JSON.stringify(message)
    log(`Writing to stdin [${requestId}]: ${json.substring(0, 200)}`)
    handle.process.stdin.write(json + '\n')
    return true
  }

  /**
   * Cancel a running process: SIGINT, then SIGKILL after 5s.
   */
  cancel(requestId: string): boolean {
    const handle = this.activeRuns.get(requestId)
    if (!handle) return false

    log(`Cancelling run ${requestId}`)
    handle.process.kill('SIGINT')

    // Fallback: SIGKILL if process hasn't exited after 5s.
    // Only check exitCode — process.killed is set true by the SIGINT call above,
    // so checking !killed would prevent the fallback from ever firing.
    setTimeout(() => {
      if (handle.process.exitCode === null) {
        log(`Force killing run ${requestId} (SIGINT did not terminate)`)
        handle.process.kill('SIGKILL')
      }
    }, 5000)

    return true
  }

  /**
   * Get an enriched error object for a failed run.
   */
  getEnrichedError(requestId: string, exitCode: number | null): EnrichedError {
    const handle = this.activeRuns.get(requestId) || this._finishedRuns.get(requestId)
    return {
      message: `Run failed with exit code ${exitCode}`,
      stderrTail: handle?.stderrTail.slice(-20) || [],
      stdoutTail: handle?.stdoutTail.slice(-20) || [],
      exitCode,
      elapsedMs: handle ? Date.now() - handle.startedAt : 0,
      toolCallCount: handle?.toolCallCount || 0,
      sawPermissionRequest: handle?.sawPermissionRequest || false,
      permissionDenials: handle?.permissionDenials || [],
    }
  }

  isRunning(requestId: string): boolean {
    return this.activeRuns.has(requestId)
  }

  getHandle(requestId: string): RunHandle | undefined {
    return this.activeRuns.get(requestId)
  }

  getActiveRunIds(): string[] {
    return Array.from(this.activeRuns.keys())
  }

  private _ringPush(buffer: string[], line: string): void {
    buffer.push(line)
    if (buffer.length > MAX_RING_LINES) {
      buffer.shift()
    }
  }
}
