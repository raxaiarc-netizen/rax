import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import {
  parseInvoicePaid,
  parseMembershipEvent,
  readEventId,
  readEventType,
  verifyWhopSignature,
  centsForPlan,
} from '@/lib/whop'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Whop V1 webhook. Subscribed events (Whop dashboard → Developer →
 * Webhooks → Edit):
 *
 *   - payment.succeeded     → deposit credits (initial + renewals)
 *   - membership.activated  → store the membership_id ↔ user mapping
 *   - membership.deactivated → mark membership inactive
 *
 * Signature: Standard Webhooks spec — `webhook-id`, `webhook-timestamp`,
 * `webhook-signature` headers; verified in lib/whop.ts.
 *
 * Returning 5xx makes Whop retry. apply_topup() is idempotent on the
 * (provider, event_id) unique key in credit_ledger, so retries can't
 * double-credit.
 */

// Whop has shipped event names in both dotted (`payment.succeeded`) and
// snake-case (`payment_succeeded`) forms across API versions. Accept any.
const PAID_EVENTS        = new Set(['payment.succeeded', 'payment_succeeded', 'invoice.paid', 'invoice_paid'])
const ACTIVATED_EVENTS   = new Set(['membership.activated', 'membership_activated', 'membership.went_valid'])
const DEACTIVATED_EVENTS = new Set(['membership.deactivated', 'membership_deactivated', 'membership.went_invalid'])

export async function POST(req: Request) {
  const secret = process.env.WHOP_WEBHOOK_SECRET
  if (!secret) {
    console.error('[whop] WHOP_WEBHOOK_SECRET missing')
    return NextResponse.json({ error: 'misconfigured' }, { status: 500 })
  }

  // Standard Webhooks headers (Whop's current scheme).
  const webhookId        = req.headers.get('webhook-id')
  const webhookTimestamp = req.headers.get('webhook-timestamp')
  const webhookSignature = req.headers.get('webhook-signature')

  const raw = await req.text()
  if (!verifyWhopSignature(raw, webhookId, webhookTimestamp, webhookSignature, secret)) {
    console.warn(`[whop] sig invalid id=${webhookId} ts=${webhookTimestamp}`)
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 })
  }

  let payload: any
  try {
    payload = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const eventId = readEventId(payload)
  const type    = readEventType(payload)
  if (!eventId || !type) {
    return NextResponse.json({ error: 'missing event id or type' }, { status: 400 })
  }

  const db = supabaseAdmin()

  // ── payment.succeeded → credit the user ─────────────────────────────
  if (PAID_EVENTS.has(type)) {
    const inv = parseInvoicePaid(payload)
    if (inv.amountCents == null) {
      return NextResponse.json(
        { error: 'invoice_paid missing amount', invoiceId: inv.invoiceId },
        { status: 400 },
      )
    }

    // Zero-dollar payments happen for trials, 100% promos, and owner
    // discounts. Acknowledge cleanly without crediting — there's nothing
    // to deposit. The membership link still happens via the separate
    // membership.activated event.
    if (inv.amountCents === 0) {
      console.warn(
        `[whop] zero-amount payment ignored invoice=${inv.invoiceId} ` +
        `membership=${inv.membershipId} (likely promo/owner-discount)`,
      )
      return NextResponse.json({ ignored: 'zero_amount', invoiceId: inv.invoiceId })
    }

    // Resolve our user_id, in priority order:
    //   1. metadata.user_id (set on initial checkout)
    //   2. memberships table lookup by whop_membership_id (renewal path)
    let userId = inv.metadataUserId
    if (!userId && inv.membershipId) {
      const { data: row } = await db
        .from('memberships')
        .select('user_id')
        .eq('whop_membership_id', inv.membershipId)
        .maybeSingle()
      userId = row?.user_id ?? null
    }
    if (!userId) {
      // Acknowledge so Whop doesn't retry forever, but log so we can
      // reconcile manually if it happens.
      console.warn(`[whop] invoice_paid event=${eventId} membership=${inv.membershipId} — no user found`)
      return NextResponse.json({ ignored: 'unmatched_user', eventId })
    }

    // Sanity: if the plan is one of ours, ensure we don't credit
    // some surprising amount. We trust amountCents from Whop, but log
    // a mismatch.
    if (inv.planId) {
      const expected = centsForPlan(inv.planId)
      if (expected !== null && expected !== inv.amountCents) {
        console.warn(
          `[whop] invoice ${inv.invoiceId} plan ${inv.planId} ` +
          `amount=${inv.amountCents} expected=${expected}`,
        )
      }
    }

    const { error } = await db.rpc('apply_topup', {
      p_user_id:  userId,
      p_event_id: eventId,
      p_amount:   inv.amountCents,
      p_provider: 'whop',
    })
    if (error) {
      console.error(`[whop] apply_topup failed: ${error.message}`)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ credited: inv.amountCents, user_id: userId })
  }

  // ── membership.activated → link membership to user ─────────────────
  if (ACTIVATED_EVENTS.has(type)) {
    const m = parseMembershipEvent(payload)
    if (!m.membershipId) {
      return NextResponse.json({ ignored: 'no_membership_id' })
    }
    if (!m.metadataUserId) {
      console.warn(`[whop] membership_activated ${m.membershipId} — no metadata.user_id`)
      return NextResponse.json({ ignored: 'no_user_in_metadata' })
    }
    const { error } = await db
      .from('memberships')
      .upsert({
        user_id:            m.metadataUserId,
        whop_membership_id: m.membershipId,
        whop_product_id:    m.productId,
        status:             'active',
        updated_at:         new Date().toISOString(),
      }, { onConflict: 'whop_membership_id' })
    if (error) {
      console.error(`[whop] upsert membership failed: ${error.message}`)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ linked: m.membershipId, user_id: m.metadataUserId })
  }

  // ── membership.deactivated → flag inactive ──────────────────────────
  if (DEACTIVATED_EVENTS.has(type)) {
    const m = parseMembershipEvent(payload)
    if (!m.membershipId) {
      return NextResponse.json({ ignored: 'no_membership_id' })
    }
    await db
      .from('memberships')
      .update({ status: 'inactive', updated_at: new Date().toISOString() })
      .eq('whop_membership_id', m.membershipId)
    return NextResponse.json({ deactivated: m.membershipId })
  }

  // Acknowledge any other configured event so Whop stops retrying.
  return NextResponse.json({ ignored: true, type })
}
