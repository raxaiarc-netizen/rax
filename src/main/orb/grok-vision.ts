import Anthropic from '@anthropic-ai/sdk'
import { spawn } from 'child_process'
import * as raxAuth from '../auth/rax'
import { log as _log } from '../logger'

function log(msg: string): void {
  _log('GrokVision', msg)
}

// ─── Vision sidecar for the Grok realtime backend ───
//
// Grok's speech-to-speech API can't receive image bytes, so on its own the
// orb is blind: rax_screenshot degrades to coordinates and the model can
// only offer to "have a crew member look". This sidecar gives Grok mode
// working eyes — every screenshot result is run through a fast Claude
// vision call and the description rides back inside the tool output, so
// "what's my mouse hovering over?" gets a real answer in one tool hop
// instead of a 30-second crew dispatch.
//
// Credentials reuse the app's existing ladder (same as OrbDirectSession):
//   1. Rax cloud key (proxy baseURL)
//   2. Claude CLI OAuth from the macOS Keychain — needs the canonical
//      Claude Code preamble as the first system block + the oauth beta
//      header or Anthropic rejects the token
//   3. ANTHROPIC_API_KEY env
// No credentials → returns null and the tool output falls back to the
// honest "image content unknown" note.

const MODEL = 'claude-haiku-4-5'
// Click-grounding uses the same model class the DEFAULT orb uses to read
// coordinates off a screenshot (claude-sonnet-4-6) — that's exactly why the
// default orb clicks accurately and the blind realtime model does not. Grok
// describes the target in words; this model, which sees the pixels, returns
// the point. Overridable for tuning.
const CLICK_MODEL = process.env.RAX_GROK_CLICK_MODEL || 'claude-sonnet-4-6'
const MAX_TOKENS = 400
const CLICK_MAX_TOKENS = 300
const TIMEOUT_MS = 12_000
const OAUTH_PREAMBLE = "You are Claude Code, Anthropic's official CLI for Claude."

const LOCATE_SYSTEM = [
  'You locate on-screen targets for a voice agent that drives a real mouse. You are given a screenshot and a short description of what the user wants clicked. Return the single best point to click.',
  '',
  'Coordinates are IMAGE PIXELS of the attached screenshot, top-left origin:',
  '  x = 0 at the LEFT edge, growing rightward. y = 0 at the TOP edge, growing downward.',
  'The user message states the exact pixel dimensions of the image — your coordinates must fall inside those bounds.',
  'Aim at the CENTER of the clickable element (the icon glyph, the button\'s middle, the link text), not its label beside it and not the surrounding padding.',
  '',
  'Reply with ONE line of strict JSON and nothing else (no other braces anywhere):',
  '{"found": true|false, "x": <int px>, "y": <int px>, "label": "<what you are pointing at>", "confidence": <0-1>}',
  'If the described target is not visible, or you are not reasonably sure which element it is, return {"found": false, "label": "<what you DO see that is closest, or none>", "confidence": 0}. Do not guess a random spot — a wrong click is worse than admitting you cannot find it.',
].join('\n')

export interface LocateResult {
  found: boolean
  /** IMAGE-PIXEL coordinates of the searched screenshot, top-left origin
   *  (only meaningful when found). Pixel space — not normalized — because
   *  that is the coordinate convention Claude points accurately in; it is
   *  exactly how the default orb reads click targets off a screenshot. */
  x: number
  y: number
  label: string
  confidence: number
}

const VISION_SYSTEM = [
  'You are the eyes of a voice agent that cannot see images itself. Describe the attached screenshot FOR THE AGENT to relay aloud.',
  'Priorities, in order:',
  '1. What sits exactly at/under the cursor — marked by a RED RING with a white dot. Name the specific UI element (button label, link text, file name, tab title, icon).',
  '2. The frontmost app/window and what it shows.',
  '3. Anything else load-bearing for the user\'s likely question.',
  'Write 2-4 short plain-text sentences. No markdown, no coordinates, no preamble — just the description.',
].join('\n')

interface VisionClient {
  client: Anthropic
  oauthMode: boolean
}

let cached: { source: string; vc: VisionClient } | null = null
let cachedOauth: { token: string | null; readAt: number } | null = null
const OAUTH_CACHE_TTL_MS = 60_000

async function readClaudeOauthToken(): Promise<string | null> {
  if (process.platform !== 'darwin') return null
  if (cachedOauth && Date.now() - cachedOauth.readAt < OAUTH_CACHE_TTL_MS) return cachedOauth.token
  const token = await new Promise<string | null>((resolve) => {
    const child = spawn('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout!.on('data', (b: Buffer) => { stdout += b.toString('utf-8') })
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      if (code !== 0) return resolve(null)
      try {
        const parsed = JSON.parse(stdout.trim()) as { claudeAiOauth?: { accessToken?: string } }
        resolve(parsed.claudeAiOauth?.accessToken || null)
      } catch {
        resolve(null)
      }
    })
  })
  cachedOauth = { token, readAt: Date.now() }
  return token
}

async function resolveClient(): Promise<VisionClient | null> {
  // Rax cloud first — same precedence as everywhere else in the app.
  if (raxAuth.isActive()) {
    const key = raxAuth.getActiveKey()
    if (key) {
      const source = `rax:${key.slice(-6)}`
      if (cached?.source === source) return cached.vc
      const vc = { client: new Anthropic({ apiKey: key, baseURL: raxAuth.baseUrl() }), oauthMode: false }
      cached = { source, vc }
      return vc
    }
  }
  const oauth = await readClaudeOauthToken()
  if (oauth) {
    const source = `oauth:${oauth.slice(-6)}`
    if (cached?.source === source) return cached.vc
    const vc = {
      client: new Anthropic({ authToken: oauth, defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' } }),
      oauthMode: true,
    }
    cached = { source, vc }
    return vc
  }
  if (process.env.ANTHROPIC_API_KEY) {
    const source = 'env'
    if (cached?.source === source) return cached.vc
    const vc = { client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }), oauthMode: false }
    cached = { source, vc }
    return vc
  }
  return null
}

/**
 * Describe a screenshot for the (blind) realtime voice model. `cursorLine`
 * is the screenshot tool's own text channel (size, display, cursor coords)
 * so the vision model knows where the red-ring marker points. Returns null
 * on any failure — callers fall back to the text-only note.
 */
export async function describeScreenshotForGrok(
  base64: string,
  mimeType: string,
  cursorLine: string,
): Promise<string | null> {
  let vc: VisionClient | null
  try {
    vc = await resolveClient()
  } catch (err) {
    log(`credential resolution failed: ${(err as Error).message}`)
    return null
  }
  if (!vc) {
    log('no credentials — vision sidecar disabled')
    return null
  }

  const system: Anthropic.Messages.TextBlockParam[] = vc.oauthMode
    ? [
        { type: 'text', text: OAUTH_PREAMBLE },
        { type: 'text', text: VISION_SYSTEM, cache_control: { type: 'ephemeral' } },
      ]
    : [{ type: 'text', text: VISION_SYSTEM, cache_control: { type: 'ephemeral' } }]

  const started = Date.now()
  try {
    const response = await vc.client.messages.create(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: (mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp') || 'image/png',
                  data: base64,
                },
              },
              {
                type: 'text',
                text:
                  `${cursorLine ? cursorLine + '\n' : ''}` +
                  'Describe this screen for the voice agent, leading with what the red-ring cursor marker is on.',
              },
            ],
          },
        ],
      },
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    )
    let text = ''
    for (const block of response.content) {
      if (block.type === 'text') text += block.text
    }
    const trimmed = text.trim()
    log(`described screenshot in ${Date.now() - started}ms (${trimmed.length} chars)`)
    return trimmed || null
  } catch (err) {
    log(`vision call failed after ${Date.now() - started}ms: ${(err as Error).message}`)
    return null
  }
}

/**
 * Locate a click target in a screenshot for the (blind) realtime voice model.
 * `target` is the natural-language description the model gave ("the calendar
 * icon in the dock"). `imageWidth`/`imageHeight` are the screenshot's exact
 * pixel dimensions — stated to the model so its answer is anchored to OUR
 * pixel space (callers must capture small enough that the Anthropic API does
 * not resize what the model sees: long edge ≤1280 is safe). Returns
 * image-pixel coordinates for rax_control_screen `unit:'px'`, or null when
 * no credentials / call failed. A `{found:false}` result is a real answer
 * (target not on screen) — the caller relays it instead of clicking.
 */
export async function locateTargetForGrok(
  base64: string,
  mimeType: string,
  target: string,
  imageWidth: number,
  imageHeight: number,
): Promise<LocateResult | null> {
  let vc: VisionClient | null
  try {
    vc = await resolveClient()
  } catch (err) {
    log(`locate: credential resolution failed: ${(err as Error).message}`)
    return null
  }
  if (!vc) {
    log('locate: no credentials — grounding disabled')
    return null
  }

  const system: Anthropic.Messages.TextBlockParam[] = vc.oauthMode
    ? [
        { type: 'text', text: OAUTH_PREAMBLE },
        { type: 'text', text: LOCATE_SYSTEM, cache_control: { type: 'ephemeral' } },
      ]
    : [{ type: 'text', text: LOCATE_SYSTEM, cache_control: { type: 'ephemeral' } }]

  const started = Date.now()
  try {
    const response = await vc.client.messages.create(
      {
        model: CLICK_MODEL,
        max_tokens: CLICK_MAX_TOKENS,
        system,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: (mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp') || 'image/png',
                  data: base64,
                },
              },
              {
                type: 'text',
                text:
                  `This image is exactly ${imageWidth}x${imageHeight} pixels.\n` +
                  `Target to click: ${target}\nReturn the JSON now.`,
              },
            ],
          },
        ],
      },
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    )
    let text = ''
    for (const block of response.content) {
      if (block.type === 'text') text += block.text
    }
    const parsed = parseLocate(text, imageWidth, imageHeight)
    log(
      `located "${clipForLog(target)}" in ${Date.now() - started}ms → ` +
        (parsed ? `found=${parsed.found} (${parsed.x},${parsed.y})px of ${imageWidth}x${imageHeight} "${clipForLog(parsed.label)}" conf=${parsed.confidence}` : 'unparseable'),
    )
    return parsed
  } catch (err) {
    log(`locate call failed after ${Date.now() - started}ms: ${(err as Error).message}`)
    return null
  }
}

function parseLocate(text: string, imageWidth: number, imageHeight: number): LocateResult | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>
    const found = o.found === true
    const x = clampPx(o.x, imageWidth)
    const y = clampPx(o.y, imageHeight)
    const label = typeof o.label === 'string' ? o.label.slice(0, 120) : ''
    const confidence = typeof o.confidence === 'number' ? Math.max(0, Math.min(1, o.confidence)) : found ? 0.5 : 0
    // A "found" verdict with no usable coordinate is not actionable.
    if (found && (x < 0 || y < 0)) return { found: false, x: 0, y: 0, label, confidence: 0 }
    return { found, x: Math.max(0, x), y: Math.max(0, y), label, confidence }
  } catch {
    return null
  }
}

function clampPx(v: unknown, max: number): number {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10)
  if (!Number.isFinite(n)) return -1
  return Math.max(0, Math.min(Math.max(1, Math.round(max)) - 1, Math.round(n)))
}

function clipForLog(s: string): string {
  return s.length > 60 ? s.slice(0, 59) + '…' : s
}
