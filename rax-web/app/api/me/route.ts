import { NextResponse } from 'next/server'
import { extractKey } from '@/lib/api-key'
import { resolveApiKey } from '@/lib/auth-key'
import { supabaseAdmin } from '@/lib/supabase-admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Bearer-authenticated identity endpoint used by the Electron app to
 * display the signed-in user's email + current credit balance.
 *
 *   GET /api/me   Authorization: Bearer rax_sk_…
 *
 * Returns 401 for missing/revoked keys.
 */
export async function GET(req: Request) {
  const plaintext = extractKey(req)
  if (!plaintext || !plaintext.startsWith('rax_sk_')) {
    return NextResponse.json({ error: 'invalid_api_key' }, { status: 401 })
  }
  const resolved = await resolveApiKey(plaintext)
  if (!resolved) {
    return NextResponse.json({ error: 'invalid_api_key' }, { status: 401 })
  }

  const db = supabaseAdmin()
  const [{ data: profile }, { data: authUser }, { data: freeUsage }] = await Promise.all([
    db.from('profiles').select('balance_cents').eq('user_id', resolved.user_id).single(),
    db.auth.admin.getUserById(resolved.user_id),
    db.rpc('free_usage_summary', { p_user_id: resolved.user_id }),
  ])

  // Free-tier surface is percent-only — the underlying cents are never sent
  // to the client. Keeps the "Rax Default" budget opaque to end users.
  const usage = Array.isArray(freeUsage) ? freeUsage[0] : freeUsage
  const dailyPct   = pctFromCents(usage?.day_cents,   usage?.day_limit_cents)
  const monthlyPct = pctFromCents(usage?.month_cents, usage?.month_limit_cents)

  return NextResponse.json({
    user_id:       resolved.user_id,
    email:         authUser?.user?.email ?? null,
    balance_cents: profile?.balance_cents ?? 0,
    free_tier: {
      daily_pct:   dailyPct,
      monthly_pct: monthlyPct,
    },
  })
}

function pctFromCents(used: unknown, limit: unknown): number {
  const u = Number(used ?? 0)
  const l = Number(limit ?? 0)
  if (l <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((u / l) * 100)))
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 })
}
