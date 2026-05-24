import Anthropic from '@anthropic-ai/sdk'
import { log as _log } from '../logger'

function log(msg: string): void {
  _log('HaikuVerifier', msg)
}

export interface HaikuVerdict {
  should_capture: boolean
  reason: string
}

export interface HaikuVerifier {
  verify(transcript: string, signal?: AbortSignal): Promise<HaikuVerdict>
  enabled: boolean
}

/**
 * Where each verify() call should be sent. Returning `null` disables the
 * verifier (orb falls back to regex-only auto-screenshot). The supplier
 * is consulted on every call so the verifier follows Rax-mode toggles
 * without the main process having to rebuild it.
 */
export interface HaikuCredentials {
  apiKey: string
  /** Optional base URL override — e.g. https://rax-ai.com when Rax cloud is on. */
  baseURL?: string
}

export type HaikuCredentialsSupplier = () => HaikuCredentials | null

// System prompt is sticky across every turn of a session; with prompt caching
// enabled on the system block, every call after the first one hits cache and
// pays the cheaper cached-input rate.
const SYSTEM_PROMPT = `You are a fast classifier for a voice agent that may attach a screenshot of the user's screen. Decide whether a transcript is referring to something currently visible on the user's screen — i.e. the agent needs to SEE the screen to answer.

Return ONLY JSON: {"should_capture": true|false, "reason": "<5 words"}

CAPTURE when the user means something visible right now:
 - "what's this", "what is that" pointing at on-screen UI
 - "is it loading", "did it finish" referring to visible state
 - "this isn't working", "why is that broken" — visible failure
 - "right here", "over there" — pointing at a location

DO NOT capture when:
 - "this" / "it" refers to something earlier in this conversation
   ("I had this idea", "the bug we discussed")
 - General knowledge ("what time is it", "what day is it") UNLESS the
   user explicitly means a clock visible on their screen
 - Abstract reasoning, no on-screen referent

When uncertain, prefer DO NOT capture.`

const MODEL = 'claude-haiku-4-5'
const MAX_TOKENS = 64

class DynamicHaikuVerifier implements HaikuVerifier {
  readonly enabled = true
  private cached: { key: string; baseURL: string; client: Anthropic } | null = null

  constructor(private readonly supplier: HaikuCredentialsSupplier) {}

  private client(): Anthropic | null {
    const creds = this.supplier()
    if (!creds || !creds.apiKey) return null

    const baseURL = creds.baseURL ?? ''
    if (this.cached && this.cached.key === creds.apiKey && this.cached.baseURL === baseURL) {
      return this.cached.client
    }
    const client = new Anthropic({
      apiKey: creds.apiKey,
      ...(creds.baseURL ? { baseURL: creds.baseURL } : {}),
    })
    this.cached = { key: creds.apiKey, baseURL, client }
    return client
  }

  async verify(transcript: string, signal?: AbortSignal): Promise<HaikuVerdict> {
    const trimmed = (transcript || '').trim().slice(0, 600)
    if (!trimmed) return { should_capture: false, reason: 'empty transcript' }

    const client = this.client()
    if (!client) return { should_capture: false, reason: 'no credentials' }

    try {
      const response = await client.messages.create(
        {
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: [
            {
              type: 'text',
              text: SYSTEM_PROMPT,
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages: [
            {
              role: 'user',
              content: `Transcript: "${trimmed}"`,
            },
          ],
        },
        { signal },
      )

      const text = extractText(response)
      const parsed = parseVerdict(text)
      if (parsed) return parsed
      log(`Unparseable verdict — text=${text.slice(0, 120)}`)
      return { should_capture: false, reason: 'parse failed' }
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') {
        throw err
      }
      log(`Haiku call failed: ${(err as Error).message}`)
      return { should_capture: false, reason: 'api error' }
    }
  }
}

class NullHaikuVerifier implements HaikuVerifier {
  readonly enabled = false
  async verify(): Promise<HaikuVerdict> {
    return { should_capture: false, reason: 'haiku disabled' }
  }
}

/**
 * Returns a working Haiku verifier whose credentials are resolved on
 * every call via `supplier`. Pass `null` (or have the supplier return
 * `null`) to disable verification — the orb will fall back to its
 * regex-only auto-screenshot heuristic.
 */
export function createHaikuVerifier(
  supplier: HaikuCredentialsSupplier | null,
): HaikuVerifier {
  if (!supplier) return new NullHaikuVerifier()
  return new DynamicHaikuVerifier(supplier)
}

function extractText(response: Anthropic.Messages.Message): string {
  let out = ''
  for (const block of response.content) {
    if (block.type === 'text') out += block.text
  }
  return out
}

function parseVerdict(text: string): HaikuVerdict | null {
  const trimmed = text.trim()
  // Tolerate ```json fences and stray prose around the JSON.
  const match = trimmed.match(/\{[\s\S]*?\}/)
  if (!match) return null
  try {
    const obj = JSON.parse(match[0])
    if (typeof obj?.should_capture !== 'boolean') return null
    return {
      should_capture: !!obj.should_capture,
      reason: typeof obj.reason === 'string' ? obj.reason.slice(0, 80) : '',
    }
  } catch {
    return null
  }
}
