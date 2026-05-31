import { NextResponse } from 'next/server'
import { extractKey } from '@/lib/api-key'
import { resolveApiKey } from '@/lib/auth-key'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { estimateInputTokens } from '@/lib/tokenize'
import { estimateCost, estimateRawCost, isFreeModel, isSupportedModel, priceUsage, type Usage } from '@/lib/pricing'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const ANTHROPIC = 'https://api.anthropic.com/v1/messages'
const MOONSHOT  = 'https://api.moonshot.ai/anthropic/v1/messages'

/** Pick the upstream endpoint + auth headers for a given model. Kimi K2.x
 *  rides on Moonshot's Anthropic-compatible endpoint (same wire format, but
 *  Bearer auth instead of x-api-key). Everything else goes to Anthropic. */
function resolveUpstream(model: string, req: Request): {
  url: string
  authHeaders: Record<string, string>
  provider: 'anthropic' | 'moonshot'
} | { error: string } {
  if (model.startsWith('kimi-')) {
    const key = process.env.MOONSHOT_API_KEY
    if (!key) return { error: 'no moonshot key configured' }
    return {
      url: MOONSHOT,
      authHeaders: { 'authorization': `Bearer ${key}` },
      provider: 'moonshot',
    }
  }
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return { error: 'no anthropic key configured' }
  return {
    url: ANTHROPIC,
    authHeaders: {
      'x-api-key': key,
      'anthropic-version': req.headers.get('anthropic-version') ?? '2023-06-01',
      ...(req.headers.get('anthropic-beta')
        ? { 'anthropic-beta': req.headers.get('anthropic-beta')! }
        : {}),
    },
    provider: 'anthropic',
  }
}

function jsonError(status: number, type: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ type: 'error', error: { type, ...extra } }, { status })
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 })
}

export async function POST(req: Request) {
  const t0 = Date.now()

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

  // Resolve provider here — fails fast if the chosen model needs a key the
  // server doesn't have configured (e.g. kimi-* without MOONSHOT_API_KEY).
  const upstreamRes = resolveUpstream(model, req)
  if ('error' in upstreamRes) {
    return jsonError(500, 'server_misconfigured', { detail: upstreamRes.error })
  }
  const maxTokens: number = typeof body?.max_tokens === 'number' ? body.max_tokens : 4096
  const inputTokens = estimateInputTokens(body)
  const freeTier = isFreeModel(model)
  // Free-tier estimate is the RAW upstream cost (no markup). Paid-tier
  // estimate carries the 30% markup since it'll be debited from credits.
  const estimate = freeTier
    ? estimateRawCost(model, inputTokens, maxTokens)
    : estimateCost(model,    inputTokens, maxTokens)

  // ─── 3. Atomic debit (paid) OR free-tier quota check ─────────────────
  const db = supabaseAdmin()
  let requestId: string | null
  if (freeTier) {
    const { data, error } = await db.rpc('free_quota_check_or_reject', {
      p_user_id:    resolved.user_id,
      p_api_key_id: resolved.key_id,
      p_model:      model,
      p_estimate:   estimate,
    })
    if (error) return jsonError(500, 'server_error', { message: error.message })
    requestId = (data as string | null) ?? null
    if (!requestId) {
      const { data: usage } = await db.rpc('free_usage_summary', { p_user_id: resolved.user_id })
      const row = Array.isArray(usage) ? usage[0] : usage
      const dayPct   = pct(row?.day_cents,   row?.day_limit_cents)
      const monthPct = pct(row?.month_cents, row?.month_limit_cents)
      // Surface percentages only; the underlying cents stay server-side.
      return jsonError(429, 'free_tier_limit_reached', {
        daily_pct:   dayPct,
        monthly_pct: monthPct,
        message:
          dayPct >= 100
            ? 'Daily limit reached. Resets in the next 24h.'
            : 'Monthly limit reached. Resets at the start of next month.',
      })
    }
  } else {
    const { data: debitRow, error: debitErr } = await db.rpc('debit_or_reject', {
      p_user_id:    resolved.user_id,
      p_api_key_id: resolved.key_id,
      p_model:      model,
      p_estimate:   estimate,
    })
    if (debitErr) return jsonError(500, 'server_error', { message: debitErr.message })
    requestId = (debitRow as string | null) ?? null
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
  }

  // ─── 4. Forward to upstream (Anthropic or Moonshot) ──────────────────
  const wantStream = body?.stream === true
  let upstream: Response
  try {
    upstream = await fetch(upstreamRes.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...upstreamRes.authHeaders,
      },
      body: JSON.stringify(body),
    })
  } catch (e: any) {
    await finalize(requestId, estimate, model, null, 'error', e?.message ?? 'upstream_fetch_failed', Date.now() - t0)
    return jsonError(502, 'upstream_error', { message: `failed to reach ${upstreamRes.provider}` })
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

function pct(used: number | null | undefined, limit: number | null | undefined): number {
  const u = Number(used ?? 0)
  const l = Number(limit ?? 0)
  if (l <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((u / l) * 100)))
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
  // Free-tier requests must never adjust the user's balance. Passing
  // estimate=0 and actual=0 makes reconcile_request's v_diff = 0 so the
  // credit_ledger insert + balance update are skipped, while the row's
  // anthropic_cost_cents still receives the real upstream spend (used by
  // the free-tier quota check). For paid requests, behaviour is unchanged.
  const freeTier = isFreeModel(model)
  const recEstimate = freeTier ? 0 : estimate
  const recActual   = freeTier ? 0 : price.cents
  await db.rpc('reconcile_request', {
    p_request_id: requestId,
    p_estimate: recEstimate,
    p_actual_cost_cents: recActual,
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
