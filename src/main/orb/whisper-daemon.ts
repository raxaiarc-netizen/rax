import { spawn, type ChildProcess } from 'child_process'
import { createServer } from 'net'
import { existsSync, mkdirSync, readFileSync, statSync, createWriteStream, renameSync, unlinkSync } from 'fs'
import { homedir } from 'os'
import { join, basename, dirname } from 'path'
import { request as httpRequest } from 'http'
import { randomBytes } from 'crypto'
import * as https from 'https'
import { app } from 'electron'
import { getCliEnv } from '../cli-env'
import { log as _log } from '../logger'

function log(msg: string): void {
  _log('WhisperDaemon', msg)
}

const DEFAULT_TINY_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin'
const STARTUP_READY_RE = /whisper server listening at/i
const STARTUP_TIMEOUT_MS = 60_000
const REQUEST_TIMEOUT_MS = 30_000

/**
 * Locate the bundled whisper-server + model that ship inside the .app.
 * Always preferred over Homebrew copies — those depend on
 * /opt/homebrew/opt/ggml/lib/libggml*.dylib (hardcoded RPATH) and don't run
 * on a machine without Homebrew installed.
 *
 * scripts/vendor-whisper.sh produces this layout:
 *   resources/whisper/
 *     bin/whisper-server      (statically linked, system dyld only)
 *     models/ggml-tiny.bin    (~75 MB)
 */
function bundledWhisperRoot(): string | null {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'whisper')]
    : [
        join(app.getAppPath(), 'resources', 'whisper'),
        join(process.cwd(), 'resources', 'whisper'),
      ]
  for (const p of candidates) {
    if (existsSync(join(p, 'bin', 'whisper-server'))) return p
  }
  return null
}

function buildServerCandidates(): string[] {
  const list: string[] = []
  const bundled = bundledWhisperRoot()
  if (bundled) list.push(join(bundled, 'bin', 'whisper-server'))
  list.push(
    '/opt/homebrew/bin/whisper-server',
    '/usr/local/bin/whisper-server',
    join(homedir(), '.local/bin/whisper-server'),
  )
  return list
}

function buildModelCandidates(): string[] {
  const list: string[] = []
  const bundled = bundledWhisperRoot()
  if (bundled) {
    list.push(
      join(bundled, 'models', 'ggml-base.bin'),
      join(bundled, 'models', 'ggml-tiny.bin'),
      join(bundled, 'models', 'ggml-base.en.bin'),
      join(bundled, 'models', 'ggml-tiny.en.bin'),
    )
  }
  list.push(
    // User-installed (system) — multilingual preferred (auto-detect).
    join(homedir(), '.local/share/whisper/ggml-base.bin'),
    join(homedir(), '.local/share/whisper/ggml-tiny.bin'),
    '/opt/homebrew/share/whisper-cpp/models/ggml-base.bin',
    '/opt/homebrew/share/whisper-cpp/models/ggml-tiny.bin',
    // English-only fallback.
    join(homedir(), '.local/share/whisper/ggml-base.en.bin'),
    join(homedir(), '.local/share/whisper/ggml-tiny.en.bin'),
    '/opt/homebrew/share/whisper-cpp/models/ggml-base.en.bin',
    '/opt/homebrew/share/whisper-cpp/models/ggml-tiny.en.bin',
  )
  return list
}

const HALLUCINATION_RE = /^\s*(\[BLANK_AUDIO\]|you\.?|thank you\.?|thanks\.?)\s*$/i

export interface TranscribeResult {
  transcript: string
  /** Time spent inside HTTP round-trip (network + inference). */
  inferenceMs: number
}

/**
 * Long-lived whisper.cpp HTTP daemon. Starts a `whisper-server` subprocess on
 * a private port at orb startup; subsequent transcribe() calls go over HTTP
 * with the model already resident, eliminating the 300–700ms cold-spawn cost
 * the per-turn `whisper-cli` path pays today.
 *
 * Falls back gracefully: `start()` resolves with `false` if `whisper-server`
 * isn't installed or no model is available — callers must check `isReady()`
 * before each transcribe and use the legacy path otherwise.
 *
 * Auto-respawns on unexpected exit so a crash doesn't permanently disable
 * the fast path.
 */
export class WhisperDaemon {
  private state: 'idle' | 'starting' | 'ready' | 'failed' = 'idle'
  private child: ChildProcess | null = null
  private port = 0
  private modelPath = ''
  private serverBin = ''
  private startPromise: Promise<boolean> | null = null
  /** Disabled means we won't auto-respawn (e.g. no model + download failed). */
  private disabled = false

  /** Probe + (lazy) start. Idempotent. Returns true if ready, false if unavailable. */
  start(): Promise<boolean> {
    if (this.disabled) return Promise.resolve(false)
    if (this.state === 'ready') return Promise.resolve(true)
    if (this.startPromise) return this.startPromise
    this.startPromise = this._start().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  isReady(): boolean {
    return this.state === 'ready' && !!this.child && this.child.exitCode === null
  }

  /**
   * Transcribe a WAV file via the running daemon. Throws if the daemon isn't
   * ready — callers must gate on `isReady()` or accept the throw and fall
   * through to the legacy spawn path.
   */
  async transcribe(wavPath: string): Promise<TranscribeResult> {
    if (!this.isReady()) throw new Error('whisper daemon not ready')
    const t0 = Date.now()
    const result = await uploadWavMultipart(
      `http://127.0.0.1:${this.port}/inference`,
      wavPath,
      {
        response_format: 'json',
        temperature: '0',
        // The daemon is started with a language flag matching the model
        // (auto for multilingual, en for .en). Re-asserting per-request is
        // harmless and explicit.
        language: this._isEnglishOnlyModel() ? 'en' : 'auto',
      },
      REQUEST_TIMEOUT_MS,
    )
    const raw = typeof (result as { text?: unknown }).text === 'string'
      ? (result as { text: string }).text
      : ''
    const trimmed = raw.trim()
    const transcript = HALLUCINATION_RE.test(trimmed) ? '' : trimmed
    return { transcript, inferenceMs: Date.now() - t0 }
  }

  shutdown(): void {
    this.disabled = true
    if (this.child) {
      try { this.child.kill('SIGTERM') } catch {}
      this.child = null
    }
    this.state = 'idle'
  }

  // ─── Internals ───

  private async _start(): Promise<boolean> {
    if (this.state === 'starting') return false
    this.state = 'starting'
    try {
      this.serverBin = findServerBinary()
      if (!this.serverBin) {
        log('whisper-server not installed — daemon disabled, fallback path will handle transcription')
        this.disabled = true
        this.state = 'idle'
        return false
      }

      this.modelPath = findModel()
      if (!this.modelPath) {
        log('No whisper model found — attempting auto-download of ggml-tiny')
        try {
          const dest = join(homedir(), '.local/share/whisper/ggml-tiny.bin')
          await downloadModel(dest, DEFAULT_TINY_URL)
          this.modelPath = dest
          log(`Model downloaded to ${dest}`)
        } catch (err) {
          log(`Model auto-download failed: ${(err as Error).message} — daemon disabled`)
          this.disabled = true
          this.state = 'idle'
          return false
        }
      }

      this.port = await pickFreePort()

      const args = [
        '-m', this.modelPath,
        '--host', '127.0.0.1',
        '--port', String(this.port),
        '--inference-path', '/inference',
        '-nt',           // no timestamps
        '-nlp',          // no language probabilities in verbose_json
        '-nf',           // no temperature fallback (faster)
        '-sns',          // suppress non-speech tokens
        '-t', '4',
        '-l', this._isEnglishOnlyModel() ? 'en' : 'auto',
      ]

      log(`Starting daemon: ${this.serverBin} (model=${basename(this.modelPath)}, port=${this.port})`)
      const child = spawn(this.serverBin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: getCliEnv(),
      })
      this.child = child

      // Whisper-server prints volumes of init noise to stderr. We watch for
      // the "listening at" line as the readiness signal, then quiet down.
      const ready = waitForReadiness(child, STARTUP_TIMEOUT_MS)

      child.on('exit', (code, signal) => {
        log(`Daemon exited code=${code} signal=${signal}`)
        const wasOurs = this.child === child
        if (wasOurs) {
          this.child = null
          this.state = this.disabled ? 'idle' : 'failed'
        }
        // If we exit unexpectedly while in steady-state, schedule a respawn.
        if (wasOurs && !this.disabled && code !== 0 && !signal) {
          setTimeout(() => {
            if (!this.disabled && this.state !== 'ready' && this.state !== 'starting') {
              log('Auto-respawning daemon')
              this.start().catch((err) => log(`Respawn failed: ${(err as Error).message}`))
            }
          }, 1000).unref?.()
        }
      })
      child.on('error', (err) => {
        log(`Daemon spawn error: ${err.message}`)
      })

      await ready
      this.state = 'ready'
      log(`Daemon ready on 127.0.0.1:${this.port}`)
      return true
    } catch (err) {
      log(`Daemon start failed: ${(err as Error).message}`)
      if (this.child) {
        try { this.child.kill('SIGTERM') } catch {}
        this.child = null
      }
      this.state = 'failed'
      return false
    }
  }

  private _isEnglishOnlyModel(): boolean {
    return this.modelPath.includes('.en.')
  }
}

// ─── Helpers ───

function findServerBinary(): string {
  for (const c of buildServerCandidates()) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return c
    } catch {}
  }
  return ''
}

function findModel(): string {
  for (const m of buildModelCandidates()) {
    try {
      if (existsSync(m)) return m
    } catch {}
  }
  return ''
}

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.unref()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address()
      if (!addr || typeof addr === 'string') {
        probe.close()
        reject(new Error('Failed to allocate port'))
        return
      }
      const port = addr.port
      probe.close(() => resolve(port))
    })
  })
}

function waitForReadiness(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(`whisper-server startup timeout after ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref?.()

    const onStderr = (chunk: Buffer): void => {
      buf += chunk.toString('utf-8')
      const lines = buf.split('\n')
      buf = lines.pop() || ''
      for (const line of lines) {
        if (STARTUP_READY_RE.test(line)) {
          if (settled) return
          settled = true
          cleanup()
          resolve()
          return
        }
      }
    }
    const onExitEarly = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(`whisper-server exited before ready (code=${code} signal=${signal})`))
    }
    function cleanup(): void {
      clearTimeout(timer)
      child.stderr?.removeListener('data', onStderr)
      child.removeListener('exit', onExitEarly)
    }
    child.stderr?.setEncoding('utf-8')
    child.stderr?.on('data', onStderr)
    child.once('exit', onExitEarly)
  })
}

function uploadWavMultipart(
  url: string,
  wavPath: string,
  fields: Record<string, string>,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch (err) {
      reject(err as Error)
      return
    }

    let fileBuf: Buffer
    try {
      fileBuf = readFileSync(wavPath)
    } catch (err) {
      reject(err as Error)
      return
    }

    const boundary = '----RaxOrbWhisper' + randomBytes(8).toString('hex')
    const filename = basename(wavPath)
    const headerParts: string[] = []
    for (const [k, v] of Object.entries(fields)) {
      headerParts.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${k}"\r\n` +
        `\r\n` +
        `${v}\r\n`,
      )
    }
    headerParts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: audio/wav\r\n` +
      `\r\n`,
    )
    const head = Buffer.from(headerParts.join(''), 'utf-8')
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8')
    const totalLength = head.length + fileBuf.length + tail.length

    const req = httpRequest(
      {
        method: 'POST',
        hostname: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : 80,
        path: parsed.pathname + parsed.search,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': totalLength,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8')
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 400)}`))
            return
          }
          try {
            resolve(body ? JSON.parse(body) : {})
          } catch {
            // whisper-server sometimes returns plain text — treat as transcript.
            resolve({ text: body })
          }
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('whisper request timeout')))
    req.on('error', reject)
    req.write(head)
    req.write(fileBuf)
    req.write(tail)
    req.end()
  })
}

function downloadModel(destPath: string, url: string): Promise<void> {
  mkdirSync(dirname(destPath), { recursive: true })
  const tmpPath = destPath + '.downloading'
  const fetchUrl = (current: string, redirects: number): Promise<void> =>
    new Promise((resolve, reject) => {
      if (redirects > 5) { reject(new Error('Too many redirects')); return }
      https.get(current, (res) => {
        const code = res.statusCode || 0
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume()
          fetchUrl(res.headers.location, redirects + 1).then(resolve, reject)
          return
        }
        if (code !== 200) {
          res.resume()
          reject(new Error(`HTTP ${code}`))
          return
        }
        const out = createWriteStream(tmpPath)
        res.pipe(out)
        out.on('finish', () => out.close(() => {
          try { renameSync(tmpPath, destPath); resolve() } catch (e) { reject(e as Error) }
        }))
        out.on('error', (err) => {
          try { unlinkSync(tmpPath) } catch {}
          reject(err)
        })
      }).on('error', reject)
    })
  return fetchUrl(url, 0)
}
