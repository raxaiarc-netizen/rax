import { spawn, ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { createServer } from 'net'
import { getCliEnv } from '../cli-env'
import type { DetectedProject } from '../../shared/types'

const URL_PATTERN = /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/[^\s\x1b]*)?)/i

export type DevServerEvent =
  | { type: 'starting'; pid: number }
  | { type: 'log'; stream: 'stdout' | 'stderr'; line: string }
  | { type: 'ready'; url: string }
  | { type: 'error'; message: string }
  | { type: 'exit'; code: number | null; signal: NodeJS.Signals | null }

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (typeof addr === 'object' && addr) {
        const port = addr.port
        srv.close(() => resolve(port))
      } else {
        srv.close(() => reject(new Error('Could not allocate port')))
      }
    })
  })
}

function stripAnsi(input: string): string {
  // Drop CSI sequences and other control bytes that dev servers love to print.
  return input.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '')
}

function extractUrl(line: string): string | null {
  const cleaned = stripAnsi(line)
  const match = cleaned.match(URL_PATTERN)
  if (!match) return null
  let url = match[1]
  // Trim trailing punctuation that dev servers love to print after URLs
  url = url.replace(/[.,)\]'`]+$/, '')
  // Some loggers wrap URLs with "Local:" labels — already handled by regex
  return url
}

export interface StartedServer {
  url: string
  pid: number
  port: number | null
}

export class DevServerManager extends EventEmitter {
  private child: ChildProcess | null = null
  private resolved = false
  private startupTimer: NodeJS.Timeout | null = null
  private readonly logBuffer: string[] = []
  private readonly LOG_LIMIT = 200

  isRunning(): boolean {
    return !!this.child && this.child.exitCode === null
  }

  recentLogs(): string[] {
    return [...this.logBuffer]
  }

  async start(projectPath: string, project: DetectedProject): Promise<StartedServer> {
    if (this.isRunning()) {
      throw new Error('Dev server already running — stop it first')
    }
    if (project.kind === 'unknown' || !project.command) {
      throw new Error('Could not detect a runnable project in this folder')
    }

    this.logBuffer.length = 0
    this.resolved = false

    let assignedPort: number | null = null
    let args = [...project.args]

    // Static-html servers need an explicit port — find one and substitute.
    if (project.kind === 'static-html') {
      assignedPort = await findFreePort()
      args = args.map((a) => (a === '__PORT__' ? String(assignedPort) : a))
    }

    const env = { ...getCliEnv() }
    if (project.honorsPortEnv && !env.PORT) {
      assignedPort = assignedPort ?? (await findFreePort())
      env.PORT = String(assignedPort)
    }
    // BROWSER=none stops CRA/Next from auto-opening Chrome behind us.
    env.BROWSER = 'none'
    env.FORCE_COLOR = '0'
    env.NO_COLOR = '1'
    env.CI = '1'

    let child: ChildProcess
    try {
      child = spawn(project.command, args, {
        cwd: projectPath,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Detached so we can kill the whole tree (npm spawns its own children).
        detached: true,
      })
    } catch (err) {
      throw new Error(`Failed to spawn ${project.command}: ${(err as Error).message}`)
    }

    if (!child.pid) {
      throw new Error(`Failed to spawn ${project.command}`)
    }

    this.child = child
    this.emit('event', { type: 'starting', pid: child.pid } satisfies DevServerEvent)

    return new Promise<StartedServer>((resolve, reject) => {
      const finishReady = (url: string) => {
        if (this.resolved) return
        this.resolved = true
        if (this.startupTimer) clearTimeout(this.startupTimer)
        this.emit('event', { type: 'ready', url } satisfies DevServerEvent)
        resolve({ url, pid: child.pid!, port: assignedPort })
      }

      const finishError = (message: string) => {
        if (this.resolved) return
        this.resolved = true
        if (this.startupTimer) clearTimeout(this.startupTimer)
        this.emit('event', { type: 'error', message } satisfies DevServerEvent)
        reject(new Error(message))
        // Best-effort cleanup
        this.kill()
      }

      const handleLine = (stream: 'stdout' | 'stderr', raw: string) => {
        const line = stripAnsi(raw)
        this.logBuffer.push(`[${stream}] ${line}`)
        if (this.logBuffer.length > this.LOG_LIMIT) this.logBuffer.shift()
        this.emit('event', { type: 'log', stream, line } satisfies DevServerEvent)

        if (!this.resolved) {
          const url = extractUrl(line)
          if (url) finishReady(url)
        }
      }

      const lineSplitter = (stream: 'stdout' | 'stderr') => {
        let buf = ''
        return (chunk: Buffer) => {
          buf += chunk.toString('utf-8')
          const lines = buf.split('\n')
          buf = lines.pop() || ''
          for (const line of lines) {
            if (line.length > 0) handleLine(stream, line)
          }
        }
      }

      child.stdout?.on('data', lineSplitter('stdout'))
      child.stderr?.on('data', lineSplitter('stderr'))

      child.on('error', (err) => finishError(err.message))

      child.on('exit', (code, signal) => {
        this.emit('event', { type: 'exit', code, signal } satisfies DevServerEvent)
        if (!this.resolved) {
          const tail = this.logBuffer.slice(-12).join('\n')
          finishError(
            `Dev server exited (${code ?? 'no code'}) before announcing a URL.\n${tail}`,
          )
        }
        if (this.child === child) this.child = null
      })

      // 90 seconds is generous — Next/Vite cold start can be 30s+ on slow disks.
      this.startupTimer = setTimeout(() => {
        if (!this.resolved) {
          if (project.fallbackPort && project.fallbackPort > 0) {
            // Fall back to the framework default; the dev server might just be quiet.
            const fallback = `http://localhost:${assignedPort ?? project.fallbackPort}/`
            finishReady(fallback)
          } else {
            finishError('Timed out waiting for dev server to start')
          }
        }
      }, 90_000)
    })
  }

  kill(): void {
    if (!this.child) return
    const child = this.child
    this.child = null
    if (this.startupTimer) {
      clearTimeout(this.startupTimer)
      this.startupTimer = null
    }
    try {
      // Negative PID kills the whole process group (we spawned with detached: true).
      if (child.pid && child.exitCode === null) {
        try {
          process.kill(-child.pid, 'SIGINT')
        } catch {
          child.kill('SIGINT')
        }
        setTimeout(() => {
          if (child.exitCode === null) {
            try {
              process.kill(-child.pid!, 'SIGTERM')
            } catch {
              child.kill('SIGTERM')
            }
          }
        }, 4_000)
      }
    } catch {
      // best effort
    }
  }
}
