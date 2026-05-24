/**
 * Tool layer for the direct-API orb session.
 *
 * Two kinds of tools are exposed to the model:
 *   1. Native filesystem / shell tools (bash, read, write, edit, grep, glob)
 *      — executed in-process by Node, no MCP roundtrip.
 *   2. rax_* tools (screenshot, control_screen, list_tabs, …) — forwarded over
 *      loopback HTTP to the already-running `OrbRpcServer` so we keep a single
 *      source of truth for the heavier handlers (calibration cache, tab fan-
 *      out). Localhost HTTP adds ~0.5ms which is invisible next to the model
 *      latency win.
 *
 * The tool definitions deliberately mirror the names/shapes Claude Code uses
 * so the orb's existing system-prompt narration anchors keep working without
 * re-training the rhythm guide.
 */

import { spawn } from 'child_process'
import { promises as fsp } from 'fs'
import { resolve as pathResolve, isAbsolute, dirname, join } from 'path'
import { homedir, tmpdir } from 'os'
import { request as httpRequest } from 'http'
import { URL } from 'url'
import { randomBytes } from 'crypto'
import type { Anthropic } from '@anthropic-ai/sdk'

/**
 * Anthropic's hard cap is 5MB per image (raw decoded bytes). Retina PNG
 * screenshots routinely break that — we re-encode to JPEG before sending.
 * Headroom: 4MB so a turn carrying a screenshot + another image (e.g. an
 * auto-attached one) still fits well under the cap.
 */
const IMAGE_MAX_BYTES = 4_000_000

export type ToolDef = Anthropic.Messages.Tool

/**
 * Single tool execution result. Either a plain string (becomes a text-only
 * tool_result) or a list of content blocks (for screenshot etc that carry
 * image bytes back to the model).
 */
export type ToolResultContent =
  | { kind: 'text'; text: string; isError?: boolean }
  | { kind: 'image'; base64: string; mimeType: string; text?: string; isError?: boolean }

export interface OrbRpcEndpoint {
  url: string
  secret: string
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Tool schemas                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

export function buildToolDefs(): ToolDef[] {
  const tools: ToolDef[] = [
    {
      name: 'bash',
      description:
        'Run a shell command on the user\'s Mac via /bin/zsh -lc and return stdout/stderr. ' +
        'Use for git, file system probing, npm, curl, python, anything the user could run in a terminal. ' +
        'Long-running commands (>30s) will be killed — for those, background them with `nohup ... &` or split into steps. ' +
        'Permissions are bypassed for the orb — confirm before clearly destructive commands (rm -rf, force push, drop database).',
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run.' },
          cwd: { type: 'string', description: 'Working directory. Defaults to the project path.' },
          timeoutMs: { type: 'integer', minimum: 100, maximum: 120_000, description: 'Default 30000.' },
        },
        required: ['command'],
      },
    },
    {
      name: 'read',
      description:
        'Read a UTF-8 text file from the user\'s machine. Returns up to ~200KB; pass a line range for larger files. SILENT tool — do not narrate before calling.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          offsetLines: { type: 'integer', minimum: 0 },
          maxLines: { type: 'integer', minimum: 1, maximum: 5000 },
        },
        required: ['path'],
      },
    },
    {
      name: 'write',
      description:
        'Write a UTF-8 text file. Overwrites the existing file. Creates parent directories as needed. Confirm verbally before destructive overwrites of user-edited files.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'edit',
      description:
        'Replace exact-match text inside a file. `oldString` must be unique in the file unless `replaceAll` is true. Preserves the rest of the file byte-for-byte.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          oldString: { type: 'string' },
          newString: { type: 'string' },
          replaceAll: { type: 'boolean' },
        },
        required: ['path', 'oldString', 'newString'],
      },
    },
    {
      name: 'grep',
      description:
        'Regex search across files using ripgrep. Returns matching lines with file:line prefix. SILENT tool — do not narrate before calling.',
      input_schema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Rust regex pattern.' },
          path: { type: 'string', description: 'Directory or file to search. Defaults to cwd.' },
          glob: { type: 'string', description: 'File glob filter, e.g. "*.ts".' },
          maxMatches: { type: 'integer', minimum: 1, maximum: 500, description: 'Default 100.' },
          ignoreCase: { type: 'boolean' },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'glob',
      description:
        'List paths matching a glob from a starting directory. Uses ripgrep --files. SILENT tool — do not narrate before calling.',
      input_schema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'e.g. "src/**/*.ts"' },
          path: { type: 'string', description: 'Root. Defaults to cwd.' },
          maxResults: { type: 'integer', minimum: 1, maximum: 2000, description: 'Default 500.' },
        },
        required: ['pattern'],
      },
    },

    /* ── rax_* — forwarded to OrbRpcServer over loopback HTTP ───────────── */
    {
      name: 'rax_screenshot',
      description:
        'Capture the user\'s screen and return it as an image you can SEE. The OS cursor is HIDDEN; a red ring + white dot marks the cursor location. Use whenever the user says "look at this", "what am I pointing at", or before driving the cursor with rax_control_screen. Captures main display by default; pass 1-based display index for secondary monitors. The text channel reports the cursor\'s image-pixel coords — pass those exact coordinates to rax_control_screen.',
      input_schema: {
        type: 'object',
        properties: {
          display: { type: 'integer', minimum: 1, maximum: 8 },
          downscale: { type: 'boolean', description: 'Default true — clamp longest edge to 1600px.' },
          annotateCursor: { type: 'boolean', description: 'Default true.' },
        },
      },
    },
    {
      name: 'rax_control_screen',
      description:
        'Drive the user\'s mouse and keyboard. ALWAYS rax_screenshot FIRST — clicks are calibrated against the most recent screenshot. Coordinates are IMAGE-PIXEL coordinates of that screenshot (top-left origin). Real CGEvent mouse/keyboard, works in browsers, Electron apps, Slack, IDEs. Actions: click {x,y,button?}, double_click {x,y}, type {text}, key {key, modifiers?}, scroll {dy?,dx?}, cursor_position. If response has error="accessibility_denied", tell the user to approve Rax in System Settings → Privacy & Security → Accessibility.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['click', 'double_click', 'type', 'key', 'scroll', 'cursor_position'] },
          x: { type: 'integer' },
          y: { type: 'integer' },
          button: { type: 'string', enum: ['left', 'right'] },
          text: { type: 'string' },
          key: { type: 'string' },
          modifiers: { type: 'array', items: { type: 'string', enum: ['cmd', 'command', 'shift', 'alt', 'option', 'opt', 'ctrl', 'control'] } },
          dy: { type: 'integer' },
          dx: { type: 'integer' },
        },
        required: ['action'],
      },
    },
    {
      name: 'rax_list_tabs',
      description: 'Roll call of your five-agent crew (Max, Alex, Luna, Nova, Zara) — current status, last user/assistant message, last tool, last error for each one. Use to check who is busy vs. idle before dispatching work.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'rax_read_tab',
      description: 'Read the recent message log of one crew member. Pass the agent\'s NAME as `tab` ("Max", "Alex", "Luna", "Nova", "Zara" — case-insensitive). UUID / 1-based index also accepted for compatibility.',
      input_schema: {
        type: 'object',
        properties: {
          tab: { type: 'string', description: 'Crew member name (preferred), UUID, prefix, or 1-based index.' },
          lastN: { type: 'integer', minimum: 1, maximum: 40 },
        },
        required: ['tab'],
      },
    },
    {
      name: 'rax_open_tab',
      description: 'LEGACY — DO NOT CALL. The Rax crew is fixed at five named agents; you cannot create new ones. Use rax_send_to_tab against an idle crew member instead.',
      input_schema: {
        type: 'object',
        properties: {
          workingDirectory: { type: 'string' },
          prompt: { type: 'string' },
        },
      },
    },
    {
      name: 'rax_send_to_tab',
      description: 'Dispatch a prompt to a named crew member (fire and forget). Pass their NAME as `tab` ("Max" / "Alex" / "Luna" / "Nova" / "Zara"). Tell the user out loud who you handed it to.',
      input_schema: {
        type: 'object',
        properties: {
          tab: { type: 'string', description: 'Crew member name — Max, Alex, Luna, Nova, or Zara.' },
          prompt: { type: 'string' },
        },
        required: ['tab', 'prompt'],
      },
    },
    {
      name: 'rax_send_to_tab_and_wait',
      description: 'Dispatch a prompt to a named crew member AND wait for them to finish, returning their final assistant message. Use when the user needs the answer before you can reply. Pass agent NAME as `tab`.',
      input_schema: {
        type: 'object',
        properties: {
          tab: { type: 'string', description: 'Crew member name — Max, Alex, Luna, Nova, or Zara.' },
          prompt: { type: 'string' },
        },
        required: ['tab', 'prompt'],
      },
    },
    {
      name: 'rax_focus_tab',
      description: 'Bring a crew member\'s window to the foreground so the user can watch them work. Pass agent NAME as `tab`.',
      input_schema: {
        type: 'object',
        properties: { tab: { type: 'string', description: 'Crew member name — Max, Alex, Luna, Nova, or Zara.' } },
        required: ['tab'],
      },
    },
    {
      name: 'rax_describe_self',
      description: 'Self-description: host, project path, platform.',
      input_schema: { type: 'object', properties: {} },
    },
  ]

  // Mark the last tool with cache_control so the entire tool list is one
  // cache block — every turn after the first re-uses it without paying for
  // the schema bytes again.
  const last = tools[tools.length - 1]
  ;(last as ToolDef & { cache_control?: { type: 'ephemeral' } }).cache_control = { type: 'ephemeral' }

  return tools
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Execution router                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

export interface ToolExecContext {
  projectPath: string
  rpc: OrbRpcEndpoint
}

const RAX_RPC_PATHS: Record<string, string> = {
  rax_screenshot: '/screenshot',
  rax_control_screen: '/control_screen',
  rax_list_tabs: '/list_tabs',
  rax_read_tab: '/read_tab',
  rax_open_tab: '/open_tab',
  rax_send_to_tab: '/send_to_tab',
  rax_send_to_tab_and_wait: '/send_to_tab_and_wait',
  rax_focus_tab: '/focus_tab',
  rax_describe_self: '/describe_self',
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolExecContext,
  signal?: AbortSignal,
): Promise<ToolResultContent> {
  if (RAX_RPC_PATHS[name]) {
    // Capture pipeline now adaptively shrinks PNG to fit Anthropic's 5MB cap
    // while keeping calibration coherent (see screen-capture.ts). Direct
    // mode no longer needs to force a smaller maxEdge — both CLI orb and
    // direct orb get the largest PNG that fits, exactly the behavior the
    // CLI has always had.
    return rpcCall(RAX_RPC_PATHS[name], input, ctx.rpc, signal)
  }

  try {
    switch (name) {
      case 'bash':       return await execBash(input, ctx, signal)
      case 'read':       return await execRead(input, ctx)
      case 'write':      return await execWrite(input, ctx)
      case 'edit':       return await execEdit(input, ctx)
      case 'grep':       return await execGrep(input, ctx, signal)
      case 'glob':       return await execGlob(input, ctx, signal)
      default:
        return { kind: 'text', text: `Error: unknown tool "${name}"`, isError: true }
    }
  } catch (err) {
    return { kind: 'text', text: `Error: ${(err as Error).message}`, isError: true }
  }
}

/* ── rax RPC bridge ─────────────────────────────────────────────────────── */

function rpcCall(
  path: string,
  body: Record<string, unknown>,
  rpc: OrbRpcEndpoint,
  signal?: AbortSignal,
): Promise<ToolResultContent> {
  return new Promise((resolve) => {
    const url = new URL(path, rpc.url)
    const data = JSON.stringify(body || {})
    const req = httpRequest(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          Authorization: `Bearer ${rpc.secret}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8')
          let parsed: Record<string, unknown> = {}
          try {
            parsed = raw ? JSON.parse(raw) : {}
          } catch {
            resolve({ kind: 'text', text: `RPC bad response: ${raw.slice(0, 200)}`, isError: true })
            return
          }
          if (res.statusCode && res.statusCode >= 400) {
            resolve({ kind: 'text', text: `RPC HTTP ${res.statusCode}: ${JSON.stringify(parsed)}`, isError: true })
            return
          }
          // Screenshot path returns base64 + mimeType — surface as image.
          if (typeof parsed.base64 === 'string' && typeof parsed.mimeType === 'string') {
            const meta: string[] = []
            if (parsed.bytes) meta.push(`${parsed.bytes} bytes`)
            if (parsed.display) meta.push(`display ${parsed.display}`)
            const sz = parsed.imageSize as { width: number; height: number } | undefined
            if (sz) meta.push(`${sz.width}×${sz.height} px`)
            let cursorLine = ''
            const cursor = parsed.cursor as { x: number; y: number; onCapturedDisplay?: boolean } | undefined
            if (cursor && typeof cursor.x === 'number' && typeof cursor.y === 'number') {
              if (cursor.onCapturedDisplay !== false) {
                cursorLine =
                  `\nUser's cursor is at image-pixel (${cursor.x}, ${cursor.y}), top-left origin. ` +
                  `The RED RING + white dot in the image marks that exact spot. ` +
                  `Pass the same coordinates to rax_control_screen to click there.`
              } else {
                cursorLine = `\nUser's cursor is on a different display than the one captured — no red-ring marker drawn.`
              }
            }
            // PNG goes through verbatim — same as the CLI orb path. We do
            // NOT re-encode to JPEG here; JPEG artifacts on small UI text
            // hurt the model's click accuracy. The capture pipeline is asked
            // for a 1280px maxEdge upstream so the PNG fits Anthropic's 5MB
            // cap natively. If a future capture still exceeds that cap,
            // Anthropic will return a 400 — explicit failure beats silently
            // degrading the image the model uses to aim clicks.
            resolve({
              kind: 'image',
              base64: parsed.base64 as string,
              mimeType: parsed.mimeType as string,
              text: (meta.length ? `Captured screenshot (${meta.join(', ')}).` : 'Captured screenshot.') + cursorLine,
            })
            return
          }
          const isError = !!parsed.error
          resolve({
            kind: 'text',
            text: JSON.stringify(parsed, null, 2),
            isError,
          })
        })
      },
    )
    req.on('error', (err) => {
      resolve({ kind: 'text', text: `RPC error: ${err.message}`, isError: true })
    })
    if (signal) {
      const onAbort = () => req.destroy(new Error('aborted'))
      signal.addEventListener('abort', onAbort, { once: true })
    }
    req.write(data)
    req.end()
  })
}

/* ── native tool executors ──────────────────────────────────────────────── */

function expandPath(p: string, cwd: string): string {
  if (!p) return cwd
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return homedir() + p.slice(1)
  if (isAbsolute(p)) return p
  return pathResolve(cwd, p)
}

async function execBash(
  input: Record<string, unknown>,
  ctx: ToolExecContext,
  signal?: AbortSignal,
): Promise<ToolResultContent> {
  const command = String(input.command ?? '').trim()
  if (!command) return { kind: 'text', text: 'Error: missing command', isError: true }
  const cwd = expandPath(String(input.cwd ?? ''), ctx.projectPath)
  const timeoutMs = clampInt(input.timeoutMs, 100, 120_000, 30_000)

  return new Promise((resolve) => {
    const child = spawn('/bin/zsh', ['-lc', command], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    let stdout = ''
    let stderr = ''
    const MAX_OUT = 200_000
    const append = (which: 'stdout' | 'stderr', buf: Buffer) => {
      const s = buf.toString('utf-8')
      if (which === 'stdout') {
        if (stdout.length < MAX_OUT) stdout += s.slice(0, MAX_OUT - stdout.length)
      } else {
        if (stderr.length < MAX_OUT) stderr += s.slice(0, MAX_OUT - stderr.length)
      }
    }
    child.stdout!.on('data', (b) => append('stdout', b))
    child.stderr!.on('data', (b) => append('stderr', b))

    let killed = false
    const timer = setTimeout(() => {
      killed = true
      try { child.kill('SIGKILL') } catch {}
    }, timeoutMs)

    const onAbort = () => {
      try { child.kill('SIGTERM') } catch {}
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.on('close', (code, sig) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      const head = `exit ${code ?? sig ?? '?'}${killed ? ' (killed: timeout)' : ''}\ncwd: ${cwd}\n`
      const body =
        (stdout ? `--- stdout ---\n${stdout}\n` : '') +
        (stderr ? `--- stderr ---\n${stderr}\n` : '') ||
        '(no output)'
      resolve({
        kind: 'text',
        text: head + body,
        isError: (code ?? 0) !== 0,
      })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ kind: 'text', text: `Failed to spawn: ${err.message}`, isError: true })
    })
  })
}

async function execRead(input: Record<string, unknown>, ctx: ToolExecContext): Promise<ToolResultContent> {
  const path = expandPath(String(input.path ?? ''), ctx.projectPath)
  if (!path) return { kind: 'text', text: 'Error: missing path', isError: true }
  const offsetLines = clampInt(input.offsetLines, 0, 1_000_000, 0)
  const maxLines = clampInt(input.maxLines, 1, 5000, 2000)
  const buf = await fsp.readFile(path)
  // Cap raw bytes too — defensive for huge logs.
  const text = buf.subarray(0, 800_000).toString('utf-8')
  const lines = text.split('\n')
  const slice = lines.slice(offsetLines, offsetLines + maxLines)
  const truncated = lines.length > offsetLines + maxLines
  const numbered = slice.map((l, i) => `${String(offsetLines + i + 1).padStart(6, ' ')}\t${l}`).join('\n')
  const footer = truncated ? `\n…(${lines.length - offsetLines - maxLines} more lines)` : ''
  return { kind: 'text', text: numbered + footer }
}

async function execWrite(input: Record<string, unknown>, ctx: ToolExecContext): Promise<ToolResultContent> {
  const path = expandPath(String(input.path ?? ''), ctx.projectPath)
  const content = String(input.content ?? '')
  if (!path) return { kind: 'text', text: 'Error: missing path', isError: true }
  await fsp.mkdir(dirname(path), { recursive: true })
  await fsp.writeFile(path, content, 'utf-8')
  return { kind: 'text', text: `Wrote ${Buffer.byteLength(content)} bytes to ${path}` }
}

async function execEdit(input: Record<string, unknown>, ctx: ToolExecContext): Promise<ToolResultContent> {
  const path = expandPath(String(input.path ?? ''), ctx.projectPath)
  const oldString = String(input.oldString ?? '')
  const newString = String(input.newString ?? '')
  const replaceAll = !!input.replaceAll
  if (!path) return { kind: 'text', text: 'Error: missing path', isError: true }
  if (!oldString) return { kind: 'text', text: 'Error: oldString may not be empty', isError: true }

  const current = await fsp.readFile(path, 'utf-8')
  let next: string
  let count: number
  if (replaceAll) {
    const parts = current.split(oldString)
    count = parts.length - 1
    next = parts.join(newString)
  } else {
    const first = current.indexOf(oldString)
    if (first === -1) return { kind: 'text', text: `Error: oldString not found in ${path}`, isError: true }
    const second = current.indexOf(oldString, first + oldString.length)
    if (second !== -1) {
      return {
        kind: 'text',
        text: `Error: oldString matches ${current.split(oldString).length - 1} places; pass more surrounding context or set replaceAll=true.`,
        isError: true,
      }
    }
    count = 1
    next = current.slice(0, first) + newString + current.slice(first + oldString.length)
  }
  await fsp.writeFile(path, next, 'utf-8')
  return { kind: 'text', text: `Replaced ${count} occurrence${count === 1 ? '' : 's'} in ${path}` }
}

async function execGrep(
  input: Record<string, unknown>,
  ctx: ToolExecContext,
  signal?: AbortSignal,
): Promise<ToolResultContent> {
  const pattern = String(input.pattern ?? '')
  if (!pattern) return { kind: 'text', text: 'Error: missing pattern', isError: true }
  const path = expandPath(String(input.path ?? ''), ctx.projectPath)
  const glob = typeof input.glob === 'string' ? input.glob : ''
  const maxMatches = clampInt(input.maxMatches, 1, 500, 100)
  const ignoreCase = !!input.ignoreCase

  const args = ['--no-heading', '--with-filename', '--line-number', '-m', String(maxMatches)]
  if (ignoreCase) args.push('-i')
  if (glob) args.push('--glob', glob)
  args.push('--', pattern, path)

  return runCapture('rg', args, signal, ctx.projectPath)
}

async function execGlob(
  input: Record<string, unknown>,
  ctx: ToolExecContext,
  signal?: AbortSignal,
): Promise<ToolResultContent> {
  const pattern = String(input.pattern ?? '')
  if (!pattern) return { kind: 'text', text: 'Error: missing pattern', isError: true }
  const path = expandPath(String(input.path ?? ''), ctx.projectPath)
  const maxResults = clampInt(input.maxResults, 1, 2000, 500)

  const args = ['--files', '--glob', pattern, path]
  const res = await runCapture('rg', args, signal, ctx.projectPath)
  if (res.kind !== 'text') return res
  const lines = res.text.split('\n').filter(Boolean).slice(0, maxResults)
  const truncated = res.text.split('\n').filter(Boolean).length > maxResults
  return {
    kind: 'text',
    text: lines.join('\n') + (truncated ? `\n…(more than ${maxResults} matches; refine the pattern)` : ''),
    isError: res.isError,
  }
}

function runCapture(cmd: string, args: string[], signal: AbortSignal | undefined, cwd: string): Promise<ToolResultContent> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const MAX = 200_000
    child.stdout!.on('data', (b: Buffer) => {
      if (stdout.length < MAX) stdout += b.toString('utf-8').slice(0, MAX - stdout.length)
    })
    child.stderr!.on('data', (b: Buffer) => {
      if (stderr.length < MAX) stderr += b.toString('utf-8').slice(0, MAX - stderr.length)
    })
    const onAbort = () => { try { child.kill('SIGTERM') } catch {} }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (err) => {
      resolve({ kind: 'text', text: `${cmd} failed: ${err.message}`, isError: true })
    })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      // ripgrep exits 1 when there are simply no matches — that's not an error.
      if (code === 0 || (code === 1 && !stderr)) {
        resolve({ kind: 'text', text: stdout || '(no matches)' })
      } else {
        resolve({ kind: 'text', text: `${cmd} exited ${code}\n${stderr || stdout}`, isError: true })
      }
    })
  })
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

/**
 * Re-encode a base64 image to JPEG if its raw bytes exceed Anthropic's 5MB
 * per-image limit. Uses macOS `sips` — no native deps.
 *
 * CRITICAL: dimensions are preserved across all passes. The orb's
 * rax_control_screen calibration is set when the screenshot is captured and
 * is keyed to the IMAGE-PIXEL coordinate space the model sees. If we
 * downscaled here, the model's "click (500, 200)" would map through the
 * original-sized calibration on the RPC and land in the wrong global point.
 * So we ONLY lower JPEG quality — going as low as q15 if the image is huge.
 *
 * In practice a Retina-sized JPEG at q40 is well under 1MB, so quality 35
 * (the first attempted level) handles every realistic screenshot.
 */
export async function shrinkIfNeeded(
  base64: string,
  mimeType: string,
): Promise<{ base64: string; mimeType: string; note?: string }> {
  // Anthropic's limit applies to the DECODED bytes, not the base64-encoded
  // length. base64 inflates by ~4/3 so we work in decoded space.
  const decodedLen = Math.floor((base64.length * 3) / 4)
  if (decodedLen <= IMAGE_MAX_BYTES) return { base64, mimeType }

  const tmpId = randomBytes(6).toString('hex')
  const srcPath = join(tmpdir(), `rax-orb-shot-${tmpId}.png`)
  const dstPath = join(tmpdir(), `rax-orb-shot-${tmpId}.jpg`)

  try {
    await fsp.writeFile(srcPath, Buffer.from(base64, 'base64'))

    // Quality ladder. Each pass keeps full dimensions; only the encoder's
    // quantization gets more aggressive. q35 → q20 → q12 is enough for any
    // panoramic Retina capture I've seen.
    const ladder = [35, 20, 12]
    let buf: Buffer | null = null
    let usedQuality = ladder[0]
    for (const q of ladder) {
      await runSips(srcPath, dstPath, q)
      buf = await fsp.readFile(dstPath)
      usedQuality = q
      if (buf.length <= IMAGE_MAX_BYTES) break
    }
    if (!buf || buf.length > IMAGE_MAX_BYTES) {
      throw new Error(`could not shrink below ${IMAGE_MAX_BYTES} bytes (still ${buf?.length ?? 'n/a'})`)
    }

    return {
      base64: buf.toString('base64'),
      mimeType: 'image/jpeg',
      note: `recompressed ${Math.round(decodedLen / 1024)}KB→${Math.round(buf.length / 1024)}KB @q${usedQuality}`,
    }
  } finally {
    fsp.unlink(srcPath).catch(() => {})
    fsp.unlink(dstPath).catch(() => {})
  }
}

function runSips(src: string, dst: string, quality: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality), src, '--out', dst]
    const child = spawn('/usr/bin/sips', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr!.on('data', (b: Buffer) => { err += b.toString('utf-8') })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`sips exit ${code}: ${err.slice(0, 200)}`))
    })
  })
}
