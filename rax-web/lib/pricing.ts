/**
 * Anthropic published per-million-token rates in USD, as of the model
 * cutoff for this build. Update via redeploy when Anthropic publishes
 * new prices. All other code applies markup via `withMarkup`.
 */
export const MARKUP = 1.30 // 30%

export type ModelPricing = {
  inputPerMTok: number
  outputPerMTok: number
  cacheWritePerMTok: number   // 5m ephemeral cache writes
  cacheReadPerMTok: number    // cache hits
}

// Prices below are the *Anthropic* prices in USD per 1M tokens.
const RAW: Record<string, ModelPricing> = {
  'claude-opus-4-7': {
    inputPerMTok:       15.00,
    outputPerMTok:      75.00,
    cacheWritePerMTok:  18.75,
    cacheReadPerMTok:    1.50,
  },
  'claude-sonnet-4-6': {
    inputPerMTok:        3.00,
    outputPerMTok:      15.00,
    cacheWritePerMTok:   3.75,
    cacheReadPerMTok:    0.30,
  },
  'claude-haiku-4-5': {
    inputPerMTok:        1.00,
    outputPerMTok:       5.00,
    cacheWritePerMTok:   1.25,
    cacheReadPerMTok:    0.10,
  },
  // Moonshot Kimi K2.7-code — billed via /v1/messages → Moonshot's
  // Anthropic-compatible endpoint. Cache-miss input = $0.95/Mtok, cache hit
  // = $0.16/Mtok, output = $4.00/Mtok. Moonshot doesn't quote a separate
  // cache-write price (caching is automatic), so we charge cache writes at
  // the cache-miss input rate — the same tokens you'd pay for anyway.
  'kimi-k2.7-code': {
    inputPerMTok:        0.95,
    outputPerMTok:       4.00,
    cacheWritePerMTok:   0.95,
    cacheReadPerMTok:    0.16,
  },
}

/** Resolve a model id (incl. dated suffixes / aliases) to its base entry. */
export function pricingFor(model: string): ModelPricing {
  if (RAW[model]) return RAW[model]
  // Match longest prefix (handles version-dated ids like sonnet-4-6-20251015).
  let best: string | null = null
  for (const k of Object.keys(RAW)) {
    if (model.startsWith(k) && (best === null || k.length > best.length)) best = k
  }
  if (best) return RAW[best]
  // Sensible fallback: bill at Sonnet rates rather than free.
  return RAW['claude-sonnet-4-6']
}

export function isSupportedModel(model: string): boolean {
  if (RAW[model]) return true
  for (const k of Object.keys(RAW)) if (model.startsWith(k)) return true
  return false
}

/** "Rax Default" — every kimi-* model id is free for the user (within caps).
 *  The route bypasses the credit debit and runs a per-user daily/monthly
 *  raw-cost quota check instead. Keep this in lockstep with the SQL
 *  `model like 'kimi-%'` filter in 0004_free_tier.sql. */
export function isFreeModel(model: string): boolean {
  return model.startsWith('kimi-')
}

/** Convert a token count + per-Mtok rate to USD cents (rounded up). */
function toCents(tokens: number, perMTok: number): number {
  return Math.ceil((tokens * perMTok * 100) / 1_000_000)
}

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

/**
 * Compute the customer-facing cost (with markup) and the raw Anthropic
 * cost (without markup) for a given usage breakdown.
 */
export function priceUsage(model: string, u: Usage): { cents: number; anthropicCents: number } {
  const p = pricingFor(model)
  const raw =
    toCents(u.input_tokens,                        p.inputPerMTok) +
    toCents(u.output_tokens,                       p.outputPerMTok) +
    toCents(u.cache_creation_input_tokens ?? 0,    p.cacheWritePerMTok) +
    toCents(u.cache_read_input_tokens     ?? 0,    p.cacheReadPerMTok)
  return { cents: Math.ceil(raw * MARKUP), anthropicCents: raw }
}

/**
 * Cap on `max_tokens` used for pre-debit reservation. The CLIs we
 * support (Claude Code, Cursor, etc.) routinely pass max_tokens=32K+,
 * but actual completions are almost always far smaller. Reserving the
 * full ceiling for every concurrent request over-stacks the balance
 * and triggers spurious 402s — even though reconcile would have
 * refunded most of it within seconds.
 *
 * The actual `max_tokens` is still forwarded to Anthropic unchanged;
 * reconcile catches any real over-run after the stream closes.
 */
const ESTIMATE_MAX_OUTPUT_TOKENS = 8000

/**
 * Worst-case cost estimate used for pre-debit reservation.
 * Caller supplies an exact input-token count and the request's max_tokens
 * (defaulting to 4096 if absent).
 */
export function estimateCost(
  model: string,
  inputTokens: number,
  maxOutputTokens: number,
): number {
  const p = pricingFor(model)
  const cappedOutput = Math.min(maxOutputTokens, ESTIMATE_MAX_OUTPUT_TOKENS)
  const raw =
    toCents(inputTokens,                       p.inputPerMTok) +
    toCents(cappedOutput,                      p.outputPerMTok)
  return Math.ceil(raw * MARKUP)
}

/** Raw upstream cost estimate (no markup) used by the free-tier quota
 *  check. Free-tier requests don't bill credits so MARKUP doesn't apply;
 *  the cap is stated in real upstream cents. */
export function estimateRawCost(
  model: string,
  inputTokens: number,
  maxOutputTokens: number,
): number {
  const p = pricingFor(model)
  const cappedOutput = Math.min(maxOutputTokens, ESTIMATE_MAX_OUTPUT_TOKENS)
  return (
    toCents(inputTokens,  p.inputPerMTok) +
    toCents(cappedOutput, p.outputPerMTok)
  )
}

/** Subscription tiers shown on the dashboard. Each tier is a Whop
 *  subscription priced at `cents`/month; on every `invoice_paid` event
 *  we deposit that many cents to the user's balance. */
export const TOPUP_OPTIONS = [
  { label: '$20',  cents: 2000,  tier: 'Pro'   },
  { label: '$50',  cents: 5000,  tier: 'Pro+'  },
  { label: '$100', cents: 10000, tier: 'Ultra' },
] as const
