import { Webhook } from 'standardwebhooks'

/**
 * Whop V1 integration — subscriptions with monthly credit deposits.
 *
 * Event types we listen for (configured in the Whop dashboard, API v1):
 *   - payment.succeeded     → deposit credits (initial + every renewal)
 *   - membership.activated  → link membership_id to our user_id (so
 *                             future renewals can find the user)
 *   - membership.deactivated → mark the membership inactive
 *   - invoice.past_due       → currently logged, not acted on
 *
 * Webhook signature: Standard Webhooks spec (webhook-id / -timestamp /
 * -signature headers; v1,<base64-hmac> tokens). See verifyWhopSignature
 * for Whop's non-standard secret-bytes interpretation.
 */

const CHECKOUT_HOST = process.env.WHOP_CHECKOUT_HOST ?? 'https://whop.com'

/** Each tier is one Whop subscription plan. The plan ID resolves to the
 *  dollar amount we credit on each successful invoice. Hosted checkout
 *  (`https://whop.com/checkout/{id}`) routes by plan id, not product id. */
type TierKey = '20' | '50' | '100'

interface Tier {
  plan_id: string
  cents: number
  label: string
}

function envTier(key: TierKey, cents: number, label: string): Tier | null {
  const id = process.env[`WHOP_PLAN_${key}`]
  if (!id) return null
  return { plan_id: id, cents, label }
}

export function tiers(): Tier[] {
  return [
    envTier('20',  2000,  '$20/mo'),
    envTier('50',  5000,  '$50/mo'),
    envTier('100', 10000, '$100/mo'),
  ].filter((t): t is Tier => t !== null)
}

/** Resolve a Whop plan id back to its credit amount. */
export function centsForPlan(planId: string): number | null {
  for (const t of tiers()) if (t.plan_id === planId) return t.cents
  return null
}

export type CheckoutMetadata = {
  user_id: string
  cents: number
}

/**
 * Create a Whop checkout session and return its hosted purchase URL.
 *
 * Why a session and not a plain URL: Whop's hosted checkout silently
 * ignores URL-form `metadata[…]` and `redirect_url` query params on
 * `/checkout/{plan}`. The membership ends up with `metadata: {}`, so
 * our webhook can't link it to our user. The Sessions API persists
 * both server-side, so they survive into the membership_activated and
 * invoice_paid webhooks.
 *
 * Returns the `purchase_url` (looks like
 * `https://whop.com/checkout/plan_xxx/?session=ch_yyy`).
 */
export async function whopCheckoutUrl(
  planId: string,
  metadata: CheckoutMetadata,
  redirectUrl: string,
): Promise<string> {
  const key = process.env.WHOP_API_KEY
  if (!key) throw new Error('WHOP_API_KEY missing — required for Checkout Sessions')

  const res = await fetch('https://api.whop.com/api/v2/checkout_sessions', {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${key}`,
      'content-type':  'application/json',
    },
    body: JSON.stringify({
      plan_id:      planId,
      // Whop stores metadata as a string map; stringify numbers so the
      // webhook payload comes back with predictable types.
      metadata: {
        user_id: metadata.user_id,
        cents:   String(metadata.cents),
      },
      redirect_url:      redirectUrl,
      // Disable promos: our credit amount is tied to the plan's sticker
      // price, so any % discount would credit more than the user paid.
      allow_promo_codes: false,
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Whop checkout_sessions ${res.status}: ${body.slice(0, 200)}`)
  }

  const json = await res.json() as { purchase_url?: string }
  if (!json.purchase_url) {
    throw new Error('Whop checkout_sessions response missing purchase_url')
  }
  // Whop returns either a full URL or a path. Normalize to full URL.
  return json.purchase_url.startsWith('http')
    ? json.purchase_url
    : new URL(json.purchase_url, CHECKOUT_HOST).toString()
}

// ─── Signature verification (Standard Webhooks spec) ───────────────────

/**
 * Verify a Whop webhook signature.
 *
 * Whop sends three Standard-Webhooks headers — `webhook-id`,
 * `webhook-timestamp`, `webhook-signature` — and the signature header
 * holds space-separated `v1,<base64-hmac>` tokens.
 *
 * The HMAC is SHA-256 of `${id}.${timestamp}.${body}`. The key is the
 * **full secret string (including the `ws_` prefix) as UTF-8 bytes** —
 * verified empirically against live webhook deliveries. (The Standard
 * Webhooks spec calls for base64-decoded secret bytes after stripping
 * the `whsec_` prefix; Whop deviates by signing with the raw string.)
 */
export function verifyWhopSignature(
  rawBody: string,
  webhookId: string | null,
  webhookTimestamp: string | null,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!webhookId || !webhookTimestamp || !signatureHeader) return false
  try {
    const wh = new Webhook(Buffer.from(secret, 'utf-8'), { format: 'raw' })
    wh.verify(rawBody, {
      'webhook-id':        webhookId,
      'webhook-timestamp': webhookTimestamp,
      'webhook-signature': signatureHeader,
    })
    return true
  } catch {
    return false
  }
}

// ─── Event parsing ─────────────────────────────────────────────────────

/** Pull a stable unique id for the event. Whop uses `id` at the top level. */
export function readEventId(payload: any): string | null {
  return payload?.id ?? payload?.event_id ?? payload?.data?.id ?? null
}

/** Pull the event action. Whop V1 uses snake_case like `invoice_paid`,
 *  `membership_activated`. We accept the dotted forms too as a safety
 *  net in case the API version flips. */
export function readEventType(payload: any): string | null {
  const t: string | undefined =
    payload?.action ?? payload?.type ?? payload?.event ?? payload?.data?.type
  return t ?? null
}

export type ParsedInvoice = {
  invoiceId: string | null
  amountCents: number | null
  membershipId: string | null
  planId: string | null
  productId: string | null
  metadataUserId: string | null
}

export function parseInvoicePaid(payload: any): ParsedInvoice {
  const d = payload?.data ?? payload
  // Whop V1 `payment.succeeded` exposes the charged amount in
  // `final_amount` (dollars) plus several legacy field names from older
  // payloads. Try them in order; bail to null if none parse.
  const amountCents =
    asInt(d?.amount_paid_in_cents) ??
    asInt(d?.amount_in_cents) ??
    centsFromDollars(d?.final_amount) ??
    centsFromDollars(d?.amount_paid) ??
    centsFromDollars(d?.amount) ??
    centsFromDollars(d?.total) ??
    null

  // `membership` can be a string (V1) or an object (V2); same for plan
  // and product. Metadata may live at `metadata` or `membership_metadata`.
  const membershipRef = d?.membership_id ?? d?.membership
  const planRef       = d?.plan_id       ?? d?.plan
  const productRef    = d?.product_id    ?? d?.product
  const meta          = d?.metadata ?? d?.membership_metadata

  return {
    invoiceId:       d?.id ?? null,
    amountCents,
    membershipId:    typeof membershipRef === 'string' ? membershipRef : (membershipRef?.id ?? null),
    planId:          typeof planRef       === 'string' ? planRef       : (planRef?.id       ?? null),
    productId:       typeof productRef    === 'string' ? productRef    : (productRef?.id    ?? null),
    metadataUserId:  (meta?.user_id as string | undefined) ?? null,
  }
}

export type ParsedMembership = {
  membershipId: string | null
  planId: string | null
  productId: string | null
  metadataUserId: string | null
}

export function parseMembershipEvent(payload: any): ParsedMembership {
  const d = payload?.data ?? payload
  const planRef    = d?.plan_id    ?? d?.plan
  const productRef = d?.product_id ?? d?.product
  return {
    membershipId:   d?.id ?? d?.membership_id ?? null,
    planId:         typeof planRef    === 'string' ? planRef    : (planRef?.id    ?? null),
    productId:      typeof productRef === 'string' ? productRef : (productRef?.id ?? null),
    metadataUserId: (d?.metadata?.user_id as string | undefined) ?? null,
  }
}

function asInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v)
  if (typeof v === 'string' && /^\d+$/.test(v)) return parseInt(v, 10)
  return null
}

function centsFromDollars(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v * 100)
  if (typeof v === 'string' && /^\d+(\.\d{1,2})?$/.test(v)) return Math.round(parseFloat(v) * 100)
  return null
}
