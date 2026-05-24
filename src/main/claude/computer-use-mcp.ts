/**
 * Computer-use MCP wiring for chat-tab claude sessions.
 *
 * Materializes the same `mcp-server.cjs` shim the orb uses, but in a "tab"
 * toolset that only advertises:
 *   - rax_screenshot       (see the screen)
 *   - rax_control_screen   (drive mouse / keyboard)
 *   - rax_describe_self    (so the model can introspect)
 *
 * Tab tools (rax_open_tab / rax_send_to_tab / rax_list_tabs / rax_read_tab)
 * are intentionally hidden — letting a chat tab spawn or message other tabs
 * is a loop-and-surprise hazard the orb earns by being explicitly summoned by
 * voice. Chat tabs get the *computer-use* subset only.
 *
 * The shim is written to a tmpdir path once per app launch and reused across
 * every tab run. The same `--mcp-config <path>` is passed to every `claude -p`
 * spawn by RunManager.
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
// Vite's `?raw` resolves the .cjs file content into a string at bundle time —
// we don't ship the .cjs as a separate asset, it lives inline in the bundle.
// eslint-disable-next-line import/no-unresolved
import mcpServerSrc from '../orb/mcp-server.cjs?raw'
import { log as _log } from '../logger'
import type { OrbRpcInfo } from '../orb/orb-rpc'

function log(msg: string): void {
  _log('TabMCP', msg)
}

const TEMP_PREFIX = 'rax-tab-mcp-'
const MCP_SERVER_NAME = 'rax-tools'

/**
 * MCP tool names as Claude Code surfaces them. MCP tools come through with
 * the canonical `mcp__<server>__<tool>` prefix — used to populate the
 * `--allowedTools` list so they don't trigger permission cards.
 */
export const TAB_MCP_TOOL_NAMES = [
  `mcp__${MCP_SERVER_NAME}__rax_screenshot`,
  `mcp__${MCP_SERVER_NAME}__rax_control_screen`,
  `mcp__${MCP_SERVER_NAME}__rax_describe_self`,
] as const

interface TabMcpFiles {
  scriptPath: string
  configPath: string
}

/**
 * Single-process cache. The shim file content is immutable for the lifetime
 * of the bundle, so we write it once and reuse. The config file embeds the
 * RPC port/secret — those are stable for the lifetime of OrbRpcServer too.
 */
let cached: { rpcUrl: string; rpcSecret: string; files: TabMcpFiles } | null = null

/**
 * Ensure both files exist on disk for the given rpcInfo. Idempotent within a
 * single process — repeated calls return the same paths.
 *
 * If the rpcInfo changes between calls (e.g. orb restarted on a new port),
 * we re-materialize the config so the shim points at the live RPC server.
 */
export function ensureTabMcpFiles(rpc: OrbRpcInfo): TabMcpFiles {
  if (cached && cached.rpcUrl === rpc.url && cached.rpcSecret === rpc.secret) {
    // Verify files still exist — tmp-dir sweeps or user `rm`s shouldn't crash us.
    if (existsSync(cached.files.scriptPath) && existsSync(cached.files.configPath)) {
      return cached.files
    }
  }

  const dir = tmpdir()
  try { mkdirSync(dir, { recursive: true }) } catch {}

  const scriptPath = join(dir, `${TEMP_PREFIX}${randomBytes(6).toString('hex')}.cjs`)
  writeFileSync(scriptPath, mcpServerSrc as string, { mode: 0o600 })

  const configPath = join(dir, `${TEMP_PREFIX}cfg-${randomBytes(6).toString('hex')}.json`)
  const cfg = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: 'stdio',
        command: process.execPath, // Electron's bundled node — no separate runtime needed.
        args: [scriptPath],
        env: {
          RAX_ORB_RPC_URL: rpc.url,
          RAX_ORB_RPC_SECRET: rpc.secret,
          RAX_MCP_TOOLSET: 'tab',
          ELECTRON_RUN_AS_NODE: '1',
        },
      },
    },
  }
  writeFileSync(configPath, JSON.stringify(cfg), { mode: 0o600 })

  cached = { rpcUrl: rpc.url, rpcSecret: rpc.secret, files: { scriptPath, configPath } }
  log(`Materialized tab MCP shim at ${scriptPath} -> RPC ${rpc.url}`)
  return cached.files
}

/**
 * Best-effort cleanup of stale tab-mcp temp files from previous launches.
 * Called once at app startup (alongside `sweepStaleOrbTempFiles`).
 */
export function sweepStaleTabMcpFiles(): number {
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
    if (removed > 0) log(`Swept ${removed} stale tab-MCP temp file(s)`)
  } catch (err) {
    log(`Sweep failed: ${(err as Error).message}`)
  }
  return removed
}
