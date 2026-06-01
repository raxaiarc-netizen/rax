/**
 * ClaudeInstance — single source of truth for which `claude` Rax talks to.
 *
 * Two modes:
 *   - 'bundled': use the Claude Code CLI we ship inside the .app, with a
 *     Rax-private config dir (CLAUDE_CONFIG_DIR=<userData>/claude-home).
 *     Memory, history, MCP, plugins, login — all isolated.
 *   - 'system' : use whichever `claude` is on the user's PATH, with their
 *     personal ~/.claude. The original behavior.
 *
 * Every spawn site (run-manager, pty-run-manager, orb-session, process-manager,
 * the diagnostic execSyncs in main/index.ts, and the first-launch login flow)
 * routes through getActiveInstance() + buildSpawnInvocation() instead of doing
 * its own `which claude` + spawn.
 */
import { app } from 'electron'
import { execSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { EventEmitter } from 'events'
import { getCliEnv } from '../cli-env'
import { log as _log } from '../logger'
import * as raxAuth from '../auth/rax'

function log(msg: string): void {
  _log('ClaudeInstance', msg)
}

export type ClaudeMode = 'bundled' | 'system'

export interface ClaudeInstance {
  mode: ClaudeMode
  /** Path to the binary OR (when invokeViaElectronNode is true) the JS entry. */
  binaryPath: string
  /** When true, binaryPath is a JS file that must be run by Electron's node. */
  invokeViaElectronNode: boolean
  /** CLAUDE_CONFIG_DIR override. undefined means let claude use ~/.claude. */
  configDir: string | undefined
  /** Human label for the UI chip / settings page. */
  label: string
  /** Effective home directory the instance reads/writes (for display). */
  homeDescription: string
  /** False when mode='bundled' but the bundled binary couldn't be located —
   *  callers should treat this as an error condition (we don't silently fall
   *  back to system, because that would defeat the isolation promise). */
  available: boolean
  /** Reason the instance isn't available, if any. */
  unavailableReason?: string
}

const events = new EventEmitter()
events.setMaxListeners(50)

// Cached per-mode resolution. Invalidated on setMode().
let cachedSystemBinary: string | null = null
let cachedBundledEntry: { path: string | null; reason?: string } | null = null

// ─── Persistence ──────────────────────────────────────────────────────────

function configFilePath(): string {
  return join(app.getPath('userData'), 'rax-claude-config.json')
}

function readPersistedMode(): ClaudeMode {
  try {
    const raw = readFileSync(configFilePath(), 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && (parsed.mode === 'bundled' || parsed.mode === 'system')) {
      return parsed.mode
    }
  } catch {}
  return 'bundled' // first-run default per the design
}

function persistMode(mode: ClaudeMode): void {
  try {
    const path = configFilePath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ mode }, null, 2))
  } catch (err) {
    log(`Failed to persist mode: ${(err as Error).message}`)
  }
}

let currentMode: ClaudeMode | null = null

function getCurrentMode(): ClaudeMode {
  if (currentMode === null) {
    currentMode = readPersistedMode()
    log(`Initial mode: ${currentMode}`)
  }
  return currentMode
}

// ─── Bundled binary discovery ─────────────────────────────────────────────

/**
 * Locate the bundled Claude Code CLI inside the app.
 *
 * Layout produced by scripts/vendor-claude.sh:
 *   <resources>/claude-cli/
 *     entry.json               { "entry": "cli.js" }
 *     package.json             (the vendored @anthropic-ai/claude-code package)
 *     cli.js  (or vendor/...)  the JS entry referenced by the bin field
 *
 * We prefer entry.json (explicit, written by the vendor script) and fall back
 * to reading the package's `bin.claude` field if it's missing.
 */
function resolveBundledEntry(): { path: string | null; reason?: string } {
  if (cachedBundledEntry) return cachedBundledEntry

  // Dev: app.getAppPath() resolves to /Users/.../rax-main when running
  //      under electron-vite, so resources/ lives alongside it.
  // Prod: process.resourcesPath = Contents/Resources inside the .app bundle.
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'claude-cli')]
    : [
        join(app.getAppPath(), 'resources', 'claude-cli'),
        join(process.cwd(), 'resources', 'claude-cli'),
      ]

  for (const base of candidates) {
    if (!existsSync(base)) continue

    // 1) Explicit entry.json wins.
    const entryJson = join(base, 'entry.json')
    if (existsSync(entryJson)) {
      try {
        const { entry } = JSON.parse(readFileSync(entryJson, 'utf-8'))
        if (typeof entry === 'string') {
          const full = join(base, entry)
          if (existsSync(full)) {
            const result = { path: full }
            cachedBundledEntry = result
            return result
          }
        }
      } catch (err) {
        log(`entry.json unreadable at ${entryJson}: ${(err as Error).message}`)
      }
    }

    // 2) Fall back to package.json bin field.
    const pkgPath = join(base, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
        const bin = pkg?.bin
        let rel: string | undefined
        if (typeof bin === 'string') rel = bin
        else if (bin && typeof bin === 'object') rel = bin.claude || bin['claude-code']
        if (rel) {
          const full = join(base, rel)
          if (existsSync(full)) {
            const result = { path: full }
            cachedBundledEntry = result
            return result
          }
        }
      } catch (err) {
        log(`bundled package.json unreadable: ${(err as Error).message}`)
      }
    }
  }

  const reason =
    'Bundled Claude Code not found in resources/claude-cli/. ' +
    'Run `npm run vendor-claude` to vendor it before building.'
  // Do NOT cache the miss. The CLI can appear after the first check (vendor
  // script finishing after app launch in dev, or a first-launch unpack race
  // in the packaged app). Caching null here would pin the failure until a
  // full restart even once the binary exists. Only successful resolutions
  // above are cached; a miss stays retryable.
  return { path: null as string | null, reason }
}

// ─── System binary discovery (the original logic, deduplicated) ───────────

function resolveSystemBinary(): string {
  if (cachedSystemBinary) return cachedSystemBinary

  // PATH-resolution first so the user's preferred install wins (Homebrew vs
  // ~/.local/bin etc. — newer versions tend to live in ~/.local/bin).
  try {
    const found = execSync('/bin/zsh -ilc "whence -p claude"', {
      encoding: 'utf-8',
      env: getCliEnv(),
    }).trim()
    if (found && existsSync(found)) {
      cachedSystemBinary = found
      return found
    }
  } catch {}

  try {
    const found = execSync('/bin/bash -lc "which claude"', {
      encoding: 'utf-8',
      env: getCliEnv(),
    }).trim()
    if (found && existsSync(found)) {
      cachedSystemBinary = found
      return found
    }
  } catch {}

  const candidates = [
    join(homedir(), '.local', 'bin', 'claude'),
    join(homedir(), '.npm-global', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ]
  for (const c of candidates) {
    if (existsSync(c)) {
      cachedSystemBinary = c
      return c
    }
  }

  cachedSystemBinary = 'claude'
  return 'claude'
}

// ─── Public API ───────────────────────────────────────────────────────────

export function getActiveInstance(): ClaudeInstance {
  const mode = getCurrentMode()

  if (mode === 'system') {
    const binaryPath = resolveSystemBinary()
    return {
      mode,
      binaryPath,
      invokeViaElectronNode: false,
      configDir: undefined,
      label: 'Default Claude',
      homeDescription: join(homedir(), '.claude'),
      available: binaryPath !== 'claude' || existsSync('claude'),
      unavailableReason:
        binaryPath === 'claude'
          ? 'No `claude` binary on PATH. Install with `npm i -g @anthropic-ai/claude-code` or switch to Rax\'s bundled Claude.'
          : undefined,
    }
  }

  // bundled
  const { path, reason } = resolveBundledEntry()
  const configDir = join(app.getPath('userData'), 'claude-home')
  if (!path) {
    return {
      mode,
      binaryPath: '',
      invokeViaElectronNode: false,
      configDir,
      label: "Rax's Claude",
      homeDescription: configDir,
      available: false,
      unavailableReason: reason,
    }
  }

  // Make sure the isolated home exists so claude-cli can write into it on
  // first run without permission errors.
  try {
    mkdirSync(configDir, { recursive: true })
  } catch (err) {
    log(`Failed to ensure config dir ${configDir}: ${(err as Error).message}`)
  }

  // The CLI ships as either a native binary (bin/claude.exe — Mach-O on macOS)
  // or a JS entry. JS entries are spawned via Electron-as-Node so we don't
  // need a separate Node runtime; native binaries are spawned directly.
  const invokeViaElectronNode = /\.(?:c?js|mjs)$/i.test(path)

  return {
    mode,
    binaryPath: path,
    invokeViaElectronNode,
    configDir,
    label: "Rax's Claude",
    homeDescription: configDir,
    available: true,
  }
}

export function getMode(): ClaudeMode {
  return getCurrentMode()
}

export function setMode(mode: ClaudeMode): ClaudeInstance {
  if (mode !== 'bundled' && mode !== 'system') {
    throw new Error(`Invalid mode: ${mode}`)
  }
  if (mode === currentMode) return getActiveInstance()
  log(`Mode change: ${currentMode} → ${mode}`)
  currentMode = mode
  persistMode(mode)
  // Invalidate caches so the next resolve picks up the new mode's binary.
  cachedSystemBinary = null
  // (bundled entry cache stays valid — same on-disk file across mode flips.)
  const instance = getActiveInstance()
  events.emit('mode-changed', instance)
  return instance
}

export function onModeChange(cb: (instance: ClaudeInstance) => void): () => void {
  events.on('mode-changed', cb)
  return () => events.off('mode-changed', cb)
}

// ─── Spawn helpers ────────────────────────────────────────────────────────

/**
 * Build an env block that points the spawned claude at the active instance's
 * config dir, plus the usual login-shell PATH augmentation.
 *
 * Provider routing:
 *   raxAuth.isActive()  → Rax cloud proxy (rax-ai.com forwards to the right
 *                         upstream, including Moonshot for kimi-* models)
 *   else                → user's own ANTHROPIC_API_KEY / claude.ai login
 *
 * Callers may pass the per-spawn picked model id via the `RAX_REQUESTED_MODEL`
 * sentinel inside `extraEnv`; we strip it here so it never leaks into the
 * subprocess. (No longer routed on locally — kept only for back-compat.)
 */
export function buildClaudeEnv(extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const instance = getActiveInstance()
  const env = getCliEnv(extraEnv)

  // Pull the per-spawn model hint, then strip it so subprocesses don't
  // inherit a Rax-internal env var.
  const requestedModel = (env.RAX_REQUESTED_MODEL || '').trim()
  delete env.RAX_REQUESTED_MODEL

  // ─── Rax cloud env injection ─────────────────────────────────────────
  if (raxAuth.isActive()) {
    const key = raxAuth.getActiveKey()
    if (key) {
      env.ANTHROPIC_BASE_URL = raxAuth.baseUrl()
      env.ANTHROPIC_AUTH_TOKEN = key
      // Don't leak the user's own Anthropic key alongside — pick one.
      delete env.ANTHROPIC_API_KEY
    }
  }

  // ─── kimi-* (Rax Default) model pinning ──────────────────────────────
  // For kimi-* the CLI's --model flag is skipped (its validator rejects
  // non-Anthropic ids), so without this the CLI sends its built-in default
  // (e.g. claude-opus-4-8) to the Rax proxy, which 400s. Pin the model via
  // env so the CLI emits kimi-k2.6 to whatever base URL is active — the Rax
  // cloud proxy then forwards kimi-* upstream to Moonshot. No local key
  // needed; only the model NAME is set here (creds come from Rax cloud).
  if (requestedModel.startsWith('kimi-')) {
    env.ANTHROPIC_MODEL = requestedModel
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = requestedModel
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = requestedModel
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = requestedModel
  }

  if (instance.configDir) {
    env.CLAUDE_CONFIG_DIR = instance.configDir
  } else {
    // Make sure we don't leak a Rax-private CLAUDE_CONFIG_DIR into system mode
    // if it was set by something earlier in the process lifetime.
    delete env.CLAUDE_CONFIG_DIR
  }

  // Bundled mode runs via Electron-as-node — strip the marker if a caller
  // (like the orb's MCP shim) explicitly removed it before, but for the
  // claude subprocess itself we WANT it set.
  if (instance.invokeViaElectronNode) {
    env.ELECTRON_RUN_AS_NODE = '1'
  } else {
    delete env.ELECTRON_RUN_AS_NODE
    // Make sure the binary's dir is on PATH (mirrors the previous per-site logic).
    if (instance.binaryPath) {
      const binDir = instance.binaryPath.substring(0, instance.binaryPath.lastIndexOf('/'))
      if (binDir && env.PATH && !env.PATH.includes(binDir)) {
        env.PATH = `${binDir}:${env.PATH}`
      }
    }
  }

  return env
}

/**
 * Resolve `(command, args)` for a spawn() / pty.spawn() / execSync() call so
 * callers don't have to think about whether they're invoking the bundled JS
 * entry via Electron's node or a real binary.
 */
export function buildClaudeSpawnInvocation(claudeArgs: string[]): {
  command: string
  args: string[]
  instance: ClaudeInstance
} {
  const instance = getActiveInstance()
  if (!instance.available) {
    // Surface a structured error rather than letting spawn fail with ENOENT.
    throw new Error(
      `Claude Code is not available: ${instance.unavailableReason ?? 'unknown reason'}`,
    )
  }
  if (instance.invokeViaElectronNode) {
    return {
      command: process.execPath,
      args: [instance.binaryPath, ...claudeArgs],
      instance,
    }
  }
  return {
    command: instance.binaryPath,
    args: claudeArgs,
    instance,
  }
}

/**
 * Run `claude <args>` synchronously and return trimmed stdout. Honors the
 * active instance. Returns null on failure. Used for the version / auth /
 * mcp-list diagnostics surfaced in Settings.
 */
export function execClaudeSync(args: string[], timeoutMs = 5000): string | null {
  try {
    const { command, args: spawnArgs } = buildClaudeSpawnInvocation(args)
    const out = execSync(
      [command, ...spawnArgs].map(quoteForShell).join(' '),
      { encoding: 'utf-8', timeout: timeoutMs, env: buildClaudeEnv() },
    )
    return out.trim()
  } catch {
    return null
  }
}

function quoteForShell(s: string): string {
  if (s === '') return "''"
  if (/^[A-Za-z0-9_\-./=:]+$/.test(s)) return s
  return `'${s.replace(/'/g, "'\\''")}'`
}
