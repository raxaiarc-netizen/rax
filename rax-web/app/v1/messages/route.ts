import { NextResponse } from 'next/server'
import { extractKey } from '@/lib/api-key'
import { resolveApiKey } from '@/lib/auth-key'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { estimateInputTokens } from '@/lib/tokenize'
import { estimateCost, isSupportedModel, priceUsage, type Usage } from '@/lib/pricing'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const ANTHROPIC = 'https://api.anthropic.com/v1/messages'

function jsonError(status: number, type: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ type: 'error', error: { type, ...extra } }, { status })
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 })
}

export async function POST(req: Request) {
  const t0 = Date.now()
  const upstreamKey = process.env.ANTHROPIC_API_KEY
  if (!upstreamKey) return jsonError(500, 'server_misconfigured', { detail: 'no upstream key' })

  // ─── 1. Auth ─────────────────────────────────────────────────────────
  const plaintext = extractKey(req)
  if (!plaintext || !plaintext.startsWith('rax_sk_')) {
    return jsonError(401, 'invalid_api_key')
  }
  const resolved = await resolveApiKey(plaintext)
  if (!resolved) return jsonError(401, 'invalid_api_key')

  // ─── 2. Parse + estimate ─────────────────────────────────────────────
  let body: any
  try {
    body = await req.json()
  } catch {
    return jsonError(400, 'invalid_request_error', { message: 'malformed JSON' })
  }
  const model: string = body?.model
  if (typeof model !== 'string') {
    return jsonError(400, 'invalid_request_error', { message: 'model is required' })
  }
  if (!isSupportedModel(model)) {
    return jsonError(400, 'invalid_request_error', { message: `model ${model} not supported by rax` })
  }
  const maxTokens: number = typeof body?.max_tokens === 'number' ? body.max_tokens : 4096
  const inputTokens = estimateInputTokens(body)
  const estimate = estimateCost(model, inputTokens, maxTokens)

  // ─── 3. Atomic debit ─────────────────────────────────────────────────
  const db = supabaseAdmin()
  const { data: debitRow, error: debitErr } = await db.rpc('debit_or_reject', {
    p_user_id: resolved.user_id,
    p_api_key_id: resolved.key_id,
    p_model: model,
    p_estimate: estimate,
  })
  if (debitErr) {
    return jsonError(500, 'server_error', { message: debitErr.message })
  }
  const requestId: string | null = debitRow as any
  if (!requestId) {
    const { data: prof } = await db
      .from('profiles')
      .select('balance_cents')
      .eq('user_id', resolved.user_id)
      .single()
    return jsonError(402, 'insufficient_credits', {
      balance_cents: prof?.balance_cents ?? 0,
      estimated_cents: estimate,
      message: 'Insufficient Rax credits. Top up at https://rax-ai.com/app/dashboard.',
    })
  }

  // ─── 4. Forward to Anthropic ─────────────────────────────────────────
  const wantStream = body?.stream === true
  let upstream: Response
  try {
    upstream = await fetch(ANTHROPIC, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': upstreamKey,
        'anthropic-version': req.headers.get('anthropic-version') ?? '2023-06-01',
        ...(req.headers.get('anthropic-beta')
          ? { 'anthropic-beta': req.headers.get('anthropic-beta')! }
          : {}),
      },
      body: JSON.stringify(body),
    })
  } catch (e: any) {
    await finalize(requestId, estimate, model, null, 'error', e?.message ?? 'upstream_fetch_failed', Date.now() - t0)
    return jsonError(502, 'upstream_error', { message: 'failed to reach Anthropic' })
  }

  if (!upstream.ok) {
    // Mirror upstream error verbatim and refund the full estimate.
    const text = await upstream.text()
    await finalize(requestId, estimate, model, null, 'error', `upstream_${upstream.status}`, Date.now() - t0)
    return new NextResponse(text, {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
    })
  }

  // ─── 5a. Non-streaming response ──────────────────────────────────────
  if (!wantStream) {
    const json: any = await upstream.json()
    const usage: Usage = {
      input_tokens: json?.usage?.input_tokens ?? 0,
      output_tokens: json?.usage?.output_tokens ?? 0,
      cache_creation_input_tokens: json?.usage?.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: json?.usage?.cache_read_input_tokens ?? 0,
    }
    await finalize(requestId, estimate, model, usage, 'ok', null, Date.now() - t0)
    return NextResponse.json(json)
  }

  // ─── 5b. Streaming response ──────────────────────────────────────────
  const usage: Usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }

  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let sseBuffer = ''

  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body!.getReader()
      let aborted = false

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          // Inspect chunks for usage events before passing through.
          sseBuffer += decoder.decode(value, { stream: true })
          parseSseBuffer()
          controller.enqueue(value)
        }
      } catch (err) {
        aborted = true
      } finally {
        try { controller.close() } catch {}
        const status = aborted ? 'aborted' : 'ok'
        await finalize(requestId, estimate, model, usage, status, null, Date.now() - t0)
      }

      function parseSseBuffer() {
        // SSE events are delimited by a blank line ("\n\n").
        let idx
        while ((idx = sseBuffer.indexOf('\n\n')) !== -1) {
          const event = sseBuffer.slice(0, idx)
          sseBuffer = sseBuffer.slice(idx + 2)
          handleEvent(event)
        }
      }
      function handleEvent(raw: string) {
        let eventType = ''
        let dataLine = ''
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) eventType = line.slice(6).trim()
          else if (line.startsWith('data:')) dataLine += line.slice(5).trim()
        }
        if (!dataLine || dataLine === '[DONE]') return
        try {
          const data = JSON.parse(dataLine)
          if (eventType === 'message_start' && data?.message?.usage) {
            usage.input_tokens = data.message.usage.input_tokens ?? usage.input_tokens
            usage.cache_creation_input_tokens =
              data.message.usage.cache_creation_input_tokens ?? usage.cache_creation_input_tokens
            usage.cache_read_input_tokens =
              data.message.usage.cache_read_input_tokens ?? usage.cache_read_input_tokens
            usage.output_tokens = data.message.usage.output_tokens ?? usage.output_tokens
          } else if (eventType === 'message_delta' && data?.usage) {
            // message_delta.usage carries running output_tokens
            usage.output_tokens = data.usage.output_tokens ?? usage.output_tokens
          }
        } catch {
          // Ignore malformed JSON; we still pass the bytes through.
        }
      }
    },
    cancel() {
      // Client disconnected. The `finally` in start() handles reconcile.
    },
  })

  return new NextResponse(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
    },
  })
}

async function finalize(
  requestId: string,
  estimate: number,
  model: string,
  usage: Usage | null,
  status: 'ok' | 'error' | 'aborted',
  errorCode: string | null,
  latencyMs: number,
) {
  const db = supabaseAdmin()
  const price = usage
    ? priceUsage(model, usage)
    : { cents: 0, anthropicCents: 0 }
  await db.rpc('reconcile_request', {
    p_request_id: requestId,
    p_estimate: estimate,
    p_actual_cost_cents: price.cents,
    p_anthropic_cost_cents: price.anthropicCents,
    p_input_tokens: usage?.input_tokens ?? 0,
    p_output_tokens: usage?.output_tokens ?? 0,
    p_cache_read_tokens: usage?.cache_read_input_tokens ?? 0,
    p_cache_creation_tokens: usage?.cache_creation_input_tokens ?? 0,
    p_latency_ms: latencyMs,
    p_status: status,
    p_error_code: errorCode,
  })
}
