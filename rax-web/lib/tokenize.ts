/**
 * Lightweight input-token estimator.
 *
 * Anthropic doesn't ship a public client-side tokenizer (their tokenizer
 * counts via /v1/messages/count_tokens on the server). We *could* call
 * that endpoint here but it adds a network round-trip to every proxied
 * request, so we instead use a deliberately-conservative heuristic that
 * over-estimates by ~10-15%. The reconcile step later corrects the
 * charge to the exact value Anthropic reports.
 *
 * Heuristic: 1 token ≈ 3.5 chars of typical English text. We multiply by
 * 1.10 to bias upward, then add a small per-message constant for the
 * role/structure overhead.
 */

type MessageContent =
  | string
  | Array<{ type: string; text?: string; source?: { data?: string } }>

type Message = {
  role: string
  content: MessageContent
}

export type CountInput = {
  system?: string | Array<{ type: string; text?: string }>
  messages: Message[]
  tools?: Array<{ name: string; description?: string; input_schema?: unknown }>
}

function countString(s: string): number {
  if (!s) return 0
  return Math.ceil((s.length / 3.5) * 1.10)
}

function countSystem(system: CountInput['system']): number {
  if (!system) return 0
  if (typeof system === 'string') return countString(system)
  let n = 0
  for (const block of system) if (block?.text) n += countString(block.text)
  return n
}

function countMessage(m: Message): number {
  let n = 6 // role + structural overhead
  if (typeof m.content === 'string') {
    n += countString(m.content)
  } else if (Array.isArray(m.content)) {
    for (const b of m.content) {
      if (b.type === 'text' && b.text) n += countString(b.text)
      else if (b.type === 'image') n += 1300 // worst-case low-detail image
      else if (b.text) n += countString(b.text)
      else n += 8 // tool_use / tool_result envelope
    }
  }
  return n
}

function countTools(tools: CountInput['tools']): number {
  if (!tools) return 0
  let n = 0
  for (const t of tools) {
    n += countString(t.name)
    n += countString(t.description ?? '')
    n += countString(JSON.stringify(t.input_schema ?? {}))
  }
  return n
}

export function estimateInputTokens(input: CountInput): number {
  let n = 0
  n += countSystem(input.system)
  n += countTools(input.tools)
  for (const m of input.messages ?? []) n += countMessage(m)
  return n
}
