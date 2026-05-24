/**
 * Rax cloud auth — manages the locally stored `rax_sk_…` API key that
 * lets the spawned `claude` CLI bill against the user's Rax credit
 * balance instead of needing their own Anthropic key.
 *
 *   ┌─────────────┐   open URL     ┌──────────────┐
 *   │ Electron app│ ─────────────► │ default      │
 *   │             │                │ browser      │
 *   │ loopback    │ ◄───── redirect ◄ rax-ai.com   │
 *   │ :PORT       │   key=rax_sk_… └──────────────┘
 *   └─────────────┘
 *
 * The key is written to `<userData>/rax-cloud.json` with 0600 perms. We
 * deliberately avoid `keytar` to skip the native-module rebuild step;
 * upgrading to the macOS Keychain later is straightforward.
 */

import { EventEmitter } from 'events'
import { createServer, type Server } from 'http'
import { promises as fsp, constants as fsc } from 'fs'
import { join } from 'path'
import { app, shell } from 'electron'
import { hostname } from 'os'

function defaultBaseUrl(): string {
  if (process.env.RAX_BASE_URL) return process.env.RAX_BASE_URL
  // In dev (npm run dev), the rax-web Next.js server is at :3001.
  // In a packaged .app, point at the live deployment.
  return app.isPackaged ? 'https://rax-ai.com' : 'http://localhost:3001'
}

interface PersistedState {
  enabled: boolean
  key: string | null
  baseUrl?: string
}

let state: PersistedState = { enabled: false, key: null }
let loaded = false
const events = new EventEmitter()

function storePath(): string {
  return join(app.getPath('userData'), 'rax-cloud.json')
}

async function load(): Promise<void> {
  if (loaded) return
  try {
    const raw = await fsp.readFile(storePath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<PersistedState>
    state = {
      enabled: !!parsed.enabled,
      key: typeof parsed.key === 'string' ? parsed.key : null,
      baseUrl: parsed.baseUrl,
    }
  } catch {
    // First run, no file. Defaults are fine.
  }
  loaded = true
}

async function persist(): Promise<void> {
  const path = storePath()
  await fsp.mkdir(join(path, '..'), { recursive: true })
  await fsp.writeFile(path, JSON.stringify(state, null, 2), { mode: 0o600 })
  try { await fsp.chmod(path, 0o600) } catch {}
  events.emit('changed')
}

export function baseUrl(): string {
  return state.baseUrl ?? defaultBaseUrl()
}

export async function getStatus(): Promise<{
  enabled: boolean
  signedIn: boolean
  keyPrefix: string | null
  baseUrl: string
}> {
  await load()
  return {
    enabled: state.enabled && !!state.key,
    signedIn: !!state.key,
    keyPrefix: state.key ? state.key.slice(0, 12) : null,
    baseUrl: baseUrl(),
  }
}

/** True when env-injection should be applied at spawn time. */
export function isActive(): boolean {
  return loaded && state.enabled && !!state.key
}

/** Return the currently active API key, or null if not in active state. */
export function getActiveKey(): string | null {
  return isActive() ? state.key : null
}

export async function setEnabled(enabled: boolean): Promise<void> {
  await load()
  state.enabled = enabled
  await persist()
}

export async function signOut(): Promise<void> {
  await load()
  state.key = null
  state.enabled = false
  await persist()
}

export function onChange(fn: () => void): () => void {
  events.on('changed', fn)
  return () => events.off('changed', fn)
}

/**
 * Fetch the user's current account snapshot (email + balance) from
 * /api/me. Returns null fields with an `error` string on failure.
 */
export async function fetchAccount(): Promise<{
  email: string | null
  balanceCents: number | null
  fetchedAt: string | null
  error: string | null
}> {
  if (!isActive()) {
    return { email: null, balanceCents: null, fetchedAt: null, error: 'not_signed_in' }
  }
  const key = state.key!
  try {
    const res = await fetch(`${baseUrl()}/api/me`, {
      method: 'GET',
      headers: { authorization: `Bearer ${key}` },
    })
    if (!res.ok) {
      return {
        email: null,
        balanceCents: null,
        fetchedAt: new Date().toISOString(),
        error: `http_${res.status}`,
      }
    }
    const j = (await res.json()) as { email?: string; balance_cents?: number }
    return {
      email: j.email ?? null,
      balanceCents: typeof j.balance_cents === 'number' ? j.balance_cents : null,
      fetchedAt: new Date().toISOString(),
      error: null,
    }
  } catch (err) {
    return {
      email: null,
      balanceCents: null,
      fetchedAt: new Date().toISOString(),
      error: (err as Error).message ?? 'fetch_failed',
    }
  }
}

/**
 * Drive the loopback OAuth flow. Returns when the user completes (or
 * cancels) the browser flow.
 */
export async function signIn(): Promise<{ ok: true } | { ok: false; reason: string }> {
  await load()

  return new Promise((resolve) => {
    let resolved = false
    const port = pickPort()
    let server: Server | null = null

    const finish = (out: { ok: true } | { ok: false; reason: string }) => {
      if (resolved) return
      resolved = true
      try { server?.close() } catch {}
      resolve(out)
    }

    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const key = url.searchParams.get('key')
      if (!key || !key.startsWith('rax_sk_')) {
        res.writeHead(400, { 'content-type': 'text/html' }).end(htmlPage(
          'Sign-in failed',
          'No key was returned. You can close this window and try again from Rax.',
        ))
        finish({ ok: false, reason: 'missing key' })
        return
      }
      state.key = key
      state.enabled = true
      await persist()
      res.writeHead(200, { 'content-type': 'text/html' }).end(htmlPage(
        'Signed in to Rax',
        'You can close this window and return to the Rax app.',
      ))
      finish({ ok: true })
    })

    server.on('error', (err) => finish({ ok: false, reason: err.message }))
    server.listen(port, '127.0.0.1', () => {
      const device = encodeURIComponent(hostname())
      const url = `${baseUrl()}/api/auth/cli?port=${port}&device=${device}`
      void shell.openExternal(url)
    })

    // 5-minute timeout — user closed the browser without finishing.
    setTimeout(() => finish({ ok: false, reason: 'timeout' }), 5 * 60_000).unref()
  })
}

function pickPort(): number {
  // Stable port range — collisions are vanishingly rare on a dev machine.
  return 53682 + Math.floor(Math.random() * 100)
}

function htmlPage(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8">
<title>${title}</title>
<style>
  html,body{height:100%;margin:0;display:flex;align-items:center;justify-content:center;
    font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;background:#0a0a0a;color:#e5e5e5;}
  .card{max-width:420px;padding:32px;text-align:center;}
  h1{font-size:18px;margin:0 0 8px;font-weight:600}
  p{margin:0;color:#a3a3a3;font-size:14px;line-height:1.5}
</style>
<div class="card">
  <h1>${title}</h1>
  <p>${body}</p>
</div>`
}

// Kick off the load as soon as Electron is ready so isActive() returns
// the correct value to the orb / haiku verifier on the very first call,
// even before any auth IPC has fired.
void app.whenReady().then(() => load())
